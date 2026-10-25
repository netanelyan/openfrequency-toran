import * as cheerio from 'cheerio';
import type { Fetcher } from '../core/http.ts';
import { DEFAULT_TITLE, type ProductRow, type Variant, htmlText, plainText, price, searchText, summarize } from './rows.ts';
import { wixRow, wixWarmupProduct } from './wix.ts';
import { cashcowRow, isCashcowProduct } from './cashcow.ts';

// A catalogue with no feed, read the way a search engine reads it: the store's sitemap
// lists the product pages, and each page says what it sells in schema.org JSON-LD (the
// Product with its offers: price, currency, stock), which stores publish for Google's
// shopping results. Wix's pages carry more than that (wix.ts), and are read from it when
// it is there.
//
// This is how Wix stores are read (store-products-sitemap.xml), Cashcow stores (one
// sitemap, /crowlers/sitemap, its products under /p/: cashcow.ts), and a WooCommerce
// store when its Store API is off (wp-sitemap-posts-product-1.xml, Yoast's
// product-sitemap.xml). One request a page, through the polite fetcher (one at a time
// per host, robots.txt obeyed), newest pages first by the sitemap's lastmod (Cashcow's
// gives none: its order), and no more than MAX_PRODUCT_PAGES a run: past that the rest
// are counted and reported, not read.
//
// Every address is the store's base and a path: its origin, or a free Wix site's
// https://<user>.wixsite.com/<site> (urls.ts siteBase), whose sitemaps and pages all
// hang from the site's path. An entry outside the base is not the store's.
//
// The same sitemaps list the store's other pages, which is where shipping, returns and
// contact pages are found on Wix, WordPress and Cashcow (they have no standard /policies/
// paths): pageLinks() hands them to readPolicies (pages.ts).

export const MAX_PRODUCT_PAGES = 150;
const XML = 'application/xml,text/xml;q=0.9,*/*;q=0.5';
const PRODUCT_MAP = /store-products|product-sitemap|posts-product|sitemap[_-]products?[_-]?\d*\.xml/i;
const NOT_PRODUCTS = /categor|product_cat|product-cat|product_tag|product-tag|tags?-sitemap|brand/i;
const PAGE_MAP = /pages-sitemap|posts-page|page-sitemap|sitemap[_-]pages/i;

/**
 * Where a platform's sitemaps are: the indexes that name the product and page sitemaps, the product sitemaps to try
 * when no index answers, and, for a platform with one flat sitemap (Cashcow), which of its entries are products and
 * which are pages, by their path under the base.
 */
type Plan = { indexes: string[]; direct: string[]; isProduct?: (path: string) => boolean; isPage?: (path: string) => boolean };
const PLANS: Record<string, Plan> = {
  default: { indexes: ['/sitemap.xml', '/sitemap_index.xml', '/wp-sitemap.xml'], direct: ['/store-products-sitemap.xml', '/wp-sitemap-posts-product-1.xml', '/product-sitemap.xml'] },
  // One sitemap; a big store's is an index of /crowlers/sitemap?page=N, each a mix of products, categories and pages.
  cashcow: { indexes: ['/crowlers/sitemap'], direct: ['/crowlers/sitemap'], isProduct: (p) => /^\/p\/[^/]+/.test(p), isPage: (p) => /^\/page\/[^/]+/.test(p) },
};
const planOf = (platform?: string | null) => PLANS[String(platform || '')] || PLANS.default;

export type SitemapEntry = { loc: string; lastmod: string | null };

/** The <url> entries of a urlset, or the child sitemaps of an index. */
export function readSitemap(xml: string): { index: boolean; entries: SitemapEntry[] } {
  const index = /<sitemapindex[\s>]/i.test(xml);
  const entries: SitemapEntry[] = [];
  for (const m of xml.matchAll(/<(url|sitemap)>([\s\S]*?)<\/\1>/gi)) {
    const loc = /<loc>\s*(?:<!\[CDATA\[)?([^<\]]+?)(?:\]\]>)?\s*<\/loc>/i.exec(m[2])?.[1];
    if (!loc) continue;
    const lastmod = /<lastmod>\s*([^<]+?)\s*<\/lastmod>/i.exec(m[2])?.[1] || null;
    entries.push({ loc: loc.replace(/&amp;/g, '&').trim(), lastmod });
  }
  return { index, entries };
}

