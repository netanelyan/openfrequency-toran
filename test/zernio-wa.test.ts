import { test } from 'node:test';
import assert from 'node:assert/strict';
import { storeConnectReady, waProvider } from '../src/channels/kapso.ts';
import { zernioSign, zernioTemplateSend } from '../src/channels/zernio.ts';
import { submitTemplates } from '../src/auto/templates.ts';
import { drain } from '../src/jobs/worker.ts';
import { customer } from './helpers.ts';
import { serve } from './serve.ts';

// A store's own WhatsApp number connected through Zernio (channels/zernio.ts, TORAN_WA_PROVIDER=zernio; the owner,
// 2026-11-08: "yes, switch to zernio"), against a stand-in for Zernio's API. Nothing here reaches Zernio or Meta.

const KEY = 'sk_zernio_test_key';
const HOOK = 'zernio-webhook-secret-0123456789';
const WA_ACCOUNT = 'b1b2c3d4e5f6a7b8c9d0e1f2';
const OTHER_ACCOUNT = 'f0e1d2c3b4a5968778695a4b';
const CUSTOMER = '972500000141';
const CONV = 'beef0000beef0000beef0000';

type Call = { method: string; path: string; auth: string | null; body: any };

/** Zernio, as much of it as a store's WhatsApp uses: profiles, the connect link, accounts, sending, templates. */
function fakeZernio() {
  const calls: Call[] = [];
  const state = { profiles: new Map<string, string>(), accounts: [] as any[], sent: 0, deleted: [] as string[] };
  let pid = 0;
  const f = (async (input: any, init: any = {}) => {
    const u = new URL(String(input));
    const method = String(init.method || 'GET');
    const body = init.body ? JSON.parse(String(init.body)) : null;
    const h = (init.headers || {}) as Record<string, string>;
    calls.push({ method, path: u.pathname + u.search, auth: h.authorization || null, body });
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
    if (u.hostname !== 'zernio.com') return json({ error: `not Zernio: ${u.hostname}` }, 404);
    if (h.authorization !== `Bearer ${KEY}`) return json({ error: 'Unauthorized' }, 401);
    const p = u.pathname.replace(/^\/api\/v1/, '');
    if (p === '/profiles' && method === 'GET') {
      const id = state.profiles.get(u.searchParams.get('externalId') || '');
      return json({ profiles: id ? [{ _id: id }] : [] });
    }
    if (p === '/profiles' && method === 'POST') {
      const id = (++pid).toString(16).padStart(24, '0');
      state.profiles.set(body.externalId, id);
      return json({ profile: { _id: id } }, 201);
    }
    if (p === '/connect/whatsapp' && method === 'GET') return json({ authUrl: 'https://zernio.com/connect/whatsapp/hosted?t=abc' });
    if (p === '/accounts' && method === 'GET') return json({ accounts: state.accounts.filter((a) => a.profileId === u.searchParams.get('profileId') && a.platform === u.searchParams.get('platform')) });
    const del = /^\/accounts\/([0-9a-f]{24})$/.exec(p);
    if (del && method === 'DELETE') {
      state.deleted.push(del[1]);
      return json({ message: 'Account disconnected' });
    }
    const send = /^\/inbox\/conversations\/([0-9a-f]{24})\/messages$/.exec(p);
    if (send && method === 'POST') {
      state.sent++;
      return json({ success: true, data: { messageId: `wamid.out-${state.sent}`, conversationId: send[1] } });
    }
    if (p === '/inbox/conversations' && method === 'POST') return json({ success: true, data: { messageId: 'wamid.tpl-1', conversationId: CONV } }, 201);
    if (p === '/whatsapp/templates' && method === 'POST') return json({ success: true, template: { id: `t-${body.name}`, name: body.name, status: 'PENDING', category: body.category, language: body.language } });
    if (p === '/whatsapp/templates' && method === 'GET') return json({ success: true, templates: [] });
    return json({ error: `no route ${method} ${p}` }, 404);
  }) as typeof fetch;
  /** A WhatsApp number connected at Zernio under a profile. */
  const account = (profileId: string, phone = '972500000142', id = WA_ACCOUNT) =>
    state.accounts.push({ _id: id, platform: 'whatsapp', profileId, username: `+${phone}`, displayName: 'כלי חרס של נורית', metadata: { displayPhoneNumber: `+${phone}`, wabaId: '1029384756', phoneNumberId: '5550001112', verifiedName: 'כלי חרס של נורית', qualityRating: 'GREEN' } });
  return { f, calls, state, account };
}

