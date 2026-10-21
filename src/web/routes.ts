import type { App } from '../app.ts';
import type { DashReq, Route } from './server.ts';
import { brandPage } from './pages/brand.ts';
import { storeColor } from '../ingest/brand.ts';

// The dashboard's routes: GET pages and POST actions, all behind the session.
// Every page module's routes are listed here, in one table.

export async function headerCounts(app: App) {
  const r = await app.db.one<{ review: number; followups: number; chats: number; usd: number; cap: number }>(
    `SELECT
       (SELECT COUNT(*)::int FROM stores WHERE status = 'page_ready' AND approved_at IS NULL) AS review,
       (SELECT COUNT(*)::int FROM stores WHERE followup_due_at <= now() AND followup_sent_at IS NULL AND status IN ('sent','opened')) AS followups,
       (SELECT COUNT(*)::int FROM conversations c WHERE c.channel = 'whatsapp' AND (c.handoffs > 0 OR c.misses > 0) AND c.last_at > now() - interval '3 days') AS chats,
       (SELECT COALESCE(SUM(usd), 0)::float FROM usage WHERE at >= date_trunc('month', now())) AS usd,
       0 AS cap`,
  );
  const cap = Number(app.env.TORAN_MONTHLY_CAP_USD) || 0;
  return { waiting: { review: r?.review || 0, followups: r?.followups || 0, chats: r?.chats || 0 }, spend: { usd: Number(r?.usd) || 0, cap } };
}

/** stores.css: each store's own colour as --store, so pages need no inline style (the CSP forbids it). */
export async function storesCss(app: App): Promise<string> {
  const rows = await app.db.query<{ id: number; brand: any; brand_override: any }>('SELECT id, brand, brand_override FROM stores');
  return rows.map((r) => `.st-${r.id}{--store:${storeColor({ ...r.brand, ...r.brand_override })}}`).join('\n');
}

export function dashboardRoutes(app: App): Route<DashReq>[] {
  return [
    ['GET', /^\/brand$/, (r) => ({ html: brandPage(r.ctx) })],
    ['GET', /^\/jobs\/(\d+)\.json$/, async (_r, m) => ({ json: (await app.db.one('SELECT id, kind, status, progress, last_error, result FROM jobs WHERE id = $1', [Number(m[1])])) || { status: 'missing' } })],
  ];
}
