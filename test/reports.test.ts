import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { monthlyReports, monthReport, reportMail } from '../src/owners/reports.ts';
import { waitingDigest } from '../src/owners/waiting.ts';
import { prevMonth, monthOf } from '../src/plans.ts';
import { testApp } from './helpers.ts';

// Toran's emails through accounts (owners/notify-client.ts, TORAN-READINESS.md P1-9, P1-10): the waiting digest and
// the month's results go to POST /internal/notify as product toran with its own kinds; accounts' no stands.

const TOKEN = 'x'.repeat(40);

async function fakeNotify(answer: { status: number; body: any } = { status: 202, body: { ok: true, sent: 1 } }) {
  const asked: any[] = [];
  const state = { answer };
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    if (req.url !== '/internal/notify' || req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'not_found' }));
      return;
    }
    asked.push(JSON.parse(raw));
    res.writeHead(state.answer.status, { 'content-type': 'application/json' }).end(JSON.stringify(state.answer.body));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as any).port;
  return { asked, state, env: { OF_ACCOUNTS_INTERNAL: `http://127.0.0.1:${port}`, OF_INTERNAL_TOKEN: TOKEN, PUBLIC_BASE_URL: 'https://toran.openfrequency.co.il' }, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function storeWithWaiting(a: Awaited<ReturnType<typeof testApp>>) {
  const id = (await a.db.one<{ id: number }>("INSERT INTO stores (domain, url, name, platform, source, slug, workspace_id) VALUES ('rp.example', 'https://rp.example/', 'כלי חרס', 'shopify', 'signup', 'rp-x', 7) RETURNING id"))!.id;
  const acc = (await a.db.one<{ id: number }>("INSERT INTO channel_accounts (store_id, channel, kind, external_id, name) VALUES ($1, 'email', 'sim', 'rp@in.toran.test', 'r') RETURNING id", [id]))!.id;
  const conv = (await a.db.one<{ id: number }>("INSERT INTO conversations (store_id, channel, peer, account_id) VALUES ($1, 'email', 'dana@example.test', $2) RETURNING id", [id, acc]))!.id;
  await a.db.query("INSERT INTO messages (conversation_id, role, text) VALUES ($1, 'customer', 'אפשר לאסוף?')", [conv]);
  await a.db.query("INSERT INTO messages (conversation_id, role, text, handoff) VALUES ($1, 'agent', 'בודקים', $2::jsonb)", [conv, JSON.stringify({ reason: 'unknown', summary: 'שואלת על איסוף' })]);
  return { id, conv };
}

test('the waiting digest goes through accounts as toran conversation_waiting with the conversation\'s link; accounts\' limit stands', async () => {
  const a = await testApp();
  const n = await fakeNotify();
  Object.assign(a.env, n.env);
  try {
    const { id, conv } = await storeWithWaiting(a);
    const r = await waitingDigest(a, id);
    assert.equal(r.sent, 1);
    assert.equal(n.asked.length, 1);
    assert.deepEqual({ ...n.asked[0], text: undefined, subject: undefined }, { workspace: 7, product: 'toran', kind: 'conversation_waiting', link: `https://toran.openfrequency.co.il/chat/${conv}`, text: undefined, subject: undefined });
    assert.match(n.asked[0].subject, /לקוח של כלי חרס מחכה לתשובה שלכם/);
    assert.match(n.asked[0].text, /שואלת על איסוף/);

    // Told: not again. A new waiting conversation over accounts' day limit: accounts' 429 stands, no other mail.
    assert.equal((await waitingDigest(a, id)).why, 'nothing new waits');
    await a.db.query("DELETE FROM events WHERE kind = 'owner_told'");
    n.state.answer = { status: 429, body: { error: 'limit' } };
    a.mail = { notice: async () => assert.fail('no mail of our own when accounts said no') } as any;
    assert.equal((await waitingDigest(a, id)).why, 'accounts: limit');
  } finally {
    await n.close();
    await a.db.close();
  }
});

test("the month's results: once a store a month, from the 1st at 09:00, through accounts as toran monthly; a quiet store gets none", async () => {
  const a = await testApp();
  const n = await fakeNotify();
  Object.assign(a.env, n.env);
  try {
    const { id } = await storeWithWaiting(a);
    await a.db.query("INSERT INTO stores (domain, url, name, platform, source, slug, workspace_id) VALUES ('quiet.example', 'https://quiet.example/', 'שקט', 'shopify', 'signup', 'q-x', 8)");
    // Last month's conversation: move it back into last month.
    const last = prevMonth(monthOf());
    await a.db.query(`UPDATE messages SET at = ('${last}-15'::date + interval '12 hours')`);
    await a.db.query(`UPDATE conversations SET last_at = ('${last}-15'::date + interval '12 hours')`);

    const rep = await monthReport(a, id, {}, last);
    assert.deepEqual({ ...rep, cart: null }, { month: last, conversations: 1, alone: 0, fixed: 0, waiting: 1, cart: null, cap: 300 });
    const mail = reportMail('כלי חרס', rep, 'https://toran.openfrequency.co.il');
    assert.match(mail.text, /שיחה אחת עם לקוחות של כלי חרס ב/);
    assert.match(mail.text, /ו־1 עוד מחכות לכם/);
    assert.match(mail.subject, /^שיחה אחת עם לקוחות של כלי חרס ב\S+$/, 'no colon heading, conversations as the body counts them');
    const busy = reportMail('My Store 10', { ...rep, conversations: 12, alone: 9, fixed: 2, waiting: 1 }, 'https://toran.openfrequency.co.il');
    assert.match(busy.subject, /^תורן ענה לבד ב־9 שיחות של My Store 10 ב/);

    assert.deepEqual(await monthlyReports(a, { t: Date.parse('2026-11-01T05:00:00Z') }), { sent: [], skipped: [] }, '07:00 on the 1st: not yet');
    const r = await monthlyReports(a, { force: true });
    assert.deepEqual(r.sent, [id]);
    assert.equal(r.skipped.length, 1, 'the quiet store gets none');
    assert.equal(n.asked.length, 1);
    assert.equal(n.asked[0].kind, 'monthly');
    assert.equal(n.asked[0].product, 'toran');
    const again = await monthlyReports(a, { force: true });
    assert.deepEqual(again.sent, [], 'once a store a month');
  } finally {
    await n.close();
    await a.db.close();
  }
});
