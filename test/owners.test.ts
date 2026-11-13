import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { handleInbound } from '../src/channels/route.ts';
import { createHandler } from '../src/web/server.ts';
import { drain } from '../src/jobs/worker.ts';
import { J } from '../src/db/index.ts';
import { handleTederEvent, handleTederReady } from '../src/owners/events.ts';
import { DISCLOSURE, pushToOwner, TEDER_ON_WHATSAPP } from '../src/owners/notify.ts';
import { ownerByPhone } from '../src/owners/identity.ts';
import { DIR, signature, signedHeaders, verify } from '../src/owners/teder.ts';
import { TEMPLATES, templatesDoc } from '../src/owners/templates.ts';
import { OWNER_PER_10_MIN, tederHere } from '../src/owners/line.ts';
import type { Block, TurnReq } from '../src/agent/llm/types.ts';
import type { Script } from '../src/agent/llm/scripted.ts';
import { fakeOwnerAccounts, fakeTeder, SECRET } from './owner-fakes.ts';
import { syncCompany } from '../src/company.ts';
import { accountFor } from '../src/channels/store.ts';
import { ownerReply } from '../src/channels/owner.ts';
import { testApp } from './helpers.ts';

// The owner line (src/owners/, docs/owner-line.md): who a number is, a Toran store's owner and their assistant, and
// WhatsApp's rules in code (the opt-out, the limits). Teder is managed on its own dashboard only since 2026-11-02 (the
// owner: "managing teder through whatsapp, only through the dashboard"): none of Teder's news goes to WhatsApp, no
// template is sent, a reply about Teder's posts approves nothing and is told where the dashboard is, and an owner with
// Teder alone is our support's, like anyone else. Accounts and Teder are stand-ins that check the token and the
// signatures (owner-fakes.ts), and keep every call, so a test can say Teder was never asked; the model is a script.

const LINE = '972500000888';
const OWNER = '972500000123';
const OTHER = '972500000124';
const WS = 7;
const SIDS = Object.keys(TEMPLATES).map((n, i) => `${n}=HX${String(i).repeat(32)}`).join(',');
const DASHBOARD = 'https://teder.openfrequency.co.il';
let seq = 0;

const toolUse = (name: string, input: Record<string, unknown>): Block[] => [{ type: 'tool_use', id: `t${seq++}`, name, input }];
const say = (text: string): Block[] => [{ type: 'text', text }];
const lastResult = (req: TurnReq) => {
  const last = req.messages[req.messages.length - 1];
  return Array.isArray(last.content) ? String((last.content.find((b: any) => b.type === 'tool_result') as any)?.content || '') : '';
};
const QUOTA = { account: { id: 'acc', name: 'חשבון' }, quota: { month: '2026-10', suggestions: { used: 32, held: 0, limit: 40, left: 8 }, redos: { used: 3, held: 0, limit: 10, left: 7 } } };
const WEEK = { from: '2026-10-18T06:00:00.000Z', to: '2026-10-25T06:00:00.000Z', accounts: [{ account: { id: 'acc', name: 'חשבון' }, week: { published: 6, views: 1500, best: { id: 'p1', coverLine: 'הכי טוב', views: 900 } }, quota: { suggestions: { left: 28, limit: 40 } } }] };

