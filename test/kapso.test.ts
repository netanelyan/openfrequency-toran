import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KapsoError, kapsoSign, kapsoSignatureOk, startKapsoConnect, storeConnectReady, waProvider } from '../src/channels/kapso.ts';
import { drain, schedule } from '../src/jobs/worker.ts';
import { submitTemplates } from '../src/auto/templates.ts';
import { customer } from './helpers.ts';
import { serve } from './serve.ts';

// A store's own WhatsApp number connected through Kapso (channels/kapso.ts, TORAN_WA_PROVIDER=kapso), against a
// stand-in for Kapso's Platform API and its Meta proxy. Nothing here reaches Kapso or Meta.

const KEY = 'kapso-test-project-key';
const HOOK = 'kapso-webhook-secret-0123456789';
const EVENTS = 'kapso-events-secret-0123456789';
const PHONE_ID = '611122233344455';
const WABA = '922233344455566';
const CUSTOMER = '972500000654';

type Call = { method: string; path: string; key: string | null; auth: string | null; body: any };

/**
 * Kapso, as much of it as Toran uses: customers, setup links, the project's numbers (`numbers`, each with the customer
 * it belongs to), a number's webhooks, deleting a number, and the Meta proxy's sends and template submissions. Every
 * call without our key is refused, as Kapso does.
 */
function fakeKapso() {
  const calls: Call[] = [];
  const state = { customers: 0, links: 0, sent: 0, numbers: new Map<string, any>(), webhooks: [] as any[], deleted: [] as string[] };
  const f = (async (input: any, init: any = {}) => {
    const u = new URL(String(input));
    const method = String(init.method || 'GET');
    const body = init.body ? JSON.parse(String(init.body)) : null;
    const h = (init.headers || {}) as Record<string, string>;
    calls.push({ method, path: u.pathname + u.search, key: h['x-api-key'] || null, auth: h.authorization || null, body });
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
    if (u.hostname !== 'api.kapso.ai') return json({ error: { message: `not Kapso: ${u.hostname}` } }, 404);
    if (h['x-api-key'] !== KEY) return json({ error: { message: 'Missing or invalid API key' } }, 401);
    const p = u.pathname;
    if (p === '/platform/v1/customers' && method === 'POST') return json({ data: { id: `0000000${++state.customers}-0000-4000-8000-000000000000`.slice(-36), name: body.customer.name, external_customer_id: body.customer.external_customer_id } }, 201);
    const link = /^\/platform\/v1\/customers\/([0-9a-f-]{36})\/setup_links$/.exec(p);
    if (link && method === 'POST') return json({ data: { id: `link-${++state.links}`, url: `https://app.kapso.ai/whatsapp/setup/tok${state.links}`, status: 'active', ...body.setup_link } }, 201);
    if (p === '/platform/v1/whatsapp/phone_numbers' && method === 'GET') {
      const n = state.numbers.get(u.searchParams.get('phone_number_id') || '');
      return json({ data: n ? [n] : [], meta: { page: 1, per_page: 20, total_pages: 1, total_count: n ? 1 : 0 } });
    }
    const hooks = /^\/platform\/v1\/whatsapp\/phone_numbers\/(\d+)\/webhooks(?:\/([\w-]+))?$/.exec(p);
    if (hooks && method === 'GET') return json({ data: state.webhooks.filter((w) => w.phone === hooks[1]) });
    if (hooks && method === 'POST') {
      if (state.webhooks.some((w) => w.phone === hooks[1] && w.kind === 'meta')) return json({ error: 'Only one Meta webhook is allowed per phone number' }, 422);
      const w = { id: `wh-${state.webhooks.length + 1}`, phone: hooks[1], ...body.whatsapp_webhook };
      state.webhooks.push(w);
      return json({ data: w }, 201);
    }
    if (hooks && method === 'PATCH') {
      const w = state.webhooks.find((x) => x.id === hooks[2]);
      Object.assign(w, body.whatsapp_webhook);
      return json({ data: w });
    }
    const del = /^\/platform\/v1\/whatsapp\/phone_numbers\/(\d+)$/.exec(p);
    if (del && method === 'DELETE') {
      state.deleted.push(del[1]);
      state.numbers.delete(del[1]);
      return new Response(null, { status: 204 });
    }
    if (p === `/meta/whatsapp/v24.0/${PHONE_ID}/messages` && method === 'POST') return json({ messaging_product: 'whatsapp', messages: [{ id: `wamid.kapso-${++state.sent}` }] });
    if (p === `/meta/whatsapp/v24.0/${WABA}/message_templates` && method === 'POST') return json({ id: `tpl-${body.name}`, status: 'PENDING', category: body.category });
    return json({ error: { message: `no route ${method} ${p}` } }, 404);
  }) as typeof fetch;
  /** A number in our Kapso project, connected by `customer` (its Kapso id). */
  const number = (customerId: string, id = PHONE_ID, display = '972500000888') =>
    state.numbers.set(id, { id, phone_number_id: id, customer_id: customerId, business_account_id: WABA, display_phone_number: `+${display}`, display_phone_number_normalized: display, verified_name: 'כלי חרס של נורית', is_coexistence: true, status: 'CONNECTED', quality_rating: 'GREEN' });
  return { f, calls, state, number };
}

