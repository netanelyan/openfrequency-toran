import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedDemo } from '../src/demoSeed.ts';
import { claim, enqueue, MESSAGE_KINDS } from '../src/jobs/queue.ts';
import { deadlineMs, LONG_JOB_MINUTES, QUICK_JOB_MINUTES, JOB_MINUTES, runOne, schedule, startWorker } from '../src/jobs/worker.ts';
import { turnOn } from '../src/channels/web.ts';
import { setLive } from '../src/golive.ts';
import { setupStoreOf, storeState } from '../src/setup.ts';
import type { App } from '../src/app.ts';
import { testApp } from './helpers.ts';

// The worker's deadlines and its loops (the 2026-11-12 audit, P1-26): one ingest that never ended held the only
// background loop, and with it the schedule (the five-minute queue alert included), the owners' email about a waiting
// customer and Zernio's echoes, for good, while /readyz stayed green. Now each job has a deadline by its kind, the short
// jobs someone waits on have a loop of their own, and the schedule a timer of its own.

const status = async (app: App, id: number) => (await app.db.one<{ status: string }>('SELECT status FROM jobs WHERE id = $1', [id]))?.status;

/** Wait for `ok` to be true, asking every 30 ms, for at most `ms`; fail with `what` after that. */
async function until(ok: () => Promise<boolean>, what: string, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ok()) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  assert.fail(`not within ${ms} ms: ${what}`);
}

/** A site that does not answer: every request waits until `answer()` ends them all with an error, and every later one fails at once. */
function silentSite() {
  const waiting: ((e: Error) => void)[] = [];
  let answered = false;
  const fetcher = (() => new Promise((_, reject) => (answered ? reject(new Error('refused')) : void waiting.push(reject)))) as unknown as App['fetcher'];
  return {
    fetcher,
    answer: () => {
      answered = true;
      waiting.splice(0).forEach((r) => r(new Error('the site answered at last')));
    },
  };
}

test('each kind of job has its deadline: long readings 40 minutes, the short jobs someone waits on 5, the rest 10; each can be set', () => {
  assert.equal(deadlineMs({}, 'ingest'), LONG_JOB_MINUTES * 60_000);
  assert.equal(deadlineMs({}, 'looks'), 40 * 60_000);
  assert.equal(deadlineMs({}, 'owner_waiting'), QUICK_JOB_MINUTES * 60_000);
  assert.equal(deadlineMs({}, 'zernio_echo'), 5 * 60_000);
  assert.equal(deadlineMs({}, 'wa_inbound'), JOB_MINUTES * 60_000);
  assert.equal(deadlineMs({}, 'auto_send'), 10 * 60_000);
  assert.equal(deadlineMs({ TORAN_LONG_JOB_MINUTES: '90' }, 'rescrape'), 90 * 60_000);
  assert.equal(deadlineMs({ TORAN_QUICK_JOB_MINUTES: '2' }, 'owner_waiting'), 2 * 60_000);
  assert.equal(deadlineMs({ TORAN_JOB_MINUTES: '15' }, 'web_inbound'), 15 * 60_000);
  assert.equal(deadlineMs({ TORAN_JOB_MINUTES: 'nonsense' }, 'web_inbound'), 10 * 60_000, 'a value that is not a number is the default');
});

test('a reading past its deadline is failed at once and not tried again, the operator hears of it, and its late end changes nothing', { timeout: 60_000 }, async () => {
  const app = await testApp();
  try {
    const { storeId } = await seedDemo(app, { conversation: false });
    const site = silentSite();
    app.fetcher = site.fetcher;
    const id = await enqueue(app.db, 'ingest', { storeId }, { dedupeKey: `ingest:${storeId}` });
    const job = (await claim(app.db, ['ingest']))!;
    await runOne(app, job, { deadline: 200 });
    const row = (await app.db.one<any>('SELECT status, last_error, attempts, max_attempts FROM jobs WHERE id = $1', [id]))!;
    assert.equal(row.status, 'failed', 'failed at once');
    assert.ok(row.attempts < row.max_attempts, 'though attempts were left: its work may still be running');
    assert.match(row.last_error, /deadline/);
    assert.equal(await claim(app.db, ['ingest']), null, 'not tried again by itself');
    const alert = await app.db.one<any>("SELECT store_id, data FROM events WHERE kind = 'operator_alert' AND data->>'key' = 'deadline:ingest'");
    assert.ok(alert, 'the operator hears of it');
    assert.equal(alert.store_id, storeId);
    assert.match(alert.data.title, /נתקעה/);
    // The site answers at last: the job stays as the deadline left it.
    site.answer();
    await new Promise((r) => setTimeout(r, 150));
    assert.deepEqual(await app.db.one<any>('SELECT status, last_error FROM jobs WHERE id = $1', [id]), { status: 'failed', last_error: row.last_error });
    // A store whose first reading got stuck so reads on Today and /start as a reading that failed, no longer "קוראים את האתר".
    await app.db.query('UPDATE stores SET workspace_id = 61, ingested_at = NULL WHERE id = $1', [storeId]);
    assert.equal(storeState(await setupStoreOf(app, 61)).status, 'attention');
  } finally {
    await app.db.close();
  }
});

