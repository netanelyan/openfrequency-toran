import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enqueue } from '../src/jobs/queue.ts';
import { usage } from '../src/db/log.ts';
import { customer } from './helpers.ts';
import { serve } from './serve.ts';

// A workspace deleted in openfrequency-accounts (its src/accounts/erase.js): Toran's POST
// /internal/workspaces/<id>/delete (src/erase.ts), through the real route, from this machine with the internal token.

test('a workspace deleted in accounts: POST /internal/workspaces/<id>/delete takes everything of it, answers 200 when nothing was there, and refuses without the token', async () => {
  const s = await serve();
  try {
    const { app } = s;
    const store = (await app.db.one<{ id: number }>("INSERT INTO stores (domain, url, name, source, platform, workspace_id) VALUES ('mine.example', 'https://mine.example/', 'שלי', 'signup', 'shopify', 42) RETURNING id"))!.id;
    const acc = (await app.db.one<{ id: number }>("INSERT INTO channel_accounts (store_id, channel, kind, external_id) VALUES ($1, 'whatsapp', 'meta', '1234567') RETURNING id", [store]))!.id;
    const conv = (await app.db.one<{ id: number }>("INSERT INTO conversations (store_id, channel, peer, account_id) VALUES ($1, 'whatsapp', '972500000600', $2) RETURNING id", [store, acc]))!.id;
    await app.db.query("INSERT INTO messages (conversation_id, role, text) VALUES ($1, 'customer', 'שלום')", [conv]);
    await app.db.query("INSERT INTO owner_numbers (phone, workspace_id, user_id) VALUES ('972500000601', 42, 1)");
    await enqueue(app.db, 'wa_inbound', { from: '972500000600', account: '1234567', id: 'w1' });
    await usage(app.db, { storeId: store, kind: 'llm', usd: 0.5, tag: 'agent' });
    const del = (id: number, token = app.env.OF_INTERNAL_TOKEN) => fetch(`${s.base}/internal/workspaces/${id}/delete`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' });
    // The contract's cases (openfrequency-accounts docs/contracts/workspaces-delete.json).
    const wrong = await del(42, 'wrong-token-wrong-token-wrong-token-00');
    assert.equal(wrong.status, 401);
    assert.equal((await wrong.json()).error, 'bad_token');
    const none = await fetch(`${s.base}/internal/workspaces/42/delete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(none.status, 401, 'no token at all');
    const forwarded = await fetch(`${s.base}/internal/workspaces/42/delete`, { method: 'POST', headers: { authorization: `Bearer ${app.env.OF_INTERNAL_TOKEN}`, 'x-forwarded-for': '203.0.113.9', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(forwarded.status, 403, 'through Caddy: never');
    const never = await del(9999);
    assert.equal(never.status, 200, 'a workspace Toran never saw');
    const nothing = await never.json();
    assert.equal(nothing.ok, true);
    assert.ok(Object.values(nothing.deleted).every((n) => n === 0), 'every count zero');
    const r = await del(42);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.deleted.stores, 1);
    assert.equal(body.deleted.conversations, 1);
    assert.equal(body.deleted.messages, 1);
    assert.equal(body.deleted.jobs, 1);
    assert.equal(await app.db.one('SELECT 1 FROM stores WHERE workspace_id = 42'), null);
    assert.equal(await app.db.one("SELECT 1 FROM owner_numbers WHERE workspace_id = 42"), null);
    assert.equal(await app.db.one("SELECT 1 FROM channel_accounts WHERE external_id = '1234567'"), null);
    assert.ok(await app.db.one('SELECT 1 FROM usage WHERE store_id IS NULL AND usd = 0.5'), 'what it cost stays, without the store');
    const again = await del(42);
    assert.equal(again.status, 200, 'nothing there: still 200');
    assert.equal((await again.json()).deleted.stores, 0);
    const token = app.env.OF_INTERNAL_TOKEN;
    app.env.OF_INTERNAL_TOKEN = 'short';
    const unset = await del(42, 'short');
    assert.equal(unset.status, 503);
    assert.equal((await unset.json()).error, 'not_configured');
    app.env.OF_INTERNAL_TOKEN = token;
  } finally {
    await s.close();
  }
});

// The operator's "למחוק את החנות" on a store's page (src/erase.ts eraseStore): the store's accounts at Zernio are
// disconnected there first, then its profile, and only then is everything of it deleted here. A disconnect Zernio
// refuses stops it before anything is gone.
test('"למחוק את החנות": the store leaves Zernio first, then everything of it goes here; a refusal at Zernio deletes nothing; customers and the company store are refused', async () => {
  const s = await serve();
  try {
    const { app } = s;
    const KEY = 'sk_zernio_erase_test';
    Object.assign(app.env, { ZERNIO_API_KEY: KEY, ZERNIO_WEBHOOK_SECRET: 'zernio-webhook-secret-0123456789', PUBLIC_BASE_URL: 'https://toran.test' });
    const calls: string[] = [];
    let refuse = true;
    app.graph = (async (input: any, init: any = {}) => {
      const u = new URL(String(input));
      const method = String(init.method || 'GET');
      calls.push(`${method} ${u.pathname}`);
      const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
      if ((init.headers || {}).authorization !== `Bearer ${KEY}`) return json({ error: 'Unauthorized' }, 401);
      if (method === 'DELETE' && /^\/api\/v1\/accounts\/[0-9a-f]{24}$/.test(u.pathname)) return refuse ? json({ error: 'try later' }, 503) : json({ message: 'Disconnected' });
      if (method === 'DELETE' && /^\/api\/v1\/profiles\/[0-9a-f]{24}$/.test(u.pathname)) return json({ message: 'Deleted' });
      return json({ error: 'no route' }, 404);
    }) as typeof fetch;
    const store = (await app.db.one<{ id: number }>("INSERT INTO stores (domain, url, name, source, platform, workspace_id) VALUES ('test-shop.example', 'https://test-shop.example/', 'My Store 10', 'signup', 'shopify', 7) RETURNING id"))!.id;
    const ig = 'a1b2c3d4e5f6a7b8c9d0e1f2';
    const acc = (await app.db.one<{ id: number }>("INSERT INTO channel_accounts (store_id, channel, kind, external_id, status) VALUES ($1, 'instagram', 'zernio', $2, 'active') RETURNING id", [store, ig]))!.id;
    await app.db.query("INSERT INTO zernio_profiles (store_id, profile_id) VALUES ($1, 'b1b2c3d4e5f6a7b8c9d0e1f2')", [store]);
    const conv = (await app.db.one<{ id: number }>("INSERT INTO conversations (store_id, channel, peer, account_id) VALUES ($1, 'instagram', '17841400000000001', $2) RETURNING id", [store, acc]))!.id;
    await app.db.query("INSERT INTO messages (conversation_id, role, text) VALUES ($1, 'customer', 'יש משלוח לאילת?')", [conv]);
    await app.db.query("INSERT INTO domain_claims (workspace_id, domain, url, token, proven_at, how) VALUES (7, 'test-shop.example', 'https://test-shop.example/', 'tok', now(), 'meta')");
    await usage(app.db, { storeId: store, kind: 'llm', usd: 0.25, tag: 'agent' });
    const press = async (id: number) => s.post(`/lead/${id}/delete`, { _csrf: await s.csrf(`/lead/${id}`) });

    // A customer of that workspace may not, even for their own store.
    s.as(s.accounts.session(customer(7)).cookie);
    assert.equal((await s.post(`/lead/${store}/delete`, { _csrf: 'x' })).status, 403, 'the operator\'s alone');

    s.login();
    // Zernio refuses the disconnect: nothing is deleted here, and the page says so.
    const no = await press(store);
    assert.ok(no.status < 500, `answered ${no.status}`);
    assert.ok(await app.db.one('SELECT 1 FROM stores WHERE id = $1', [store]), 'the store stays');
    assert.ok(await app.db.one("SELECT 1 FROM channel_accounts WHERE id = $1 AND status = 'active'", [acc]), 'its account stays on, to try again');
    assert.ok(await app.db.one('SELECT 1 FROM zernio_profiles WHERE store_id = $1', [store]), 'its profile stays');

    refuse = false;
    calls.length = 0;
    const yes = await press(store);
    assert.equal(yes.status, 303);
    assert.match(String(yes.headers.get('location')), /\/leads$/);
    assert.deepEqual(calls, [`DELETE /api/v1/accounts/${ig}`, 'DELETE /api/v1/profiles/b1b2c3d4e5f6a7b8c9d0e1f2'], 'the account at Zernio first, then the profile');
    assert.equal(await app.db.one('SELECT 1 FROM stores WHERE id = $1', [store]), null);
    assert.equal(await app.db.one('SELECT 1 FROM conversations WHERE id = $1', [conv]), null);
    assert.equal(await app.db.one('SELECT 1 FROM channel_accounts WHERE id = $1', [acc]), null);
    assert.equal(await app.db.one("SELECT 1 FROM domain_claims WHERE domain = 'test-shop.example'"), null, 'adding the site again asks to prove it again');
    assert.ok(await app.db.one('SELECT 1 FROM usage WHERE store_id IS NULL AND usd = 0.25'), 'what it cost stays, without the store');
    const row = await app.db.one<{ detail: any }>("SELECT detail FROM audit WHERE action = 'store_deleted'");
    assert.equal(row?.detail.store, store);
    assert.equal(row?.detail.conversations, 1);
    assert.equal(row?.detail.messages, 1);

    // Our own company store is never deleted from here.
    const own = s.seeded.storeId;
    await app.db.query("UPDATE stores SET platform = 'company' WHERE id = $1", [own]);
    assert.doesNotMatch(await (await s.get(`/lead/${own}`)).text(), /למחוק את החנות/);
    await press(own);
    assert.ok(await app.db.one('SELECT 1 FROM stores WHERE id = $1', [own]), 'the company store stays');
  } finally {
    await s.close();
  }
});
