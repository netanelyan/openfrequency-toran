import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncCompany, type CompanyExport } from '../src/company.ts';
import { handleInbound } from '../src/channels/route.ts';
import { ownerReply } from '../src/channels/owner.ts';
import { ConnectError, connectWhatsapp, disconnectWhatsapp, OURS_HE, ownerEcho } from '../src/channels/waStore.ts';
import { oneNumber, oneNumberRoles, ownerWa } from '../src/channels/lines.ts';
import { opsData } from '../src/ops/api.ts';
import type { Script } from '../src/agent/llm/scripted.ts';
import type { TurnReq } from '../src/agent/llm/types.ts';
import { fakeOwnerAccounts } from './owner-fakes.ts';
import { testApp } from './helpers.ts';
import { serve } from './serve.ts';

// Toran on our own number (channels/lines.ts oneNumber, docs/company.md): OpenFrequency's one WhatsApp number,
// connected on our company store's WhatsApp page, is the owner line, the demo number and our support at once. Meta's
// Graph API is a stand-in; nothing here reaches Meta.

const APP_SECRET = 'test-app-secret-not-a-real-one';
const OUR_ID = '123123123123123';
const OUR_NUMBER = '972500000900';
const SHOP_ID = '456456456456456'; // a store's own number, whose Meta id Meta shows with our number (see below)
const WABA = '900800700600500';
const TOKEN = 'test-token-of-our-own-business';
const OWNER = '972500000901';
const CUSTOMER = '972500000902';
const STRANGER = '972500000903';
const WS = 7;
let seq = 0;

const META = { META_APP_ID: '1234567890', META_APP_SECRET: APP_SECRET, META_WA_CONFIG_ID: '555', META_WEBHOOK_VERIFY_TOKEN: 'verify-me', TORAN_SECRETS_KEY: 'k'.repeat(40) };
const COEXISTENCE = 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING';
const PRICE = 'החבילה הקטנה עולה 250 ₪ לחודש, לא כולל מע״מ.';

const company = (): CompanyExport => ({
  domain: 'shirut-li.example', url: 'https://shirut-li.example/', name: 'שירות לי', status: 'מה עובד היום:\n- עונה במייל.', tone: '', contact: {},
  plans: [{ key: 'small', product: 'shirut', title: 'שירות, חבילה קטנה', monthly: 250, text: '250 ₪ לחודש, לא כולל מע״מ.', url: 'https://shirut-li.example/#price' }],
  faq: [], pages: [{ kind: 'about', title: 'מי אנחנו', url: 'https://shirut-li.example/', text: 'עסק קטן מחיפה.' }],
});

type Call = { method: string; path: string; body: any };

/** Meta for our one number: the connect (code, subscription, the number, its token) and the sends. */
function fakeGraph() {
  const calls: Call[] = [];
  // Both ids show our number: the second is how a store's page would try to connect it under another id.
  const numbers: Record<string, string> = { [OUR_ID]: '+972 50-000-0900', [SHOP_ID]: '+972 50-000-0900' };
  const f = (async (input: any, init: any = {}) => {
    const u = new URL(String(input));
    const method = String(init.method || 'GET');
    const path = u.pathname.replace(/^\/v\d+\.\d+\//, '');
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, path, body });
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
    if (path === 'oauth/access_token') return json({ access_token: TOKEN, token_type: 'bearer' });
    if (path === 'debug_token') return json({ data: { is_valid: true, issued_at: 1, expires_at: 0, data_access_expires_at: 0, scopes: ['whatsapp_business_messaging'], granular_scopes: [] } });
    if ((init.headers as any)?.authorization !== `Bearer ${TOKEN}`) return json({ error: { message: 'bad token', code: 190 } }, 401);
    if (path === `${WABA}/subscribed_apps`) return json({ success: true });
    if (numbers[path] && method === 'GET') return json({ display_phone_number: numbers[path], verified_name: 'OpenFrequency', status: 'CONNECTED', id: path });
    if (path.endsWith('/messages') && method === 'POST') return json({ messaging_product: 'whatsapp', messages: [{ id: `wamid.out-${seq++}` }] });
    return json({ error: { message: `no route ${method} ${path}`, code: 1 } }, 404);
  }) as typeof fetch;
  return { f, calls, sent: () => calls.filter((c) => c.path.endsWith('/messages')) };
}

