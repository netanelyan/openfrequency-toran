import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discover } from '../src/leads/discover.ts';
import { ingestStore } from '../src/ingest/pack.ts';
import { simEmail } from '../src/channels/email.ts';
import { storeAddress } from '../src/channels/config.ts';
import { enqueue } from '../src/jobs/queue.ts';
import { drain } from '../src/jobs/worker.ts';
import { DIGESTS_PER_DAY, nightEnd, RETRY_MINUTES, waitingDigest, waitingMail } from '../src/owners/waiting.ts';
import { handleInbound } from '../src/channels/route.ts';
import { turnOn } from '../src/channels/web.ts';
import { ownerReply } from '../src/channels/owner.ts';
import { handOver } from '../src/channels/store.ts';
import { setLive } from '../src/golive.ts';
import { STATE_SQL } from '../src/web/inbox.ts';
import { customer } from './helpers.ts';
import { serve } from './serve.ts';
import { israelWeekdayHour } from '../src/core/clock.ts';
import type { Block } from '../src/agent/llm/types.ts';
import { testApp } from './helpers.ts';
import { fakeOwnerAccounts } from './owner-fakes.ts';

// The owner hears when a customer waits (owners/waiting.ts; TORAN-READINESS.md P0-2): one email a burst, with each
// conversation's link, each conversation once in twelve hours, a few a day at most; the demo number is not the owner's.

const DOMAIN = 'in.toran.test';
let seq = 0;

async function shop() {
  const app = await testApp({ script: () => [{ type: 'text', text: 'כן.' } as Block] });
  const accounts = await fakeOwnerAccounts();
  Object.assign(app.env, accounts.env, { TORAN_CHANNELS: 'whatsapp,email', PUBLIC_BASE_URL: 'https://toran.example' });
  app.mail = simEmail({ domain: DOMAIN });
  await discover(app.db, (async function* () { yield { url: 'https://kli-cheres.example/', source: 'seed', detail: {} }; })(), { fetcher: app.fetcher, limit: 1 });
  const store = (await app.db.one<{ id: number; slug: string }>("SELECT id, slug FROM stores WHERE domain = 'kli-cheres.example'"))!;
  await ingestStore(app, store.id);
  await app.db.query('UPDATE stores SET workspace_id = 7, agent_live_at = NULL WHERE id = $1', [store.id]); // a customer's store, not switched on
  accounts.link({ phone: '972500000123', workspace: 7, products: ['toran'] });
  const address = storeAddress(store, DOMAIN);
  await app.db.query("INSERT INTO channel_accounts (store_id, channel, kind, external_id, name) VALUES ($1, 'email', 'sim', $2, 'כלי חרס')", [store.id, address]);
  const write = async (from: string, text: string) => {
    await enqueue(app.db, 'mail_inbound', simEmail({ domain: DOMAIN }).parse({ raw: JSON.stringify({ from, to: [address], subject: 'שאלה', text, message_id: `<w${seq++}@example.test>` }), form: {}, headers: {}, url: '' })![0]);
    await drain(app, { kinds: ['mail_inbound'] });
  };
  const digest = async () => {
    await app.db.query("UPDATE jobs SET run_at = now() - interval '1 second' WHERE kind = 'owner_waiting' AND status = 'queued'");
    await drain(app, { kinds: ['owner_waiting'] });
  };
  const toOwner = () => app.mail!.outbox!.filter((m: any) => m.to === 'owner7@example.test' || (Array.isArray(m.to) && m.to.includes('owner7@example.test')));
  return { app, accounts, storeId: store.id, write, digest, toOwner };
}

test('two customers waiting in a few minutes are one email to the owner, each with its link; the same ones are not told again', async () => {
  const s = await shop();
  try {
    await s.write('Dana <dana@example.test>', 'אפשר לאסוף מהמחסן?');
    await s.write('Yossi <yossi@example.test>', 'יש משלוח לאילת?');
    assert.equal((await s.app.db.query("SELECT 1 FROM jobs WHERE kind = 'owner_waiting' AND status = 'queued'")).length, 1, 'one digest asked for, not two');
    await s.digest();
    const mails: any[] = s.toOwner();
    assert.equal(mails.length, 1, 'one email');
    assert.match(mails[0].subject, /^2 לקוחות של .+ מחכים לתשובה שלכם$/);
    const ids = (await s.app.db.query<{ id: number }>('SELECT id FROM conversations ORDER BY id')).map((r) => r.id);
    for (const id of ids) assert.ok(mails[0].text.includes(`https://toran.example/chat/${id}`), `the link to ${id}`);
    assert.match(mails[0].text, /אפשר לאסוף מהמחסן\?/);

    // Again within twelve hours: the same conversations are not told again.
    await s.write('Dana <dana@example.test>', 'ועוד שאלה');
    await s.digest();
    assert.equal(s.toOwner().length, 1, 'nothing new to tell');
    const r = await waitingDigest(s.app, s.storeId);
    assert.equal(r.why, 'nothing new waits');
  } finally {
    await s.accounts.close();
    await s.app.db.close();
  }
});