async function getXml(fetcher: Fetcher, url: string): Promise<string | null> {
  try {
    const r = await fetcher(url, { accept: XML });
    const t = r.text.trimStart();
    return t.startsWith('<?xml') || /^<(urlset|sitemapindex)[\s>]/i.test(t) ? t : null; // a store's 404 page answers HTML
  } catch {
    return null;
  }
}

/** The child sitemaps the store's sitemap index names, from the first index that answers. */
async function childMaps(fetcher: Fetcher, base: string, plan: Plan): Promise<SitemapEntry[]> {
  for (const p of plan.indexes) {
    const xml = await getXml(fetcher, `${base}${p}`);
    if (!xml) continue;
    const s = readSitemap(xml);
    if (s.index) return s.entries;
  }
  return [];
}

/** The path of an address under the store's base ("/p/x"), or null when it is not under it (another site, another Wix site on the host). */
export function pathUnder(loc: string, base: string): string | null {
  try {
    const u = new URL(loc);
    const b = new URL(base);
    if (u.hostname.replace(/^www\./, '') !== b.hostname.replace(/^www\./, '')) return null;
    const root = b.pathname.replace(/\/+$/, '');
    let p = u.pathname;
    try {
      p = decodeURIComponent(p);
    } catch {
      /* kept as sent */
    }
    if (!root) return p;
    return p === root || p.startsWith(`${root}/`) ? p.slice(root.length) || '/' : null;
  } catch {
    return null;
  }
}

/** Every product page the sitemaps list, newest first, which sitemaps said so, and whether they gave dates. */
export async function productUrls(fetcher: Fetcher, base: string, platform?: string | null): Promise<{ entries: SitemapEntry[]; maps: string[]; dated: boolean }> {
  const plan = planOf(platform);
  const children = await childMaps(fetcher, base, plan);
  // A flat-sitemap platform's index pages one sitemap: every child is read, and its entries told apart by their paths.
  let maps = children.map((c) => c.loc).filter((l) => plan.isProduct || (PRODUCT_MAP.test(l) && !NOT_PRODUCTS.test(l)));
  if (!maps.length) maps = plan.direct.map((p) => `${base}${p}`);
  const seen = new Set<string>();
  const entries: SitemapEntry[] = [];
  const used: string[] = [];
  for (const m of maps.slice(0, 20)) {
    const xml = await getXml(fetcher, m);
    if (!xml) continue;
    const s = readSitemap(xml);
    if (s.index) continue;
    used.push(m);
    for (const e of s.entries) {
      const p = pathUnder(e.loc, base);
      if (p == null || seen.has(e.loc) || (plan.isProduct && !plan.isProduct(p))) continue;
      // A shop's own front page is in WordPress's product sitemap too; it has no Product and is dropped later.
      seen.add(e.loc);
      entries.push(e);
    }
    // Every product sitemap the index names is read (WordPress pages them); of the direct guesses, the first that answers.
    if (!children.length) break;
  }
  const dated = entries.some((e) => e.lastmod);
  if (dated) entries.sort((a, b) => (Date.parse(b.lastmod || '') || 0) - (Date.parse(a.lastmod || '') || 0));
  return { entries, maps: used, dated };
}

/**
 * The store's own pages from its sitemap (Wix's pages-sitemap.xml, WordPress's page sitemap, the /page/ entries of
 * Cashcow's one sitemap), as links for readPolicies.
 */
export async function pageLinks(fetcher: Fetcher, base: string, platform?: string | null): Promise<{ url: string; text: string }[]> {
  const plan = planOf(platform);
  const children = (await childMaps(fetcher, base, plan)).map((c) => c.loc);
  const maps = plan.isPage ? (children.length ? children : plan.direct.map((p) => `${base}${p}`)) : children.filter((l) => PAGE_MAP.test(l));
  const out: { url: string; text: string }[] = [];
  for (const m of maps.slice(0, 3)) {
    const xml = await getXml(fetcher, m);
    if (!xml) continue;
    for (const e of readSitemap(xml).entries) {
      const p = pathUnder(e.loc, base);
      if (p != null && (!plan.isPage || plan.isPage(p))) out.push({ url: e.loc, text: '' });
    }
  }
  return out.slice(0, 400);
}

