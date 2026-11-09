import type { Db } from './db/index.ts';
import { J } from './db/index.ts';
import type { Shipment } from './orders.ts';

// Where a package is, for get_order_status (agent/tools.ts), after the order matched its customer (the owner,
// 2026-11-09: "make the order tracking also work with 17track, or the website's own tracking"). Three sources, and
// what each one adds:
//
//   the store's order    what the platform already carries (orders.ts): the carrier, the tracking number, the
//                        store's tracking link, and on Shopify the carrier's shipment_status
//   the website's page   stores.tracking_page, set on the store's knowledge page (web/pages/orders.ts): the store's own
//                        tracking page, with {number} (the tracking number) or {order} (the order number) filled in
//   17track              with TORAN_17TRACK_KEY on the server: the latest status and last event of the tracking number,
//                        from the 17track Tracking API, so Toran can say "where is my package" in words
//
// The link Toran gives, the first that is there: the website's page, the store's tracking link, a 17track link for
// the number. The status in words: 17track's when it has one, else the store's (the shipment's, else the order's).
//
// 17track, as its docs say (api.17track.net/en/doc, read 2026-11-09; docs/tracking.md has the whole list):
//   POST https://api.17track.net/track/v2.4/register and /gettrackinfo, header 17token: <key>, a JSON array of
//   {number} (carrier optional: "the tracking numbers of most UPU and commercial carriers can be auto-identified"),
//   at most 40 numbers a call, 3 requests a second. The answer is {code: 0, data: {accepted: [...], rejected: [...]}};
//   a rejected number has error.code: -18019901 already registered, -18019902 not registered yet, -18019903 carrier not
//   detected, -18019907 daily limit, -18019908 quota ran out, -18019909 no tracking info at the moment, -18010012
//   format invalid. A number must be registered before gettrackinfo, and registering one costs one of the account's
//   quota ("each tracking number counts as one shipment, no duplicate charges during the automatic tracking period");
//   a new account gets 200 numbers once (since 2026-01-07), so a number is registered only when a customer asks about
//   it, never in bulk. Results come "within seconds after the tracking number is registered (sometime it may go over 5
//   minutes)". accepted[].track_info.latest_status {status, sub_status}, latest_event {time_iso, time_utc,
//   description, location, address {country, state, city}}. No lang is sent: a translation costs quota, and Toran
//   says the carrier's words in Hebrew itself.
//
// Each answer is kept per number in tracking_cache (migration 072): FRESH (45 minutes) when 17track had a status,
// PENDING (5 minutes) while it has none yet, REFUSED (6 hours) when it will not take the number (its format, a carrier
// it cannot detect, the quota), so a customer asking again does not spend another call. Every call has TIMEOUT (4
// seconds), and nothing here throws: 17track down, slow or refusing is a reply with the link and the store's status.
//
// A wrong key is HTTP 401 ("incorrect security key, IP not in the whitelist, or account disabled"; codes -18010002 and
// -18010001), 429 is over 3 a second. UNVERIFIED: the body of a 401 (the docs show none); any answer that is not code 0
// with data is treated as no status, and logged. The public link https://t.17track.net/en#nums=<number> is not in
// the API docs: it is what 17track's own tracking page reads (its script parses "nums" from the hash, comma-separated,
// and writes window.location.hash = "nums=..." itself, checked 2026-11-09); /he answers with the English page.

export const API_17TRACK = 'https://api.17track.net/track/v2.4';
const TIMEOUT = 4_000;
const FRESH = 45 * 60_000;
const PENDING = 5 * 60_000;
const REFUSED = 6 * 60 * 60_000;
/** 17track takes "a combination of 5 to 50 characters including letters, numbers, or dashes". */
const NUMBER = /^[A-Za-z0-9-]{5,50}$/;

export type TrackEvent = { text: string; place: string | null; at: string | null };
/** What 17track says of one number: its main status (NotFound, InTransit, Delivered...) and its last event. */
export type Track = { status: string; sub: string | null; event: TrackEvent | null; checked: string };

