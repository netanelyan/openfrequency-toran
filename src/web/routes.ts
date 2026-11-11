import type { App } from '../app.ts';
import type { DashReq, Route } from './server.ts';
import { brandPage } from './pages/brand.ts';
import { homeRoutes } from './pages/home.ts';
import { leadRoutes } from './pages/leads.ts';
import { reviewRoutes } from './pages/review.ts';
import { assistantRoutes } from './pages/assistant.ts';
import { storeColor } from '../ingest/brand.ts';
import { selling, storeIdIn, storesOf, type Scope } from './workspace.ts';
import { messagingSql } from '../channels/config.ts';
import { counted, planOf, usageOf } from '../plans.ts';
import { WAITING_SQL } from './inbox.ts';
import { customerRoutes } from './pages/customer.ts';
import { whatsappRoutes } from './pages/whatsapp.ts';
import { socialRoutes } from './pages/social.ts';
import { mailDomainRoutes } from './pages/mailDomain.ts';
import { ordersRoutes } from './pages/orders.ts';
import { autoRoutes } from './pages/auto.ts';
import { webChatRoutes } from './pages/webchat.ts';
import { voiceRoutes } from './pages/voice.ts';
import { channelOffRoutes } from './pages/channelOff.ts';
import { mailSetupRoutes } from './pages/mailSetup.ts';
import { startRoutes } from './pages/start.ts';
import { queueRoutes } from './pages/queue.ts';
import { resultsRoutes } from './pages/results.ts';
import { latestNotification, subscribe, unsubscribe, vapid } from '../owners/push.ts';

// The dashboard's routes: GET pages and POST actions, all behind the session, in one table. Every list reads through
// the session's scope (workspace.ts); a route about one store, chat or job is checked in server.ts before it runs.

/** The header's counts. `look`: the operator on a customer's screens (server.ts), counted as a customer over every customer's store. */
export async function headerCounts(app: App, sc: Scope, { look = false }: { look?: boolean } = {}) {
  const r = await app.db.one<{ review: number; followups: number; chats: number }>(
    `SELECT
       (SELECT COUNT(*)::int FROM stores WHERE status = 'page_ready' AND approved_at IS NULL AND ${storesOf(sc)} AND ${selling()}) AS review,
       (SELECT COUNT(*)::int FROM stores WHERE followup_due_at <= now() AND followup_sent_at IS NULL AND status IN ('sent','opened') AND ${storesOf(sc)} AND ${selling()}) AS followups,
       (SELECT COUNT(*)::int FROM conversations c WHERE ${messagingSql('c.channel')} AND c.handoffs > 0 AND c.last_at > now() - interval '3 days' AND ${storeIdIn(sc, 'c.store_id')}) AS chats`,
  );
  if (sc.operator && !look) {
    // The ring is TORAN_MONTHLY_CAP_USD's, and counts what it counts (agent/spend.ts, 2026-11-11): this Israel month's
    // usage of the stores no customer pays for (leads, demos, our support) and of none, a claude-cli call at its API
    // price. A customer's store is held to what its workspace pays instead, on the store's page.
    const u = await app.db.one<{ usd: number }>(
      `SELECT COALESCE(SUM(CASE WHEN u.backend = 'claude-cli' THEN u.api_usd ELSE u.usd END), 0)::float AS usd FROM usage u
        WHERE u.at >= (date_trunc('month', now() AT TIME ZONE 'Asia/Jerusalem') AT TIME ZONE 'Asia/Jerusalem')
          AND NOT EXISTS (SELECT 1 FROM stores s WHERE s.id = u.store_id AND s.workspace_id IS NOT NULL)`,
    );
    const cap = Number(app.env.TORAN_MONTHLY_CAP_USD) || 0;
    return { waiting: { review: r?.review || 0, followups: r?.followups || 0, chats: r?.chats || 0 }, spend: { usd: Number(u?.usd) || 0, cap }, plan: null };
  }
  // A customer: the conversations waiting for them, and this month's conversations against their stores' plans. The
  // operator's `look`: every customer's store, never the leads (pages/customer.ts myStores).
  const theirs = sc.operator ? ' AND workspace_id IS NOT NULL' : '';
  const w = await app.db.one<{ n: number }>(`SELECT COUNT(*)::int AS n FROM conversations c WHERE ${messagingSql('c.channel')} AND c.store_id IN (SELECT id FROM stores WHERE ${storesOf(sc)}${theirs}) AND ${WAITING_SQL}`);
  const stores = await app.db.query<{ id: number; config: any; name: string | null; domain: string; brand: any }>(`SELECT id, config, name, domain, brand FROM stores WHERE ${storesOf(sc)}${theirs} ORDER BY id`);
  const n = await counted(app.db, stores.map((s) => s.id), { months: 1 });
  const usage = stores.map((s) => usageOf(planOf(s.config), n.get(s.id)));
  const plan = usage.length ? { used: usage.reduce((a, u) => a + u.thisMonth, 0), cap: usage.reduce((a, u) => a + u.cap, 0) } : null;
  // The store the pages are about, in the header where Teder shows the account (docs/design-pro.md, "The two desks side by
  // side"): its name, its address and its colour. A workspace's first; most have one.
  const first = stores[0];
  const store = first ? { id: first.id, name: String(first.brand?.name || first.name || first.domain), domain: first.domain, more: stores.length - 1 } : null;
  return { waiting: { chats: w?.n || 0 }, spend: { usd: 0, cap: 0 }, plan, store };
}

