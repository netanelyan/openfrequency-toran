import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setOffer } from '../src/offer.ts';
import { accountsClient } from '../src/web/accounts.ts';
import { customer, viewingAs } from './helpers.ts';
import { serve, TEST_OFFER } from './serve.ts';

// Sign-in is openfrequency-accounts', and a session sees only its workspace's stores (src/web/workspace.ts).
// Workspace 1 has the fictional store (with its demo chat), workspace 2 a store of its own with a chat of its own.

async function twoWorkspaces() {
  const s = await serve();
  const a = s.seeded.storeId;
  const b = (await s.app.db.one<{ id: number }>("SELECT id FROM stores WHERE domain = 'shaked-jewelry.example'"))!.id;
  await s.app.db.query('UPDATE stores SET workspace_id = 1 WHERE id = $1', [a]);
  await s.app.db.query("UPDATE stores SET workspace_id = 2, status = 'page_ready', page_built_at = now(), notes = 'B notes' WHERE id = $1", [b]);
  const chatA = (await s.app.db.one<{ id: number }>('SELECT id FROM conversations WHERE store_id = $1 LIMIT 1', [a]))!.id;
  const chatB = (await s.app.db.one<{ id: number }>("INSERT INTO conversations (store_id, channel, peer) VALUES ($1, 'whatsapp', '972500000444') RETURNING id", [b]))!.id;
  await s.app.db.query("INSERT INTO messages (conversation_id, role, text) VALUES ($1, 'customer', 'שאלה של חנות ב')", [chatB]);
  return { s, a, b, chatA, chatB };
}

const notes = async (s: Awaited<ReturnType<typeof serve>>, id: number) => (await s.app.db.one<{ notes: string | null }>('SELECT notes FROM stores WHERE id = $1', [id]))!.notes;

test('workspace A sees and changes nothing of workspace B, on every page and action', async () => {
  const { s, a, b, chatA, chatB } = await twoWorkspaces();
  try {
    s.as(s.accounts.session(customer(1)).cookie);
    const leads = await (await s.get('/leads?all=1')).text();
    assert.match(leads, /kli-cheres\.example/);
    assert.ok(!/shaked-jewelry\.example/.test(leads), 'B is not in A\'s list');
    assert.ok(!/ein-hakore\.example/.test(leads), 'the operator\'s own leads (no workspace) are not in A\'s list');
    assert.equal((await s.get(`/lead/${a}`)).status, 200);
    for (const p of [`/lead/${b}`, `/lead/${b}/review`, `/chat/${chatB}`]) assert.equal((await s.get(p)).status, 404, p);
    assert.equal((await s.get(`/chat/${chatA}`)).status, 200);
    assert.ok(!/שאלה של חנות ב/.test(await (await s.get('/chats')).text()), 'B\'s chat is not in A\'s chats');
    assert.ok(!/st-\d+/.test((await (await s.get('/static/stores.css')).text()).replace(new RegExp(`\\.st-${a}\\{`), '')), 'only A\'s colours');
    assert.ok(!/shaked|שקד/.test(await (await s.get('/review')).text()), 'B\'s page is not in A\'s review queue');
    const token = await s.csrf(`/lead/${a}`);
    assert.ok(token);
    const r = await s.post(`/lead/${b}/notes`, { _csrf: token, notes: 'written by A' });
    assert.equal(r.status, 404);
    assert.equal(await notes(s, b), 'B notes', 'A changed nothing of B');
    await s.post('/review/approve-all', { _csrf: token, ids: String(b) });
    assert.equal((await s.app.db.one<any>('SELECT approved_at FROM stores WHERE id = $1', [b])).approved_at, null, 'approve-all skips B\'s ids');
    assert.equal((await s.post('/settings/offer', { _csrf: token, monthly: '1' })).status, 403, 'the offer is the operator\'s');
    assert.ok(!/action="\/settings\/discover"/.test(await (await s.get('/settings')).text()), 'no lead discovery for a customer');
    assert.equal((await s.post(`/lead/${a}/notes`, { _csrf: token, notes: 'A notes' })).status, 303);
    assert.equal(await notes(s, a), 'A notes', 'A changes its own');
    // The owner's assistant (pages/assistant.ts): B's is not A's to read, to write to, or to give a number to.
    assert.equal((await s.get(`/lead/${a}/assistant`)).status, 200);
    assert.equal((await s.get(`/lead/${b}/assistant`)).status, 404);
    assert.equal((await s.post(`/lead/${b}/assistant`, { _csrf: token, text: 'מה קרה היום?' })).status, 404);
    assert.equal((await s.app.db.one<any>('SELECT COUNT(*)::int AS n FROM assistant_messages WHERE store_id = $1', [b])).n, 0, 'nothing reached B\'s assistant');
    // The owner's numbers are linked in accounts (src/owners/identity.ts): no form here makes a number an owner's.
    assert.equal((await s.post(`/lead/${a}/owner-phones`, { _csrf: token, phones: '050-0000999' })).status, 404);
    assert.match(await (await s.get(`/lead/${a}/assistant`)).text(), /לחבר מספר בחשבון/);

    s.login();
    const all = await (await s.get('/leads?all=1')).text();
    assert.match(all, /kli-cheres\.example/);
    assert.match(all, /shaked-jewelry\.example/, 'the operator sees every workspace');
    assert.equal((await s.get(`/chat/${chatB}`)).status, 200);
  } finally {
    await s.close();
  }
});

