import * as cheerio from 'cheerio';
import { DEFAULT_TITLE, type ProductRow, type Variant, htmlText, plainText, price, searchText, summarize } from './rows.ts';

// A Cashcow (קאש קאו) product, from its own page. Cashcow publishes no product feed and
// no JSON-LD Product, and every call its storefront makes for prices and stock is a POST
// (GetPriceForProduct, GetProductMatrix), which Toran never sends. What there is: one
// sitemap (/crowlers/sitemap, named in robots.txt) listing the products under /p/, the
// categories under /c/ and the pages under /page/, and on each product page the
// product as its own markup carries it:
//
//   <div id="productdetailscont" data-id="...">   the product's id, its schema.org
//                                                 microdata (name, image, AggregateOffer)
//   the buy button's data-price                   what the cart charges, after a sale
//   .offer-price-only[data-realprice]             the regular price, before it
//   <meta property="product:price:amount">        the same paid price, for Facebook's catalogue
//   <meta property="product:availability">        "in stock" / "out of stock"
//   select.attrObjectInput                        each option (size, colour), its values with
//                                                 data-price: what the value adds to the price
//   dataLayer.push({ ecommerce: { detail: ... }})  the price and category the store reports to
//                                                 Google Analytics: the price check's source
//
// Options are surcharges, so a variant's price is the product's price and what its
// values add. On a sale, the page shows the surcharge before the sale and the server
// computes the rest; the variant is priced at the same discount as the product (the
// ratio of the paid price to the regular one), and the decisions entry says so. An
// option the customer may leave empty (not attr_required) is an add-on: it is listed
// in the product's text, not multiplied into variants. Stock is the product's: per
// option stock is behind GetProductMatrix's POST.

const MAX_VARIANTS = 60;

