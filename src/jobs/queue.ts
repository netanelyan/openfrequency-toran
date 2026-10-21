import { type Db, J } from '../db/index.ts';

// A job queue in Postgres, for phase 1's few hundred jobs a day. No Redis.
//
//   enqueue    a job, with an optional dedupe key (one live job per key: two clicks on
//              "add" for the same store are one ingest)
//   claim      the next due job, taken with FOR UPDATE SKIP LOCKED so two workers never
//              take the same one
//   done/fail  a failed job is retried with backoff (1, 4, 9 minutes...) up to its
//              max_attempts, then kept as failed with its error for the dashboard
//   progress   a line the dashboard shows while the job runs ("reading the products: 250")
//
// Jobs that were running when the process died (locked over 15 minutes ago) go back
// to the queue on the next claim.

export type Job = { id: number; kind: string; payload: any; attempts: number; max_attempts: number; dedupe_key: string | null };

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

export async function claim(db: Db, kinds: string[] | null = null): Promise<Job | null> {
  await db.query("UPDATE jobs SET status = 'queued', locked_at = NULL WHERE status = 'running' AND locked_at < now() - interval '15 minutes'");
  const r = await db.one<Job>(
    `UPDATE jobs SET status = 'running', locked_at = now(), attempts = attempts + 1
     WHERE id = (SELECT id FROM jobs WHERE status = 'queued' AND run_at <= now() ${kinds ? 'AND kind = ANY($1::text[])' : ''} ORDER BY run_at, id FOR UPDATE SKIP LOCKED LIMIT 1)
     RETURNING id, kind, payload, attempts, max_attempts, dedupe_key`,
    kinds ? [kinds] : [],
  );
  return r ? { ...r, id: Number(r.id) } : null;
}

export async function done(db: Db, id: number, result: unknown = null) {
  await db.query("UPDATE jobs SET status = 'done', done_at = now(), result = $2::jsonb, progress = NULL WHERE id = $1", [id, J(result)]);
}

export async function fail(db: Db, job: Job, error: string) {
  const retry = job.attempts < job.max_attempts;
  await db.query(
    `UPDATE jobs SET status = $2, last_error = $3, locked_at = NULL, run_at = now() + ($4 || ' minutes')::interval, done_at = CASE WHEN $2 = 'failed' THEN now() ELSE NULL END WHERE id = $1`,
    [job.id, retry ? 'queued' : 'failed', error.slice(0, 1000), String(job.attempts * job.attempts)],
  );
}

export async function progress(db: Db, id: number, line: string) {
  await db.query('UPDATE jobs SET progress = $2 WHERE id = $1', [id, line.slice(0, 200)]);
}
