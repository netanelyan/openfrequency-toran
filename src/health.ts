import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { App } from './app.ts';
import { ROOT } from './core/paths.ts';

// Is Toran working, not just running?
//
//   /healthz   liveness: the process answers. "ok" and the build's commit (REVISION, written by deploy/deploy.sh into
//              each release), nothing else asked: cheap enough for anything to call
//   /readyz    readiness, what the deploy waits on after a restart and the uptime monitor watches: 200 when
//                db       the database answers SELECT 1
//                worker   a worker loop of this same build took a turn in the last WORKER_STALE_MS (worker_beats, written
//                         by every loop at most every BEAT_MS, in the web's process or beside it). The build matters
//                         right after a deploy: the old process's last sign of life is still fresh, and says nothing
//                         about whether the new one's worker started
//                queue    no customer's message has waited for a loop more than QUEUE_STALE_MS since it was due
//              and 503 with the same JSON when any of them fails. No count, id or error text: the page is public.

/** A worker loop writes its sign of life at most this often. */
export const BEAT_MS = 30_000;
/** No sign of life from any loop for this long, and the worker is down. */
export const WORKER_STALE_MS = 2 * 60_000;
/** A customer's message due this long and still not taken is a worker that cannot keep up. */
export const QUEUE_STALE_MS = 5 * 60_000;
/** The jobs that are a customer waiting for an answer. */
export const CUSTOMER_KINDS = ['wa_inbound', 'mail_inbound', 'dm_inbound', 'wa_echo'];

let rev: string | null | undefined;

/** The build's commit: TORAN_REVISION, else the REVISION file a deploy writes at the release's root, else null. */
export function revision(env: Record<string, string | undefined> = process.env): string | null {
  const set = String(env.TORAN_REVISION || '').trim();
  if (set) return set.slice(0, 40);
  if (rev === undefined) {
    const file = path.join(ROOT, 'REVISION');
    rev = existsSync(file) ? readFileSync(file, 'utf8').trim().slice(0, 40) || null : null;
  }
  return rev;
}

const lastBeat = new WeakMap<object, number>();

/** A worker loop's sign of life, written at most every BEAT_MS for each database. Never throws. */
export async function workerBeat(app: App, { force = false } = {}): Promise<void> {
  const now = Date.now();
  if (!force && now - (lastBeat.get(app.db) || 0) < BEAT_MS) return;
  lastBeat.set(app.db, now);
  try {
    await app.db.query(
      "INSERT INTO worker_beats (name, at, pid, revision) VALUES ('worker', now(), $1, $2) ON CONFLICT (name) DO UPDATE SET at = now(), pid = EXCLUDED.pid, revision = EXCLUDED.revision",
      [process.pid, revision(app.env)],
    );
  } catch (e: any) {
    lastBeat.delete(app.db);
    app.log(`[health] the worker's sign of life was not written: ${e?.message || e}`);
  }
}

export type Readiness = { ok: boolean; db: boolean; worker: boolean; queue: boolean; revision: string | null };

/** The three checks of /readyz. Each one that cannot be read counts as failed. */
export async function readiness(app: App): Promise<Readiness> {
  const out: Readiness = { ok: false, db: false, worker: false, queue: false, revision: revision(app.env) };
  try {
    out.db = Boolean(await app.db.one('SELECT 1 AS one'));
  } catch {
    return out;
  }
  try {
    const b = await app.db.one<{ age: number | null; revision: string | null }>("SELECT EXTRACT(EPOCH FROM now() - at) * 1000 AS age, revision FROM worker_beats WHERE name = 'worker'");
    out.worker = b?.age != null && Number(b.age) < WORKER_STALE_MS && (!out.revision || b.revision === out.revision);
  } catch {
    out.worker = false;
  }
  try {
    const q = await app.db.one<{ age: number | null }>(
      "SELECT EXTRACT(EPOCH FROM now() - min(run_at)) * 1000 AS age FROM jobs WHERE status = 'queued' AND run_at <= now() AND kind = ANY($1::text[])",
      [CUSTOMER_KINDS],
    );
    out.queue = q?.age == null || Number(q.age) < QUEUE_STALE_MS;
  } catch {
    out.queue = false;
  }
  out.ok = out.db && out.worker && out.queue;
  return out;
}
