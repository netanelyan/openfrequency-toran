import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { firstConnection, migrate, migrationFiles, migrationStatus, openDb, pgOptions, PG_LIMITS, SchemaError, timeoutLine, withDbLabel } from '../src/db/index.ts';
import { backupAgeMs, BACKUP_FRESH_MS } from '../src/db/backup.ts';
import { claim, enqueue } from '../src/jobs/queue.ts';
import { readiness, workerBeat } from '../src/health.ts';
import { createHandler } from '../src/web/server.ts';
import { refusals, tapSummary } from '../scripts/release-check.ts';
import { testApp, testDb } from './helpers.ts';

// What operations lean on: the schema check, the first connection after a reboot, the limits on every connection,
// the readiness page the deploy and the uptime monitor wait on, the backup the migrate step asks for, and the release
// check. On PGlite here; CI runs the same file on Postgres (TORAN_TEST_DATABASE_URL).

test('a database holding a migration this build has no file for is refused, in every mode', async () => {
  const db = await testDb();
  try {
    await db.query("INSERT INTO schema_migrations (name) VALUES ('999_from_a_newer_build.sql')");
    await assert.rejects(migrate(db), (e: any) => e instanceof SchemaError && e.code === 'schema_ahead' && e.names.includes('999_from_a_newer_build.sql'));
    await assert.rejects(migrate(db, { apply: false }), (e: any) => e.code === 'schema_ahead');
    assert.deepEqual((await migrationStatus(db)).unknown, ['999_from_a_newer_build.sql']);
  } finally {
    await db.close();
  }
});

test('TORAN_MIGRATE=check opens only a schema already up to date, and applies nothing', async () => {
  const db = await testDb();
  try {
    const last = migrationFiles().at(-1)!;
    assert.deepEqual(await migrate(db, { apply: false }), [], 'up to date: opens');
    await db.query('DELETE FROM schema_migrations WHERE name = $1', [last]);
    await assert.rejects(migrate(db, { apply: false }), (e: any) => e.code === 'schema_behind' && e.names[0] === last);
    assert.deepEqual((await migrationStatus(db)).pending, [last], 'nothing was applied');
  } finally {
    await db.close();
  }
});

test("a rollback's question: does that older build know every migration the database holds?", async () => {
  const db = await testDb();
  try {
    // An older release's migrations folder: everything but this build's last migration.
    const older = mkdtempSync(path.join(os.tmpdir(), 'toran-older-'));
    const files = migrationFiles();
    for (const f of files.slice(0, -1)) writeFileSync(path.join(older, f), '-- as it was');
    assert.deepEqual(await migrationStatus(db, older), { applied: files, pending: [], unknown: [files.at(-1)!] });
    // The same folder as this build's: nothing unknown, nothing pending.
    assert.deepEqual((await migrationStatus(db)).unknown, []);
  } finally {
    await db.close();
  }
});

test('the first connection is tried again while the server is starting, for a while, and each try is logged', async () => {
  const lines: string[] = [];
  const waits: number[] = [];
  let n = 0;
  const up = await firstConnection(
    async () => {
      if (++n < 4) throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
    },
    { withinMs: 60_000, log: (m) => lines.push(m), sleep: async (ms) => void waits.push(ms) },
  );
  assert.equal(up, 4);
  assert.deepEqual(waits, [500, 1000, 2000]);
  assert.equal(lines.filter((l) => /not answering yet \(ECONNREFUSED\)/.test(l)).length, 3);
  assert.match(lines.at(-1)!, /connected on try 4/);

  // A wrong password is not a server starting up: no waiting.
  await assert.rejects(firstConnection(async () => Promise.reject(Object.assign(new Error('bad password'), { code: '28P01' })), { log: () => {}, sleep: async () => assert.fail('no wait') }), /bad password/);
  // And the waiting ends.
  await assert.rejects(firstConnection(async () => Promise.reject(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })), { withinMs: 30, log: () => {} }), /refused/);
});

test('a real Postgres that is not there: openDb gives up after its window, having tried more than once', async () => {
  const lines: string[] = [];
  const t = Date.now();
  await assert.rejects(openDb({ url: 'postgres://nobody@127.0.0.1:1/none', log: (m) => lines.push(m), connectWithinMs: 1200 }), (e: any) => e.code === 'ECONNREFUSED');
  assert.ok(Date.now() - t >= 1000, 'it waited');
  assert.ok(lines.some((l) => /try 2/.test(l)), lines.join('\n'));
});

