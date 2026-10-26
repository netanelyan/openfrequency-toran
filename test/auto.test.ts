import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seal } from '../src/core/secrets.ts';
import { afterQuiet, customerQuiet, israelHoliday, now, setNow } from '../src/core/clock.ts';
import { displayName } from '../src/ingest/brand.ts';
import { simEmail } from '../src/channels/email.ts';
import { signBody } from '../src/channels/meta.ts';
import { handleInbound } from '../src/channels/route.ts';
import { counted, monthOf } from '../src/plans.ts';
import { drain } from '../src/jobs/worker.ts';
import { pollStore, scheduleAuto } from '../src/auto/jobs.ts';
import { consentOf, stopToken } from '../src/auto/consent.ts';
import { categoryOf, emailText, firstName, KINDS, LEGACY, MESSAGES, templateRequest, waText } from '../src/auto/messages.ts';
import { shopifyOrderRead, shopifySign, wixCheckoutRead, wixOrderRead, wooSign } from '../src/auto/platforms.ts';
import { AutoError, record, saveSetting, sendDue } from '../src/auto/send.ts';
import { approvedFor, submitTemplates } from '../src/auto/templates.ts';
import { customer } from './helpers.ts';
import { serve } from './serve.ts';

// Toran's automatic messages (src/auto/): an abandoned cart, a payment, a shipment and a review request, started from
// what the store's own platform says, on the store's own WhatsApp number (an approved template) or its email. The
// platforms (app.api) and Meta's Graph API (app.graph) are stand-ins; nothing here reaches Shopify, WooCommerce, Wix,
// Meta or Resend.

const APP_SECRET = 'test-app-secret-not-a-real-one';
const PHONE_ID = '100200300400501';
const WABA = '900800700600501';
const TOKEN = 'test-business-token-for-the-store';
const CUSTOMER = '972500000321';
const OTHER = '972500000322';
const SHOPIFY_TOKEN = `shpat_${'TEST'.repeat(6)}`;
const API_SECRET = `shpss_${'TEST'.repeat(6)}`;
const WOO_KEY = { key: `ck_${'test'.repeat(6)}`, secret: `cs_${'test'.repeat(6)}` };
// A Tuesday, 11:00 in Israel: not quiet.
const T0 = Date.parse('2026-10-20T08:00:00Z');
const MIN = 60_000;
const iso = (t: number) => new Date(t).toISOString();

type Call = { url: URL; method: string; body: any };

/** The store's platform: Shopify's Admin API and a WooCommerce store's REST API, as far as Toran uses them. */
function fakePlatforms() {
  const calls: Call[] = [];
  const state = { orders: [] as any[], checkouts: [] as any[], webhooks: [] as any[], wooOrders: [] as any[], wooReadOnly: true, wooHooks: [] as any[] };
  const api = (async (input: any, init: any = {}) => {
    const url = new URL(String(input));
    const method = String(init.method || 'GET');
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method, body });
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
    if (url.host === 'kli-cheres.myshopify.com') {
      if ((init.headers as any)?.['x-shopify-access-token'] !== SHOPIFY_TOKEN) return json({ errors: 'Invalid API key or access token' }, 401);
      const p = url.pathname.replace(/^\/admin\/api\/[^/]+\//, '');
      if (p === 'checkouts.json') return json({ checkouts: state.checkouts });
      if (p === 'orders.json') return json({ orders: state.orders });
      if (p === 'webhooks.json' && method === 'GET') return json({ webhooks: state.webhooks });
      if (p === 'webhooks.json' && method === 'POST') {
        const w = { id: 7000 + state.webhooks.length, ...body.webhook };
        state.webhooks.push(w);
        return json({ webhook: w }, 201);
      }
      const one = /^orders\/(\d+)\.json$/.exec(p);
      if (one) return json({ order: state.orders.find((o) => String(o.id) === one[1]) });
    }
    if (url.host === 'tavlinim-ba-shuk.example') {
      const p = url.pathname.replace('/wp-json/wc/v3/', '');
      if (p === 'webhooks' && method === 'GET') return json(state.wooHooks);
      if (p === 'webhooks' && method === 'POST') {
        if (state.wooReadOnly) return json({ code: 'woocommerce_rest_cannot_create', message: 'Sorry, you are not allowed to create resources.' }, 401);
        const w = { id: 300 + state.wooHooks.length, status: 'active', ...body };
        state.wooHooks.push(w);
        return json(w, 201);
      }
      if (p === 'orders') return json(url.searchParams.get('status') === 'checkout-draft' ? [] : state.wooOrders);
    }
    return json({ message: `no route ${method} ${url}` }, 404);
  }) as typeof fetch;
  return { api, calls, state };
}

