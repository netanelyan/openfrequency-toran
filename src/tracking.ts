import type { Shipment } from './orders.ts';

// Where a package is, for get_order_status (agent/tools.ts), after the order matched its customer (the owner,
// 2026-11-09: "make the order tracking also work with 17track, or the website's own tracking", and then: "lets just
// track trough shopify. a store that has the tracking page gets that"). Two sources:
//
//   the store's order    what the platform already carries (orders.ts): the carrier, the tracking number, the
//                        store's tracking link, and on Shopify the carrier's shipment_status
//   the website's page   stores.tracking_page, set on the store's knowledge page (web/pages/orders.ts): the store's own
//                        tracking page, with {number} (the tracking number) or {order} (the order number) filled in
//
// The link Toran gives: the website's page when the store has one, else the store's tracking link. The status in
// words: the store's (the shipment's, else the order's). No outside tracking service is asked.

const str = (v: unknown) => (v == null ? '' : String(v).trim());

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

/** The link to give for one shipment: the website's page when the store has one, else the store's own link. */
export function linkFor(tpl: string | null | undefined, s: Shipment, order: string): string | null {
  return pageFor(tpl, s.number ? str(s.number) : null, order) || s.url || null;
}

/** One shipment as the tool tells it. */
export type Told = { status: string | null; company: string | null; number: string | null; link: string | null };

export function shipmentsTold(tpl: string | null | undefined, order: string, shipments: Shipment[]): Told[] {
  return shipments.slice(0, 5).map((s) => ({ status: s.status, company: s.company, number: s.number, link: linkFor(tpl, s, order) }));
}