async function setup(script?: Script) {
  const app = await testApp({ script });
  const accounts = await fakeOwnerAccounts();
  const teder = await fakeTeder();
  // The templates' SIDs are set, as they would be on a server that still has them: nothing may go out all the same.
  Object.assign(app.env, accounts.env, teder.env, { TORAN_ASSISTANT_WA: LINE, TWILIO_TEMPLATES: SIDS });
  const outbox = app.wa.outbox!;
  const write = (text: string, from = OWNER, id = `o${seq++}`) => handleInbound(app, { channel: 'whatsapp', from, text, id, at: Date.now(), to: LINE });
  const event = async (type: string, data: unknown, id = `evt_${seq++}`) => {
    await app.db.query('INSERT INTO teder_events (id, type, workspace_id, data) VALUES ($1, $2, $3, $4::jsonb)', [id, type, WS, J(data)]);
    return { id, result: await handleTederEvent(app, id) };
  };
  const toOwner = () => outbox.filter((m) => m.to === OWNER);
  const notes = () => app.db.query<any>('SELECT kind, status, mode, template, reason FROM owner_notifications ORDER BY id');
  const three = () => {
    teder.add({ id: 11, workspace: WS, hook: '5 טעויות בבחירת נעלי ריצה' });
    teder.add({ id: 12, workspace: WS, hook: 'איך לשמור על הגב בריצה' });
    teder.add({ id: 13, workspace: WS, hook: 'מה לאכול לפני מרתון' });
    return [11, 12, 13].map((id) => ({ id: String(id), coverLine: teder.posts.get(id)!.hook, image: `https://teder.test/m/${id}/instagram/1?e=1&s=x` }));
  };
  // A list the owner was shown before 2026-11-02, as the line kept it: "1" in a reply meant its first post.
  const oldList = (ids: number[], phone = OWNER) => app.db.query("INSERT INTO owner_lists (phone, workspace_id, items, source) VALUES ($1, $2, $3::jsonb, 'post.ready')", [phone, WS, J(ids.map((id) => ({ id: String(id), hook: `מצגת ${id}` })))]);
  // A Toran store in the owner's workspace: its owner has something of theirs on the line.
  const toranStore = async () => (await app.db.one<{ id: number }>("INSERT INTO stores (domain, url, name, platform, source, slug, workspace_id) VALUES ('both.example', 'https://both.example/', 'שניהם', 'shopify', 'seed', 'both-x1', $1) RETURNING id", [WS]))!.id;
  // Our support, as the website's export makes it.
  const support = async () => {
    const { storeId } = await syncCompany(app, {
      domain: 'shirut-li.example', url: 'https://shirut-li.example/', name: 'שירות לי', status: 'מה עובד היום:\n- עונה במייל.', tone: '', contact: {},
      plans: [{ key: 'one', product: 'shirut', title: 'שירות', monthly: 250, text: '250 ₪ לחודש, לא כולל מע״מ.', url: 'https://shirut-li.example/#price' }],
      faq: [], pages: [{ kind: 'about', title: 'מי אנחנו', url: 'https://shirut-li.example/', text: 'עסק קטן מחיפה.' }],
    });
    app.env.TORAN_SUPPORT_STORE = 'shirut-li.example';
    return storeId;
  };
  return {
    app, accounts, teder, outbox, write, event, toOwner, notes, three, oldList, toranStore, support,
    close: async () => {
      await accounts.close();
      await teder.close();
      await app.db.close();
    },
  };
}

test("the signature is Teder's: six lines (direction, time, nonce, method, path, body hash) under one HMAC; stale, changed, turned around or replayed is refused", () => {
  const body = '{"a":1}';
  const nonce = 'abcdefghijklmnop';
  const want = `t=1700000000,n=${nonce},s=${createHmac('sha256', SECRET).update(['toran->teder', 1700000000, nonce, 'POST', '/internal/assistant/customers/7/posts/p1/approve', createHash('sha256').update(body).digest('hex')].join('\n')).digest('hex')}`;
  assert.equal(signature(SECRET, { dir: DIR.out, method: 'POST', path: '/internal/assistant/customers/7/posts/p1/approve', body, t: 1700000000, nonce }), want, "the string Teder's docs/assistant-api.md gives");
  const h = { 'x-of-signature': signature(SECRET, { dir: DIR.in, method: 'POST', path: '/x', body, t: 1700000000 }) };
  assert.equal(verify(SECRET, h, 'POST', '/x', body, 1700000400), 'stale');
  assert.equal(verify(SECRET, h, 'POST', '/x', '{"a":2}', 1700000100), 'bad_signature');
  assert.equal(verify(SECRET, h, 'GET', '/x', body, 1700000100), 'bad_signature');
  assert.equal(verify(SECRET, signedHeaders(SECRET, 'POST', '/x', body, 1700000000), 'POST', '/x', body, 1700000100), 'bad_signature', 'a request signed toran->teder is not an event');
  assert.equal(verify(null, h, 'POST', '/x', body, 1700000100), 'not_configured');
  assert.equal(verify(SECRET, h, 'POST', '/x', body, 1700000100), null);
  assert.equal(verify(SECRET, h, 'POST', '/x', body, 1700000100), 'replay', 'the same nonce twice');
});