// ---------------------------------------------------------------- JSON-LD

const typeIs = (o: any, t: string) => (Array.isArray(o?.['@type']) ? o['@type'].includes(t) : o?.['@type'] === t);

/** Every schema.org Product (or ProductGroup) on a page, from arrays and @graph alike. */
export function jsonLdProducts(html: string): any[] {
  const out: any[] = [];
  const walk = (o: any) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) return o.forEach(walk);
    if (typeIs(o, 'Product') || typeIs(o, 'ProductGroup')) out.push(o);
    if (Array.isArray(o['@graph'])) o['@graph'].forEach(walk);
  };
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      walk(JSON.parse(m[1].trim()));
    } catch {
      try {
        walk(JSON.parse(m[1].replace(/[\u0000-\u001f]+/g, ' ')));
      } catch {
        /* a broken block: the others still count */
      }
    }
  }
  return out;
}

const inStock = (a: unknown) => (a == null || a === '' ? true : !/OutOfStock|SoldOut|Discontinued/i.test(String(a)));
const imageOf = (img: any): string | null => {
  const first = Array.isArray(img) ? img[0] : img;
  if (!first) return null;
  return typeof first === 'string' ? first : first.contentUrl || first.url || null;
};
const offerList = (offers: any): any[] => (Array.isArray(offers) ? offers : offers ? [offers] : []).flatMap((o: any) => (typeIs(o, 'AggregateOffer') && o.offers ? offerList(o.offers) : [o]));
const offerPrice = (o: any) => price(o?.price ?? o?.priceSpecification?.price ?? (Array.isArray(o?.priceSpecification) ? o.priceSpecification[0]?.price : null));

function pathKey(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname).replace(/\/+$/, '') || url;
  } catch {
    return url;
  }
}

/** A JSON-LD Product as a row. A WooCommerce page's product id (body class postid-N) is its id, as the Store API's would be. */
export function ldRow(ld: any, url: string, html = '', currency = 'ILS'): ProductRow | null {
  const title = plainText(ld?.name);
  if (!title) return null;
  let variants: Variant[] = [];
  let priceMax: number | null = null;
  let cur: string | null = null;
  if (typeIs(ld, 'ProductGroup') && Array.isArray(ld.hasVariant)) {
    for (const [i, v] of ld.hasVariant.entries()) {
      const o = offerList(v?.offers)[0];
      const name = plainText(v?.name).replace(title, '').replace(/^[\s\-–|,:]+/, '').trim();
      cur ||= o?.priceCurrency || null;
      variants.push({ id: String(v?.sku || v?.['@id'] || i), title: name || DEFAULT_TITLE, options: name ? name.split(/\s*[/,|]\s*/) : [], price: offerPrice(o), compare_at: null, available: inStock(o?.availability), sku: v?.sku ? String(v.sku) : null });
    }
  } else {
    const raw = Array.isArray(ld?.offers) ? ld.offers : ld?.offers ? [ld.offers] : [];
    const aggregate = raw.find((o: any) => typeIs(o, 'AggregateOffer') && !o.offers);
    const offers = offerList(ld?.offers).filter((o: any) => !typeIs(o, 'AggregateOffer'));
    cur = (aggregate || offers[0])?.priceCurrency || null;
    if (offers.length > 1) {
      variants = offers.map((o: any, i: number) => {
        const name = plainText(o?.name || o?.itemOffered?.name || '').replace(title, '').replace(/^[\s\-–|,:]+/, '').trim();
        return { id: String(o?.sku || o?.['@id'] || i), title: name || `${i + 1}`, options: name ? [name] : [], price: offerPrice(o), compare_at: null, available: inStock(o?.availability), sku: o?.sku ? String(o.sku) : null };
      });
    } else if (offers.length === 1) {
      variants = [{ id: String(ld?.sku || pathKey(url)), title: DEFAULT_TITLE, options: [], price: offerPrice(offers[0]), compare_at: null, available: inStock(offers[0]?.availability), sku: ld?.sku ? String(ld.sku) : null }];
    } else if (aggregate) {
      variants = [{ id: String(ld?.sku || pathKey(url)), title: DEFAULT_TITLE, options: [], price: price(aggregate.lowPrice ?? aggregate.price), compare_at: null, available: inStock(aggregate.availability), sku: ld?.sku ? String(ld.sku) : null }];
      priceMax = price(aggregate.highPrice);
    }
  }
  if (!variants.length) return null; // a Product with no offer has no price to quote
  const vendor = plainText(typeof ld?.brand === 'string' ? ld.brand : ld?.brand?.name) || null;
  const category = plainText(Array.isArray(ld?.category) ? ld.category[0] : ld?.category) || null;
  const images = Array.isArray(ld?.image) ? ld.image : ld?.image ? [ld.image] : [];
  const postId = /<body[^>]*class="[^"]*\bpostid-(\d+)\b/i.exec(html)?.[1];
  const key = pathKey(url);
  const sum = summarize(variants);
  return {
    ext_id: postId || key,
    handle: key.split('/').pop() || key,
    title,
    vendor,
    product_type: category,
    tags: category ? [category] : [],
    url,
    image: imageOf(ld?.image),
    image_count: images.length,
    currency: cur || currency,
    ...sum,
    ...(priceMax != null && sum.price_max != null && priceMax > sum.price_max ? { price_max: priceMax } : {}),
    variants,
    body_text: htmlText(String(ld?.description || '')),
    search_text: searchText(title, category, vendor, category ? [category] : [], variants),
    source_updated_at: null,
  };
}

