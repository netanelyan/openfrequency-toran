import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import { createHandler } from '../src/web/server.ts';
import { conversationFor, runTurn } from '../src/agent/loop.ts';
import { entitlementClient, FRESH_MS, planAccess, refreshWorkspaces, STALE_MS, storeAllowed } from '../src/billing/entitlement.ts';
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
    // The 30-day clock on a stopped store's chats hangs off the same answer (planAccess, refreshWorkspaces).
    assert.deepEqual(await planAccess(s.app.db, 7, false), [a]);
    assert.equal(await refreshWorkspaces(s.app), 1);
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

// accounts' side signs it: openfrequency-accounts src/web/admin-toran.js operatorAssertion, and its contract
// docs/contracts/admin-toran-operator.json, whose example payload these cases are built from.
const CONTRACT_EXAMPLE = { id: 1, email: 'admin@example.com', name: 'Admin', ses: 'Qm9vazEyMzQ1Njc4OTBhYmNkZWZnaGlq', exp: 1792832460000 };
const sign = (claim: Record<string, unknown>, key = INTERNAL_TOKEN) => {
  const payload = Buffer.from(JSON.stringify(claim)).toString('base64url');
  return `${payload}.${createHmac('sha256', key).update(payload).digest('base64url')}`;
};

/** One request straight into the handler, from a socket address of the test's choosing. */
function call(s: Awaited<ReturnType<typeof serve>>, { url, headers, remote }: { url: string; headers: Record<string, string>; remote: string }): Promise<{ status: number; location: string | null }> {
  const handler = createHandler(s.app, { port: Number(new URL(s.base).port) });
  const req = Object.assign(Readable.from([]), { method: 'GET', url, headers: { host: new URL(s.base).host, ...headers }, socket: { remoteAddress: remote } });
  return new Promise((done) => {
    let status = 0;
    let location: string | null = null;
    const res = {
      writeHead(st: number, h: Record<string, string> = {}) {
        status = st;
        location = h.location ?? null;
        return res;
      },
      setHeader() {},
      end() {
        done({ status, location });
      },
    };
    handler(req as any, res as any);
  });
}

test('under /admin, accounts vouches for the operator with X-OF-Operator instead of their cookie, exactly as its contract signs it (PRA-SEC-004)', async () => {
  const s = await serve();
  const ADMIN = { 'x-of-admin-prefix': '/admin/toran' };
  try {
    s.as('');
    const good = sign({ ...CONTRACT_EXAMPLE, exp: Date.now() + 60_000 });
    assert.equal((await s.get('/admin/toran/leads', { ...ADMIN, 'x-of-operator': good })).status, 200, 'the contract\'s payload, signed with our token, 60 seconds ahead');
    assert.equal((await s.get('/leads', { 'x-of-operator': good })).status, 303, 'only under the admin prefix');
    const refused: [string, string][] = [
      ['the contract\'s example as it stands: expired', sign(CONTRACT_EXAMPLE)],
      ['too far ahead', sign({ ...CONTRACT_EXAMPLE, exp: Date.now() + 3_600_000 })],
      ['a bad signature', sign({ ...CONTRACT_EXAMPLE, exp: Date.now() + 60_000 }, 'x'.repeat(40))],
      ['a changed payload', `${Buffer.from(JSON.stringify({ ...CONTRACT_EXAMPLE, exp: Date.now() + 60_000 })).toString('base64url')}.${good.split('.')[1]}`],
      ['no ses', sign({ ...CONTRACT_EXAMPLE, ses: undefined, exp: Date.now() + 60_000 })],
      ['a ses that is not 32 base64url characters', sign({ ...CONTRACT_EXAMPLE, ses: 'short', exp: Date.now() + 60_000 })],
      ['not a statement', 'nonsense'],
    ];
    for (const [why, h] of refused) assert.equal((await s.get('/admin/toran/leads', { ...ADMIN, 'x-of-operator': h })).status, 303, why);
    // From a socket that is not this machine's, the same good header is no one's: sent to sign in.
    const away = await call(s, { url: '/admin/toran/leads', headers: { ...ADMIN, 'x-of-operator': good }, remote: '10.0.0.5' });
    assert.equal(away.status, 303);
    assert.match(String(away.location), /\/login\?next=/);
    assert.equal((await call(s, { url: '/admin/toran/leads', headers: { ...ADMIN, 'x-of-operator': good }, remote: '127.0.0.1' })).status, 200);
    // The CSRF token comes from ses: the same session posts, another session's token does not.
    const html = await (await s.get('/admin/toran/settings', { ...ADMIN, 'x-of-operator': good })).text();
    const token = /name="_csrf" value="([^"]+)"/.exec(html)?.[1] || '';
    assert.ok(token);
    const again = sign({ ...CONTRACT_EXAMPLE, exp: Date.now() + 60_000 });
    assert.equal((await s.post('/admin/toran/settings/dev', { _csrf: token, on: '1' }, { ...ADMIN, 'x-of-operator': again, origin: 'https://accounts.test' })).status, 303);
    const other = sign({ ...CONTRACT_EXAMPLE, ses: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', exp: Date.now() + 60_000 });
    assert.equal((await s.post('/admin/toran/settings/dev', { _csrf: token, on: '1' }, { ...ADMIN, 'x-of-operator': other, origin: 'https://accounts.test' })).status, 403);
  } finally {
    await s.close();
  }
});
