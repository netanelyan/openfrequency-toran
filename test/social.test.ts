import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signBody } from '../src/channels/meta.ts';
import { parseSocial } from '../src/channels/social.ts';
import { fit } from '../src/channels/policy.ts';
import { counted, monthOf } from '../src/plans.ts';
import { drain, schedule } from '../src/jobs/worker.ts';
import { customer } from './helpers.ts';
import { serve } from './serve.ts';

// A store's Facebook Page (Messenger) and Instagram account, connected through Meta (channels/social.ts,
// socialStore.ts, pages/social.ts), against a stand-in for Meta's Graph API and Instagram's. Nothing here reaches Meta.

const APP_ID = '1234567890';
const APP_SECRET = 'test-app-secret-not-a-real-one';
const IG_APP_ID = '5555555555';
const IG_SECRET = 'test-instagram-secret-not-real';
const PAGE = '200300400500600';
const PAGE2 = '200300400500700';
const IG = '17841400000000001';
const PSID = '7000000000000001';
const IGSID = '8000000000000001';
const USER_TOKEN = 'test-user-token';
const PAGE_TOKEN = 'test-page-token';
const IG_TOKEN = 'test-ig-long-token';

type Call = { method: string; host: string; path: string; auth: string | null; query: URLSearchParams; body: any };

function fakeMeta() {
  const calls: Call[] = [];
  const state = { pages: [{ id: PAGE, name: 'כלי חרס של נורית', access_token: PAGE_TOKEN, tasks: ['MODERATE', 'MESSAGING'] }] as any[], sent: 0, igToken: IG_TOKEN, refreshFails: false };
  const f = (async (input: any, init: any = {}) => {
    const u = new URL(String(input));
    const method = String(init.method || 'GET');
    const path = u.pathname.replace(/^\/v\d+\.\d+\//, '').replace(/^\//, '');
    const raw = init.body ? String(init.body) : '';
    const body = !raw ? null : String((init.headers as any)?.['content-type']).includes('json') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw));
    const auth = (init.headers as any)?.authorization || null;
    calls.push({ method, host: u.host, path, auth, query: u.searchParams, body });
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
    const no = () => json({ error: { message: `no route ${method} ${u.host}/${path}`, code: 1 } }, 404);
    if (u.host === 'graph.facebook.com') {
      if (path === 'oauth/access_token') {
        if (u.searchParams.get('grant_type') === 'fb_exchange_token') return json({ access_token: USER_TOKEN });
        return u.searchParams.get('code') === 'good-code' && u.searchParams.get('client_secret') === APP_SECRET ? json({ access_token: 'short-user-token' }) : json({ error: { message: 'bad code', code: 100 } }, 400);
      }
      if (path === 'me' && auth === `Bearer ${USER_TOKEN}`) return json({ id: '99999' });
      if (path === 'me/accounts' && auth === `Bearer ${USER_TOKEN}`) return json({ data: state.pages });
      const pageToken = state.pages.find((p) => auth === `Bearer ${p.access_token}`);
      if (!pageToken) return json({ error: { message: 'bad token', code: 190 } }, 401);
      if (/^\d+\/subscribed_apps$/.test(path)) return json({ success: true });
      if (/^\d+\/messages$/.test(path) && method === 'POST') return json({ recipient_id: body.recipient.id, message_id: `m_out-${++state.sent}` });
      if (path === PSID) return json({ first_name: 'דנה', last_name: 'כהן' });
      return no();
    }
    if (u.host === 'api.instagram.com' && path === 'oauth/access_token') return body?.code === 'good-code' && body?.client_secret === IG_SECRET && body?.client_id === IG_APP_ID ? json({ data: [{ access_token: 'short-ig', user_id: IG, permissions: 'instagram_business_basic,instagram_business_manage_messages' }] }) : json({ error_message: 'bad code', code: 400 }, 400);
    if (u.host === 'graph.instagram.com') {
      if (path === 'access_token') return json({ access_token: state.igToken, token_type: 'bearer', expires_in: 5_184_000 });
      if (path === 'refresh_access_token') {
        if (state.refreshFails) return json({ error: { message: 'Error validating access token', code: 190 } }, 400);
        state.igToken = 'test-ig-refreshed';
        return json({ access_token: state.igToken, token_type: 'bearer', expires_in: 5_184_000 });
      }
      if (u.searchParams.get('access_token') !== state.igToken) return json({ error: { message: 'bad token', code: 190 } }, 400);
      if (path === 'me') return json({ id: 'app-scoped-1', user_id: IG, username: 'nurit.ceramics', name: 'נורית' });
      if (path === 'me/subscribed_apps') return json({ success: true });
      if (path === `${IG}/messages` && method === 'POST') return json({ recipient_id: body.recipient.id, message_id: `ig_out-${++state.sent}` });
      if (path === IGSID) return json({ name: 'יעל', username: 'yael' });
      return no();
    }
    return no();
  }) as typeof fetch;
  return { f, calls, state };
}

