import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedDemo } from '../src/demoSeed.ts';
import { getOffer, setOffer, priceSentence, OFFER_DEFAULT } from '../src/offer.ts';
import { pitchGaps } from '../src/pitch/ready.ts';
import { pitchData, pitchPage, shelfRows, themeCss, type PitchData } from '../src/pitch/page.ts';
import { buildPitch } from '../src/pitch/build.ts';
import { contrast, displayName } from '../src/ingest/brand.ts';
import { testApp } from './helpers.ts';

const OFFER = { monthly: 199, vat: 'excluded' as const, setup: 0, city: 'אשדוד' };
const ENV = { DEMO_WA_NUMBER: '972500000999', TORAN_OWNER_WHATSAPP: '972500000888', PUBLIC_BASE_URL: 'https://toran.example' };

async function seeded() {
  const app = await testApp();
  Object.assign(app.env, ENV);
  const s = await seedDemo(app, { conversation: false });
  const store = await app.db.one<any>('SELECT * FROM stores WHERE id = $1', [s.storeId]);
  return { app, s, store };
}

test('the sample chat is two questions and two answers by the agent, about one product, second question from the pack', async () => {
  const { app, s } = await seeded();
  try {
    const p = await app.db.one<any>('SELECT sample_chat FROM pitches WHERE store_id = $1', [s.storeId]);
    assert.deepEqual(p.sample_chat.map((m: any) => m.role), ['customer', 'agent', 'customer', 'agent']);
    assert.match(p.sample_chat[0].text, /^היי, יש לכם .+\? כמה זה עולה\?$/);
    assert.equal(p.sample_chat[2].text, 'ותוך כמה זמן זה מגיע?', 'the store has a shipping page, so the second question is about delivery');
    const ev = await app.db.one<any>("SELECT data FROM events WHERE store_id = $1 AND kind = 'page_built' ORDER BY at DESC LIMIT 1", [s.storeId]);
    assert.equal(ev.data.sample, 'agent');
  } finally {
    await app.db.close();
  }
});

test('when every answer hands off there is no sample chat, no row-built stand-in, and the page waits with that gap', async () => {
  const app = await testApp({
    script: (req) => {
      const last = req.messages[req.messages.length - 1];
      const answered = Array.isArray(last.content) && last.content.some((b: any) => b.type === 'tool_result');
      return answered ? [{ type: 'text', text: 'העברתי את השאלה לחנות, ויחזרו אליך כאן.' }] : [{ type: 'tool_use', id: 'h1', name: 'handoff', input: { reason: 'unknown', summary: 'x' } } as any];
    },
  });
  Object.assign(app.env, ENV);
  try {
    const s = await seedDemo(app, { conversation: false });
    const p = await app.db.one<any>('SELECT sample_chat FROM pitches WHERE store_id = $1', [s.storeId]);
    assert.deepEqual(p.sample_chat, []);
    const store = await app.db.one<any>('SELECT * FROM stores WHERE id = $1', [s.storeId]);
    assert.ok((await pitchGaps(app, store)).some((g) => g.key === 'sample'));
  } finally {
    await app.db.close();
  }
});

test('a page is held for each missing field: price, the two numbers, the colour, the name', async () => {
  const { app, store } = await seeded();
  try {
    const keys = async () => (await pitchGaps(app, await app.db.one<any>('SELECT * FROM stores WHERE id = $1', [store.id]))).map((g) => g.key).sort();
    assert.deepEqual(await keys(), ['price'], 'no price set yet');
    await setOffer(app.db, { ...OFFER, setup: null });
    assert.deepEqual(await keys(), ['price'], 'a setup fee that is not decided still holds the page');
    await setOffer(app.db, OFFER);
    assert.deepEqual(await keys(), []);
    app.env.TORAN_OWNER_WHATSAPP = app.env.DEMO_WA_NUMBER;
    assert.deepEqual(await keys(), ['of_number'], 'our number may not be the demo number');
    app.env.TORAN_OWNER_WHATSAPP = ENV.TORAN_OWNER_WHATSAPP;
    delete app.env.DEMO_WA_NUMBER;
    assert.deepEqual(await keys(), ['demo_number']);
    app.env.DEMO_WA_NUMBER = ENV.DEMO_WA_NUMBER;
    await app.db.query("UPDATE stores SET brand = brand - 'colors' WHERE id = $1", [store.id]);
    assert.deepEqual(await keys(), ['color'], 'no colour from the site: no grey guess');
    await app.db.query(`UPDATE stores SET brand_override = '{"colors":["#2e7d6b"]}'::jsonb WHERE id = $1`, [store.id]);
    assert.deepEqual(await keys(), [], 'the owner picked one');
    await app.db.query("UPDATE stores SET name = NULL, brand = brand - 'name' WHERE id = $1", [store.id]);
    assert.deepEqual(await keys(), ['name'], 'no name: never the domain instead');
  } finally {
    await app.db.close();
  }
});

