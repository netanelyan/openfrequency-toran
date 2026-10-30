import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enqueue } from '../src/jobs/queue.ts';
import { usage } from '../src/db/log.ts';
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
