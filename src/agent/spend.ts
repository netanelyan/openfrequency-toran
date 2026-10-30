import type { App } from '../app.ts';
import type { Db } from '../db/index.ts';
import { monthOf, PLANS, planOf } from '../plans.ts';
import { alertOperator } from '../ops/alert.ts';

// What the model may still spend, before each agent turn (agent/loop.ts). Two caps, on the paid API only (the
// subscription's claude-cli costs nothing per call):
//
//   the store's   its month's spend (store_spend, kept as each usage row is written: db/log.ts) against its cap: the
//                 operator's stores.config.capUsd, else its plan's conversations, twice over (one busy month costs
//                 nothing more, as the website says), at TORAN_CAP_USD_PER_CONVERSATION each (0.25: 300 conversations
//                 are $150, 1,500 are $750). The 0.25 is measured, not guessed: docs/milestones.md has an
//                 eight-question conversation at about $0.23 on Opus 5.5 before prompt caching. Past the cap only that
//                 store hands off; the others go on
//   everyone's    TORAN_MONTHLY_CAP_USD over all usage this month, read at most once a minute
//
// At 80% of either the operator hears once that month; past it, once a day. A store spending more than
// TORAN_STORE_HOUR_ALERT_USD (5) in one hour is said too, at most once an hour (a burst, or two bots answering each
// other). Months are Israel's calendar months.

const PER_CONVERSATION = 0.25;
const HOUR_ALERT_USD = 5;
const GLOBAL_TTL_MS = 60_000;

let globalCache: { month: string; at: number; usd: number } | null = null;

/** This month's spend over every store and none, cached a minute so a turn never sums the usage table. */
export async function monthSpend(db: Db, t = Date.now()): Promise<number> {
  const month = monthOf(t);
  if (globalCache && globalCache.month === month && t - globalCache.at < GLOBAL_TTL_MS) return globalCache.usd;
  const r = await db.one<{ usd: number }>(`SELECT COALESCE(SUM(usd), 0)::float AS usd FROM usage WHERE at >= ($1::date::timestamp AT TIME ZONE 'Asia/Jerusalem')`, [`${month}-01`]);
  globalCache = { month, at: t, usd: Number(r?.usd) || 0 };
  return globalCache.usd;
}

/** Forget the cached total (tests, and after a cap is changed). */
export const forgetMonthSpend = () => {
  globalCache = null;
};

export async function storeSpend(db: Db, storeId: number, t = Date.now()): Promise<number> {
  const r = await db.one<{ usd: number }>('SELECT usd::float AS usd FROM store_spend WHERE store_id = $1 AND month = $2', [storeId, monthOf(t)]);
  return Number(r?.usd) || 0;
}

/** A store's monthly cap in dollars: the operator's number, or its plan's. */
export function storeCapUsd(env: Record<string, string | undefined>, config: any): number {
  const own = Number(config?.capUsd);
  if (config?.capUsd != null && Number.isFinite(own) && own >= 0) return own;
  const per = Number(env.TORAN_CAP_USD_PER_CONVERSATION);
  return PLANS[planOf(config)].conversations * 2 * (Number.isFinite(per) && per > 0 ? per : PER_CONVERSATION);
}

export type Capped = { by: 'store' | 'global'; cap: number; spent: number } | null;

/** Is this store past a cap? Null when not, or when the backend is not the paid API. Says 80% to the operator. */
export async function capFor(app: App, store: { id: number; config?: any }): Promise<Capped> {
  if (app.llm.backend !== 'api') return null;
  const month = monthOf();
  const cap = storeCapUsd(app.env, store.config);
  const spent = await storeSpend(app.db, store.id);
  const global = Number(app.env.TORAN_MONTHLY_CAP_USD) || 0;
  const all = global > 0 ? await monthSpend(app.db) : 0;
  if (spent >= cap) {
    await alertOperator(app, `cap:store:${store.id}:${month}`, `חנות ${store.id} הגיעה לתקרת ההוצאה החודשית`, `הוצאה החודש: $${spent.toFixed(2)} מתוך $${cap.toFixed(2)}. עד סוף החודש, או עד שמעלים לה את התקרה (config.capUsd), כל שאלה של לקוח בחנות הזו עוברת לבעלים בלי מודל.`, { everyMinutes: 24 * 60, storeId: store.id });
    return { by: 'store', cap, spent };
  }
  if (global > 0 && all >= global) {
    await alertOperator(app, `cap:global:${month}`, 'תורן הגיע לתקרת ההוצאה החודשית הכללית', `הוצאה החודש: $${all.toFixed(2)} מתוך $${global.toFixed(2)} (TORAN_MONTHLY_CAP_USD). עד סוף החודש כל החנויות מעבירות שאלות לבעלים בלי מודל.`, { everyMinutes: 24 * 60 });
    return { by: 'global', cap: global, spent: all };
  }
  if (spent >= cap * 0.8) await alertOperator(app, `cap80:store:${store.id}:${month}`, `חנות ${store.id} ב-80% מתקרת ההוצאה`, `הוצאה החודש: $${spent.toFixed(2)} מתוך $${cap.toFixed(2)}.`, { everyMinutes: 40 * 24 * 60, storeId: store.id });
  if (global > 0 && all >= global * 0.8) await alertOperator(app, `cap80:global:${month}`, 'תורן ב-80% מתקרת ההוצאה הכללית', `הוצאה החודש: $${all.toFixed(2)} מתוך $${global.toFixed(2)}.`, { everyMinutes: 40 * 24 * 60 });
  return null;
}

/** After a turn that cost something: a store spending more than the hourly line in one hour is told to the operator. */
export async function watchHour(app: App, storeId: number) {
  const line = Number(app.env.TORAN_STORE_HOUR_ALERT_USD) || HOUR_ALERT_USD;
  const r = await app.db.one<{ usd: number }>("SELECT COALESCE(SUM(usd), 0)::float AS usd FROM usage WHERE store_id = $1 AND at > now() - interval '1 hour'", [storeId]);
  const usd = Number(r?.usd) || 0;
  if (usd > line) await alertOperator(app, `hour:${storeId}`, `חנות ${storeId} הוציאה $${usd.toFixed(2)} בשעה האחרונה`, `זה יותר מ-$${line} בשעה (TORAN_STORE_HOUR_ALERT_USD). כדאי לבדוק בתיבה של החנות אם יש הצפה של הודעות או שני בוטים שעונים זה לזה.`, { storeId });
}
