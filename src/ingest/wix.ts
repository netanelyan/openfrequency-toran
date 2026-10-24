import { DEFAULT_TITLE, type ProductRow, type Variant, htmlText, plainText, searchText, summarize } from './rows.ts';

// A Wix Stores product, from its own page. Wix publishes no product feed, but every
// product page it renders carries the product as its storefront needs it, in the
// <script id="wix-warmup-data"> JSON, under appsWarmupData.<app>.productPage_<currency>_<slug>.catalog.product:
// the options (size, colour), each variant ("productItems") with its price and stock, the
// sale, the description and the photos. sitemap.ts lists the pages (store-products-sitemap.xml)
// and falls back to the page's schema.org JSON-LD when this is missing.
//
// Wix's numbers, as its pages show them:
//   price            the regular price
//   discountedPrice  what the customer pays (the same as price when there is no sale)
//   productItems[i]  price is regular; comparePrice, when above 0 and below price, is the sale price
// Stock: a variant is out when Wix says out_of_stock or hides it. Wix often reports a
// tracked variant as in_stock with quantity 0; when the product's other variants do have
// quantities, that 0 means sold out, and when every quantity is 0 the counts mean
// nothing and the status stands.

/** The product object on a Wix product page, or null when the page has none. */
export function wixWarmupProduct(html: string): any | null {
  const m = /<script[^>]*id="wix-warmup-data"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!m) return null;
  let data: any;
  try {
    data = JSON.parse(m[1]);
  } catch {
    return null;
  }
  for (const app of Object.values<any>(data?.appsWarmupData || {})) {
    if (!app || typeof app !== 'object') continue;
    for (const [k, v] of Object.entries<any>(app)) if (k.startsWith('productPage_') && v?.catalog?.product?.name) return v.catalog.product;
  }
  return null;
}

const num = (v: unknown): number | null => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 100) / 100);

/** A Wix product (wixWarmupProduct) as a row; `url` is the page it came from. */
export function wixRow(p: any, url: string, currency = 'ILS'): ProductRow {
  // Option values by selection id: a colour's value is "rgb(...)", its description is the name.
  const options: { title: string; values: Map<number, string> }[] = (p?.options || []).map((o: any) => ({
    title: plainText(o?.title),
    values: new Map((o?.selections || []).map((s: any) => [Number(s.id), plainText(s.description || s.value)])),
  }));
  const items: any[] = (p?.productItems || []).filter((i: any) => i && i.isVisible !== false);
  const tracked = p?.isTrackingInventory === true && p?.isManageProductItems === true;
  const countsMean = tracked && items.some((i) => Number(i?.inventory?.quantity) > 0);
  let variants: Variant[] = items.map((i) => {
    const values = (i.optionsSelections || []).map((id: number) => options.find((o) => o.values.has(Number(id)))?.values.get(Number(id))).filter(Boolean) as string[];
    const regular = num(i.price);
    const sale = num(i.comparePrice);
    const onSale = sale != null && sale > 0 && regular != null && sale < regular;
    const status = String(i?.inventory?.status || '');
    return {
      id: String(i.id),
      title: values.length ? values.join(' / ') : DEFAULT_TITLE,
      options: values,
      price: onSale ? sale : regular,
      compare_at: onSale ? regular : null,
      available: p?.isInStock !== false && status !== 'out_of_stock' && !(countsMean && Number(i?.inventory?.quantity) <= 0),
      sku: i.sku ? String(i.sku) : null,
    };
  });
  if (!variants.length) {
    const regular = num(p?.price);
    const paid = num(p?.discountedPrice) ?? regular;
    variants = [{ id: String(p?.id || url), title: DEFAULT_TITLE, options: [], price: paid, compare_at: regular != null && paid != null && regular > paid ? regular : null, available: p?.isInStock !== false, sku: p?.sku ? String(p.sku) : null }];
  }
  const title = plainText(p?.name);
  const tags = (p?.breadcrumbs || []).map((b: any) => plainText(b?.name)).filter(Boolean);
  const vendor = plainText(p?.brand) || null;
  const media = (p?.media || []).filter((m: any) => m?.fullUrl);
  return {
    ext_id: String(p?.id || url),
    handle: String(p?.urlPart || ''),
    title,
    vendor,
    product_type: null,
    tags,
    url,
    image: media[0]?.fullUrl || null,
    image_count: media.length,
    currency: p?.currency || currency,
    ...summarize(variants),
    variants,
    body_text: htmlText(p?.description || ''),
    search_text: searchText(title, null, vendor, tags, variants),
    source_updated_at: null,
  };
}