test('the owner\'s preview of a held page shows each gap as a visible placeholder and says why', async () => {
  const { app, store } = await seeded();
  try {
    const d = (await pitchData(app, store.slug))!;
    assert.equal(d.public, false);
    const html = pitchPage(d, { env: app.env, owner: true });
    assert.match(html, /class="held"/);
    assert.match(html, /המחיר עוד לא נקבע/);
    assert.match(html, /<mark class="ph" dir="rtl">\[המחיר\] ₪<\/mark> לחודש, <mark class="ph" dir="rtl">\[כולל או לא כולל מע״מ\]<\/mark>/);
  } finally {
    await app.db.close();
  }
});

test('the price sentence comes from the one offer, with VAT said and the setup fee only when there is one', async () => {
  const plain = (s: string) => s;
  assert.equal(priceSentence(OFFER, plain), 'זה 199 ₪ לחודש, לא כולל מע״מ.');
  assert.equal(priceSentence({ ...OFFER, vat: 'included', setup: 1500 }, plain), 'זה 199 ₪ לחודש, כולל מע״מ, ועוד 1,500 ₪ דמי הקמה, פעם אחת.');
  const { app } = await seeded();
  try {
    assert.deepEqual(await getOffer(app.db), OFFER_DEFAULT, 'no price until one is set: nothing is assumed');
  } finally {
    await app.db.close();
  }
});

function fake(over: Partial<PitchData> = {}, name: string | null = 'כלי חרס של נורית'): PitchData {
  return {
    store: { id: 1, name, domain: 'shop.example', url: 'https://shop.example/', slug: 'shop-abcd', demo_code: 'DEMO-ABCD', brand: {}, brand_override: {}, config: {}, approved_at: new Date(), taken_down_at: null, status: 'sent' },
    name,
    color: '#b4532a',
    chat: [{ role: 'customer', text: 'היי' }, { role: 'agent', text: 'כן' }, { role: 'customer', text: 'ו?' }, { role: 'agent', text: 'כן' }],
    product: null,
    counts: { products: 14, available: 12, images: 31, min: 39, max: 329 },
    pages: { shipping: true, returns: true, titles: ['מדיניות משלוחים', 'החזרות והחלפות', 'שאלות נפוצות'] },
    shelf: [],
    offer: OFFER,
    gaps: [],
    public: true,
    ...over,
  };
}

test('the hero says only what was really read: the product count in any size, and only the pages that were found', () => {
  const page = (d: PitchData) => pitchPage(d, { env: ENV });
  assert.match(page(fake()), /עברנו על האתר שלכם, על 14 המוצרים ועל עמודי המשלוחים וההחזרות\./);
  const counts = (products: number) => ({ products, available: products, images: 0, min: null, max: null });
  assert.match(page(fake({ counts: counts(2431), pages: { shipping: true, returns: false, titles: [] } })), /על 2,431 המוצרים ועל עמוד המשלוחים\./);
  assert.match(page(fake({ counts: counts(3), pages: { shipping: false, returns: true, titles: [] } })), /על 3 המוצרים ועל עמוד ההחזרות\./);
  assert.match(page(fake({ counts: counts(1), pages: { shipping: false, returns: false, titles: [] } })), /עברנו על האתר שלכם ועל המוצר שבו\./);
  assert.match(page(fake({}, 'Nike Store')), /<h1>בנינו ל־<span class="hl"><bdi>Nike Store<\/bdi><\/span> תורן לוואטסאפ<\/h1>/, 'the name under its marker stroke');
  const all = page(fake());
  assert.ok(!/[—–]/.test(all.replace(/<title>[\s\S]*?<\/title>/, '')), 'no em or en dashes');
  assert.ok(!/בניתי|אני נתנאל|לכתוב לי/.test(all), 'OpenFrequency speaks as "we"');
  assert.match(all, /data-takedown/);
  assert.match(all, /OpenFrequency<\/span>, אשדוד/);
});

