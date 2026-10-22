import type { App } from '../app.ts';
import { event } from '../db/log.ts';

// What happens on a pitch page, for the funnel: opens, how far down it was read, taps
// on the demo button, and taps on "take this page down" (which only flags the store for
// the owner: the page comes down when the request is confirmed in the dashboard). The demo itself starting is the WhatsApp router's (the code
// arriving binds the phone). Nothing about the reader is kept but an anonymous visitor
// id in a first-party cookie, and the owner's own visits (a dashboard session, or the
// dashboard's preview) are not counted.
//
// The first open moves a lead that was sent to "opened".

export async function recordOpen(app: App, storeId: number, visitor: string) {
  await event(app.db, storeId, 'page_open', {}, visitor);
  await app.db.query("UPDATE stores SET opened_at = COALESCE(opened_at, now()), status = CASE WHEN status = 'sent' THEN 'opened' ELSE status END, updated_at = now() WHERE id = $1", [storeId]);
}

export async function recordBeacon(app: App, slug: string, kind: string, depth: number | null, visitor: string | null): Promise<boolean> {
  if (!['scroll', 'demo_click', 'takedown_click'].includes(kind)) return false;
  // Only a page that is open to the public can be read, so only its beacons count.
  const s = await app.db.one<{ id: number }>("SELECT id FROM stores WHERE slug = $1 AND approved_at IS NOT NULL AND taken_down_at IS NULL AND status <> 'skipped'", [slug]);
  if (!s) return false;
  if (kind === 'scroll' && ![25, 50, 75, 100].includes(Number(depth))) return false;
  await event(app.db, s.id, kind, kind === 'scroll' ? { depth: Number(depth) } : {}, visitor);
  if (kind === 'takedown_click') await app.db.query('UPDATE stores SET takedown_asked_at = COALESCE(takedown_asked_at, now()), updated_at = now() WHERE id = $1', [s.id]);
  return true;
}

/** The page's numbers for the dashboard: opens, distinct visitors, the deepest scroll, demo taps. */
export async function pageStats(app: App, storeId: number) {
  return app.db.one<{ opens: number; visitors: number; depth: number; clicks: number; last: string | null }>(
    `SELECT COUNT(*) FILTER (WHERE kind = 'page_open')::int AS opens,
            COUNT(DISTINCT visitor) FILTER (WHERE kind = 'page_open')::int AS visitors,
            COALESCE(MAX((data->>'depth')::int) FILTER (WHERE kind = 'scroll'), 0)::int AS depth,
            COUNT(*) FILTER (WHERE kind = 'demo_click')::int AS clicks,
            MAX(at) FILTER (WHERE kind = 'page_open') AS last
     FROM events WHERE store_id = $1`,
    [storeId],
  );
}
