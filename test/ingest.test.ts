import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discover } from '../src/leads/discover.ts';
import { ingestStore, verifyPrices } from '../src/ingest/pack.ts';
import { chunk, kindOf, mainText, readFaqs } from '../src/ingest/pages.ts';
import { normHex, readableShade, contrast, storeColor } from '../src/ingest/brand.ts';
import { toRow, price } from '../src/ingest/shopify.ts';
import { minor, wooRow } from '../src/ingest/woocommerce.ts';
import { jsonLdProducts, ldRow, readSitemap } from '../src/ingest/sitemap.ts';
import { canIngest } from '../src/ingest/catalogue.ts';
import { runTool } from '../src/agent/tools.ts';
import { buildPitch } from '../src/pitch/build.ts';
import { pitchData, pitchPage } from '../src/pitch/page.ts';
import { WIX_DOMAIN, WOO_DOMAIN, WOO_SITEMAP_DOMAIN } from '../src/demo.ts';
import { testApp } from './helpers.ts';
import type { App } from '../src/app.ts';

async function seeded(url = 'https://kli-cheres.example/'): Promise<{ app: App; id: number }> {
  const app = await testApp();
  await discover(
    app.db,
    (async function* () {
      yield { url, source: 'seed', detail: {} };
    })(),
    { fetcher: app.fetcher, limit: 1 },
  );
  const s = await app.db.one<{ id: number }>('SELECT id FROM stores WHERE domain = $1', [new URL(url).hostname.replace(/^www\./, '')]);
  return { app, id: s!.id };
}

const product = (app: App, id: number, title: string) => app.db.one<any>('SELECT id, ext_id, url, price_min::float, price_max::float, compare_at_max::float, available, variants FROM products WHERE store_id = $1 AND title = $2', [id, title]);

test('a product row keeps every variant price exactly, the range, the sale price and stock', () => {
  const r = toRow({ id: 1, title: 'ספל', handle: 'mug', tags: ['a'], variants: [{ id: 11, title: 'חול', option1: 'חול', price: '89.00', available: true }, { id: 12, title: 'אפור', option1: 'אפור', price: '99.90', compare_at_price: '120.00', available: false }] }, 'https://s.example', 'ILS');
  assert.equal(r.price_min, 89);
  assert.equal(r.price_max, 99.9);
  assert.equal(r.compare_at_max, 120);
  assert.equal(r.available, true);
  assert.deepEqual(r.variants.map((v) => v.available), [true, false]);
  assert.equal(r.url, 'https://s.example/products/mug');
  assert.equal(price('1,290.50'), 1290.5);
});

test('policy pages: kinds, the main text without the chrome, FAQ questions with their answers, chunks', () => {
  assert.equal(kindOf('מדיניות משלוחים', '/policies/shipping-policy'), 'shipping');
  assert.equal(kindOf('', '/policies/refund-policy'), 'returns');
  assert.equal(kindOf('מדיניות פרטיות', '/policies/privacy-policy'), 'skip');
  const m = mainText('<html><body><header>תפריט עליון</header><main><h1>משלוחים</h1><p>משלוח 35 ₪.</p></main><footer>פוטר</footer></body></html>');
  assert.equal(m.title, 'משלוחים');
  assert.ok(m.text.includes('משלוח 35 ₪') && !m.text.includes('תפריט') && !m.text.includes('פוטר'));
  const faqs = readFaqs('<main><details><summary>אפשר לשלם בביט?</summary><p>כן, בביט ובאשראי.</p></details></main>', 'https://s.example/pages/faq');
  assert.equal(faqs[0].question, 'אפשר לשלם בביט?');
  assert.match(faqs[0].site_answer || '', /בביט ובאשראי/);
  const parts = chunk(`${'א'.repeat(400)}\n${'ב'.repeat(400)}\n${'ג'.repeat(100)}`, 700);
  assert.equal(parts.length, 2);
});

test('brand colours: Shopify\'s "r,g,b" settings, contrast, a readable shade, a neutral fallback', () => {
  assert.equal(normHex('180,83,42'), '#b4532a');
  assert.equal(normHex('rgb(46, 94, 78)'), '#2e5e4e');
  assert.equal(normHex('#abc'), '#aabbcc');
  assert.ok(contrast(readableShade('#f2c94c'), '#ffffff') >= 4.5);
  assert.equal(storeColor({ colors: ['#ffffff', '#111111'] }), '#4a4a52');
});

