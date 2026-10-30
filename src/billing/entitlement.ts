import type { Db } from '../db/index.ts';
import { J } from '../db/index.ts';
import { markServiceResumed, markServiceStopped } from '../jobs/retention.ts';

// Whether a workspace has paid for Toran: openfrequency-accounts owns subscriptions, Toran asks (Teder's
// src/billing/entitlement.js, ported).
//
//   GET {OF_ACCOUNTS_INTERNAL}/internal/entitlement?workspace=<id>&product=toran, bearer OF_INTERNAL_TOKEN
//   -> { workspace, product: "toran", enabled, access: paid | comp | due | unpaid | cancelled | off, allowed, paidThrough, cancelAt,
//        graceUntil } (test/fixtures/contracts/entitlement.json, accounts' contract)
//
// `allowed` is the only thing acted on. The answer is kept in the settings table (entitlement:<workspace>), so the
// dashboard and the answer path read the same one and a restart keeps it:
//
//   - an answer under FRESH_MS (5 minutes) old is used as it is, nothing is asked
//   - 404 no_workspace (an id accounts never had) is an answer: not allowed. A deleted workspace is a 200, access off.
//   - when accounts cannot answer (down, a timeout, a 5xx, a 401, a shape that is not the contract's), the last answer
//     it gave stands for up to STALE_MS (24 hours): a paying store is never stopped by a hiccup. Asked again after
//     RETRY_MS.
//   - a workspace accounts never answered for, or whose last answer is older than that, is not allowed. Fail closed.
//
// What stops (the audit's PRA-SEC-002 and PRA-BE-007): a customer's dashboard shows the pay page instead (web/server.ts;
// the operator and the operator viewing as the customer are never asked about); a customer's message on the store's own
// channels gets no model call and goes to the owner (agent/loop.ts); no automatic message is sent (auto/send.ts). The
// store's knowledge, chats and settings stay as they are. A store in no workspace (the operator's own, a lead, our
// support store) is never asked about.

export const PRODUCT = 'toran';
export const FRESH_MS = 5 * 60_000;
export const STALE_MS = 24 * 3_600_000;
export const RETRY_MS = 60_000;
/**
 * The access values accounts' contract lists. `due` (the 14 days of grace after a paid period, still allowed) came on
 * 2026-10-29. Only `allowed` is acted on, so a value not in this list is still an answer: refusing it as malformed would
 * read accounts as down and stop a paying store after STALE_MS.
 */
export const ACCESS = ['paid', 'comp', 'due', 'unpaid', 'cancelled', 'off'];
const MIN_TOKEN = 32;

type Env = Record<string, string | undefined>;
type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
export type Kept = { allowed: boolean; access: string | null; paidThrough: string | null; cancelAt: string | null; graceUntil?: string | null; checkedAt: string };
export type View = { workspace: number; allowed: boolean; known: boolean; access: string | null; paidThrough: string | null; cancelAt: string | null; checkedAt: string | null; source: 'fresh' | 'cache' | 'stale' | 'unknown' };

const keyOf = (workspaceId: number) => `entitlement:${workspaceId}`;

/** The last answer accounts gave for a workspace, as kept, or null. */
export async function lastKnown(db: Db, workspaceId: number): Promise<Kept | null> {
  return (await db.one<{ value: Kept }>('SELECT value FROM settings WHERE key = $1', [keyOf(workspaceId)]))?.value || null;
}

