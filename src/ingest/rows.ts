import * as cheerio from 'cheerio';
import { normalize } from '../core/hebrew.ts';

// The one product row every platform's reader produces (shopify.ts, woocommerce.ts,
// sitemap.ts), so that ingest, the agent's tools and the pitch page never need to know
// where a store's catalogue came from. A product with no options has one variant
// titled "Default Title", as Shopify calls it; the tools leave that title out.

export type ProductRow = {
  ext_id: string;
  handle: string;
  title: string;
  vendor: string | null;
  product_type: string | null;
  tags: string[];
  url: string;
  image: string | null;
  image_count: number;
  currency: string;
  price_min: number | null;
  price_max: number | null;
  compare_at_max: number | null;
  available: boolean;
  variants: Variant[];
  body_text: string;
  search_text: string;
  source_updated_at: string | null;
};
export type Variant = { id: string; title: string; options: string[]; price: number | null; compare_at: number | null; available: boolean; sku: string | null };

export const DEFAULT_TITLE = 'Default Title';

export const price = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
};

export function htmlText(html: string, max = 2500): string {
  if (!html) return '';
  const $ = cheerio.load(`<div>${html}</div>`);
  $('script, style, iframe').remove();
  $('br').replaceWith('\n');
  $('p, li, h1, h2, h3, h4, tr, div').each((_, el) => {
    $(el).append('\n');
  });
  return $('div').first().text().replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim().slice(0, max);
}

/** A name with its HTML entities decoded (WooCommerce sends "טבעת &quot;ספירלה&quot;"), on one line. */
export const plainText = (s: unknown): string => (s == null ? '' : cheerio.load(`<p>${String(s)}</p>`)('p').text().replace(/\s+/g, ' ').trim());

/** The price range, the highest sale-before price and stock, from the variants. */
export function summarize(variants: Variant[]): Pick<ProductRow, 'price_min' | 'price_max' | 'compare_at_max' | 'available'> {
  const prices = variants.map((v) => v.price).filter((x): x is number => x != null);
  const compares = variants.map((v) => v.compare_at).filter((x): x is number => x != null);
  return {
    price_min: prices.length ? Math.min(...prices) : null,
    price_max: prices.length ? Math.max(...prices) : null,
    compare_at_max: compares.length ? Math.max(...compares) : null,
    available: variants.some((v) => v.available),
  };
}

/** What the agent's search matches: the title, type, vendor, the tags that mean something, the variants' colours and sizes. */
export function searchText(title: string, productType: string | null, vendor: string | null, tags: string[], variants: Variant[]): string {
  // Variant titles carry colours and sizes; "Default Title" carries nothing.
  const variantWords = [...new Set(variants.map((v) => v.title).filter((t) => t && t !== DEFAULT_TITLE && !/^default title$/i.test(t)))].join(' ');
  const cleanTags = tags.filter((t: string) => !/^(yes|no)?discount|sale-tag|bogo|^\w+-\d+|group\d|^[A-Z]{1,4}$/i.test(t));
  return normalize([title, productType, vendor, cleanTags.join(' '), variantWords].filter(Boolean).join(' '));
}
