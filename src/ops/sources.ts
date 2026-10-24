import type { App } from '../app.ts';

// What the operator's dashboard reads from the other services on this machine (docs/operator.md):
//
//   accounts   GET /internal/ops/customers   the workspaces, their subscriptions and invoices (read at each load)
//   Teder      GET /internal/demos           the store demos and their opens (copied into teder_leads at each load,
//                                            so that Toran can keep their outreach)
//
// Both take OF_INTERNAL_TOKEN. A service that does not answer leaves its part of the dashboard saying so; the rest
// still works.

const MIN_TOKEN = 32;

export type Subscription = { product: string; monthly: number; vat: 'excluded' | 'included'; setup: number; startedOn: string | null; paidUntil: string | null; endsOn: string | null; state: 'paid' | 'waiting' | 'late' | 'ending' | 'ended'; nextChargeOn: string | null };
export type Customer = { id: number; slug: string; name: string; disabled: boolean; createdAt: string; products: string[]; people: number; invitesWaiting: number; lastLoginAt: string | null; subscriptions: Subscription[]; invoices: { count: number; lastIssuedOn: string | null } };
export type Demo = { id: number | string; domain: string; url: string | null; name: string | null; status: string; whatsapp: string | null; pageUrl: string | null; createdAt: string | null; readyAt: string | null; approvedAt: string | null; removedAt: string | null; error: string | null; opens: number; visitors: number; lastOpenAt: string | null };

async function get(app: App, base: string, path: string): Promise<any | null> {
  const token = String(app.env.OF_INTERNAL_TOKEN || '').trim();
  if (token.length < MIN_TOKEN) return null;
  try {
    const r = await fetch(`${base.replace(/\/+$/, '')}${path}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(3000) });
    if (!r.ok) {
      app.log(`[ops] ${base}${path}: ${r.status}`);
      return null;
    }
    return await r.json();
  } catch (e: any) {
    app.log(`[ops] ${base}${path}: ${e?.name === 'TimeoutError' ? 'timed out' : e?.message}`);
    return null;
  }
}

/** Every customer workspace, from accounts; null when accounts did not answer. */
export async function customers(app: App): Promise<{ today: string; workspaces: Customer[] } | null> {
  const b = await get(app, String(app.env.OF_ACCOUNTS_INTERNAL || 'http://127.0.0.1:4741'), '/internal/ops/customers');
  if (!b || !Array.isArray(b.workspaces)) return null;
  return { today: String(b.today || ''), workspaces: b.workspaces.filter((w: any) => Number.isInteger(w?.id) && Array.isArray(w.subscriptions)) };
}

const iso = (v: unknown) => (v && !Number.isNaN(Date.parse(String(v))) ? new Date(String(v)).toISOString() : null);

/** Teder's store demos, copied into teder_leads (Teder's columns only); false when Teder did not answer. */
export async function syncTeder(app: App): Promise<boolean> {
  const b = await get(app, String(app.env.TEDER_SITE_INTERNAL || 'http://127.0.0.1:4700'), '/internal/demos');
  if (!b || !Array.isArray(b.demos)) return false;
  for (const d of b.demos as Demo[]) {
    if (d?.id == null || typeof d.domain !== 'string') continue;
    await app.db.query(
      `INSERT INTO teder_leads (id, domain, url, name, whatsapp, status, page_url, created_at, ready_at, approved_at, removed_at, opens, visitors, last_open_at, synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, now())
       ON CONFLICT (id) DO UPDATE SET domain = EXCLUDED.domain, url = EXCLUDED.url, name = EXCLUDED.name, whatsapp = EXCLUDED.whatsapp, status = EXCLUDED.status,
         page_url = EXCLUDED.page_url, created_at = EXCLUDED.created_at, ready_at = EXCLUDED.ready_at, approved_at = EXCLUDED.approved_at, removed_at = EXCLUDED.removed_at,
         opens = EXCLUDED.opens, visitors = EXCLUDED.visitors, last_open_at = EXCLUDED.last_open_at, synced_at = now()`,
      [String(d.id), d.domain, d.url ?? null, d.name ?? null, d.whatsapp ? String(d.whatsapp).replace(/\D/g, '') : null, String(d.status || ''), d.pageUrl ?? null, iso(d.createdAt), iso(d.readyAt), iso(d.approvedAt), iso(d.removedAt), Number(d.opens) || 0, Number(d.visitors) || 0, iso(d.lastOpenAt)],
    );
  }
  return true;
}
