import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simEmail } from '../src/channels/email.ts';
import { storeAddress } from '../src/channels/config.ts';
import { counted, monthOf, prevMonth, usageOf } from '../src/plans.ts';
import { customer } from './helpers.ts';
import { serve } from './serve.ts';

// The customer's dashboard (docs/customer.md): a store owner signed in to their workspace sees what
// openfrequency.co.il/toran sells them. Workspace 1 owns the fictional store, with its email connected.

const DOMAIN = 'in.toran.test';
let seq = 0;

async function shop() {
  const s = await serve();
  s.app.env.TORAN_CHANNELS = 'whatsapp,email';
  s.app.mail = simEmail({ domain: DOMAIN });
  const a = s.seeded.storeId;
  await s.app.db.query('UPDATE stores SET workspace_id = 1 WHERE id = $1', [a]);
  const store = (await s.app.db.one<{ id: number; slug: string }>('SELECT id, slug FROM stores WHERE id = $1', [a]))!;
  const account = (await s.app.db.one<{ id: number }>("INSERT INTO channel_accounts (store_id, channel, kind, external_id, name) VALUES ($1, 'email', 'sim', $2, 'כלי חרס') RETURNING id", [a, storeAddress(store, DOMAIN)]))!.id;
  const me = s.accounts.session(customer(1));
  s.as(me.cookie);
  return { s, a, account };
}

/** A conversation on the store's email: the customer's question, and the agent's answer (handed over, or not). */
async function thread(s: Awaited<ReturnType<typeof serve>>, storeId: number, account: number, question: string, { handoff = false, at = 'now()' } = {}) {
  const c = (await s.app.db.one<{ id: number }>(`INSERT INTO conversations (store_id, channel, peer, account_id, meta, last_at) VALUES ($1, 'email', 'dana@example.test', $2, '{"subject":"שאלה"}', ${at}) RETURNING id`, [storeId, account]))!.id;
  await s.app.db.query(`INSERT INTO messages (conversation_id, role, text, ext_id, at) VALUES ($1, 'customer', $2, $3, ${at})`, [c, question, `<q${seq++}@example.test>`]);
  await s.app.db.query(`INSERT INTO messages (conversation_id, role, text, handoff, at) VALUES ($1, 'agent', $2, $3::jsonb, ${at})`, [c, handoff ? 'את זה אני לא יודע. אני בודק עם החנות, ואחזור אליך כאן.' : 'כן, יש.', handoff ? JSON.stringify({ reason: 'unknown', summary: 'הלקוחה שואלת אם אפשר לאסוף מהמחסן' }) : null]);
  if (handoff) await s.app.db.query('UPDATE conversations SET handoffs = 1 WHERE id = $1', [c]);
  return c;
}

test('a customer\'s menu is the website\'s: Today, the inbox, what Toran knows, the assistant, the plan, the settings', async () => {
  const { s } = await shop();
  try {
    const page = await (await s.get('/')).text();
    for (const href of ['/', '/chats', '/knowledge', '/assistant', '/plan', '/settings']) assert.match(page, new RegExp(`<a href="${href.replace('/', '\\/')}"`), href);
    for (const href of ['/leads', '/review', '/followups']) assert.ok(!page.includes(`href="${href}"`), `no ${href}`);
    assert.match(page, /<span class="lbl">שיחות<\/span>/, 'the header counts conversations against the plan, not tokens');
    assert.ok(!/טוקנים/.test(page));
    assert.match(page, /הערוצים/);
    assert.match(page, /בשבועיים הראשונים אנחנו עוברים איתכם על השיחות/, 'the email was connected today');
    assert.equal((await s.get('/knowledge')).headers.get('location'), `/lead/${s.seeded.storeId}/knowledge`, 'one store goes straight to its page');
  } finally {
    await s.close();
  }
});

