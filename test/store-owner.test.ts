import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleInbound } from '../src/channels/route.ts';
import { ownerEcho } from '../src/channels/waStore.ts';
import { forgetNumbers } from '../src/owners/storeLine.ts';
import { DISCLOSURE } from '../src/owners/notify.ts';
import { localPhone } from '../src/core/urls.ts';
import { defaultScript, scriptedClient, type Script } from '../src/agent/llm/scripted.ts';
import type { Block } from '../src/agent/llm/types.ts';
import type { Inbound } from '../src/channels/types.ts';
import { fakeOwnerAccounts } from './owner-fakes.ts';
import { mailStore, STORE_WA } from './mail-fixtures.ts';
import { customer } from './helpers.ts';
import { serve } from './serve.ts';

// The owner's assistant on the store's own WhatsApp number (src/owners/storeLine.ts; the owner, 2026-11-09: "the
// personal assistant should be the number of the business, and the owner messages it personally"). A phone accounts
// verified for the store's workspace writing to the store's number gets the assistant, about that store, through the
// store's adapter, and nothing of it reaches the customers' side; anyone else, the owner of another workspace too, is
// a customer as before. The workspace's numbers are asked once a minute, not on every customer's message. Every number
// here is a fictional one.

const WS = 7;
const OWNER = '972500000901';
const CUSTOMER = '972500000902';
const STRANGER = '972500000903'; // another workspace's owner
const LINE = '972500000888';
const B_WA = '972500000910';
let seq = 0;

const say = (text: string): Block[] => [{ type: 'text', text }];
// The assistant (its tools are the store's records) says one thing; the customers' agent answers as it always does.
const script: Script = (req, n) => (req.tools?.some((t) => t.name === 'store_overview') ? say('שקט היום בחנות, אין שאלות שמחכות לכם.') : defaultScript(req, n));
const wa = (from: string, text: string, account = STORE_WA): Inbound => ({ channel: 'whatsapp', from, text, id: `so-${seq++}`, account, at: Date.now() });

async function setup() {
  const s = await mailStore({ whatsapp: true });
  const { app, storeId } = s;
  app.llm = scriptedClient(script);
  const accounts = await fakeOwnerAccounts();
  Object.assign(app.env, accounts.env, { TORAN_ASSISTANT_WA: LINE });
  await app.db.query('UPDATE stores SET workspace_id = $2 WHERE id = $1', [storeId, WS]);
  accounts.link({ phone: OWNER, workspace: WS, products: ['toran'] });
  accounts.link({ phone: STRANGER, workspace: 8, products: ['toran'] });
  const listCalls = () => accounts.calls.filter((c) => c.path.startsWith('/internal/owner-phones')).length;
  const liveCalls = () => accounts.calls.filter((c) => c.path.startsWith('/internal/owner-phone?')).length;
  const convOf = (peer: string) => app.db.one<{ id: number }>('SELECT id FROM conversations WHERE peer = $1', [peer]);
  const done = async () => {
    await accounts.close();
    await app.db.close();
  };
  return { app, storeId, accounts, listCalls, liveCalls, convOf, done };
}

