import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { conversationFor, runTurn } from '../src/agent/loop.ts';
import { entitlementClient, FRESH_MS, STALE_MS, storeAllowed } from '../src/billing/entitlement.ts';
import { customer, INTERNAL_TOKEN, viewingAs } from './helpers.ts';
import { serve } from './serve.ts';

// The paywall (src/billing/entitlement.ts, PRA-SEC-002 and PRA-BE-007): accounts says whether a workspace has paid for
// Toran; one that has not sees the pay page, and its customers' messages get no model call.

test('a workspace that has not paid sees the pay page and posts nothing; the operator and view-as are never stopped', async () => {
  const s = await serve();
  const a = s.seeded.storeId;
  await s.app.db.query('UPDATE stores SET workspace_id = 1 WHERE id = $1', [a]);
  try {
    s.as(s.accounts.session(customer(1)).cookie);
    assert.equal((await s.get('/')).status, 200, 'paid: the dashboard');
    const token = await s.csrf(`/lead/${a}/knowledge`);
    s.accounts.paid(1, 'unpaid');
    await s.app.db.query("DELETE FROM settings WHERE key = 'entitlement:1'"); // as if the kept answer were 5 minutes old
    const page = await s.get('/');
    assert.equal(page.status, 402);
    const html = await page.text();
    assert.match(html, /data-refusal="unpaid"/);
    assert.match(html, /href="https:\/\/accounts\.test"/, 'to the account, where payment is');
    assert.equal((await s.post(`/lead/${a}/faq`, { _csrf: token, question: 'q?', answer: 'a' })).status, 402);
    assert.equal((await s.app.db.one<any>('SELECT COUNT(*)::int AS n FROM faqs WHERE store_id = $1 AND answer IS NOT NULL', [a])).n, 0);
    s.as(s.accounts.session(viewingAs(1)).cookie);
    assert.equal((await s.get('/')).status, 200, 'the operator viewing as the customer sees what is there');
    s.login();
    assert.equal((await s.get('/leads?all=1')).status, 200, 'the operator');
    // accounts not answering, with nothing kept: closed, and said so.
    s.as(s.accounts.session(customer(1)).cookie);
    s.accounts.paid(1, 'down');
    await s.app.db.query("DELETE FROM settings WHERE key = 'entitlement:1'");
    const down = await s.get('/');
    assert.equal(down.status, 503);
    assert.match(await down.text(), /data-refusal="unchecked"/);
  } finally {
    await s.close();
  }
});

test('a store of a workspace that has not paid gets no model call and the owner gets the message; a store in no workspace always answers', async () => {
  const s = await serve();
  const a = s.seeded.storeId;
  let calls = 0;
  const inner = s.app.llm;
  s.app.llm = { backend: inner.backend, turn: (req) => (calls++, inner.turn(req)) };
  try {
    const conv = await conversationFor(s.app.db, a, 'whatsapp', '972500000331');
    await runTurn(s.app, { storeId: a, conversationId: conv, text: 'יש ספלים?', channel: 'whatsapp', footer: false });
    assert.ok(calls > 0, 'no workspace: answered');
    await s.app.db.query('UPDATE stores SET workspace_id = 7 WHERE id = $1', [a]);
    s.accounts.paid(7, 'unpaid');
    calls = 0;
    const out = await runTurn(s.app, { storeId: a, conversationId: conv, text: 'ועוד שאלה', channel: 'whatsapp', footer: false });
    assert.equal(calls, 0, 'no model call');
    assert.match(out.handoff?.summary || '', /not paid for/);
    assert.equal(await storeAllowed(s.app, a), false);
    s.accounts.paid(7, null);
    await s.app.db.query("DELETE FROM settings WHERE key = 'entitlement:7'");
    assert.equal(await storeAllowed(s.app, a), true, 'paid again: answered again');
  } finally {
    await s.close();
  }
});

test('the kept answer: fresh for 5 minutes, standing 24 hours while accounts is down, then closed; an unknown workspace is not allowed', async () => {
  const s = await serve();
  try {
    let t = Date.parse('2026-11-01T10:00:00Z');
    let calls = 0;
    const paid = { workspace: 3, product: 'toran', enabled: true, access: 'paid', allowed: true, paidThrough: null, cancelAt: null };
    let answer: () => Response = () => new Response(JSON.stringify(paid), { status: 200 });
    const c = entitlementClient({ db: s.app.db, env: { OF_INTERNAL_TOKEN: INTERNAL_TOKEN }, clock: () => t, fetchImpl: async () => (calls++, answer()) });
    assert.equal((await c.check(3)).allowed, true);
    t += FRESH_MS - 1;
    assert.equal((await c.check(3)).source, 'cache');
    assert.equal(calls, 1);
    answer = () => {
      throw new Error('ECONNREFUSED');
    };
    t += 2;
    const stale = await c.check(3);
    assert.equal(stale.allowed, true, 'a hiccup stops nobody');
    assert.equal(stale.source, 'stale');
    t += STALE_MS;
    assert.equal((await c.check(3)).allowed, false, 'a day without an answer: closed');
    answer = () => new Response(JSON.stringify({ error: 'no_workspace' }), { status: 404 });
    assert.equal((await c.check(9)).allowed, false);
    answer = () => new Response(JSON.stringify({ workspace: 4, product: 'teder', allowed: true }), { status: 200 });
    assert.equal((await c.check(4)).allowed, false, 'an answer about another product is not believed');
  } finally {
    await s.close();
  }
});

test('under /admin, accounts may vouch for the operator with a signed header instead of their cookie (PRA-SEC-004)', async () => {
  const s = await serve();
  const ADMIN = { 'x-of-admin-prefix': '/admin/toran' };
  const vouch = (claim: Record<string, unknown>, key = INTERNAL_TOKEN) => {
    const body = Buffer.from(JSON.stringify(claim)).toString('base64url');
    return `${body}.${createHmac('sha256', key).update(body).digest('base64url')}`;
  };
  try {
    s.as('');
    const good = vouch({ email: 'operator@example.test', name: 'operator', exp: Date.now() + 60_000 });
    assert.equal((await s.get('/admin/toran/leads', { ...ADMIN, 'x-of-operator': good })).status, 200);
    assert.equal((await s.get('/leads', { 'x-of-operator': good })).status, 303, 'only under the admin prefix');
    const bad = [
      vouch({ email: 'operator@example.test', exp: Date.now() - 1 }),
      vouch({ email: 'operator@example.test', exp: Date.now() + 3_600_000 }),
      vouch({ email: 'operator@example.test', exp: Date.now() + 60_000 }, 'x'.repeat(40)),
      `${good}x`,
      'nonsense',
    ];
    for (const b of bad) assert.equal((await s.get('/admin/toran/leads', { ...ADMIN, 'x-of-operator': b })).status, 303, b);
    // A form under it carries the operator's own CSRF token.
    const html = await (await s.get('/admin/toran/settings', { ...ADMIN, 'x-of-operator': good })).text();
    const token = /name="_csrf" value="([^"]+)"/.exec(html)?.[1] || '';
    assert.ok(token);
    const on = await s.post('/admin/toran/settings/dev', { _csrf: token, on: '1' }, { ...ADMIN, 'x-of-operator': good, origin: 'https://accounts.test' });
    assert.equal(on.status, 303);
    assert.equal((await s.post('/admin/toran/settings/dev', { _csrf: 'stale', on: '1' }, { ...ADMIN, 'x-of-operator': good, origin: 'https://accounts.test' })).status, 403);
  } finally {
    await s.close();
  }
});
