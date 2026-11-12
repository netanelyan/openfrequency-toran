import type { App } from '../app.ts';
import { type Db, J } from '../db/index.ts';
import { audit } from '../db/log.ts';
import { monthOf, PLANS, planOf, type PlanKey } from '../plans.ts';
import { alertOperator } from '../ops/alert.ts';
import { lastKnown } from '../billing/entitlement.ts';
import { enqueue } from '../jobs/queue.ts';
import { displayName } from '../ingest/brand.ts';

// What the model may still spend, asked before each agent turn (agent/loop.ts), a store's voice (agent/voice.ts), the
// looks of its photos (ingest/looks.ts) and a receipt's check (channels/payCheck.ts).
//
// A CUSTOMER'S STORE (one in a workspace) is held to what its customer pays. The owner, 2026-11-11: "make sure there is
// a cap where if ai costs of an account reach 30% of the payment of the customer, we get alerted. them on 50% it
// stops." The cost is the month's usage of every store of the workspace, in dollars (a claude-cli call at its API
// price, as the header and the settings page count it), in shekels at USD_ILS; the payment is what a month of Toran
// costs the workspace before VAT (accounts' entitlement answer, `monthlyIls`; the plan's list price when an accounts
// from before 2026-11-11 gives none):
//
//   ALERT_SHARE (30%)  the operator hears, once that month
//   STOP_SHARE (50%)   no model call for the workspace's stores until the month ends: a customer's message gets the
//                      honest "checking" line and goes to the owner, as past a cap (agent/loop.ts), and the owner's line
//                      says only that Toran passed the question on, never a cost or a share. The operator hears once,
//                      and can lift it for the rest of the month on the store's page (/lead/<id>#cost), audited. The
//                      owner is told once by email and on Today while it lasts, as the terms promise (owners/paused.ts)
//
// On every backend: the subscription's calls count at their API price, so a workspace stops in development as it would
// in production. It replaces the plan's cap for these stores (its conversations twice over at $0.25: $150 for a store
// paying 590 ₪, about 80% of it); the operator's own stores.config.capUsd still stops its one store when it comes first.
//
// EVERY OTHER STORE (a lead, a demo, our support store: nobody pays for them) is held, on the paid API only (the
// subscription's claude-cli costs nothing per call), to:
//
//   its own   its month's spend (store_spend, kept as each usage row is written: db/log.ts) against its cap: the
//             operator's stores.config.capUsd, else its plan's conversations, twice over, at
//             TORAN_CAP_USD_PER_CONVERSATION each (0.25; docs/milestones.md has an eight-question conversation at about
//             $0.23 on Opus 5.5 before prompt caching). Past it only that store hands off; the others go on
//   ours      TORAN_MONTHLY_CAP_USD over this month's usage of the stores in no workspace and of none (our number's
//             messages, a receipt's check with no support store), read at most once a minute. Never a customer's
//             (2026-11-11): a launch with paying stores cannot stop them by it, nor run it out for the demos
//
// At 80% of either the operator hears once that month; past it, once a day. A store spending more than
// TORAN_STORE_HOUR_ALERT_USD (5) in one hour is said too, at most once an hour (a burst, or two bots answering each
// other). Months are Israel's calendar months.

/** The owner's 30%: the operator hears. */
export const ALERT_SHARE = 0.3;
/** The owner's 50%: the model stops for the workspace's stores until the month ends. */
export const STOP_SHARE = 0.5;
/** Shekels to the dollar when USD_ILS is not set: the Bank of Israel's representative rate on 2026-11-11 was 3.172. */
export const USD_ILS = 3.17;
/**
 * What a month of Toran costs before VAT, in shekels, when accounts' answer has no `monthlyIls`: the plans' list prices
 * (accounts' src/accounts/subscriptions.js, 2026-11-11). Read by this rule only: Toran never shows a price.
 */
export const LIST_ILS: Record<PlanKey, number> = { store: 590, big: 1190 };

