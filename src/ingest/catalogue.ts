import type { Fetcher } from '../core/http.ts';
import type { ProductRow } from './rows.ts';
import { fetchCatalogue, productJs, shopMeta } from './shopify.ts';
import { fetchWooCatalogue, wooProduct } from './woocommerce.ts';
import { MAX_PRODUCT_PAGES, fetchSitemapCatalogue, jsonLdProducts, ldRow } from './sitemap.ts';
import { wixRow, wixWarmupProduct } from './wix.ts';
import { cashcowLivePrice, isCashcowProduct } from './cashcow.ts';

// Which platforms ingest reads, and how each one's catalogue is read. Everything after
// this file sees the same rows (rows.ts), whatever the platform:
//
//   shopify      /products.json and /meta.json (shopify.ts)
//   woocommerce  the public Store API (woocommerce.ts); the sitemap when the API is off
//   wix          the products sitemap and each product page (sitemap.ts, wix.ts)
//   cashcow      its one sitemap and each product page (sitemap.ts, cashcow.ts)
//
// Every address is read from the store's base (urls.ts siteBase): its origin, or a free
// Wix site's path on wixsite.com.
//
// Konimbo, Magento and the rest are detected, scored and listed, and stop at ingest
// with a clear reason. Konimbo answers every request that comes with no referring page,
// robots.txt included, with a "go to the requested page" screen instead of the page
// (detect.ts knows it), and Toran does not get around a store's gate.

export const INGESTIBLE = ['shopify', 'woocommerce', 'wix', 'cashcow'] as const;
export const canIngest = (platform: string | null | undefined): boolean => (INGESTIBLE as readonly string[]).includes(String(platform || ''));
/** The platforms ingest reads, as a sentence: in the errors and in the dashboard's Hebrew. */
export const INGESTIBLE_EN = 'Shopify, WooCommerce, Wix and Cashcow';
export const INGESTIBLE_HE = 'Shopify, WooCommerce, Wix ו־Cashcow';

export type Catalogue = { rows: ProductRow[]; currency: string | null; name: string | null; moneyFormat: string | null; source: string; warnings: string[] };

async function fromSitemap(fetcher: Fetcher, base: string, platform: string, progress: (m: string) => void, warnings: string[]): Promise<Catalogue> {
  progress('קורא את רשימת המוצרים מהאתר');
  const s = await fetchSitemapCatalogue(fetcher, base, { platform, onPage: (done, total) => progress(`קורא את דפי המוצרים: ${done} מתוך ${total}`) });
  if (!s.maps.length) warnings.push('no product sitemap found');
  if (s.listed > MAX_PRODUCT_PAGES) warnings.push(`the sitemap lists ${s.listed} products: read the ${MAX_PRODUCT_PAGES} ${s.dated ? 'newest' : 'it lists first (it gives no dates)'}`);
  const pages = (n: number) => `${n} product page${n === 1 ? '' : 's'}`;
  if (s.failed) warnings.push(`${pages(s.failed)} of ${Math.min(s.listed, MAX_PRODUCT_PAGES)} did not load`);
  if (s.read > s.rows.length) warnings.push(`${pages(s.read - s.rows.length)} had no product data (the platform's own or JSON-LD) to read`);
  return { rows: s.rows, currency: s.currency, name: null, moneyFormat: null, source: 'sitemap', warnings };
}

export async function readCatalogue(fetcher: Fetcher, platform: string, base: string, progress: (m: string) => void = () => {}): Promise<Catalogue> {
  const warnings: string[] = [];
  if (platform === 'shopify') {
    progress('קורא את פרטי החנות');
    const meta = await shopMeta(fetcher, base);
    const currency = meta.currency || 'ILS';
    progress('קורא את המוצרים');
    const rows = await fetchCatalogue(fetcher, base, currency, { onPage: (_p, n) => progress(`קורא את המוצרים: ${n}`) });
    return { rows, currency, name: meta.name || null, moneyFormat: meta.money_format || null, source: 'products.json', warnings };
  }
  if (platform === 'woocommerce') {
    progress('קורא את המוצרים');
    try {
      const w = await fetchWooCatalogue(fetcher, base, { onPage: (_p, n) => progress(`קורא את המוצרים: ${n}`) });
      warnings.push(...w.warnings);
      if (w.rows.length) return { rows: w.rows, currency: w.currency, name: null, moneyFormat: null, source: 'store-api', warnings };
      warnings.push('the WooCommerce Store API answered with no products: read from the sitemap instead');
    } catch (e: any) {
      warnings.push(`the WooCommerce Store API did not answer (${e.code || e.message}): read from the sitemap instead`);
    }
    return fromSitemap(fetcher, base, platform, progress, warnings);
  }
  if (platform === 'wix' || platform === 'cashcow') return fromSitemap(fetcher, base, platform, progress, warnings);
  throw new Error(`no catalogue reader for ${platform}`);
}

/**
 * A stored product's price as the store shows it now, from a different source than the
 * one ingest read: Shopify's /products/<handle>.js, WooCommerce's single-product Store
 * API route, a Cashcow page's analytics price (ingest read its buy button), else the
 * product page's JSON-LD offer (Wix's page, or a WooCommerce store whose API is off).
 * Null when it could not be read.
 */
export async function livePrice(fetcher: Fetcher, platform: string, base: string, row: { ext_id: string; handle: string; url: string }): Promise<{ price_min: number | null; variants?: { id: string; price: number }[] } | null> {
  if (platform === 'shopify') return productJs(fetcher, base, row.handle);
  if (platform === 'woocommerce' && /^\d+$/.test(row.ext_id)) {
    const w = await wooProduct(fetcher, base, row.ext_id);
    if (w) return w;
  }
  try {
    const r = await fetcher(row.url, { accept: 'text/html' });
    if (isCashcowProduct(r.text)) {
      const p = cashcowLivePrice(r.text);
      return p == null ? null : { price_min: p };
    }
    const ld = jsonLdProducts(r.text)[0];
    const fromLd = ld ? ldRow(ld, row.url, r.text) : null;
    if (fromLd) return { price_min: fromLd.price_min };
    // A Wix page without JSON-LD: its own product data, which is what ingest read, so a check of the page and not of the source.
    const wix = wixWarmupProduct(r.text);
    return wix ? { price_min: wixRow(wix, row.url).price_min } : null;
  } catch {
    return null;
  }
}