test('identity: an unknown number is told it is not linked (once an hour); a link code links it, and says where Teder is managed; accounts down acts for nobody', async () => {
  const s = await setup();
  try {
    const r = await s.write('אשר את 1', OTHER);
    assert.equal(r.action, 'owner_line');
    assert.match(s.outbox.at(-1)!.text, /המספר הזה לא מחובר לחשבון ב-OpenFrequency/);
    assert.match(s.outbox.at(-1)!.text, /https:\/\/accounts\.test/);
    await s.write('שוב', OTHER);
    assert.equal(s.outbox.filter((m) => m.to === OTHER).length, 1, 'said once, not to every message');
    assert.equal(s.teder.calls.length, 0, 'nothing reached Teder for a number nobody vouched for');

    // The number proves itself by sending accounts' code from itself. A workspace with Teder alone hears where Teder
    // is managed, and nothing about posts or messages coming here.
    s.accounts.code('LINK-ABCDEF', { workspace: WS, products: ['teder'], optIn: true });
    const linked = await s.write('היי, LINK-abcdef', OTHER);
    assert.equal(linked.action, 'owner_line');
    assert.deepEqual(s.accounts.calls.find((c) => c.path === '/internal/owner-phone/claim')!.body, { code: 'LINK-ABCDEF', phone: OTHER });
    const text = s.outbox.at(-1)!.text;
    assert.ok(text.startsWith(DISCLOSURE), 'the first message to the number says it is a bot');
    assert.equal(text, `${DISCLOSURE}\n\nהמספר הזה מחובר עכשיו לחשבון של עסק ${WS}. ${tederHere(DASHBOARD)}`);
    assert.doesNotMatch(text, /אשלח|הפסק|פוסטים חדשים/);
    await s.write('LINK-ABCDEF', OTHER);
    assert.match(s.outbox.at(-1)!.text, /הקוד הזה כבר שימש/);

    // A workspace with Toran hears it can write about the store.
    s.accounts.code('LINK-BCDEFG', { workspace: 8, products: ['toran'], optIn: false });
    await s.write('LINK-BCDEFG', '972500000126');
    assert.equal(s.outbox.at(-1)!.text, `${DISCLOSURE}\n\nהמספר הזה מחובר עכשיו לחשבון של עסק 8. אפשר לכתוב לי כאן על החנות.`);

    // Accounts not answering: nobody is an owner, and the line says to try later.
    s.accounts.down = true;
    s.teder.add({ id: 11, workspace: WS, hook: 'x' });
    const down = await s.write('אשר את 1', OTHER);
    assert.equal(s.teder.calls.length, 0);
    assert.match(s.outbox.at(-1)!.text, /משהו אצלנו לא עובד כרגע/);
    assert.ok(down);

    // A closed workspace is not linked.
    s.accounts.down = false;
    s.accounts.link({ phone: OWNER, workspace: WS, disabled: true });
    await s.write('מה המצב?');
    assert.match(s.outbox.at(-1)!.text, /לא מחובר/);
  } finally {
    await s.close();
  }
});

test('with TORAN_SUPPORT_STORE, a number nobody linked gets our support agent on the owner line, and a reply from the inbox goes out from the line', async () => {
  const script: Script = (req) => (lastResult(req) ? say('תורן עולה 250 ₪ לחודש, לא כולל מע״מ.') : toolUse('get_plans', {}));
  const s = await setup(script);
  try {
    const storeId = await s.support();
    const r = await s.write('כמה זה עולה?', OTHER);
    assert.equal(r.storeId, storeId);
    const out = s.outbox.filter((m) => m.to === OTHER);
    assert.equal(out.length, 1);
    assert.equal(out[0].text, `היי, אני תורן, הבוט של שירות לי.\n\nתורן עולה 250 ₪ לחודש, לא כולל מע״מ.`, 'our support says it is a bot');
    assert.equal(out[0].from, LINE, 'the answer goes out from the owner line');
    const conv = await s.app.db.one<any>('SELECT c.id, a.status, a.external_id FROM conversations c JOIN channel_accounts a ON a.id = c.account_id WHERE c.store_id = $1 AND c.peer = $2', [storeId, OTHER]);
    assert.deepEqual([conv.status, conv.external_id], ['line', LINE]);
    assert.equal(await accountFor(s.app, 'whatsapp', LINE), null, 'the line is never a store\'s own account, so owners are not answered as support');

    const d = await ownerReply(s.app, conv.id, 'אני כאן, מה הכתובת של החנות?', 'operator');
    assert.ok(d.ok);
    assert.equal(s.outbox.at(-1)!.from, LINE, 'a reply from the inbox goes out from the owner line, not the demo number');

    // Without the setting, the line says "not linked" as before.
    delete s.app.env.TORAN_SUPPORT_STORE;
    await s.write('שוב אני', '972500000125');
    assert.match(s.outbox.at(-1)!.text, /לא מחובר לחשבון/);
  } finally {
    await s.close();
  }
});