test('the owner writes to the store\'s own number: the assistant answers there, about this store, and no customer conversation opens', async () => {
  const s = await setup();
  try {
    const { app, storeId } = s;
    const r = await handleInbound(app, wa(OWNER, 'מה קרה היום?'));
    assert.equal(r.action, 'assistant');
    assert.equal(r.storeId, storeId);
    const out = app.wa.outbox!.filter((m) => m.to === OWNER);
    assert.equal(out.length, 1, 'one answer, through the store\'s own adapter');
    assert.ok(out[0].text.startsWith(DISCLOSURE), 'the first answer says a bot is writing');
    assert.match(out[0].text, /שקט היום בחנות/);
    const chat = await app.db.query<any>('SELECT role, via, phone, store_id FROM assistant_messages WHERE phone = $1 ORDER BY id', [OWNER]);
    assert.deepEqual(chat.map((m) => [m.role, m.via, m.store_id]), [['owner', 'whatsapp', storeId], ['assistant', 'whatsapp', storeId]]);
    // Nothing of the customers' side: no conversation, no customer id, no inbound counted as a customer's.
    assert.equal(await s.convOf(OWNER), null);
    assert.equal((await app.db.one<any>('SELECT COUNT(*)::int AS n FROM customer_ids WHERE value = $1', [OWNER]))!.n, 0);
    assert.equal((await app.db.one<any>("SELECT COUNT(*)::int AS n FROM events WHERE store_id = $1 AND kind = 'wa_in'", [storeId]))!.n, 0);

    // A customer on the same number is answered as before, and so is another workspace's owner: only this store's own counts.
    for (const who of [CUSTOMER, STRANGER]) {
      const c = await handleInbound(app, wa(who, 'יש לכם קערה כחולה?'));
      assert.notEqual(c.action, 'assistant', who);
      assert.ok(await s.convOf(who), `${who} is a customer conversation`);
    }
    assert.equal((await app.db.one<any>('SELECT COUNT(*)::int AS n FROM assistant_messages WHERE phone <> $1', [OWNER]))!.n, 0);

    // The workspace's numbers were asked once for all four messages; only the owner's own number was asked live.
    await handleInbound(app, wa(CUSTOMER, 'ועוד שאלה'));
    assert.equal(s.listCalls(), 1, 'one list, kept');
    assert.equal(s.liveCalls(), 1, 'customers cost no question about themselves');
    const again = await handleInbound(app, wa(OWNER, 'ומה עם אתמול?'));
    assert.equal(again.action, 'assistant');
    assert.equal(s.liveCalls(), 2, 'the owner is asked live before each answer, as on our number');
    assert.ok(!app.wa.outbox!.filter((m) => m.to === OWNER)[1].text.startsWith(DISCLOSURE), 'said once');
  } finally {
    await s.done();
  }
});

test('a number removed in accounts is a customer at once; accounts not answering keeps a known owner out of the inbox', async () => {
  const s = await setup();
  try {
    const { app } = s;
    assert.equal((await handleInbound(app, wa(OWNER, 'מה חדש?'))).action, 'assistant');
    // Removed a moment ago: the kept list still has it, the live question does not, and the list is asked again.
    s.accounts.owners.delete(OWNER);
    const r = await handleInbound(app, wa(OWNER, 'שלום'));
    assert.notEqual(r.action, 'assistant');
    assert.ok(await s.convOf(OWNER), 'a customer now');
    await handleInbound(app, wa(CUSTOMER, 'שלום'));
    assert.equal(s.listCalls(), 2);

    // Linked again, then accounts goes down: the number Toran saw write for the workspace is held as the owner's, with
    // the one line saying to try again, and no message of theirs joins the customers'.
    s.accounts.link({ phone: OWNER, workspace: WS, products: ['toran'] });
    forgetNumbers(app, WS);
    s.accounts.down = true;
    const before = (await app.db.one<any>('SELECT COUNT(*)::int AS n FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.peer = $1', [OWNER]))!.n;
    const d = await handleInbound(app, wa(OWNER, 'מה קורה?'));
    assert.equal(d.action, 'held');
    assert.match(app.wa.outbox!.filter((m) => m.to === OWNER).at(-1)!.text, /משהו אצלנו לא עובד כרגע/);
    assert.equal((await app.db.one<any>('SELECT COUNT(*)::int AS n FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.peer = $1', [OWNER]))!.n, before);
    // A customer meanwhile is answered as always, and accounts is not asked again on every message.
    const calls = s.accounts.calls.length;
    assert.ok(await handleInbound(app, wa(CUSTOMER, 'עוד שאלה')));
    assert.equal(s.accounts.calls.length, calls, 'no question while the list is known to be down');
  } finally {
    await s.done();
  }
});

