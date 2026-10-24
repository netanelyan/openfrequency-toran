import type { App } from '../app.ts';
import type { Customer } from './sources.ts';

// Each product's funnel, for the operator: how many reached each stage, over all time and in the last 30 days (by
// the moment each one reached it), and the rate from each stage to the next. The last stage, customers, is accounts'
// word (a subscription that is paid or ending), never a status typed here.

export type Stage = { key: string; label: string; all: number; month: number };

const count = async (app: App, sql: string) => (await app.db.one<{ all: number; month: number }>(sql))!;

export async function funnels(app: App, customers: Customer[] | null): Promise<{ toran: Stage[]; teder: Stage[] }> {
  const t = (col: string, where = 'TRUE') => `SELECT COUNT(*) FILTER (WHERE ${col} IS NOT NULL AND ${where})::int AS all, COUNT(*) FILTER (WHERE ${col} > now() - interval '30 days' AND ${where})::int AS month FROM stores`;
  const d = (col: string, where = 'TRUE') => `SELECT COUNT(*) FILTER (WHERE ${col} IS NOT NULL AND ${where})::int AS all, COUNT(*) FILTER (WHERE ${col} > now() - interval '30 days' AND ${where})::int AS month FROM teder_leads`;
  const paying = (product: string) => {
    const list = (customers || []).filter((w) => w.subscriptions.some((s) => s.product === product && (s.state === 'paid' || s.state === 'ending')));
    const month = list.filter((w) => w.subscriptions.some((s) => s.product === product && s.startedOn && Date.parse(s.startedOn) > Date.now() - 30 * 86_400_000)).length;
    return { all: list.length, month };
  };
  const stage = (key: string, label: string, n: { all: number; month: number }): Stage => ({ key, label, ...n });
  const toran = [
    stage('found', 'נמצאו', await count(app, t('found_at'))),
    stage('qualified', 'מתאימות', await count(app, t('found_at', 'qualified'))),
    stage('page', 'דף מוכן', await count(app, t('page_built_at'))),
    stage('sent', 'נשלח', await count(app, t('sent_at'))),
    stage('opened', 'נפתח', await count(app, t('opened_at'))),
    stage('demo', 'ניסו את הדמו', await count(app, t('demo_started_at'))),
    stage('replied', 'ענו', await count(app, t('replied_at'))),
    stage('customers', 'לקוחות', customers ? paying('toran') : { all: 0, month: 0 }),
  ];
  const teder = [
    stage('asked', 'ביקשו באתר', await count(app, d('created_at'))),
    stage('ready', 'מצגת מוכנה', await count(app, d('approved_at'))),
    stage('sent', 'נשלח', await count(app, d('sent_at'))),
    stage('opened', 'נפתח', await count(app, d('last_open_at'))),
    stage('replied', 'ענו', await count(app, d('replied_at'))),
    stage('customers', 'לקוחות', customers ? paying('teder') : { all: 0, month: 0 }),
  ];
  return { toran, teder };
}

/** The rate from the stage before, as a whole percent, or null when the stage before is empty. */
export const rate = (stages: Stage[], i: number, k: 'all' | 'month') => (i > 0 && stages[i - 1][k] ? Math.round((100 * stages[i][k]) / stages[i - 1][k]) : null);

export type Money = { mrr: number; paying: { toran: number; teder: number }; late: { w: Customer; product: string; since: string | null; monthly: number }[]; waiting: { w: Customer; product: string; monthly: number; setup: number }[]; renewals: { w: Customer; product: string; on: string; monthly: number }[] };

/** The money, from accounts' subscriptions: monthly revenue before VAT, who is late, who has not paid yet, the next 7 days. */
export function money(customers: Customer[], today: string): Money {
  const out: Money = { mrr: 0, paying: { toran: 0, teder: 0 }, late: [], waiting: [], renewals: [] };
  const week = new Date(Date.parse(today) + 7 * 86_400_000).toISOString().slice(0, 10);
  for (const w of customers) {
    if (w.disabled) continue;
    for (const s of w.subscriptions) {
      // VAT included: the monthly figure holds 18% VAT; the revenue counts it without.
      const net = s.vat === 'included' ? Math.round((s.monthly / 1.18) * 100) / 100 : s.monthly;
      if (s.state === 'paid' || s.state === 'ending') {
        out.mrr += net;
        if (s.product === 'toran' || s.product === 'teder') out.paying[s.product]++;
        if (s.state === 'paid' && s.nextChargeOn && s.nextChargeOn <= week) out.renewals.push({ w, product: s.product, on: s.nextChargeOn, monthly: s.monthly });
      } else if (s.state === 'late') out.late.push({ w, product: s.product, since: s.nextChargeOn, monthly: s.monthly });
      else if (s.state === 'waiting') out.waiting.push({ w, product: s.product, monthly: s.monthly, setup: s.setup });
    }
  }
  out.mrr = Math.round(out.mrr * 100) / 100;
  out.renewals.sort((a, b) => a.on.localeCompare(b.on));
  return out;
}