const PER_CONVERSATION = 0.25;
const HOUR_ALERT_USD = 5;
const GLOBAL_TTL_MS = 60_000;
const ONCE_A_MONTH = 40 * 24 * 60;
const TZ = 'Asia/Jerusalem';

type Env = Record<string, string | undefined>;

export const usdIls = (env: Env) => {
  const n = Number(env.USD_ILS);
  return Number.isFinite(n) && n > 0 ? n : USD_ILS;
};

/** "2026-12" after "2026-11". */
const nextMonth = (m: string) => {
  const [y, mo] = m.split('-').map(Number);
  return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
};

let globalCache: { month: string; at: number; usd: number } | null = null;

/** This month's paid spend over the stores in no workspace and none (TORAN_MONTHLY_CAP_USD's), cached a minute so a turn never sums the usage table. */
export async function monthSpend(db: Db, t = Date.now()): Promise<number> {
  const month = monthOf(t);
  if (globalCache && globalCache.month === month && t - globalCache.at < GLOBAL_TTL_MS) return globalCache.usd;
  const r = await db.one<{ usd: number }>(
    `SELECT COALESCE(SUM(u.usd), 0)::float AS usd FROM usage u
      WHERE u.at >= ($1::date::timestamp AT TIME ZONE '${TZ}')
        AND NOT EXISTS (SELECT 1 FROM stores s WHERE s.id = u.store_id AND s.workspace_id IS NOT NULL)`,
    [`${month}-01`],
  );
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

/** The operator's own monthly cap for one store (stores.config.capUsd), or null when none is set. */
const ownCapUsd = (config: any): number | null => {
  const own = Number(config?.capUsd);
  return config?.capUsd != null && Number.isFinite(own) && own >= 0 ? own : null;
};

/** A store's monthly cap in dollars: the operator's number, or its plan's. */
export function storeCapUsd(env: Env, config: any): number {
  const own = ownCapUsd(config);
  if (own != null) return own;
  const per = Number(env.TORAN_CAP_USD_PER_CONVERSATION);
  return PLANS[planOf(config)].conversations * 2 * (Number.isFinite(per) && per > 0 ? per : PER_CONVERSATION);
}

// ---- a customer's workspace: its month's cost against what it pays

/** The month's usage of a workspace's stores in dollars: what each call cost, a claude-cli call at its API price. */
export async function workspaceSpend(db: Db, workspaceId: number, t = Date.now()): Promise<number> {
  const m = monthOf(t);
  const r = await db.one<{ usd: number }>(
    `SELECT COALESCE(SUM(CASE WHEN u.backend = 'claude-cli' THEN u.api_usd ELSE u.usd END), 0)::float AS usd FROM usage u
      WHERE u.store_id IN (SELECT id FROM stores WHERE workspace_id = $1)
        AND u.at >= ($2::date::timestamp AT TIME ZONE '${TZ}') AND u.at < ($3::date::timestamp AT TIME ZONE '${TZ}')`,
    [workspaceId, `${m}-01`, `${nextMonth(m)}-01`],
  );
  return Number(r?.usd) || 0;
}

/** What a month of Toran costs the workspace before VAT, in shekels: accounts' `monthlyIls`, else its plan's list price. */
export async function monthlyIlsOf(db: Db, workspaceId: number, config?: any): Promise<number> {
  const kept = await lastKnown(db, workspaceId);
  const n = Number(kept?.monthlyIls);
  if (kept?.monthlyIls != null && Number.isFinite(n) && n > 0) return n;
  return LIST_ILS[kept?.plan?.name === 'big' || kept?.plan?.name === 'store' ? kept.plan.name : planOf(config)];
}

/** The operator's lift of a workspace's stop: who, when, and for which month (only that one counts). */
export type Lift = { month: string; by: string; at: string };
const liftKey = (workspaceId: number) => `cost_lift:${workspaceId}`;

/** The lift that holds this month, or null. */
export async function liftOf(db: Db, workspaceId: number, t = Date.now()): Promise<Lift | null> {
  const v = (await db.one<{ value: Lift }>('SELECT value FROM settings WHERE key = $1', [liftKey(workspaceId)]))?.value;
  return v && v.month === monthOf(t) ? v : null;
}

export type Share = { workspace: number; month: string; usd: number; ils: number; base: number; share: number; lifted: Lift | null };

/** A workspace's month: its cost in dollars and shekels, what it pays, the share, and the operator's lift. */
export async function shareOf(app: { db: Db; env: Env }, workspaceId: number, config?: any, t = Date.now()): Promise<Share> {
  const usd = await workspaceSpend(app.db, workspaceId, t);
  const ils = usd * usdIls(app.env);
  const base = await monthlyIlsOf(app.db, workspaceId, config);
  return { workspace: workspaceId, month: monthOf(t), usd, ils, base, share: base > 0 ? ils / base : 0, lifted: await liftOf(app.db, workspaceId, t) };
}

/** Is the workspace's model stopped for the rest of this month (past STOP_SHARE, not lifted)? */
export const stopped = (s: Share) => s.share >= STOP_SHARE && !s.lifted;

/** Where a customer's store stops this month, in dollars: half of what its workspace pays, or the operator's own capUsd when lower. */
export async function customerCapUsd(app: { db: Db; env: Env }, workspaceId: number, config?: any): Promise<number> {
  const line = ((await monthlyIlsOf(app.db, workspaceId, config)) * STOP_SHARE) / usdIls(app.env);
  const own = ownCapUsd(config);
  return own != null ? Math.min(own, line) : line;
}

/**
 * The operator lifts a workspace's stop for the rest of this month, or puts it back (`on` false): kept in the settings
 * table, read on the next turn by the worker too, and audited with the month's numbers.
 */
export async function setLift(app: { db: Db; env: Env }, workspaceId: number, on: boolean, { actor, storeId }: { actor: string; storeId: number }): Promise<Share> {
  const before = await shareOf(app, workspaceId);
  if (on) await app.db.query('INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [liftKey(workspaceId), J({ month: before.month, by: actor, at: new Date().toISOString() } satisfies Lift)]);
  else await app.db.query('DELETE FROM settings WHERE key = $1', [liftKey(workspaceId)]);
  await audit(app.db, { actor, action: on ? 'cost_lift' : 'cost_stop', storeId, detail: { workspace: workspaceId, month: before.month, usd: round2(before.usd), ils: round2(before.ils), monthlyIls: before.base, share: round2(before.share) } });
  return { ...before, lifted: on ? { month: before.month, by: actor, at: new Date().toISOString() } : null };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
/** Shekels as accounts writes them ("1,746.40 ₪"), a round amount without its agorot ("590 ₪"). */
export const shekels = (n: number) => `${n.toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })} ₪`;
/** A share as a whole percent, never rounded up to the next line: 0.499 is 49%. */
export const percent = (share: number) => `${Math.floor(share * 100)}%`;
const MONTH_HE = new Intl.DateTimeFormat('he-IL', { timeZone: TZ, month: 'long', year: 'numeric' });
/** "נובמבר 2026" for "2026-11". */
export const monthHe = (month: string) => MONTH_HE.format(Date.parse(`${month}-15T12:00:00Z`));

/** The workspace's stores as the operator knows them: the first one's name, and how many more. */
async function storesNamed(db: Db, workspaceId: number): Promise<string> {
  const rows = await db.query<{ name: string | null; domain: string; brand: any; brand_override: any }>('SELECT name, domain, brand, brand_override FROM stores WHERE workspace_id = $1 ORDER BY id', [workspaceId]);
  const first = rows[0] ? displayName(rows[0].brand_override?.name, rows[0].brand?.name, rows[0].name) || rows[0].domain : `חשבון ${workspaceId}`;
  return rows.length > 1 ? `${first} ועוד ${rows.length - 1 === 1 ? 'חנות אחת' : `${rows.length - 1} חנויות`}` : first;
}

/** The operator's line about a workspace's month: when, the cost in shekels and dollars, and its share of what the customer pays. */
const costLine = (s: Share, so: string) => `ב${monthHe(s.month)} המודל עלה ${so} ${shekels(round2(s.ils))} ($${s.usd.toFixed(2)}), שהם ${percent(s.share)} מ-${shekels(s.base)} שהלקוח משלם על החודש לפני מע״מ.`;

export type Capped = { by: 'store' | 'global' | 'share'; cap: number; spent: number; customer: boolean } | null;

/**
 * Is this store past a cap? Null when not. A customer's store: its workspace's share (any backend) and the operator's
 * own capUsd for it (the paid API); every other store: its own cap and ours, on the paid API only. Says it to the
 * operator on the way (30% and 50% of what a customer pays, 80% and past a cap).
 */
export async function capFor(app: App, store: { id: number; config?: any; workspace_id?: number | null }): Promise<Capped> {
  const ws = store.workspace_id !== undefined ? store.workspace_id : ((await app.db.one<{ workspace_id: number | null }>('SELECT workspace_id FROM stores WHERE id = $1', [store.id]))?.workspace_id ?? null);
  return ws != null ? customerCap(app, store, Number(ws)) : ourCap(app, store);
}

async function customerCap(app: App, store: { id: number; config?: any }, workspaceId: number): Promise<Capped> {
  const month = monthOf();
  const own = ownCapUsd(store.config);
  if (own != null && app.llm.backend === 'api') {
    const spent = await storeSpend(app.db, store.id);
    if (spent >= own) {
      await alertOperator(app, `cap:store:${store.id}:${month}`, `חנות ${store.id} הגיעה לתקרת ההוצאה שקבעת לה`, `הוצאה החודש: $${spent.toFixed(2)} מתוך $${own.toFixed(2)} (config.capUsd). עד סוף החודש, או עד שמעלים לה את התקרה, כל שאלה של לקוח בחנות הזו עוברת לבעלים בלי מודל.`, { everyMinutes: 24 * 60, storeId: store.id });
      return { by: 'store', cap: own, spent, customer: true };
    }
    if (spent >= own * 0.8) await alertOperator(app, `cap80:store:${store.id}:${month}`, `חנות ${store.id} ב-80% מתקרת ההוצאה שקבעת לה`, `הוצאה החודש: $${spent.toFixed(2)} מתוך $${own.toFixed(2)}.`, { everyMinutes: ONCE_A_MONTH, storeId: store.id });
  }
  const s = await shareOf(app, workspaceId, store.config);
  if (s.share < ALERT_SHARE) return null;
  const who = await storesNamed(app.db, workspaceId);
  if (s.share >= STOP_SHARE) {
    // A lift is the operator's answer to this alert: after one, nothing more is said this month.
    if (s.lifted) return null;
    const first = await alertOperator(app, `cost50:ws:${workspaceId}:${month}`, `תורן עצר את המודל בחשבון ${workspaceId} (${who}) עד סוף החודש`, `${costLine(s, 'כבר')} מעכשיו עד סוף החודש השאלות של הלקוחות בחנויות של החשבון עוברות לבעלים בלי מודל, והבעלים לא רואים סכום או אחוז. הם מקבלים מייל אחד ושורה בדף "היום". אפשר להחזיר את המודל לחודש הזה בדף של החנות, בחלק "החבילה של הלקוח".`, { everyMinutes: ONCE_A_MONTH, storeId: store.id });
    // The owner is told once too, as the terms promise (owners/paused.ts): the email waits for the worker, never the customer.
    if (first) await enqueue(app.db, 'owner_paused', { workspace: workspaceId, month }, { dedupeKey: `owner_paused:${workspaceId}:${month}` }).catch((e) => app.log(`[spend] workspace ${workspaceId}: the owners' notice was not queued: ${e?.message || e}`));
    return { by: 'share', cap: (s.base * STOP_SHARE) / usdIls(app.env), spent: s.usd, customer: true };
  }
  await alertOperator(app, `cost30:ws:${workspaceId}:${month}`, `המודל בחשבון ${workspaceId} (${who}) עלה החודש ${percent(s.share)} ממה שהלקוח משלם`, `${costLine(s, 'עד עכשיו')} ב-50% תורן יעצור את המודל בחנויות של החשבון עד סוף החודש, והשאלות של הלקוחות יעברו לבעלים.`, { everyMinutes: ONCE_A_MONTH, storeId: store.id });
  return null;
}

async function ourCap(app: App, store: { id: number; config?: any }): Promise<Capped> {
  if (app.llm.backend !== 'api') return null;
  const month = monthOf();
  const cap = storeCapUsd(app.env, store.config);
  const spent = await storeSpend(app.db, store.id);
  const global = Number(app.env.TORAN_MONTHLY_CAP_USD) || 0;
  const all = global > 0 ? await monthSpend(app.db) : 0;
  if (spent >= cap) {
    await alertOperator(app, `cap:store:${store.id}:${month}`, `חנות ${store.id} הגיעה לתקרת ההוצאה החודשית`, `הוצאה החודש: $${spent.toFixed(2)} מתוך $${cap.toFixed(2)}. עד סוף החודש, או עד שמעלים לה את התקרה (config.capUsd), כל שאלה של לקוח בחנות הזו עוברת לבעלים בלי מודל.`, { everyMinutes: 24 * 60, storeId: store.id });
    return { by: 'store', cap, spent, customer: false };
  }
  if (global > 0 && all >= global) {
    await alertOperator(app, `cap:global:${month}`, 'תורן הגיע לתקרת ההוצאה החודשית על החנויות שלא של לקוחות', `הוצאה החודש: $${all.toFixed(2)} מתוך $${global.toFixed(2)} (TORAN_MONTHLY_CAP_USD), על לידים, דמו והתמיכה שלנו. עד סוף החודש הם מעבירים שאלות לבעלים בלי מודל. החנויות של הלקוחות ממשיכות לענות כרגיל.`, { everyMinutes: 24 * 60 });
    return { by: 'global', cap: global, spent: all, customer: false };
  }
  if (spent >= cap * 0.8) await alertOperator(app, `cap80:store:${store.id}:${month}`, `חנות ${store.id} ב-80% מתקרת ההוצאה`, `הוצאה החודש: $${spent.toFixed(2)} מתוך $${cap.toFixed(2)}.`, { everyMinutes: ONCE_A_MONTH, storeId: store.id });
  if (global > 0 && all >= global * 0.8) await alertOperator(app, `cap80:global:${month}`, 'תורן ב-80% מתקרת ההוצאה על החנויות שלא של לקוחות', `הוצאה החודש: $${all.toFixed(2)} מתוך $${global.toFixed(2)} (TORAN_MONTHLY_CAP_USD), על לידים, דמו והתמיכה שלנו.`, { everyMinutes: ONCE_A_MONTH });
  return null;
}

/** After a turn that cost something: a store spending more than the hourly line in one hour is told to the operator. */
export async function watchHour(app: App, storeId: number) {
  const line = Number(app.env.TORAN_STORE_HOUR_ALERT_USD) || HOUR_ALERT_USD;
  const r = await app.db.one<{ usd: number }>("SELECT COALESCE(SUM(usd), 0)::float AS usd FROM usage WHERE store_id = $1 AND at > now() - interval '1 hour'", [storeId]);
  const usd = Number(r?.usd) || 0;
  if (usd > line) await alertOperator(app, `hour:${storeId}`, `חנות ${storeId} הוציאה $${usd.toFixed(2)} בשעה האחרונה`, `זה יותר מ-$${line} בשעה (TORAN_STORE_HOUR_ALERT_USD). כדאי לבדוק בתיבה של החנות אם יש הצפה של הודעות או שני בוטים שעונים זה לזה.`, { storeId });
}
