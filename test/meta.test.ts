import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { open, seal, SecretError } from '../src/core/secrets.ts';
import { parseWebhook, signBody, signatureOk } from '../src/channels/meta.ts';
import { checkToken } from '../src/channels/waStore.ts';
import { ownerReply, replyState } from '../src/channels/owner.ts';
import { simEmail } from '../src/channels/email.ts';
import { queue } from '../src/ops/queue.ts';
import { markReconnectTold } from '../src/ops/actions.ts';
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

const BUSINESS = '700600500400300';
const DAY_S = 86_400;
const nowS = () => Math.floor(Date.now() / 1000);
const SCOPES = ['whatsapp_business_management', 'whatsapp_business_messaging'];

type Tok = { expires: number; valid: boolean; scopes: string[] };

/**
 * Meta's Graph API, as much of it as Toran uses. `status` is what the number reports; `tokens` is what debug_token
 * says about each token Meta gave (expires 0: never), and a token that is not valid, or past its end, is refused (190)
 * everywhere, as Meta does. `refresh` and `lasting` are whether Meta allows each way of renewing one; `sendError` makes
 * every send fail with that code.
 */
function fakeGraph() {
  const calls: Call[] = [];
  const tokens = new Map<string, Tok>([[TOKEN, { expires: 0, valid: true, scopes: SCOPES }]]);
  const state = { status: 'CONNECTED', sent: 0, n: 0, refresh: true, lasting: false, sendError: 0 };
  const live = (t: Tok | undefined) => Boolean(t?.valid && (t.expires === 0 || t.expires > nowS()));
  const f = (async (input: any, init: any = {}) => {
    const u = new URL(String(input));
    const method = String(init.method || 'GET');
    const path = u.pathname.replace(/^\/v\d+\.\d+\//, '');
    const body = init.body ? JSON.parse(String(init.body)) : null;
    const auth = (init.headers as any)?.authorization || null;
    calls.push({ method, path, auth, body });
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
    if (path === 'oauth/access_token' && u.searchParams.get('grant_type') === 'fb_exchange_token') {
      const old = tokens.get(u.searchParams.get('fb_exchange_token') || '');
      if (!state.refresh || !live(old) || u.searchParams.get('client_secret') !== APP_SECRET || u.searchParams.get('set_token_expires_in_60_days') !== 'true') return json({ error: { message: 'cannot refresh this token', code: 100 } }, 400);
      const t = `refreshed-token-${++state.n}`;
      tokens.set(t, { expires: nowS() + 60 * DAY_S, valid: true, scopes: old!.scopes });
      return json({ access_token: t, token_type: 'bearer', expires_in: 60 * DAY_S });
    }
    if (path === 'oauth/access_token') return u.searchParams.get('code') === 'good-code' && u.searchParams.get('client_secret') === APP_SECRET ? json({ access_token: TOKEN, token_type: 'bearer' }) : json({ error: { message: 'bad code', code: 100 } }, 400);
    if (path === 'debug_token') {
      if (auth !== `Bearer 1234567890|${APP_SECRET}`) return json({ error: { message: 'bad app token', code: 190 } }, 401);
      const t = tokens.get(u.searchParams.get('input_token') || '');
      const bm = t?.scopes.includes('business_management') ? [{ scope: 'business_management', target_ids: [BUSINESS] }] : [];
      return json({ data: t ? { app_id: '1234567890', type: 'SYSTEM_USER', is_valid: live(t), issued_at: nowS() - DAY_S, expires_at: t.expires, data_access_expires_at: 0, scopes: t.scopes, granular_scopes: bm } : { is_valid: false, expires_at: 0, scopes: [] } });
    }
    const bearer = String(auth || '').replace(/^Bearer /, '');
    if (!live(tokens.get(bearer))) return json({ error: { message: 'Error validating access token', code: 190 } }, 401);
    if (path === `${BUSINESS}/system_user_access_tokens` && method === 'POST') {
      if (!state.lasting || u.searchParams.get('appsecret_proof') !== createHmac('sha256', APP_SECRET).update(bearer).digest('hex')) return json({ error: { message: 'not allowed', code: 200 } }, 403);
      const t = `lasting-token-${++state.n}`;
      tokens.set(t, { expires: 0, valid: true, scopes: tokens.get(bearer)!.scopes });
      return json({ access_token: t });
    }
    if (path === `${WABA}/subscribed_apps`) return json({ success: true });
    if (path === PHONE_ID && method === 'GET') return json({ display_phone_number: '+972 50-000-0777', verified_name: 'כלי חרס של נורית', status: state.status, platform_type: 'CLOUD_API', id: PHONE_ID });
    if (path === `${PHONE_ID}/messages` && method === 'POST') {
      if (state.sendError) return json({ error: { message: 'Error validating access token: Session has expired', code: state.sendError } }, 401);
      return json({ messaging_product: 'whatsapp', messages: [{ id: `wamid.out-${++state.sent}` }] });
    }
    return json({ error: { message: `no route ${method} ${path}`, code: 1 } }, 404);
  }) as typeof fetch;
  return { f, calls, state, tokens };
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
    assert.deepEqual(g.calls.map((c) => `${c.method} ${c.path}`), ['GET oauth/access_token', `POST ${WABA}/subscribed_apps`, `GET ${PHONE_ID}`, 'GET debug_token']);

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

const tokenRow = (s: Awaited<ReturnType<typeof serve>>) => s.app.db.one<any>("SELECT id, status, secret, meta, token_issued_at, token_expires_at, token_checked_at FROM channel_accounts WHERE channel = 'whatsapp'");
const DAY_MS = DAY_S * 1000;

test('the token\'s life: read after the connect and daily; one that never expires is left alone; one ending within 20 days gets 60 more, or one that never expires when Meta allows', async () => {
  const { s, a, g } = await shop();
  try {
    assert.equal((await (await connect(s, a)).json()).ok, true);
    let row = await tokenRow(s);
    assert.equal(row.token_expires_at, null, 'Meta said 0: it never expires');
    assert.ok(row.token_issued_at && row.token_checked_at);
    assert.deepEqual(row.meta.token_scopes, SCOPES);
    assert.equal(row.meta.by_email, 'owner1@example.test', 'who connected, to tell them when it has to be done again');

    // The next day the worker reads it again, and leaves it.
    await s.app.db.query("UPDATE channel_accounts SET token_checked_at = now() - interval '25 hours'");
    g.calls.length = 0;
    await schedule(s.app);
    await drain(s.app, { kinds: ['wa_token'] });
    assert.deepEqual(g.calls.map((c) => c.path), ['debug_token']);
    assert.equal((await tokenRow(s)).secret, row.secret);

    // A 60-day token with 15 days left: Meta's refresh gives 60 more, and the store's messages go out with it.
    g.tokens.get(TOKEN)!.expires = nowS() + 15 * DAY_S;
    assert.deepEqual(await checkToken(s.app, row.id), { status: 'active', renewed: 'refreshed' });
    row = await tokenRow(s);
    assert.equal(open(s.app.env, row.secret), 'refreshed-token-1');
    assert.ok(new Date(row.token_expires_at).getTime() > Date.now() + 59 * DAY_MS);
    assert.ok(await s.app.db.one("SELECT 1 FROM events WHERE kind = 'wa_token_renewed' AND data->>'how' = 'refreshed'"));
    await webhook(s, message('יש לכם קערות?'));
    await drain(s.app);
    assert.equal(g.calls.filter((c) => c.path === `${PHONE_ID}/messages`).at(-1)!.auth, 'Bearer refreshed-token-1');

    // A token that covers the store's business: Meta makes one that never expires from it.
    Object.assign(g.tokens.get('refreshed-token-1')!, { expires: nowS() + 12 * DAY_S, scopes: [...SCOPES, 'business_management'] });
    g.state.lasting = true;
    assert.deepEqual(await checkToken(s.app, row.id), { status: 'active', renewed: 'lasting' });
    row = await tokenRow(s);
    assert.equal(open(s.app.env, row.secret), 'lasting-token-2');
    assert.equal(row.token_expires_at, null);
    assert.ok(g.calls.some((c) => c.method === 'POST' && c.path === `${BUSINESS}/system_user_access_tokens`));
  } finally {
    await s.close();
  }
});

test('a token Meta will not renew: from 10 days before its end the owner (once, by email too) and the operator are asked to connect again; on the end customers\' messages wait for the owner; connecting again turns it back on', async () => {
  const { s, a, g } = await shop();
  try {
    const mail = simEmail({ domain: 'in.toran.test' });
    s.app.mail = mail;
    g.tokens.get(TOKEN)!.expires = nowS() + 8 * DAY_S;
    g.state.refresh = false;
    assert.equal((await (await connect(s, a)).json()).ok, true);
    const id = (await tokenRow(s)).id;
    assert.equal((await checkToken(s.app, id)).status, 'active', 'it still works: Toran answers until the end');
    await checkToken(s.app, id);
    const notices = () => mail.outbox!.filter((m) => m.notice);
    assert.equal(notices().length, 1, 'told once');
    assert.equal(notices()[0].to, 'owner1@example.test');
    assert.match(String(notices()[0].subject), /לחבר מחדש את הוואטסאפ/);
    assert.match(notices()[0].text, new RegExp(`/lead/${a}/whatsapp`));
    assert.match((await tokenRow(s)).meta.renew_error, /refreshed: Meta refused/);

    // The store's own dashboard says it, with the button, and the operator's list has it first.
    const today = await (await s.get('/')).text();
    assert.match(today, /צריך לחבר מחדש את הוואטסאפ עד/);
    assert.match(today, new RegExp(`href="/lead/${a}/whatsapp"[^>]*>.*לחבר מחדש את הוואטסאפ`));
    const page = await (await s.get(`/lead/${a}/whatsapp`)).text();
    assert.match(page, /data-wa-connect[^>]*>.*לחבר מחדש את הוואטסאפ/);
    assert.match(page, /\/static\/wa-connect\.js/);
    let q = await queue(s.app);
    assert.equal(q.items[0].reason, 'reconnect');
    assert.equal(q.items[0].id, String(a));
    assert.match(q.items[0].message!, /לחבר אותו מחדש/);
    assert.ok(await markReconnectTold(s.app, String(a), 'operator'));
    q = await queue(s.app);
    assert.ok(!q.items.some((i) => i.reason === 'reconnect'), '"שלחתי": off the list for three days');

    // The end: Meta says the token is no good. Toran stops answering on the number, and the owner is told.
    g.tokens.get(TOKEN)!.expires = nowS() - 60;
    assert.deepEqual(await checkToken(s.app, id), { status: 'reconnect' });
    assert.equal((await tokenRow(s)).status, 'reconnect');
    assert.equal(notices().length, 2);
    assert.match(String(notices()[1].subject), /הפסיק לענות/);

    // A customer writes: nothing is sent, and the message waits for the owner with a note saying why, once.
    g.calls.length = 0;
    await webhook(s, message('יש משלוח לאילת?'));
    await webhook(s, message('הלו?'));
    await drain(s.app);
    assert.equal(g.calls.filter((c) => c.path === `${PHONE_ID}/messages`).length, 0);
    const conv = (await s.app.db.one<any>('SELECT c.id FROM conversations c WHERE c.account_id = $1', [id])).id;
    const msgs = await s.app.db.query<any>('SELECT role, text, handoff FROM messages WHERE conversation_id = $1 ORDER BY id', [conv]);
    assert.deepEqual(msgs.filter((m) => m.role === 'customer').map((m) => m.text), ['יש משלוח לאילת?', 'הלו?']);
    assert.equal(msgs.filter((m) => m.handoff?.reason === 'reconnect').length, 1);
    assert.ok(!msgs.some((m) => m.role === 'agent'));
    assert.equal((await replyState(s.app, conv)).reason, 'reconnect');
    assert.deepEqual(await ownerReply(s.app, conv, 'כן, יש', 'owner'), { ok: false, reason: 'reconnect' });
    assert.match(await (await s.get('/')).text(), /תורן לא עונה בוואטסאפ של החנות/);
    assert.match(await (await s.get(`/chat/${conv}`)).text(), /החיבור של הוואטסאפ לתורן הסתיים/);

    // Connecting again on the same page: a fresh token that never expires, and Toran answers.
    g.tokens.set(TOKEN, { expires: 0, valid: true, scopes: SCOPES });
    assert.equal((await (await connect(s, a)).json()).ok, true);
    const row = await tokenRow(s);
    assert.deepEqual([row.status, row.token_expires_at, row.meta.notified], ['active', null, undefined]);
    assert.ok(!/לחבר מחדש את הוואטסאפ/.test(await (await s.get('/')).text()));
    await webhook(s, message('ועכשיו?'));
    await drain(s.app);
    assert.equal(g.calls.filter((c) => c.path === `${PHONE_ID}/messages`).length, 1);
  } finally {
    await s.close();
  }
});

test('Meta refusing the token while Toran answers (190) marks the number to connect again, and the message waits for the owner', async () => {
  const { s, a, g } = await shop();
  try {
    assert.equal((await (await connect(s, a)).json()).ok, true);
    g.state.sendError = 190;
    await webhook(s, message('יש לכם צלחות?'));
    await drain(s.app);
    assert.equal((await tokenRow(s)).status, 'reconnect');
    assert.ok(await s.app.db.one("SELECT 1 FROM events WHERE kind = 'wa_reconnect' AND store_id = $1", [a]));
    assert.ok(await s.app.db.one("SELECT 1 FROM messages WHERE role = 'system' AND handoff->>'reason' = 'reconnect'"));
    assert.ok(!(await s.app.db.one("SELECT 1 FROM jobs WHERE kind = 'wa_inbound' AND status = 'failed'")), 'handled, not a failed job retried');
  } finally {
    await s.close();
  }
});