async function shop({ channels = 'messenger,instagram' } = {}) {
  const s = await serve();
  Object.assign(s.app.env, { TORAN_CHANNELS: channels, META_APP_ID: APP_ID, META_APP_SECRET: APP_SECRET, META_WEBHOOK_VERIFY_TOKEN: 'verify-me', META_IG_APP_ID: IG_APP_ID, META_IG_APP_SECRET: IG_SECRET, TORAN_SECRETS_KEY: 'k'.repeat(40), PUBLIC_BASE_URL: 'https://toran.test' });
  const g = fakeMeta();
  s.app.graph = g.f;
  const a = s.seeded.storeId;
  await s.app.db.query('UPDATE stores SET workspace_id = 1 WHERE id = $1', [a]);
  s.as(s.accounts.session(customer(1)).cookie);
  return { s, a, g };
}

type S = Awaited<ReturnType<typeof serve>>;

/** The button, then Meta's answer in the same browser: the redirect to Meta, and where Toran sends the store after. */
async function connect(s: S, a: number, channel: 'messenger' | 'instagram', { code = 'good-code', cookie = true }: { code?: string; cookie?: boolean } = {}) {
  const r = await s.post(`/lead/${a}/${channel}/connect`, { _csrf: await s.csrf(`/lead/${a}/${channel}`) });
  assert.equal(r.status, 303);
  const meta = new URL(String(r.headers.get('location')));
  const nonce = /tn_meta=([^;]+)/.exec(r.headers.getSetCookie().join('\n'))![1];
  const back = await fetch(`${s.base}/meta/oauth/${channel}?code=${code}&state=${encodeURIComponent(meta.searchParams.get('state')!)}`, { headers: cookie ? { cookie: `tn_meta=${nonce}` } : {}, redirect: 'manual' });
  return { meta, back, to: String(back.headers.get('location') || ''), state: meta.searchParams.get('state')! };
}