/** Is this a Cashcow product page? */
export const isCashcowProduct = (html: string) => /id="productdetailscont"[^>]*data-id="\d+"/.test(html) || /class="productdetailscont"[^>]*data-id="\d+"/.test(html);

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The paid price and the category the page reports to Google Analytics (dataLayer), or nulls. */
export function cashcowDataLayer(html: string): { price: number | null; category: string | null } {
  const block = /dataLayer\.push\(\{\s*['"]ecommerce['"]\s*:\s*\{\s*['"]detail['"]([\s\S]{0,800}?)\}\s*\]/.exec(html)?.[1] || '';
  const p = /['"]price['"]\s*:\s*['"]([\d.]+)['"]/.exec(block)?.[1];
  const c = /['"]category['"]\s*:\s*['"]([^'"]*)['"]/.exec(block)?.[1];
  return { price: p ? price(p) : null, category: c ? plainText(c) : null };
}

/** A Cashcow product page as a row; null when the page is not one (a category, a page). */
export function cashcowRow(html: string, url: string, currency = 'ILS'): ProductRow | null {
  if (!isCashcowProduct(html)) return null;
  const $ = cheerio.load(html);
  const root = $('#productdetailscont, .productdetailscont[data-id]').first();
  const id = root.attr('data-id') || $('meta[property="product:retailer_item_id"]').attr('content') || '';
  const title = plainText(root.find('meta[itemprop="name"]').attr('content') || $('h1').first().text() || ($('meta[property="og:title"]').attr('content') || '').split(/\s[|-]\s/)[0]);
  if (!id || !title) return null;

  const meta = (p: string) => $(`meta[property="${p}"]`).attr('content') || null;
  const paid = price(root.find('[data-pid][data-price]').first().attr('data-price')) ?? price(meta('product:price:amount')) ?? cashcowDataLayer(html).price;
  const regulars = root.find('.offer-retail .offer-price-only[data-realprice], .offer-price-only[data-realprice]').map((_, el) => price($(el).attr('data-realprice'))).get().filter((x): x is number => x != null && x > 0);
  const regular = regulars.length ? Math.min(...regulars) : null;
  const onSale = paid != null && regular != null && regular > paid;
  const ratio = onSale ? paid / regular : 1;
  const cur = meta('product:price:currency') || root.find('[itemprop="priceCurrency"]').attr('content') || currency;

  const availability = `${meta('product:availability') || ''} ${root.find('[itemprop="availability"]').attr('href') || ''}`;
  const outBox = root.find('.out-of-qty-msg').first();
  const available = !/out of stock|OutOfStock|SoldOut|discontinued/i.test(availability) && !(outBox.length && !outBox.closest('.cc-hidden').length);

  // The options: a required one multiplies the variants, an optional one is an add-on.
  type Opt = { title: string; values: { id: string; name: string; add: number }[] };
  const required: Opt[] = [];
  const addOns: Opt[] = [];
  root.find('select.attrObjectInput').each((_, el) => {
    const sel = $(el);
    const o: Opt = {
      title: plainText(sel.closest('.attr_cont').find('.attr-title').first().text()).replace(/[^\p{L}\p{N}\s"'״׳()./-]/gu, '').trim(),
      values: sel.find('option').filter((_, op) => $(op).attr('value') !== '-1').map((_, op) => ({ id: String($(op).attr('value')), name: plainText($(op).text()).replace(/\s*-\s*בתוספת של:?.*$/, '').trim(), add: price($(op).attr('data-price')) || 0 })).get(),
    };
    if (!o.values.length) return;
    (sel.attr('attr_required') === '1' ? required : addOns).push(o);
  });

  let combos: Opt['values'][] = [[]];
  for (const o of required) {
    const next = combos.flatMap((c) => o.values.map((v) => [...c, v]));
    if (next.length > MAX_VARIANTS) break; // past this the first options are enough to quote from
    combos = next;
  }
  const variants: Variant[] = combos.map((c) => {
    const add = c.reduce((s, v) => s + v.add, 0);
    return {
      id: c.length ? `${id}:${c.map((v) => v.id).join('-')}` : id,
      title: c.length ? c.map((v) => v.name).join(' / ') : DEFAULT_TITLE,
      options: c.map((v) => v.name),
      price: paid == null ? null : round2(paid + add * ratio),
      compare_at: onSale ? round2(regular! + add) : null,
      available,
      sku: null,
    };
  });

  const category = cashcowDataLayer(html).category;
  const crumbs = $('[itemprop="itemListElement"] [itemprop="name"]').map((_, el) => plainText($(el).attr('content') || $(el).text())).get().filter((t) => t && t !== title && !/^(ראשי|דף הבית|דף בית|עמוד הבית|home)$/i.test(t));
  const tags = [...new Set([category, ...crumbs].filter(Boolean) as string[])];
  const images = root.find('img[itemprop="image"]').map((_, el) => $(el).attr('src')).get().filter(Boolean);
  const extras = addOns.map((o) => `${o.title}: ${o.values.map((v) => (v.add ? `${v.name} (תוספת ${v.add} ₪)` : v.name)).join(', ')}`);
  const body = [htmlText($('#product-short-description').html() || ''), htmlText(root.find('#cc-details .description').html() || ''), extras.length ? `אפשר להוסיף: ${extras.join('; ')}` : ''].filter(Boolean).join('\n');
  let handle = url;
  try {
    handle = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || url);
  } catch {
    /* kept as it is */
  }
  return {
    ext_id: id,
    handle,
    title,
    vendor: null,
    product_type: category || tags[0] || null,
    tags,
    url,
    image: images[0] || meta('og:image'),
    image_count: images.length || (meta('og:image') ? 1 : 0),
    currency: cur,
    ...summarize(variants),
    variants,
    body_text: body.slice(0, 2500),
    search_text: searchText(title, category || tags[0] || null, null, tags, variants),
    source_updated_at: null,
  };
}

/** The price check's source on a Cashcow page: the price it reports to Google Analytics, else Facebook's catalogue tag. */
export function cashcowLivePrice(html: string): number | null {
  return cashcowDataLayer(html).price ?? price(/<meta property="product:price:amount" content="([\d.]+)"/.exec(html)?.[1]);
}