test("the strip under the hero shows the store's own products, loops without a gap, and is left out with too few", () => {
  const item = (i: number) => ({ title: `מוצר ${i}`, image: `https://cdn.shopify.com/s/files/p${i}.jpg?v=1`, price_min: 10 * i });
  const page = (n: number) => pitchPage(fake({ shelf: Array.from({ length: n }, (_, i) => item(i + 1)) }), { env: ENV });
  assert.doesNotMatch(page(0), /class="shelf"/);
  const html = page(7);
  assert.match(html, /<div class="shelf" aria-hidden="true">/, 'a picture of their shop, repeated to loop: not read out');
  assert.equal((html.match(/class="shelf-row/g) || []).length, 2, '6 or more products: two rows');
  assert.match(html, /src="https:\/\/cdn\.shopify\.com\/s\/files\/p1\.jpg\?v=1&amp;width=300"/, 'a Shopify photo is asked for at the tile size');
  assert.match(html, /<b>מוצר 1<\/b><small>10 ₪<\/small>/);
  // Every row holds at least 8 tiles in each of its two copies, and the pace grows with the row.
  for (const n of [3, 5, 7, 16]) for (const row of shelfRows(Array.from({ length: n }, (_, i) => item(i)))) assert.ok(row.length >= 8, `${n} products: a row of ${row.length}`);
  assert.equal(shelfRows(Array.from({ length: 4 }, (_, i) => item(i))).length, 1, 'a few products: one row');
  assert.match(themeCss(fake({ shelf: Array.from({ length: 7 }, (_, i) => item(i)) })), /--shelf-0:32s;--shelf-1:36s/);
});

test('the page counts what was read: products, their images, the information pages by name, and the price range', () => {
  const page = (d: PitchData) => pitchPage(d, { env: ENV });
  const html = page(fake());
  assert.match(html, /<dt>מוצרים<\/dt><dd>14<\/dd>/);
  assert.match(html, /<dt>תמונות מוצרים<\/dt><dd>31<\/dd>/);
  assert.match(html, /<dt>עמודי מידע<\/dt><dd>3<\/dd>/);
  assert.match(html, /<dt>טווח המחירים<\/dt><dd>39 ₪ <small>עד<\/small> 329 ₪<\/dd>/);
  assert.match(html, /<bdi>מדיניות משלוחים<\/bdi>, <bdi>החזרות והחלפות<\/bdi>, <bdi>שאלות נפוצות<\/bdi>/);
  // Nothing found, nothing said: no zero images, no empty page list; one price is one price, not a range.
  const bare = page(fake({ counts: { products: 1, available: 1, images: 0, min: 49, max: 49 }, pages: { shipping: false, returns: false, titles: [] } }));
  assert.match(bare, /<dt>מוצר<\/dt><dd>1<\/dd>/);
  assert.doesNotMatch(bare, /תמונות|תמונת|עמודי מידע|עמוד מידע|עמודי המידע/);
  assert.match(bare, /<dt>טווח המחירים<\/dt><dd>49 ₪<\/dd>/);
});

test('the store colour is darkened until white text on it passes 4.5:1, whatever the site gave', () => {
  for (const c of ['#ffd400', '#f8f8f8', '#7fd1ff', '#b4532a', '#00ff00']) {
    const css = themeCss(fake({ color: c }));
    const store = /--store:(#[0-9a-f]{6})/.exec(css)![1];
    assert.ok(contrast(store, '#ffffff') >= 4.5, `${c} became ${store}`);
    assert.match(css, /--store-ink:#ffffff/);
  }
});

test('a store\'s name is its name, not its tagline and never its domain', () => {
  assert.equal(displayName(null, 'כלי חרס של נורית | קרמיקה בעבודת יד'), 'כלי חרס של נורית');
  assert.equal(displayName('', 'Shop – Handmade in Israel'), 'Shop');
  assert.equal(displayName(null, undefined, ''), null);
});

test('rebuilding never fills a gap with a guess: the page keeps waiting until the agent answers cleanly', async () => {
  const { app, s } = await seeded();
  try {
    const r = await buildPitch(app, s.storeId);
    assert.equal(r.chat.length, 4);
    assert.ok(r.turns >= 2 && r.turns <= 8);
  } finally {
    await app.db.close();
  }
});