test('an owner with Teder and no Toran store is our support\'s, like anyone: "אשר את 1" approves nothing, reaches no assistant, and leaves nothing of theirs on the line', async () => {
  const script: Script = (req) => (lastResult(req) ? say('את המצגות מאשרים בלוח הבקרה של תדר.') : toolUse('get_plans', {}));
  const s = await setup(script);
  try {
    const storeId = await s.support();
    s.accounts.link({ phone: OWNER, workspace: WS });
    s.three();
    await s.oldList([11, 12, 13]);
    const r = await s.write('אשר את 1 ו-3, את 2 תעשה קצר יותר');
    assert.equal(r.storeId, storeId, "our support's store answered");
    assert.equal(r.action, 'owner_line');
    assert.equal(s.teder.calls.length, 0, 'nothing was asked of Teder: nothing approved, nothing sent back');
    assert.equal(s.toOwner().at(-1)!.text, 'היי, אני תורן, הבוט של שירות לי.\n\nאת המצגות מאשרים בלוח הבקרה של תדר.', "the support's own answer");
    assert.equal(s.toOwner().at(-1)!.from, LINE);
    assert.ok(await s.app.db.one('SELECT 1 FROM conversations WHERE store_id = $1 AND peer = $2', [storeId, OWNER]), 'in our support inbox');
    assert.equal((await s.app.db.one<any>('SELECT COUNT(*)::int AS n FROM assistant_messages WHERE phone = $1', [OWNER])).n, 0, 'no chat with the assistant');
    assert.equal(await s.app.db.one('SELECT 1 FROM owner_numbers WHERE phone = $1', [OWNER]), null, 'not remembered as an owner on the line, so the operator answering from our phone lands in support');

    // "הצג" and "סטטוס", the old templates' buttons, are our support's too.
    await s.write('הצג');
    await s.write('סטטוס');
    assert.equal(s.teder.calls.length, 0);
  } finally {
    await s.close();
  }
});

test('without our support, an owner with Teder alone is told once an hour where Teder is managed, and a delivery twice is acted on once', async () => {
  const s = await setup();
  try {
    s.accounts.link({ phone: OWNER, workspace: WS });
    s.three();
    await s.oldList([11, 12, 13]);
    const r = await s.write('אשר את 1', OWNER, 'SM-dup');
    assert.equal(r.action, 'owner_line');
    assert.equal(r.reply, `${DISCLOSURE}\n\n${tederHere(DASHBOARD)}`, 'said by the bot');
    assert.equal(tederHere(DASHBOARD), `את המצגות של תדר מאשרים עכשיו רק בלוח הבקרה של תדר: ${DASHBOARD}. שם גם מתקנים אותן ורואים מה עלה.`);
    assert.deepEqual(s.toOwner().map((m) => m.text), [r.reply]);
    assert.equal((await s.write('אשר את 1', OWNER, 'SM-dup')).action, 'duplicate');
    await s.write('הפסק');
    await s.write('שלח');
    assert.equal(s.toOwner().length, 1, 'once an hour, then silence');
    assert.equal(s.teder.calls.length, 0, 'Teder was never asked');
    assert.equal(s.accounts.calls.filter((c) => c.path.endsWith('/consent')).length, 0);
    // A TEDER_URL of the server's own is the address said.
    s.app.env.TEDER_URL = 'https://teder.example.test/';
    await s.app.db.query("DELETE FROM events WHERE kind = 'owner_line_teder'");
    await s.write('הצג');
    assert.equal(s.toOwner().at(-1)!.text, `${DISCLOSURE}\n\n${tederHere('https://teder.example.test')}`);
  } finally {
    await s.close();
  }
});

