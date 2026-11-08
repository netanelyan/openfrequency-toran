import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dmConnectReady, dmProvider, storeOfExternalId, zernioSign, zernioSignatureOk } from '../src/channels/zernio.ts';
import { humanAgentOn } from '../src/channels/policy.ts';
import { drain } from '../src/jobs/worker.ts';
import { customer } from './helpers.ts';
import { serve } from './serve.ts';

// A store's Facebook Page and Instagram account connected through Zernio (channels/zernio.ts, TORAN_DM_PROVIDER=zernio),
// against a stand-in for Zernio's API. Nothing here reaches Zernio or Meta.

const KEY = 'sk_zernio_test_key';
const HOOK = 'zernio-webhook-secret-0123456789';
const IG_ACCOUNT = 'a1b2c3d4e5f6a7b8c9d0e1f2';
const OTHER_ACCOUNT = 'f0e1d2c3b4a5968778695a4b';
const IGSID = '17841400000000001';
const CONV = 'c0ffee00c0ffee00c0ffee00';

type Call = { method: string; path: string; auth: string | null; body: any };

/**
 * Zernio, as much of it as Toran uses: profiles (by externalId), the connect link, a profile's accounts, disconnecting
 * an account, and sending in a conversation. Every call without our key is refused, as Zernio does.
 */
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
      return json({ profiles: id ? [{ _id: id, externalId: u.searchParams.get('externalId') }] : [] });
    }
    if (p === '/profiles' && method === 'POST') {
      if (state.profiles.has(body.externalId)) return json({ error: 'exists', details: { existingProfileId: state.profiles.get(body.externalId) } }, 409);
      const id = (++pid).toString(16).padStart(24, '0');
      state.profiles.set(body.externalId, id);
      return json({ message: 'Profile created successfully', profile: { _id: id, name: body.name, externalId: body.externalId } }, 201);
    }
    const connect = /^\/connect\/(facebook|instagram)$/.exec(p);
    if (connect && method === 'GET') return json({ authUrl: `https://zernio.com/connect/welcome/${connect[1]}?t=abc` });
    if (p === '/accounts' && method === 'GET') {
      const list = state.accounts.filter((a) => a.profileId === u.searchParams.get('profileId') && a.platform === u.searchParams.get('platform'));
      return json({ accounts: list });
    }
    const del = /^\/accounts\/([0-9a-f]{24})$/.exec(p);
    if (del && method === 'DELETE') {
      state.deleted.push(del[1]);
      return json({ message: 'Account disconnected' });
    }
    const send = /^\/inbox\/conversations\/([0-9a-f]{24})\/messages$/.exec(p);
    if (send && method === 'POST') {
      state.sent++;
      return json({ success: true, data: { messageId: `mid.out-${state.sent}`, conversationId: send[1] } });
    }
    return json({ error: `no route ${method} ${p}` }, 404);
  }) as typeof fetch;
  /** An account connected at Zernio under a profile (what a store's login there would make). */
  const account = (profileId: string, id = IG_ACCOUNT, platform = 'instagram', username = 'nurit.ceramics') => state.accounts.push({ _id: id, platform, profileId, username, displayName: 'כלי חרס של נורית', platformUserId: '17841400099' });
  return { f, calls, state, account };
}

async function shop() {
  const s = await serve();
  Object.assign(s.app.env, { TORAN_DM_PROVIDER: 'zernio', ZERNIO_API_KEY: KEY, ZERNIO_WEBHOOK_SECRET: HOOK, PUBLIC_BASE_URL: 'https://toran.test', TORAN_CHANNELS: 'whatsapp,email,messenger,instagram' });
  const z = fakeZernio();
  s.app.graph = z.f;
  const a = s.seeded.storeId;
  await s.app.db.query('UPDATE stores SET workspace_id = 1 WHERE id = $1', [a]);
  s.as(s.accounts.session(customer(1)).cookie);
  return { s, a, z };
}