test('an owner with two stores: the store\'s own number answers about that store; our number keeps working too', async () => {
  const s = await setup();
  try {
    const { app, storeId } = s;
    const b = (await app.db.one<{ id: number }>("INSERT INTO stores (domain, url, name, platform, source, slug, workspace_id) VALUES ('second.example', 'https://second.example/', 'השנייה', 'shopify', 'seed', 'second-x1', $1) RETURNING id", [WS]))!.id;
    await app.db.query("INSERT INTO channel_accounts (store_id, channel, kind, external_id, name) VALUES ($1, 'whatsapp', 'sim', $2, 'השנייה')", [b, B_WA]);
    await app.db.query("UPDATE stores SET updated_at = now() + interval '1 day' WHERE id = $1", [storeId]);
    const onB = await handleInbound(app, wa(OWNER, 'מה קרה היום?', B_WA));
    assert.equal(onB.action, 'assistant');
    assert.equal(onB.storeId, b, 'the store whose number it is, not the most recently active');
    // Our number: the workspace's most recently active store, as before.
    const ours = await handleInbound(app, { channel: 'whatsapp', from: OWNER, text: 'מה קרה היום?', id: `so-${seq++}`, at: Date.now(), to: LINE });
    assert.equal(ours.action, 'assistant');
    assert.equal(ours.storeId, storeId);
    assert.equal(await s.convOf(OWNER), null);
  } finally {
    await s.done();
  }
});