test("none of Teder's news goes to WhatsApp: every event type ends with nothing sent, no template, and nothing asked of accounts or Teder, inside the 24 hours and out", async () => {
  const s = await setup(() => say('שלום'));
  try {
    assert.equal(TEDER_ON_WHATSAPP, false);
    await s.toranStore();
    s.accounts.link({ phone: OWNER, workspace: WS, products: ['teder', 'toran'] });
    await s.write('היי'); // the owner wrote: the 24 hours are open, and that is not a reason either
    const before = s.toOwner().length;
    const asked = s.accounts.calls.length;
    const off = { skipped: 'teder_on_dashboard' };
    for (const p of s.three()) assert.deepEqual((await s.event('post.ready', { post: p, redoOf: null })).result, off);
    assert.deepEqual(await handleTederReady(s.app, WS), off);
    s.teder.add({ id: 21, workspace: WS, hook: 'מה לאכול לפני מרתון', status: 'approved', slides: [['a', ''], ['b', '']], caption: 'כיתוב' });
    const post = { id: '21', coverLine: 'מה לאכול לפני מרתון' };
    assert.deepEqual((await s.event('post.reminder', { post, delivery: 'by_hand', platforms: { tiktok: 'by_hand' }, sound: null })).result, off);
    assert.deepEqual((await s.event('post.unposted', { post, delivery: 'by_hand', platforms: { instagram: 'by_hand' }, minutesLate: 61 })).result, off);
    assert.deepEqual((await s.event('post.published', { post, tiktokUrl: 'https://www.tiktok.com/@x/video/1' })).result, off);
    assert.deepEqual((await s.event('quota.low', QUOTA)).result, off);
    assert.deepEqual((await s.event('weekly.summary', WEEK)).result, off);
    // Outside the 24 hours, with every template's SID set and Meta's names listed: still nothing.
    await s.app.db.query("UPDATE owner_numbers SET last_inbound_at = now() - interval '25 hours'");
    s.app.env.META_TEMPLATES = Object.keys(TEMPLATES).join(',');
    assert.deepEqual((await s.event('quota.low', QUOTA)).result, off);
    assert.deepEqual((await s.event('weekly.summary', WEEK)).result, off);

    assert.equal(s.toOwner().length, before, 'nothing was sent to the owner');
    assert.ok(!s.outbox.some((m) => m.template), 'no template went to anyone');
    assert.deepEqual(await s.notes(), [], 'not even an attempt');
    assert.equal(s.teder.calls.length, 0, 'Teder was not asked for a list or a bundle');
    assert.equal(s.accounts.calls.length, asked, "accounts was not asked for the workspace's numbers");
    assert.equal((await s.app.db.one<any>("SELECT COUNT(*)::int AS n FROM jobs WHERE kind = 'teder_ready'")).n, 0, 'no list gathered');

    // The one function that starts a message to an owner refuses too, whatever it is handed.
    const own = await ownerByPhone(s.app, OWNER);
    assert.ok(own.ok);
    const n = s.outbox.length;
    assert.equal(await pushToOwner(s.app, own.owner, { kind: 'quota.low', eventId: 'x1', workspaceId: WS, session: [{ text: 'בדיקה' }], template: { name: 'teder_quota_low', vars: ['8 מתוך 40 הצעות למצגות'] } }), 'skipped');
    assert.equal(s.outbox.length, n);

    // The templates stay on file as what Meta approved, marked as not sent (docs/whatsapp-templates.md, made from them).
    const doc = readFileSync(path.join(import.meta.dirname, '..', 'docs', 'whatsapp-templates.md'), 'utf8');
    assert.ok(doc.endsWith(templatesDoc()), 'docs/whatsapp-templates.md is the templates as submitted (node scripts/templates-doc.ts)');
    assert.match(doc.slice(0, 600), /not sent since 2026-11-02/i);
  } finally {
    await s.close();
  }
});

