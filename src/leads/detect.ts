import { canonicalDomain, homeUrl } from '../core/urls.ts';
import { type Fetcher, FetchError, getJson } from '../core/http.ts';
import { hebrewRatio } from '../core/hebrew.ts';
import { readHome, type HomeSignals } from './signals.ts';

// Platform detection: is this an online store, on what, how big, how alive, and how
// do we reach its owner. One home page, then the platform's own public endpoints:
//
//   Shopify       GET /products.json?limit=250 (paged): the count, the newest update,
//                 the catalogue's language. A JSON 200 is proof; HTML back means the
//                 feed is off or the store is behind a password.
//   WooCommerce   GET /wp-json/wc/store/v1/products?per_page=1: the X-WP-Total header
//                 is the count. Proof as well.
//   Wix, other    the HTML fingerprints, and the product sitemap for a count
//                 (store-products-sitemap.xml on Wix, product-sitemap.xml on WordPress)
//
// A contact page is read only when the home page gave no email. A page that is almost
// all JavaScript (under 300 characters of text) is rendered headless when a browser is
// available, and the signals are read again from what it rendered.

export type Platform = 'shopify' | 'woocommerce' | 'wix' | 'konimbo' | 'cashcow' | 'magento' | 'bigcommerce' | 'other' | 'unknown';

export type Detection = {
  input: string;
  url: string; // the home page after redirects
  domain: string;
  name: string;
  platform: Platform;
  platformEvidence: string;
  productCount: number | null;
  productCountSource: string | null;
  productCountCapped: boolean; // we stopped paging: "at least"
  newestProductAt: string | null;
  catalogHebrewRatio: number | null;
  catalogSample: string[]; // up to 60 product titles, for the restricted-category check
  home: HomeSignals;
  rendered: boolean;
  email: string | null;
  whatsapp: string | null;
  phone: string | null;
  franchiseOf: string | null; // a local site of an international brand
  errors: string[];
};

const SHOPIFY_PAGES = 4; // 1,000 products is enough to place a store in its tier