let seq = 0;
const webhook = (s: S, body: unknown, secret = APP_SECRET) => {
  const raw = JSON.stringify(body);
  return fetch(`${s.base}/meta/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': signBody(secret, raw) }, body: raw });
};
const fbMessage = (text: string, from = PSID) => ({ object: 'page', entry: [{ id: PAGE, time: Date.now(), messaging: [{ sender: { id: from }, recipient: { id: PAGE }, timestamp: Date.now(), message: { mid: `m_in-${seq++}`, text } }] }] });
const fbEcho = (text: string, appId: string | null, mid = `m_echo-${seq++}`) => ({ object: 'page', entry: [{ id: PAGE, time: Date.now(), messaging: [{ sender: { id: PAGE }, recipient: { id: PSID }, timestamp: Date.now(), message: { mid, is_echo: true, text, ...(appId ? { app_id: appId } : {}) } }] }] });
const igMessage = (text: string, from = IGSID) => ({ object: 'instagram', entry: [{ id: IG, time: Date.now(), messaging: [{ sender: { id: from }, recipient: { id: IG }, timestamp: Date.now(), message: { mid: `ig_in-${seq++}`, text } }] }] });
const igEcho = (text: string, mid: string) => ({ object: 'instagram', entry: [{ id: IG, time: Date.now(), messaging: [{ sender: { id: IG }, recipient: { id: IGSID }, timestamp: Date.now(), message: { mid, is_echo: true, text } }] }] });
const runEchoes = async (s: S) => {
  await s.app.db.query("UPDATE jobs SET run_at = now() WHERE kind = 'dm_echo' AND status = 'queued'");
  await drain(s.app);
};
const sends = (g: ReturnType<typeof fakeMeta>, path: string) => g.calls.filter((c) => c.method === 'POST' && c.path === path);

test('what Meta\'s webhook carries for Messenger and Instagram, and Instagram\'s 1,000 bytes', () => {
  const w = parseSocial({ object: 'page', entry: [{ id: PAGE, messaging: [
    { sender: { id: PSID }, recipient: { id: PAGE }, timestamp: 1700000000000, message: { mid: 'm1', text: ' יש במלאי? ' } },
    { sender: { id: PSID }, recipient: { id: PAGE }, timestamp: 1700000000000, message: { mid: 'm2', attachments: [{ type: 'image', payload: { url: 'https://x' } }] } },
    { sender: { id: PSID }, recipient: { id: PAGE }, timestamp: 1700000000000, read: { watermark: 1 } },
    { sender: { id: PSID }, recipient: { id: PAGE }, timestamp: 1700000000000, postback: { title: 'להתחיל', payload: 'GET_STARTED', mid: 'p1' } },
    { sender: { id: PAGE }, recipient: { id: PSID }, timestamp: 1700000000000, message: { mid: 'e1', is_echo: true, app_id: 263902037430900, text: 'כן, יש' } },
  ] }] });
  assert.equal(w.channel, 'messenger');
  assert.deepEqual(w.messages.map((m) => [m.id, m.from, m.account, m.text, (m.attachments || []).length]), [['m1', PSID, PAGE, 'יש במלאי?', 0], ['m2', PSID, PAGE, '', 1], ['p1', PSID, PAGE, 'להתחיל', 0]], 'a read receipt is no message');
  assert.deepEqual(w.echoes.map((e) => [e.id, e.to, e.text, e.appId]), [['e1', PSID, 'כן, יש', '263902037430900']]);
  // The app dashboard's test sends come as changes.
  const t = parseSocial({ object: 'instagram', entry: [{ id: IG, changes: [{ field: 'messages', value: { sender: { id: IGSID }, recipient: { id: IG }, timestamp: '1700000000', message: { mid: 'i1', text: 'hi' } } }] }] });
  assert.deepEqual(t.messages.map((m) => [m.channel, m.id, m.account]), [['instagram', 'i1', IG]]);
  assert.equal(parseSocial({ object: 'whatsapp_business_account', entry: [] }).channel, null, 'WhatsApp is meta.ts\'s');

  const long = 'שלום לך, '.repeat(150);
  const parts = fit(long, 1000, 1000);
  assert.ok(parts.length >= 2);
  assert.ok(parts.every((p) => Buffer.byteLength(p, 'utf8') <= 1000), 'every part fits Instagram\'s bytes');
  assert.equal(parts.join(' ').replace(/\s+/g, ' ').trim(), long.trim());
  assert.deepEqual(fit('short', 2000), ['short']);
});

test('behind the flag: with Messenger and Instagram off, the pages are not there, Meta\'s calls about them are dropped, and the website keeps "בקרוב"', async () => {
  const { s, a } = await shop({ channels: '' });
  try {
    assert.equal((await s.get(`/lead/${a}/messenger`)).status, 404);
    assert.equal((await s.get(`/lead/${a}/instagram`)).status, 404);
    assert.equal((await fetch(`${s.base}/meta/oauth/messenger?code=x&state=y`, { redirect: 'manual' })).status, 404);
    assert.equal((await webhook(s, fbMessage('שלום'))).status, 200, 'acknowledged, so Meta does not retry');
    assert.equal((await s.app.db.query("SELECT 1 FROM jobs WHERE kind LIKE 'dm_%'")).length, 0, 'and dropped');
    assert.deepEqual((await (await fetch(`${s.base}/channels.json`)).json()).soon.sort(), ['email', 'instagram', 'messenger']);
    const today = await (await s.get('/')).text();
    assert.ok(!/לחבר את הדף בפייסבוק|לחבר את האינסטגרם/.test(today));
  } finally {
    await s.close();
  }
});

test('connecting a Page: Meta\'s login, the state and this browser\'s cookie, the Page\'s token sealed, its messages sent here', async () => {
  const { s, a, g } = await shop();
  try {
    const page = await s.get(`/lead/${a}/messenger`);
    assert.match(String(page.headers.get('content-security-policy')), /form-action 'self' https:\/\/www\.facebook\.com/);
    assert.match(await page.text(), /לחבר את הדף בפייסבוק/);

    // Meta's answer in another browser (no cookie) is refused.
    let c = await connect(s, a, 'messenger', { cookie: false });
    assert.equal(c.meta.origin, 'https://www.facebook.com');
    assert.equal(c.meta.searchParams.get('client_id'), APP_ID);
    assert.equal(c.meta.searchParams.get('redirect_uri'), 'https://toran.test/meta/oauth/messenger');
    assert.match(String(c.meta.searchParams.get('scope')), /pages_messaging/);
    assert.equal(c.to, `/lead/${a}/messenger?error=browser`);
    assert.equal(g.calls.length, 0, 'nothing was asked of Meta');

    c = await connect(s, a, 'messenger');
    assert.equal(c.to, `/lead/${a}/messenger?connected=1`);
    const row = await s.app.db.one<any>("SELECT store_id, kind, external_id, name, status, secret, meta FROM channel_accounts WHERE channel = 'messenger'");
    assert.deepEqual([row.store_id, row.kind, row.external_id, row.name, row.status], [a, 'meta', PAGE, 'כלי חרס של נורית', 'active']);
    assert.ok(row.secret.startsWith('v1.') && !row.secret.includes(PAGE_TOKEN), 'the Page\'s token is sealed');
    const sub = g.calls.find((x) => x.path === `${PAGE}/subscribed_apps`)!;
    assert.equal(sub.auth, `Bearer ${PAGE_TOKEN}`);
    assert.equal(sub.query.get('subscribed_fields'), 'messages,messaging_postbacks,message_echoes');
    assert.match(await (await s.get(`/lead/${a}/messenger?connected=1`)).text(), /תורן עונה מעכשיו/);
    assert.match(await (await s.get('/settings')).text(), /מחובר, <bdi>כלי חרס של נורית<\/bdi>/);

    // The same answer twice is refused: a state is used once.
    const again = await fetch(`${s.base}/meta/oauth/messenger?code=good-code&state=${encodeURIComponent(c.state)}`, { redirect: 'manual' });
    assert.equal(again.headers.get('location'), `/lead/${a}/messenger?error=expired`);
    assert.equal((await fetch(`${s.base}/meta/oauth/messenger?code=good-code&state=made-up`, { redirect: 'manual' })).status, 400);

    // Another workspace's store cannot take the Page, nor connect store A.
    const b = (await s.app.db.one<{ id: number }>("SELECT id FROM stores WHERE domain = 'shaked-jewelry.example'"))!.id;
    await s.app.db.query('UPDATE stores SET workspace_id = 2 WHERE id = $1', [b]);
    s.as(s.accounts.session(customer(2)).cookie);
    c = await connect(s, b, 'messenger');
    assert.equal(c.to, `/lead/${b}/messenger?error=taken`);
    assert.equal((await s.post(`/lead/${a}/messenger/connect`, { _csrf: await s.csrf('/') })).status, 404);
  } finally {
    await s.close();
  }
});

test('someone who manages more than one Page picks the store\'s, and only they see the list', async () => {
  const { s, a, g } = await shop();
  try {
    g.state.pages.push({ id: PAGE2, name: 'הדף הפרטי', access_token: 'test-page-token-2', tasks: ['MANAGE'] });
    const c = await connect(s, a, 'messenger');
    assert.match(c.to, new RegExp(`^/lead/${a}/messenger\\?pick=`));
    const html = await (await s.get(c.to)).text();
    assert.match(html, /באיזה דף תורן יענה/);
    assert.match(html, new RegExp(`value="${PAGE2}"`));
    assert.ok(!html.includes('test-page-token'), 'no token reaches the page');
    // Another person of the same workspace does not see the list.
    s.as(s.accounts.session({ ...customer(1), user: { ...customer(1).user, id: 777 } }).cookie);
    assert.match(await (await s.get(c.to)).text(), /הבחירה כבר לא פתוחה/);
    s.as(s.accounts.session(customer(1)).cookie);
    assert.equal((await s.post(`/lead/${a}/messenger/pick`, { _csrf: await s.csrf(c.to), state: c.state, page: PAGE2 })).status, 303);
    const row = await s.app.db.one<any>("SELECT external_id, name FROM channel_accounts WHERE channel = 'messenger' AND status = 'active'");
    assert.deepEqual(row, { external_id: PAGE2, name: 'הדף הפרטי' });
    assert.equal((await s.app.db.one<any>('SELECT data FROM channel_connects WHERE state = $1', [c.state])).data, null, 'the tokens are gone once picked');
  } finally {
    await s.close();
  }
});

test('a customer writes to the Page: Toran answers through Meta, named in the inbox, counted in the plan; the owner answers from the Page\'s inbox and Toran steps back', async () => {
  const { s, a, g } = await shop();
  try {
    await connect(s, a, 'messenger');
    assert.equal((await webhook(s, fbMessage('יש לכם ספלים בכחול?'))).status, 200);
    assert.equal((await webhook(s, fbMessage('x'), 'not-the-secret')).status, 403, 'a forged call is refused');
    await drain(s.app);
    const conv = await s.app.db.one<any>("SELECT id, channel, peer, meta FROM conversations WHERE channel = 'messenger'");
    assert.deepEqual([conv.peer, conv.meta.name], [PSID, 'דנה כהן']);
    const out = sends(g, `${PAGE}/messages`);
    assert.equal(out.length, 1);
    assert.equal(out[0].auth, `Bearer ${PAGE_TOKEN}`, 'sent with the Page\'s own token');
    assert.deepEqual([out[0].body.recipient.id, out[0].body.messaging_type], [PSID, 'RESPONSE']);
    assert.ok(out[0].body.message.text.length > 0 && !/דמו של תורן/.test(out[0].body.message.text));
    assert.equal((await counted(s.app.db, [a])).get(a)!.get(monthOf()), 1);
    const list = await (await s.get('/chats')).text();
    assert.match(list, new RegExp(`/chat/${conv.id}"`));
    assert.match(list, /מסנג׳ר/);

    // Meta echoes Toran's own send back: dropped. The owner's answer from the Page's inbox: kept, and Toran steps back.
    await webhook(s, fbEcho(out[0].body.message.text, APP_ID));
    await runEchoes(s);
    assert.equal((await s.app.db.query("SELECT 1 FROM messages WHERE conversation_id = $1 AND role = 'owner'", [conv.id])).length, 0);
    await webhook(s, fbEcho('אני בודקת ואחזור אלייך', '263902037430900'));
    await runEchoes(s);
    const owner = await s.app.db.one<any>("SELECT text, author FROM messages WHERE conversation_id = $1 AND role = 'owner'", [conv.id]);
    assert.deepEqual(owner, { text: 'אני בודקת ואחזור אלייך', author: 'מהדף בפייסבוק' });
    const before = sends(g, `${PAGE}/messages`).length;
    await webhook(s, fbMessage('תודה!'));
    await drain(s.app);
    assert.equal(sends(g, `${PAGE}/messages`).length, before, 'paused: the owner has it');
    assert.match(await (await s.get(`/chat/${conv.id}`)).text(), /דנה כהן/);
  } finally {
    await s.close();
  }
});