test("Teder's events still come in signed, from this machine only, once each, and their job sends nothing", async () => {
  const s = await setup();
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  server.on('request', createHandler(s.app, { port }));
  const path = '/internal/teder/events';
  const post = (raw: string, headers: Record<string, string>) => fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: raw });
  try {
    s.accounts.link({ phone: OWNER, workspace: WS });
    // As Teder sends it: its body, X-OF-Event, and the signature in the direction teder->toran.
    const signed = (raw: string, secret = SECRET, t?: number) => ({ 'x-of-event': 'quota.low', 'x-of-signature': signature(secret, { dir: DIR.in, method: 'POST', path, body: raw, ...(t ? { t } : {}) }) });
    const ev = JSON.stringify({ id: 'evt_signed_1', type: 'quota.low', at: '2026-10-24T09:00:00.000Z', sentAt: '2026-10-24T09:00:01.000Z', customer: WS, data: QUOTA });
    assert.equal((await post(ev, signed(ev, 'wrong-secret-000000000000000000000000'))).status, 401);
    assert.equal((await post(ev, signed(ev, SECRET, Math.floor(Date.now() / 1000) - 600))).status, 401, 'stale');
    assert.equal((await post(ev, signedHeaders(SECRET, 'POST', path, ev))).status, 401, 'a request signed toran->teder is not an event');
    assert.equal((await post(ev, { ...signed(ev), 'x-forwarded-for': '1.2.3.4' })).status, 403, 'never through Caddy');
    const ok = await post(ev, signed(ev));
    assert.equal(ok.status, 200, 'acknowledged, so Teder does not send it again');
    assert.equal((await post(ev, signed(ev))).status, 200, 'again (a retry, a new nonce): acknowledged');
    assert.equal((await s.app.db.one<any>("SELECT COUNT(*)::int AS n FROM jobs WHERE kind = 'teder_event'")).n, 1, 'and kept once');
    const bad = JSON.stringify({ id: 'evt_x', type: 'post.deleted', customer: WS, data: {} });
    assert.equal((await post(bad, signed(bad))).status, 400);
    await drain(s.app);
    const job = await s.app.db.one<any>("SELECT status FROM jobs WHERE kind = 'teder_event'");
    assert.equal(job.status, 'done');
    assert.equal(s.toOwner().length, 0, 'nothing went to the owner');
    assert.equal(s.teder.calls.length, 0);
  } finally {
    server.close();
    await s.close();
  }
});

test('"הפסק" is still kept as the owner\'s word (here and in accounts) and says where Teder is; "התחל" turns nothing on', async () => {
  const s = await setup(() => say('שלום'));
  try {
    await s.toranStore();
    s.accounts.link({ phone: OWNER, workspace: WS, products: ['teder', 'toran'] });
    await s.write('הפסק');
    assert.equal(s.outbox.at(-1)!.text, `${DISCLOSURE}\n\nרשמתי, ומתדר לא יגיעו אליכם הודעות לכאן. ${tederHere(DASHBOARD)}`);
    assert.deepEqual(s.accounts.calls.filter((c) => c.path.endsWith('/consent')).map((c) => c.body), [{ phone: OWNER, optIn: false, source: 'whatsapp' }]);
    assert.ok((await s.app.db.one<any>('SELECT opted_out_at FROM owner_numbers WHERE phone = $1', [OWNER])).opted_out_at, 'kept here too');

    await s.write('התחל');
    assert.equal(s.outbox.at(-1)!.text, `מתדר כבר לא נשלחות הודעות לוואטסאפ. ${tederHere(DASHBOARD)}`);
    assert.equal(s.accounts.calls.filter((c) => c.path.endsWith('/consent')).length, 1, 'no opt-in was recorded');
    assert.ok((await s.app.db.one<any>('SELECT opted_out_at FROM owner_numbers WHERE phone = $1', [OWNER])).opted_out_at, 'the stop still stands');
    assert.equal(s.teder.calls.length, 0);
  } finally {
    await s.close();
  }
});

test('the limit: messages from one number in ten minutes', async () => {
  const s = await setup((_req, call) => say(`תשובה ${call}`));
  try {
    await s.toranStore();
    s.accounts.link({ phone: OWNER, workspace: WS, products: ['toran'] });
    for (let i = 0; i < OWNER_PER_10_MIN + 3; i++) await s.write(`שאלה ${i}`);
    const limitLines = s.toOwner().filter((m) => /קיבלתי הרבה הודעות ברצף/.test(m.text));
    assert.equal(limitLines.length, 1, 'said once, then silence');
  } finally {
    await s.close();
  }
});

