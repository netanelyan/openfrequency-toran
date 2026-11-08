import type { App } from '../app.ts';
import { israelWeekdayHour, now } from '../core/clock.ts';
import { event } from '../db/log.ts';
import { displayName } from '../ingest/brand.ts';
import { cartLine, cartReport, monthHe } from '../auto/report.ts';
import { messagingSql } from '../channels/config.ts';
import { counted, PLANS, planOf, prevMonth, monthOf } from '../plans.ts';
import { STATE_SQL } from '../web/inbox.ts';
import { notifyOwners } from './notify-client.ts';

// The month's results by email, on the 1st from 09:00 Israel time, to each customer store's owners (TORAN-READINESS.md
// P1-10, as Teder's "דוח תוצאות בכל חודש"): how many conversations there were, how many Toran answered alone, how many
// the owner fixed and how many still wait, the abandoned carts and what came back, and the month against the plan.
// Through accounts (kind monthly), once a store a month; a store with no conversation and no cart that month gets none.

export type MonthReport = { month: string; conversations: number; alone: number; fixed: number; waiting: number; cart: string | null; cap: number };

/** One store's past month, in numbers. */
export async function monthReport(app: App, storeId: number, config: any, month: string): Promise<MonthReport> {
  const start = `('${month}-01'::date::timestamp AT TIME ZONE 'Asia/Jerusalem')`;
  const end = `(('${month}-01'::date + interval '1 month')::timestamp AT TIME ZONE 'Asia/Jerusalem')`;
  const s = await app.db.one<{ alone: number; fixed: number; waiting: number }>(
    `SELECT COUNT(*) FILTER (WHERE state = 'alone')::int AS alone, COUNT(*) FILTER (WHERE state = 'fixed')::int AS fixed, COUNT(*) FILTER (WHERE state = 'waiting')::int AS waiting
       FROM (SELECT ${STATE_SQL} AS state FROM conversations c WHERE ${messagingSql('c.channel')} AND c.store_id = $1 AND c.account_id IS NOT NULL AND c.last_at >= ${start} AND c.last_at < ${end}) x`,
    [storeId],
  );
  const conv = (await counted(app.db, [storeId], { months: 2 })).get(storeId)?.get(month) || 0;
  const cart = (await cartReport(app.db, [storeId], 2)).find((m) => m.month === month);
  return { month, conversations: conv, alone: s?.alone || 0, fixed: s?.fixed || 0, waiting: s?.waiting || 0, cart: cart && cart.reminded ? cartLine(cart) : null, cap: PLANS[planOf(config)].conversations };
}

/** The email's words. */
export function reportMail(storeName: string, r: MonthReport, base: string): { subject: string; text: string; link: string } {
  const m = monthHe(r.month);
  const lines = [
    `${r.conversations === 1 ? 'שיחה אחת' : `${r.conversations.toLocaleString('he-IL')} שיחות`} עם לקוחות של ${storeName} ב${m}.`,
    `תורן ענה לבד ב-${r.alone.toLocaleString('he-IL')}, עניתם בעצמכם ב-${r.fixed.toLocaleString('he-IL')}${r.waiting ? `, ו-${r.waiting.toLocaleString('he-IL')} עוד מחכות לכם` : ''}.`,
    ...(r.cart ? [`עגלות נטושות: ${r.cart}.`] : []),
    `בחבילה ${r.cap.toLocaleString('he-IL')} שיחות בחודש${r.conversations > r.cap ? `, וב${m} עברתם אותן. חודש עמוס אחד לא עולה יותר` : ''}.`,
    '',
    'כל השיחות והמספרים בלוח הבקרה.',
  ];
  return { subject: `החודש של תורן ב${storeName}: ${r.alone.toLocaleString('he-IL')} תשובות לבד ב${m}`, text: lines.join('\n'), link: `${base}/` };
}

/** On the 1st from 09:00: last month's report to each customer store's owners, once a store. */
export async function monthlyReports(app: App, { t = now(), force = false }: { t?: number; force?: boolean } = {}): Promise<{ sent: number[]; skipped: number[] }> {
  const out = { sent: [] as number[], skipped: [] as number[] };
  const day = Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', day: '2-digit' }).format(new Date(t)));
  if (!force && (day !== 1 || israelWeekdayHour(t).hour < 9)) return out;
  const month = prevMonth(monthOf(t));
  const done = await app.db.one<{ value: any }>("SELECT value FROM settings WHERE key = 'monthly_reports'");
  if (!force && done?.value?.month === month) return out;
  const base = String(app.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  const stores = await app.db.query<any>(`SELECT s.id, s.name, s.domain, s.brand, s.brand_override, s.config, s.workspace_id FROM stores s
    WHERE s.workspace_id IS NOT NULL AND s.platform <> 'company' AND s.service_stopped_at IS NULL AND s.taken_down_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM events e WHERE e.store_id = s.id AND e.kind = 'monthly_report' AND e.data->>'month' = $1)`, [month]);
  let unasked = 0;
  for (const s of stores) {
    const r = await monthReport(app, s.id, s.config, month);
    if (!r.conversations && !r.cart) {
      out.skipped.push(s.id);
      continue;
    }
    const name = displayName(s.brand_override?.name, s.brand?.name, s.name) || s.domain;
    const m = reportMail(name, r, base);
    const sent = await notifyOwners(app, Number(s.workspace_id), 'monthly', m.subject, m.text, m.link);
    if (sent.ok || sent.reachable) {
      // Sent, or refused by accounts for a reason it will keep (the product off, the day's limit): not asked again.
      await event(app.db, s.id, 'monthly_report', { month, ok: sent.ok, ...(sent.ok ? { sent: sent.sent } : { why: sent.why }) });
      (sent.ok ? out.sent : out.skipped).push(s.id);
    } else {
      app.log(`[reports] store ${s.id}: accounts could not be asked (${sent.why}); tried again on the next tick`);
      out.skipped.push(s.id);
      unasked++;
    }
  }
  // Every store answered for: the month is done, and the ticks after it ask nothing.
  if (!unasked) await app.db.query("INSERT INTO settings (key, value) VALUES ('monthly_reports', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [JSON.stringify({ month })]);
  return out;
}
