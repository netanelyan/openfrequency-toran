import type { Db } from '../db/index.ts';
import { now } from '../core/clock.ts';

// What the cart reminders brought back, per month (the owner, 2026-11-06, docs/todo.md: "the owner can see money that
// came back (carts recovered, and their total)"): carts reminded, carts recovered, and the money recovered.
//
// A cart is recovered when an order is placed after its reminder went out and within RECOVERY_DAYS of it, by the same
// checkout (the platform says the order came from it) or by the same person (the cart's phone or email on the order).
// Seven days is the window: a reminder is one message, read the same day or the next, and a week covers a customer who
// came back to the cart on the weekend without crediting the reminder with every later order. It is the reminder's
// share of the order, not proof the reminder caused it, and the page says "חזרו והזמינו", not "בזכות התזכורת".
//
// The money is the order's own total where the platform gave one (send.ts keeps it on the order's "placed" row), else
// the cart's; an order with neither counts as recovered with no amount. Each currency is summed apart. Months are
// Israel's, by when the reminder went out.

export const RECOVERY_DAYS = 7;

export type CartMonth = { month: string; reminded: number; recovered: number; money: Record<string, number> };

/** The carts' months for these stores, newest first: the last `months` months that had a reminder. */
export async function cartReport(db: Db, storeIds: number[], months = 3): Promise<CartMonth[]> {
  if (!storeIds.length) return [];
  const since = new Date(now() - (months + 1) * 31 * 86_400_000).toISOString();
  const rows = await db.query<{ month: string; cart_total: string | null; cart_cur: string | null; placed: any }>(
    `SELECT to_char(e.sent_at AT TIME ZONE 'Asia/Jerusalem', 'YYYY-MM') AS month, e.vars->>'total' AS cart_total, e.vars->>'currency' AS cart_cur,
       (SELECT p.vars FROM auto_events p WHERE p.store_id = e.store_id AND p.message = 'placed'
          AND p.happened_at > e.sent_at AND p.happened_at <= e.sent_at + make_interval(days => ${RECOVERY_DAYS})
          AND (p.vars->>'checkout' = split_part(e.key, ':', 3)
            OR (e.contact->>'phone' IS NOT NULL AND p.contact->>'phone' = e.contact->>'phone')
            OR (e.contact->>'email' IS NOT NULL AND p.contact->>'email' = e.contact->>'email'))
          ORDER BY p.happened_at LIMIT 1) AS placed
     FROM auto_events e
     WHERE e.store_id = ANY($1::int[]) AND e.message = 'cart' AND e.status = 'sent' AND e.sent_at >= $2`,
    [storeIds, since],
  );
  const by = new Map<string, CartMonth>();
  for (const r of rows) {
    const m = by.get(r.month) || { month: r.month, reminded: 0, recovered: 0, money: {} };
    m.reminded++;
    if (r.placed) {
      m.recovered++;
      const placed = typeof r.placed === 'string' ? JSON.parse(r.placed) : r.placed;
      const total = Number(placed?.total ?? r.cart_total);
      const currency = String((placed?.total != null ? placed?.currency : r.cart_cur) || 'ILS').toUpperCase();
      if (Number.isFinite(total) && total > 0) m.money[currency] = Math.round(((m.money[currency] || 0) + total) * 100) / 100;
    }
    by.set(r.month, m);
  }
  return [...by.values()].sort((a, b) => b.month.localeCompare(a.month)).slice(0, months);
}

/** The month as Israel's calendar has it now, YYYY-MM. */
export const monthNow = (t = now()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit' }).format(new Date(t)).slice(0, 7);

const SIGN: Record<string, string> = { ILS: '₪', USD: '$', EUR: '€', GBP: '£' };

/**
 * "1,240 ₪" (and "80 $" beside it in another currency), or '' with no money: the sign after the number, as every other
 * price Toran shows ("249 ₪", offer.ts; "₪1,240" here was the audit's P2-17).
 */
export const moneyHe = (money: Record<string, number>) =>
  Object.entries(money)
    .sort(([a], [b]) => (a === 'ILS' ? -1 : b === 'ILS' ? 1 : a.localeCompare(b)))
    .map(([c, v]) => `${Math.round(v).toLocaleString('en-US')} ${SIGN[c] || c}`)
    .join(' + ');

const MONTH_HE = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
export const monthHe = (m: string) => MONTH_HE[Number(m.slice(5, 7)) - 1] || m;

/** One month in words: "12 עגלות קיבלו תזכורת, 3 חזרו והזמינו, 1,240 ₪". */
export function cartLine(m: CartMonth): string {
  const money = moneyHe(m.money);
  const reminded = m.reminded === 1 ? 'עגלה אחת קיבלה תזכורת' : `${m.reminded} עגלות קיבלו תזכורת`;
  const back = m.recovered === 0 ? 'עוד אף אחת לא חזרה להזמין' : m.recovered === 1 ? 'אחת חזרה והזמינה' : `${m.recovered} חזרו והזמינו`;
  return `${reminded}, ${back}${money ? `, ${money}` : ''}`;
}