test("a customer's message whose answer never comes goes to the owner at its deadline, said as not answered in time", { timeout: 60_000 }, async () => {
  const app = await testApp();
  try {
    const { storeId } = await seedDemo(app, { conversation: false });
    const acc = (await turnOn(app, storeId, 'test'))!;
    await setLive(app, storeId, true, 'test');
    // The model never answers, whatever the turn's own clock says.
    app.llm = { backend: app.llm.backend, turn: () => new Promise(() => {}) };
    const visitor = 'Vstuckvisitor000000001';
    const id = await enqueue(app.db, 'web_inbound', { channel: 'web', from: visitor, text: 'יש לכם משלוח לאילת?', id: `web:${acc.external_id}:${visitor}:1`, account: acc.external_id, at: Date.now() });
    const job = (await claim(app.db, MESSAGE_KINDS))!;
    assert.equal(job.id, id);
    await runOne(app, job, { deadline: 300 });
    assert.equal(await status(app, id), 'failed');
    const conv = (await app.db.one<{ id: number }>("SELECT id FROM conversations WHERE channel = 'web' AND peer = $1", [visitor]))!.id;
    const msgs = await app.db.query<any>('SELECT role, text, handoff FROM messages WHERE conversation_id = $1 ORDER BY id', [conv]);
    assert.ok(msgs.some((m) => m.role === 'customer' && m.text === 'יש לכם משלוח לאילת?'), "the customer's message is in the conversation");
    const note = msgs.find((m) => m.role === 'system' && m.handoff?.reason === 'failed');
    assert.ok(note, 'a handoff for the owner');
    assert.equal(note.text, 'תורן לא הצליח לענות להודעה הזו בזמן, אז היא מחכה לכם.');
    assert.ok(await app.db.one("SELECT 1 FROM events WHERE kind = 'operator_alert' AND data->>'key' = $1", [`lost:${id}`]), 'the operator hears of it once, as a lost message');
    assert.ok(!(await app.db.one("SELECT 1 FROM events WHERE kind = 'operator_alert' AND data->>'key' = 'deadline:web_inbound'")), 'not twice');
  } finally {
    await app.db.close();
  }
});

test('a reading that holds the background loop holds back neither the email about a waiting customer nor the schedule', { timeout: 90_000 }, async () => {
  const app = await testApp();
  const site = silentSite();
  let w: ReturnType<typeof startWorker> | null = null;
  try {
    const { storeId } = await seedDemo(app, { conversation: false });
    app.fetcher = site.fetcher;
    const ingest = await enqueue(app.db, 'ingest', { storeId }, { dedupeKey: `ingest:${storeId}` });
    w = startWorker(app, { messageLoops: 1, quickLoops: 1, backgroundLoops: 1, idleMs: 20, scheduleEveryMs: 150, boot: 'test-worker', deadline: () => 600_000 });
    await until(async () => (await status(app, ingest)) === 'running', 'the reading started');
    const digest = await enqueue(app.db, 'owner_waiting', { storeId });
    await until(async () => (await status(app, digest)) === 'done', 'the owners\' email ran while the reading held the background loop');
    // An expired demo binding is cleaned up by the schedule: a pass that runs after the reading took its loop.
    await app.db.query("INSERT INTO wa_users (phone, store_id, code, bound_at, expires_at, last_inbound_at) VALUES ('972500000612', $1, 'DEMO-TEST', now() - interval '9 days', now() - interval '2 days', now())", [storeId]);
    await until(async () => !(await app.db.one("SELECT 1 FROM wa_users WHERE phone = '972500000612'")), 'the schedule ran while the reading held its loop');
    assert.equal(await status(app, ingest), 'running', 'the reading still holds the background loop');
  } finally {
    site.answer();
    await w?.stop({ graceMs: 2000 });
    await app.db.close();
  }
});

test('one step of the schedule that throws does not stop the steps after it', { timeout: 60_000 }, async () => {
  const app = await testApp();
  try {
    const { storeId } = await seedDemo(app, { conversation: false });
    await app.db.query("INSERT INTO wa_users (phone, store_id, code, bound_at, expires_at, last_inbound_at) VALUES ('972500000613', $1, 'DEMO-TEST', now() - interval '9 days', now() - interval '2 days', now())", [storeId]);
    // The daily re-scrapes' question to the database fails (a step before the clean-up of expired bindings).
    const query = app.db.query.bind(app.db);
    app.db.query = (async (sql: string, params?: unknown[]) => {
      if (/page_built_at IS NOT NULL AND status <> 'skipped'/.test(String(sql))) throw new Error('refused');
      return query(sql, params as any);
    }) as typeof app.db.query;
    await schedule(app);
    assert.ok(!(await app.db.one("SELECT 1 FROM wa_users WHERE phone = '972500000613'")), 'the next steps ran: the expired binding is gone');
  } finally {
    await app.db.close();
  }
});
