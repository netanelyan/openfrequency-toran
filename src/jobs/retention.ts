import { readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { App } from '../app.ts';
import { israelDate } from '../core/clock.ts';
import { filesDir } from '../core/paths.ts';
import { type Db, J } from '../db/index.ts';
import { event } from '../db/log.ts';
import { closeSilent } from '../channels/conversations.ts';

// How long Toran keeps what it keeps, and the daily pass that holds it to that (the worker's schedule, once an Israel
// day). The periods the website publishes (openfrequency-web: legal.leadMonths, price.keepDays) are the first two:
//
//   a store's customers' conversations   while the store uses Toran, and SERVICE_KEEP_DAYS (30) after its service
//                 stopped: then its conversations, their messages and files, its customers' contact details, its
//                 automatic messages' log and its events are deleted. The opt-outs (auto_consent) stay: they keep each
//                 customer's "stop" in force if the store comes back. A service stops when the store has had a channel
//                 and none is on any more (marked here), when its page was taken down, or when its workspace's Toran
//                 ends (markServiceStopped, from the paywall). It goes on again when a channel or the plan does
//   leads         LEAD_MONTHS (6) after the last contact: the demo requests from the website, Teder's demos as Toran
//                 keeps them (teder_leads, unless won), and the chats on the demo number with a store that is not a
//                 customer's (the phone of the person who tried it)
//   jobs          a finished job's payload (a customer's message, their number) is emptied after 7 days, and finished
//                 and failed jobs are deleted after 30
//   automatic messages' log (auto_events)  AUTO_EVENTS_DAYS (90) after it was written, once finished
//   events        EVENTS_MONTHS (13) months: the funnel and the dashboards read the last year
//   owner line    its duplicate guard (owner_inbound) after 30 days
//   conversations silent for 14 days are closed, and what an order lookup said about tracking is taken out of them
//                 (channels/conversations.ts)
//
// Each run writes one event (retention) with what it deleted, and a log line, so the operator can show the policy holds.

export const SERVICE_KEEP_DAYS = 30;
export const LEAD_MONTHS = 6;
export const AUTO_EVENTS_DAYS = 90;
export const EVENTS_MONTHS = 13;
const KEY = 'retention';

const n = async (db: Db, sql: string, params: unknown[] = []) => (await db.query(sql, params)).length;

/** The paywall stopped this store's service (its workspace's Toran ended): its conversations go 30 days from now. */
export async function markServiceStopped(db: Db, storeId: number, why: 'plan' | 'channels' | 'taken_down' = 'plan') {
  await db.query('UPDATE stores SET service_stopped_at = COALESCE(service_stopped_at, now()), service_stopped_why = COALESCE(service_stopped_why, $2) WHERE id = $1', [storeId, why]);
}

/** The service is on again: nothing of it is due for deletion. */
export async function markServiceResumed(db: Db, storeId: number, why: 'plan' | 'channels' | 'taken_down' = 'plan') {
  await db.query('UPDATE stores SET service_stopped_at = NULL, service_stopped_why = NULL WHERE id = $1 AND service_stopped_why = $2', [storeId, why]);
}

/** Bytes in the files folder that no row names any more. */
export async function sweepFiles(app: App): Promise<number> {
  const root = filesDir(app.env);
  let shas: string[] = [];
  try {
    for (const d of readdirSync(root)) if (/^[0-9a-f]{2}$/.test(d)) shas.push(...readdirSync(path.join(root, d)).filter((f) => /^[0-9a-f]{64}$/.test(f)));
  } catch {
    return 0;
  }
  let gone = 0;
  while (shas.length) {
    const batch = shas.slice(0, 500);
    shas = shas.slice(500);
    const kept = new Set((await app.db.query<{ sha256: string }>('SELECT DISTINCT sha256 FROM files WHERE sha256 = ANY($1::text[])', [batch])).map((r) => r.sha256));
    for (const sha of batch) {
      if (kept.has(sha)) continue;
      rmSync(path.join(root, sha.slice(0, 2), sha), { force: true });
      gone++;
    }
  }
  return gone;
}

/** What a stopped store keeps no longer: everything of its customers but their opt-outs. */
async function forgetStore(db: Db, storeId: number) {
  return {
    conversations: await n(db, 'DELETE FROM conversations WHERE store_id = $1 RETURNING id', [storeId]),
    customers: await n(db, 'DELETE FROM customers WHERE store_id = $1 RETURNING id', [storeId]),
    autoEvents: await n(db, 'DELETE FROM auto_events WHERE store_id = $1 RETURNING id', [storeId]),
    events: await n(db, 'DELETE FROM events WHERE store_id = $1 RETURNING id', [storeId]),
    jobs: await n(db, "DELETE FROM jobs WHERE status IN ('done', 'failed') AND payload->>'storeId' = $1 RETURNING id", [String(storeId)]),
  };
}

/** One pass of every rule above. Returns what it did; `force` runs it even if it ran today. */
export async function retention(app: App): Promise<Record<string, number>> {
  const { db } = app;
  const out: Record<string, number> = {};
  const add = (k: string, v: number) => (out[k] = (out[k] || 0) + v);

  // Services that stopped, and ones on again.
  add('stopped', await n(db, `UPDATE stores s SET service_stopped_at = now(), service_stopped_why = 'channels' WHERE s.service_stopped_at IS NULL
      AND EXISTS (SELECT 1 FROM channel_accounts a WHERE a.store_id = s.id)
      AND NOT EXISTS (SELECT 1 FROM channel_accounts a WHERE a.store_id = s.id AND a.status IN ('active', 'pending', 'reconnect', 'line')) RETURNING id`));
  add('stopped', await n(db, "UPDATE stores SET service_stopped_at = COALESCE(taken_down_at, now()), service_stopped_why = 'taken_down' WHERE service_stopped_at IS NULL AND taken_down_at IS NOT NULL RETURNING id"));
  add('resumed', await n(db, `UPDATE stores s SET service_stopped_at = NULL, service_stopped_why = NULL WHERE s.service_stopped_why = 'channels'
      AND EXISTS (SELECT 1 FROM channel_accounts a WHERE a.store_id = s.id AND a.status IN ('active', 'pending', 'reconnect', 'line')) RETURNING id`));
  const due = await db.query<{ id: number }>(`SELECT id FROM stores WHERE service_stopped_at < now() - interval '${SERVICE_KEEP_DAYS} days'`);
  for (const s of due) {
    const r = await db.tx((t) => forgetStore(t, s.id));
    for (const [k, v] of Object.entries(r)) add(k, v);
    if (Object.values(r).some(Boolean)) await event(db, s.id, 'service_data_deleted', r);
  }

  // Leads, six months after the last contact.
  const lead = `interval '${LEAD_MONTHS} months'`;
  add('demoRequests', await n(db, `DELETE FROM demo_requests WHERE COALESCE(claimed_at, created_at) < now() - ${lead} RETURNING id`));
  add('tederLeads', await n(db, `DELETE FROM teder_leads WHERE won_at IS NULL AND GREATEST(created_at, sent_at, reminded_at, replied_at, last_open_at, lost_at, approved_at, ready_at) < now() - ${lead} RETURNING id`));
  add('demoChats', await n(db, `DELETE FROM conversations c USING stores s WHERE s.id = c.store_id AND c.account_id IS NULL AND c.peer IS NOT NULL AND c.channel = 'whatsapp'
      AND s.workspace_id IS NULL AND c.last_at < now() - ${lead} RETURNING c.id`));

  // The queue, the automatic messages' log, the events, the owner line's guard.
  add('jobPayloads', await n(db, "UPDATE jobs SET payload = '{}'::jsonb, result = NULL WHERE status = 'done' AND done_at < now() - interval '7 days' AND payload <> '{}'::jsonb RETURNING id"));
  add('jobs', await n(db, "DELETE FROM jobs WHERE status IN ('done', 'failed') AND COALESCE(done_at, created_at) < now() - interval '30 days' RETURNING id"));
  add('autoEvents', await n(db, `DELETE FROM auto_events WHERE status NOT IN ('waiting', 'sending') AND created_at < now() - interval '${AUTO_EVENTS_DAYS} days' RETURNING id`));
  add('events', await n(db, `DELETE FROM events WHERE at < now() - interval '${EVENTS_MONTHS} months' RETURNING id`));
  add('ownerInbound', await n(db, "DELETE FROM owner_inbound WHERE at < now() - interval '30 days' RETURNING ext_id"));

  add('closed', await closeSilent(db, 14));
  add('files', await sweepFiles(app));
  return out;
}

/** The worker's daily call: once an Israel day, then nothing until the next. */
export async function dailyRetention(app: App, { force = false }: { force?: boolean } = {}): Promise<Record<string, number> | null> {
  const today = israelDate();
  const last = await app.db.one<{ value: any }>('SELECT value FROM settings WHERE key = $1', [KEY]);
  if (!force && last?.value?.day === today) return null;
  await app.db.query('INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [KEY, J({ day: today, at: new Date().toISOString() })]);
  const r = await retention(app);
  const said = Object.entries(r).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(', ');
  app.log(`[retention] ${said || 'nothing to delete'}`);
  await event(app.db, null, 'retention', r);
  return r;
}
