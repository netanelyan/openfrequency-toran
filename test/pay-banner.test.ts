import { test } from 'node:test';
import assert from 'node:assert/strict';
import { payReminder, REMIND_DAYS, type View } from '../src/billing/entitlement.ts';
import { customer } from './helpers.ts';
import { serve } from './serve.ts';

// The pay reminder on every page of a customer's workspace (TORAN-READINESS.md P1-3, as Teder's payReminder and
// payBanner; the owner, 2026-11-03: remind on WhatsApp, email and the dashboard, 72 hours to pay after the month ends).

const DAY = 86_400_000;
const T = Date.parse('2026-11-08T10:00:00Z');
const ent = (o: Partial<View>): View => ({ workspace: 1, allowed: true, known: true, access: 'paid', paidThrough: null, cancelAt: null, graceUntil: null, checkedAt: new Date(T).toISOString(), source: 'fresh', ...o });

test('payReminder: the last week paid for, the grace after it, and nothing else', () => {
  assert.equal(REMIND_DAYS, 7);
  assert.equal(payReminder(ent({ paidThrough: new Date(T + 20 * DAY).toISOString() }), T), null, 'weeks away');
  assert.deepEqual(payReminder(ent({ paidThrough: new Date(T + 3 * DAY).toISOString() }), T), { state: 'soon', until: new Date(T + 3 * DAY).toISOString() });
  assert.deepEqual(payReminder(ent({ access: 'due', graceUntil: new Date(T + 2 * DAY).toISOString() }), T), { state: 'due', until: new Date(T + 2 * DAY).toISOString() });
  assert.equal(payReminder(ent({ access: 'due', graceUntil: new Date(T - DAY).toISOString() }), T), null, 'a day already past says nothing');
  assert.equal(payReminder(ent({ access: 'due' }), T), null, 'no day from accounts, nothing of ours');
  for (const access of ['comp', 'cancelled', 'off']) assert.equal(payReminder(ent({ access, paidThrough: new Date(T + DAY).toISOString() }), T), null, access);
  assert.equal(payReminder(ent({ allowed: false, access: 'unpaid' }), T), null, 'the paywall says it');
  assert.equal(payReminder(ent({ known: false }), T), null);
  assert.equal(payReminder(null, T), null);
});

test('the banner on the dashboard: due with the day and the way to pay; none for the operator', async () => {
  const s = await serve();
  try {
    const id = s.seeded.storeId;
    await s.app.db.query('UPDATE stores SET workspace_id = 4 WHERE id = $1', [id]);
    const grace = new Date(Date.now() + 2 * DAY).toISOString();
    // As accounts answered a minute ago: kept, and read for five minutes without asking again.
    await s.app.db.query("INSERT INTO settings (key, value) VALUES ('entitlement:4', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [JSON.stringify({ allowed: true, access: 'due', paidThrough: null, cancelAt: null, graceUntil: grace, checkedAt: new Date().toISOString() })]);
    s.as(s.accounts.session(customer(4)).cookie);
    const page = await (await s.get('/')).text();
    assert.match(page, /<div class="banner warn pay" id="pay">/);
    assert.match(page, /התשלום על החודש הבא עוד לא הגיע אלינו/);
    assert.match(page, /תורן ממשיך לענות ללקוחות עד סוף/);
    assert.match(page, /href="https:\/\/accounts\.test\/setup">איך משלמים/);
    s.login();
    assert.doesNotMatch(await (await s.get('/')).text(), /id="pay"/, 'the operator is never reminded to pay');
  } finally {
    await s.close();
  }
});

test('/waiting.json: the waiting count of the session\'s own stores, for the live badge (P1-13)', async () => {
  const s = await serve();
  try {
    const id = s.seeded.storeId;
    await s.app.db.query('UPDATE stores SET workspace_id = 6 WHERE id = $1', [id]);
    s.as(s.accounts.session(customer(6)).cookie);
    const before = await (await s.get('/waiting.json')).json();
    assert.equal(typeof before.chats, 'number');
    const conv = (await s.app.db.one<{ id: number }>("INSERT INTO conversations (store_id, channel, peer, account_id) VALUES ($1, 'email', 'dana@example.test', NULL) RETURNING id", [id]))!.id;
    await s.app.db.query("INSERT INTO messages (conversation_id, role, text, handoff) VALUES ($1, 'customer', 'שאלה', NULL), ($1, 'agent', 'בודק', '{\"reason\":\"unknown\",\"summary\":\"שאלה\"}'::jsonb)", [conv]);
    const after = await (await s.get('/waiting.json')).json();
    assert.ok(after.chats >= before.chats, 'it counts what the header counts');
    s.as(s.accounts.session(customer(7)).cookie);
    assert.equal((await (await s.get('/waiting.json')).json()).chats, 0, 'another workspace sees none of it');
  } finally {
    await s.close();
  }
});

test('the plan accounts sells the workspace is its stores\' plan; a missing or malformed one leaves the store\'s own (P1-2)', async () => {
  const { entitlementClient, planOfAnswer } = await import('../src/billing/entitlement.ts');
  const { INTERNAL_TOKEN } = await import('./helpers.ts');
  assert.deepEqual(planOfAnswer({ plan: { name: 'big', conversations: 1500 } }), { name: 'big', conversations: 1500 });
  for (const bad of [{}, { plan: null }, { plan: { name: 'small', conversations: 300 } }, { plan: { name: 'big', conversations: -1 } }, { plan: { name: 'big', conversations: '1500' } }]) assert.equal(planOfAnswer(bad), null, JSON.stringify(bad));
  const s = await serve();
  try {
    const id = s.seeded.storeId;
    await s.app.db.query("UPDATE stores SET workspace_id = 12, config = '{}'::jsonb WHERE id = $1", [id]);
    let t = Date.parse('2026-11-08T10:00:00Z');
    let plan: any = { name: 'big', conversations: 1500 };
    const body = () => ({ workspace: 12, product: 'toran', enabled: true, access: 'paid', allowed: true, paidThrough: '2026-12-08T00:00:00Z', cancelAt: null, ...(plan === undefined ? {} : { plan }) });
    const c = entitlementClient({ db: s.app.db, env: { OF_INTERNAL_TOKEN: INTERNAL_TOKEN }, clock: () => t, fetchImpl: async () => new Response(JSON.stringify(body()), { status: 200 }) });
    const cfg = async () => (await s.app.db.one<{ config: any }>('SELECT config FROM stores WHERE id = $1', [id]))!.config;
    assert.equal((await c.check(12)).allowed, true);
    assert.equal((await cfg()).plan, 'big', 'the store follows accounts');
    plan = { name: 'nope', conversations: 1 };
    t += 10 * 60_000;
    await c.check(12);
    assert.equal((await cfg()).plan, 'big', 'a malformed plan changes nothing');
    plan = { name: 'store', conversations: 300 };
    t += 10 * 60_000;
    await c.check(12);
    assert.equal((await cfg()).plan, 'store');
  } finally {
    await s.close();
  }
});
