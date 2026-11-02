import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entitlementClient, entitlementOf, lastKnown, storeAllowed } from '../src/billing/entitlement.ts';
import { changedRoutes } from '../src/billing/changed.ts';
import { customer, INTERNAL_TOKEN } from './helpers.ts';
import { serve } from './serve.ts';

// accounts tells Toran when a workspace's access changes (the owner's audit, 2026-11-02, accounts item 3: "When a payment
// is recorded, tell Teder and Toran right away (the existing internal endpoint with the bearer token), so they clear
// their entitlement cache. The customer should see access open on the next refresh, not after 5 minutes."):
// POST /internal/entitlement/changed (accounts' docs/contracts/entitlement-changed.json, billing/changed.ts). The answer
// Toran keeps 5 minutes is marked in the database, so the dashboard's next page and the worker's next message ask
// accounts afresh; a refusal marks nothing.

type S = Awaited<ReturnType<typeof serve>>;
const WRONG = 'wrong-token-wrong-token-wrong-token-00';
const notice = (s: S, body: unknown, { token = INTERNAL_TOKEN as string | null, method = 'POST', headers = {} as Record<string, string>, raw = undefined as string | undefined } = {}) =>
  fetch(`${s.base}/internal/entitlement/changed`, {
    method,
    headers: { ...(token == null ? {} : { authorization: `Bearer ${token}` }), 'content-type': 'application/json', ...headers },
    ...(method === 'GET' || method === 'HEAD' ? {} : { body: raw ?? JSON.stringify(body) }),
  }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

async function unpaidStore(s: S, workspace: number) {
  await s.app.db.query('UPDATE stores SET workspace_id = $1 WHERE id = $2', [workspace, s.seeded.storeId]);
  s.accounts.paid(workspace, 'unpaid');
  s.as(s.accounts.session(customer(workspace)).cookie);
}

test('accounts says it changed: the next page asks accounts again, inside the 5 minutes, and the store that just paid sees Toran', async () => {
  const s = await serve();
  try {
    await unpaidStore(s, 1);
    assert.equal((await s.get('/')).status, 402, 'not paid: the pay page');
    const asked = s.accounts.entitlementCalls;
    // The payment is recorded in accounts. Toran still has its answer, and does not ask.
    s.accounts.paid(1, null);
    assert.equal((await s.get('/')).status, 402);
    assert.equal(s.accounts.entitlementCalls, asked, 'kept: not asked');

    assert.deepEqual(await notice(s, { workspace: 1, reason: 'paid' }), { status: 200, json: { ok: true, workspace: 1, cleared: true } });
    const kept = await lastKnown(s.app.db, 1);
    assert.equal(kept?.allowed, false, 'the notice opens nothing by itself: accounts says what is allowed');
    assert.ok(kept?.changedAt, 'marked, and kept for the 24 hours accounts may be down');

    assert.equal((await s.get('/')).status, 200, 'the next page: the dashboard');
    assert.equal(s.accounts.entitlementCalls, asked + 1, 'accounts asked once');
    assert.equal((await lastKnown(s.app.db, 1))?.changedAt, undefined, 'the new answer is kept as any answer is');
    assert.equal((await s.get('/')).status, 200);
    assert.equal(s.accounts.entitlementCalls, asked + 1, 'and used for its 5 minutes, as before');
  } finally {
    await s.close();
  }
});

test("the store's customers are answered again at once, by this process and by the worker's, which keeps its own client: the mark is in the database", async () => {
  const s = await serve();
  try {
    await unpaidStore(s, 2);
    // The worker answers the store's customers in its own process: a client of its own, on the same database.
    const worker = entitlementClient({ db: s.app.db, env: s.app.env });
    assert.equal(await storeAllowed(s.app, s.seeded.storeId), false);
    assert.equal((await worker.check(2)).source, 'cache', "the worker reads the answer the dashboard's client kept");
    s.accounts.paid(2, null);
    assert.equal(await storeAllowed(s.app, s.seeded.storeId), false, 'within the 5 minutes the kept answer stands');
    assert.equal((await notice(s, { workspace: 2, reason: 'paid' })).status, 200);
    const w = await worker.check(2);
    assert.deepEqual([w.allowed, w.source], [true, 'fresh'], 'the worker asks again at once');
    assert.equal(await storeAllowed(s.app, s.seeded.storeId), true);
  } finally {
    await s.close();
  }
});

test('a workspace Toran never asked about is fine: 200, cleared false, nothing written; a reason Toran does not know is acted on the same way', async () => {
  const s = await serve();
  try {
    assert.deepEqual(await notice(s, { workspace: 999, reason: 'paid' }), { status: 200, json: { ok: true, workspace: 999, cleared: false } });
    assert.equal(await lastKnown(s.app.db, 999), null);
    await unpaidStore(s, 3);
    await s.get('/');
    assert.equal((await notice(s, { workspace: 3, reason: 'a_new_one' })).json.cleared, true);
    assert.equal((await notice(s, { workspace: 3 })).json.cleared, true, 'and none at all');
  } finally {
    await s.close();
  }
});

test('refused, and nothing marked: no token, a wrong one, through Caddy, from another machine, a GET, no token here, no workspace', async () => {
  const s = await serve();
  try {
    await unpaidStore(s, 4);
    await s.get('/');
    const cases: [string, Promise<{ status: number; json: any }>, number, string][] = [
      ['no token', notice(s, { workspace: 4 }, { token: null }), 401, 'bad_token'],
      ['a wrong token', notice(s, { workspace: 4 }, { token: WRONG }), 401, 'bad_token'],
      ['through Caddy', notice(s, { workspace: 4 }, { headers: { 'x-forwarded-for': '203.0.113.9' } }), 403, 'forbidden'],
      ['GET', notice(s, null, { method: 'GET' }), 405, 'method_not_allowed'],
      ['GET without the token', notice(s, null, { method: 'GET', token: null }), 401, 'bad_token'],
      ['GET through Caddy', notice(s, null, { method: 'GET', headers: { 'x-forwarded-for': '203.0.113.9' } }), 403, 'forbidden'],
      ['no workspace', notice(s, {}), 400, 'bad_workspace'],
      ['a workspace as a string', notice(s, { workspace: '4' }), 400, 'bad_workspace'],
      ['zero', notice(s, { workspace: 0 }), 400, 'bad_workspace'],
      ['a fraction', notice(s, { workspace: 4.5 }), 400, 'bad_workspace'],
      ['not JSON', notice(s, null, { raw: 'workspace=4' }), 400, 'bad_workspace'],
      ['a list', notice(s, [4]), 400, 'bad_workspace'],
      ['too large', notice(s, { workspace: 4, reason: 'x'.repeat(5000) }), 400, 'bad_workspace'],
    ];
    for (const [label, call, status, error] of cases) assert.deepEqual(await call, { status, json: { error } }, label);
    const was = s.app.env.OF_INTERNAL_TOKEN;
    delete s.app.env.OF_INTERNAL_TOKEN;
    assert.deepEqual(await notice(s, { workspace: 4 }), { status: 503, json: { error: 'not_configured' } }, 'OF_INTERNAL_TOKEN unset here');
    s.app.env.OF_INTERNAL_TOKEN = was;
    assert.equal((await lastKnown(s.app.db, 4))?.changedAt, undefined, 'none of them marked anything');

    // A socket that is not this machine's (the route's own check: Toran listens on 127.0.0.1 behind Caddy).
    const [, , post] = changedRoutes(s.app)[0];
    const req = { headers: { authorization: `Bearer ${INTERNAL_TOKEN}` }, socket: { remoteAddress: '203.0.113.9' } };
    for (const remoteAddress of ['203.0.113.9', '::ffff:10.0.0.4']) {
      const out = await post({ req: { ...req, socket: { remoteAddress } }, raw: '{"workspace":4}' } as any, [] as any);
      assert.deepEqual([out.status, out.json], [403, { error: 'forbidden' }], remoteAddress);
    }
    assert.equal((await lastKnown(s.app.db, 4))?.changedAt, undefined);
  } finally {
    await s.close();
  }
});

test('the client: changed() makes the next check ask, past the minute a failed question waits; a question out at that moment brings back an answer that is kept marked', async () => {
  const s = await serve();
  try {
    let now = Date.parse('2026-11-02T12:00:00.000Z');
    const answers: string[] = [];
    let hold: Promise<void> | null = null;
    let down = false;
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      if (hold) await hold;
      if (down) throw new Error('down');
      const access = answers.shift() || 'paid';
      return new Response(JSON.stringify({ workspace: 5, product: 'toran', enabled: true, access, allowed: access === 'paid', paidThrough: null, cancelAt: null, graceUntil: null }), { status: 200 });
    };
    const c = entitlementClient({ db: s.app.db, env: { OF_INTERNAL_TOKEN: INTERNAL_TOKEN }, clock: () => now, fetchImpl });

    answers.push('unpaid');
    assert.equal((await c.check(5)).allowed, false);
    now += 1000;
    assert.equal((await c.check(5)).source, 'cache');
    assert.equal(await c.changed(5), true);
    answers.push('paid');
    const a = await c.check(5);
    assert.deepEqual([a.allowed, a.source, calls], [true, 'fresh', 2]);

    // accounts down after a notice: the last answer stands; a failed question waits a minute before the next, unless
    // accounts says it changed.
    down = true;
    await c.changed(5);
    const stale = await c.check(5);
    assert.deepEqual([stale.allowed, stale.source, calls], [true, 'stale', 3], 'a paying store is not stopped by accounts being down');
    now += 1000;
    assert.deepEqual([(await c.check(5)).source, calls], ['stale', 3], 'not asked again within the minute');
    down = false;
    await c.changed(5);
    now += 1000;
    assert.deepEqual([(await c.check(5)).source, calls], ['fresh', 4], 'a notice: asked at once');

    // A question already out when accounts says it changed (it left before the payment was committed).
    await c.changed(5);
    answers.push('unpaid', 'paid');
    let release!: () => void;
    hold = new Promise<void>((r) => (release = r));
    now += 1000;
    const sent = calls;
    const out = c.check(5);
    // The question is out (it reads the database first): only then does accounts' notice come.
    while (calls === sent) await new Promise((r) => setImmediate(r));
    now += 10;
    await c.changed(5);
    hold = null;
    release();
    assert.equal((await out).allowed, false, 'the answer from before the payment');
    assert.ok((await lastKnown(s.app.db, 5))?.changedAt, 'kept marked');
    now += 10;
    const next = await c.check(5);
    assert.deepEqual([next.allowed, next.source], [true, 'fresh'], 'asked again: paid');
    assert.equal((await lastKnown(s.app.db, 5))?.changedAt, undefined);
    // The shared client is the one the route tells.
    assert.equal(typeof entitlementOf(s.app).changed, 'function');
  } finally {
    await s.close();
  }
});