async function keep(db: Db, workspaceId: number, k: Kept) {
  await db.query('INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [keyOf(workspaceId), J(k)]);
}

/** A 200 is believed only in the shape the contract gives it, and for the workspace asked about. */
function wellFormed(b: any, workspaceId: number): boolean {
  if (!b || typeof b !== 'object') return false;
  if (b.workspace !== workspaceId || b.product !== PRODUCT || typeof b.allowed !== 'boolean') return false;
  if (b.access != null && typeof b.access !== 'string') return false;
  return true;
}

/** The client. `fetchImpl` and `clock` replace the network and the time for the tests. */
export function entitlementClient({ db, env = process.env, fetchImpl = fetch as FetchLike, clock = Date.now, timeoutMs = 2000, log = (_: string) => {} }: { db: Db; env?: Env; fetchImpl?: FetchLike; clock?: () => number; timeoutMs?: number; log?: (line: string) => void }) {
  const base = String(env.OF_ACCOUNTS_INTERNAL || 'http://127.0.0.1:4741').trim().replace(/\/+$/, '');
  const token = String(env.OF_INTERNAL_TOKEN || '').trim();
  const failedAt = new Map<number, number>();
  const asking = new Map<number, Promise<View>>();

  const view = (workspace: number, k: Kept | null, source: View['source'], t: number): View => {
    const fresh = Boolean(k && t - Date.parse(k.checkedAt) < STALE_MS);
    return { workspace, allowed: Boolean(fresh && k!.allowed === true), known: fresh, access: k?.access ?? null, paidThrough: k?.paidThrough ?? null, cancelAt: k?.cancelAt ?? null, checkedAt: k?.checkedAt ?? null, source: k ? source : 'unknown' };
  };

  async function ask(workspaceId: number): Promise<View> {
    const t = clock();
    const kept = await lastKnown(db, workspaceId);
    const stale = () => {
      failedAt.set(workspaceId, t);
      return view(workspaceId, kept, 'stale', t);
    };
    if (token.length < MIN_TOKEN) {
      log('[entitlement] OF_INTERNAL_TOKEN is not set (32 characters or more): no workspace is allowed');
      return stale();
    }
    let r: Response;
    try {
      r = await fetchImpl(`${base}/internal/entitlement?${new URLSearchParams({ workspace: String(workspaceId), product: PRODUCT })}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    } catch (e: any) {
      log(`[entitlement] accounts unreachable at ${base}: ${e?.name === 'TimeoutError' ? 'timed out' : e?.message}`);
      return stale();
    }
    let body: any = null;
    try {
      body = await r.json();
    } catch {
      /* not JSON: handled below */
    }
    let next: Kept | null = null;
    if (r.status === 200 && wellFormed(body, workspaceId)) next = { allowed: body.allowed, access: body.access ?? null, paidThrough: body.paidThrough ?? null, cancelAt: body.cancelAt ?? null, graceUntil: body.graceUntil ?? null, checkedAt: new Date(t).toISOString() };
    else if (r.status === 404 && body?.error === 'no_workspace') next = { allowed: false, access: 'off', paidThrough: null, cancelAt: null, checkedAt: new Date(t).toISOString() };
    if (!next) {
      log(`[entitlement] workspace ${workspaceId}: accounts answered ${r.status}${body?.error ? ` ${body.error}` : ''}, the last answer stands`);
      return stale();
    }
    failedAt.delete(workspaceId);
    await keep(db, workspaceId, next);
    await planAccess(db, workspaceId, next.allowed);
    return view(workspaceId, next, 'fresh', t);
  }

  return {
    /** May this workspace use Toran now? Asks accounts when the kept answer is over 5 minutes old (one question at a time per workspace). */
    async check(workspaceId: number): Promise<View> {
      const t = clock();
      const kept = await lastKnown(db, workspaceId);
      if (kept && t - Date.parse(kept.checkedAt) < FRESH_MS) return view(workspaceId, kept, 'cache', t);
      if (t - (failedAt.get(workspaceId) || -Infinity) < RETRY_MS) return view(workspaceId, kept, 'stale', t);
      const inFlight = asking.get(workspaceId);
      if (inFlight) return inFlight;
      const p = ask(workspaceId).finally(() => asking.delete(workspaceId));
      asking.set(workspaceId, p);
      return p;
    },
  };
}

/**
 * What accounts answered, for the 30-day clock on a stopped store's chats (the retention pass of the message path,
 * toran-path's src/jobs/retention.ts): each store of a workspace that is not allowed has its service stopped for 'plan',
 * each store of one that is allowed has it resumed. Called on every fresh answer.
 */
export async function planAccess(db: Db, workspaceId: number, allowed: boolean): Promise<number[]> {
  const ids = (await db.query<{ id: number }>('SELECT id FROM stores WHERE workspace_id = $1', [workspaceId])).map((r) => r.id);
  for (const id of ids) {
    if (allowed) await markServiceResumed(db, id, 'plan');
    else await markServiceStopped(db, id, 'plan');
  }
  return ids;
}

/**
 * Ask afresh about every workspace that has a store: a store nobody writes to is asked about nowhere else, and its
 * clock must still start when its workspace stops paying. The daily retention pass calls this before it deletes.
 */
export async function refreshWorkspaces(app: { db: Db; env: Env; log?: (line: string) => void }): Promise<number> {
  const rows = await app.db.query<{ ws: number }>('SELECT DISTINCT workspace_id AS ws FROM stores WHERE workspace_id IS NOT NULL');
  for (const r of rows) await entitlementOf(app).check(Number(r.ws));
  return rows.length;
}

// One client per database, so the dashboard and the answer path share its in-flight questions and its retry clock.
const clients = new WeakMap<Db, ReturnType<typeof entitlementClient>>();
export function entitlementOf(app: { db: Db; env: Env; log?: (line: string) => void }) {
  let c = clients.get(app.db);
  if (!c) {
    c = entitlementClient({ db: app.db, env: app.env, log: app.log });
    clients.set(app.db, c);
  }
  return c;
}

/** May this store's channels be answered and its automatic messages sent? A store in no workspace always may. */
export async function storeAllowed(app: { db: Db; env: Env; log?: (line: string) => void }, storeId: number): Promise<boolean> {
  const ws = (await app.db.one<{ workspace_id: number | null }>('SELECT workspace_id FROM stores WHERE id = $1', [storeId]))?.workspace_id ?? null;
  if (ws == null) return true;
  return (await entitlementOf(app).check(Number(ws))).allowed;
}
