import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleInbound } from '../src/channels/route.ts';
import { simEmail } from '../src/channels/email.ts';
import { apartCustomer, idsIn, otherConversations, sameCustomer } from '../src/channels/customers.ts';
import { ROW_SQL } from '../src/web/inbox.ts';
import type { TurnReq } from '../src/agent/llm/types.ts';
import { defaultScript } from '../src/agent/llm/scripted.ts';
import { drain } from '../src/jobs/worker.ts';
import { customer } from './helpers.ts';
import { DOMAIN, mail, mailStore, STORE_WA, wa } from './mail-fixtures.ts';
import { serve } from './serve.ts';

const convOf = async (app: any, channel: string, peer: string) => (await app.db.one('SELECT id FROM conversations WHERE channel = $1 AND peer = $2 ORDER BY id DESC LIMIT 1', [channel, peer])).id as number;
const others = async (app: any, id: number) => (await otherConversations(app, id, ROW_SQL)).map((c) => [c.channel, c.peer, c.why]);

test('the ids a message gives: email addresses and phone numbers in every common form, as channel ids; nothing else', () => {
  assert.deepEqual(idsIn('המייל שלי Dana.K@Example.test, תודה.'), [{ channel: 'email', value: 'dana.k@example.test' }]);
  for (const t of ['050-000-0123', '0500000123', '050 000 0123', '+972 50-000-0123', '972500000123', '+972500000123', '00972500000123']) assert.deepEqual(idsIn(`הטלפון שלי ${t}`), [{ channel: 'whatsapp', value: '972500000123' }], t);
  assert.deepEqual(idsIn('call +44 7700 900123'), [{ channel: 'whatsapp', value: '447700900123' }]);
  for (const t of ['הזמנה 12345678', 'מחיר 189.90 ש"ח', 'מידה 40', 'קוד 0501', 'בתאריך 05/10/2026', '1234-5678-9012-3456']) assert.deepEqual(idsIn(t), [], t);
  assert.deepEqual(idsIn('dana@example.test 050-000-0123').map((i) => i.channel), ['email', 'whatsapp']);
});

test('one customer across channels: an address or number given in one conversation joins the other; the agent never reads it', async () => {
  const seen: TurnReq[] = [];
  const { app, storeId, address } = await mailStore({ whatsapp: true, script: (req, n) => (seen.push(req), defaultScript(req, n)) });
  // WhatsApp first: the customer gives their email address; the email they send later is the same customer.
  await handleInbound(app, wa('972500000123', 'יש לכם קערה? המייל שלי dana@example.test'));
  await handleInbound(app, mail(address, { text: 'שלחתי לכם גם בוואטסאפ, יש קערה בכחול?' }));
  const w = await convOf(app, 'whatsapp', '972500000123');
  const e = await convOf(app, 'email', 'dana@example.test');
  assert.deepEqual(await others(app, w), [['email', 'dana@example.test', 'said']]);
  assert.deepEqual(await others(app, e), [['whatsapp', '972500000123', 'wrote']]);
  assert.ok(!seen.some((q) => JSON.stringify(q.messages).includes('שלחתי לכם גם') && JSON.stringify(q.messages).includes('המייל שלי')), 'neither conversation is in the other\'s prompt');

  // An email first: a phone number in the signature joins a WhatsApp conversation that exists already.
  await handleInbound(app, wa('972500000124', 'מה שעות הפעילות?'));
  await handleInbound(app, mail(address, { from: 'Yossi <yossi@example.test>', subject: 'משלוח', text: 'מתי מגיע?\n\nיוסי\n050-000-0124' }));
  assert.deepEqual(await others(app, await convOf(app, 'whatsapp', '972500000124')), [['email', 'yossi@example.test', 'wrote']]);

  // Another email thread from the same address is the same customer, as always.
  await handleInbound(app, mail(address, { subject: 'נושא אחר', text: 'ועוד שאלה' }));
  assert.deepEqual((await others(app, e)).map((x) => x[2]).sort(), ['same', 'wrote']);

  // The store's own address and number, and our addresses, are nobody's.
  await handleInbound(app, wa('972500000125', `כתבתי ל-${address} ולמספר ${STORE_WA}, ולא ענו`));
  assert.deepEqual(await others(app, await convOf(app, 'whatsapp', '972500000125')), []);
  // An id someone else gave first stays with them: a second person naming dana's address joins nothing.
  await handleInbound(app, wa('972500000126', 'תשלחו לחברה שלי, dana@example.test'));
  assert.deepEqual(await others(app, await convOf(app, 'whatsapp', '972500000126')), []);
  assert.equal((await app.db.one<any>("SELECT COUNT(*)::int AS n FROM customer_ids WHERE store_id = $1 AND how = 'said'", [storeId])).n, 2, 'what was said: dana\'s address and yossi\'s number');
  await app.db.close();
});

