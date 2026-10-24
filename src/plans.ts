import type { Db } from './db/index.ts';

// Toran's plans, as openfrequency.co.il/toran sells them: two plans by conversations a month, everything else the same.
// The price, the founding offer and the invoices are accounts' (openfrequency-accounts), so Toran never quotes them;
// it knows which plan a store is on (stores.config.plan, set by the operator) and counts the conversations.
//
// A conversation counts when a customer wrote in it that month, on one of the store's own channels (a conversation
// with an account: its email address now, its own WhatsApp number once Meta connects it). The demo, on our shared
// demo number, never counts. Months are Israel's calendar months.
//
// Moving between plans, as the website says it: one busy month costs nothing more. Two months in a row over the plan,
// and the store moves to the big plan (we write to the owner on WhatsApp a week before); two months in a row under
// 300 on the big plan, and it moves back. The move itself is the operator's, on the store's page.

export const PLANS = {
  store: { he: 'חנות', conversations: 300 },
  big: { he: 'חנות גדולה', conversations: 1500 },
} as const;
export type PlanKey = keyof typeof PLANS;

export const planOf = (config: any): PlanKey => (config?.plan === 'big' ? 'big' : 'store');

const TZ = 'Asia/Jerusalem';

/** "2026-10", the month a time falls in, in Israel. */
export function monthOf(t: number | Date = Date.now()): string {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit' }).formatToParts(new Date(t));
  return `${p.find((x) => x.type === 'year')!.value}-${p.find((x) => x.type === 'month')!.value}`;
}

/** The month before "2026-10": "2026-09". */
export function prevMonth(m: string): string {
  const [y, mo] = m.split('-').map(Number);
  return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`;
}

/** The conversations that count, per store and month, for these stores over the last `months` months (this one included). */
export async function counted(db: Db, storeIds: number[], { months = 3, now = Date.now() }: { months?: number; now?: number } = {}): Promise<Map<number, Map<string, number>>> {
  const out = new Map<number, Map<string, number>>(storeIds.map((id) => [id, new Map()]));
  const ids = storeIds.filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) return out;
  let from = monthOf(now);
  for (let i = 1; i < months; i++) from = prevMonth(from);
  const rows = await db.query<{ store_id: number; month: string; n: number }>(
    `SELECT c.store_id, to_char(m.at AT TIME ZONE '${TZ}', 'YYYY-MM') AS month, COUNT(DISTINCT c.id)::int AS n
       FROM conversations c JOIN messages m ON m.conversation_id = c.id
      WHERE c.store_id IN (${ids.map(Number).join(', ')}) AND c.account_id IS NOT NULL AND m.role = 'customer'
        AND m.at >= ($1::date::timestamp AT TIME ZONE '${TZ}')
      GROUP BY 1, 2`,
    [`${from}-01`],
  );
  for (const r of rows) out.get(r.store_id)?.set(r.month, r.n);
  return out;
}

export type Usage = { plan: PlanKey; cap: number; month: string; thisMonth: number; lastMonth: number; note: string | null };

/** One store's month against its plan, and the sentence about moving plans when one is due (the website's rule). */
export function usageOf(plan: PlanKey, byMonth: Map<string, number> | undefined, now = Date.now()): Usage {
  const month = monthOf(now);
  const thisMonth = byMonth?.get(month) || 0;
  const lastMonth = byMonth?.get(prevMonth(month)) || 0;
  const cap = PLANS[plan].conversations;
  const small = PLANS.store.conversations;
  let note: string | null = null;
  if (plan === 'store' && thisMonth > cap) {
    note = lastMonth > cap
      ? `זה החודש השני ברצף מעל ${cap} שיחות, אז מהחודש הבא החנות עוברת לחבילה הגדולה. נכתוב לכם בוואטסאפ שבוע לפני.`
      : `החודש עברתם את ${cap} השיחות של החבילה, וזה לא עולה לכם יותר. אם גם החודש הבא יהיה מעל ${cap}, החנות תעבור לחבילה הגדולה, ונכתוב לכם בוואטסאפ שבוע לפני.`;
  } else if (plan === 'big' && thisMonth > cap) {
    note = `החודש עברתם את ${cap.toLocaleString('en-US')} השיחות של החבילה הגדולה. כתבו לנו בוואטסאפ, ונבנה חבילה לפי החנות.`;
  } else if (plan === 'big' && lastMonth < small && lastMonth > 0) {
    note = `בחודש שעבר היו פחות מ-${small} שיחות. אם גם החודש ייגמר מתחת ל-${small}, החנות תחזור לחבילת חנות.`;
  }
  return { plan, cap, month, thisMonth, lastMonth, note };
}