test('a POST right after signing out is refused, even while pages may still use the cached answer', async () => {
  const { s, a } = await twoWorkspaces();
  try {
    const me = s.accounts.session(customer(1));
    s.as(me.cookie);
    const token = await s.csrf(`/lead/${a}`);
    assert.ok(token);
    s.accounts.answer(me.sid, null); // signed out at accounts
    const r = await s.post(`/lead/${a}/notes`, { _csrf: token, notes: 'after sign-out' });
    assert.equal(r.status, 303);
    assert.match(String(r.headers.get('location')), /^https:\/\/accounts\.test\/login\?next=/);
    const ajax = await s.post(`/lead/${a}/notes`, { _csrf: token, notes: 'after sign-out' }, { 'x-tn-ajax': '1' });
    assert.equal(ajax.status, 401);
    assert.notEqual(await notes(s, a), 'after sign-out');
  } finally {
    await s.close();
  }
});

test('view-as is read-only: the pages open with the banner, every POST is refused', async () => {
  const { s, a } = await twoWorkspaces();
  try {
    s.as(s.accounts.session(viewingAs(1)).cookie);
    const page = await (await s.get(`/lead/${a}`)).text();
    assert.match(page, /class="viewas"/);
    assert.match(page, /<body class="ro">/);
    const token = await s.csrf(`/lead/${a}`);
    for (const p of [`/lead/${a}/notes`, `/lead/${a}/skip`, `/lead/${a}/status`]) assert.equal((await s.post(p, { _csrf: token, notes: 'x', status: 'paid' })).status, 403, p);
    assert.notEqual(await notes(s, a), 'x');
    assert.notEqual((await s.app.db.one<any>('SELECT status FROM stores WHERE id = $1', [a])).status, 'skipped');
  } finally {
    await s.close();
  }
});