/** A product page as a row: Wix's or Cashcow's own product data when the page has it, else its JSON-LD. Null when it sells nothing. */
export function readProductPage(html: string, url: string, currency = 'ILS'): ProductRow | null {
  const wix = wixWarmupProduct(html);
  if (wix) return wixRow(wix, url, currency);
  if (isCashcowProduct(html)) return cashcowRow(html, url, currency);
  const ld = jsonLdProducts(html)[0];
  return ld ? ldRow(ld, url, html, currency) : null;
}

/** The canonical address of a page, when it names one on the same site; else where it was fetched from. */
function canonical(html: string, fetched: string): string {
  const href = cheerio.load(html.slice(0, 200_000))('link[rel="canonical"]').attr('href');
  return href && pathUnder(new URL(href, fetched).toString(), new URL(fetched).origin) != null ? new URL(href, fetched).toString() : fetched;
}

export type SitemapCatalogue = { rows: ProductRow[]; listed: number; read: number; failed: number; maps: string[]; dated: boolean; currency: string | null };

export async function fetchSitemapCatalogue(fetcher: Fetcher, base: string, { max = MAX_PRODUCT_PAGES, onPage, platform }: { max?: number; onPage?: (done: number, total: number) => void; platform?: string | null } = {}): Promise<SitemapCatalogue> {
  const { entries, maps, dated } = await productUrls(fetcher, base, platform);
  const todo = entries.slice(0, max);
  const rows: ProductRow[] = [];
  const ids = new Set<string>();
  let failed = 0;
  let read = 0;
  for (const [i, e] of todo.entries()) {
    // Ten failures before the first product: the pages are refused (a firewall, robots.txt), and the rest would be too.
    if (failed >= 10 && !rows.length) break;
    try {
      const r = await fetcher(e.loc, { accept: 'text/html' });
      read++;
      const row = readProductPage(r.text, canonical(r.text, r.url || e.loc));
      if (row && !ids.has(row.ext_id)) {
        ids.add(row.ext_id);
        rows.push(row);
      }
    } catch {
      failed++;
    }
    onPage?.(i + 1, todo.length);
  }
  return { rows, listed: entries.length, read, failed, maps, dated, currency: rows.find((r) => r.currency)?.currency || null };
}