test('the owner says "זה אותו לקוח" and "זה לא אותו לקוח"; what the owner split is never joined again by what someone said', async () => {
  const { app, address } = await mailStore({ whatsapp: true });
  await handleInbound(app, mail(address, { from: 'Bob <bob@example.test>', text: 'יש קערה?' }));
  await handleInbound(app, wa('972500000127', 'שלום, אני בוב ממקודם'));
  const e = await convOf(app, 'email', 'bob@example.test');
  const w = await convOf(app, 'whatsapp', '972500000127');
  assert.deepEqual(await others(app, e), []);
  assert.equal(await sameCustomer(app, e, w, 'owner'), true);
  assert.deepEqual(await others(app, e), [['whatsapp', '972500000127', 'owner']]);
  assert.deepEqual(await others(app, w), [['email', 'bob@example.test', 'owner']]);
  assert.equal((await app.db.one<any>("SELECT COUNT(*)::int AS n FROM audit WHERE action = 'same_customer'")).n, 1);

  assert.equal(await apartCustomer(app, e, w, 'owner'), true);
  assert.deepEqual(await others(app, e), []);
  assert.deepEqual(await others(app, w), []);
  await handleInbound(app, mail(address, { from: 'Bob <bob@example.test>', subject: 'שוב', text: 'הטלפון שלי 050-000-0127' }));
  assert.deepEqual(await others(app, w), [], 'split by the owner: what bob said does not join them back');
  assert.equal(await sameCustomer(app, e, w, 'owner'), true, 'the owner can join them again');
  assert.deepEqual(await others(app, w), [['email', 'bob@example.test', 'owner'], ['email', 'bob@example.test', 'owner']]);

  // Never a demo chat, or another store's conversation, or a conversation with itself.
  const code = (await app.db.one<{ demo_code: string }>('SELECT demo_code FROM stores LIMIT 1'))!.demo_code;
  await handleInbound(app, { from: '972500000777', text: `${code} שלום`, id: 'demo-1' });
  const demo = await convOf(app, 'whatsapp', '972500000777');
  assert.equal(await sameCustomer(app, e, demo, 'owner'), false);
  assert.equal(await sameCustomer(app, e, e, 'owner'), false);
  await app.db.close();
});

test('the customer\'s other conversations in the inbox over HTTP, with "זה אותו לקוח"; another workspace cannot join to theirs', async () => {
  const s = await serve();
  try {
    s.app.env.TORAN_CHANNELS = 'whatsapp,email';
    s.app.mail = simEmail({ domain: DOMAIN });
    s.login();
    const id = s.seeded.storeId;
    await s.post(`/lead/${id}/channels/email`, { _csrf: await s.csrf(), on: '1' });
    await s.app.db.query("INSERT INTO channel_accounts (store_id, channel, kind, external_id) VALUES ($1, 'whatsapp', 'sim', $2)", [id, STORE_WA]);
    const address = (await s.app.db.one<any>("SELECT external_id FROM channel_accounts WHERE store_id = $1 AND channel = 'email'", [id])).external_id;
    for (const [from, text, mid] of [['dana@example.test', 'יש לכם קערה?', '<c-1@example.test>'], ['roni@example.test', 'מה עם משלוח?', '<c-2@example.test>']]) await fetch(`${s.base}/mail/sim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from, to: [address], subject: text, text, message_id: mid }) });
    await drain(s.app, { kinds: ['mail_inbound'] });
    await handleInbound(s.app, wa('972500000128', 'זו דנה, כתבתי לכם במייל'));
    const e = await convOf(s.app, 'email', 'dana@example.test');
    const w = await convOf(s.app, 'whatsapp', '972500000128');
    const page = await (await s.get(`/chat/${w}`)).text();
    assert.match(page, /הלקוח הזה בשיחות אחרות/);
    assert.match(page, /אין ללקוח הזה שיחות אחרות/);
    assert.match(page, new RegExp(`<option value="${e}">`));
    assert.equal((await s.post(`/chat/${w}/same`, { _csrf: await s.csrf(`/chat/${w}`), other: String(e) })).status, 303);
    const joined = await (await s.get(`/chat/${w}`)).text();
    assert.match(joined, new RegExp(`href="/chat/${e}"[^]*חוברו ידנית`));
    assert.match(joined, /זה לא אותו לקוח/);
    assert.match(await (await s.get(`/chat/${e}`)).text(), new RegExp(`href="/chat/${w}"`));
    assert.equal((await s.post(`/chat/${w}/apart`, { _csrf: await s.csrf(`/chat/${w}`), other: String(e) })).status, 303);
    assert.ok(!new RegExp(`href="/chat/${e}"`).test(await (await s.get(`/chat/${w}`)).text().then((t) => t.split('הלקוח הזה בשיחות אחרות')[1] || '')));

    // A customer of another workspace: the conversation does not exist for them, nor joining to it.
    s.as(s.accounts.session(customer(9)).cookie);
    assert.equal((await s.post(`/chat/${w}/same`, { _csrf: await s.csrf(), other: String(e) })).status, 404);
  } finally {
    await s.close();
  }
});
