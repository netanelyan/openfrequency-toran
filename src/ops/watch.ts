import type { App } from '../app.ts';
import { israelDate } from '../core/clock.ts';
import { J } from '../db/index.ts';
import { displayName } from '../ingest/brand.ts';
import { counted, monthOf, planOf, usageOf } from '../plans.ts';
import { alertOperator } from './alert.ts';

// What the operator hears about customers' stores once a day (TORAN-READINESS.md P1-25), the counterparts of Teder's
// "nothing drafted": a store over its plan this month (the move to the big plan is the operator's, plans.ts), and a
// store whose site was read three days ago and that has no channel connected yet (a customer stuck at setup).
// The disconnections themselves (Kapso, Zernio) and Kapso's credits are said where they happen (channels/kapso.ts,
// channels/zernio.ts, jobs/worker.ts).

const KEY = 'watch';
export const STUCK_DAYS = 3;

/** Once an Israel day: each customer store over its plan, or stuck with nothing connected. */
export async function watchStores(app: App, { force = false }: { force?: boolean } = {}): Promise<{ over: number[]; stuck: number[] } | null> {
  const day = israelDate(Date.now());
  const last = await app.db.one<{ value: any }>('SELECT value FROM settings WHERE key = $1', [KEY]);
  if (!force && last?.value?.day === day) return null;
  await app.db.query('INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [KEY, J({ day })]);
  const stores = await app.db.query<any>(`SELECT s.id, s.name, s.domain, s.brand, s.brand_override, s.config, s.ingested_at,
      EXISTS (SELECT 1 FROM channel_accounts a WHERE a.store_id = s.id AND a.status IN ('active', 'pending', 'reconnect')) AS connected
    FROM stores s WHERE s.workspace_id IS NOT NULL AND s.service_stopped_at IS NULL AND s.taken_down_at IS NULL AND s.platform <> 'company'`);
  const over: number[] = [];
  const stuck: number[] = [];
  const counts = await counted(app.db, stores.map((s) => s.id), { months: 1 });
  const month = monthOf();
  for (const s of stores) {
    const name = displayName(s.brand_override?.name, s.brand?.name, s.name) || s.domain;
    const u = usageOf(planOf(s.config), counts.get(s.id));
    if (u.thisMonth > u.cap) {
      over.push(s.id);
      await alertOperator(app, `over_plan:${s.id}:${month}`, `תורן: ${name} מעל החבילה החודש`, `${u.thisMonth} שיחות מתוך ${u.cap}. ${u.note || ''} ההעברה לחבילה הגדולה היא שלך, בדף של החנות.`.trim(), { storeId: s.id, everyMinutes: 31 * 24 * 60 });
    }
    if (!s.connected && s.ingested_at && Date.now() - new Date(s.ingested_at).getTime() > STUCK_DAYS * 86_400_000) {
      stuck.push(s.id);
      await alertOperator(app, `stuck:${s.id}`, `תורן: ${name} עוד לא חיברה ערוץ`, `האתר נקרא לפני יותר מ-${STUCK_DAYS} ימים, ואין לה אף ערוץ מחובר. כדאי לכתוב לבעלים ולעזור לחבר.`, { storeId: s.id, everyMinutes: 7 * 24 * 60 });
    }
  }
  return { over, stuck };
}