test('the demo number is not the owner\'s; a day has at most a few emails; the night waits for the morning', async () => {
  const s = await shop();
  try {
    // A conversation on our demo number (no account): nothing asked for.
    const demo = (await s.app.db.one<{ id: number }>("INSERT INTO conversations (store_id, channel, peer) VALUES ($1, 'whatsapp', '972500000999') RETURNING id", [s.storeId]))!.id;
    const { notifyWaiting } = await import('../src/owners/waiting.ts');
    await notifyWaiting(s.app, s.storeId, demo);
    assert.equal((await s.app.db.query("SELECT 1 FROM jobs WHERE kind = 'owner_waiting'")).length, 0);

    for (let i = 0; i < DIGESTS_PER_DAY; i++) await s.app.db.query("INSERT INTO events (store_id, kind, data) VALUES ($1, 'owner_digest', '{}')", [s.storeId]);
    await s.write('Dana <dana@example.test>', 'שאלה');
    assert.equal((await waitingDigest(s.app, s.storeId)).why, 'enough emails today');
    assert.equal(s.toOwner().length, 0);

    // 23:30 Israel time waits for 07:00.
    const late = Date.parse('2026-11-08T21:30:00Z'); // 23:30 in Israel (UTC+2)
    const at = nightEnd(late);
    assert.equal(israelWeekdayHour(at).hour, 7);
    assert.equal(nightEnd(Date.parse('2026-11-08T10:00:00Z')), Date.parse('2026-11-08T10:00:00Z'), 'noon is now');
  } finally {
    await s.accounts.close();
    await s.app.db.close();
  }
});

test('the email says what each customer asked, or what Toran handed over when it is in Hebrew', () => {
  const m = waitingMail('כלי חרס', [{ id: 5, peer: 'x', channel: 'email', summary: 'the guard cut price: ...', last_q: 'כמה עולה?' }], 'https://toran.example');
  assert.equal(m.subject, 'לקוח של כלי חרס מחכה לתשובה שלכם');
  assert.match(m.text, /• כמה עולה\?\n  https:\/\/toran\.example\/chat\/5/);
  assert.doesNotMatch(m.text, /guard/, 'the English line for the operator stays out');
  const he = waitingMail('כלי חרס', [{ id: 6, peer: 'x', channel: 'email', summary: 'הלקוחה שואלת על איסוף', last_q: 'x' }], 'https://toran.example');
  assert.match(he.text, /הלקוחה שואלת על איסוף/);
});

/** The fictional store with its site chat on and on its site, in workspace 7, signed in as its owner. */
async function chatShop() {
  const s = await serve();
  const id = s.seeded.storeId;
  await s.app.db.query('UPDATE stores SET workspace_id = 7 WHERE id = $1', [id]);
  const acc = (await turnOn(s.app, id, 'test'))!;
  await s.app.db.query(`UPDATE channel_accounts SET meta = meta || '{"first_seen_at":"2026-11-01T00:00:00Z"}'::jsonb WHERE id = $1`, [acc.id]);
  s.as(s.accounts.session(customer(7)).cookie);
  let n = 0;
  const say = async (v: string, text: string) => handleInbound(s.app, { channel: 'web', from: v, text, id: `web:${acc.external_id}:${v}:${n++}`, account: acc.external_id } as any);
  const conv = async (v: string) => (await s.app.db.one<{ id: number }>("SELECT id FROM conversations WHERE channel = 'web' AND peer = $1", [v]))!.id;
  const waiting = async () => (await (await s.get('/waiting.json')).json()).chats as number;
  const told = async () => (await waitingDigest(s.app, id)).conversations;
  const token = async (conversation: number) => s.csrf(`/chat/${conversation}`);
  return { s, id, say, conv, waiting, told, token };
}

