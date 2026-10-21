import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discover } from '../src/leads/discover.ts';
import { ingestStore, verifyPrices } from '../src/ingest/pack.ts';
import { chunk, kindOf, mainText, readFaqs } from '../src/ingest/pages.ts';
import { normHex, readableShade, contrast, storeColor } from '../src/ingest/brand.ts';
import { toRow, price } from '../src/ingest/shopify.ts';
import { testApp } from './helpers.ts';
import type { App } from '../src/app.ts';

async function seeded(): Promise<{ app: App; id: number }> {
  const app = await testApp();
  await discover(
    app.db,
    (async function* () {
      yield { url: 'https://kli-cheres.example/', source: 'seed', detail: {} };
    })(),
    { fetcher: app.fetcher, limit: 1 },
  );
  const s = await app.db.one<{ id: number }>("SELECT id FROM stores WHERE domain = 'kli-cheres.example'");
  return { app, id: s!.id };
}

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

test('ingest stops with a clear reason for a platform phase 1 does not ingest', async () => {
  const { app, id } = await seeded();
  await app.db.query("UPDATE stores SET platform = 'wix' WHERE id = $1", [id]);
  await assert.rejects(ingestStore(app, id), /Shopify stores only/);
  await app.db.close();
});
