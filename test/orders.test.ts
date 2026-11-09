import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discover } from '../src/leads/discover.ts';
import { ingestStore } from '../src/ingest/pack.ts';
import { runTool, type ToolContext } from '../src/agent/tools.ts';
import { conversationFor, runTurn } from '../src/agent/loop.ts';
import { connectOrders, contactsIn, matches, OrderConnectError, shopOf, shopifyOrder } from '../src/orders.ts';
import { EXAMPLE_DOMAIN, WIX_DOMAIN, WOO_DOMAIN, WOO_SITEMAP_DOMAIN } from '../src/demo.ts';
import type { Script } from '../src/agent/llm/scripted.ts';
import type { App } from '../src/app.ts';
import { customer, testApp } from './helpers.ts';
import { serve } from './serve.ts';
import { withoutTracking } from '../src/channels/conversations.ts';

// Real cart links on a live turn, per platform, and a store's own orders read with the owner's read-only key, told
// only to the customer who placed them. The platforms' order APIs are a stand-in (app.api); the catalogues are the
// fictional stores in examples/.

async function store(host: string, script?: Script): Promise<{ app: App; id: number; ctx: ToolContext }> {
  const app = await testApp({ script });
  await discover(app.db, (async function* () { yield { url: `https://${host}/`, source: 'seed', detail: {} }; })(), { fetcher: app.fetcher, limit: 1 });
  const id = (await app.db.one<{ id: number }>('SELECT id FROM stores WHERE domain = $1', [host]))!.id;
  await ingestStore(app, id);
  return { app, id, ctx: { db: app.db, storeId: id, origin: `https://${host}`, currency: 'ILS', env: app.env, demo: false } };
}

const row = (app: App, id: number, title: string) => app.db.one<any>('SELECT id, ext_id, variants FROM products WHERE store_id = $1 AND title = $2', [id, title]);
const variant = (p: any, title: string) => p.variants.find((v: any) => v.title === title).id;

