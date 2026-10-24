import { type Fetcher, FetchError, getJson } from '../core/http.ts';
import { DEFAULT_TITLE, type ProductRow, type Variant, htmlText, plainText, searchText, summarize } from './rows.ts';

// A WooCommerce store's catalogue, from its public Store API (the one its own cart and
// checkout blocks call, no key needed):
//
//   GET /wp-json/wc/store/v1/products?per_page=100&page=N
//       every published product; X-WP-TotalPages says when to stop
//   GET /wp-json/wc/store/v1/products?type=variation&per_page=100&page=N
//       every variation of every variable product, each with its parent, its own price
//       and its own stock: one listing instead of a request per product
//
// Prices are strings in the currency's minor unit, and the unit is given per store:
// "10000" with currency_minor_unit 2 is 100.00 ₪, "295" with 0 is 295 ₪. Names come
// with HTML entities ("&quot;"), decoded here.
//
// A store that turned the Store API off, put it behind a firewall, or answers it with
// no products is read from its sitemap instead (sitemap.ts), and ingest says so.

export const STORE_API = '/wp-json/wc/store/v1/products';
const PER_PAGE = 100;
const MAX_PAGES = 50; // 5,000 products, as for Shopify

/** A Store API amount in shekels: "10000" at minor unit 2 is 100. */
export function minor(v: unknown, unit: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const u = Number.isInteger(Number(unit)) ? Number(unit) : 2;
  return Math.round((n / 10 ** u) * 100) / 100;
}

/** One variation's options as Shopify writes a variant title: "כסף / אמטיסט". */
const optionValues = (v: any): string[] => (Array.isArray(v?.variation_attributes) ? v.variation_attributes : Array.isArray(v?.attributes) ? v.attributes : []).map((a: any) => plainText(a?.value ?? a?.option)).filter(Boolean);

function variationValues(v: any): string[] {
  const own = optionValues(v);
  if (own.length) return own;
  // The listing gives "מתכת: כסף, אבן: אמטיסט" in `variation`.
  return plainText(v?.variation || '').split(/,\s*/).map((part) => part.split(/:\s*/).slice(1).join(':').trim() || part.trim()).filter(Boolean);
}

function variantOf(v: any, fallbackTitle: string): Variant {
  const unit = v?.prices?.currency_minor_unit;
  const p = minor(v?.prices?.price, unit);
  const regular = minor(v?.prices?.regular_price, unit);
  const values = variationValues(v);
  return {
    id: String(v.id),
    title: values.length ? values.join(' / ') : fallbackTitle,
    options: values,
    price: p,
    compare_at: regular != null && p != null && regular > p ? regular : null,
    available: v?.is_in_stock !== false,
    sku: v?.sku ? String(v.sku) : null,
  };
}

/** A Store API product as a row; `variations` are its own, from the variation listing. */
export function wooRow(p: any, variations: any[] = [], currency = 'ILS'): ProductRow {
  const unit = p?.prices?.currency_minor_unit;
  let variants: Variant[];
  // A variable product whose variations were not listed keeps its range (price_range), and no options.
  const range = !variations.length && p?.prices?.price_range ? { lo: minor(p.prices.price_range.min_amount, unit), hi: minor(p.prices.price_range.max_amount, unit) } : null;
  if (variations.length) variants = variations.map((v) => variantOf(v, DEFAULT_TITLE));
  else if (range) variants = [{ id: String(p.id), title: DEFAULT_TITLE, options: [], price: range.lo, compare_at: null, available: true, sku: p.sku ? String(p.sku) : null }];
  else variants = [variantOf({ ...p, variation: '', attributes: [] }, DEFAULT_TITLE)];
  // A variable product is in stock when one of its variations is; its own flag says the same, or more.
  if (!variations.length && p?.is_in_stock === false) variants = variants.map((v) => ({ ...v, available: false }));

  const title = plainText(p?.name);
  const categories = (p?.categories || []).map((c: any) => plainText(c?.name)).filter(Boolean);
  const tags = [...categories, ...(p?.tags || []).map((t: any) => plainText(t?.name)).filter(Boolean)];
  const vendor = plainText(p?.brands?.[0]?.name) || null;
  const productType = categories[0] || null;
  const body = [htmlText(p?.short_description || ''), htmlText(p?.description || '')].filter(Boolean).join('\n');
  let handle = String(p?.slug || '');
  try {
    handle = decodeURIComponent(handle);
  } catch {
    /* kept as sent */
  }
  return {
    ext_id: String(p.id),
    handle,
    title,
    vendor,
    product_type: productType,
    tags,
    url: String(p?.permalink || ''),
    image: p?.images?.[0]?.src || null,
    image_count: Array.isArray(p?.images) ? p.images.length : 0,
    currency: p?.prices?.currency_code || currency,
    ...summarize(variants),
    ...(range?.hi != null ? { price_max: range.hi } : {}),
    variants,
    body_text: body.slice(0, 2500),
    search_text: searchText(title, productType, vendor, tags, variants),
    source_updated_at: null, // the Store API gives no dates
  };
}

/** Every page of one Store API listing. Throws when the API is not there (404, a firewall's HTML, robots). */
async function listAll(fetcher: Fetcher, origin: string, extra: string, onPage?: (page: number, n: number) => void): Promise<any[]> {
  const out: any[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { data, res } = await getJson<any[]>(fetcher, `${origin}${STORE_API}?per_page=${PER_PAGE}&page=${page}${extra}`);
    if (!Array.isArray(data)) throw new FetchError('the Store API did not answer a list', 'not_json', origin);
    out.push(...data);
    onPage?.(page, out.length);
    const pages = Number(res.headers['x-wp-totalpages']);
    if (data.length < PER_PAGE || (Number.isFinite(pages) && page >= pages)) break;
  }
  return out;
}

export type WooCatalogue = { rows: ProductRow[]; currency: string | null; warnings: string[] };

export async function fetchWooCatalogue(fetcher: Fetcher, origin: string, { onPage }: { onPage?: (page: number, n: number) => void } = {}): Promise<WooCatalogue> {
  const warnings: string[] = [];
  const products = await listAll(fetcher, origin, '', onPage);
  const byParent = new Map<number, any[]>();
  if (products.some((p) => p?.type === 'variable')) {
    try {
      for (const v of await listAll(fetcher, origin, '&type=variation')) {
        if (v?.type !== 'variation' || !v.parent) continue;
        const list = byParent.get(Number(v.parent)) || [];
        list.push(v);
        byParent.set(Number(v.parent), list);
      }
    } catch (e: any) {
      warnings.push(`the variations did not load (${e.code || e.message}): variable products have their price range only`);
    }
  }
  const currency = products.find((p) => p?.prices?.currency_code)?.prices.currency_code || null;
  const rows = products.filter((p) => p && p.type !== 'variation' && p.id).map((p) => wooRow(p, byParent.get(Number(p.id)) || [], currency || 'ILS'));
  return { rows, currency, warnings };
}

/** One product from the Store API's single-product route: the independent check of a stored price. */
export async function wooProduct(fetcher: Fetcher, origin: string, id: string): Promise<{ price_min: number | null; available: boolean } | null> {
  try {
    const { data } = await getJson<any>(fetcher, `${origin}${STORE_API}/${encodeURIComponent(id)}`);
    if (!data?.prices) return null;
    const unit = data.prices.currency_minor_unit;
    const lo = data.prices.price_range ? minor(data.prices.price_range.min_amount, unit) : minor(data.prices.price, unit);
    return { price_min: lo, available: data.is_in_stock !== false };
  } catch {
    return null;
  }
}