export async function detect(input: string, { fetcher, render }: { fetcher: Fetcher; render?: (url: string) => Promise<string | null> }): Promise<Detection> {
  const start = homeUrl(input);
  if (!start) throw new FetchError('not a URL', 'network', input);
  const errors: string[] = [];

  const home = await fetcher(start, { accept: 'text/html' });
  const url = home.url || start;
  const domain = canonicalDomain(url) || canonicalDomain(start)!;
  const origin = new URL(url).origin;
  let html = home.text;
  let signals = readHome(html, url);
  let rendered = false;
  if (signals.textLength < 300 && render) {
    const r = await render(url).catch(() => null);
    if (r) {
      html = r;
      signals = readHome(r, url);
      rendered = true;
    }
  }
  const headerHints = Object.keys(home.headers || {}).some((k) => /^x-wix-/i.test(k)) ? ['wix'] : [];
  const shopifyHeader = Object.keys(home.headers || {}).some((k) => /^x-shopid$|^x-shopify-/i.test(k));
  const hints = new Set([...signals.platformHints, ...headerHints, ...(shopifyHeader ? ['shopify'] : [])]);

  let platform: Platform = 'unknown';
  let platformEvidence = '';
  let productCount: number | null = null;
  let productCountSource: string | null = null;
  let productCountCapped = false;
  let newestProductAt: string | null = null;
  let catalogHebrewRatio: number | null = null;
  let catalogSample: string[] = [];

  // ---- Shopify: try the feed when the HTML hints at it, or when nothing else does (custom domains hide it well).
  const tryShopify = hints.has('shopify') || ![...hints].some((h) => ['woocommerce', 'wordpress', 'wix', 'magento', 'konimbo', 'cashcow', 'bigcommerce'].includes(h));
  if (tryShopify) {
    try {
      let count = 0;
      let newest = 0;
      const titles: string[] = [];
      for (let page = 1; page <= SHOPIFY_PAGES; page++) {
        const { data } = await getJson<{ products?: any[] }>(fetcher, `${origin}/products.json?limit=250&page=${page}`);
        if (!Array.isArray(data?.products)) throw new FetchError('no products array', 'not_json', origin);
        count += data.products.length;
        for (const p of data.products) {
          const t = Date.parse(p.updated_at || p.published_at || '');
          if (t > newest) newest = t;
          if (titles.length < 60) titles.push(String(p.title || ''));
        }
        if (data.products.length < 250) break;
        if (page === SHOPIFY_PAGES) productCountCapped = true;
      }
      // A big catalogue: one probe deeper (page 8, then 16) turns "1,000+" into a better lower bound, at one
      // request each, so a chain's 5,000 products do not read as a 1,000-product shop.
      if (productCountCapped) {
        for (const deep of [8, 16]) {
          try {
            const { data } = await getJson<{ products?: any[] }>(fetcher, `${origin}/products.json?limit=250&page=${deep}`);
            if (!data?.products?.length) break;
            count = (deep - 1) * 250 + data.products.length;
          } catch {
            break;
          }
        }
      }
      platform = 'shopify';
      platformEvidence = '/products.json answered';
      productCount = count;
      productCountSource = 'products.json';
      newestProductAt = newest ? new Date(newest).toISOString() : null;
      catalogHebrewRatio = titles.length ? Number(hebrewRatio(titles.join(' ')).toFixed(3)) : null;
      catalogSample = titles;
    } catch (e: any) {
      if (hints.has('shopify')) {
        platform = 'shopify';
        platformEvidence = `Shopify markers in the HTML; the product feed did not answer (${e.code || e.message})`;
        errors.push(`products.json: ${e.code || e.message}`);
      }
    }
  }

  // ---- WooCommerce
  if (platform === 'unknown' && (hints.has('woocommerce') || hints.has('wordpress'))) {
    for (const path of ['/wp-json/wc/store/v1/products?per_page=1', '/wp-json/wc/store/products?per_page=1']) {
      try {
        const { data, res } = await getJson<any[]>(fetcher, `${origin}${path}`);
        if (!Array.isArray(data)) continue;
        platform = 'woocommerce';
        platformEvidence = 'the WooCommerce Store API answered';
        const total = Number(res.headers['x-wp-total']);
        productCount = Number.isFinite(total) && res.headers['x-wp-total'] !== undefined ? total : data.length ? null : 0;
        productCountSource = productCount != null ? 'store-api' : null;
        break;
      } catch (e: any) {
        errors.push(`woo ${path.split('?')[0]}: ${e.code || e.message}`);
      }
    }
    if (platform === 'unknown' && hints.has('woocommerce')) {
      platform = 'woocommerce';
      platformEvidence = 'WooCommerce markers in the HTML';
    }
  }

  if (platform === 'unknown') {
    for (const k of ['wix', 'konimbo', 'cashcow', 'magento', 'bigcommerce'] as const) {
      if (hints.has(k)) {
        platform = k;
        platformEvidence = `${k} markers in the HTML`;
        break;
      }
    }
  }
  if (platform === 'unknown' && signals.cartMarkers) {
    platform = 'other';
    platformEvidence = 'a cart on the page, platform not recognised';
  }

  // ---- a product count from the sitemap, where the platform gave none
  if (productCount == null && platform !== 'unknown') {
    const candidates = platform === 'wix' ? ['/store-products-sitemap.xml'] : platform === 'shopify' ? ['/sitemap_products_1.xml'] : ['/product-sitemap.xml', '/wp-sitemap-posts-product-1.xml', '/sitemap.xml'];
    for (const p of candidates) {
      try {
        const r = await fetcher(`${origin}${p}`, { accept: 'application/xml,text/xml' });
        if (p === '/sitemap.xml') {
          const child = /<loc>([^<]*product[^<]*)<\/loc>/i.exec(r.text)?.[1];
          if (!child) continue;
          const c = await fetcher(child.trim(), { accept: 'application/xml,text/xml' });
          productCount = (c.text.match(/<url>/g) || []).length;
        } else productCount = (r.text.match(/<url>/g) || []).length;
        productCountSource = 'sitemap';
        break;
      } catch (e: any) {
        errors.push(`sitemap ${p}: ${e.code || e.message}`);
      }
    }
  }

  // ---- an email from the contact page, when the home page had none
  if (!signals.emails.length && signals.contactLinks.length) {
    try {
      const c = await fetcher(signals.contactLinks[0], { accept: 'text/html' });
      const cs = readHome(c.text, c.url);
      signals = { ...signals, emails: cs.emails, phones: signals.phones.length ? signals.phones : cs.phones, whatsappNumbers: signals.whatsappNumbers.length ? signals.whatsappNumbers : cs.whatsappNumbers };
    } catch (e: any) {
      errors.push(`contact page: ${e.code || e.message}`);
    }
  }

  // A local site of an international brand links to the brand's global site: brand.co.il -> brand.com.
  const label = domain.split('.')[0];
  const franchiseOf = label.length >= 4 ? signals.externalLinks.map((l) => canonicalDomain(l)).find((d) => d && d !== domain && d.split('.')[0] === label) || null : null;

  return {
    input,
    url,
    domain,
    name: storeName(signals, domain),
    platform,
    platformEvidence,
    productCount,
    productCountSource,
    productCountCapped,
    newestProductAt,
    catalogHebrewRatio,
    catalogSample,
    home: signals,
    rendered,
    email: signals.emails[0] || null,
    whatsapp: signals.whatsappNumbers[0] || null,
    phone: signals.phones.find((p) => p !== signals.whatsappNumbers[0]) || signals.phones[0] || null,
    franchiseOf,
    errors,
  };
}

/** The store's own name: og:site_name, else the part of the title that is not "Home" or a slogan. */
export function storeName(s: HomeSignals, domain: string): string {
  if (s.siteName && s.siteName.length <= 60) return s.siteName;
  const parts = s.title.split(/\s[|–—-]\s|\s·\s/).map((p) => p.trim()).filter(Boolean);
  const generic = /^(home|homepage|דף הבית|ראשי|עמוד הבית|בית|shop|חנות)$/i;
  const named = parts.filter((p) => !generic.test(p));
  const label = domain.split('.')[0].toLowerCase();
  const pick = named.find((p) => p.toLowerCase().replace(/[^a-z0-9]/g, '').includes(label.replace(/[^a-z0-9]/g, ''))) || named.sort((a, b) => a.length - b.length)[0];
  return (pick || domain).slice(0, 60);
}