// The audit of 2026-11-12, P0-3: the customer's follow-up after the owner answered was held with no answer, counted as
// waiting only while the 12-hour pause ran, and told to nobody.
test('a customer who writes again after the owner answered waits for the owner past the pause and "להחזיר לתורן", until answered or marked handled, and the owner is told again', async () => {
  const c = await chatShop();
  try {
    const V = 'Abcdefghijklmnopqrstu3';
    await c.say(V, 'אפשר לאסוף מהסטודיו?');
    const id = await c.conv(V);
    await handOver(c.s.app, c.id, id, 'unknown', 'שאלה על איסוף', 'x');
    assert.equal(await c.told(), 1, 'the first handoff is told');
    await ownerReply(c.s.app, id, 'כן, בימים א-ה.', 'owner');
    assert.equal(await c.waiting(), 0, 'answered');
    await c.say(V, 'ואפשר לשלם במזומן?');
    assert.equal(await c.waiting(), 1, 'the follow-up waits');
    assert.equal(await c.told(), 1, 'and is told: a new wait in a conversation told before');
    // The pause ends, and nobody answered: still waiting.
    await c.s.app.db.query("UPDATE conversations SET agent_paused_until = now() - interval '1 minute' WHERE id = $1", [id]);
    assert.equal(await c.waiting(), 1, 'past the 12 hours');
    // "להחזיר לתורן" with a message waiting: said before, and the message stays the owner's.
    await ownerReply(c.s.app, id, 'עוד שאלה אליכם?', 'owner');
    await c.say(V, 'כן, יש חניה?');
    const page = await (await c.s.get(`/chat/${id}`)).text();
    assert.match(page, /data-confirm="תורן יענה מההודעה הבאה של הלקוח, וההודעה שמחכה עכשיו נשארת אצלכם בשיחות\./);
    const back = await c.s.post(`/chat/${id}/resume`, { _csrf: await c.token(id) }, { 'x-tn-ajax': '1' });
    assert.match((await back.json()).message, /ההודעה שמחכה עכשיו נשארת אצלכם בשיחות/);
    assert.equal(await c.waiting(), 1, 'after "להחזיר לתורן"');
    // Marked handled: done.
    await c.s.post(`/chat/${id}/settle`, { _csrf: await c.token(id) });
    assert.equal(await c.waiting(), 0);
  } finally {
    await c.s.close();
  }
});

// The audit of 2026-11-12, P0-4: on a store that does not answer, one note a conversation a day, so after "טיפלתי בזה"
// a same-day message waited for nobody.
test('on a store that does not answer, a message after "טיפלתי בזה" the same day waits again and is told; while one waits, no second note', async () => {
  const c = await chatShop();
  try {
    await setLive(c.s.app, c.id, true);
    await setLive(c.s.app, c.id, false);
    const V = 'Abcdefghijklmnopqrstu4';
    await c.say(V, 'היי, אתם פתוחים היום?');
    await c.say(V, 'יש מישהו?');
    const id = await c.conv(V);
    assert.equal((await c.s.app.db.one<any>('SELECT COUNT(*)::int AS n FROM messages WHERE conversation_id = $1 AND handoff IS NOT NULL', [id])).n, 1, 'one note while it waits');
    assert.equal(await c.waiting(), 1);
    assert.equal(await c.told(), 1);
    await c.s.post(`/chat/${id}/settle`, { _csrf: await c.token(id) });
    assert.equal(await c.waiting(), 0);
    await c.say(V, 'עדיין מחכה לתשובה, אתם פתוחים?');
    assert.equal(await c.waiting(), 1, 'waits again');
    assert.equal(await c.told(), 1, 'told again');
    const facts = /<p class="th-facts">([^]*?)<\/p>/.exec(await (await c.s.get(`/chat/${id}`)).text())![1];
    assert.match(facts, /מחכה לכם/, 'its own chip says it waits, never "answered alone"');
  } finally {
    await c.s.close();
  }
});

// The audit of 2026-11-12, P1-4: "טיפלתי בזה" on a conversation Toran handed over read "ענה לבד" on its chip, Today, the
// results and the month's email.
test('"טיפלתי בזה" counts with the owner\'s answers, never as Toran answering alone', async () => {
  const c = await chatShop();
  try {
    const V = 'Abcdefghijklmnopqrstu5';
    await c.say(V, 'אפשר החזר?');
    const id = await c.conv(V);
    await handOver(c.s.app, c.id, id, 'refund', 'מבקש החזר', 'x');
    await c.s.post(`/chat/${id}/settle`, { _csrf: await c.token(id) });
    const state = (await c.s.app.db.one<{ st: string }>(`SELECT ${STATE_SQL} AS st FROM conversations c WHERE c.id = $1`, [id]))!.st;
    assert.equal(state, 'fixed');
    assert.match(await (await c.s.get('/results')).text(), /<span class="l">תורן ענה לבד<\/span><span class="v ok">0<\/span>/);
  } finally {
    await c.s.close();
  }
});

test('a digest nobody could send is tried again in 15 minutes, under a key of its own', async () => {
  const s = await shop();
  try {
    await s.write('Dana <dana@example.test>', 'אפשר לאסוף מהמחסן?');
    await s.app.db.query("DELETE FROM jobs WHERE kind = 'owner_waiting'");
    s.app.mail = null as any;
    assert.equal((await waitingDigest(s.app, s.storeId)).why, 'email is off here');
    const retry = await s.app.db.one<any>("SELECT dedupe_key, run_at FROM jobs WHERE kind = 'owner_waiting' AND status = 'queued'");
    assert.match(String(retry?.dedupe_key), /^owner_waiting_retry:/);
    const due = nightEnd(Date.now() + RETRY_MINUTES * 60_000);
    assert.ok(Math.abs(new Date(retry.run_at).getTime() - due) < 2 * 60_000, 'in 15 minutes, or the morning');
  } finally {
    await s.accounts.close();
    await s.app.db.close();
  }
});

test('the email says why every message waits: Toran not switched on, paused, or not paid for; the pause is 12 hours; a Latin name takes a maqaf', () => {
  const list = [{ id: 5, peer: 'x', channel: 'email', summary: 'Toran is not switched on in this store', last_q: 'יש משלוח?' }];
  const never = waitingMail('My Store 10', list, 'https://toran.example', 'never');
  assert.equal(never.subject, 'לקוח של My Store 10 מחכה לתשובה שלכם');
  assert.match(never.text, /^לקוח כתב ל־My Store 10\. תורן עוד לא הופעל בחנות, אז ההודעה מחכה לכם\. מפעילים אותו בדף היום, ומשם הוא עונה לבד\./);
  assert.doesNotMatch(never.text, /לא מצא לה תשובה בטוחה/);
  assert.match(waitingMail('כלי חרס', list, 'https://toran.example', 'paused').text, /^לקוח כתב לכלי חרס\. תורן מושהה בחנות/);
  assert.match(waitingMail('כלי חרס', list, 'https://toran.example', 'unpaid').text, /כי התשלום על תורן עוד לא רשום אצלנו/);
  const handed = waitingMail('כלי חרס', list, 'https://toran.example');
  assert.match(handed.text, /^לקוח של כלי חרס מחכה לתשובה שלכם\. הנה במה מדובר, עם הקישור לשיחה:/);
  assert.match(handed.text, /תורן לא עונה בשיחה הזו 12 שעות, אלא אם מחזירים אותה אליו קודם/);
  assert.doesNotMatch(handed.text, /עד שתחזירו/);
});

// The audit of 2026-11-12, P1-6: the owner heard of a waiting customer by email only. Now also on WhatsApp, to a number
// accounts verified that agreed to hear from Toran: inside the 24 hours after it last wrote to us as a plain message,
// after them only as the template once it is approved (owners/templates.ts toran_customer_waiting).
test('a waiting customer reaches the owner\'s own WhatsApp too: a plain message inside the 24 hours, the approved template after them, each wait once', async () => {
  const s = await shop();
  try {
    const OWNER = '972500000123';
    await s.app.db.query("INSERT INTO owner_numbers (phone, workspace_id, user_id, products, checked_at, last_inbound_at) VALUES ($1, 7, 107, '{toran}', now(), now() - interval '1 hour')", [OWNER]);
    const toPhone = () => s.app.wa.outbox!.filter((m: any) => m.to === OWNER);
    await s.write('Dana <dana@example.test>', 'אפשר לאסוף מהמחסן?');
    await s.digest();
    assert.equal(toPhone().length, 1);
    const id = (await s.app.db.one<{ id: number }>("SELECT id FROM conversations WHERE peer = 'dana@example.test'"))!.id;
    assert.match(toPhone()[0].text, /^היי, אני תורן, הבוט של OpenFrequency\.\n\nלקוח של .+ מחכה לתשובה שלכם\.\nהוא כתב: "אפשר לאסוף מהמחסן\?"/);
    assert.ok(toPhone()[0].text.includes(`https://toran.example/chat/${id}`));
    // The same wait is not said again; a new customer is.
    await s.write('Dana <dana@example.test>', 'ועוד שאלה');
    await s.digest();
    assert.equal(toPhone().length, 1, 'the same wait, once');
    // After the 24 hours: only the approved template, and nothing while it is not.
    await s.app.db.query("UPDATE owner_numbers SET last_inbound_at = now() - interval '25 hours' WHERE phone = $1", [OWNER]);
    await s.write('Yossi <yossi@example.test>', 'יש משלוח לאילת?');
    await s.digest();
    assert.equal(toPhone().length, 1, 'no template approved: nothing on WhatsApp, the email still goes');
    s.app.env.TWILIO_TEMPLATES = `toran_customer_waiting=HX${'0'.repeat(32)}`;
    await s.write('Rina <rina@example.test>', 'מה שעות הפתיחה?');
    await s.digest();
    const t = toPhone().at(-1) as any;
    assert.equal(toPhone().length, 2);
    assert.equal(t.template, 'toran_customer_waiting');
    assert.deepEqual(t.vars.slice(1), ['מה שעות הפתיחה?']);
    assert.match(String(t.url), /^chats\?state=waiting$|^chat\/\d+$/, 'the button opens the conversation, or the waiting list');
  } finally {
    await s.accounts.close();
    await s.app.db.close();
  }
});