/** Meta's Graph API: the store's templates and its sends. */
function fakeGraph() {
  const sent: any[] = [];
  const templates = new Map<string, { id: string; status: string; category: string; body: any }>();
  const f = (async (input: any, init: any = {}) => {
    const url = new URL(String(input));
    const method = String(init.method || 'GET');
    const path = url.pathname.replace(/^\/v\d+\.\d+\//, '');
    const body = init.body ? JSON.parse(String(init.body)) : null;
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
    if ((init.headers as any)?.authorization !== `Bearer ${TOKEN}`) return json({ error: { message: 'Error validating access token', code: 190 } }, 401);
    if (path === `${WABA}/message_templates` && method === 'POST') {
      if (templates.has(body.name)) return json({ error: { message: 'Invalid parameter', code: 100, error_subcode: 2388024, error_user_msg: 'Content in this language already exists' } }, 400);
      const t = { id: `tpl-${templates.size + 1}`, status: 'PENDING', category: body.category, body };
      templates.set(body.name, t);
      return json({ id: t.id, status: t.status, category: t.category });
    }
    if (path === `${WABA}/message_templates` && method === 'GET') {
      const name = url.searchParams.get('name') || '';
      const t = templates.get(name);
      return json({ data: t ? [{ id: t.id, status: t.status, category: t.category, name, language: 'he', rejected_reason: 'NONE' }] : [] });
    }
    if (path === `${PHONE_ID}/messages` && method === 'POST') {
      sent.push(body);
      return json({ messaging_product: 'whatsapp', messages: [{ id: `wamid.auto-${sent.length}` }] });
    }
    return json({ error: { message: `no route ${method} ${path}`, code: 1 } }, 404);
  }) as typeof fetch;
  return { f, sent, templates };
}

/** The fictional Shopify store with its owner's keys, its own WhatsApp number, and email on. */
async function shop({ whatsapp = true, email = true }: { whatsapp?: boolean; email?: boolean } = {}) {
  setNow(T0);
  const s = await serve();
  const app = s.app;
  Object.assign(app.env, { META_APP_ID: '1234567890', META_APP_SECRET: APP_SECRET, META_WEBHOOK_VERIFY_TOKEN: 'verify-me', TORAN_SECRETS_KEY: 'k'.repeat(40), PUBLIC_BASE_URL: 'https://toran.test', TORAN_CHANNELS: 'whatsapp,email' });
  app.mail = simEmail();
  const p = fakePlatforms();
  const g = fakeGraph();
  app.api = p.api;
  app.graph = g.f;
  const id = s.seeded.storeId;
  await app.db.query('UPDATE stores SET workspace_id = 1 WHERE id = $1', [id]);
  await app.db.query("INSERT INTO order_access (store_id, platform, secret, status, meta) VALUES ($1, 'shopify', $2, 'active', '{}')", [id, seal(app.env, JSON.stringify({ token: SHOPIFY_TOKEN, shop: 'kli-cheres.myshopify.com' }))]);
  let wa: number | null = null;
  if (whatsapp) wa = (await app.db.one<{ id: number }>("INSERT INTO channel_accounts (store_id, channel, kind, external_id, name, secret, status, meta) VALUES ($1, 'whatsapp', 'meta', $2, 'כלי חרס', $3, 'active', $4::jsonb) RETURNING id", [id, PHONE_ID, seal(app.env, TOKEN), JSON.stringify({ waba_id: WABA, display_phone_number: '972500000777' })]))!.id;
  if (email) await app.db.query("INSERT INTO channel_accounts (store_id, channel, kind, external_id, status) VALUES ($1, 'email', 'sim', 'kli@mail.toran.test', 'active')", [id]);
  s.as(s.accounts.session(customer(1)).cookie);
  return { s, app, id, p, g, wa };
}

const done = async (s: Awaited<ReturnType<typeof serve>>) => {
  setNow(null);
  await s.close();
};

/** Every template Meta approves, through its webhook, as it does once the review is over. */
async function approveAll(s: Awaited<ReturnType<typeof serve>>, names: string[]) {
  const body = { object: 'whatsapp_business_account', entry: [{ id: WABA, changes: names.map((n) => ({ field: 'message_template_status_update', value: { event: 'APPROVED', message_template_id: 1, message_template_name: n, message_template_language: 'he', reason: 'NONE' } })) }] };
  const raw = JSON.stringify(body);
  const res = await fetch(`${s.base}/meta/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': signBody(APP_SECRET, raw) }, body: raw });
  assert.equal(res.status, 200);
  await drain(s.app, { kinds: ['wa_template_status'] });
}

const ALL_TEMPLATES = Object.values(MESSAGES).map((m) => m.template);

const shopifyHook = (s: Awaited<ReturnType<typeof serve>>, id: number, topic: string, body: unknown, { secret = API_SECRET, hookId = `wh-${Math.random()}` }: { secret?: string; hookId?: string } = {}) => {
  const raw = JSON.stringify(body);
  return fetch(`${s.base}/hooks/shopify/${id}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-shopify-hmac-sha256': shopifySign(secret, raw), 'x-shopify-topic': topic, 'x-shopify-webhook-id': hookId }, body: raw });
};

const checkout = (o: Record<string, unknown> = {}) => ({ id: 9001, token: 'tok-9001', abandoned_checkout_url: 'https://kli-cheres.example/checkouts/tok-9001/recover?key=k1', email: 'dana@example.test', phone: '+972500000321', created_at: iso(T0), updated_at: iso(T0), completed_at: null, buyer_accepts_marketing: false, customer: { first_name: 'דנה', email: 'dana@example.test', phone: '+972500000321' }, ...o });
const order = (o: Record<string, unknown> = {}) => ({ id: 5001, name: '#1042', email: 'dana@example.test', phone: '+972500000321', created_at: iso(T0), updated_at: iso(T0), processed_at: iso(T0), cancelled_at: null, financial_status: 'paid', fulfillment_status: null, customer: { first_name: 'דנה', email: 'dana@example.test', phone: '+972500000321' }, fulfillments: [], order_status_url: 'https://kli-cheres.example/orders/s1', checkout_token: 'tok-9001', ...o });
const events = (app: any, id: number) => app.db.query('SELECT key, message, status, why, channel, basis FROM auto_events WHERE store_id = $1 AND kind <> $2 ORDER BY id', [id, 'order']);

// ---- quiet time

test('quiet time in Israel: the night, Shabbat from Friday afternoon, the holidays and their eves; the next hour that is not', () => {
  const at = (s: string) => Date.parse(s);
  assert.equal(customerQuiet(at('2026-10-20T08:00:00Z')), false, 'a Tuesday at 11:00');
  assert.equal(customerQuiet(at('2026-10-20T19:30:00Z')), true, 'a Tuesday at 21:30');
  assert.equal(customerQuiet(at('2026-10-21T05:30:00Z')), true, 'a Wednesday at 07:30');
  assert.equal(customerQuiet(at('2026-10-23T08:00:00Z')), false, 'a Friday at 10:00');
  assert.equal(customerQuiet(at('2026-10-23T11:30:00Z')), true, 'a Friday at 13:30, Shabbat is coming');
  assert.equal(customerQuiet(at('2026-10-24T15:00:00Z')), true, 'Saturday afternoon');
  assert.ok(israelHoliday(at('2026-09-13T09:00:00Z')), 'the second day of Rosh Hashana');
  assert.equal(customerQuiet(at('2026-09-13T09:00:00Z')), true, 'Rosh Hashana, on a Sunday');
  assert.equal(customerQuiet(at('2026-09-20T08:00:00Z')), false, 'the morning before Yom Kippur');
  assert.equal(customerQuiet(at('2026-09-20T11:00:00Z')), true, 'the afternoon before Yom Kippur');
  assert.equal(customerQuiet(at('2026-09-21T09:00:00Z')), true, 'Yom Kippur');
  assert.equal(customerQuiet(at('2026-09-29T09:00:00Z')), false, 'a day of Chol HaMoed');
  // Friday 13:30 waits for Sunday 09:00; Rosh Hashana 5787 (Saturday and Sunday) for Monday 09:00.
  assert.equal(new Date(afterQuiet(at('2026-10-23T11:30:00Z'))).toISOString(), '2026-10-25T07:00:00.000Z');
  assert.equal(new Date(afterQuiet(at('2026-09-11T12:00:00Z'))).toISOString(), '2026-09-14T06:00:00.000Z');
  assert.equal(afterQuiet(at('2026-10-20T08:00:00Z')), at('2026-10-20T08:00:00Z'), 'not quiet: now');
});

// ---- the words

test('the messages: every template has words on both sides of each variable, the marketing ones have one quiet "הגדרות הודעות" link and no "הסר", a missing name reads "שלום לכם"', () => {
  for (const [key, m] of Object.entries(MESSAGES)) {
    const body = m.body('כלי חרס');
    assert.ok(!/^\s*\{\{|\}\}\s*$/.test(body), `${key}: a variable at the start or the end`);
    assert.equal((body.match(/\{\{\d\}\}/g) || []).length, m.vars.length, `${key}: one variable for each value`);
    const mail = emailText(key as any, 'כלי חרס', { name: 'דנה', order: '#1', link: 'https://x.example/' }, 'https://toran.test/u/t').text;
    assert.ok(!/[—–]|את\/ה|ניתן|במידה ו/.test(body + mail), `${key}: plain Hebrew`);
    assert.doesNotMatch(body + mail, /הסר/, `${key}: nothing says to write "הסר"`);
    const req = templateRequest(key as any, 'כלי חרס', 'https://toran.test');
    assert.equal(req.language, 'he');
    assert.equal(req.components[0].example!.body_text[0].length, m.vars.length);
    assert.ok(!req.components.some((c) => c.type === 'FOOTER'), `${key}: no footer`);
    if (categoryOf(key as any) === 'MARKETING') {
      // One URL button to the customer's page, its token Meta's dynamic suffix, with an example Meta can open.
      const b = (req.components[1] as any).buttons;
      assert.deepEqual(req.components.slice(1), [{ type: 'BUTTONS', buttons: [{ type: 'URL', text: 'הגדרות הודעות', url: 'https://toran.test/u/{{1}}', example: [b[0].example[0]] }] }]);
      assert.match(b[0].example[0], /^https:\/\/toran\.test\/u\/[\w-]{24}$/);
      assert.match(mail, /\n\nכלי חרס\n\nלא רוצים לקבל מאיתנו תזכורות כאלה\? אפשר להפסיק כאן:\nhttps:\/\/toran\.test\/u\/t$/);
    } else {
      assert.equal(req.components.length, 1, `${key}: a body and nothing else`);
      assert.doesNotMatch(mail, /להפסיק/, `${key}: an update on an order has no link to stop`);
    }
  }
  assert.equal(templateRequest('cart', 'כלי חרס', 'https://toran.test').category, 'MARKETING');
  assert.equal(templateRequest('shipped', 'כלי חרס', 'https://toran.test').category, 'UTILITY');
  assert.ok(!JSON.stringify(templateRequest('review', 'כלי חרס', 'https://toran.test')).includes('QUICK_REPLY'), 'no "הסר" button');
  const cart = { name: 'דנה', order: '', link: 'https://kli-cheres.example/c' };
  assert.match(waText('cart', 'כלי חרס', cart).text, /^שלום דנה, נשארו לכם מוצרים בעגלה בכלי חרס\. .*https:\/\/kli-cheres\.example\/c\nיש שאלה על מוצר או על המשלוח\? אפשר לכתוב לנו כאן\.$/s);
  // An old template (approved before the button) is kept as the customer reads it, with its footer.
  assert.match(waText('cart', 'כלי חרס', cart, { legacy: true }).text, /\n\nלא רוצים עוד הודעות כאלה\? כתבו הסר$/);
  assert.doesNotMatch(waText('paid', 'כלי חרס', { name: 'דנה', order: '#1042', link: '' }, { legacy: true }).text, /הסר/, 'a payment says nothing about stopping marketing');
  assert.match(waText('paid', 'Kli Shop', { name: firstName(''), order: '#1042', link: '' }).text, /^שלום לכם, קיבלנו את התשלום על הזמנה #1042 ב-Kli Shop\./);
  assert.equal(firstName('דנה כהן'), 'דנה');
  assert.equal(firstName('<script>'), 'לכם');
});

// ---- templates

test('templates: submitted to the store\'s own WhatsApp account, approved through Meta\'s webhook; a kind turns on for WhatsApp only once they are', async () => {
  const { s, app, id, g, wa } = await shop();
  try {
    await assert.rejects(saveSetting(app, id, 'payment', { whatsapp: true, email: false }, 'owner'), (e: any) => e instanceof AutoError && /Meta מאשרת/.test(e.he), 'no WhatsApp before the templates are approved');
    let page = await (await s.get('/settings')).text();
    assert.match(page, /הודעות אוטומטיות/);
    assert.match(page, /עוד לא נשלחה/);
    assert.match(page, /צריך שיהיה בו אמצעי תשלום/, 'the cost is the store\'s, on its own WhatsApp account');
    assert.match(page, /name="whatsapp" value="1" disabled/);

    const res = await s.post(`/lead/${id}/auto/templates`, { _csrf: await s.csrf('/settings') });
    assert.equal(res.status, 303);
    assert.equal(g.templates.size, ALL_TEMPLATES.length, 'one template a message, on the store\'s WABA');
    assert.equal(g.templates.get(MESSAGES.cart.template)!.category, 'MARKETING');
    assert.ok(!g.templates.has(LEGACY.cart!.template), 'the old shape is never submitted');
    assert.deepEqual(g.templates.get(MESSAGES.cart.template)!.body.components.map((c: any) => c.type), ['BODY', 'BUTTONS']);
    assert.equal(g.templates.get(MESSAGES.cart.template)!.body.components[1].buttons[0].url, 'https://toran.test/u/{{1}}');
    assert.equal(g.templates.get('toran_order_shipped')!.category, 'UTILITY');
    page = await (await s.get('/settings')).text();
    assert.match(page, /מחכה לאישור של Meta/);
    assert.equal((await approvedFor(app, wa, 'payment')).ok, false);
    // Again: what is waiting at Meta is not sent twice.
    assert.deepEqual(await submitTemplates(app, id, 'owner'), { sent: 0, refused: 0 });

    await approveAll(s, ['toran_order_paid', 'toran_payment_pending', 'toran_payment_failed']);
    assert.equal((await approvedFor(app, wa, 'payment')).ok, true);
    assert.equal((await approvedFor(app, wa, 'shipping')).ok, false, 'one kind\'s templates do not open another');
    const on = await s.post(`/lead/${id}/auto/payment`, { _csrf: await s.csrf('/settings'), whatsapp: '1' });
    assert.equal(on.status, 303);
    const row = await app.db.one<any>("SELECT whatsapp, email, on_since FROM auto_settings WHERE store_id = $1 AND kind = 'payment'", [id]);
    assert.deepEqual([row.whatsapp, row.email, new Date(row.on_since).getTime()], [true, false, T0]);
    page = await (await s.get('/plan')).text();
    assert.match(page, /פעיל: תשלום/, 'the plan says it is on');
    // A member sees, and changes nothing.
    s.as(s.accounts.session({ ...customer(1), role: 'client_member' }).cookie);
    assert.doesNotMatch(await (await s.get('/settings')).text(), /action="\/lead\/\d+\/auto\/templates"|<button class="btn sm mt8" type="submit">לשמור<\/button>/, 'no buttons for a member');
    await s.post(`/lead/${id}/auto/payment`, { _csrf: await s.csrf('/settings') });
    assert.equal((await app.db.one<any>("SELECT whatsapp FROM auto_settings WHERE store_id = $1 AND kind = 'payment'", [id])).whatsapp, true, 'a member cannot turn it off');
  } finally {
    await done(s);
  }
});

// ---- Shopify: webhooks, a cart, a payment

async function shopifyOn(o: Parameters<typeof shop>[0] = {}) {
  const t = await shop(o);
  try {
    if (t.wa) {
      await submitTemplates(t.app, t.id, 'owner');
      await approveAll(t.s, ALL_TEMPLATES);
    }
    for (const k of Object.keys(KINDS) as (keyof typeof KINDS)[]) await saveSetting(t.app, t.id, k, { whatsapp: Boolean(t.wa), email: o.email !== false, link: k === 'review' ? 'https://g.example/review/kli' : null }, 'owner');
    // The setup job: Shopify's webhooks need the app's API secret key, which the owner pastes.
    await drain(t.app, { kinds: ['auto_setup'] });
  } catch (e) {
    await done(t.s);
    throw e;
  }
  return t;
}

test('Shopify: without the API secret key no webhooks (said plainly); with it, every topic registered and only a signed webhook believed', async () => {
  const { s, app, id, p } = await shopifyOn();
  try {
    let src = await app.db.one<any>('SELECT can, hooks FROM auto_sources WHERE store_id = $1', [id]);
    assert.equal(src.can.webhooks, false);
    assert.equal(src.can.why.webhooks, 'no_secret');
    assert.equal(src.can.checkouts, true);
    assert.match(await (await s.get('/settings')).text(), /כל רבע שעה.*API secret key/s);

    const res = await s.post(`/lead/${id}/auto/secret`, { _csrf: await s.csrf('/settings'), secret: API_SECRET });
    assert.equal(res.status, 303);
    src = await app.db.one<any>('SELECT can, hooks FROM auto_sources WHERE store_id = $1', [id]);
    assert.equal(src.can.webhooks, true);
    assert.deepEqual(p.state.webhooks.map((w) => w.topic), ['checkouts/create', 'checkouts/update', 'orders/create', 'orders/updated', 'orders/paid', 'fulfillments/create', 'fulfillments/update']);
    assert.ok(p.state.webhooks.every((w) => w.address === `https://toran.test/hooks/shopify/${id}`));
    // Set up again: nothing registered twice.
    await s.post(`/lead/${id}/auto/secret`, { _csrf: await s.csrf('/settings'), secret: API_SECRET });
    assert.equal(p.state.webhooks.length, 7);

    assert.equal((await shopifyHook(s, id, 'orders/paid', order(), { secret: 'shpss_wrongwrongwrongwrong' })).status, 401, 'a wrong signature');
    assert.equal((await fetch(`${s.base}/hooks/shopify/${id}`, { method: 'POST', body: '{}' })).status, 401, 'no signature');
    assert.equal((await shopifyHook(s, id + 999, 'orders/paid', order())).status, 401, 'another store\'s address');
    assert.equal((await app.db.one<any>('SELECT COUNT(*)::int AS n FROM jobs WHERE kind = $1', ['auto_hook'])).n, 0);
    assert.equal((await shopifyHook(s, id, 'orders/paid', order())).status, 200);
    await drain(app, { kinds: ['auto_hook'] });
    assert.deepEqual((await events(app, id)).map((e: any) => [e.key, e.status]), [['shopify:order:5001:paid', 'waiting']]);
  } finally {
    await done(s);
  }
});

test('Shopify: a payment by the store\'s own WhatsApp template, kept in the conversation, counted only once the customer answers; the same event twice is one message', async () => {
  const { s, app, id, g, p } = await shopifyOn();
  try {
    await s.post(`/lead/${id}/auto/secret`, { _csrf: await s.csrf('/settings'), secret: API_SECRET });
    // The webhook twice (Shopify retries), and a reading of the same order: one row.
    await shopifyHook(s, id, 'orders/paid', order(), { hookId: 'wh-1' });
    await shopifyHook(s, id, 'orders/updated', order(), { hookId: 'wh-2' });
    await drain(app, { kinds: ['auto_hook'] });
    p.state.orders = [order()];
    await pollStore(app, id);
    assert.ok(p.calls.some((c) => c.url.pathname.endsWith('/orders.json') && c.url.searchParams.get('updated_at_min')), 'the reading asks for what changed since');
    const before = await events(app, id);
    assert.equal(before.length, 1);
    await sendDue(app);
    await sendDue(app);
    assert.equal(g.sent.length, 1, 'sent once');
    const b = g.sent[0];
    assert.equal(b.type, 'template');
    assert.equal(b.to, CUSTOMER);
    assert.equal(b.template.name, 'toran_order_paid');
    assert.equal(b.template.language.code, 'he');
    assert.deepEqual(b.template.components[0].parameters.map((x: any) => x.text), ['דנה', '#1042']);
    const ev = (await events(app, id))[0];
    assert.deepEqual([ev.status, ev.channel, ev.basis], ['sent', 'whatsapp', "the order's phone"]);
    const c = await app.db.one<any>("SELECT c.id, c.peer, c.account_id, m.role, m.auto, m.text FROM conversations c JOIN messages m ON m.conversation_id = c.id WHERE c.store_id = $1 AND m.auto IS NOT NULL", [id]);
    assert.deepEqual([c.peer, c.role, c.auto], [CUSTOMER, 'agent', 'paid']);
    assert.match(c.text, /^שלום דנה, קיבלנו את התשלום על הזמנה #1042/);
    assert.equal((await counted(app.db, [id])).get(id)!.get(monthOf()) || 0, 0, 'Toran\'s own message counts nothing');
    const chat = await (await s.get(`/chat/${c.id}`)).text();
    assert.match(chat, /הודעה אוטומטית: התשלום התקבל/);

    // The customer answers: the same conversation, and now it counts.
    const r = await handleInbound(app, { channel: 'whatsapp', from: CUSTOMER, text: 'תודה! מתי זה יוצא?', id: 'wamid.in-a1', account: PHONE_ID, at: Date.now() });
    assert.equal(r.action, 'answered');
    const conv = await app.db.query<any>('SELECT DISTINCT conversation_id FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.store_id = $1 AND c.peer = $2', [id, CUSTOMER]);
    assert.equal(conv.length, 1, 'the answer lands beside the message');
    assert.equal((await counted(app.db, [id])).get(id)!.get(monthOf()), 1);
  } finally {
    await done(s);
  }
});

test('Shopify: an abandoned checkout reminded once, after the delay, only to a customer who agreed; an order placed or a message from the customer drops it', async () => {
  const { s, app, id, g } = await shopifyOn({ email: false });
  try {
    await s.post(`/lead/${id}/auto/secret`, { _csrf: await s.csrf('/settings'), secret: API_SECRET });
    // No consent at the checkout: never sent.
    await shopifyHook(s, id, 'checkouts/create', checkout());
    // Consent for the phone at the checkout ("text me with news and offers"), for a second checkout.
    const agreed = checkout({ id: 9002, token: 'tok-9002', abandoned_checkout_url: 'https://kli-cheres.example/checkouts/tok-9002/recover?key=k2', phone: '+972500000322', email: 'noa@example.test', customer: { first_name: 'נועה', phone: '+972500000322', sms_marketing_consent: { state: 'subscribed', opt_in_level: 'single_opt_in', consent_updated_at: iso(T0 - 5 * MIN) } } });
    await shopifyHook(s, id, 'checkouts/create', agreed);
    await shopifyHook(s, id, 'checkouts/update', agreed);
    // A third, whose customer then ordered.
    await shopifyHook(s, id, 'checkouts/create', checkout({ id: 9003, token: 'tok-9003', phone: '+972500000323', customer: { first_name: 'רון', phone: '+972500000323', sms_marketing_consent: { state: 'subscribed', consent_updated_at: iso(T0) } } }));
    await drain(app, { kinds: ['auto_hook'] });
    await shopifyHook(s, id, 'orders/create', order({ id: 5003, name: '#1043', checkout_token: 'tok-9003', phone: '+972500000323', email: 'ron@example.test', financial_status: 'pending', customer: { first_name: 'רון', phone: '+972500000323' } }));
    await drain(app, { kinds: ['auto_hook'] });
    assert.equal((await consentOf(app.db, id, 'whatsapp', OTHER)).source, 'shopify:sms_marketing_consent');

    await sendDue(app);
    assert.equal(g.sent.filter((b) => b.template.name === MESSAGES.cart.template).length, 0, 'not before the hour');
    setNow(T0 + 61 * MIN);
    await sendDue(app);
    const carts = g.sent.filter((b) => b.template.name === MESSAGES.cart.template);
    assert.equal(carts.length, 1, 'one reminder: the customer who agreed');
    assert.equal(carts[0].to, OTHER);
    assert.deepEqual(carts[0].template.components[0].parameters.map((x: any) => x.text), ['נועה', 'https://kli-cheres.example/checkouts/tok-9002/recover?key=k2']);
    // The button's variable is the customer's own token, bound to this store, channel and phone.
    const button = carts[0].template.components[1];
    assert.deepEqual([button.type, button.sub_type, button.index], ['button', 'url', '0']);
    const token = button.parameters[0].text;
    assert.match(token, /^[\w-]{24}$/);
    assert.deepEqual(await app.db.one('SELECT store_id, channel, address FROM auto_links WHERE token = $1', [token]), { store_id: id, channel: 'whatsapp', address: OTHER });
    assert.doesNotMatch((await app.db.one<any>("SELECT text FROM messages WHERE auto = 'cart'")).text, /הסר/, 'the text in the inbox has no footer');
    const rows = await events(app, id);
    const by = (k: string) => rows.find((e: any) => e.key === k);
    assert.equal(by('shopify:checkout:tok-9001:cart').why, 'whatsapp: no consent');
    assert.equal(by('shopify:checkout:tok-9002:cart').basis, 'consent shopify:sms_marketing_consent');
    assert.equal(by('shopify:checkout:tok-9003:cart').why, 'ordered');
    assert.equal(by('shopify:order:5003:pending').status, 'sent', 'the order waiting for payment is told so');
    // The same checkout updated again later: never a second reminder.
    await shopifyHook(s, id, 'checkouts/update', { ...agreed, updated_at: iso(T0 + 2 * 60 * MIN) });
    await drain(app, { kinds: ['auto_hook'] });
    setNow(T0 + 3 * 60 * MIN);
    await sendDue(app);
    assert.equal(g.sent.filter((b) => b.template.name === MESSAGES.cart.template).length, 1);

    // A reminder still waiting is dropped when the customer writes to the store first.
    await shopifyHook(s, id, 'checkouts/create', { ...agreed, id: 9004, token: 'tok-9004', created_at: iso(T0 + 3 * 60 * MIN) });
    await drain(app, { kinds: ['auto_hook'] });
    await handleInbound(app, { channel: 'whatsapp', from: OTHER, text: 'יש את הספל באפור?', id: 'wamid.in-c1', account: PHONE_ID, at: Date.now() });
    setNow(T0 + 5 * 60 * MIN);
    await sendDue(app);
    assert.equal((await events(app, id)).find((e: any) => e.key === 'shopify:checkout:tok-9004:cart').why, 'replied');
  } finally {
    await done(s);
  }
});

test('opt-out: "הסר" on the store\'s WhatsApp is answered with one line, recorded with its source, and stops every automatic message after it', async () => {
  const { s, app, id, g } = await shopifyOn({ email: false });
  try {
    const r = await handleInbound(app, { channel: 'whatsapp', from: CUSTOMER, text: 'הסר', id: 'wamid.in-o1', account: PHONE_ID, at: Date.now() });
    assert.equal(r.action, 'opt_out');
    assert.match(r.reply!, /לא נשלח לכם יותר הודעות אוטומטיות/);
    assert.equal(g.sent.length, 1);
    assert.equal(g.sent[0].type, 'text', 'the answer is an ordinary reply inside the 24 hours');
    const c = await app.db.one<any>("SELECT source, scope, state FROM auto_consent WHERE store_id = $1 AND address = $2", [id, CUSTOMER]);
    assert.deepEqual(c, { source: 'customer:הסר', scope: 'all', state: 'out' });
    assert.deepEqual(await consentOf(app.db, id, 'whatsapp', '050-000-0321'), { updates: false, marketing: false, source: null });
    // A payment after it: not sent.
    setNow(T0 + 10 * MIN);
    await record(app, id, 'shopify', { happenings: [{ key: 'shopify:order:5009:paid', message: 'paid', ref: '#1049', at: iso(T0 + 10 * MIN), contact: { name: 'דנה', phone: CUSTOMER, email: null }, vars: { order: '#1049' } }], consent: [], placed: [] }, 'webhook');
    await sendDue(app);
    assert.equal(g.sent.length, 1);
    assert.equal((await events(app, id))[0].why, 'whatsapp: opted out');
    // STOP works too, and a later "yes" at a checkout counts again.
    assert.equal((await handleInbound(app, { channel: 'whatsapp', from: OTHER, text: 'STOP', id: 'wamid.in-o2', account: PHONE_ID, at: Date.now() })).action, 'opt_out');
    await record(app, id, 'shopify', { happenings: [], placed: [], consent: [{ channel: 'whatsapp', address: OTHER, scope: 'marketing', state: 'in', source: 'shopify:sms_marketing_consent', at: iso(T0 + 60 * MIN) }] }, 'poll');
    setNow(T0 + 61 * MIN);
    assert.equal((await consentOf(app.db, id, 'whatsapp', OTHER)).marketing, true);
  } finally {
    await done(s);
  }
});

test('quiet time: a message due on Friday afternoon waits for Sunday morning; something a week old is never recorded', async () => {
  const { app, id, g, s } = await shopifyOn({ email: false });
  try {
    const fri = Date.parse('2026-10-23T11:30:00Z'); // 13:30 in Israel
    setNow(fri);
    // Turned on again from Friday, so that what happens now counts.
    await app.db.query("UPDATE auto_settings SET on_since = $2 WHERE store_id = $1", [id, iso(fri - 60 * MIN)]);
    await record(app, id, 'shopify', { happenings: [{ key: 'shopify:order:6001:paid', message: 'paid', ref: '#2001', at: iso(fri), contact: { name: 'דנה', phone: CUSTOMER, email: null }, vars: { order: '#2001' } }], consent: [], placed: [] }, 'webhook');
    await sendDue(app);
    assert.equal(g.sent.length, 0);
    const e = await app.db.one<any>("SELECT status, due_at FROM auto_events WHERE key = 'shopify:order:6001:paid'");
    assert.deepEqual([e.status, new Date(e.due_at).toISOString()], ['waiting', '2026-10-25T07:00:00.000Z']);
    setNow(Date.parse('2026-10-24T17:00:00Z')); // Saturday night, 19:00: still Shabbat by our hours
    await sendDue(app);
    assert.equal(g.sent.length, 0);
    setNow(Date.parse('2026-10-25T07:05:00Z')); // Sunday 09:05
    await sendDue(app);
    assert.equal(g.sent.length, 1);
    // Something old a reading brings back is never recorded.
    assert.equal(await record(app, id, 'shopify', { happenings: [{ key: 'shopify:order:6002:paid', message: 'paid', ref: '#2002', at: iso(fri - 10 * 24 * 60 * MIN), contact: { name: null, phone: CUSTOMER, email: null }, vars: { order: '#2002' } }], consent: [], placed: [] }, 'poll'), 0);
  } finally {
    await done(s);
  }
});

// ---- WooCommerce: a read-only key, the reading, email

test('WooCommerce with a read-only key: no webhooks, said plainly; the orders read every 15 minutes; paid, failed and shipped by email from the store\'s address', async () => {
  const { s, app, p } = await shop({ whatsapp: false });
  const id = (await app.db.one<{ id: number }>("INSERT INTO stores (domain, url, name, platform, source, workspace_id) VALUES ('tavlinim-ba-shuk.example', 'https://tavlinim-ba-shuk.example/', 'תבלינים בשוק', 'woocommerce', 'seed', 1) ON CONFLICT (domain) DO UPDATE SET workspace_id = 1, platform = 'woocommerce', name = EXCLUDED.name, brand = '{}', brand_override = '{}' RETURNING id"))!.id;
  try {
    await app.db.query("INSERT INTO order_access (store_id, platform, secret, status, meta) VALUES ($1, 'woocommerce', $2, 'active', '{}')", [id, seal(app.env, JSON.stringify(WOO_KEY))]);
    await app.db.query("INSERT INTO channel_accounts (store_id, channel, kind, external_id, status) VALUES ($1, 'email', 'sim', 'tavlinim@mail.toran.test', 'active')", [id]);
    await assert.rejects(saveSetting(app, id, 'payment', { whatsapp: true, email: false }, 'owner'), (e: any) => /המספר של החנות/.test(e.he), 'no WhatsApp without the store\'s own number');
    await saveSetting(app, id, 'payment', { whatsapp: false, email: true }, 'owner');
    await saveSetting(app, id, 'shipping', { whatsapp: false, email: true }, 'owner');
    await drain(app, { kinds: ['auto_setup'] });
    const src = await app.db.one<any>('SELECT can FROM auto_sources WHERE store_id = $1', [id]);
    assert.deepEqual([src.can.webhooks, src.can.why.webhooks], [false, 'read_only']);
    assert.match(await (await s.get('/settings')).text(), /לקריאה בלבד.*כל רבע שעה/s);

    const woo = (o: Record<string, unknown>) => ({ id: 801, number: '801', status: 'processing', date_created_gmt: iso(T0).slice(0, 19), date_modified_gmt: iso(T0).slice(0, 19), date_paid_gmt: iso(T0).slice(0, 19), billing: { first_name: 'יעל', email: 'yael@example.test', phone: '050-000-0324' }, shipping: {}, payment_url: 'https://tavlinim-ba-shuk.example/checkout/order-pay/801/?key=wc_order_x', line_items: [{ product_id: 11, variation_id: 0, quantity: 1 }], meta_data: [], ...o });
    p.state.wooOrders = [woo({}), woo({ id: 802, number: '802', status: 'failed', date_paid_gmt: null, billing: { first_name: 'עמית', email: 'amit@example.test', phone: '' } })];
    await scheduleAuto(app);
    await drain(app, { kinds: ['auto_poll'] });
    assert.ok(p.calls.some((c) => c.url.pathname === '/wp-json/wc/v3/orders' && c.url.searchParams.get('modified_after')), 'read since the last reading');
    await sendDue(app);
    const out = app.mail!.outbox!.filter((m) => !m.notice);
    assert.deepEqual(out.map((m) => [m.to, m.subject]), [['yael@example.test', 'קיבלנו את התשלום על הזמנה 801 בתבלינים בשוק'], ['amit@example.test', 'התשלום על הזמנה 802 בתבלינים בשוק לא עבר']]);
    assert.match(out[1].text, /https:\/\/tavlinim-ba-shuk\.example\/checkout\/order-pay\/802|order-pay\/801/);
    assert.equal((out[0].headers as any)['Auto-Submitted'], 'auto-generated');
    assert.equal(out[0].from, '"תבלינים בשוק" <tavlinim@mail.toran.test>');
    assert.ok(!('List-Unsubscribe' in (out[0].headers as any)), 'a payment is not marketing');

    // Not read again before 15 minutes; then the order is completed: shipped, with no tracking link, still by email.
    p.calls.length = 0;
    await scheduleAuto(app);
    assert.equal(await drain(app, { kinds: ['auto_poll'] }), 0);
    p.state.wooOrders = [woo({ status: 'completed', date_completed_gmt: iso(T0 + 20 * MIN).slice(0, 19), date_modified_gmt: iso(T0 + 20 * MIN).slice(0, 19) })];
    setNow(T0 + 16 * MIN);
    await app.db.query("UPDATE auto_sources SET polled_at = $2 WHERE store_id = $1", [id, iso(T0)]);
    await pollStore(app, id);
    setNow(T0 + 21 * MIN);
    await sendDue(app);
    const shipped = app.mail!.outbox!.filter((m) => !m.notice).at(-1)!;
    assert.equal(shipped.subject, 'הזמנה 801 מתבלינים בשוק יצאה אליכם');
    // A reply in that thread finds the conversation the message is in.
    const conv = await app.db.query<any>("SELECT id, meta FROM conversations WHERE store_id = $1 AND peer = 'yael@example.test' ORDER BY id", [id]);
    assert.equal(conv.length, 2, 'each email its own thread');
    assert.equal(conv[1].meta.bare, 'הזמנה 801 מתבלינים בשוק יצאה אליכם');
  } finally {
    await done(s);
  }
});

test('WooCommerce with a Read/Write key: its webhooks registered with a secret Toran made, and a signed order.updated believed', async () => {
  const { s, app, p } = await shop({ whatsapp: false });
  const id = (await app.db.one<{ id: number }>("INSERT INTO stores (domain, url, name, platform, source, workspace_id) VALUES ('tavlinim-ba-shuk.example', 'https://tavlinim-ba-shuk.example/', 'תבלינים בשוק', 'woocommerce', 'seed', 1) ON CONFLICT (domain) DO UPDATE SET workspace_id = 1, platform = 'woocommerce', name = EXCLUDED.name, brand = '{}', brand_override = '{}' RETURNING id"))!.id;
  try {
    p.state.wooReadOnly = false;
    await app.db.query("INSERT INTO order_access (store_id, platform, secret, status, meta) VALUES ($1, 'woocommerce', $2, 'active', '{}')", [id, seal(app.env, JSON.stringify(WOO_KEY))]);
    await app.db.query("INSERT INTO channel_accounts (store_id, channel, kind, external_id, status) VALUES ($1, 'email', 'sim', 'tavlinim@mail.toran.test', 'active')", [id]);
    await saveSetting(app, id, 'payment', { whatsapp: false, email: true }, 'owner');
    await drain(app, { kinds: ['auto_setup'] });
    assert.deepEqual(p.state.wooHooks.map((w) => [w.topic, w.delivery_url]), [['order.created', `https://toran.test/hooks/woocommerce/${id}`], ['order.updated', `https://toran.test/hooks/woocommerce/${id}`]]);
    const secret = p.state.wooHooks[0].secret;
    assert.ok(secret.length >= 24);
    // WooCommerce's unsigned ping when a webhook is saved.
    assert.equal((await fetch(`${s.base}/hooks/woocommerce/${id}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'webhook_id=300' })).status, 200);
    const raw = JSON.stringify({ id: 803, number: '803', status: 'on-hold', date_created_gmt: iso(T0).slice(0, 19), billing: { first_name: 'דנה', email: 'dana@example.test' }, meta_data: [] });
    assert.equal((await fetch(`${s.base}/hooks/woocommerce/${id}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-wc-webhook-signature': wooSign('not-the-secret', raw), 'x-wc-webhook-topic': 'order.updated' }, body: raw })).status, 401);
    assert.equal((await fetch(`${s.base}/hooks/woocommerce/${id}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-wc-webhook-signature': wooSign(secret, raw), 'x-wc-webhook-topic': 'order.updated', 'x-wc-webhook-delivery-id': 'd1' }, body: raw })).status, 200);
    await drain(app, { kinds: ['auto_hook'] });
    await sendDue(app);
    assert.equal(app.mail!.outbox!.filter((m) => !m.notice).at(-1)!.subject, 'הזמנה 803 בתבלינים בשוק מחכה לתשלום');
  } finally {
    await done(s);
  }
});

// ---- shipping and the review, and Wix's readers

test('a shipment: shipped with its tracking link, delivered as the carrier says, and the review counted from the delivery; Wix\'s orders and checkouts read the same way', async () => {
  const { s, app, id, g } = await shopifyOn({ email: false });
  try {
    const f = { id: 41, status: 'success', created_at: iso(T0), updated_at: iso(T0), tracking_url: 'https://track.example/IL123', shipment_status: 'in_transit' };
    await record(app, id, 'shopify', shopifyOrderRead(order({ fulfillments: [f] })), 'webhook');
    let rows = await events(app, id);
    assert.deepEqual(rows.map((e: any) => e.key).sort(), ['shopify:fulfillment:41:shipped', 'shopify:order:5001:paid', 'shopify:order:5001:review']);
    const review = await app.db.one<any>("SELECT due_at FROM auto_events WHERE key = 'shopify:order:5001:review'");
    assert.equal(new Date(review.due_at).getTime(), T0 + 5 * 24 * 60 * MIN, 'from the shipment: three days, and two for the delivery');
    await sendDue(app);
    // Delivered a day later: the review moves to three days from the delivery.
    const d = T0 + 24 * 60 * MIN;
    setNow(d);
    await record(app, id, 'shopify', shopifyOrderRead(order({ fulfillments: [{ ...f, shipment_status: 'delivered', updated_at: iso(d) }] })), 'poll');
    assert.equal(new Date((await app.db.one<any>("SELECT due_at FROM auto_events WHERE key = 'shopify:order:5001:review'")).due_at).getTime(), d + 3 * 24 * 60 * MIN);
    await sendDue(app);
    assert.deepEqual(g.sent.map((b) => b.template.name), ['toran_order_paid', 'toran_order_shipped', 'toran_order_delivered']);
    assert.equal(g.sent[1].template.components[0].parameters[2].text, 'https://track.example/IL123');
    // Due on Saturday, so it waits for Sunday morning; and it is marketing, which this customer never agreed to.
    setNow(d + 3 * 24 * 60 * MIN + MIN);
    await sendDue(app);
    assert.equal((await events(app, id)).find((e: any) => e.message === 'review').status, 'waiting');
    setNow(Date.parse('2026-10-25T07:05:00Z'));
    await sendDue(app);
    rows = await events(app, id);
    assert.equal(rows.find((e: any) => e.message === 'review').why, 'whatsapp: no consent');

    const wix = wixOrderRead({ id: 'w-1', number: '10021', createdDate: iso(T0), status: 'APPROVED', paymentStatus: 'PAID', fulfillmentStatus: 'FULFILLED', buyerInfo: { email: 'gal@example.test' }, billingInfo: { contactDetails: { firstName: 'גל', phone: '050-000-0325' } }, checkoutId: 'ck-1' }, [{ id: 'f-1', createdDate: iso(T0), trackingInfo: { trackingLink: 'https://track.example/W1' } }], 'https://quiet-candles.example');
    assert.deepEqual(wix.happenings.map((h) => [h.key, h.contact.phone]), [['wix:order:w-1:paid', '972500000325'], ['wix:fulfillment:f-1:shipped', '972500000325'], ['wix:order:w-1:review', '972500000325']]);
    assert.equal(wix.placed[0].checkout, 'ck-1');
    const ab = wixCheckoutRead({ id: 'a-1', checkoutId: 'ck-2', status: 'ABANDONED', createdDate: iso(T0), buyerInfo: { email: 'gal@example.test' }, checkoutUrl: 'https://quiet-candles.example/checkout?id=ck-2' });
    assert.equal(ab.happenings[0].key, 'wix:checkout:ck-2:cart');
    assert.equal(wixCheckoutRead({ id: 'a-2', checkoutId: 'ck-3', status: 'RECOVERED', createdDate: iso(T0) }).placed.length, 1);
  } finally {
    await done(s);
  }
});

// ---- the link to stop the reminders: the page, the email's headers, the old templates

const DANA = 'dana@example.test';
const yes = (channel: 'whatsapp' | 'email', address: string, at = T0 - 5 * MIN) => ({ channel, address, scope: 'marketing' as const, state: 'in' as const, source: channel === 'whatsapp' ? 'shopify:sms_marketing_consent' : 'shopify:email_marketing_consent', at: iso(at) });
const happening = (message: 'cart' | 'review' | 'paid', ref: string, at: number, contact: { name: string | null; phone: string | null; email: string | null }) => ({
  happenings: [{ key: `shopify:${message === 'cart' ? 'checkout' : 'order'}:${ref}:${message}`, message, ref, at: iso(at), contact, vars: message === 'cart' ? { link: `https://kli-cheres.example/checkouts/${ref}/recover` } : { order: `#${ref}` } }],
  consent: [],
  placed: [],
});
const page = (s: Awaited<ReturnType<typeof serve>>, p: string, init: RequestInit = {}) => fetch(`${s.base}${p}`, { redirect: 'manual', ...init });
const form = (body: string) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });

test('the link in a reminder: a quiet page in the store\'s colour, stop and undo; the cart and the review stop on every channel, payment and shipping go on; a wrong token gets one polite page', async () => {
  const { s, app, id, g } = await shopifyOn();
  try {
    const dana = { name: 'דנה', phone: CUSTOMER, email: DANA };
    await record(app, id, 'shopify', { happenings: [], placed: [], consent: [yes('whatsapp', CUSTOMER), yes('email', DANA)] }, 'poll');
    await record(app, id, 'shopify', happening('cart', 'tok-a', T0, dana), 'webhook');
    setNow(T0 + 61 * MIN);
    await sendDue(app);
    const sent = g.sent.find((b) => b.template?.name === MESSAGES.cart.template);
    const token = sent.template.components[1].parameters[0].text;
    const st = await app.db.one<any>('SELECT name, brand, brand_override FROM stores WHERE id = $1', [id]);
    const name = displayName(st.brand_override?.name, st.brand?.name, st.name)!;

    // The page: the store's name, one question, one button. Never indexed, and the token never leaves in a Referer.
    let res = await page(s, `/u/${token}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('x-robots-tag')!, /noindex/);
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    let html = await res.text();
    assert.match(html, /<html lang="he" dir="rtl">/);
    assert.match(html, /<meta name="robots" content="noindex/);
    assert.ok(html.includes(`<bdi>${name}</bdi>`), 'the store\'s name');
    assert.match(html, /לא לקבל יותר תזכורות מ(-)?<bdi>[^<]+<\/bdi>\?/);
    assert.match(html, new RegExp(`<form method="post" action="/u/${token}"><input type="hidden" name="do" value="stop"><button class="stop-btn" type="submit">כן, להפסיק</button>`));
    assert.ok(html.includes(`href="/u/${token}/theme.css"`));
    assert.match(await (await page(s, `/u/${token}/theme.css`)).text(), /^:root\{--store:#[0-9a-f]{6};--store-ink:#[0-9a-f]{6}\}$/);
    assert.equal((await consentOf(app.db, id, 'whatsapp', CUSTOMER)).marketing, true, 'opening the page stops nothing');

    // Stop: recorded with source "link" for the phone and for the email the same order carried.
    res = await page(s, `/u/${token}`, form('do=stop'));
    assert.deepEqual([res.status, res.headers.get('location')], [303, `/u/${token}`]);
    html = await (await page(s, `/u/${token}`)).text();
    assert.match(html, /סגור, לא נשלח לכם יותר תזכורות מ(-)?<bdi>[^<]+<\/bdi>\./);
    assert.match(html, /עדכונים על הזמנות שעשיתם \(תשלום ומשלוח\) ימשיכו להגיע\./);
    assert.match(html, /name="do" value="undo"><button class="grey" type="submit">בעצם כן, להמשיך לקבל<\/button>/);
    assert.deepEqual(await app.db.query("SELECT channel, address, scope, state FROM auto_consent WHERE store_id = $1 AND source = 'link' ORDER BY channel", [id]), [
      { channel: 'email', address: DANA, scope: 'marketing', state: 'out' },
      { channel: 'whatsapp', address: CUSTOMER, scope: 'marketing', state: 'out' },
    ]);
    assert.deepEqual(await consentOf(app.db, id, 'whatsapp', CUSTOMER), { updates: true, marketing: false, source: null });
    assert.equal((await consentOf(app.db, id, 'email', DANA)).marketing, false, 'on every channel');
    // Twice is once.
    await page(s, `/u/${token}`, form('do=stop'));
    assert.equal((await app.db.one<any>("SELECT COUNT(*)::int AS n FROM auto_consent WHERE store_id = $1 AND source = 'link'", [id])).n, 2);

    // Later: a review request is not sent on either channel; a payment is.
    await record(app, id, 'shopify', happening('review', '5050', T0 + 61 * MIN, dana), 'webhook');
    setNow(T0 + 3 * 24 * 60 * MIN + 62 * MIN); // a Friday, 12:02 in Israel
    await record(app, id, 'shopify', happening('paid', '5051', now(), dana), 'webhook');
    const before = g.sent.length;
    await sendDue(app);
    const rows = await events(app, id);
    assert.equal(rows.find((e: any) => e.message === 'review').why, 'whatsapp: no consent; email: no consent');
    assert.equal(rows.find((e: any) => e.message === 'paid').status, 'sent');
    assert.deepEqual(g.sent.slice(before).map((b) => b.template.name), ['toran_order_paid']);
    assert.equal(g.sent.at(-1).template.components.length, 1, 'an update on an order has no button');

    // Undo: the "yes" the stop put aside comes back, with its own source.
    res = await page(s, `/u/${token}`, form('do=undo'));
    assert.deepEqual([res.status, res.headers.get('location')], [303, `/u/${token}?kept=1`]);
    html = await (await page(s, `/u/${token}?kept=1`)).text();
    assert.match(html, /בסדר, התזכורות מ(-)?<bdi>[^<]+<\/bdi> ימשיכו להגיע\./);
    assert.match(html, /כן, להפסיק/);
    assert.deepEqual(await consentOf(app.db, id, 'whatsapp', CUSTOMER), { updates: true, marketing: true, source: 'shopify:sms_marketing_consent' });
    assert.equal((await consentOf(app.db, id, 'email', DANA)).marketing, true);
    // An undo never gives a "yes" nobody gave: a customer with no consent who stops and undoes still has none.
    const t2 = (await stopToken(app.db, id, 'whatsapp', OTHER))!;
    assert.equal(await stopToken(app.db, id, 'whatsapp', '050-000-0322'), t2, 'one token an address');
    await page(s, `/u/${t2}`, form('do=stop'));
    await page(s, `/u/${t2}`, form('do=undo'));
    assert.equal((await consentOf(app.db, id, 'whatsapp', OTHER)).marketing, false);
    // "הסר" still works, though nothing says it: it stops everything, the undo of the link does not bring it back.
    await handleInbound(app, { channel: 'whatsapp', from: CUSTOMER, text: 'הסר', id: 'wamid.in-l1', account: PHONE_ID, at: Date.now() });
    await page(s, `/u/${token}`, form('do=stop'));
    await page(s, `/u/${token}`, form('do=undo'));
    assert.equal((await consentOf(app.db, id, 'whatsapp', CUSTOMER)).updates, false);

    // A token that is not ours, of any shape: one polite page, nothing about any store.
    for (const bad of ['A'.repeat(24), 'short', `${token.slice(0, 23)}${token.endsWith('x') ? 'y' : 'x'}`]) {
      const r = await page(s, `/u/${bad}`);
      assert.equal(r.status, 404);
      const h = await r.text();
      assert.match(h, /הקישור הזה לא עובד/);
      assert.ok(!h.includes(name), 'no store\'s name');
      assert.equal((await page(s, `/u/${bad}`, form('do=stop'))).status, 404);
    }
  } finally {
    await done(s);
  }
});

test('email: a reminder ends with its link, List-Unsubscribe names the page and the reply, and a mail client\'s one-click POST stops it (RFC 8058)', async () => {
  const { s, app, id } = await shopifyOn({ whatsapp: false });
  try {
    await record(app, id, 'shopify', { happenings: [], placed: [], consent: [yes('email', DANA)] }, 'poll');
    await record(app, id, 'shopify', happening('cart', 'tok-m', T0, { name: 'דנה', phone: null, email: DANA }), 'webhook');
    setNow(T0 + 61 * MIN);
    await sendDue(app);
    const out = app.mail!.outbox!.filter((m) => !m.notice).at(-1)!;
    assert.equal(out.to, DANA);
    const m = /\n\nלא רוצים לקבל מאיתנו תזכורות כאלה\? אפשר להפסיק כאן:\nhttps:\/\/toran\.test\/u\/([\w-]{24})$/.exec(out.text);
    assert.ok(m, 'the last line is the link');
    assert.doesNotMatch(out.text, /הסר/);
    const token = m![1];
    const h = out.headers as Record<string, string>;
    assert.equal(h['List-Unsubscribe'], `<https://toran.test/u/${token}>, <mailto:kli@mail.toran.test?subject=${encodeURIComponent('הסר')}>`);
    assert.equal(h['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
    assert.deepEqual(await app.db.one('SELECT channel, address FROM auto_links WHERE token = $1', [token]), { channel: 'email', address: DANA });

    // The one-click POST: no cookie, no Origin, no page to read; answered with the confirmation.
    const res = await fetch(`${s.base}/u/${token}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /סגור, לא נשלח לכם יותר תזכורות/);
    assert.deepEqual(await consentOf(app.db, id, 'email', DANA), { updates: true, marketing: false, source: null });
    assert.equal((await app.db.one<any>("SELECT source FROM auto_consent WHERE store_id = $1 AND state = 'out'", [id])).source, 'link');
    assert.equal((await app.db.one<any>("SELECT data FROM events WHERE store_id = $1 AND kind = 'auto_link_stop'", [id])).data.via, 'one-click');

    // A payment by email is not marketing: no link, no List-Unsubscribe.
    await record(app, id, 'shopify', happening('paid', '5060', now(), { name: 'דנה', phone: null, email: DANA }), 'webhook');
    await sendDue(app);
    const paid = app.mail!.outbox!.filter((x) => !x.notice).at(-1)!;
    assert.match(String(paid.subject), /קיבלנו את התשלום/);
    assert.ok(!('List-Unsubscribe' in (paid.headers as any)) && !('List-Unsubscribe-Post' in (paid.headers as any)));
    assert.doesNotMatch(paid.text, /\/u\//);
  } finally {
    await done(s);
  }
});

test('a store whose old marketing templates ("כתבו הסר") Meta approved: they go out as they were until the new ones are approved; the worker submits the new ones once', async () => {
  const { s, app, id, g, wa } = await shop({ email: false });
  try {
    for (const [key, m] of Object.entries(MESSAGES)) {
      const name = LEGACY[key as keyof typeof LEGACY]?.template || m.template;
      await app.db.query("INSERT INTO wa_templates (account_id, store_id, name, message, asked, category, meta_id, status, body) VALUES ($1, $2, $3, $4, $5, $5, $6, 'APPROVED', 'x')", [wa, id, name, key, categoryOf(key as any), `old-${key}`]);
    }
    assert.deepEqual(await approvedFor(app, wa, 'cart'), { ok: true, missing: [], legacy: ['cart'] });
    await saveSetting(app, id, 'cart', { whatsapp: true, email: false }, 'owner');
    assert.match(await (await s.get('/settings')).text(), /אושרה בנוסח הקודם\. צריך לשלוח את הנוסח החדש/);

    await record(app, id, 'shopify', { happenings: [], placed: [], consent: [yes('whatsapp', OTHER), yes('whatsapp', CUSTOMER)] }, 'poll');
    await record(app, id, 'shopify', happening('cart', 'tok-o', T0, { name: 'נועה', phone: OTHER, email: null }), 'webhook');
    setNow(T0 + 61 * MIN);
    await sendDue(app);
    assert.equal(g.sent.length, 1);
    assert.equal(g.sent[0].template.name, 'toran_cart_reminder', 'the old one, approved');
    assert.deepEqual(g.sent[0].template.components.map((c: any) => c.type), ['body'], 'no button parameter for a template that has none');
    assert.match((await app.db.one<any>("SELECT text FROM messages WHERE auto = 'cart'")).text, /כתבו הסר$/, 'kept as the customer read it');

    // The worker submits the new marketing ones, once, and nothing else.
    await scheduleAuto(app);
    await drain(app, { kinds: ['wa_templates_new'] });
    assert.deepEqual([...g.templates.keys()].sort(), [MESSAGES.cart.template, MESSAGES.review.template].sort());
    await scheduleAuto(app);
    assert.equal((await app.db.one<any>("SELECT COUNT(*)::int AS n FROM jobs WHERE kind = 'wa_templates_new'")).n, 1);
    assert.match(await (await s.get('/settings')).text(), /אושרה בנוסח הקודם, והחדש מחכה לאישור של Meta/);

    // Approved: the new one, with its button, from then on.
    await approveAll(s, [MESSAGES.cart.template, MESSAGES.review.template]);
    assert.deepEqual((await approvedFor(app, wa, 'cart')).legacy, []);
    await record(app, id, 'shopify', happening('cart', 'tok-p', T0 + 2 * 60 * MIN, { name: 'דנה', phone: CUSTOMER, email: null }), 'webhook');
    setNow(T0 + 3 * 60 * MIN + MIN);
    await sendDue(app);
    const last = g.sent.at(-1);
    assert.equal(last.template.name, MESSAGES.cart.template);
    assert.equal(last.template.components[1].sub_type, 'url');
  } finally {
    await done(s);
  }
});
