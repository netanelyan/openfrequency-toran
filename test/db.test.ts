import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { J, JSON_TYPE } from '../src/db/index.ts';
import { enqueue } from '../src/jobs/queue.ts';
import { testDb } from './helpers.ts';

// The database layer (db/index.ts): Postgres in production, PGlite here, or the Postgres CI runs (TORAN_TEST_DATABASE_URL).

test('json and jsonb parameters go to Postgres as the JSON text callers pass, not that text JSON-encoded again', () => {
  // The driver's own serializer, kept only for what is not text yet.
  assert.equal(JSON_TYPE.serialize(J({ storeId: 95 })), '{"storeId":95}');
  assert.equal(JSON_TYPE.serialize({ storeId: 95 }), '{"storeId":95}');
  assert.equal(JSON_TYPE.serialize(J('שלום')), '"שלום"');
  // And the driver takes it for both types (114 json, 3802 jsonb). postgres() opens no connection until a query.
  const sql = postgres('postgres://nobody@127.0.0.1:1/none', { types: { json: JSON_TYPE } }) as any;
  for (const oid of [114, 3802]) assert.equal(sql.options.serializers[oid](J({ a: [1, 2] })), '{"a":[1,2]}');
  const stock = postgres('postgres://nobody@127.0.0.1:1/none') as any;
  assert.equal(stock.options.serializers[3802](J({ a: 1 })), '"{\\"a\\":1}"', 'the bug: without it, the text is encoded twice');
});

test('migration 020 gives back what a doubly encoded value meant, and leaves a true string alone', async () => {
  const db = await testDb();
  try {
    const job = await enqueue(db, 'rescrape', { storeId: 95 });
    // As the driver wrote them, from the move to Postgres until the fix.
    await db.query('UPDATE jobs SET payload = to_jsonb($1::text) WHERE id = $2', [J({ storeId: 95 }), job]);
    const text = await enqueue(db, 'rescrape', 'not json at all');
    const nul = await enqueue(db, 'rescrape', null);
    await db.query('UPDATE jobs SET payload = to_jsonb($1::text) WHERE id = $2', [J(null), nul]);
    assert.equal((await db.one<any>('SELECT jsonb_typeof(payload) AS t FROM jobs WHERE id = $1', [job])).t, 'string');

    await db.exec(readFileSync(new URL('../src/db/migrations/020_json_unwrap.sql', import.meta.url), 'utf8'));
    assert.deepEqual((await db.one<any>('SELECT payload FROM jobs WHERE id = $1', [job])).payload, { storeId: 95 });
    assert.equal((await db.one<any>('SELECT payload FROM jobs WHERE id = $1', [text])).payload, 'not json at all');
    assert.equal((await db.one<any>('SELECT jsonb_typeof(payload) AS t FROM jobs WHERE id = $1', [nul])).t, 'null');
  } finally {
    await db.close();
  }
});