test('the 24 hours: past them nothing goes out, until Meta approves Human Agent; then the owner\'s answer goes out tagged, up to 7 days', async () => {
  const { s, a, g } = await shop();
  try {
    await connect(s, a, 'messenger');
    await webhook(s, fbMessage('מתי אתם פתוחים?'));
    await drain(s.app);
    const conv = (await s.app.db.one<any>("SELECT id FROM conversations WHERE channel = 'messenger'")).id;
    await s.app.db.query("UPDATE messages SET at = now() - interval '30 hours' WHERE conversation_id = $1", [conv]);
    let html = await (await s.get(`/chat/${conv}`)).text();
    assert.match(html, /Meta לא מאפשרת לענות במסנג׳ר/);
    const n = sends(g, `${PAGE}/messages`).length;
    await s.post(`/chat/${conv}/reply`, { _csrf: await s.csrf(`/chat/${conv}`), text: 'פתוחים עד שש' });
    assert.equal(sends(g, `${PAGE}/messages`).length, n, 'refused');

    s.app.env.META_HUMAN_AGENT = '1';
    html = await (await s.get(`/chat/${conv}`)).text();
    assert.match(html, /7 ימים מההודעה האחרונה של הלקוח/);
    assert.equal((await s.post(`/chat/${conv}/reply`, { _csrf: await s.csrf(`/chat/${conv}`), text: 'פתוחים עד שש' })).status, 303);
    const last = sends(g, `${PAGE}/messages`).at(-1)!;
    assert.deepEqual([last.body.messaging_type, last.body.tag, last.body.message.text], ['MESSAGE_TAG', 'HUMAN_AGENT', 'פתוחים עד שש']);

    // The agent never answers past the 24 hours, approved or not.
    await s.app.db.query("UPDATE conversations SET agent_paused_until = NULL WHERE id = $1", [conv]);
    await s.app.db.query("UPDATE messages SET at = now() - interval '8 days' WHERE conversation_id = $1", [conv]);
    assert.match(await (await s.get(`/chat/${conv}`)).text(), /Meta לא מאפשרת לענות במסנג׳ר/, 'past 7 days, not even the owner');
  } finally {
    await s.close();
  }
});

