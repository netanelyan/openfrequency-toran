import { type Fetcher, getJson } from '../core/http.ts';
import { type ProductRow, type Variant, htmlText, price, searchText, summarize } from './rows.ts';

export { type ProductRow, type Variant, htmlText, price } from './rows.ts';

// A Shopify store's catalogue, from its public feed (/products.json, 250 a page), as
// rows (rows.ts): one product a row, its variants with their own prices and stock, and
// the text the agent searches. Prices are kept exactly as the feed gives them (strings of
// shekels with agorot, "99.00"), parsed to numbers once, here.
//
// /meta.json (Shopify's public store summary) gives the currency, the store's name
// and its published product count.

export type ShopMeta = { name?: string; currency?: string; country?: string; published_products_count?: number; description?: string; myshopify_domain?: string; money_format?: string };

const MAX_PAGES = 20; // 5,000 products: far past any store Toran is for

export function toRow(p: any, origin: string, currency: string): ProductRow {
  const variants: Variant[] = (p.variants || []).map((v: any) => ({
    id: String(v.id),
    title: String(v.title || ''),
    options: [v.option1, v.option2, v.option3].filter((o: unknown) => o != null && o !== '').map(String),
    price: price(v.price),
    compare_at: price(v.compare_at_price),
    available: v.available !== false,
    sku: v.sku ? String(v.sku) : null,
  }));
  const tags = Array.isArray(p.tags) ? p.tags.map(String) : String(p.tags || '').split(',').map((t: string) => t.trim()).filter(Boolean);
  const title = String(p.title || '').trim();
  return {
    ext_id: String(p.id),
    handle: String(p.handle || ''),
    title,
    vendor: p.vendor ? String(p.vendor) : null,
    product_type: p.product_type ? String(p.product_type) : null,
    tags,
    url: `${origin}/products/${p.handle}`,
    image: p.images?.[0]?.src || p.image?.src || null,
    image_count: Array.isArray(p.images) ? p.images.length : p.image?.src ? 1 : 0,
    currency,
    ...summarize(variants),
    variants,
    body_text: htmlText(p.body_html || ''),
    search_text: searchText(title, p.product_type ? String(p.product_type) : null, p.vendor ? String(p.vendor) : null, tags, variants),
    source_updated_at: p.updated_at || p.published_at || null,
  };
}

export async function shopMeta(fetcher: Fetcher, origin: string): Promise<ShopMeta> {
  try {
    const { data } = await getJson<ShopMeta>(fetcher, `${origin}/meta.json`);
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

export async function fetchCatalogue(fetcher: Fetcher, origin: string, currency = 'ILS', { onPage }: { onPage?: (page: number, n: number) => void } = {}): Promise<ProductRow[]> {
  const rows: ProductRow[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { data } = await getJson<{ products?: any[] }>(fetcher, `${origin}/products.json?limit=250&page=${page}`);
    const list = Array.isArray(data?.products) ? data.products : [];
    for (const p of list) rows.push(toRow(p, origin, currency));
    onPage?.(page, rows.length);
    if (list.length < 250) break;
  }
  return rows;
}

/** One product's own JSON (/products/<handle>.js): prices in agorot. The independent check of a stored price. */
export async function productJs(fetcher: Fetcher, origin: string, handle: string): Promise<{ price_min: number | null; available: boolean; variants: { id: string; price: number }[] } | null> {
  try {
    const { data } = await getJson<any>(fetcher, `${origin}/products/${encodeURIComponent(handle)}.js`);
    const vs = (data?.variants || []).map((v: any) => ({ id: String(v.id), price: Math.round(Number(v.price)) / 100, available: v.available !== false }));
    return { price_min: vs.length ? Math.min(...vs.map((v: any) => v.price)) : null, available: vs.some((v: any) => v.available), variants: vs };
  } catch {
    return null;
  }
}