test('the public routes need no session and never ask accounts: pitch pages, the beacon, the webhook, /healthz', async () => {
  const { s, a } = await twoWorkspaces();
  try {
    await setOffer(s.app.db, TEST_OFFER);
    await s.app.db.query("UPDATE stores SET status = 'sent', approved_at = now() WHERE id = $1", [a]);
    const before = s.accounts.calls;
    assert.equal((await fetch(`${s.base}/healthz`)).status, 200);
    assert.equal((await fetch(`${s.base}/s/${s.seeded.slug}`)).status, 200);
    assert.equal((await fetch(`${s.base}/s/${s.seeded.slug}/theme.css`)).status, 200);
    assert.equal((await fetch(`${s.base}/t`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slug: s.seeded.slug, kind: 'scroll', depth: 50 }) })).status, 204);
    assert.equal((await fetch(`${s.base}/wa/sim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: '972500000555', text: s.seeded.code, id: 'pub-1' }) })).status, 200);
    assert.equal(s.accounts.calls, before, 'no cookie, no question to accounts');
    // Another workspace's session is a visitor on this store's page: it counts as an open, sees no owner note.
    s.as(s.accounts.session(customer(2)).cookie);
    assert.ok(!/class="held"/.test(await (await s.get(`/s/${s.seeded.slug}`)).text()));
  } finally {
    await s.close();
  }
});

test('a demo asked for on the website: only with the shared token and never through Caddy; it is written down and waits for its WhatsApp message', async () => {
  const s = await serve();
  try {
    const token = String(s.app.env.OF_INTERNAL_TOKEN);
    const send = (body: unknown, headers: Record<string, string> = {}) =>
      fetch(`${s.base}/internal/lead`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers }, body: JSON.stringify(body) });
    const ask = { url: 'https://www.new-shop.co.il/collections/sale', code: 'REQ-K7M2Q9' };
    assert.equal((await send(ask, { authorization: 'Bearer not-the-token-not-the-token-not-the' })).status, 403);
    assert.equal((await send(ask, { 'x-forwarded-for': '203.0.113.9' })).status, 403, 'from outside, through Caddy');
    assert.equal((await send({ url: 'new-shop.co.il', code: 'nope' })).status, 400);
    assert.equal((await send({ url: 'new-shop.co.il', whatsapp: '972500000123' })).status, 400, 'a typed number proves nothing: no code, no request');
    const before = s.accounts.calls;
    const jobsBefore = (await s.app.db.query("SELECT 1 FROM jobs WHERE kind = 'add_store'")).length;
    assert.equal((await send(ask)).status, 200);
    const row = await s.app.db.one<any>("SELECT url, domain, phone FROM demo_requests WHERE code = 'REQ-K7M2Q9'");
    assert.deepEqual(row, { url: 'https://www.new-shop.co.il/', domain: 'new-shop.co.il', phone: null });
    assert.equal((await s.app.db.query("SELECT 1 FROM jobs WHERE kind = 'add_store'")).length, jobsBefore, 'nothing is fetched until the person writes');
    assert.equal(s.accounts.calls, before, 'the website is no session: accounts is never asked');
  } finally {
    await s.close();
  }
});

test('a workspace without Toran, a closed workspace, and accounts down: refused, never let through', async () => {
  const s = await serve();
  try {
    s.as(s.accounts.session({ status: 403, body: { error: 'product_disabled' } }).cookie);
    let r = await s.get('/');
    assert.equal(r.status, 403);
    assert.match(await r.text(), /data-refusal="not_in_plan"/);
    // A 200 whose workspace has no Toran is not believed either.
    s.as(s.accounts.session(customer(1, { products: ['teder'] })).cookie);
    r = await s.get('/');
    assert.equal(r.status, 503);
    assert.match(await r.text(), /data-refusal="error"/);
    s.as(s.accounts.session({ status: 403, body: { error: 'workspace_disabled' } }).cookie);
    r = await s.get('/leads');
    assert.equal(r.status, 403);
    assert.match(await r.text(), /data-refusal="closed"/);
    const token = await s.csrf();
    assert.equal((await s.post('/lead/1/notes', { _csrf: token, notes: 'x' })).status, 403);
    // Accounts not answering at all: an error page, not a loop through the login, and no way in.
    const me = s.accounts.session(customer(1));
    s.as(me.cookie);
    await s.accounts.close();
    r = await s.get('/');
    assert.equal(r.status, 503);
    assert.match(await r.text(), /אי אפשר להיכנס כרגע/);
  } finally {
    s.server.close();
    await s.app.db.close();
  }
});

test('the accounts client: pages reuse an answer for 60 seconds, a POST always asks, and a refusal is never cached', async () => {
  let t = 0;
  let calls = 0;
  let status = 200;
  const body = customer(1);
  const fetchImpl = async () => {
    calls++;
    return new Response(JSON.stringify(status === 200 ? body : { error: 'no_session' }), { status });
  };
  const c = accountsClient({ env: { OF_INTERNAL_TOKEN: 'x'.repeat(40) }, fetchImpl, clock: () => t });
  const sid = 'a'.repeat(43);
  assert.equal((await c.whoIs(sid)).status, 200);
  t += 59_000;
  assert.equal((await c.whoIs(sid)).cached, true);
  assert.equal(calls, 1);
  assert.equal((await c.whoIs(sid, { live: true })).cached, false, 'a POST asks afresh');
  assert.equal(calls, 2);
  t += 61_000;
  status = 401;
  assert.equal((await c.whoIs(sid)).status, 401, 'past 60 seconds: asked again');
  assert.equal((await c.whoIs(sid)).status, 401);
  assert.equal(calls, 4, 'a refusal is not cached');
  const unset = accountsClient({ env: {}, fetchImpl });
  assert.equal((await unset.whoIs(sid)).status, 503, 'no OF_INTERNAL_TOKEN: nobody signs in');
});