async function shop() {
  const s = await serve();
  Object.assign(s.app.env, { TORAN_WA_PROVIDER: 'zernio', ZERNIO_API_KEY: KEY, ZERNIO_WEBHOOK_SECRET: HOOK, PUBLIC_BASE_URL: 'https://toran.test', TORAN_CHANNELS: 'whatsapp,email' });
  const z = fakeZernio();
  s.app.graph = z.f;
  const a = s.seeded.storeId;
  await s.app.db.query('UPDATE stores SET workspace_id = 1 WHERE id = $1', [a]);
  s.as(s.accounts.session(customer(1)).cookie);
  return { s, a, z };
}

type S = Awaited<ReturnType<typeof serve>>;
const profileOf = async (s: S, storeId: number) => (await s.app.db.one<{ profile_id: string }>('SELECT profile_id FROM zernio_profiles WHERE store_id = $1', [storeId]))?.profile_id;
const start = async (s: S, a: number) => s.post(`/lead/${a}/whatsapp/zernio/start`, { _csrf: await s.csrf(`/lead/${a}/whatsapp`) });
const signed = (s: S, body: unknown) => {
  const raw = JSON.stringify(body);
  return fetch(`${s.base}/zernio/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-zernio-signature': zernioSign(HOOK, raw), 'x-zernio-event-id': String((body as any).id) }, body: raw });
};

let seq = 0;
const account = { id: WA_ACCOUNT, accountId: WA_ACCOUNT, profileId: 'p', platform: 'whatsapp', username: '+972500000142' };
const received = (storeId: number, text: string) => ({
  id: `evt-${seq++}`,
  event: 'message.received',
  message: { id: `m${seq}`, conversationId: CONV, platform: 'whatsapp', platformMessageId: `wamid.in-${seq}`, direction: 'incoming', text, attachments: [], sender: { id: CUSTOMER, name: 'דנה', phoneNumber: `+${CUSTOMER}` }, sentAt: new Date().toISOString(), isRead: false },
  conversation: { id: CONV, participantId: CUSTOMER, participantName: 'דנה', status: 'active' },
  account,
  profiles: [{ id: 'p', externalId: `toran-store-${storeId}` }],
  timestamp: new Date().toISOString(),
});
const sent = (storeId: number, text: string, source: string, sentAt = new Date()) => ({
  id: `evt-${seq++}`,
  event: 'message.sent',
  message: { id: `m${seq}`, conversationId: CONV, platform: 'whatsapp', platformMessageId: `wamid.echo-${seq}`, direction: 'outgoing', text, attachments: [], sender: { id: WA_ACCOUNT }, sentAt: sentAt.toISOString(), isRead: true, source, sentVia: source === 'cloud_api' ? 'api' : null },
  conversation: { id: CONV, participantId: CUSTOMER, participantName: 'דנה', status: 'active' },
  account,
  profiles: [{ id: 'p', externalId: `toran-store-${storeId}` }],
  timestamp: new Date().toISOString(),
});

test('the WhatsApp provider switch: zernio, kapso or meta (unset: meta); Zernio is ready with its key, a 16+ secret and an https base; our company store is always Meta\'s', () => {
  assert.equal(waProvider({}), 'meta');
  assert.equal(waProvider({ TORAN_WA_PROVIDER: 'Zernio' }), 'zernio');
  assert.equal(waProvider({ TORAN_WA_PROVIDER: 'kapso' }), 'kapso');
  const env = { TORAN_WA_PROVIDER: 'zernio', ZERNIO_API_KEY: KEY, ZERNIO_WEBHOOK_SECRET: HOOK, PUBLIC_BASE_URL: 'https://toran.test' };
  assert.equal(storeConnectReady(env), true);
  assert.equal(storeConnectReady({ ...env, ZERNIO_WEBHOOK_SECRET: 'short' }), false);
  assert.equal(storeConnectReady({ ...env, PUBLIC_BASE_URL: 'http://localhost:4710' }), false);
  assert.equal(storeConnectReady(env, true), false, 'the company store connects on Meta, whose settings are not set here');
});

test('connecting WhatsApp through Zernio: coexistence on Zernio\'s hosted page and its own app, no scopes; the number taken only when Zernio lists it under the store\'s profile, never one of ours; disconnecting removes it at Zernio', async () => {
  const { s, a, z } = await shop();
  try {
    const page = await s.get(`/lead/${a}/whatsapp`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Zernio/, 'the store is told who connects it');
    assert.match(html, new RegExp(`action="/lead/${a}/whatsapp/zernio/start"`));
    assert.match(String(page.headers.get('content-security-policy')), /form-action 'self'[^;]*https:\/\/zernio\.com/);
    const go = await start(s, a);
    assert.equal(go.status, 303);
    assert.match(String(go.headers.get('location')), /^https:\/\/zernio\.com\//);
    const q = new URL(`https://x${z.calls.find((c) => c.path.startsWith('/api/v1/connect/whatsapp'))!.path}`).searchParams;
    assert.equal(q.get('onboarding'), 'business_app', 'coexistence: the app stays on the phone');
    assert.equal(q.get('signup'), 'hosted');
    assert.equal(q.get('scopes'), null, 'Zernio refuses scopes for WhatsApp');
    assert.equal(q.get('oauthAppId'), null, 'Zernio\'s own app');
    assert.equal(q.get('redirect_url'), `https://toran.test/lead/${a}/whatsapp/zernio`);

    // An account Zernio does not list under this store's profile: refused.
    await s.get(`/lead/${a}/whatsapp/zernio?connected=whatsapp&accountId=${OTHER_ACCOUNT}`);
    assert.equal(await s.app.db.one("SELECT 1 FROM channel_accounts WHERE kind = 'zernio'"), null);

    // Our own demo number, connected through the store's profile: refused.
    z.account((await profileOf(s, a))!, s.app.env.DEMO_WA_NUMBER!, OTHER_ACCOUNT);
    assert.match(await (await s.get(`/lead/${a}/whatsapp/zernio?connected=whatsapp&accountId=${OTHER_ACCOUNT}`)).text(), /החיבור לא הושלם/);
    assert.equal(await s.app.db.one("SELECT 1 FROM channel_accounts WHERE kind = 'zernio'"), null);

    // Zernio's own reason for a connect that did not finish: said in Hebrew.
    assert.match(await (await s.get(`/lead/${a}/whatsapp/zernio?error=whatsapp_coexistence_not_registered&platform=whatsapp`)).text(), /פחות משבוע/);

    z.account((await profileOf(s, a))!);
    const done = await s.get(`/lead/${a}/whatsapp/zernio?connected=whatsapp&accountId=${WA_ACCOUNT}`);
    assert.equal(done.status, 200);
    assert.match(await done.text(), /הוואטסאפ מחובר/);
    const row = await s.app.db.one<any>("SELECT store_id, kind, external_id, status, secret, meta FROM channel_accounts WHERE channel = 'whatsapp' AND kind = 'zernio'");
    assert.deepEqual({ store_id: row.store_id, kind: row.kind, external_id: row.external_id, status: row.status, secret: row.secret }, { store_id: a, kind: 'zernio', external_id: WA_ACCOUNT, status: 'active', secret: null });
    assert.equal(row.meta.display_phone_number, '972500000142');
    assert.equal(row.meta.waba_id, '1029384756');

    const off = await s.post(`/lead/${a}/whatsapp/disconnect`, { _csrf: await s.csrf(`/lead/${a}/whatsapp`) });
    assert.equal(off.status, 303);
    assert.deepEqual(z.state.deleted, [WA_ACCOUNT]);
    assert.equal((await s.app.db.one<any>("SELECT status FROM channel_accounts WHERE kind = 'zernio'")).status, 'off');
  } finally {
    await s.close();
  }
});

