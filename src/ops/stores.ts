import type { App } from '../app.ts';
import type { Out, Req, Route } from '../web/server.ts';
import { displayName } from '../ingest/brand.ts';
import { internalRefusal } from './internal.ts';

// The stores Toran found, for Teder's operator page of leads, which reads them here and keeps its own outreach on
// them (docs/operator.md section 4, docs/decisions.md 2026-11-05):
//
//   GET /internal/stores?since=<ISO moment, optional>&limit=<1-500, default 200>
//
// From this machine only, with OF_INTERNAL_TOKEN and no X-Forwarded-For, like /internal/ops (internal.ts
// internalRefusal: 503 not_configured, 403 forbidden, 401 bad_token); then 400 bad_since or bad_limit.
//
// Every qualified store (score 55 or more and nothing that rejects it, leads/score.ts) whose fields here changed after
// `since`, in the order they changed (stores.changed_at, which the database keeps on every write: migration 046), the
// oldest first. `next` is the last row's updatedAt when the page is full, else null: the caller asks again with
// since=next, as it is (it has microseconds). The rows that changed at the very moment of the page's last row all come
// in that page, a little over `limit` if need be, so that none falls between two pages.
//
// optedOut is true when anything in Toran says not to write to the store (Teder drops it):
//   takedown_asked_at   its owner asked to take its pitch page down, from the page's footer or in a message from it
//                       (channels/demo.ts pageMessage); a takedown request is an opt-out (migration 002)
//   taken_down_at       the operator took the page down (web/pages/leads.ts), which also skips the store
//   status 'skipped'    the operator skipped it: "not a fit, or asked not to be contacted" (migration 001); discovery
//                       never brings it back
//   lost_at             "לא מעוניינים" on the dashboard, with any reason (ops/actions.ts markLost: "לא נכתוב להם
//                       יותר"). A "לא" to the first message (outreach.ts: 'אפשר לענות "לא" ולא נכתוב שוב') reaches the
//                       operator's own WhatsApp, and is recorded so; Toran reads no lead's "לא" by itself. "reopen"
//                       undoes it, and the store is no longer opted out
//   workspace_id        a customer's own store (web/workspace.ts), never a lead to write to (ops/queue.ts live)
// Read and left out, since they are about other messages and not a lead's word to us: mail_suppressed (bounces and
// complaints on the mail Toran sends for a store to that store's customers; Toran never mails a lead), the automatic
// messages' opt-outs (auto/consent.ts, a store's customers), "הפסק" to the payment reminders (pay_remind_stops) and the
// owner line's opt-out (owner_numbers), both a customer's; and followup_sent_at, the one reminder sent, which is not a
// no (toranStatus says where the outreach is).

export const STORES_LIMIT = 200;
export const STORES_MAX = 500;

export type FoundStore = {
  id: number;
  domain: string;
  url: string;
  name: string | null;
  platform: string | null;
  score: number | null;
  toranStatus: string;
  contact: { email: string | null; whatsapp: string | null; phone: string | null };
  social: { instagram: string | null; tiktok: string | null; facebook: string | null };
  optedOut: boolean;
  updatedAt: string;
};

/** An ISO moment as Teder sends it: a date, a time to the minute at least (6 decimals at most), and its zone. */
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:?\d{2})$/i;

/** The query's since, or null when it is not a moment; a "+02:00" whose plus became a space in the query string is mended. */
export function parseSince(raw: string): string | null {
  const s = raw.trim().replace(/ (\d{2}:?\d{2})$/, '+$1');
  return ISO.test(s) && !Number.isNaN(Date.parse(s)) ? s : null;
}

const OPTED_OUT = "(takedown_asked_at IS NOT NULL OR taken_down_at IS NOT NULL OR status = 'skipped' OR lost_at IS NOT NULL OR workspace_id IS NOT NULL)";
const https = (v: unknown) => (typeof v === 'string' && v.startsWith('https://') ? v : null);

export async function foundStores(app: App, { since = null, limit = STORES_LIMIT }: { since?: string | null; limit?: number } = {}): Promise<{ stores: FoundStore[]; next: string | null }> {
  const n = Math.max(1, Math.min(STORES_MAX, Math.floor(limit) || STORES_LIMIT));
  // $1 goes in as text and Postgres reads it as a moment: typed timestamptz, the postgres driver made it a Date first,
  // which threw on '-infinity' (every call without since answered 500 on the server, 2026-11-05) and would have cut
  // a since's microseconds to milliseconds, so a full page could come back again and again. PGlite passes text either way.
  const rows = await app.db.query<any>(
    `SELECT id, domain, url, name, brand->>'name' AS brand_name, brand_override->>'name' AS override_name, platform, score, status,
            contact_email, contact_whatsapp, contact_phone,
            signals->'social'->>'instagram' AS instagram, signals->'social'->>'tiktok' AS tiktok, signals->'social'->>'facebook' AS facebook,
            ${OPTED_OUT} AS opted_out, to_char(changed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS changed
       FROM stores
      WHERE qualified AND changed_at > $1::text::timestamptz
        AND changed_at <= COALESCE((SELECT changed_at FROM stores WHERE qualified AND changed_at > $1::text::timestamptz ORDER BY changed_at OFFSET $2::int - 1 LIMIT 1), 'infinity'::timestamptz)
      ORDER BY changed_at, id`,
    [since || '-infinity', n],
  );
  const stores = rows.map((r): FoundStore => ({
    id: Number(r.id),
    domain: r.domain,
    url: r.url,
    name: displayName(r.override_name, r.brand_name, r.name),
    platform: r.platform && r.platform !== 'unknown' ? r.platform : null,
    score: r.score == null ? null : Number(r.score),
    toranStatus: r.status,
    contact: { email: r.contact_email || null, whatsapp: r.contact_whatsapp || null, phone: r.contact_phone || null },
    social: { instagram: https(r.instagram), tiktok: https(r.tiktok), facebook: https(r.facebook) },
    optedOut: Boolean(r.opted_out),
    updatedAt: r.changed,
  }));
  return { stores, next: stores.length >= n ? stores[stores.length - 1].updatedAt : null };
}

export function storesRoutes(app: App): Route<Req>[] {
  return [
    ['GET', /^\/internal\/stores$/, async (r): Promise<Out> => {
      const no = internalRefusal(app, r);
      if (no) return no;
      const rawSince = r.url.searchParams.get('since') || '';
      const since = rawSince ? parseSince(rawSince) : null;
      if (rawSince && !since) return { status: 400, json: { error: 'bad_since' } };
      const rawLimit = r.url.searchParams.get('limit') || '';
      if (rawLimit && !/^\d{1,6}$/.test(rawLimit)) return { status: 400, json: { error: 'bad_limit' } };
      const limit = rawLimit ? Number(rawLimit) : STORES_LIMIT;
      if (limit < 1) return { status: 400, json: { error: 'bad_limit' } };
      return { json: await foundStores(app, { since, limit }), headers: { 'cache-control': 'no-store' } };
    }],
  ];
}