test('ingest of the fictional store: every product with the right prices, the policies, FAQ, brand and tone', async () => {
  const { app, id } = await seeded();
  const s = await ingestStore(app, id);
  assert.equal(s.products, 14);
  assert.equal(s.available, 13);
  assert.deepEqual(s.policies.map((p) => p.kind).sort(), ['contact', 'faq', 'returns', 'shipping']);
  assert.ok(s.chunks >= 4);
  assert.equal(s.faqs, 3);
  assert.deepEqual(s.brand.colors[0], '#b4532a');
  assert.ok(s.brand.tone);
  const mug = await app.db.one<any>("SELECT price_min::float, price_max::float, available, variants FROM products WHERE store_id = $1 AND handle = 'sandy-mug'", [id]);
  assert.equal(mug.price_min, 89);
  assert.equal(mug.variants.length, 3);
  assert.equal(mug.variants.find((v: any) => v.title.startsWith('תכלת')).available, false);
  const platter = await app.db.one<any>("SELECT price_min::float, compare_at_max::float FROM products WHERE store_id = $1 AND handle = 'oval-platter'", [id]);
  assert.deepEqual([platter.price_min, platter.compare_at_max], [149, 189]);
  const v = await verifyPrices(app, id, 14);
  assert.equal(v.checked, 14);
  assert.equal(v.mismatches.length, 0);
  await app.db.close();
});

test('a re-scrape keeps the owner\'s corrections and FAQ answers, and marks products that left the feed', async () => {
  const { app, id } = await seeded();
  await ingestStore(app, id);
  await app.db.query("UPDATE products SET override = '{\"price\": 79}'::jsonb WHERE store_id = $1 AND handle = 'sandy-mug'", [id]);
  await app.db.query("UPDATE faqs SET answer = 'כן, עד 3 תשלומים.' WHERE store_id = $1 AND question LIKE '%ביט%'", [id]);
  await app.db.query("UPDATE policies SET override_text = 'משלוח 30 ₪.' WHERE store_id = $1 AND kind = 'shipping'", [id]);
  await app.db.query("INSERT INTO products (store_id, ext_id, title, search_text) VALUES ($1, 'old-1', 'מוצר ישן', 'מוצר ישן')", [id]);
  const s = await ingestStore(app, id);
  assert.equal(s.gone, 1);
  const mug = await app.db.one<any>("SELECT override FROM products WHERE store_id = $1 AND handle = 'sandy-mug'", [id]);
  assert.equal(mug.override.price, 79);
  const faq = await app.db.one<any>("SELECT answer FROM faqs WHERE store_id = $1 AND question LIKE '%ביט%'", [id]);
  assert.equal(faq.answer, 'כן, עד 3 תשלומים.');
  const pol = await app.db.one<any>("SELECT override_text FROM policies WHERE store_id = $1 AND kind = 'shipping'", [id]);
  assert.equal(pol.override_text, 'משלוח 30 ₪.');
  await app.db.close();
});

test('ingest stops with a clear reason for a platform it does not read', async () => {
  const { app, id } = await seeded();
  await app.db.query("UPDATE stores SET platform = 'konimbo' WHERE id = $1", [id]);
  await assert.rejects(ingestStore(app, id), /Toran reads Shopify, WooCommerce and Wix stores/);
  assert.deepEqual(['shopify', 'woocommerce', 'wix', 'konimbo', 'other'].map(canIngest), [true, true, true, false, false]);
  await app.db.close();
});

// ---- WooCommerce and Wix. The fictional stores' responses keep the shapes recorded from real Israeli stores (src/demo.ts).

test('a WooCommerce Store API product: prices in the store\'s minor unit, the sale, the entities in the name', () => {
  assert.equal(minor('10000', 2), 100);
  assert.equal(minor('295', 0), 295);
  // As a store with currency_minor_unit 0 sends it (recorded), names and numbers changed.
  const r = wooRow({ id: 7, name: 'טבעת &quot;לילך&quot;', slug: '%d7%9c%d7%99%d7%9c%d7%9a', type: 'simple', permalink: 'https://s.example/product/x/', prices: { price: '295', regular_price: '328', sale_price: '295', price_range: null, currency_code: 'ILS', currency_minor_unit: 0 }, is_in_stock: true, images: [], categories: [{ name: 'טבעות' }], tags: [], brands: [] });
  assert.equal(r.title, 'טבעת "לילך"');
  assert.equal(r.handle, 'לילך');
  assert.deepEqual([r.price_min, r.compare_at_max, r.product_type, r.variants[0].title], [295, 328, 'טבעות', 'Default Title']);
});