test('a new number for Toran alone, without coexistence: folded under the main button, Meta\'s standard window (onboarding=api), kept as no coexistence, and the page says the owner answers from the inbox', async () => {
  const { s, a, z } = await shop();
  try {
    const html = await (await s.get(`/lead/${a}/whatsapp`)).text();
    const fold = html.slice(html.indexOf('<details class="mt16">'));
    assert.match(fold, /אין לכם WhatsApp Business, או שאתם רוצים מספר חדש רק לתורן\?/, 'the second way, folded under the first');
    assert.match(fold, /name="number" value="new"/);
    assert.ok(html.indexOf('לחבר את הוואטסאפ של החנות') < html.indexOf('לחבר מספר חדש לתורן'), 'the number already in use comes first');

    const go = await s.post(`/lead/${a}/whatsapp/zernio/start`, { _csrf: await s.csrf(`/lead/${a}/whatsapp`), number: 'new' });
    assert.equal(go.status, 303);
    const q = new URL(`https://x${z.calls.filter((c) => c.path.startsWith('/api/v1/connect/whatsapp')).at(-1)!.path}`).searchParams;
    assert.equal(q.get('onboarding'), 'api', 'Meta\'s standard window, where a new number gets its code');
    assert.equal(q.get('signup'), 'hosted');
    assert.equal(q.get('redirect_url'), `https://toran.test/lead/${a}/whatsapp/zernio?number=new`);

    assert.match(await (await s.get(`/lead/${a}/whatsapp/zernio?error=whatsapp_number_in_use&platform=whatsapp`)).text(), /עדיין רשום באפליקציית וואטסאפ/);

    z.account((await profileOf(s, a))!);
    const done = await (await s.get(`/lead/${a}/whatsapp/zernio?number=new&connected=whatsapp&accountId=${WA_ACCOUNT}`)).text();
    assert.match(done, /עונים ללקוחות מהשיחות כאן, לא מאפליקציה בטלפון/);
    const row = await s.app.db.one<any>("SELECT meta FROM channel_accounts WHERE channel = 'whatsapp' AND kind = 'zernio'");
    assert.equal(row.meta.coexistence, false);
    const page = await (await s.get(`/lead/${a}/whatsapp`)).text();
    assert.match(page, /מחובר לתורן בלבד, בלי אפליקציה בטלפון/);
    assert.doesNotMatch(page, /כשעונים ללקוח מהטלפון/);

    // The usual way records coexistence, and its page keeps the phone's line.
    const plain = await start(s, a);
    assert.equal(plain.status, 303);
    assert.equal(new URL(`https://x${z.calls.filter((c) => c.path.startsWith('/api/v1/connect/whatsapp')).at(-1)!.path}`).searchParams.get('onboarding'), 'business_app');
  } finally {
    await s.close();
  }
});