const str = (v: unknown) => (v == null ? '' : String(v).trim());
const line = (v: unknown, max = 160) => str(v).replace(/\s+/g, ' ').replace(/"/g, "'").slice(0, max);

/** A tracking number as 17track takes it, or null. */
export const trackNumber = (n: string | null | undefined) => {
  const s = str(n).replace(/\s+/g, '').toUpperCase();
  return NUMBER.test(s) ? s : null;
};

/** The public 17track page for a number, the last link when nothing else is there. */
export const link17 = (number: string) => `https://t.17track.net/en#nums=${encodeURIComponent(number)}`;

// ---- The website's own tracking page

export const PAGE_MAX = 300;

/**
 * The owner's tracking page as it is kept, or null for none; throws with the owner's Hebrew reason when it is not an
 * https address. {number} and {order} may stand anywhere in it.
 */
export function cleanTrackingPage(input: string): string | null {
  const s = str(input);
  if (!s) return null;
  if (s.length > PAGE_MAX) throw new TrackingPageError(`longer than ${PAGE_MAX}`, `הכתובת ארוכה מדי. אפשר עד ${PAGE_MAX} תווים.`);
  let u: URL;
  try {
    u = new URL(fill(s, 'RR000000000IL', '1042'));
  } catch {
    throw new TrackingPageError('not a URL', 'זו לא נראית כתובת של דף. מעתיקים אותה מהדפדפן, למשל https://my-store.co.il/track');
  }
  if (u.protocol !== 'https:') throw new TrackingPageError('not https', 'הכתובת צריכה להתחיל ב-https://');
  if (u.username || u.password || !u.hostname.includes('.') || /\s/.test(s)) throw new TrackingPageError('not a public address', 'זו לא נראית כתובת של דף באתר. מעתיקים אותה מהדפדפן, למשל https://my-store.co.il/track');
  return s;
}

export class TrackingPageError extends Error {
  he: string;
  constructor(message: string, he: string) {
    super(message);
    this.he = he;
  }
}

const fill = (tpl: string, number: string, order: string) => tpl.replace(/\{number\}/g, encodeURIComponent(number)).replace(/\{order\}/g, encodeURIComponent(order));

/** The page with this shipment's numbers in it; null when it needs a tracking number the shipment has none of. */
export function pageFor(tpl: string | null | undefined, number: string | null, order: string): string | null {
  if (!tpl) return null;
  if (tpl.includes('{number}') && !number) return null;
  return fill(tpl, number || '', order.replace(/^#/, ''));
}

/** The link to give for one shipment: the website's page, the store's own link, 17track's page, in that order. */
export function linkFor(tpl: string | null | undefined, s: Shipment, order: string): string | null {
  const n = trackNumber(s.number);
  return pageFor(tpl, s.number ? str(s.number) : null, order) || s.url || (n ? link17(n) : null);
}

// ---- 17track

type Row = { number: string; registered_at: string | null; status: string | null; sub_status: string | null; event: any; refused: string | null; checked_at: string };
type Ctx = { db: Db; env: Record<string, string | undefined>; api: typeof fetch; log?: (m: string) => void };

/** The main statuses (api.17track.net/en/doc, "Main Status"), as the tool tells them to the model. */
export const STATUS_17: Record<string, string> = {
  NotFound: 'the carrier has no information on it yet',
  InfoReceived: 'the carrier has the shipment details and is about to collect the package',
  InTransit: 'on its way',
  Expired: 'on its way for a long time and not delivered yet',
  AvailableForPickup: 'waiting at the pickup point',
  OutForDelivery: 'out for delivery',
  DeliveryFailure: 'a delivery was attempted and did not succeed',
  Delivered: 'delivered',
  Exception: 'a problem on the way (it may be coming back to the store, held at customs, or delayed)',
};

const STOP = new Set([-18010012, -18019903, -18019907, -18019908, -18019910, -18019911]);

async function post(c: Ctx, path: string, body: unknown): Promise<any> {
  const res = await c.api(`${API_17TRACK}/${path}`, {
    method: 'POST',
    headers: { '17token': c.env.TORAN_17TRACK_KEY!, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const data: any = await res.json().catch(() => null);
  if (!res.ok || data?.code !== 0 || !data?.data) throw new Error(`17track ${path} answered ${res.status}${data?.code != null ? ` (code ${data.code})` : ''}`);
  return data.data;
}

const errOf = (d: any, number: string) => {
  const r = (d?.rejected || []).find((x: any) => trackNumber(x?.number) === number);
  return r ? Number(r?.error?.code) || -1 : null;
};

function trackOf(info: any, at: string): Track | null {
  const status = str(info?.latest_status?.status);
  if (!status) return null;
  const e = info?.latest_event;
  const place = [str(e?.location), str(e?.address?.city), str(e?.address?.country)].find(Boolean) || null;
  return {
    status,
    sub: str(info?.latest_status?.sub_status) || null,
    event: e && str(e.description) ? { text: line(e.description), place: place ? line(place, 60) : null, at: str(e.time_utc || e.time_iso) || null } : null,
    checked: at,
  };
}

const keep = (db: Db, number: string, f: { registered?: boolean; track?: Track | null; refused?: string | null }) =>
  db.query(
    `INSERT INTO tracking_cache (number, registered_at, status, sub_status, event, refused, checked_at) VALUES ($1, CASE WHEN $2::boolean THEN now() END, $3, $4, $5::jsonb, $6, now())
     ON CONFLICT (number) DO UPDATE SET registered_at = CASE WHEN $2::boolean THEN COALESCE(tracking_cache.registered_at, now()) WHEN $7::boolean THEN NULL ELSE tracking_cache.registered_at END,
       status = EXCLUDED.status, sub_status = EXCLUDED.sub_status, event = EXCLUDED.event, refused = EXCLUDED.refused, checked_at = now()`,
    [number, Boolean(f.registered), f.track?.status || null, f.track?.sub || null, J(f.track?.event || null), f.refused || null, f.registered === false],
  );

const fromRow = (r: Row): Track | null => (r.status ? { status: r.status, sub: r.sub_status, event: r.event || null, checked: new Date(r.checked_at).toISOString() } : null);

/**
 * What 17track says of this tracking number now, or null: no key on the server, a number it does not take, nothing
 * yet, or 17track not answering in time. Never throws.
 */
export async function track17(c: Ctx, raw: string | null | undefined): Promise<Track | null> {
  if (!str(c.env.TORAN_17TRACK_KEY)) return null;
  const number = trackNumber(raw);
  if (!number) return null;
  try {
    const row = await c.db.one<Row>('SELECT number, registered_at, status, sub_status, event, refused, checked_at FROM tracking_cache WHERE number = $1', [number]);
    if (row) {
      const age = Date.now() - new Date(row.checked_at).getTime();
      if (row.refused && age < REFUSED) return null;
      if (row.status && row.status !== 'NotFound' && age < FRESH) return fromRow(row);
      if (!row.refused && age < PENDING) return fromRow(row);
    }
    let registered = Boolean(row?.registered_at);
    for (let round = 0; round < 2; round++) {
      if (!registered) {
        const d = await post(c, 'register', [{ number }]);
        const err = errOf(d, number);
        if (err != null && err !== -18019901) {
          if (STOP.has(err)) {
            await keep(c.db, number, { refused: String(err) });
            c.log?.(`[tracking] 17track would not register a number (${err})`);
            return null;
          }
          throw new Error(`17track register refused it (${err})`);
        }
        registered = true;
      }
      const d = await post(c, 'gettrackinfo', [{ number }]);
      const err = errOf(d, number);
      if (err === -18019902) {
        // Registered here, not there (stopped, deleted): once more from the register.
        registered = false;
        continue;
      }
      const hit = (d?.accepted || []).find((x: any) => trackNumber(x?.number) === number);
      const t = hit ? trackOf(hit.track_info, new Date().toISOString()) : null;
      await keep(c.db, number, { registered: true, track: t });
      return t;
    }
    await keep(c.db, number, { registered: false });
    return null;
  } catch (e: any) {
    c.log?.(`[tracking] 17track did not answer: ${String(e?.message || e).slice(0, 160)}`);
    return null;
  }
}

/** One shipment as the tool tells it, after 17track's word on it when there is a key. */
export type Told = { status: string | null; company: string | null; number: string | null; link: string | null; event: TrackEvent | null; from17: boolean };

export async function shipmentsTold(c: Ctx, tpl: string | null | undefined, order: string, shipments: Shipment[]): Promise<Told[]> {
  const first = shipments.slice(0, 5);
  const tracks = await Promise.all(first.map((s, i) => (i < 3 ? track17(c, s.number) : Promise.resolve(null))));
  return first.map((s, i) => {
    const t = tracks[i];
    const known = t && t.status !== 'NotFound' ? t : null;
    return {
      status: known ? STATUS_17[known.status] || `the carrier's status "${line(known.status, 40)}"` : s.status,
      company: s.company,
      number: s.number,
      link: linkFor(tpl, s, order),
      event: known?.event || null,
      from17: Boolean(known),
    };
  });
}