test('JSON-LD: a product in Yoast\'s @graph, an AggregateOffer range, stock, and a sitemap\'s entries', () => {
  const html = '<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebPage"},{"@type":"Product","name":"סבון","offers":[{"@type":"AggregateOffer","lowPrice":"30.00","highPrice":"55.00","availability":"https://schema.org/InStock","priceCurrency":"ILS"}]}]}</script>';
  const [ld] = jsonLdProducts(html);
  const r = ldRow(ld, 'https://s.example/product/soap/', '<body class="single postid-12">');
  assert.deepEqual([r?.ext_id, r?.price_min, r?.price_max, r?.available], ['12', 30, 55, true]);
  const out = ldRow({ '@type': 'Product', name: 'נר', offers: { '@type': 'Offer', price: '18', availability: 'https://schema.org/OutOfStock' } }, 'https://s.example/product-page/נר');
  assert.deepEqual([out?.ext_id, out?.available], ['/product-page/נר', false]);
  const s = readSitemap('<urlset><url><loc>https://s.example/a</loc><lastmod>2026-10-01</lastmod></url><url><loc>https://s.example/b?x=1&amp;y=2</loc></url></urlset>');
  assert.deepEqual(s.entries, [{ loc: 'https://s.example/a', lastmod: '2026-10-01' }, { loc: 'https://s.example/b?x=1&y=2', lastmod: null }]);
});

test('a WooCommerce store, through its Store API: variations with their own prices and stock, the sale, policies from a Hebrew slug, the standard address and the sitemap', async () => {
  const { app, id } = await seeded(`https://${WOO_DOMAIN}/`);
  try {
    assert.equal((await app.db.one<any>('SELECT platform FROM stores WHERE id = $1', [id])).platform, 'woocommerce');
    const s = await ingestStore(app, id);
    assert.equal(s.products, 6);
    assert.equal(s.available, 5);
    assert.equal(s.currency, 'ILS');
    assert.deepEqual(s.policies.map((p) => p.kind).sort(), ['contact', 'faq', 'returns', 'shipping']);
    assert.equal(s.faqs, 2);
    assert.ok(!s.warnings.some((w) => /Store API|shipping|returns/.test(w)), s.warnings.join('; '));
    const zaatar = await product(app, id, 'זעתר "של סבתא"');
    assert.deepEqual([zaatar.ext_id, zaatar.price_min, zaatar.price_max], ['310', 24, 49]);
    assert.deepEqual(zaatar.variants.map((v: any) => [v.title, v.price]), [['100 גרם', 24], ['250 גרם', 49]]);
    const paprika = await product(app, id, 'פפריקה מעושנת');
    assert.deepEqual(paprika.variants.map((v: any) => [v.title, v.available]), [['100 גרם / מתוקה', true], ['250 גרם / מתוקה', true], ['100 גרם / חריפה', false]]);
    const baharat = await product(app, id, 'בהרט');
    assert.deepEqual([baharat.price_min, baharat.compare_at_max], [29, 39]);
    assert.equal((await product(app, id, 'סומק')).available, false);
    const v = await verifyPrices(app, id, 6);
    assert.deepEqual([v.checked, v.mismatches.length], [6, 0]);
  } finally {
    await app.db.close();
  }
});

test('a WooCommerce store whose Store API is behind a firewall is read from its sitemap and its product pages\' JSON-LD, and says so', async () => {
  const { app, id } = await seeded(`https://${WOO_SITEMAP_DOMAIN}/`);
  try {
    assert.equal((await app.db.one<any>('SELECT platform FROM stores WHERE id = $1', [id])).platform, 'woocommerce');
    const s = await ingestStore(app, id);
    assert.ok(s.warnings.some((w) => /Store API did not answer.*sitemap/.test(w)), s.warnings.join('; '));
    assert.equal(s.products, 4, 'the shop page in the product sitemap sells nothing and is left out');
    assert.deepEqual(s.policies.map((p) => p.kind), ['returns']);
    const lavender = await product(app, id, 'סבון לבנדר');
    assert.deepEqual([lavender.ext_id, lavender.price_min, lavender.price_max], ['420', 30, 55]);
    assert.equal((await product(app, id, 'סבון חלב עיזים')).available, false);
    assert.equal((await product(app, id, 'מארז "שלושה סבונים"')).price_min, 99, 'a product inside a Yoast @graph');
    const v = await verifyPrices(app, id, 4);
    assert.deepEqual([v.checked, v.mismatches.length], [4, 0]);
  } finally {
    await app.db.close();
  }
});