test('Instagram: connected with Instagram Login, answered in parts of 1,000 bytes, the owner\'s answers from the app kept, and the token renewed before its 60 days end', async () => {
  const { s, a, g } = await shop();
  try {
    const c = await connect(s, a, 'instagram');
    assert.equal(c.meta.origin, 'https://www.instagram.com');
    assert.equal(c.meta.searchParams.get('client_id'), IG_APP_ID);
    assert.equal(c.meta.searchParams.get('scope'), 'instagram_business_basic,instagram_business_manage_messages');
    assert.equal(c.to, `/lead/${a}/instagram?connected=1`);
    const row = await s.app.db.one<any>("SELECT id, external_id, name, secret, meta FROM channel_accounts WHERE channel = 'instagram'");
    assert.deepEqual([row.external_id, row.name], [IG, '@nurit.ceramics']);
    assert.ok(!row.secret.includes(IG_TOKEN));
    assert.ok(new Date(row.meta.expires_at).getTime() > Date.now() + 59 * 86_400_000);
    assert.ok(g.calls.some((x) => x.host === 'graph.instagram.com' && x.path === 'me/subscribed_apps' && x.method === 'POST'));

    await webhook(s, igMessage('יש משלוח לאילת?'), IG_SECRET);
    await drain(s.app);
    const conv = await s.app.db.one<any>("SELECT id, meta FROM conversations WHERE channel = 'instagram'");
    assert.equal(conv.meta.name, 'יעל');
    assert.equal(sends(g, `${IG}/messages`).length, 1);

    // A long answer from the owner goes out in parts Instagram takes, and their echoes are known as Toran's own.
    await s.post(`/chat/${conv.id}/reply`, { _csrf: await s.csrf(`/chat/${conv.id}`), text: 'כן, שולחים לאילת. '.repeat(60).trim() });
    const parts = sends(g, `${IG}/messages`).slice(1);
    assert.ok(parts.length >= 2);
    assert.ok(parts.every((p) => Buffer.byteLength(p.body.message.text, 'utf8') <= 1000));
    for (const [i, p] of parts.entries()) await webhook(s, igEcho(p.body.message.text, `ig_out-${i + 2}`), IG_SECRET);
    await webhook(s, igEcho('מהטלפון שלי', 'ig_echo-own'), IG_SECRET);
    await runEchoes(s);
    const owners = await s.app.db.query<any>("SELECT author, text FROM messages WHERE conversation_id = $1 AND role = 'owner' ORDER BY id", [conv.id]);
    assert.equal(owners.length, 2, 'the dashboard answer once, and the one from the app');
    assert.deepEqual(owners[1], { author: 'מהאינסטגרם', text: 'מהטלפון שלי' });

    // 45 days later: the token is renewed. Then Instagram says the token is dead (190): the account stops, in words.
    await s.app.db.query("UPDATE channel_accounts SET meta = meta || jsonb_build_object('expires_at', (now() + interval '15 days')::text), connected_at = now() - interval '45 days' WHERE id = $1", [row.id]);
    await schedule(s.app);
    await drain(s.app, { kinds: ['ig_refresh'] });
    const fresh = await s.app.db.one<any>('SELECT meta FROM channel_accounts WHERE id = $1', [row.id]);
    assert.ok(new Date(fresh.meta.expires_at).getTime() > Date.now() + 59 * 86_400_000);
    await s.app.db.query('UPDATE conversations SET agent_paused_until = NULL WHERE id = $1', [conv.id]);
    await webhook(s, igMessage('ועוד שאלה'), IG_SECRET);
    await drain(s.app);
    assert.ok(sends(g, `${IG}/messages`).at(-1)!.query.get('access_token') === 'test-ig-refreshed', 'sent with the renewed token');

    g.state.refreshFails = true;
    await s.app.db.query("UPDATE channel_accounts SET meta = meta || jsonb_build_object('expires_at', (now() + interval '10 days')::text, 'refreshed_at', (now() - interval '2 days')::text) WHERE id = $1", [row.id]);
    await schedule(s.app);
    await drain(s.app, { kinds: ['ig_refresh'] });
    assert.equal((await s.app.db.one<any>('SELECT status FROM channel_accounts WHERE id = $1', [row.id])).status, 'error');
    assert.match(await (await s.get('/settings')).text(), /נעצר, ותורן לא עונה בו/);
  } finally {
    await s.close();
  }
});