/** stores.css: each store's own colour as --store, so pages need no inline style (the CSP forbids it). */
export async function storesCss(app: App, sc: Scope): Promise<string> {
  const rows = await app.db.query<{ id: number; brand: any; brand_override: any }>(`SELECT id, brand, brand_override FROM stores WHERE ${storesOf(sc)}`);
  return rows.map((r) => `.st-${r.id}{--store:${storeColor({ ...r.brand, ...r.brand_override })}}`).join('\n');
}

export function dashboardRoutes(app: App): Route<DashReq>[] {
  return [
    // The waiting count, for the open page to keep its badge and title live (TORAN-READINESS.md P1-13, static/app.js):
    // the same number as the header's, from the session's own scope.
    ['GET', /^\/waiting\.json$/, async (r) => ({ json: { chats: r.ctx.waiting?.chats ?? 0 }, headers: { 'cache-control': 'no-store' } })],
    // The owner's browser notifications (owners/push.ts, TORAN-READINESS.md P1-11): the key a browser subscribes with,
    // its subscription in the session's workspace (never view-as), and the newest notification for the service worker.
    ['GET', /^\/push\/key$/, async () => ({ json: { key: (await vapid(app.db)).publicKey }, headers: { 'cache-control': 'no-store' } })],
    ['POST', /^\/push\/subscribe$/, async (r) => {
      if (r.ctx.readOnly) return { status: 403, json: { ok: false, message: 'במצב צפייה אי אפשר להפעיל התראות.' } };
      const done = await subscribe(app.db, String(r.form.endpoint || ''), { userId: r.user.id, workspaceId: r.scope.workspaceId });
      return 'problem' in done ? { status: 400, json: { ok: false, message: 'הדפדפן הזה לא מאפשר התראות.' } } : { json: { ok: true, message: 'ההתראות פועלות בדפדפן הזה.' } };
    }],
    ['POST', /^\/push\/unsubscribe$/, async (r) => {
      await unsubscribe(app.db, String(r.form.endpoint || ''), r.scope.workspaceId);
      return { json: { ok: true, message: 'ההתראות כבויות בדפדפן הזה.' } };
    }],
    ['GET', /^\/notifications\/latest\.json$/, async (r) => ({ json: await latestNotification(app.db, r.scope.workspaceId), headers: { 'cache-control': 'no-store' } })],
    ...customerRoutes(app),
    ...resultsRoutes(app),
    ...startRoutes(app),
    ...whatsappRoutes(app),
    ...socialRoutes(app),
    ...mailDomainRoutes(app),
    ...ordersRoutes(app),
    ...autoRoutes(app),
    ...webChatRoutes(app),
    ...voiceRoutes(app),
    ...channelOffRoutes(app),
    ...mailSetupRoutes(app),
    ...homeRoutes(app),
    ...leadRoutes(app),
    ...reviewRoutes(app),
    ...assistantRoutes(app),
    ...queueRoutes(app),
    ['GET', /^\/brand$/, (r) => ({ html: brandPage(r.ctx) })],
    ['GET', /^\/jobs\/(\d+)\.json$/, async (_r, m) => ({ json: (await app.db.one('SELECT id, kind, status, progress, last_error, result FROM jobs WHERE id = $1', [Number(m[1])])) || { status: 'missing' } })],
  ];
}