test('every production connection carries a statement, lock and idle-transaction limit, and its name', () => {
  const o = pgOptions();
  assert.deepEqual(o.connection, { application_name: 'toran', statement_timeout: 15_000, lock_timeout: 5_000, idle_in_transaction_session_timeout: 30_000 });
  assert.equal(o.idle_timeout, 60);
  assert.equal(o.connect_timeout, 10);
  assert.equal(pgOptions({ test: true }).idle_timeout, 1, "a test's idle connections close at once, so its process can end");
  assert.deepEqual(PG_LIMITS, { statement_timeout: 15_000, lock_timeout: 5_000, idle_in_transaction_session_timeout: 30_000 });
});

test('a query the server cancels for a limit is logged with the job it ran in', async () => {
  const lines: string[] = [];
  const db = await openDb({ memory: true, log: (m) => lines.push(m) });
  try {
    // The server's own error for a statement that ran past statement_timeout, raised on purpose.
    const cancelled = "DO $$ BEGIN RAISE EXCEPTION 'canceling statement due to statement timeout' USING ERRCODE = '57014'; END $$";
    await assert.rejects(withDbLabel('job wa_inbound', () => db.exec(cancelled)), (e: any) => e.code === '57014');
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^\[db\] statement timeout in job wa_inbound: DO \$\$ BEGIN RAISE/);
    // Any other error is not a timeout and is not logged here.
    await assert.rejects(db.exec("DO $$ BEGIN RAISE EXCEPTION 'nope'; END $$"));
    assert.equal(lines.length, 1);
    assert.equal(timeoutLine({ code: '55P03' }, 'UPDATE jobs SET x = 1', 'job ingest'), '[db] lock timeout in job ingest: UPDATE jobs SET x = 1');
    assert.equal(timeoutLine({ code: '23505' }, 'INSERT'), null);
  } finally {
    await db.close();
  }
});

test("a transaction can ask for a longer statement limit for itself alone (an ingest's write)", async () => {
  const db = await testDb();
  try {
    const inside = await db.tx(async (t) => (await t.one<{ statement_timeout: string }>('SHOW statement_timeout'))!.statement_timeout, { statementTimeoutMs: 120_000 });
    assert.equal(inside, '2min');
    const after = (await db.one<{ statement_timeout: string }>('SHOW statement_timeout'))!.statement_timeout;
    assert.notEqual(after, '2min', 'SET LOCAL ends with its transaction');
  } finally {
    await db.close();
  }
});

test('two connections claiming at once take two different jobs (FOR UPDATE SKIP LOCKED)', async () => {
  const a = await testDb();
  // On Postgres a second connection of its own; PGlite has one connection, and the two claims run in turn.
  const b = a.url ? await openDb({ url: a.url, test: true }) : a;
  try {
    const ids = [await enqueue(a, 'rescrape', { storeId: 1 }), await enqueue(a, 'rescrape', { storeId: 2 })];
    const [x, y] = await Promise.all([claim(a), claim(b)]);
    assert.ok(x && y);
    assert.notEqual(x.id, y.id);
    assert.deepEqual([x.id, y.id].sort((m, n) => m - n), ids.sort((m, n) => m - n));
    assert.equal(await claim(a), null, 'nothing left to take');
  } finally {
    if (b !== a) await b.close();
    await a.close();
  }
});

test('/readyz: the database, a worker loop alive in the last two minutes, and no customer message waiting five', async () => {
  const app = await testApp();
  try {
    let r = await readiness(app);
    assert.deepEqual({ ok: r.ok, db: r.db, worker: r.worker, queue: r.queue }, { ok: false, db: true, worker: false, queue: true }, 'no loop has run yet');
    await workerBeat(app, { force: true });
    r = await readiness(app);
    assert.equal(r.ok, true);

    // A loop that stopped three minutes ago.
    await app.db.query("UPDATE worker_beats SET at = now() - interval '3 minutes'");
    assert.equal((await readiness(app)).worker, false);
    await workerBeat(app, { force: true });

    // A customer's message due six minutes ago that no loop took; a rescrape waiting as long is no customer.
    await enqueue(app.db, 'rescrape', { storeId: 1 }, { runAt: new Date(Date.now() - 6 * 60_000) });
    assert.equal((await readiness(app)).queue, true);
    const late = await enqueue(app.db, 'wa_inbound', { from: 'x' }, { runAt: new Date(Date.now() - 6 * 60_000) });
    r = await readiness(app);
    assert.deepEqual({ ok: r.ok, queue: r.queue }, { ok: false, queue: false });
    // A retry set for later is not waiting yet.
    await app.db.query("UPDATE jobs SET run_at = now() + interval '4 minutes' WHERE id = $1", [late]);
    assert.equal((await readiness(app)).ok, true);
  } finally {
    await app.db.close();
  }
});