test('disconnecting: Meta stops sending, the token is gone, and a message to the Page is no longer answered', async () => {
  const { s, a, g } = await shop();
  try {
    await connect(s, a, 'messenger');
    assert.equal((await s.post(`/lead/${a}/messenger/disconnect`, { _csrf: await s.csrf(`/lead/${a}/messenger`) })).status, 303);
    assert.deepEqual(await s.app.db.one<any>("SELECT status, secret FROM channel_accounts WHERE channel = 'messenger'"), { status: 'off', secret: null });
    assert.ok(g.calls.some((x) => x.method === 'DELETE' && x.path === `${PAGE}/subscribed_apps`));
    await webhook(s, fbMessage('עדיין פתוחים?'));
    await drain(s.app);
    assert.equal(sends(g, `${PAGE}/messages`).length, 0);
    assert.ok(await s.app.db.one("SELECT 1 FROM events WHERE kind = 'fb_unknown_account'"));
    assert.match(await (await s.get(`/lead/${a}/messenger`)).text(), /לחבר את הדף בפייסבוק/, 'it can be connected again');
  } finally {
    await s.close();
  }
});

test('without the Instagram app\'s settings, or the public address, the page says the connection is not open, and the button is refused', async () => {
  const { s, a } = await shop();
  try {
    delete s.app.env.META_IG_APP_SECRET;
    const html = await (await s.get(`/lead/${a}/instagram`)).text();
    assert.match(html, /החיבור עוד לא פתוח בשרת/);
    assert.ok(!/instagram\/connect/.test(html));
    const r = await s.post(`/lead/${a}/instagram/connect`, { _csrf: await s.csrf(`/lead/${a}/instagram`) }, { 'x-tn-ajax': '1' });
    assert.equal((await r.json()).ok, false);
    delete s.app.env.PUBLIC_BASE_URL;
    assert.match(await (await s.get(`/lead/${a}/messenger`)).text(), /החיבור עוד לא פתוח בשרת/);
  } finally {
    await s.close();
  }
});
