import { randomUUID } from 'node:crypto';
import { type Db, J } from '../db/index.ts';

// A job queue in Postgres, for phase 1's few hundred jobs a day. No Redis.
//
//   enqueue    a job, with an optional dedupe key (one live job per key: two clicks on
//              "add" for the same store are one ingest)
//   claim      the next due job, taken with FOR UPDATE SKIP LOCKED so two workers never
//              take the same one, and marked with this process's boot id. A customer's
//              message is never taken while another message of the same customer to the
//              same account is running: the two are answered in order, and no loop sits
//              waiting on the other's conversation
//   done/fail  a failed job is retried with backoff (1, 4, 9 minutes...) up to its
//              max_attempts, then kept as failed with its error for the dashboard
//   release    a job put back as it was, its attempt not counted (a shutdown, a busy conversation)
//   progress   a line the dashboard shows while the job runs ("reading the products: 250")
//
// A running job's locked_at is refreshed every minute (beat), so a job whose process died
// is known by a lease of LEASE_MINUTES, not 15 minutes: it goes back to the queue on the
// next claim. At start the worker puts back every running job another boot left
// (requeueOrphans), at once.

export type Job = { id: number; kind: string; payload: any; attempts: number; max_attempts: number; dedupe_key: string | null };

/** This process's boot: the jobs it claims carry it. */
export const BOOT: string = randomUUID();

/** How long a running job may go without a heartbeat before it is taken to be dead. */
export const LEASE_MINUTES = 3;

/** A customer's message, from any channel, and the owner's own messages to customers: what a customer waits on. */
export const MESSAGE_KINDS = ['wa_inbound', 'mail_inbound', 'dm_inbound', 'wa_echo', 'dm_echo'];

export async function enqueue(db: Db, kind: string, payload: unknown, { dedupeKey = null, runAt = null, maxAttempts = 3 }: { dedupeKey?: string | null; runAt?: Date | null; maxAttempts?: number } = {}): Promise<number> {
  if (dedupeKey) {
    const live = await db.one<{ id: number }>("SELECT id FROM jobs WHERE dedupe_key = $1 AND status IN ('queued', 'running')", [dedupeKey]);
    if (live) return Number(live.id);
  }
  const r = await db.one<{ id: number }>(
    `INSERT INTO jobs (kind, payload, dedupe_key, run_at, max_attempts) VALUES ($1, $2::jsonb, $3, COALESCE($4, now()), $5)
     ON CONFLICT (dedupe_key) WHERE status IN ('queued', 'running') DO UPDATE SET dedupe_key = EXCLUDED.dedupe_key RETURNING id`,
    [kind, J(payload), dedupeKey, runAt ? runAt.toISOString() : null, maxAttempts],
  );
  return Number(r!.id);
}

/**
 * The next due job: of these kinds (`kinds`), or of any kind but these (`except`), or any. A message job whose customer
 * (the same sender to the same account, on the same kind) has another message running waits for it.
 */
export async function claim(db: Db, kinds: string[] | null = null, { except = null, boot = BOOT }: { except?: string[] | null; boot?: string } = {}): Promise<Job | null> {
  await db.query(`UPDATE jobs SET status = 'queued', locked_at = NULL, locked_by = NULL WHERE status = 'running' AND locked_at < now() - interval '${LEASE_MINUTES} minutes'`);
  const params: unknown[] = [boot, MESSAGE_KINDS];
  const where: string[] = [];
  if (kinds) {
    params.push(kinds);
    where.push(`AND j.kind = ANY($${params.length}::text[])`);
  }
  if (except) {
    params.push(except);
    where.push(`AND NOT (j.kind = ANY($${params.length}::text[]))`);
  }
  const r = await db.one<Job>(
    `UPDATE jobs SET status = 'running', locked_at = now(), locked_by = $1, attempts = attempts + 1
     WHERE id = (SELECT j.id FROM jobs j WHERE j.status = 'queued' AND j.run_at <= now() ${where.join(' ')}
                   AND NOT (j.kind = ANY($2::text[]) AND EXISTS (
                     SELECT 1 FROM jobs o WHERE o.status = 'running' AND o.kind = j.kind AND o.id <> j.id
                        AND o.payload->>'from' = j.payload->>'from' AND COALESCE(o.payload->>'account', '') = COALESCE(j.payload->>'account', '')))
                 ORDER BY j.run_at, j.id FOR UPDATE SKIP LOCKED LIMIT 1)
     RETURNING id, kind, payload, attempts, max_attempts, dedupe_key`,
    params,
  );
  return r ? { ...r, id: Number(r.id) } : null;
}