test('a Wix store: pages from the products sitemap, variants and stock from Wix\'s own data, the sale, JSON-LD when that is missing, policies from the pages sitemap', async () => {
  const { app, id } = await seeded(`https://${WIX_DOMAIN}/`);
  try {
    assert.equal((await app.db.one<any>('SELECT platform FROM stores WHERE id = $1', [id])).platform, 'wix');
    const s = await ingestStore(app, id);
    assert.equal(s.products, 4);
    assert.equal(s.available, 3);
    assert.deepEqual(s.policies.map((p) => p.kind).sort(), ['about', 'contact', 'shipping', 'terms']);
    assert.ok(!s.warnings.some((w) => /product pages|sitemap/.test(w)), s.warnings.join('; '));
    const jar = await product(app, id, 'נר סויה בצנצנת');
    assert.deepEqual([jar.price_min, jar.price_max], [69, 89]);
    // Wix says in_stock with quantity 0; the other variants' counts show that 0 means sold out. The hidden one is not offered.
    assert.deepEqual(jar.variants.map((v: any) => [v.title, v.available]), [['קטן / לבנדר', true], ['קטן / וניל', false], ['גדול / לבנדר', true]]);
    assert.match(jar.url, /^https:\/\/www\.quiet-candles\.example\/product-page\//);
    const box = await product(app, id, 'מארז שלושה נרות');
    assert.deepEqual([box.price_min, box.compare_at_max], [120, 150]);
    assert.equal((await product(app, id, 'נר עמוד לבן')).available, false);
    assert.equal((await product(app, id, 'גפרורים ארוכים')).price_min, 18, 'a page without Wix\'s data is read from its JSON-LD');
    const v = await verifyPrices(app, id, 4);
    assert.deepEqual([v.checked, v.mismatches.length], [4, 0]);
  } finally {
    await app.db.close();
  }
});

test('from a WooCommerce or Wix lead to the demo: the agent\'s tools answer from the rows, and the pitch page is built with a sample chat', async () => {
  for (const host of [WOO_DOMAIN, WIX_DOMAIN]) {
    const { app, id } = await seeded(`https://${host}/`);
    try {
      await ingestStore(app, id);
      const woo = host === WOO_DOMAIN;
      const ctx = { db: app.db, storeId: id, origin: `https://${host}`, currency: 'ILS' };
      const found = await runTool(ctx, 'search_products', { query: woo ? 'זעתר' : 'נר סויה' });
      assert.match(found.content, woo ? /זעתר "של סבתא": 24 ₪ עד 49 ₪, במלאי, 2 options/ : /נר סויה בצנצנת: 69 ₪ עד 89 ₪, במלאי, 3 options/);
      const pid = Number(/\[id (\d+)\]/.exec(found.content)![1]);
      const one = await runTool(ctx, 'get_product', { product_id: pid });
      assert.match(one.content, woo ? /250 גרם: 49 ₪, במלאי/ : /קטן \/ וניל: 69 ₪, אזל מהמלאי/);
      const policy = await runTool(ctx, 'get_policy', { topic: 'כמה עולה משלוח?' });
      assert.match(policy.content, woo ? /30 ₪/ : /35 ₪/);
      const cart = await runTool(ctx, 'create_cart_link', { items: [{ product_id: pid }] });
      assert.match(cart.content, woo ? /^DEMO: in the live version this is one link to a ready cart/ : /^DEMO: Wix has no link that fills a cart/);
      assert.ok(cart.content.includes(woo ? `https://${host}/product/` : `https://www.${host}/product-page/`));
      await buildPitch(app, id);
      const p = await app.db.one<any>('SELECT sample_chat FROM pitches WHERE store_id = $1', [id]);
      assert.deepEqual(p.sample_chat.map((m: any) => m.role), ['customer', 'agent', 'customer', 'agent']);
      const store = await app.db.one<any>('SELECT slug FROM stores WHERE id = $1', [id]);
      const html = pitchPage((await pitchData(app, store.slug))!, { env: app.env, owner: true });
      assert.ok(html.includes(woo ? 'תבלינים בשוק' : 'נרות שקטים'));
    } finally {
      await app.db.close();
    }
  }
});