test('an owner of a Toran store with Teder: the model has Toran\'s tools only, a reply about Teder\'s posts is told where the dashboard is, and Toran\'s "כן" still answers its own offer', async () => {
  const reqs: TurnReq[] = [];
  const s = await setup((req, call) => {
    reqs.push(req);
    return call === 0 ? toolUse('store_overview', { days: 1 }) : say('היום לא היו שיחות.');
  });
  try {
    const store = await s.toranStore();
    s.accounts.link({ phone: OWNER, workspace: WS, products: ['teder', 'toran'] });
    const r = await s.write('מה קרה היום בחנות? ואיך המצגות?');
    assert.equal(r.action, 'assistant');
    assert.match(s.outbox.at(-1)!.text, /היום לא היו שיחות\./);
    assert.equal((await s.app.db.one<any>("SELECT store_id FROM assistant_messages WHERE role = 'owner' ORDER BY id DESC LIMIT 1")).store_id, store);
    const tools = new Set(reqs.flatMap((q) => q.tools.map((t) => t.name)));
    assert.ok(tools.has('store_overview'));
    assert.ok(![...tools].some((t) => t.startsWith('teder_')), `no Teder tool: ${[...tools].join(', ')}`);
    assert.ok(reqs.every((q) => !/Teder/.test(q.system.map((p) => p.text).join('\n'))), 'Teder is not in the prompt');

    // A list the owner was shown before the switch: a reply to it approves nothing, and says where to approve.
    s.three();
    await s.oldList([11, 12, 13]);
    const calls = reqs.length;
    const all = await s.write('מאשר את כולן');
    assert.equal(all.action, 'owner_line');
    assert.equal(s.outbox.at(-1)!.text, tederHere(DASHBOARD));
    await s.write('אשר את 4');
    assert.equal(s.outbox.at(-1)!.text, tederHere(DASHBOARD), 'a number past the list too');
    await s.write('הצג');
    assert.equal(s.outbox.at(-1)!.text, tederHere(DASHBOARD));
    assert.equal(reqs.length, calls, 'read in code, no model call');
    assert.equal(s.teder.calls.length, 0, 'nothing reached Teder');

    // An offer of Toran's, newer than the list: "כן" is Toran's.
    await s.app.db.query("INSERT INTO assistant_actions (store_id, kind, params, summary) VALUES ($1, 'resume', '{\"conversation_id\": 0}', 'להחזיר את תורן')", [store]);
    await s.write('כן');
    assert.equal((await s.app.db.one<any>('SELECT status FROM assistant_actions')).status, 'done');
    assert.equal(s.teder.calls.length, 0);
  } finally {
    await s.close();
  }
});

test('the owner of a Toran store reaches the assistant from the demo number too, once accounts verified the number; an owner with Teder alone does not', async () => {
  const s = await setup((_req, call) => (call === 0 ? toolUse('store_overview', { days: 1 }) : say('היום לא היו שיחות.')));
  try {
    await s.app.db.query("INSERT INTO stores (domain, url, name, platform, source, slug, workspace_id, owner_phones) VALUES ('t.example', 'https://t.example/', 'ט', 'shopify', 'seed', 't-x1', $1, '{972500000124}')", [WS]);
    s.accounts.link({ phone: OWNER, workspace: WS, products: ['toran'] });
    const r = await handleInbound(s.app, { channel: 'whatsapp', from: OWNER, text: 'מה קרה היום?', id: `d${seq++}`, at: Date.now(), to: '972500000999' });
    assert.equal(r.action, 'assistant');
    assert.match(String(r.reply), /היום לא היו שיחות/);
    // A number typed on the dashboard long ago (stores.owner_phones) is not verified: it is a customer on the demo number.
    const typed = await handleInbound(s.app, { channel: 'whatsapp', from: OTHER, text: 'מה קרה היום?', id: `d${seq++}`, at: Date.now(), to: '972500000999' });
    assert.equal(typed.action, 'no_binding');
    // An owner whose workspace has Teder alone, on the demo number: where Teder is managed, and nothing at Teder.
    s.accounts.link({ phone: '972500000126', workspace: 9 });
    const teder = await handleInbound(s.app, { channel: 'whatsapp', from: '972500000126', text: 'אשר את 1', id: `d${seq++}`, at: Date.now(), to: '972500000999' });
    assert.equal(teder.action, 'owner_line');
    assert.equal(teder.reply, `${DISCLOSURE}\n\n${tederHere(DASHBOARD)}`);
    assert.equal(s.teder.calls.length, 0);
  } finally {
    await s.close();
  }
});