const lastToolResult = (req: TurnReq) => {
  const last = req.messages[req.messages.length - 1];
  return Array.isArray(last.content) && last.content.some((b: any) => b.type === 'tool_result');
};
// Our support quotes its plan; a demo store's agent says what its tools gave it.
const script: Script = (req) => (lastToolResult(req) ? [{ type: 'text', text: PRICE }] : [{ type: 'tool_use', id: `p${seq++}`, name: 'get_plans', input: {} }]);

async function setup() {
  const app = await testApp({ script });
  const accounts = await fakeOwnerAccounts();
  const g = fakeGraph();
  app.graph = g.f;
  // The one number, as everywhere else knows it today: the demo button, the owner line, the operator's phone.
  Object.assign(app.env, accounts.env, META, { DEMO_WA_NUMBER: OUR_NUMBER, TORAN_ASSISTANT_WA: OUR_NUMBER, TORAN_OWNER_WHATSAPP: OUR_NUMBER });
  const { storeId: support } = await syncCompany(app, company());
  const shop = (await app.db.one<{ id: number }>("INSERT INTO stores (domain, url, name, platform, source, slug, demo_code, page_built_at, ingested_at) VALUES ('a-shop.example', 'https://a-shop.example/', 'חנות', 'shopify', 'seed', 'a-shop-x1', 'DEMO-K7MQ', now(), now()) RETURNING id"))!.id;
  // As parseWebhook gives it: Meta names the number by its id, and says the number it was written to.
  const write = (text: string, from: string) => handleInbound(app, { channel: 'whatsapp', from, text, id: `wamid.in-${seq++}`, at: Date.now(), account: OUR_ID, to: OUR_NUMBER });
  const echo = (text: string, to: string) => ownerEcho(app, { account: OUR_ID, to, id: `wamid.echo-${seq++}`, text, at: Date.now() });
  const to = (phone: string) => g.sent().filter((c) => c.body.to === phone);
  return { app, accounts, g, support, shop, write, echo, to, close: async () => { await accounts.close(); await app.db.close(); } };
}

const connectOurs = (app: Awaited<ReturnType<typeof testApp>>, storeId: number, phoneId = OUR_ID) =>
  connectWhatsapp(app, storeId, { code: 'good-code', phoneId, wabaId: WABA, event: COEXISTENCE, by: 'operator' });

