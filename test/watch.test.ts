import { test } from 'node:test';
import assert from 'node:assert/strict';
import { watchStores } from '../src/ops/watch.ts';
import { customerHealth } from '../src/ops/health.ts';
import { testApp } from './helpers.ts';

// The operator's eye on customers' stores (TORAN-READINESS.md P1-25, P1-26): once a day, a store over its plan and a
// store stuck with nothing connected are alerted; and one health row a store for /admin.

async function app() {
  const a = await testApp();
  a.env.TORAN_ALERT_COMMAND = '';
  const store = async (domain: string, o: { ingestedDaysAgo?: number } = {}) =>
    (await a.db.one<{ id: number }>(
      `INSERT INTO stores (domain, url, name, platform, source, slug, workspace_id, ingested_at) VALUES ($1, $2, $1, 'shopify', 'signup', $1, 3, now() - ($3 || ' days')::interval) RETURNING id`,
      [domain, `https://${domain}/`, String(o.ingestedDaysAgo ?? 0)],
    ))!.id;
  return { a, store };
}

test('once a day: a store over its plan this month and a store with nothing connected three days after its site was read are alerted', async () => {
  const { a, store } = await app();
  try {
    const busy = await store('busy.example');
    const stuck = await store('stuck.example', { ingestedDaysAgo: 4 });
    const fresh = await store('fresh.example', { ingestedDaysAgo: 1 });
    const acc = (await a.db.one<{ id: number }>("INSERT INTO channel_accounts (store_id, channel, kind, external_id, name) VALUES ($1, 'email', 'sim', 'busy@in.toran.test', 'b') RETURNING id", [busy]))!.id;
    // 301 conversations with a customer message this month: over the store plan's 300.
    await a.db.query("INSERT INTO conversations (store_id, channel, peer, account_id) SELECT $1, 'email', 'c' || g || '@example.test', $2 FROM generate_series(1, 301) g", [busy, acc]);
    await a.db.query("INSERT INTO messages (conversation_id, role, text) SELECT id, 'customer', 'שאלה' FROM conversations WHERE store_id = $1", [busy]);

    const r = await watchStores(a, { force: true });
    assert.deepEqual(r!.over, [busy]);
    assert.deepEqual(r!.stuck, [stuck], `not ${fresh}: read a day ago`);
    const titles = (await a.db.query<any>("SELECT data->>'title' AS t FROM events WHERE kind = 'operator_alert' ORDER BY id")).map((x) => x.t);
    assert.ok(titles.some((t) => /busy\.example מעל החבילה החודש/.test(t)));
    assert.ok(titles.some((t) => /stuck\.example עוד לא חיברה ערוץ/.test(t)));
    assert.equal(await watchStores(a), null, 'once a day');

    const rows = await customerHealth(a);
    const b = rows.find((x) => x.storeId === busy)!;
    assert.equal(b.conversations, 301);
    assert.equal(b.cap, 300);
    assert.equal(b.live, 'live');
    assert.deepEqual(b.channels, [{ channel: 'email', kind: 'sim', status: 'active' }]);
    assert.match(b.lastAlert!.title, /מעל החבילה/);
    assert.equal(rows.find((x) => x.storeId === stuck)!.channels.length, 0);
  } finally {
    await a.db.close();
  }
});