type Call = { url: string; method: string; headers: Record<string, string>; body: any };
/** The platforms' APIs: `answer` gets each call and gives a status and a JSON body; `calls` keeps them. */
function fakeApi(answer: (c: Call) => { status?: number; body: unknown }) {
  const calls: Call[] = [];
  const api = (async (input: any, init: any = {}) => {
    const c: Call = { url: String(input), method: init.method || 'GET', headers: Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)])), body: init.body ? JSON.parse(init.body) : null };
    calls.push(c);
    const a = answer(c);
    return new Response(JSON.stringify(a.body), { status: a.status || 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { api, calls };
}

const KEY = { TORAN_SECRETS_KEY: 's'.repeat(40) };
// Shaped like each platform's own, and not like a real one (check:public refuses those).
const SHOPIFY_TOKEN = `shpat_${'TEST'.repeat(6)}`;
const WOO_KEY = { key: `ck_${'test'.repeat(6)}`, secret: `cs_${'test'.repeat(6)}` };
const WIX_KEY = { api_key: `IST.${'test'.repeat(8)}`, site_id: '00000000-0000-4000-8000-0000000000aa' };

// ---- cart links

test('Shopify: one link to a ready cart from the stored variant ids, every option and its stock checked; the demo keeps its words', async () => {
  const { app, id, ctx } = await store(EXAMPLE_DOMAIN);
  try {
    const mug = await row(app, id, 'ספל חול 350 מ"ל');
    const bowl = await row(app, id, 'קערת זית גדולה');
    const one = await runTool(ctx, 'create_cart_link', { items: [{ product_id: bowl.id }] });
    assert.match(one.content, new RegExp(`https://kli-cheres\\.example/cart/${bowl.variants[0].id}:1\\n`));
    const two = await runTool(ctx, 'create_cart_link', { items: [{ product_id: mug.id, variant_id: variant(mug, 'אפור / 350 מ"ל'), quantity: 2 }, { product_id: bowl.id }] });
    assert.ok(two.content.includes(`https://kli-cheres.example/cart/${variant(mug, 'אפור / 350 מ"ל')}:2,${bowl.variants[0].id}:1`), two.content);
    assert.match(two.content, /ספל חול 350 מ"ל \(אפור \/ 350 מ"ל\), 2 units/);

    const which = await runTool(ctx, 'create_cart_link', { items: [{ product_id: mug.id }] });
    assert.match(which.content, /comes in 3 options.*ask the customer which option/s);
    assert.doesNotMatch(which.content, /\/cart\//);
    const soldOut = await runTool(ctx, 'create_cart_link', { items: [{ product_id: mug.id, variant_id: variant(mug, 'תכלת / 350 מ"ל') }] });
    assert.match(soldOut.content, /\(תכלת \/ 350 מ"ל\) is out of stock/);
    const foreign = await runTool(ctx, 'create_cart_link', { items: [{ product_id: mug.id, variant_id: '123' }] });
    assert.equal(foreign.ok, false);
    assert.match(foreign.content, /has no option \[variant 123\]/);

    const demo = await runTool({ ...ctx, demo: undefined }, 'create_cart_link', { items: [{ product_id: bowl.id }] });
    assert.match(demo.content, /^DEMO: in the live version this is one link to a ready cart/);
    assert.ok(demo.content.includes('https://kli-cheres.example/products/olive-bowl'));
  } finally {
    await app.db.close();
  }
});

test('WooCommerce: ?add-to-cart with the variation\'s own id, one link an item; read from the sitemap, only a one-option product gets one', async () => {
  const { app, id, ctx } = await store(WOO_DOMAIN);
  try {
    assert.equal((await app.db.one<any>('SELECT config FROM stores WHERE id = $1', [id])).config.catalogue, 'store-api');
    const zaatar = await row(app, id, 'זעתר "של סבתא"');
    const baharat = await row(app, id, 'בהרט');
    const paprika = await row(app, id, 'פפריקה מעושנת');
    const one = await runTool(ctx, 'create_cart_link', { items: [{ product_id: zaatar.id, variant_id: '312', quantity: 2 }] });
    assert.ok(one.content.includes('https://tavlinim-ba-shuk.example/?add-to-cart=312&quantity=2'), one.content);
    assert.match(one.content, /^A link that puts the item in the cart/);
    const both = await runTool(ctx, 'create_cart_link', { items: [{ product_id: zaatar.id, variant_id: '311' }, { product_id: baharat.id }] });
    assert.ok(both.content.includes('?add-to-cart=311&quantity=1') && both.content.includes('?add-to-cart=340&quantity=1'), both.content);
    assert.match(both.content, /one product a link/);
    assert.match((await runTool(ctx, 'create_cart_link', { items: [{ product_id: paprika.id, variant_id: '323' }] })).content, /is out of stock/);
    assert.match((await runTool(ctx, 'create_cart_link', { items: [{ product_id: paprika.id }] })).content, /comes in 3 options/);
  } finally {
    await app.db.close();
  }

  const s = await store(WOO_SITEMAP_DOMAIN);
  try {
    assert.equal((await s.app.db.one<any>('SELECT config FROM stores WHERE id = $1', [s.id])).config.catalogue, 'sitemap');
    const soap = await s.app.db.one<any>("SELECT id, ext_id FROM products WHERE store_id = $1 AND title = 'סבון שמן זית'", [s.id]);
    // Lavender sells in sizes, 30 ₪ to 55 ₪, and its page's JSON-LD gives only the range: one row, and no variation id.
    const lavender = await s.app.db.one<any>("SELECT id, url FROM products WHERE store_id = $1 AND title = 'סבון לבנדר'", [s.id]);
    const out = await runTool(s.ctx, 'create_cart_link', { items: [{ product_id: soap.id }, { product_id: lavender.id }] });
    assert.ok(out.content.includes(`https://${WOO_SITEMAP_DOMAIN}/?add-to-cart=410&quantity=1`), out.content);
    assert.ok(out.content.includes(`${lavender.url} (its page: the option is picked there)`), 'a product with options and no variation ids goes to its page');
  } finally {
    await s.app.db.close();
  }
});

test('Wix: no cart link exists, so the product pages with the option to pick, live and in the demo alike', async () => {
  const { app, id, ctx } = await store(WIX_DOMAIN);
  try {
    const jar = await row(app, id, 'נר סויה בצנצנת');
    const inStock = jar.variants.find((v: any) => v.available);
    const live = await runTool(ctx, 'create_cart_link', { items: [{ product_id: jar.id, variant_id: inStock.id }] });
    assert.match(live.content, /^Wix has no link that fills a cart/);
    assert.ok(live.content.includes(`נר סויה בצנצנת (${inStock.title}): https://www.quiet-candles.example/product-page/`), live.content);
    assert.match(live.content, /say which option to pick/);
    const soldOut = jar.variants.find((v: any) => !v.available);
    assert.match((await runTool(ctx, 'create_cart_link', { items: [{ product_id: jar.id, variant_id: soldOut.id }] })).content, /is out of stock/);
    const demo = await runTool({ ...ctx, demo: true }, 'create_cart_link', { items: [{ product_id: jar.id, variant_id: inStock.id }] });
    assert.match(demo.content, /^DEMO: Wix has no link that fills a cart, in the demo or in the live version/);
    assert.doesNotMatch(demo.content, /ready cart/, 'the demo promises no cart Wix cannot make');
  } finally {
    await app.db.close();
  }
});

// ---- orders

const SHOPIFY_ORDER = {
  id: 5001, name: '#1042', order_number: 1042, email: 'dana@example.test', contact_email: 'dana@example.test', phone: null,
  created_at: '2026-10-20T09:15:00+03:00', cancelled_at: null, financial_status: 'paid', fulfillment_status: 'fulfilled',
  customer: { email: 'dana@example.test', phone: '+972500000101' }, billing_address: { phone: '050-000-0101' }, shipping_address: { phone: '050-000-0101' },
  fulfillments: [{ status: 'success', shipment_status: 'in_transit', tracking_company: 'דואר ישראל', tracking_number: 'RR000000000IL', tracking_url: 'https://track.example/RR000000000IL' }],
};

function shopifyAnswer(c: Call) {
  if (c.headers['x-shopify-access-token'] !== SHOPIFY_TOKEN) return { status: 401, body: { errors: '[API] Invalid API key or access token' } };
  const u = new URL(c.url);
  if (u.host !== 'kli-cheres-example.myshopify.com' || !u.pathname.startsWith('/admin/api/')) return { status: 404, body: {} };
  const name = u.searchParams.get('name');
  return { body: { orders: !name || name === '#1042' ? [SHOPIFY_ORDER] : [] } };
}
const shopifyApi = () => fakeApi(shopifyAnswer);

test('Shopify orders: the key is tried and sealed; an order is told to whoever gave its email or phone, with its tracking link, and to nobody else', async () => {
  const s = await store(EXAMPLE_DOMAIN);
  const { app, id } = s;
  try {
    const { api, calls } = shopifyApi();
    app.api = api;
    const ctx = { ...s.ctx, api };
    const ask = (said: string[], extra: Partial<ToolContext> = {}) => runTool({ ...ctx, said, ...extra }, 'get_order_status', { order_number: '1042' });

    assert.match((await ask(['איפה ההזמנה 1042?'])).content, /orders are not connected here.*handoff with reason "order"/s, 'nothing connected: the store answers');
    await assert.rejects(connectOrders(app, id, { token: SHOPIFY_TOKEN }, 'owner'), (e: any) => e instanceof OrderConnectError && /TORAN_SECRETS_KEY/.test(e.message));
    Object.assign(app.env, KEY);
    await assert.rejects(connectOrders(app, id, { token: 'not-a-token' }, 'owner'), (e: any) => e instanceof OrderConnectError && /shpat_/.test(e.he));
    await assert.rejects(connectOrders(app, id, { token: `shpat_${'WRONG'.repeat(5)}` }, 'owner'), (e: any) => e instanceof OrderConnectError && /לא קיבלה את המפתח/.test(e.he), 'a refused key is not kept');
    assert.equal(await app.db.one('SELECT 1 FROM order_access WHERE store_id = $1', [id]), null);
    await connectOrders(app, id, { token: SHOPIFY_TOKEN }, 'owner');
    const a = await app.db.one<any>('SELECT platform, secret, status, meta FROM order_access WHERE store_id = $1', [id]);
    assert.deepEqual([a.platform, a.status, a.meta.shop, a.meta.hint], ['shopify', 'active', 'kli-cheres-example.myshopify.com', '…TEST'], 'the myshopify address is read from /meta.json');
    assert.ok(a.secret.startsWith('v1.') && !a.secret.includes(SHOPIFY_TOKEN), 'sealed');

    // Writing from the order's own phone is enough (the owner, 2026-11-09).
    const told = await ask(['איפה ההזמנה 1042?'], { waPhone: '972500000101' });
    assert.match(told.content, /^Order #1042, placed 20\.10\.2026: paid, shipped\./);
    assert.match(told.content, /on its way, with דואר ישראל, tracking number RR000000000IL, tracking link: https:\/\/track\.example\/RR000000000IL/);
    assert.match(told.content, /A delivery date.*you do not know/s);
    assert.ok(calls.at(-1)!.url.includes('/admin/api/2026-04/orders.json?status=any') && calls.at(-1)!.url.includes(`name=${encodeURIComponent('#1042')}`));
    assert.match((await ask(['שלום'], { fromEmail: 'Dana@Example.test' })).content, /^Order #1042/, 'on the store\'s email, the address it was ordered with');

    // Anyone else is asked for the phone the order was placed with, and told only once they give it.
    const ask1 = await ask(['איפה ההזמנה 1042?'], { waPhone: '972500000999' });
    assert.match(ask1.content, /^ASK PHONE: .*phone number the order was placed with/s);
    assert.doesNotMatch(ask1.content, /paid|shipped|RR0|dana|0101/);
    assert.match((await ask(['איפה ההזמנה 1042?', 'הטלפון 050-000-0101'], { waPhone: '972500000999' })).content, /^Order #1042/, 'the phone on the order, in any form');
    assert.match((await ask(['1042, dana@example.test'])).content, /^ASK PHONE/, 'an email someone types proves nothing');
    const wrong = await ask(['1042', '050-000-0909']);
    assert.match(wrong.content, /^NO MATCH/);
    assert.doesNotMatch(wrong.content, /dana|0101|shipped/, 'nothing about the order, not even which detail is wrong');
    assert.equal((await runTool({ ...ctx, said: ['050-000-0101'] }, 'get_order_status', { order_number: '9999' })).content.split('\n')[0], 'NO MATCH: no order 9999 goes with the phone number the customer gave.', 'a number that is not there reads the same');
    assert.equal((await runTool({ ...ctx, said: ['שלום'] }, 'get_order_status', { order_number: '9999' })).content.split('\n')[0], (await ask(['שלום'])).content.split('\n')[0].replace('1042', '9999'), 'and is asked for the phone the same way');
    assert.match((await runTool({ ...ctx, said: ['050-000-0101'] }, 'get_order_status', { order_number: 'מה זה' })).content, /is not an order number/);
  } finally {
    await app.db.close();
  }
});

test('the phone must be the customer\'s own words, and a few guesses in one conversation send the question to the store', async () => {
  let n = 0;
  const script: Script = (req) => {
    const m = req.messages[req.messages.length - 1];
    if (typeof m.content === 'string' || !m.content.some((b) => b.type === 'tool_result')) return [{ type: 'tool_use', id: `t${++n}`, name: 'get_order_status', input: { order_number: '1042' } }];
    return [{ type: 'text', text: 'בודק.' }];
  };
  const s = await store(EXAMPLE_DOMAIN, script);
  const { app, id } = s;
  try {
    Object.assign(app.env, KEY);
    app.api = shopifyApi().api;
    await connectOrders(app, id, { token: SHOPIFY_TOKEN }, 'owner');
    const conv = await conversationFor(app.db, id, 'email', 'guess@example.test');
    const turn = (text: string) => runTurn(app, { storeId: id, conversationId: conv, text, channel: 'email', footer: false });
    assert.match((await turn('איפה ההזמנה 1042?')).tools[0].result, /^ASK PHONE/, 'not the order\'s address: asked for its phone');
    for (const guess of ['050-000-0911', '050-000-0922', '050-000-0933']) assert.match((await turn(`1042, ${guess}`)).tools[0].result, /^NO MATCH/);
    const fourth = await turn('1042, 050-000-0101');
    assert.match(fourth.tools[0].result, /Several order numbers and details did not match.*handoff with reason "order"/s);

    // On the store's email, the address the order was placed with is theirs.
    const mail = await conversationFor(app.db, id, 'email', 'dana@example.test');
    assert.match((await runTurn(app, { storeId: id, conversationId: mail, text: 'איפה ההזמנה 1042?', channel: 'email', footer: false })).tools[0].result, /^Order #1042/);

    // On the store's own WhatsApp the number the customer writes from is theirs.
    const wa = await conversationFor(app.db, id, 'whatsapp', '972500000101');
    const o = await runTurn(app, { storeId: id, conversationId: wa, text: 'איפה ההזמנה 1042?', channel: 'whatsapp', footer: false });
    assert.match(o.tools[0].result, /^Order #1042/);
    // The demo looks nothing up.
    const demo = await conversationFor(app.db, id, 'whatsapp', '972500000102');
    const d = await runTurn(app, { storeId: id, conversationId: demo, text: 'איפה ההזמנה 1042? dana@example.test' });
    assert.match(d.tools[0].result, /^DEMO:/);
  } finally {
    await app.db.close();
  }
});

test('a key the platform stops taking marks the connection broken, and the question goes to the store', async () => {
  const s = await store(EXAMPLE_DOMAIN);
  try {
    Object.assign(s.app.env, KEY);
    s.app.api = shopifyApi().api;
    await connectOrders(s.app, s.id, { token: SHOPIFY_TOKEN, shop: 'https://admin.shopify.com/store/kli-cheres-example' }, 'owner');
    const revoked = fakeApi(() => ({ status: 401, body: { errors: 'revoked' } }));
    const r = await runTool({ ...s.ctx, api: revoked.api, said: ['dana@example.test'] }, 'get_order_status', { order_number: '1042' });
    assert.match(r.content, /did not answer.*handoff with reason "order"/s);
    assert.equal((await s.app.db.one<any>('SELECT status FROM order_access WHERE store_id = $1', [s.id])).status, 'error');
    assert.match((await runTool({ ...s.ctx, said: ['dana@example.test'] }, 'get_order_status', { order_number: '1042' })).content, /did not accept its key/);
  } finally {
    await s.app.db.close();
  }
});

test('WooCommerce orders: read with the REST key (in the query when the host drops the header), by number even when the store numbers them itself', async () => {
  const s = await store(WOO_DOMAIN);
  try {
    Object.assign(s.app.env, KEY);
    const order = {
      id: 7310, number: '1042', status: 'processing', date_created_gmt: '2026-10-21T07:00:00',
      billing: { email: 'Dana@Example.test', phone: '0500000101' }, shipping: { phone: '' },
      meta_data: [{ key: '_wc_shipment_tracking_items', value: [{ tracking_provider: 'hfd', tracking_number: 'HFD000000', custom_tracking_link: '' }] }],
    };
    const { api, calls } = fakeApi((c) => {
      const u = new URL(c.url);
      if (u.host !== WOO_DOMAIN || u.protocol !== 'https:') return { status: 404, body: {} };
      const ok = u.searchParams.get('consumer_key') === WOO_KEY.key && u.searchParams.get('consumer_secret') === WOO_KEY.secret;
      // This host drops the Authorization header, as some do.
      if (!ok) return { status: 401, body: { code: 'woocommerce_rest_cannot_view', message: 'Sorry, you cannot list resources.' } };
      if (u.pathname === '/wp-json/wc/v3/orders') return { body: [null, '1042'].includes(u.searchParams.get('search')) ? [order] : [] };
      if (u.pathname === '/wp-json/wc/v3/orders/1042') return { body: { id: 1042, number: '980', status: 'completed', billing: { email: 'someone@example.test' } } };
      return { status: 404, body: { code: 'woocommerce_rest_shop_order_invalid_id' } };
    });
    s.app.api = api;
    await connectOrders(s.app, s.id, WOO_KEY, 'owner');
    assert.ok(calls[0].headers.authorization.startsWith('Basic '), 'the header first');
    const r = await runTool({ ...s.ctx, api, said: ['הזמנה 1042', 'הטלפון 050-000-0101'] }, 'get_order_status', { order_number: '#1042' });
    assert.match(r.content, /^Order 1042, placed 21\.10\.2026: paid, being prepared, not shipped yet\./);
    assert.match(r.content, /- with hfd, tracking number HFD000000, tracking link: https:\/\/t\.17track\.net\/en#nums=HFD000000\n/, 'no link from the store or its tracking plugin: 17track\'s page for the number');
    assert.ok(calls.some((c) => c.url.includes('/wp-json/wc-shipment-tracking/v3/orders/7310/shipment-trackings')), 'the plugin was asked for the link it builds');
    assert.doesNotMatch(r.content, /someone|980/, 'order id 1042 is another order, number 980');
  } finally {
    await s.app.db.close();
  }
});

test('Wix orders: searched by number with the API key and the site id, tracking from the order\'s fulfillments', async () => {
  const s = await store(WIX_DOMAIN);
  try {
    Object.assign(s.app.env, KEY);
    const { api, calls } = fakeApi((c) => {
      if (c.headers.authorization !== WIX_KEY.api_key || c.headers['wix-site-id'] !== WIX_KEY.site_id) return { status: 403, body: { message: 'not permitted' } };
      if (c.url === 'https://www.wixapis.com/ecom/v1/orders/search') {
        const wanted = c.body?.search?.filter?.number?.$eq;
        return { body: { orders: !wanted || wanted === '10042' ? [{ id: 'order-a', number: '10042', status: 'APPROVED', paymentStatus: 'PAID', fulfillmentStatus: 'FULFILLED', createdDate: '2026-10-22T10:00:00Z', buyerInfo: { email: 'noa@example.test' }, billingInfo: { contactDetails: { phone: '050-000-0102' } } }] : [] } };
      }
      if (c.url === 'https://www.wixapis.com/ecom/v1/fulfillments/list-by-ids') return { body: { ordersWithFulfillments: [{ orderId: 'order-a', fulfillments: [{ trackingInfo: { trackingNumber: 'IL000000', shippingProvider: 'צ\'יטה', trackingLink: 'https://track.example/IL000000' } }] }] } };
      return { status: 404, body: {} };
    });
    s.app.api = api;
    await assert.rejects(connectOrders(s.app, s.id, { api_key: WIX_KEY.api_key, site_id: '' }, 'owner'), (e: any) => /Site ID/.test(e.he));
    await connectOrders(s.app, s.id, { ...WIX_KEY, site_id: `https://manage.wix.com/dashboard/${WIX_KEY.site_id}/home` }, 'owner');
    const r = await runTool({ ...s.ctx, api, said: ['10042 והטלפון שלי 0500000102'] }, 'get_order_status', { order_number: '10042' });
    assert.match(r.content, /^Order 10042, placed 22\.10\.2026: paid, shipped\./);
    assert.match(r.content, /with צ'יטה, tracking number IL000000, tracking link: https:\/\/track\.example\/IL000000/);
    assert.deepEqual(calls.at(-2)!.body, { search: { filter: { number: { $eq: '10042' } }, cursorPaging: { limit: 1 } } });
  } finally {
    await s.app.db.close();
  }
});

// ---- where the package is (src/tracking.ts)

/** 17track's Tracking API, as its docs show it (api.17track.net/en/doc, v2.4): `down` makes every call fail. */
function track17Answer(state: { down?: boolean; registered: Set<string> }) {
  return (c: Call) => {
    if (state.down) return { status: 503, body: { code: 503, data: null } };
    if (c.headers['17token'] !== 'test-17track-key') return { status: 401, body: { code: -18010002, data: null } };
    const numbers: string[] = (c.body || []).map((x: any) => x.number);
    if (c.url.endsWith('/register')) {
      const fresh = numbers.filter((n) => !state.registered.has(n));
      for (const n of fresh) state.registered.add(n);
      return { body: { code: 0, data: { accepted: fresh.map((number) => ({ origin: 1, number, carrier: 3011 })), rejected: numbers.filter((n) => !fresh.includes(n)).map((number) => ({ number, error: { code: -18019901, message: `Tracking number ${number} is already registered.` } })) } } };
    }
    if (c.url.endsWith('/gettrackinfo')) {
      return { body: { code: 0, data: { accepted: numbers.filter((n) => state.registered.has(n)).map((number) => ({ number, carrier: 3011, track_info: {
        latest_status: { status: 'OutForDelivery', sub_status: 'OutForDelivery_Other', sub_status_descr: null },
        latest_event: { time_iso: '2026-11-09T10:30:00+02:00', time_utc: '2026-11-09T08:30:00Z', description: 'Out for delivery from the Tel Aviv branch', location: 'TEL AVIV', address: { country: 'IL', city: 'TEL AVIV' } },
      } })), rejected: numbers.filter((n) => !state.registered.has(n)).map((number) => ({ number, error: { code: -18019902, message: 'The tracking number does not register, please register first.' } })) } } };
    }
    return { status: 404, body: {} };
  };
}

test('tracking: the website\'s own page first, then the store\'s link; 17track\'s status and last update in words, only after the order matched, and never failing the reply', async () => {
  const s = await store(EXAMPLE_DOMAIN);
  const { app, id } = s;
  try {
    Object.assign(app.env, KEY);
    const t17 = { down: false, registered: new Set<string>() };
    const answer17 = track17Answer(t17);
    const { api, calls } = fakeApi((c) => (c.url.startsWith('https://api.17track.net/') ? answer17(c) : shopifyAnswer(c)));
    app.api = api;
    await connectOrders(app, id, { token: SHOPIFY_TOKEN }, 'owner');
    const ask = (extra: Partial<ToolContext> = {}) => runTool({ ...s.ctx, api, said: ['איפה ההזמנה 1042?'], waPhone: '972500000101', ...extra }, 'get_order_status', { order_number: '1042' });
    const to17 = () => calls.filter((c) => c.url.startsWith('https://api.17track.net/'));

    // No key: the store's own status and link, and nothing asked of 17track.
    let r = await ask();
    assert.match(r.content, /- on its way, with דואר ישראל, tracking number RR000000000IL, tracking link: https:\/\/track\.example\/RR000000000IL\n/);
    assert.equal(to17().length, 0);

    // The website's tracking page, with the numbers in it, instead of the store's link.
    await app.db.query('UPDATE stores SET tracking_page = $2 WHERE id = $1', [id, 'https://kli-cheres.example/track?n={number}&o={order}']);
    r = await ask();
    assert.match(r.content, /tracking link: https:\/\/kli-cheres\.example\/track\?n=RR000000000IL&o=1042\n/);
    assert.doesNotMatch(r.content, /track\.example\/RR/);

    // With the key: nothing is asked of 17track before the order is theirs.
    app.env.TORAN_17TRACK_KEY = 'test-17track-key';
    const s17 = { ...s.ctx, env: app.env };
    const before = await runTool({ ...s17, api, said: ['איפה ההזמנה 1042?'], waPhone: '972500000999' }, 'get_order_status', { order_number: '1042' });
    assert.match(before.content, /^ASK PHONE/);
    assert.match((await runTool({ ...s17, api, said: ['1042', '050-000-0909'] }, 'get_order_status', { order_number: '1042' })).content, /^NO MATCH/);
    assert.equal(to17().length, 0, 'no tracking details, not even a lookup, before a match');

    // Once it matches: registered, then read; the carrier's status and its last update, in Israel time.
    r = await ask({ env: app.env });
    assert.deepEqual(to17().map((c) => [c.url, c.body]), [['https://api.17track.net/track/v2.4/register', [{ number: 'RR000000000IL' }]], ['https://api.17track.net/track/v2.4/gettrackinfo', [{ number: 'RR000000000IL' }]]]);
    assert.equal(to17()[0].headers['content-type'], 'application/json');
    assert.match(r.content, /- out for delivery \(the carrier's own status, through 17track\), with דואר ישראל, latest update from the carrier: "Out for delivery from the Tel Aviv branch", TEL AVIV, 9\.11\.2026 10:30, tracking number RR000000000IL, tracking link: https:\/\/kli-cheres\.example\/track\?n=RR000000000IL&o=1042\n/);
    assert.match(r.content, /plain, natural Hebrew/);
    assert.match(r.content, /A status, a place or a time the lines above do not give, you never say/);

    // Asked again within the hour: from the cache, no call.
    await ask({ env: app.env });
    assert.equal(to17().length, 2);

    // When the conversation closes, the update goes with the number and the link; the status words stay.
    const kept = withoutTracking(r.content);
    assert.doesNotMatch(kept, /TEL AVIV|RR000000000IL|kli-cheres\.example\/track/);
    assert.match(kept, /- out for delivery \(the carrier's own status, through 17track\), with דואר ישראל\n/);

    // 17track down: the store's status and the link, as before, and the reply goes on.
    await app.db.query('DELETE FROM tracking_cache');
    t17.down = true;
    r = await ask({ env: app.env });
    assert.match(r.content, /^Order #1042/);
    assert.match(r.content, /- on its way, with דואר ישראל, tracking number RR000000000IL, tracking link: https:\/\/kli-cheres\.example\/track/);
  } finally {
    await app.db.close();
  }
});

test('who may be told: the latest few contacts only, phones in every form, and the order\'s own details never compared loosely', () => {
  const o = shopifyOrder(SHOPIFY_ORDER);
  assert.equal(matches(o, contactsIn(['+972 50-000-0101'])), true);
  assert.equal(matches(o, contactsIn(['DANA@example.test'])), false, 'an email someone types proves nothing');
  assert.equal(matches(o, contactsIn(['שלום']), { email: 'DANA@example.test' }), true, 'writing from it does');
  assert.equal(matches(o, contactsIn(['שלום']), { email: 'dana@example.tes' }), false);
  const list = ['050-000-0101', ...Array.from({ length: 5 }, (_, i) => `050-000-02${i}0`)].join(', ');
  assert.equal(matches(o, contactsIn([list])), false, 'a list of numbers proves nothing');
  assert.equal(matches(o, contactsIn(['שלום']), { waPhone: '972500000101' }), true);
  assert.deepEqual(['my-store', 'my-store.myshopify.com', 'https://admin.shopify.com/store/my-store/orders', 'kli-cheres.example'].map(shopOf), ['my-store.myshopify.com', 'my-store.myshopify.com', 'my-store.myshopify.com', null]);
});

// ---- the owner's form

test('the knowledge page: the owner pastes the key with where to find it, it connects and disconnects; a member only sees it', async () => {
  const s = await serve();
  try {
    const a = s.seeded.storeId;
    await s.app.db.query('UPDATE stores SET workspace_id = 1 WHERE id = $1', [a]);
    s.as(s.accounts.session(customer(1)).cookie);
    let page = await (await s.get(`/lead/${a}/knowledge`)).text();
    assert.match(page, /שאלות על הזמנות/);
    assert.match(page, /החיבור להזמנות עוד לא פתוח בשרת/, 'without TORAN_SECRETS_KEY nothing is stored');
    Object.assign(s.app.env, KEY);
    s.app.api = shopifyApi().api;
    page = await (await s.get(`/lead/${a}/knowledge`)).text();
    assert.match(page, /read_orders/);
    assert.match(page, /name="token"/);
    assert.match(page, /<li>איפה הזמנה מסוימת נמצאת<\/li>/);
    const panel = /<section class="panel" id="orders">[\s\S]*?<\/section>/.exec(page)![0];
    for (const bad of ['את/ה', 'ניתן', 'במידה ו', '—', '–']) assert.ok(!panel.includes(bad), bad);

    const refused = await s.post(`/lead/${a}/orders`, { _csrf: await s.csrf(`/lead/${a}/knowledge`), token: `shpat_${'WRONG'.repeat(5)}` });
    assert.equal(refused.status, 303);
    assert.match(decodeURIComponent(refused.headers.get('set-cookie') || ''), /לא קיבלה את המפתח/);
    const ok = await s.post(`/lead/${a}/orders`, { _csrf: await s.csrf(`/lead/${a}/knowledge`), token: SHOPIFY_TOKEN, shop: '' });
    assert.equal(ok.headers.get('location'), `/lead/${a}/knowledge#orders`);
    page = await (await s.get(`/lead/${a}/knowledge`)).text();
    assert.match(page, /מחובר ל-Shopify/);
    assert.match(page, /…TEST/);
    assert.ok(!page.includes(SHOPIFY_TOKEN), 'the key is never shown again');
    assert.match(page, /<li>איפה ההזמנה, למי שנותן את המייל או הטלפון שבה<\/li>/);

    // The website's own tracking page: https only, kept as typed with its {number}, and empty takes it away.
    assert.match(page, /action="\/lead\/\d+\/tracking-page"/);
    const box = /<details class="mt12" id="tracking-page"[\s\S]*?<\/details>/.exec(page)![0];
    for (const bad of ['את/ה', 'ניתן', 'במידה ו', '—', '–']) assert.ok(!box.includes(bad), bad);
    const http = await s.post(`/lead/${a}/tracking-page`, { _csrf: await s.csrf(`/lead/${a}/knowledge`), tracking_page: 'http://kli-cheres.example/track?n={number}' });
    assert.match(decodeURIComponent(http.headers.get('set-cookie') || ''), /https:\/\//);
    assert.equal((await s.app.db.one<any>('SELECT tracking_page FROM stores WHERE id = $1', [a])).tracking_page, null);
    for (const bad of ['javascript:alert(1)', 'kli-cheres.example/track', 'https://user:pw@kli-cheres.example/track']) {
      await s.post(`/lead/${a}/tracking-page`, { _csrf: await s.csrf(`/lead/${a}/knowledge`), tracking_page: bad });
      assert.equal((await s.app.db.one<any>('SELECT tracking_page FROM stores WHERE id = $1', [a])).tracking_page, null, bad);
    }
    const saved = await s.post(`/lead/${a}/tracking-page`, { _csrf: await s.csrf(`/lead/${a}/knowledge`), tracking_page: ' https://kli-cheres.example/track?n={number} ' });
    assert.equal(saved.headers.get('location'), `/lead/${a}/knowledge#orders`);
    assert.equal((await s.app.db.one<any>('SELECT tracking_page FROM stores WHERE id = $1', [a])).tracking_page, 'https://kli-cheres.example/track?n={number}');
    assert.match(await (await s.get(`/lead/${a}/knowledge`)).text(), /value="https:\/\/kli-cheres\.example\/track\?n=\{number\}"/);

    const member = s.accounts.session({ ...customer(1), role: 'client_member' });
    s.as(member.cookie);
    const seen = await (await s.get(`/lead/${a}/knowledge`)).text();
    assert.ok(!seen.includes('/orders/off'));
    assert.ok(!seen.includes('/tracking-page"') && seen.includes('דף המעקב שתורן שולח'), 'a member sees the page, and cannot change it');
    await s.post(`/lead/${a}/tracking-page`, { _csrf: await s.csrf(`/lead/${a}/knowledge`), tracking_page: '' });
    assert.ok((await s.app.db.one<any>('SELECT tracking_page FROM stores WHERE id = $1', [a])).tracking_page, 'a member cannot clear it');
    assert.equal((await s.post(`/lead/${a}/orders/off`, { _csrf: await s.csrf(`/lead/${a}/knowledge`) })).status, 303);
    assert.ok(await s.app.db.one('SELECT 1 FROM order_access WHERE store_id = $1', [a]), 'a member cannot disconnect');

    s.as(s.accounts.session(customer(1)).cookie);
    await s.post(`/lead/${a}/orders/off`, { _csrf: await s.csrf(`/lead/${a}/knowledge`) });
    assert.equal(await s.app.db.one('SELECT 1 FROM order_access WHERE store_id = $1', [a]), null, 'disconnecting forgets the key');
  } finally {
    await s.close();
  }
});