type S = Awaited<ReturnType<typeof serve>>;
const profileOf = async (s: S, storeId: number) => (await s.app.db.one<{ profile_id: string }>('SELECT profile_id FROM zernio_profiles WHERE store_id = $1', [storeId]))?.profile_id;
const start = async (s: S, a: number, channel = 'instagram') => s.post(`/lead/${a}/${channel}/connect`, { _csrf: await s.csrf(`/lead/${a}/${channel}`) });
const signed = (s: S, body: unknown, secret = HOOK) => {
  const raw = JSON.stringify(body);
  return fetch(`${s.base}/zernio/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-zernio-signature': zernioSign(secret, raw), 'x-zernio-event-id': String((body as any).id) }, body: raw });
};

let seq = 0;
const received = (storeId: number, text: string, account = IG_ACCOUNT) => ({
  id: `evt-${seq++}`,
  event: 'message.received',
  message: { id: `m${seq}`, conversationId: CONV, platform: 'instagram', platformMessageId: `mid.in-${seq}`, direction: 'incoming', text, attachments: [], sender: { id: IGSID, name: 'דנה' }, sentAt: new Date().toISOString(), isRead: false, sentVia: null },
  conversation: { id: CONV, participantId: IGSID, participantName: 'דנה', status: 'active' },
  account: { id: account, accountId: account, profileId: 'p', platform: 'instagram', username: 'nurit.ceramics' },
  profiles: [{ id: 'p', externalId: `toran-store-${storeId}` }],
  timestamp: new Date().toISOString(),
});
const sent = (storeId: number, text: string, sentVia: string | null, sentAt = new Date()) => ({
  id: `evt-${seq++}`,
  event: 'message.sent',
  message: { id: `m${seq}`, conversationId: CONV, platform: 'instagram', platformMessageId: `mid.echo-${seq}`, direction: 'outgoing', text, attachments: [], sender: { id: IG_ACCOUNT }, sentAt: sentAt.toISOString(), isRead: true, sentVia },
  conversation: { id: CONV, participantId: IGSID, participantName: 'דנה', status: 'active' },
  account: { id: IG_ACCOUNT, accountId: IG_ACCOUNT, profileId: 'p', platform: 'instagram', username: 'nurit.ceramics' },
  profiles: [{ id: 'p', externalId: `toran-store-${storeId}` }],
  timestamp: new Date().toISOString(),
});

test('the provider switch: Meta unless TORAN_DM_PROVIDER says zernio; Zernio is ready only with its key, a webhook secret, the channel on and an https base; the signature; the store an externalId names', () => {
  assert.equal(dmProvider({}), 'meta');
  assert.equal(dmProvider({ TORAN_DM_PROVIDER: 'Zernio' }), 'zernio');
  const env = { TORAN_DM_PROVIDER: 'zernio', ZERNIO_API_KEY: KEY, ZERNIO_WEBHOOK_SECRET: HOOK, PUBLIC_BASE_URL: 'https://toran.test', TORAN_CHANNELS: 'whatsapp,instagram' };
  assert.equal(dmConnectReady(env, 'instagram'), true);
  assert.equal(dmConnectReady(env, 'messenger'), false, 'a channel whose code is off');
  assert.equal(dmConnectReady({ ...env, ZERNIO_WEBHOOK_SECRET: 'short' }, 'instagram'), false);
  assert.equal(dmConnectReady({ ...env, PUBLIC_BASE_URL: 'http://localhost:4710' }, 'instagram'), false);
  assert.equal(zernioSignatureOk(HOOK, '{"a":1}', zernioSign(HOOK, '{"a":1}')), true);
  assert.equal(zernioSignatureOk(HOOK, '{"a":1}', zernioSign(HOOK, '{"a":2}')), false);
  assert.equal(zernioSignatureOk(HOOK, '{"a":1}', undefined), false);
  assert.equal(storeOfExternalId('toran-store-12'), 12);
  assert.equal(storeOfExternalId('tenant_42'), null, 'another profile (Teder\'s) is not a store');
  assert.equal(humanAgentOn({}, { kind: 'zernio' }), true, 'Zernio\'s app takes HUMAN_AGENT for a person\'s answer');
  assert.equal(humanAgentOn({}, { kind: 'meta' }), false, 'ours only once Meta approved it');
});

test('connecting through Zernio: one profile per store, a link limited to messaging, the account taken only when Zernio lists it under the store\'s profile; disconnecting removes it at Zernio', async () => {
  const { s, a, z } = await shop();
  try {
    const page = await s.get(`/lead/${a}/instagram`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Zernio/, 'the store is told the name Meta\'s window will show');
    assert.match(String(page.headers.get('content-security-policy')), /form-action 'self'[^;]*https:\/\/zernio\.com/);
    const go = await start(s, a);
    assert.equal(go.status, 303);
    assert.match(String(go.headers.get('location')), /^https:\/\/zernio\.com\/connect\/welcome\/instagram/);
    const link = z.calls.find((c) => c.path.startsWith('/api/v1/connect/instagram'))!;
    const q = new URL(`https://x${link.path}`).searchParams;
    assert.equal(q.get('scopes'), 'messaging', 'messaging only');
    assert.equal(q.get('redirect_url'), `https://toran.test/lead/${a}/instagram/zernio`);
    assert.equal(q.get('profileId'), await profileOf(s, a));
    assert.equal(q.get('oauthAppId'), null, 'Zernio\'s own app');
    const made = z.calls.find((c) => c.method === 'POST' && c.path === '/api/v1/profiles')!;
    assert.equal(made.body.externalId, `toran-store-${a}`);
    // Pressing again: the same profile.
    await start(s, a);
    assert.equal(z.calls.filter((c) => c.method === 'POST' && c.path === '/api/v1/profiles').length, 1);

    // Back with an account Zernio does not list under this store's profile: refused, nothing connected.
    const forged = await s.get(`/lead/${a}/instagram/zernio?connected=instagram&accountId=${OTHER_ACCOUNT}`);
    assert.equal(await s.app.db.one("SELECT 1 FROM channel_accounts WHERE kind = 'zernio'"), null);
    assert.notEqual(forged.status, 500);

    z.account((await profileOf(s, a))!);
    const done = await s.get(`/lead/${a}/instagram/zernio?connected=instagram&accountId=${IG_ACCOUNT}`);
    assert.equal(done.headers.get('location'), `/lead/${a}/instagram?connected=1`);
    const row = await s.app.db.one<any>("SELECT store_id, kind, external_id, name, status, secret FROM channel_accounts WHERE channel = 'instagram'");
    assert.deepEqual({ ...row }, { store_id: a, kind: 'zernio', external_id: IG_ACCOUNT, name: '@nurit.ceramics', status: 'active', secret: null });
    assert.match(await (await s.get(`/lead/${a}/instagram`)).text(), /מחובר/);

    // A cancelled login comes back with an error: said, nothing changes.
    const cancelled = await s.get(`/lead/${a}/instagram/zernio?error=oauth_denied&platform=instagram`);
    assert.equal(cancelled.headers.get('location'), `/lead/${a}/instagram?error=zernio_cancelled`);

    const off = await s.post(`/lead/${a}/instagram/disconnect`, { _csrf: await s.csrf(`/lead/${a}/instagram`) });
    assert.equal(off.status, 303);
    assert.deepEqual(z.state.deleted, [IG_ACCOUNT]);
    assert.equal((await s.app.db.one<any>("SELECT status FROM channel_accounts WHERE channel = 'instagram'")).status, 'off');
  } finally {
    await s.close();
  }
});

