import { test } from 'node:test';
import assert from 'node:assert/strict';
import { open, seal, SecretError } from '../src/core/secrets.ts';
import { parseWebhook, signBody, signatureOk } from '../src/channels/meta.ts';
import { counted, monthOf } from '../src/plans.ts';
import { drain, schedule } from '../src/jobs/worker.ts';
import { customer } from './helpers.ts';
import { serve } from './serve.ts';

// A store's own WhatsApp number, connected through Meta (channels/meta.ts, waStore.ts, pages/whatsapp.ts), against a
// stand-in for Meta's Graph API. Nothing here reaches Meta.

const APP_SECRET = 'test-app-secret-not-a-real-one';
const PHONE_ID = '100200300400500';
const WABA = '900800700600500';
const CUSTOMER = '972500000321';
const TOKEN = 'test-business-token-for-the-store';

type Call = { method: string; path: string; auth: string | null; body: any };

/** Meta's Graph API, as much of it as Toran uses. `status` is what the number reports. */
function fakeGraph() {
  const calls: Call[] = [];
  const state = { status: 'CONNECTED', sent: 0 };
  const f = (async (input: any, init: any = {}) => {
    const u = new URL(String(input));
    const method = String(init.method || 'GET');
    const path = u.pathname.replace(/^\/v\d+\.\d+\//, '');
    const body = init.body ? JSON.parse(String(init.body)) : null;
    const auth = (init.headers as any)?.authorization || null;
    calls.push({ method, path, auth, body });
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
    if (path === 'oauth/access_token') return u.searchParams.get('code') === 'good-code' && u.searchParams.get('client_secret') === APP_SECRET ? json({ access_token: TOKEN, token_type: 'bearer' }) : json({ error: { message: 'bad code', code: 100 } }, 400);
    if (auth !== `Bearer ${TOKEN}`) return json({ error: { message: 'bad token', code: 190 } }, 401);
    if (path === `${WABA}/subscribed_apps`) return json({ success: true });
    if (path === PHONE_ID && method === 'GET') return json({ display_phone_number: '+972 50-000-0777', verified_name: 'כלי חרס של נורית', status: state.status, platform_type: 'CLOUD_API', id: PHONE_ID });
    if (path === `${PHONE_ID}/messages` && method === 'POST') return json({ messaging_product: 'whatsapp', messages: [{ id: `wamid.out-${++state.sent}` }] });
    return json({ error: { message: `no route ${method} ${path}`, code: 1 } }, 404);
  }) as typeof fetch;
  return { f, calls, state };
}

async function shop() {
  const s = await serve();
  Object.assign(s.app.env, { META_APP_ID: '1234567890', META_APP_SECRET: APP_SECRET, META_WA_CONFIG_ID: '555', META_WEBHOOK_VERIFY_TOKEN: 'verify-me', TORAN_SECRETS_KEY: 'k'.repeat(40) });
  const g = fakeGraph();
  s.app.graph = g.f;
  const a = s.seeded.storeId;
  await s.app.db.query('UPDATE stores SET workspace_id = 1 WHERE id = $1', [a]);
  s.as(s.accounts.session(customer(1)).cookie);
  return { s, a, g };
}

const connect = async (s: Awaited<ReturnType<typeof serve>>, a: number, fields: Record<string, string> = {}) =>
  s.post(`/lead/${a}/whatsapp/connect`, { _csrf: await s.csrf(`/lead/${a}/knowledge`), code: 'good-code', phone_number_id: PHONE_ID, waba_id: WABA, event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING', ...fields }, { 'x-tn-ajax': '1' });

let seq = 0;
const webhook = (s: Awaited<ReturnType<typeof serve>>, body: unknown, secret = APP_SECRET) => {
  const raw = JSON.stringify(body);
  return fetch(`${s.base}/meta/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': signBody(secret, raw) }, body: raw });
};
const message = (text: string, from = CUSTOMER) => ({ object: 'whatsapp_business_account', entry: [{ id: WABA, changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: PHONE_ID, display_phone_number: '972500000777' }, contacts: [{ wa_id: from, profile: { name: 'דנה' } }], messages: [{ from, id: `wamid.in-${seq++}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }] } }] }] });
const echo = (text: string, to = CUSTOMER) => ({ object: 'whatsapp_business_account', entry: [{ id: WABA, changes: [{ field: 'smb_message_echoes', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: PHONE_ID }, message_echoes: [{ from: '972500000777', to, id: `wamid.echo-${seq++}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }] } }] }] });

test('a store\'s token is sealed at rest: it opens with the key, not without it, and nothing is sealed without a key', () => {
  const env = { TORAN_SECRETS_KEY: 'a'.repeat(40) };
  const sealed = seal(env, TOKEN);
  assert.ok(sealed.startsWith('v1.') && !sealed.includes(TOKEN));
  assert.equal(open(env, sealed), TOKEN);
  assert.notEqual(seal(env, TOKEN), sealed, 'a fresh IV each time');
  assert.throws(() => open({ TORAN_SECRETS_KEY: 'b'.repeat(40) }, sealed), SecretError);
  assert.throws(() => seal({}, TOKEN), SecretError);
  assert.throws(() => open(env, `${sealed.slice(0, -4)}AAAA`), SecretError, 'a changed byte does not open');
});

test('Meta\'s webhook: the verify handshake, the signature, and what one call carries', async () => {
  assert.ok(signatureOk(APP_SECRET, '{"a":1}', signBody(APP_SECRET, '{"a":1}')));
  assert.ok(!signatureOk(APP_SECRET, '{"a":2}', signBody(APP_SECRET, '{"a":1}')));
  assert.ok(!signatureOk('', '{}', signBody('', '{}')), 'no app secret, nothing is believed');
  const w = parseWebhook({ object: 'whatsapp_business_account', entry: [{ id: WABA, changes: [
    { field: 'messages', value: { metadata: { phone_number_id: PHONE_ID }, contacts: [{ wa_id: CUSTOMER, profile: { name: 'דנה' } }], messages: [
      { from: CUSTOMER, id: 'm1', type: 'text', text: { body: ' יש במלאי? ' } },
      { from: CUSTOMER, id: 'm2', type: 'image', image: { mime_type: 'image/jpeg', caption: '' } },
      { from: CUSTOMER, id: 'm3', type: 'reaction', reaction: { emoji: '👍' } },
    ], statuses: [{ id: 'wamid.out-1', status: 'failed', recipient_id: CUSTOMER, errors: [{ code: 131047, title: 'Re-engagement message' }] }] } },
    { field: 'smb_message_echoes', value: { metadata: { phone_number_id: PHONE_ID }, message_echoes: [{ from: '972500000777', to: CUSTOMER, id: 'e1', type: 'text', text: { body: 'כן, יש' } }] } },
    { field: 'account_update', value: { event: 'VERIFIED_ACCOUNT' } },
  ] }] });
  assert.deepEqual(w.messages.map((m) => [m.id, m.text, m.account, m.profileName, (m.attachments || []).length]), [['m1', 'יש במלאי?', PHONE_ID, 'דנה', 0], ['m2', '', PHONE_ID, 'דנה', 1]], 'a reaction is no message');
  assert.deepEqual(w.echoes.map((e) => [e.id, e.to, e.text]), [['e1', CUSTOMER, 'כן, יש']]);
  assert.equal(w.statuses[0].error, '131047: Re-engagement message');
  assert.deepEqual(w.accounts, [WABA]);

  const { s } = await shop();
  try {
    assert.equal((await fetch(`${s.base}/meta/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=abc123`)).status, 200);
    assert.equal(await (await fetch(`${s.base}/meta/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=abc123`)).text(), 'abc123');
    assert.equal((await fetch(`${s.base}/meta/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=abc123`)).status, 403);
    assert.equal((await webhook(s, message('x'), 'not-the-secret')).status, 403, 'a forged call is refused');
    assert.equal((await webhook(s, message('x'))).status, 200);
  } finally {
    await s.close();
  }
});

test('connecting: only the WhatsApp Business app number (coexistence), the token sealed, Meta asked to send its messages here', async () => {
  const { s, a, g } = await shop();
  try {
    const page = await s.get(`/lead/${a}/whatsapp`);
    assert.match(String(page.headers.get('content-security-policy')), /script-src 'self' https:\/\/connect\.facebook\.net/);
    const html = await page.text();
    assert.match(html, /WhatsApp Business/);
    assert.match(html, /data-wa-connect data-app-id="1234567890" data-config-id="555"/);
    assert.match(html, /\/static\/wa-connect\.js/);
    assert.ok(!/connect\.facebook\.net/.test(String((await s.get('/settings')).headers.get('content-security-policy'))), 'only this page lets Meta\'s SDK in');

    let r = await (await connect(s, a, { event: 'FINISH' })).json();
    assert.equal(r.ok, false);
    assert.match(r.message, /WhatsApp Business/, 'a new number (no coexistence) is refused, in words');
    assert.equal(g.calls.length, 0, 'nothing was asked of Meta');

    r = await (await connect(s, a)).json();
    assert.equal(r.ok, true, r.message);
    assert.match(r.message, /מחובר/);
    const row = await s.app.db.one<any>("SELECT store_id, kind, external_id, status, secret, meta FROM channel_accounts WHERE channel = 'whatsapp'");
    assert.equal(row.store_id, a);
    assert.equal(row.kind, 'meta');
    assert.equal(row.external_id, PHONE_ID);
    assert.equal(row.status, 'active');
    assert.ok(row.secret.startsWith('v1.') && !row.secret.includes(TOKEN), 'the token is sealed');
    assert.equal(row.meta.waba_id, WABA);
    assert.equal(row.meta.display_phone_number, '972500000777');
    assert.deepEqual(g.calls.map((c) => `${c.method} ${c.path}`), ['GET oauth/access_token', `POST ${WABA}/subscribed_apps`, `GET ${PHONE_ID}`]);

    const settings = await (await s.get('/settings')).text();
    assert.match(settings, /מחובר, <bdi class="ltr">\+972500000777<\/bdi>/);
    // Another store of another workspace cannot take the number.
    const b = (await s.app.db.one<{ id: number }>("SELECT id FROM stores WHERE domain = 'shaked-jewelry.example'"))!.id;
    await s.app.db.query('UPDATE stores SET workspace_id = 2 WHERE id = $1', [b]);
    s.as(s.accounts.session(customer(2)).cookie);
    r = await (await connect(s, b)).json();
    assert.equal(r.ok, false);
    assert.match(r.message, /כבר מחובר לחנות אחרת/);
    assert.equal((await s.post(`/lead/${a}/whatsapp/connect`, { _csrf: await s.csrf('/'), code: 'good-code', phone_number_id: PHONE_ID, waba_id: WABA, event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING' })).status, 404, 'nor connect store A');
  } finally {
    await s.close();
  }
});

test('a customer writes to the store\'s own number: Toran answers through Meta, in the inbox, counted in the plan; the owner answers from the phone and Toran steps back', async () => {
  const { s, a, g } = await shop();
  try {
    assert.equal((await (await connect(s, a)).json()).ok, true);
    g.calls.length = 0;
    assert.equal((await webhook(s, message('יש לכם ספלים בכחול?'))).status, 200);
    await drain(s.app);
    const conv = await s.app.db.one<any>("SELECT c.id, c.account_id, c.channel FROM conversations c JOIN channel_accounts a ON a.id = c.account_id WHERE a.external_id = $1", [PHONE_ID]);
    assert.ok(conv, 'the conversation belongs to the store\'s number');
    const sent = g.calls.filter((c) => c.path === `${PHONE_ID}/messages`);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].auth, `Bearer ${TOKEN}`, 'sent with the store\'s own token');
    assert.equal(sent[0].body.to, CUSTOMER);
    assert.ok(sent[0].body.text.body.length > 0);
    assert.ok(!/DEMO|דמו של תורן/.test(sent[0].body.text.body), 'no demo footer on the store\'s own number');
    assert.equal((await counted(s.app.db, [a])).get(a)!.get(monthOf()), 1);
    const list = await (await s.get('/chats')).text();
    assert.match(list, new RegExp(`/chat/${conv.id}"`));
    const row = new RegExp(`<a href="/chat/${conv.id}">(.*?)</a>`, 's').exec(list)![1];
    assert.ok(!/דמו/.test(row), 'not tagged as the demo');

    // The owner answers from the dashboard: it goes out from the store's number too.
    assert.equal((await s.post(`/chat/${conv.id}/reply`, { _csrf: await s.csrf(`/chat/${conv.id}`), text: 'כן, יש בכחול. נורית' })).status, 303);
    assert.equal(g.calls.filter((c) => c.path === `${PHONE_ID}/messages`).at(-1)!.body.text.body, 'כן, יש בכחול. נורית');
    await s.app.db.query('UPDATE conversations SET agent_paused_until = NULL WHERE id = $1', [conv.id]);

    // The owner answers from the WhatsApp Business app on the phone: in the inbox, and Toran steps back.
    assert.equal((await webhook(s, echo('אני אבדוק ואחזור אלייך'))).status, 200);
    await drain(s.app);
    const owner = await s.app.db.one<any>("SELECT text, author FROM messages WHERE conversation_id = $1 AND role = 'owner' ORDER BY id DESC LIMIT 1", [conv.id]);
    assert.deepEqual(owner, { text: 'אני אבדוק ואחזור אלייך', author: 'מהטלפון' });
    const before = g.calls.filter((c) => c.path === `${PHONE_ID}/messages`).length;
    await webhook(s, message('תודה!'));
    await drain(s.app);
    assert.equal(g.calls.filter((c) => c.path === `${PHONE_ID}/messages`).length, before, 'paused: the owner has it');
    assert.match(await (await s.get(`/chat/${conv.id}`)).text(), /תודה!/);
  } finally {
    await s.close();
  }
});

test('waiting for Meta: the dashboard says so, the worker checks again, and the store turns on by itself', async () => {
  const { s, a, g } = await shop();
  try {
    g.state.status = 'PENDING';
    const r = await (await connect(s, a)).json();
    assert.equal(r.ok, true);
    assert.match(r.message, /ממתין לאישור של Meta/);
    assert.match(await (await s.get('/')).text(), /ממתין לאישור של Meta/);
    assert.match(await (await s.get(`/lead/${a}/whatsapp`)).text(), /<span class="end chip sig">ממתין לאישור של Meta<\/span>/);
    const id = (await s.app.db.one<any>("SELECT id FROM channel_accounts WHERE channel = 'whatsapp'")).id;
    // Ten minutes later, Meta says CONNECTED.
    await s.app.db.query("UPDATE channel_accounts SET meta = meta || '{\"checked_at\":\"2000-01-01T00:00:00Z\"}'::jsonb WHERE id = $1", [id]);
    g.state.status = 'CONNECTED';
    await schedule(s.app);
    await drain(s.app, { kinds: ['wa_check'] });
    assert.equal((await s.app.db.one<any>('SELECT status FROM channel_accounts WHERE id = $1', [id])).status, 'active');
    assert.ok(await s.app.db.one("SELECT 1 FROM events WHERE kind = 'wa_connected' AND store_id = $1", [a]));

    // Meta stops the number: it shows, and Toran does not answer on it.
    g.state.status = 'BANNED';
    await webhook(s, { object: 'whatsapp_business_account', entry: [{ id: WABA, changes: [{ field: 'account_update', value: { event: 'ACCOUNT_RESTRICTION' } }] }] });
    await drain(s.app, { kinds: ['wa_check'] });
    assert.equal((await s.app.db.one<any>('SELECT status FROM channel_accounts WHERE id = $1', [id])).status, 'error');
    assert.match(await (await s.get('/settings')).text(), /Meta עצרה את המספר/);
  } finally {
    await s.close();
  }
});

test('disconnecting: Meta stops sending, the token is gone, and a message to the number is no longer answered', async () => {
  const { s, a, g } = await shop();
  try {
    assert.equal((await (await connect(s, a)).json()).ok, true);
    assert.equal((await s.post(`/lead/${a}/whatsapp/disconnect`, { _csrf: await s.csrf(`/lead/${a}/whatsapp`) })).status, 303);
    const row = await s.app.db.one<any>("SELECT status, secret FROM channel_accounts WHERE channel = 'whatsapp'");
    assert.deepEqual(row, { status: 'off', secret: null });
    assert.ok(g.calls.some((c) => c.method === 'DELETE' && c.path === `${WABA}/subscribed_apps`));
    const sends = g.calls.filter((c) => c.path === `${PHONE_ID}/messages`).length;
    await webhook(s, message('עדיין פתוחים?'));
    await drain(s.app);
    assert.equal(g.calls.filter((c) => c.path === `${PHONE_ID}/messages`).length, sends);
    assert.equal(s.app.wa.outbox!.filter((m) => m.to === CUSTOMER).length, 0, 'nor through the demo number');
    assert.ok(await s.app.db.one("SELECT 1 FROM events WHERE kind = 'wa_unknown_account'"));
    assert.match(await (await s.get(`/lead/${a}/whatsapp`)).text(), /לחבר את הוואטסאפ של החנות/, 'it can be connected again');
  } finally {
    await s.close();
  }
});

test('without the Meta settings or the secrets key, the page says the connection is not open, and connecting is refused', async () => {
  const { s, a } = await shop();
  try {
    delete s.app.env.TORAN_SECRETS_KEY;
    const html = await (await s.get(`/lead/${a}/whatsapp`)).text();
    assert.match(html, /החיבור עוד לא פתוח/);
    assert.ok(!/data-wa-connect/.test(html));
    const r = await (await connect(s, a)).json();
    assert.equal(r.ok, false);
    assert.equal((await s.app.db.query("SELECT 1 FROM channel_accounts WHERE channel = 'whatsapp'")).length, 0);
  } finally {
    await s.close();
  }
});