test('a WhatsApp customer through Zernio: answered through Zernio\'s inbox with no tag; ours, Meta\'s agent and the app\'s greeting leave Toran answering; the owner on the phone pauses it; a disconnect waits to be connected again', async () => {
  const { s, a, z } = await shop();
  try {
    await start(s, a);
    z.account((await profileOf(s, a))!);
    await s.get(`/lead/${a}/whatsapp/zernio?connected=whatsapp&accountId=${WA_ACCOUNT}`);

    // Another store's profile on our account: dropped.
    assert.equal((await signed(s, received(a + 1000, 'x'))).status, 200);
    assert.equal(await s.app.db.one("SELECT 1 FROM jobs WHERE kind = 'wa_inbound'"), null);

    assert.equal((await signed(s, received(a, 'יש לכם ספלים בכחול?'))).status, 200);
    await drain(s.app);
    const conv = await s.app.db.one<any>("SELECT c.id, c.channel, c.peer FROM conversations c JOIN channel_accounts x ON x.id = c.account_id WHERE x.external_id = $1", [WA_ACCOUNT]);
    assert.deepEqual({ channel: conv.channel, peer: conv.peer }, { channel: 'whatsapp', peer: CUSTOMER }, 'the phone, as on Meta');
    const sends = z.calls.filter((c) => c.method === 'POST' && c.path === `/api/v1/inbox/conversations/${CONV}/messages`);
    assert.equal(sends.length, 1, 'answered once');
    assert.equal(sends[0].body.accountId, WA_ACCOUNT);
    assert.equal(sends[0].body.messageTag, undefined, 'no tag on WhatsApp');

    const count = async () => (await s.app.db.one<any>("SELECT COUNT(*)::int AS n FROM messages WHERE conversation_id = $1 AND role = 'owner'", [conv.id])).n;
    const due = () => s.app.db.query("UPDATE jobs SET run_at = now() WHERE kind = 'zernio_echo' AND status = 'queued'");
    // Ours (cloud_api) and Meta's own agent: not the owner.
    await signed(s, sent(a, 'התשובה של תורן', 'cloud_api'));
    await signed(s, sent(a, 'שלום, כאן העוזר של Meta', 'meta_business_agent'));
    await due();
    await drain(s.app);
    assert.equal(await count(), 0);
    // The app's greeting, seconds after the customer's message: Toran keeps answering.
    const lastIn = await s.app.db.one<any>("SELECT at FROM messages WHERE conversation_id = $1 AND role = 'customer' ORDER BY id DESC LIMIT 1", [conv.id]);
    await signed(s, sent(a, 'תודה שפנית!', 'whatsapp_business_app', new Date(Date.parse(lastIn.at) + 3_000)));
    await due();
    await drain(s.app);
    assert.equal(await count(), 0, 'a greeting is not the owner');
    // The owner answers from the WhatsApp Business app, later: in the inbox, and Toran steps back.
    await signed(s, sent(a, 'אבדוק ואחזור אלייך', 'whatsapp_business_app', new Date(Date.now() + 60_000)));
    await due();
    await drain(s.app);
    const owner = await s.app.db.one<any>("SELECT text, author FROM messages WHERE conversation_id = $1 AND role = 'owner' ORDER BY id DESC LIMIT 1", [conv.id]);
    assert.deepEqual({ ...owner }, { text: 'אבדוק ואחזור אלייך', author: 'מהטלפון' });
    const before = z.state.sent;
    await signed(s, received(a, 'תודה!'));
    await drain(s.app);
    assert.equal(z.state.sent, before, 'Toran waits while the owner has the conversation');

    // Zernio says the number was disconnected: it waits to be connected again.
    await signed(s, { id: `evt-${seq++}`, event: 'account.disconnected', account, profiles: [{ id: 'p', externalId: `toran-store-${a}` }], timestamp: new Date().toISOString() });
    assert.equal((await s.app.db.one<any>("SELECT status FROM channel_accounts WHERE kind = 'zernio'")).status, 'reconnect');
  } finally {
    await s.close();
  }
});