test('our one number: connected on the company store\'s page it plays all three roles by itself; a verified owner gets the assistant, a code the demo, anyone else our support, every answer from that number', async () => {
  const s = await setup();
  try {
    assert.equal(await oneNumber(s.app), null, 'nothing connected: no one-number mode');
    const out = await connectOurs(s.app, s.support);
    assert.equal(out.ours, true);
    assert.deepEqual((await oneNumberRoles(s.app))?.roles, ['owner', 'demo', 'support'], 'on by itself, with no setting');

    // (a) A business owner accounts verified: the assistant.
    s.accounts.link({ phone: OWNER, workspace: WS, products: ['toran'] });
    const a = await s.write('מה קורה?', OWNER);
    assert.equal(a.action, 'assistant');
    assert.match(s.to(OWNER).at(-1)!.body.text.body, /תורן/);

    // (b) A demo code binds, and the demo goes on from the same number.
    const b = await s.write('היי, אני רוצה לנסות את תורן של החנות DEMO-K7MQ', CUSTOMER);
    assert.deepEqual([b.action, b.storeId], ['bound', s.shop]);
    assert.equal((await s.write('יש לכם ספלים?', CUSTOMER)).storeId, s.shop, 'a phone bound to a demo store stays in the demo');

    // (c) Anyone else: our support, its own prompt and tools.
    const c = await s.write('כמה זה עולה?', STRANGER);
    assert.deepEqual([c.storeId, c.reply], [s.support, PRICE]);

    // Every answer went out through the Cloud API from our number, nothing through Twilio or the simulator.
    assert.ok(s.g.sent().length >= 4);
    assert.ok(s.g.sent().every((x) => x.path === `${OUR_ID}/messages`));
    assert.equal(s.app.wa.outbox!.length, 0);
    // Never answered as the company store's own WhatsApp: no conversation sits on the Meta account itself.
    assert.ok(!(await s.app.db.one('SELECT 1 FROM conversations WHERE account_id = $1', [out.accountId])));
    const sup = await s.app.db.one<any>('SELECT c.id, a.status FROM conversations c JOIN channel_accounts a ON a.id = c.account_id WHERE c.peer = $1', [STRANGER]);
    assert.equal(sup.status, 'line');

    // The inbox's replies, in the support and the demo conversation, go out from our number too.
    assert.ok((await ownerReply(s.app, sup.id, 'אני כאן, מה הכתובת של החנות?', 'operator')).ok);
    assert.deepEqual([s.g.calls.at(-1)!.path, s.g.calls.at(-1)!.body.to], [`${OUR_ID}/messages`, STRANGER]);
    const demoConv = (await s.app.db.one<any>("SELECT id FROM conversations WHERE store_id = $1 AND peer = $2 AND channel = 'whatsapp'", [s.shop, CUSTOMER])).id;
    assert.ok((await ownerReply(s.app, demoConv, 'כאן נורית, יש בכחול', 'operator')).ok);
    assert.equal(s.g.calls.at(-1)!.path, `${OUR_ID}/messages`);

    // The owner line's templates leave from this number as well (owners/notify.ts uses ownerWa).
    const wa = await ownerWa(s.app);
    assert.equal(wa.kind, 'meta_line');
    await wa.push(OWNER, { template: { name: 'teder_posts_ready', sid: 'teder_posts_ready', vars: ['3 מצגות'] }, from: OUR_NUMBER });
    assert.deepEqual([s.g.calls.at(-1)!.path, s.g.calls.at(-1)!.body.template.name], [`${OUR_ID}/messages`, 'teder_posts_ready']);

    // The operator's dashboard data says what the number does.
    const ops = await opsData(s.app);
    assert.deepEqual(ops.ourNumber?.roles.map((r) => r.key), ['owner', 'demo', 'support']);
    assert.equal(ops.ourNumber?.number, OUR_NUMBER);

    // Disconnected on the same page, the number is no longer ours to answer.
    await disconnectWhatsapp(s.app, s.support, 'operator');
    assert.equal(await oneNumber(s.app), null);
    assert.equal((await s.write('שלום?', '972500000904')).action, 'unknown_account');
  } finally {
    await s.close();
  }
});