test('the inbox in the website\'s three words: waiting for you, answered alone, you fixed it; an answer is kept for next time', async () => {
  const { s, a, account } = await shop();
  try {
    const alone = await thread(s, a, account, 'יש קערה כחולה?');
    const asked = await thread(s, a, account, 'אפשר לאסוף מהמחסן?', { handoff: true });
    const today = await (await s.get('/')).text();
    assert.match(today, /הלקוחה שואלת אם אפשר לאסוף מהמחסן/);
    assert.match(today, /<b class="badge num" aria-label="1 מחכים">1<\/b>/, 'the inbox carries the waiting count');
    assert.match(today, new RegExp(`/chat/${alone}"`), 'a conversation nobody paused is among the recent ones (a NULL pause is not "waiting")');
    const waiting = await (await s.get('/chats?state=waiting')).text();
    assert.match(waiting, new RegExp(`/chat/${asked}"`));
    assert.ok(!waiting.includes(`/chat/${alone}"`));
    assert.match(await (await s.get('/chats?state=alone')).text(), new RegExp(`/chat/${alone}".*ענה לבד`, 's'));

    // The customer's view of a conversation: no tool calls, no cost; the answer can be kept.
    const page = await (await s.get(`/chat/${asked}`)).text();
    assert.match(page, /מחכה לכם/);
    assert.match(page, /name="learn" value="1" checked/);
    assert.match(page, /value="אפשר לאסוף מהמחסן\?"/);
    assert.ok(!/טוקנים|העברות|לליד/.test(page));
    const r = await s.post(`/chat/${asked}/reply`, { _csrf: await s.csrf(`/chat/${asked}`), text: 'כן, בימי ראשון עד חמישי, 9:00 עד 16:00.', learn: '1', question: 'אפשר לאסוף מהמחסן?' });
    assert.equal(r.status, 303);
    assert.equal(s.app.mail!.outbox!.at(-1)!.text, 'כן, בימי ראשון עד חמישי, 9:00 עד 16:00.');
    const faq = await s.app.db.one<any>('SELECT question, answer, conversation_id FROM faqs WHERE store_id = $1 AND conversation_id IS NOT NULL', [a]);
    assert.deepEqual(faq, { question: 'אפשר לאסוף מהמחסן?', answer: 'כן, בימי ראשון עד חמישי, 9:00 עד 16:00.', conversation_id: asked });
    assert.match(await (await s.get(`/chats?state=fixed`)).text(), new RegExp(`/chat/${asked}"`));
    assert.match(await (await s.get(`/lead/${a}/knowledge`)).text(), /כן, בימי ראשון עד חמישי/, 'the answer is on what Toran knows');

    // "טיפלתי בזה": handled without an answer from here.
    const other = await thread(s, a, account, 'יש הנחה לכמות?', { handoff: true });
    assert.match(await (await s.get('/chats?state=waiting')).text(), new RegExp(`/chat/${other}"`));
    assert.equal((await s.post(`/chat/${other}/settle`, { _csrf: await s.csrf(`/chat/${other}`) })).status, 303);
    assert.ok(!(await (await s.get('/chats?state=waiting')).text()).includes(`/chat/${other}"`));
  } finally {
    await s.close();
  }
});

