import type { App } from '../app.ts';
import { storeCapUsd } from '../agent/spend.ts';
import { storeAllowed } from '../billing/entitlement.ts';
import { displayName } from '../ingest/brand.ts';
import { liveState, type LiveState } from '../golive.ts';
import { counted, monthOf, planOf, usageOf, type PlanKey } from '../plans.ts';
import { WAITING_SQL } from '../web/inbox.ts';

// One row a customer's store, for the operator (TORAN-READINESS.md P1-26), as Teder's /all has one a workspace: paid,
// switched on, its channels and their state, the month's conversations against its plan, customers waiting more than a
// day, the month's model spend against its cap, and the last alert about it. Part of GET /internal/ops (ops/api.ts),
// shown on accounts' /admin.

export type HealthRow = {
  storeId: number;
  name: string;
  workspace: number;
  paid: boolean;
  live: LiveState;
  channels: { channel: string; kind: string; status: string }[];
  plan: PlanKey;
  conversations: number;
  cap: number;
  waitingOverDay: number;
  spendUsd: number;
  capUsd: number;
  lastAlert: { at: string; title: string } | null;
};

export async function customerHealth(app: App): Promise<HealthRow[]> {
  const { db } = app;
  const stores = await db.query<any>(`SELECT id, name, domain, brand, brand_override, config, workspace_id, agent_live_at, agent_paused_at FROM stores
    WHERE workspace_id IS NOT NULL AND platform <> 'company' AND taken_down_at IS NULL ORDER BY workspace_id, id`);
  if (!stores.length) return [];
  const ids = stores.map((s) => Number(s.id));
  const month = monthOf();
  const counts = await counted(db, ids, { months: 1 });
  const channels = await db.query<{ store_id: number; channel: string; kind: string; status: string }>('SELECT store_id, channel, kind, status FROM channel_accounts WHERE store_id = ANY($1::int[]) AND status <> $2 ORDER BY id', [ids, 'off']);
  const waiting = await db.query<{ store_id: number; n: number }>(`SELECT c.store_id, COUNT(*)::int AS n FROM conversations c WHERE c.store_id = ANY($1::int[]) AND c.account_id IS NOT NULL AND c.last_at < now() - interval '1 day' AND ${WAITING_SQL} GROUP BY c.store_id`, [ids]);
  const spend = await db.query<{ store_id: number; usd: number }>("SELECT store_id, COALESCE(SUM(api_usd), 0)::float AS usd FROM usage WHERE store_id = ANY($1::int[]) AND kind = 'llm' AND at >= date_trunc('month', now() AT TIME ZONE 'Asia/Jerusalem') AT TIME ZONE 'Asia/Jerusalem' GROUP BY store_id", [ids]);
  const alerts = await db.query<{ store_id: number; at: string; title: string }>("SELECT DISTINCT ON (store_id) store_id, at, data->>'title' AS title FROM events WHERE kind = 'operator_alert' AND store_id = ANY($1::int[]) ORDER BY store_id, at DESC", [ids]);
  const by = <T extends { store_id: number }>(rows: T[]) => new Map(rows.map((r) => [Number(r.store_id), r]));
  const w = by(waiting);
  const sp = by(spend);
  const al = by(alerts);
  const rows: HealthRow[] = [];
  for (const s of stores) {
    const plan = planOf(s.config);
    const u = usageOf(plan, counts.get(Number(s.id)));
    const a = al.get(Number(s.id));
    rows.push({
      storeId: Number(s.id),
      name: displayName(s.brand_override?.name, s.brand?.name, s.name) || s.domain,
      workspace: Number(s.workspace_id),
      paid: await storeAllowed(app, Number(s.id)).catch(() => false),
      live: liveState(s),
      channels: channels.filter((c) => Number(c.store_id) === Number(s.id)).map(({ channel, kind, status }) => ({ channel, kind, status })),
      plan,
      conversations: u.month === month ? u.thisMonth : 0,
      cap: u.cap,
      waitingOverDay: w.get(Number(s.id))?.n || 0,
      spendUsd: Math.round((sp.get(Number(s.id))?.usd || 0) * 100) / 100,
      capUsd: storeCapUsd(app.env, s.config),
      lastAlert: a ? { at: new Date(a.at).toISOString(), title: a.title } : null,
    });
  }
  return rows;
}
