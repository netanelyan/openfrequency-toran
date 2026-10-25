import type { App } from '../app.ts';
import { now } from '../core/clock.ts';
import { enqueue } from '../jobs/queue.ts';
import { poll, readHook, setupSource, sourceOf } from './platforms.ts';
import { anyOn, record, sendDue, settingsOf } from './send.ts';

// The automatic messages' work in the worker (jobs/worker.ts):
//
//   auto_setup   a store's source set up: its webhooks registered where the key allows (platforms.ts setupSource)
//   auto_hook    one webhook from a store's platform, its signature checked on arrival (web/public.ts)
//   auto_poll    a store's orders and checkouts read since the last reading
//   auto_send    every message whose time has come (send.ts sendDue)
//   wa_templates a store's WhatsApp templates read again at Meta while one is pending (templates.ts)
//
// scheduleAuto() runs each minute with the rest of the schedule.

export async function pollStore(app: App, storeId: number) {
  const st = await settingsOf(app, storeId);
  if (!anyOn(st)) return { skipped: 'off' };
  let src = await sourceOf(app, storeId);
  if (!src && (await setupSource(app, storeId))) src = await sourceOf(app, storeId);
  if (!src) return { skipped: 'no_access' };
  const marketing = st.cart.whatsapp || st.cart.email || st.review.whatsapp || st.review.email;
  const { reads, upto } = await poll(app, storeId, { checkouts: st.cart.whatsapp || st.cart.email, consent: marketing });
  let added = 0;
  for (const r of reads) added += await record(app, storeId, src.platform, r, 'poll');
  // The next reading starts where this one ended; the platforms' "since" is inclusive, and a row is never kept twice.
  await app.db.query('UPDATE auto_sources SET polled_at = $2, read_from = CASE WHEN $3::timestamptz IS NULL OR $3::timestamptz < read_from THEN read_from ELSE $3::timestamptz END WHERE store_id = $1', [storeId, new Date(now()).toISOString(), upto]);
  return { read: reads.length, added };
}

export async function handleHook(app: App, p: { storeId: number; platform: string; topic: string; body: any }) {
  let added = 0;
  for (const r of await readHook(app, Number(p.storeId), p.platform, p.topic, p.body)) added += await record(app, Number(p.storeId), p.platform, r, 'webhook');
  return { added };
}

export async function scheduleAuto(app: App) {
  // A store with a kind on and no source yet (the setup failed, or the key was connected again): set it up.
  const bare = await app.db.query<{ store_id: number }>("SELECT DISTINCT a.store_id FROM auto_settings a JOIN order_access o ON o.store_id = a.store_id AND o.status = 'active' WHERE (a.whatsapp OR a.email) AND NOT EXISTS (SELECT 1 FROM auto_sources s WHERE s.store_id = a.store_id)");
  for (const s of bare) await enqueue(app.db, 'auto_setup', { storeId: s.store_id }, { dedupeKey: `auto_setup:${s.store_id}`, maxAttempts: 2 });
  // Every 15 minutes without working webhooks; every hour beside them, for anything a webhook missed.
  const due = await app.db.query<{ store_id: number }>(
    `SELECT s.store_id FROM auto_sources s JOIN order_access o ON o.store_id = s.store_id AND o.status = 'active'
      WHERE EXISTS (SELECT 1 FROM auto_settings a WHERE a.store_id = s.store_id AND (a.whatsapp OR a.email))
        AND (s.polled_at IS NULL OR s.polled_at < $1::timestamptz - CASE WHEN (s.can->>'webhooks') = 'true' THEN interval '1 hour' ELSE interval '15 minutes' END)`,
    [new Date(now()).toISOString()],
  );
  for (const s of due) await enqueue(app.db, 'auto_poll', { storeId: s.store_id }, { dedupeKey: `auto_poll:${s.store_id}`, maxAttempts: 1 });
  if (await app.db.one("SELECT 1 FROM auto_events WHERE status = 'waiting' AND due_at <= $1 LIMIT 1", [new Date(now()).toISOString()])) await enqueue(app.db, 'auto_send', {}, { dedupeKey: 'auto_send', maxAttempts: 1 });
  const pending = await app.db.query<{ account_id: number }>("SELECT DISTINCT account_id FROM wa_templates WHERE status IN ('PENDING', 'IN_APPEAL') AND COALESCE(checked_at, submitted_at) < now() - interval '1 hour'");
  for (const t of pending) await enqueue(app.db, 'wa_templates', { accountId: t.account_id }, { dedupeKey: `wa_templates:${t.account_id}`, maxAttempts: 1 });
}

export { sendDue, setupSource };