test('a store number on Zernio: the owner\'s answer goes out through Zernio\'s inbox send, in the owner\'s own thread', async () => {
  const s = await setup();
  try {
    const { app, storeId } = s;
    const ZID = 'a1b2c3d4e5f6a7b8c9d0e1f9';
    const THREAD = 'c0ffee00c0ffee00c0ffee09';
    Object.assign(app.env, { ZERNIO_API_KEY: 'sk_zernio_test_key' });
    const sent: { path: string; body: any }[] = [];
    app.graph = (async (input: any, init: any = {}) => {
      const u = new URL(String(input));
      sent.push({ path: u.pathname, body: init.body ? JSON.parse(String(init.body)) : null });
      return new Response(JSON.stringify({ success: true, data: { messageId: `mid.out-${sent.length}` } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    await app.db.query("UPDATE channel_accounts SET status = 'off' WHERE store_id = $1 AND channel = 'whatsapp'", [storeId]);
    const acc = (await app.db.one<{ id: number }>("INSERT INTO channel_accounts (store_id, channel, kind, external_id, name, status, meta) VALUES ($1, 'whatsapp', 'zernio', $2, 'x', 'active', $3::jsonb) RETURNING id", [storeId, ZID, JSON.stringify({ display_phone_number: '972500000905', coexistence: true })]))!.id;
    // Zernio's message.received keeps the thread before the job runs (zernio.ts keepThread).
    await app.db.query('INSERT INTO zernio_threads (account_id, peer, conversation_id) VALUES ($1, $2, $3)', [acc, OWNER, THREAD]);
    const r = await handleInbound(app, wa(OWNER, 'מה קרה היום?', ZID));
    assert.equal(r.action, 'assistant');
    assert.equal(sent.length, 1);
    assert.match(sent[0].path, new RegExp(`/inbox/conversations/${THREAD}/messages$`));
    assert.equal(sent[0].body.accountId, ZID);
    assert.match(sent[0].body.message, /שקט היום בחנות/);
    assert.equal(app.wa.outbox!.filter((m) => m.to === OWNER).length, 0, 'nothing through our own number');
    assert.equal(await s.convOf(OWNER), null);
  } finally {
    await s.done();
  }
});

test('coexistence echoes: the app writing to a customer is the owner answering; to the owner\'s own phone it opens no conversation', async () => {
  const s = await setup();
  try {
    const { app } = s;
    await handleInbound(app, wa(OWNER, 'היי'));
    // The WhatsApp Business app greets the owner's message: an echo to the owner's own number.
    const greet = await ownerEcho(app, { account: STORE_WA, to: OWNER, id: `echo-${seq++}`, text: 'שלום! נחזור אליך בהקדם', at: Date.now() });
    assert.equal(greet.action, 'to_owner');
    assert.equal(await s.convOf(OWNER), null);
    // The owner answering a customer from the app: in the inbox, and Toran steps back there, as before.
    const ans = await ownerEcho(app, { account: STORE_WA, to: CUSTOMER, id: `echo-${seq++}`, text: 'יש, במלאי', at: Date.now() });
    assert.equal(ans.action, 'owner_echo');
    assert.ok(await s.convOf(CUSTOMER));
    // The store's own number writing to itself is never its owner.
    assert.notEqual((await handleInbound(app, wa(STORE_WA, 'בדיקה'))).action, 'assistant');
  } finally {
    await s.done();
  }
});

test('the assistant\'s WhatsApp card: the business number once connected, our number meanwhile, the button while no phone is linked', async () => {
  assert.equal(localPhone('972500000901'), '050-000-0901');
  assert.equal(localPhone('97231234567'), '03-123-4567');
  assert.equal(localPhone('447700900123'), '+447700900123');
  const s = await serve();
  try {
    s.app.env.TORAN_ASSISTANT_WA = LINE;
    const id = s.seeded.storeId;
    await s.app.db.query('UPDATE stores SET workspace_id = 1 WHERE id = $1', [id]);
    s.as(s.accounts.session(customer(1)).cookie);
    const card = async () => (await (await s.get(`/lead/${id}/assistant`)).text()).split('לכתוב לעוזר מהוואטסאפ')[1].split('</section>')[0];

    // Not connected yet: it will be the business number, and meanwhile ours.
    let c = await card();
    assert.match(c, /אחרי שתחברו את <a href="\/lead\/\d+\/whatsapp">הוואטסאפ של העסק<\/a>/);
    assert.match(c, /עד אז כותבים לו למספר שלנו, <a href="https:\/\/wa\.me\/972500000888"><bdi dir="ltr" class="ltr">050-000-0888<\/bdi><\/a>/);
    assert.match(c, /לחבר מספר בחשבון/);
    assert.doesNotMatch(c, /—|–/);

    // Connected: the business number, in its local form; accounts says no phone is linked yet.
    s.accounts.ownerPhones(1, []);
    await s.app.db.query("INSERT INTO channel_accounts (store_id, channel, kind, external_id, name, status, meta) VALUES ($1, 'whatsapp', 'meta', '123456789012345', 'x', 'active', $2::jsonb)", [id, JSON.stringify({ display_phone_number: '972500000900' })]);
    c = await card();
    assert.match(c, /כותבים מהטלפון האישי שלכם למספר של העסק, <a href="https:\/\/wa\.me\/972500000900"><bdi dir="ltr" class="ltr">050-000-0900<\/bdi><\/a>, ותורן עונה לכם כעוזר/);
    assert.doesNotMatch(c, /למספר שלנו/);
    assert.match(c, /עוד לא חיברתם מספר/);
    assert.match(c, /class="btn sm"[^>]*>לחבר מספר בחשבון/);

    // Only the business number itself linked: it cannot write to itself, so the button stays.
    s.accounts.ownerPhones(1, ['972500000900']);
    c = await card();
    assert.match(c, /רק המספר של העסק עצמו/);
    assert.match(c, /לחבר מספר בחשבון/);

    // A personal phone linked: listed, and the button gives way to a quiet link.
    s.accounts.ownerPhones(1, ['972500000900', '972500000901']);
    c = await card();
    assert.match(c, /מחוברים עכשיו: <bdi dir="ltr" class="ltr">050-000-0901<\/bdi>\./);
    assert.doesNotMatch(c, /לחבר מספר בחשבון/);
    assert.match(c, /לנהל את המספרים בחשבון/);
  } finally {
    await s.close();
  }
});