test('a store\'s automatic-message templates through Zernio: submitted with the account\'s id and Meta\'s own body, their review taken from Zernio\'s webhook by the account, and sent to a phone as a new conversation with the button\'s link last', async () => {
  const { s, a, z } = await shop();
  try {
    await start(s, a);
    z.account((await profileOf(s, a))!);
    await s.get(`/lead/${a}/whatsapp/zernio?connected=whatsapp&accountId=${WA_ACCOUNT}`);
    const out = await submitTemplates(s.app, a, 'test');
    assert.ok(out.sent > 0, 'submitted');
    const made = z.calls.filter((c) => c.method === 'POST' && c.path === '/api/v1/whatsapp/templates');
    assert.equal(made.length, out.sent);
    assert.equal(made[0].body.accountId, WA_ACCOUNT);
    assert.equal(made[0].body.language, 'he');
    assert.ok(Array.isArray(made[0].body.components), 'Meta\'s own template body');
    const name = made[0].body.name;
    assert.equal((await s.app.db.one<any>('SELECT status FROM wa_templates WHERE name = $1', [name])).status, 'PENDING');

    // Meta's review, through Zernio's webhook (it may name no profile): matched by the account.
    await signed(s, { id: `evt-${seq++}`, event: 'whatsapp.template.status_updated', account: { accountId: WA_ACCOUNT, profileId: 'p', platform: 'whatsapp', username: '+972500000142' }, template: { templateId: 't1', name, language: 'he', status: 'APPROVED', reason: 'NONE' }, timestamp: new Date().toISOString() });
    assert.equal((await s.app.db.one<any>('SELECT status FROM wa_templates WHERE name = $1', [name])).status, 'APPROVED');

    const wa = (await s.app.db.one<{ id: number; external_id: string }>("SELECT id, external_id FROM channel_accounts WHERE kind = 'zernio'"))!;
    const sentTpl = await zernioTemplateSend(s.app, wa, `+${CUSTOMER}`, name, ['דנה', '1042'], 'tok123');
    assert.equal(sentTpl.id, 'wamid.tpl-1');
    const call = z.calls.find((c) => c.method === 'POST' && c.path === '/api/v1/inbox/conversations')!;
    assert.deepEqual(call.body, { accountId: WA_ACCOUNT, participantId: CUSTOMER, templateName: name, templateLanguage: 'he', templateParams: ['דנה', '1042', 'tok123'] });
    assert.ok(await s.app.db.one('SELECT 1 FROM zernio_threads WHERE account_id = $1 AND peer = $2 AND conversation_id = $3', [wa.id, CUSTOMER, CONV]), 'the thread is kept for the replies');
  } finally {
    await s.close();
  }
});