export async function done(db: Db, id: number, result: unknown = null) {
  await db.query("UPDATE jobs SET status = 'done', done_at = now(), result = $2::jsonb, progress = NULL, locked_by = NULL WHERE id = $1", [id, J(result)]);
}

/** A failed attempt: queued again with backoff while attempts remain. True when this was the last one. */
export async function fail(db: Db, job: Job, error: string): Promise<boolean> {
  const retry = job.attempts < job.max_attempts;
  await db.query(
    `UPDATE jobs SET status = $2, last_error = $3, locked_at = NULL, locked_by = NULL, run_at = now() + ($4 || ' minutes')::interval, done_at = CASE WHEN $2 = 'failed' THEN now() ELSE NULL END WHERE id = $1`,
    [job.id, retry ? 'queued' : 'failed', error.slice(0, 1000), String(job.attempts * job.attempts)],
  );
  return !retry;
}

/** Back to the queue as it was, the attempt not counted, due again in `seconds`. */
export async function release(db: Db, id: number, seconds = 0) {
  await db.query(`UPDATE jobs SET status = 'queued', locked_at = NULL, locked_by = NULL, attempts = GREATEST(attempts - 1, 0), run_at = now() + interval '${Math.max(0, Math.floor(seconds))} seconds' WHERE id = $1 AND status = 'running'`, [id]);
}

/** The running job is alive: its lease starts again. */
export async function beat(db: Db, id: number, boot = BOOT) {
  await db.query('UPDATE jobs SET locked_at = now() WHERE id = $1 AND status = $2 AND locked_by = $3', [id, 'running', boot]);
}

/** At start: every job left running by another boot goes back to the queue now, its attempt not counted. */
export async function requeueOrphans(db: Db, boot = BOOT): Promise<number> {
  const r = await db.query("UPDATE jobs SET status = 'queued', locked_at = NULL, locked_by = NULL, attempts = GREATEST(attempts - 1, 0), run_at = now() WHERE status = 'running' AND locked_by IS DISTINCT FROM $1 RETURNING id", [boot]);
  return r.length;
}

/** Run a failed job again, from the operator's button: once more, now. */
export async function retryJob(db: Db, id: number): Promise<boolean> {
  return Boolean(await db.one("UPDATE jobs SET status = 'queued', run_at = now(), max_attempts = attempts + 1, done_at = NULL, locked_at = NULL, locked_by = NULL WHERE id = $1 AND status = 'failed' RETURNING id", [id]));
}

export async function progress(db: Db, id: number, line: string) {
  await db.query('UPDATE jobs SET progress = $2 WHERE id = $1', [id, line.slice(0, 200)]);
}

/** What the operator's queue page shows: how many wait, the oldest customer message waiting, and the failed ones. */
export async function queueState(db: Db) {
  const depth = await db.one<{ queued: number; running: number; messages: number; oldest: string | null }>(
    "SELECT COUNT(*) FILTER (WHERE status = 'queued')::int AS queued, COUNT(*) FILTER (WHERE status = 'running')::int AS running, COUNT(*) FILTER (WHERE status = 'queued' AND kind = ANY($1::text[]))::int AS messages, MIN(run_at) FILTER (WHERE status = 'queued' AND kind = ANY($1::text[]) AND run_at <= now()) AS oldest FROM jobs WHERE status IN ('queued', 'running')",
    [MESSAGE_KINDS],
  );
  const failed = await db.query<{ id: number; kind: string; payload: any; attempts: number; last_error: string | null; done_at: string; created_at: string }>("SELECT id, kind, payload, attempts, last_error, done_at, created_at FROM jobs WHERE status = 'failed' AND done_at > now() - interval '14 days' ORDER BY done_at DESC LIMIT 100");
  return { queued: depth?.queued || 0, running: depth?.running || 0, messages: depth?.messages || 0, oldestAt: depth?.oldest || null, failed: failed.map((f) => ({ ...f, id: Number(f.id) })) };
}