test('our one number: the operator\'s answers from the phone land where each person is talking, and Toran steps back there', async () => {
  const s = await setup();
  try {
    await connectOurs(s.app, s.support);
    s.accounts.link({ phone: OWNER, workspace: WS, products: ['toran'] });
    await s.write('מה קורה?', OWNER);
    await s.write('DEMO-K7MQ', CUSTOMER);
    await s.write('כמה זה עולה?', STRANGER);
    const sent = s.g.sent().length;

    // The demo: in the demo conversation with the bound store, paused.
    const d = await s.echo('כאן נורית מ-OpenFrequency', CUSTOMER);
    const demoConv = (await s.app.db.one<any>("SELECT id FROM conversations WHERE store_id = $1 AND peer = $2", [s.shop, CUSTOMER])).id;
    assert.equal(d.conversationId, demoConv);
    assert.equal((await s.write('ומה עם משלוח?', CUSTOMER)).action, 'held');

    // Our support: in the support conversation, paused.
    const e = await s.echo('אני בודקת ומחזירה לך תשובה', STRANGER);
    const supConv = (await s.app.db.one<any>('SELECT c.id FROM conversations c JOIN channel_accounts a ON a.id = c.account_id WHERE c.peer = $1 AND a.status = $2', [STRANGER, 'line'])).id;
    assert.equal(e.conversationId, supConv);
    assert.equal((await s.write('תודה', STRANGER)).action, 'held');

    // An owner: in their chat with the assistant, which waits; "הפסק" still answers.
    const o = await s.echo('היי, ראיתי את ההודעה שלך', OWNER);
    assert.equal(o.action, 'owner_echo');
    assert.ok(await s.app.db.one("SELECT 1 FROM assistant_messages WHERE phone = $1 AND author = 'מהטלפון'", [OWNER]));
    assert.equal((await s.write('מעולה, תודה', OWNER)).action, 'held');
    assert.ok(await s.app.db.one("SELECT 1 FROM assistant_messages WHERE phone = $1 AND role = 'owner' AND text = 'מעולה, תודה'", [OWNER]), 'kept for the operator');
    assert.equal(s.g.sent().length, sent, 'nothing was sent while each was paused');
    assert.notEqual((await s.write('הפסק', OWNER)).action, 'held');

    // Someone who never wrote: a new support conversation, paused, so their answer waits for the operator.
    const n = await s.echo('היי, כאן OpenFrequency', '972500000905');
    assert.equal(n.action, 'owner_echo');
    assert.equal((await s.write('היי, מי זה?', '972500000905')).action, 'held');

    // The same echo twice is kept once.
    const twice = { account: OUR_ID, to: CUSTOMER, id: 'wamid.echo-twice', text: 'פעמיים', at: Date.now() };
    await ownerEcho(s.app, twice);
    assert.equal((await ownerEcho(s.app, twice)).action, 'duplicate');
  } finally {
    await s.close();
  }
});

test('our one number: a store\'s own page cannot connect it, by its Meta id or by the number Meta shows', async () => {
  const s = await setup();
  try {
    await connectOurs(s.app, s.support);
    for (const id of [OUR_ID, SHOP_ID]) {
      await assert.rejects(connectOurs(s.app, s.shop, id), (e: any) => e instanceof ConnectError && e.he === OURS_HE);
    }
    assert.ok(!(await s.app.db.one('SELECT 1 FROM channel_accounts WHERE store_id = $1', [s.shop])), 'nothing kept for the store');
    // Before our company store connected it, the number Meta shows is still known as ours.
    await disconnectWhatsapp(s.app, s.support, 'operator');
    await assert.rejects(connectOurs(s.app, s.shop, SHOP_ID), (e: any) => e instanceof ConnectError && e.he === OURS_HE);
  } finally {
    await s.close();
  }
});