test('the plan: this month\'s conversations on the store\'s own channels, the demo never counts, and the website\'s rule for moving', async () => {
  const { s, a, account } = await shop();
  try {
    await thread(s, a, account, 'שאלה ראשונה');
    await thread(s, a, account, 'שאלה שנייה');
    await thread(s, a, account, 'מלפני חודשיים', { at: "now() - interval '70 days'" });
    const demo = (await s.app.db.one<{ n: number }>("SELECT COUNT(*)::int AS n FROM conversations WHERE store_id = $1 AND account_id IS NULL AND channel = 'whatsapp'", [a]))!.n;
    assert.ok(demo > 0, 'the seeded demo chat is there');
    const n = await counted(s.app.db, [a]);
    assert.equal(n.get(a)!.get(monthOf()), 2);
    const plan = await (await s.get('/plan')).text();
    assert.match(plan, /חבילת חנות/);
    assert.match(plan, /<span class="v num">2<\/span>/);
    assert.match(plan, /מתוך 300/);
    assert.match(plan, /תזכורות על עגלה נטושה.*עוד לא פעיל/s, 'what is not built yet says so');
    assert.match(plan, /href="\/export\/conversations\.csv"/);
    assert.match(plan, /href="https:\/\/accounts\.test"/, 'the price and the invoices are in accounts');

    // The operator moves a store between plans; the customer sees it.
    s.login();
    assert.equal((await s.post(`/lead/${a}/plan`, { _csrf: await s.csrf(`/lead/${a}`), plan: 'big' })).status, 303);
    s.as(s.accounts.session(customer(1)).cookie);
    assert.match(await (await s.get('/plan')).text(), /חבילת חנות גדולה.*עד 1,500 שיחות בחודש/s);
  } finally {
    await s.close();
  }
});

test('moving plans follows the website: one busy month costs nothing more, two in a row move the store', () => {
  const m = monthOf();
  const months = (now: number, last: number) => new Map([[m, now], [prevMonth(m), last]]);
  assert.equal(usageOf('store', months(120, 400)).note, null);
  assert.match(usageOf('store', months(301, 100)).note!, /לא עולה לכם יותר/);
  assert.match(usageOf('store', months(301, 350)).note!, /מהחודש הבא החנות עוברת לחבילה הגדולה/);
  assert.match(usageOf('big', months(100, 200)).note!, /תחזור לחבילת חנות/);
  assert.match(usageOf('big', months(1501, 1600)).note!, /נבנה חבילה לפי החנות/);
  assert.equal(usageOf('big', months(900, 800)).note, null);
  assert.equal(prevMonth('2026-01'), '2025-12');
  assert.equal(monthOf(Date.parse('2026-10-31T22:30:00Z')), '2026-11', 'Israel\'s month, not UTC\'s');
});

test('the export: every message of the workspace\'s conversations as a CSV, for the account\'s owner only', async () => {
  const { s, a, account } = await shop();
  try {
    await thread(s, a, account, '=HYPERLINK("https://evil.example")');
    const r = await s.get('/export/conversations.csv');
    assert.equal(r.status, 200);
    assert.match(String(r.headers.get('content-type')), /text\/csv/);
    assert.match(String(r.headers.get('content-disposition')), /attachment; filename="toran-conversations-\d{4}-\d{2}\.csv"/);
    const csv = Buffer.from(await r.arrayBuffer()).toString('utf8');
    assert.ok(csv.startsWith('﻿חנות,שיחה,ערוץ,לקוח'), 'a BOM, so Excel reads the Hebrew');
    assert.match(csv, /dana@example\.test/);
    assert.match(csv, /"'=HYPERLINK\(""https:\/\/evil\.example""\)"/, 'a formula is kept as text');
    s.as(s.accounts.session({ ...customer(1), role: 'client_member' }).cookie);
    assert.equal((await s.get('/export/conversations.csv')).status, 403);
    assert.ok(!/href="\/export\/conversations\.csv"/.test(await (await s.get('/plan')).text()));
    s.as(s.accounts.session(customer(2)).cookie);
    const empty = Buffer.from(await (await s.get('/export/conversations.csv')).arrayBuffer()).toString('utf8');
    assert.ok(!/dana@example/.test(empty), 'another workspace exports nothing of this one');
  } finally {
    await s.close();
  }
});

test('a workspace with no store yet: every customer page says the store is being set up', async () => {
  const s = await serve();
  try {
    s.as(s.accounts.session(customer(5)).cookie);
    for (const p of ['/', '/plan']) {
      const r = await s.get(p);
      assert.equal(r.status, 200, p);
      assert.match(await r.text(), /החנות שלכם עוד בהקמה/, p);
    }
  } finally {
    await s.close();
  }
});