test('through Zernio a customer is answered as on Meta: signed webhooks only, the reply through Zernio\'s inbox with our key, the owner\'s answer from the app pauses Toran, the Page\'s instant reply does not, and another store\'s account is never spoken for', async () => {
  const { s, a, z } = await shop();
  try {
    await start(s, a);
    z.account((await profileOf(s, a))!);
    await s.get(`/lead/${a}/instagram/zernio?connected=instagram&accountId=${IG_ACCOUNT}`);

    // Unsigned, or signed with another secret: refused, nothing queued.
    const raw = JSON.stringify(received(a, 'שלום'));
    assert.equal((await fetch(`${s.base}/zernio/webhook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw })).status, 401);
    assert.equal((await signed(s, received(a, 'שלום'), 'not-the-secret-0123456789')).status, 401);
    assert.equal(await s.app.db.one("SELECT 1 FROM jobs WHERE kind = 'dm_inbound'"), null);

    // A profile that is not a store's (Teder's share the key), and another store's id on our account: dropped.
    const teder = { ...received(a, 'x'), profiles: [{ id: 'q', externalId: 'teder-acc-1' }] };
    assert.equal((await signed(s, teder)).status, 200);
    assert.equal((await signed(s, received(a + 1000, 'x'))).status, 200);
    assert.equal(await s.app.db.one("SELECT 1 FROM jobs WHERE kind = 'dm_inbound'"), null);

    const first = received(a, 'יש לכם ספלים בכחול?');
    assert.equal((await signed(s, first)).status, 200);
    await drain(s.app);
    const conv = await s.app.db.one<any>("SELECT c.id, c.meta FROM conversations c JOIN channel_accounts x ON x.id = c.account_id WHERE x.external_id = $1", [IG_ACCOUNT]);
    assert.ok(conv, 'the conversation is the store\'s account\'s');
    assert.equal(conv.meta?.name, 'דנה', 'the name Zernio gave');
    const sends = z.calls.filter((c) => c.method === 'POST' && c.path === `/api/v1/inbox/conversations/${CONV}/messages`);
    assert.equal(sends.length, 1, 'answered once');
    assert.equal(sends[0].auth, `Bearer ${KEY}`);
    assert.equal(sends[0].body.accountId, IG_ACCOUNT);
    assert.equal(sends[0].body.messageTag, undefined, 'the agent never tags');

    // The same event again (Zernio retries): one message.
    await signed(s, first);
    await drain(s.app);
    const count = async () => (await s.app.db.one<any>('SELECT COUNT(*)::int AS n FROM messages WHERE conversation_id = $1', [conv.id])).n;
    const n = await count();

    // Our own send coming back (sentVia api): nothing.
    await signed(s, sent(a, 'התשובה של תורן', 'api'));
    await drain(s.app);
    assert.equal(await count(), n);

    // The Page's instant reply, seconds after the customer's message (sentVia null): Toran keeps answering.
    const lastIn = await s.app.db.one<any>("SELECT at FROM messages WHERE conversation_id = $1 AND role = 'customer' ORDER BY id DESC LIMIT 1", [conv.id]);
    // An echo waits a few seconds in the queue (so ours is known first); here it is made due at once.
    const due = () => s.app.db.query("UPDATE jobs SET run_at = now() WHERE kind = 'zernio_echo' AND status = 'queued'");
    await signed(s, sent(a, 'תודה שפנית! נחזור אלייך בהקדם', null, new Date(Date.parse(lastIn.at) + 2_000)));
    await due();
    await drain(s.app);
    assert.equal(await s.app.db.one("SELECT 1 FROM messages WHERE conversation_id = $1 AND role = 'owner'", [conv.id]), null, 'an instant reply is not the owner');

    // The owner answers from the Instagram app, later: in the inbox, and Toran steps back.
    await signed(s, sent(a, 'אבדוק ואחזור אלייך', null, new Date(Date.now() + 60_000)));
    await due();
    await drain(s.app);
    const owner = await s.app.db.one<any>("SELECT text, author FROM messages WHERE conversation_id = $1 AND role = 'owner' ORDER BY id DESC LIMIT 1", [conv.id]);
    assert.deepEqual({ ...owner }, { text: 'אבדוק ואחזור אלייך', author: 'מהאינסטגרם' });
    const before = z.state.sent;
    await signed(s, received(a, 'תודה!'));
    await drain(s.app);
    assert.equal(z.state.sent, before, 'Toran waits while the owner has the conversation');
  } finally {
    await s.close();
  }
});