test('our one number: a demo ends back into our support, when the person writes "תמיכה" or after 7 days, with one short line', async () => {
  const s = await setup();
  try {
    await connectOurs(s.app, s.support);
    // Asked: the binding goes, one line says so, and the next message is our support's.
    await s.write('DEMO-K7MQ', CUSTOMER);
    const asked = await s.write('תמיכה', CUSTOMER);
    assert.equal(asked.action, 'demo_ended');
    assert.match(s.to(CUSTOMER).at(-1)!.body.text.body, /^סגרנו את הדמו\. מעכשיו עונה לכם כאן התמיכה של OpenFrequency/);
    assert.ok(!(await s.app.db.one('SELECT 1 FROM wa_users WHERE phone = $1', [CUSTOMER])));
    const next = await s.write('כמה זה עולה?', CUSTOMER);
    assert.deepEqual([next.storeId, next.reply], [s.support, PRICE]);
    const conv = await s.app.db.one<any>("SELECT c.id FROM conversations c JOIN channel_accounts a ON a.id = c.account_id WHERE c.peer = $1 AND a.status = 'line'", [CUSTOMER]);
    assert.ok(await s.app.db.one("SELECT 1 FROM messages WHERE conversation_id = $1 AND role = 'agent' AND text LIKE 'סגרנו את הדמו%'", [conv.id]), 'the inbox shows the line');

    // Expired: the line, then our support answers the question that came with it.
    await s.write('DEMO-K7MQ', STRANGER);
    await s.app.db.query("UPDATE wa_users SET expires_at = now() - interval '1 hour' WHERE phone = $1", [STRANGER]);
    const before = s.to(STRANGER).length;
    const late = await s.write('כמה זה עולה?', STRANGER);
    assert.deepEqual([late.action, late.storeId], ['demo_ended', s.support]);
    const two = s.to(STRANGER).slice(before).map((c) => c.body.text.body);
    assert.match(two[0], /^עברו 7 ימים מאז שהדמו התחיל, אז סגרנו אותו\. מעכשיו עונה לכם כאן התמיכה/);
    assert.equal(two[1], PRICE);
    assert.ok(!(await s.app.db.one('SELECT 1 FROM wa_users WHERE phone = $1', [STRANGER])));

    // "עזרה" in the middle of a sentence is a question for the demo store, not the way out.
    await s.write('DEMO-K7MQ', '972500000906');
    assert.equal((await s.write('צריך עזרה עם הזמנה', '972500000906')).storeId, s.shop);
  } finally {
    await s.close();
  }
});

test('without our support set up, a demo still ends as before: "תמיכה" is a question for the store, and an expired demo says to press the button again', async () => {
  const s = await setup();
  try {
    // No company store connected and no TORAN_SUPPORT_STORE: the demo number of before (here the simulator).
    await handleInbound(s.app, { channel: 'whatsapp', from: CUSTOMER, text: 'DEMO-K7MQ', id: `sim-${seq++}`, at: Date.now() });
    assert.equal((await handleInbound(s.app, { channel: 'whatsapp', from: CUSTOMER, text: 'תמיכה', id: `sim-${seq++}`, at: Date.now() })).storeId, s.shop);
    await s.app.db.query("UPDATE wa_users SET expires_at = now() - interval '1 hour'");
    const r = await handleInbound(s.app, { channel: 'whatsapp', from: CUSTOMER, text: 'שלום', id: `sim-${seq++}`, at: Date.now() });
    assert.equal(r.action, 'no_binding');
    assert.match(String(r.reply), /לוחצים שוב על הכפתור בעמוד/);
  } finally {
    await s.close();
  }
});

test('the company store\'s WhatsApp page says what our number does, in order; a store\'s page does not', async () => {
  const s = await serve();
  const g = fakeGraph();
  try {
    Object.assign(s.app.env, META, { DEMO_WA_NUMBER: OUR_NUMBER, TORAN_ASSISTANT_WA: OUR_NUMBER });
    s.app.graph = g.f;
    const { storeId } = await syncCompany(s.app, company());
    s.login();
    const before = await (await s.get(`/lead/${storeId}/whatsapp`)).text();
    assert.match(before, /כשמחברים כאן את המספר של OpenFrequency/);
    await connectOurs(s.app, storeId);
    const html = await (await s.get(`/lead/${storeId}/whatsapp`)).text();
    assert.match(html, /מה המספר הזה עושה/);
    assert.ok(html.indexOf('הקו של בעלי העסקים') < html.indexOf('הדמו:') && html.indexOf('הדמו:') < html.indexOf('התמיכה שלנו'));
    assert.match(html, /זה המספר שלנו: תורן עונה בו לבעלי העסקים, לדמו ולתמיכה/);
    const shop = await (await s.get(`/lead/${s.seeded.storeId}/whatsapp`)).text();
    assert.doesNotMatch(shop, /מה המספר הזה עושה/);
  } finally {
    await s.close();
  }
});