test('/healthz says the build, /readyz answers 200 or 503 with the checks and nothing else, never cached', async () => {
  const app = await testApp();
  app.env.TORAN_REVISION = 'abc1234';
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  server.on('request', createHandler(app, { port }));
  const base = `http://127.0.0.1:${port}`;
  try {
    const h = await fetch(`${base}/healthz`);
    assert.equal(h.status, 200);
    assert.equal(await h.text(), 'ok abc1234');
    let r = await fetch(`${base}/readyz`);
    assert.equal(r.status, 503);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await r.json(), { ok: false, db: true, worker: false, queue: true, revision: 'abc1234' });
    await workerBeat(app, { force: true });
    r = await fetch(`${base}/readyz`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, db: true, worker: true, queue: true, revision: 'abc1234' });
    // Right after a deploy: the old build's loop wrote a moment ago, the new build's has not yet.
    await app.db.query("UPDATE worker_beats SET revision = 'old0000'");
    assert.equal((await fetch(`${base}/readyz`)).status, 503);
  } finally {
    server.close();
    await app.db.close();
  }
});

test('the migrate step reads the age of the newest backup from the folder, or from the deploy that took one', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'toran-backups-'));
  const now = Date.now();
  assert.equal(backupAgeMs({ TORAN_BACKUP_DIR: dir }, now), null, 'no backup');
  const old = path.join(dir, 'toran-20261020-0345.sql.gz');
  writeFileSync(old, 'x');
  utimesSync(old, new Date(now - 9 * 3_600_000), new Date(now - 9 * 3_600_000));
  writeFileSync(path.join(dir, 'notes.txt'), 'not a dump');
  const age = backupAgeMs({ TORAN_BACKUP_DIR: dir }, now)!;
  assert.ok(age > BACKUP_FRESH_MS, 'nine hours old');
  const fresh = path.join(dir, 'toran-20261029-1200.dump');
  writeFileSync(fresh, 'x');
  utimesSync(fresh, new Date(now - 5 * 60_000), new Date(now - 5 * 60_000));
  assert.ok(backupAgeMs({ TORAN_BACKUP_DIR: dir }, now)! < BACKUP_FRESH_MS);
  writeFileSync(path.join(dir, 'toran-20261029-1300.dump'), '');
  assert.ok(backupAgeMs({ TORAN_BACKUP_DIR: dir }, now)! >= 4 * 60_000, 'an empty dump is no backup');
  // A folder the deploy's user cannot read: the time of the dump the deploy took and checked.
  assert.ok(backupAgeMs({ TORAN_BACKUP_DIR: path.join(dir, 'nope'), TORAN_BACKUP_TAKEN_AT: new Date(now - 60_000).toISOString() }, now)! <= 60_000);
  assert.equal(backupAgeMs({ TORAN_BACKUP_DIR: path.join(dir, 'nope'), TORAN_BACKUP_TAKEN_AT: 'yesterday' }, now), null);
});

test('the release check refuses a failed, cancelled or skipped test, and lets a todo through', () => {
  const tap = (o: Record<string, number>) => Object.entries({ tests: 10, suites: 0, pass: 10, fail: 0, cancelled: 0, skipped: 0, todo: 0, ...o }).map(([k, v]) => `# ${k} ${v}`).join('\n');
  assert.deepEqual(tapSummary(`TAP version 13\nok 1 - x\n${tap({})}\n# duration_ms 12.5\n`), { tests: 10, pass: 10, fail: 0, cancelled: 0, skipped: 0, todo: 0 });
  assert.deepEqual(refusals(tapSummary(tap({})), 0), []);
  assert.deepEqual(refusals(tapSummary(tap({ pass: 8, todo: 2 })), 0), []);
  assert.deepEqual(refusals(tapSummary(tap({ pass: 9, skipped: 1 })), 0), ['1 skipped (a check that did not run)']);
  assert.deepEqual(refusals(tapSummary(tap({ pass: 8, fail: 1, cancelled: 1 })), 1), ['1 failed', '1 cancelled']);
  assert.deepEqual(refusals(tapSummary('not ok 1 - crashed\n'), 1), ['the test run ended before its summary']);
  assert.deepEqual(refusals(tapSummary(tap({})), 1), ['the test runner exited 1']);
});