async function shop() {
  const s = await serve();
  Object.assign(s.app.env, { TORAN_WA_PROVIDER: 'kapso', KAPSO_API_KEY: KEY, KAPSO_WEBHOOK_SECRET: HOOK, KAPSO_EVENTS_SECRET: EVENTS, PUBLIC_BASE_URL: 'https://toran.test' });
  const k = fakeKapso();
  s.app.graph = k.f;
  const a = s.seeded.storeId;
  await s.app.db.query('UPDATE stores SET workspace_id = 1 WHERE id = $1', [a]);
  s.as(s.accounts.session(customer(1)).cookie);
  return { s, a, k };
}

type S = Awaited<ReturnType<typeof serve>>;
const customerOf = async (s: S, storeId: number) => (await s.app.db.one<{ customer_id: string }>('SELECT customer_id FROM kapso_customers WHERE store_id = $1', [storeId]))?.customer_id;
const start = async (s: S, a: number) => s.post(`/lead/${a}/whatsapp/kapso/start`, { _csrf: await s.csrf(`/lead/${a}/whatsapp`) });
const signed = (s: S, path: string, body: unknown, secret: string, headers: Record<string, string> = {}) => {
  const raw = JSON.stringify(body);
  return fetch(`${s.base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-webhook-signature': kapsoSign(secret, raw), ...headers }, body: raw });
};

let seq = 0;
const message = (text: string, phoneId = PHONE_ID, from = CUSTOMER) => ({ object: 'whatsapp_business_account', entry: [{ id: WABA, changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: phoneId, display_phone_number: '972500000888' }, contacts: [{ wa_id: from, profile: { name: 'דנה' } }], messages: [{ from, id: `wamid.kin-${seq++}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }] } }] }] });
const echo = (text: string, to = CUSTOMER) => ({ object: 'whatsapp_business_account', entry: [{ id: WABA, changes: [{ field: 'smb_message_echoes', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: PHONE_ID }, message_echoes: [{ from: '972500000888', to, id: `wamid.kecho-${seq++}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }] } }] }] });

test('the provider switch: Meta unless TORAN_WA_PROVIDER says kapso, and Kapso is ready only with its key, a webhook secret and an https base', () => {
  assert.equal(waProvider({}), 'meta');
  assert.equal(waProvider({ TORAN_WA_PROVIDER: 'Kapso' }), 'kapso');
  const env = { TORAN_WA_PROVIDER: 'kapso', KAPSO_API_KEY: KEY, KAPSO_WEBHOOK_SECRET: HOOK, PUBLIC_BASE_URL: 'https://toran.test' };
  assert.equal(storeConnectReady(env), true);
  assert.equal(storeConnectReady({ ...env, PUBLIC_BASE_URL: 'http://localhost:4710' }), false, 'Kapso comes back over https only');
  assert.equal(storeConnectReady({ ...env, KAPSO_WEBHOOK_SECRET: 'short' }), false);
  assert.equal(storeConnectReady(env, true), false, 'our company store connects on Meta, whose settings are not here');
  const raw = '{"a":1}';
  assert.equal(kapsoSignatureOk(HOOK, raw, kapsoSign(HOOK, raw)), true);
  assert.equal(kapsoSignatureOk(HOOK, raw, kapsoSign('another-secret-0123456789', raw)), false);
  assert.equal(kapsoSignatureOk(HOOK, `${raw} `, kapsoSign(HOOK, raw)), false, 'the raw body is what is signed');
  assert.equal(kapsoSignatureOk(HOOK, raw, undefined), false);
});

test('connecting through Kapso: one customer per store, a setup link with coexistence and the store paying Meta, the number taken only when Kapso lists it under the store, and our webhook put on it', async () => {
  const { s, a, k } = await shop();
  try {
    const res = await s.get(`/lead/${a}/whatsapp`);
    const html = await res.text();
    assert.match(html, /עמוד החיבור של Kapso/);
    assert.match(html, new RegExp(`action="/lead/${a}/whatsapp/kapso/start"`));
    assert.ok(!html.includes('wa-connect.js'), 'no Meta SDK on a Kapso page');
    assert.match(String(res.headers.get('content-security-policy')), /form-action 'self' https:\/\/app\.kapso\.ai/);

    const go = await start(s, a);
    assert.equal(go.status, 303);
    assert.match(String(go.headers.get('location')), /^https:\/\/app\.kapso\.ai\/whatsapp\/setup\/tok1$/);
    const made = k.calls.find((c) => c.path === '/platform/v1/customers')!;
    assert.equal(made.body.customer.external_customer_id, `toran-store-${a}`);
    const link = k.calls.find((c) => /setup_links$/.test(c.path))!.body.setup_link;
    assert.deepEqual(link.allowed_connection_types, ['coexistence', 'dedicated']);
    assert.equal(link.meta_billing_mode, 'customer_managed');
    assert.equal(link.success_redirect_url, `https://toran.test/lead/${a}/whatsapp/kapso`);
    assert.equal(link.failure_redirect_url, `https://toran.test/lead/${a}/whatsapp?kapso=failed`);
    await start(s, a);
    assert.equal(k.calls.filter((c) => c.path === '/platform/v1/customers').length, 1, 'the store is one customer, made once');

    // Back from Kapso with a number Kapso does not list under this store: refused, nothing kept.
    k.number('99999999-0000-4000-8000-000000000000');
    const forged = await (await s.get(`/lead/${a}/whatsapp/kapso?phone_number_id=${PHONE_ID}`)).text();
    assert.match(forged, /החיבור לא הושלם/);
    assert.equal(await s.app.db.one("SELECT 1 FROM channel_accounts WHERE external_id = $1", [PHONE_ID]), null);

    // Kapso lists it under the store's customer: connected, active, coexistence, and our Meta-format webhook on it.
    k.number((await customerOf(s, a))!);
    const done = await (await s.get(`/lead/${a}/whatsapp/kapso?phone_number_id=${PHONE_ID}`)).text();
    assert.match(done, /הוואטסאפ מחובר/);
    const row = await s.app.db.one<any>("SELECT kind, status, secret, meta FROM channel_accounts WHERE external_id = $1", [PHONE_ID]);
    assert.deepEqual({ kind: row.kind, status: row.status, secret: row.secret }, { kind: 'kapso', status: 'active', secret: null });
    assert.equal(row.meta.connection_type, 'coexistence');
    assert.equal(row.meta.waba_id, WABA);
    assert.equal(row.meta.display_phone_number, '972500000888');
    assert.deepEqual(k.state.webhooks.map((w) => ({ kind: w.kind, url: w.url, secret: w.secret_key, active: w.active })), [{ kind: 'meta', url: 'https://toran.test/kapso/webhook', secret: HOOK, active: true }]);
    assert.ok(k.calls.every((c) => c.key === KEY && !c.auth), 'every call with our project key, never a Meta token');

    // Connected again (a refresh, or after a disconnect): the one Meta webhook is updated, not a second made.
    await s.get(`/lead/${a}/whatsapp/kapso?phone_number_id=${PHONE_ID}`);
    assert.equal(k.state.webhooks.length, 1);
    assert.ok(k.calls.some((c) => c.method === 'PATCH'));
    assert.match(await (await s.get('/')).text(), /מחובר, <bdi class="ltr">\+972500000888<\/bdi>/);
  } finally {
    await s.close();
  }
});

test('through Kapso a customer is answered as on Meta: signed webhooks only, the reply through Kapso\'s proxy with our key, the owner\'s answer from the phone pauses Toran, and another number\'s messages are dropped', async () => {
  const { s, a, k } = await shop();
  try {
    await start(s, a);
    k.number((await customerOf(s, a))!);
    await s.get(`/lead/${a}/whatsapp/kapso?phone_number_id=${PHONE_ID}`);

    // Unsigned, or signed with another secret: refused, nothing queued.
    const raw = JSON.stringify(message('שלום'));
    assert.equal((await fetch(`${s.base}/kapso/webhook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw })).status, 401);
    assert.equal((await signed(s, '/kapso/webhook', message('שלום'), 'not-the-secret-0123456789')).status, 401);
    assert.equal(await s.app.db.one("SELECT 1 FROM jobs WHERE kind = 'wa_inbound'"), null);

    const before = k.state.sent;
    assert.equal((await signed(s, '/kapso/webhook', message('יש לכם ספלים בכחול?'), HOOK, { 'x-idempotency-key': 'idem-1' })).status, 200);
    await drain(s.app);
    const conv = await s.app.db.one<any>("SELECT c.id FROM conversations c JOIN channel_accounts a ON a.id = c.account_id WHERE a.external_id = $1", [PHONE_ID]);
    assert.ok(conv, 'the conversation is the store\'s number\'s');
    const sends = k.calls.filter((c) => c.path === `/meta/whatsapp/v24.0/${PHONE_ID}/messages`);
    assert.equal(k.state.sent - before, 1);
    assert.equal(sends[0].key, KEY, 'sent with our Kapso key');
    assert.equal(sends[0].auth, null, 'no Meta token');
    assert.equal(sends[0].body.to, CUSTOMER);
    assert.equal(sends[0].body.messaging_product, 'whatsapp', 'the Cloud API\'s own body');

    // The same delivery again (Kapso retries): one message.
    await signed(s, '/kapso/webhook', message('יש לכם ספלים בכחול?'), HOOK);
    const n = (await s.app.db.one<any>('SELECT COUNT(*)::int AS n FROM messages WHERE conversation_id = $1', [conv.id])).n;

    // The owner answers from the WhatsApp Business app: in the inbox, and Toran steps back.
    await signed(s, '/kapso/webhook', echo('אבדוק ואחזור אלייך'), HOOK);
    await drain(s.app);
    const owner = await s.app.db.one<any>("SELECT text, author FROM messages WHERE conversation_id = $1 AND role = 'owner' ORDER BY id DESC LIMIT 1", [conv.id]);
    assert.deepEqual(owner, { text: 'אבדוק ואחזור אלייך', author: 'מהטלפון' });
    const sent = k.state.sent;
    await signed(s, '/kapso/webhook', message('תודה!'), HOOK);
    await drain(s.app);
    assert.equal(k.state.sent, sent, 'paused: the owner has it');
    assert.ok(n >= 2);

    // A number not connected through Kapso (here, any other id): Kapso's webhook does not speak for it.
    await signed(s, '/kapso/webhook', message('מספר אחר', '700000000000001'), HOOK);
    assert.equal(await s.app.db.one("SELECT 1 FROM jobs WHERE kind = 'wa_inbound' AND payload->>'account' = '700000000000001'"), null);

    // The store's templates go to its WABA through Kapso's proxy too.
    const t = await submitTemplates(s.app, a, 'test');
    assert.ok(t.sent > 0);
    assert.ok(k.calls.some((c) => c.path === `/meta/whatsapp/v24.0/${WABA}/message_templates` && c.key === KEY));
  } finally {
    await s.close();
  }
});

test('Kapso\'s project events: a number connected through a link the store closed early is taken, Meta taking access away asks to connect again, deleted is off; signed with the events secret only', async () => {
  const { s, a, k } = await shop();
  try {
    await start(s, a);
    const cust = (await customerOf(s, a))!;
    k.number(cust);
    const created = { phone_number_id: PHONE_ID, project: { id: 'p' }, customer: { id: cust } };
    assert.equal((await signed(s, '/kapso/events', created, HOOK, { 'x-webhook-event': 'whatsapp.phone_number.created' })).status, 401, 'not the events secret');
    assert.equal((await signed(s, '/kapso/events', created, EVENTS, { 'x-webhook-event': 'whatsapp.phone_number.created' })).status, 200);
    assert.equal((await s.app.db.one<any>("SELECT status FROM channel_accounts WHERE external_id = $1", [PHONE_ID])).status, 'active');

    await signed(s, '/kapso/events', { phone_number_id: PHONE_ID, customer: { id: cust }, disconnection: { reason: 'primary_inactivity' } }, EVENTS, { 'x-webhook-event': 'whatsapp.phone_number.disconnected' });
    assert.equal((await s.app.db.one<any>("SELECT status FROM channel_accounts WHERE external_id = $1", [PHONE_ID])).status, 'reconnect');
    const page = await (await s.get(`/lead/${a}/whatsapp`)).text();
    assert.match(page, /החיבור של הוואטסאפ לתורן הסתיים/);
    assert.match(page, new RegExp(`action="/lead/${a}/whatsapp/kapso/start"`), 'connect again, through Kapso');

    await signed(s, '/kapso/events', { phone_number_id: PHONE_ID, customer: { id: cust } }, EVENTS, { 'x-webhook-event': 'whatsapp.phone_number.deleted' });
    assert.equal((await s.app.db.one<any>("SELECT status FROM channel_accounts WHERE external_id = $1", [PHONE_ID])).status, 'off');
  } finally {
    await s.close();
  }
});

test('a pending Kapso number is read from Kapso by the worker, and "לנתק" deletes it from our Kapso project', async () => {
  const { s, a, k } = await shop();
  try {
    await start(s, a);
    k.number((await customerOf(s, a))!);
    k.state.numbers.get(PHONE_ID).status = 'PENDING';
    await s.get(`/lead/${a}/whatsapp/kapso?phone_number_id=${PHONE_ID}`);
    const id = (await s.app.db.one<any>("SELECT id, status FROM channel_accounts WHERE external_id = $1", [PHONE_ID]));
    assert.equal(id.status, 'pending');
    await s.app.db.query("UPDATE channel_accounts SET meta = meta || '{\"checked_at\":\"2000-01-01T00:00:00Z\"}'::jsonb WHERE id = $1", [id.id]);
    k.state.numbers.get(PHONE_ID).status = 'CONNECTED';
    await schedule(s.app);
    await drain(s.app, { kinds: ['wa_check'] });
    assert.equal((await s.app.db.one<any>('SELECT status FROM channel_accounts WHERE id = $1', [id.id])).status, 'active');
    assert.ok(!k.calls.some((c) => c.auth), 'nothing asked of Meta');

    assert.equal((await s.post(`/lead/${a}/whatsapp/disconnect`, { _csrf: await s.csrf(`/lead/${a}/whatsapp`) })).status, 303);
    assert.deepEqual(k.state.deleted, [PHONE_ID]);
    assert.equal((await s.app.db.one<any>('SELECT status FROM channel_accounts WHERE id = $1', [id.id])).status, 'off');
  } finally {
    await s.close();
  }
});

test('isolation: another workspace cannot connect, finish or disconnect a store\'s Kapso number, and a number Kapso lists under one store is never taken for another', async () => {
  const { s, a, k } = await shop();
  try {
    const b = (await s.app.db.one<{ id: number }>("INSERT INTO stores (domain, url, name, platform, source, workspace_id) VALUES ('other-shop.example', 'https://other-shop.example/', 'חנות אחרת', 'shopify', 'seed', 2) RETURNING id"))!.id;
    await start(s, a);
    k.number((await customerOf(s, a))!);
    // Workspace 2: store a's pages are not there.
    s.as(s.accounts.session(customer(2)).cookie);
    assert.equal((await s.get(`/lead/${a}/whatsapp/kapso?phone_number_id=${PHONE_ID}`)).status, 404);
    assert.equal((await s.post(`/lead/${a}/whatsapp/kapso/start`, { _csrf: await s.csrf(`/lead/${b}/whatsapp`) })).status, 404);
    assert.equal((await s.post(`/lead/${a}/whatsapp/disconnect`, { _csrf: await s.csrf(`/lead/${b}/whatsapp`) })).status, 404);
    // Its own store, with store a's number in the query: Kapso lists it under a's customer, so it is refused.
    await start(s, b);
    const page = await (await s.get(`/lead/${b}/whatsapp/kapso?phone_number_id=${PHONE_ID}`)).text();
    assert.match(page, /החיבור לא הושלם/);
    assert.equal(await s.app.db.one("SELECT 1 FROM channel_accounts WHERE external_id = $1", [PHONE_ID]), null);
    // Store a takes it; then b can never have it, even if Kapso were to list it under b.
    s.as(s.accounts.session(customer(1)).cookie);
    await s.get(`/lead/${a}/whatsapp/kapso?phone_number_id=${PHONE_ID}`);
    k.number((await customerOf(s, b))!);
    s.as(s.accounts.session(customer(2)).cookie);
    assert.match(await (await s.get(`/lead/${b}/whatsapp/kapso?phone_number_id=${PHONE_ID}`)).text(), /המספר הזה כבר מחובר לחנות אחרת/);
    assert.equal((await s.app.db.one<any>("SELECT store_id FROM channel_accounts WHERE external_id = $1", [PHONE_ID])).store_id, a);
  } finally {
    await s.close();
  }
});

test('our own numbers stay on Meta: our company store connects with Meta\'s window, never through Kapso, and none of our numbers can be taken by a store through Kapso', async () => {
  const { s, a, k } = await shop();
  try {
    await s.app.db.query("UPDATE stores SET platform = 'company' WHERE id = $1", [a]);
    s.login();
    const page = await (await s.get(`/lead/${a}/whatsapp`)).text();
    assert.ok(!page.includes('/whatsapp/kapso/start'), 'no Kapso button on our company store');
    await assert.rejects(startKapsoConnect(s.app, a, 'test'), (e: any) => e instanceof KapsoError && /זה המספר של OpenFrequency/.test(e.he));
    assert.equal(k.calls.length, 0, 'nothing asked of Kapso');

    // A store whose Kapso link connected our demo number: refused.
    await s.app.db.query("UPDATE stores SET platform = 'shopify' WHERE id = $1", [a]);
    s.app.env.META_DEMO_PHONE_ID = PHONE_ID;
    await start(s, a);
    k.number((await customerOf(s, a))!);
    assert.match(await (await s.get(`/lead/${a}/whatsapp/kapso?phone_number_id=${PHONE_ID}`)).text(), /זה המספר של OpenFrequency/);
    assert.equal(await s.app.db.one("SELECT 1 FROM channel_accounts WHERE external_id = $1 AND kind = 'kapso'", [PHONE_ID]), null);
  } finally {
    await s.close();
  }
});

test("a stopped store's Kapso number is disconnected three days after the stop; one Kapso refuses stays on and is tried again", async () => {
  const { retention, DISCONNECT_DAYS } = await import('../src/jobs/retention.ts');
  const { s, a, k } = await shop();
  try {
    s.app.env.TORAN_ALERT_COMMAND = '';
    await s.app.db.query("INSERT INTO channel_accounts (store_id, channel, kind, external_id, name, status) VALUES ($1, 'whatsapp', 'kapso', $2, 'כלי חרס', 'active')", [a, PHONE_ID]);
    // Stopped two days ago: not yet.
    await s.app.db.query("UPDATE stores SET service_stopped_at = now() - interval '2 days', service_stopped_why = 'plan' WHERE id = $1", [a]);
    await retention(s.app);
    assert.deepEqual(k.state.deleted, [], `kept for ${DISCONNECT_DAYS} days`);

    // Four days: Kapso refuses the delete once. The number stays on here, and the next pass removes it.
    await s.app.db.query("UPDATE stores SET service_stopped_at = now() - interval '4 days' WHERE id = $1", [a]);
    const real = s.app.graph!;
    s.app.graph = (async (input: any, init: any = {}) => (String(init.method) === 'DELETE' ? new Response(JSON.stringify({ error: { message: 'busy' } }), { status: 500, headers: { 'content-type': 'application/json' } }) : real(input, init))) as typeof fetch;
    const first = await retention(s.app);
    assert.equal(first.disconnectFailed, 1);
    assert.equal((await s.app.db.one<any>("SELECT status FROM channel_accounts WHERE kind = 'kapso'"))!.status, 'active', 'still on, to be tried again');
    s.app.graph = real;
    const second = await retention(s.app);
    assert.equal(second.disconnected, 1);
    assert.deepEqual(k.state.deleted, [PHONE_ID]);
    assert.equal((await s.app.db.one<any>("SELECT status FROM channel_accounts WHERE kind = 'kapso'"))!.status, 'off');
    assert.ok(await s.app.db.one("SELECT 1 FROM audit WHERE action = 'whatsapp_disconnect' AND actor = 'retention'"));
  } finally {
    await s.close();
  }
});
