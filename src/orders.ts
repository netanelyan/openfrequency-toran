import type { App } from './app.ts';
import { type Db, J } from './db/index.ts';
import { audit, event } from './db/log.ts';
import { open, seal, SecretError, secretsReady } from './core/secrets.ts';
import { canonicalDomain, toIntl } from './core/urls.ts';
import { shopMeta } from './ingest/shopify.ts';

// A store's own orders, read-only, for get_order_status (agent/tools.ts). The owner pastes a read-only key on the
// store's knowledge page (web/pages/customer.ts), and it is kept as the store's row of order_access, sealed with
// TORAN_SECRETS_KEY like a channel's token (core/secrets.ts):
//
//   shopify      the Client ID and Client secret of an app the owner made in Shopify's Dev Dashboard with read_orders
//                (since 2026; a token from them with the client credentials grant, shopifyToken), or an older custom
//                app's Admin API access token (shpat_); and the store's <name>.myshopify.com address (read from
//                /meta.json when the owner leaves it out);
//                GET /admin/api/<version>/orders.json?name=<number>&status=any
//   woocommerce  a REST API key with Read permission (its consumer key and secret);
//                GET /wp-json/wc/v3/orders/<number>, else ?search=<number> for a store that numbers its orders
//                itself (a sequential-numbers plugin)
//   wix          an API key with permission to read orders, and the site's id;
//                POST https://www.wixapis.com/ecom/v1/orders/search, then the order's fulfillments for tracking
//
// A key is tried once before it is kept, so a wrong key is refused on the page and not found later by a customer.
// A key the platform refuses later marks the row 'error', and the page says so.
//
// An order is told only to whoever shows they placed it: they write from the order's phone on the store's own WhatsApp
// (or from its email address on the store's email), and otherwise they are asked for the phone number the order was
// placed with and must give it (the owner, 2026-11-09). findOrder() returns what the platform says, and fromOrder() and
// phoneGiven() decide; the tool never says what did not match, whether the order exists, or what is on it.
//
// The APIs are called through app.api (fetch, or the tests' stand-in), never through the polite fetcher: these are
// the store's own keys on the store's own API, not a crawl.

export type Api = typeof fetch;
export const ORDER_PLATFORMS = ['shopify', 'woocommerce', 'wix'] as const;
export type OrderPlatform = (typeof ORDER_PLATFORMS)[number];
export const ordersPlatform = (p: string | null | undefined): p is OrderPlatform => (ORDER_PLATFORMS as readonly string[]).includes(String(p || ''));

export type Creds = { token?: string; shop?: string; clientId?: string; clientSecret?: string; key?: string; secret?: string; apiKey?: string; siteId?: string };
export type Shipment = { status: string | null; company: string | null; number: string | null; url: string | null };
/** One order as every platform's reader gives it: what may be told (number, date, status, shipments) and who may be told (emails, phones). */
export type Order = { number: string; placed: string | null; status: string; emails: string[]; phones: string[]; shipments: Shipment[] };

export class OrderApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** A key that cannot be connected, with the owner's Hebrew reason. */
export class OrderConnectError extends Error {
  he: string;
  constructor(message: string, he: string) {
    super(message);
    this.he = he;
  }
}

const SHOPIFY_VERSION = '2026-04'; // past its year, Shopify serves the oldest version it still supports
const WIX_API = 'https://www.wixapis.com';
const str = (v: unknown) => (v == null ? '' : String(v).trim());

type Method = 'GET' | 'POST' | 'DELETE';

async function call(api: Api, url: string, { method = 'GET', headers = {}, body, timeout = 15_000 }: { method?: Method; headers?: Record<string, string>; body?: unknown; timeout?: number } = {}): Promise<any> {
  const res = await api(url, {
    method,
    headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(timeout),
  });
  const data: any = await res.json().catch(() => null);
  if (!res.ok) throw new OrderApiError(`${new URL(url).host} answered ${res.status}${data?.message ? `: ${str(data.message).slice(0, 160)}` : ''}`, res.status);
  return data;
}

// ---- Shopify

// Since 2026-01-01 a store can't create a custom app in its admin (shopify.dev/changelog/posts/legacy-custom-apps-can-t-
// be-created-after-january-1-2026): the owner creates one in the Dev Dashboard, installs it on the store, and gives us
// its Client ID and Client secret. Toran exchanges them for an access token with the client credentials grant: POST
// https://<shop>/admin/oauth/access_token, form body grant_type=client_credentials, client_id, client_secret; the answer
// is {access_token, scope, expires_in: 86399}, 24 hours, with no scope sent (shopify.dev/docs/apps/build/
// authentication-authorization/client-credentials-grant). Kept in memory, asked again 5 minutes before it ends, and once
// more on a 401. A store with an old custom app keeps its shpat_ token, which does not expire.
const shopifyTokens = new Map<string, { token: string; until: number }>();
const tokenKey = (c: Creds) => `${c.shop}|${c.clientId}`;

/** The token for a call: the old app's own, or one from the client credentials grant. */
export async function shopifyToken(api: Api, c: Creds): Promise<string> {
  if (c.token) return c.token;
  if (!c.clientId || !c.clientSecret) throw new OrderApiError('no Shopify credentials', 401);
  const hit = shopifyTokens.get(tokenKey(c));
  if (hit && Date.now() < hit.until) return hit.token;
  const res = await api(`https://${c.shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: c.clientId, client_secret: c.clientSecret }).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  const data: any = await res.json().catch(() => null);
  if (!res.ok || !data?.access_token) {
    const said = str(data?.error_description || data?.errors || data?.error).slice(0, 160);
    throw new OrderApiError(`${c.shop} did not give a token for the app (${res.status}${said ? `: ${said}` : ''})`, res.ok ? 401 : res.status);
  }
  shopifyTokens.set(tokenKey(c), { token: String(data.access_token), until: Date.now() + Math.max(60, Number(data.expires_in) || 86399) * 1000 - 5 * 60_000 });
  return String(data.access_token);
}

/** One call to the store's Admin API with the owner's key (the automatic messages read checkouts and register webhooks with it too). */
export async function shopifyCall(api: Api, c: Creds, path: string, { method = 'GET', body }: { method?: Method; body?: unknown } = {}): Promise<any> {
  const url = `https://${c.shop}/admin/api/${SHOPIFY_VERSION}/${path}`;
  const once = async () => call(api, url, { method, headers: { 'x-shopify-access-token': await shopifyToken(api, c) }, body });
  try {
    return await once();
  } catch (e) {
    // A token from the grant that Shopify stopped taking (the app's secret rotated, the store reinstalled it): one new one.
    if (c.token || !(e instanceof OrderApiError) || e.status !== 401) throw e;
    shopifyTokens.delete(tokenKey(c));
    return once();
  }
}
const shopifyGet = (api: Api, c: Creds, path: string) => shopifyCall(api, c, path);
const SHOPIFY_FIELDS = 'id,name,order_number,email,contact_email,phone,created_at,cancelled_at,financial_status,fulfillment_status,customer,billing_address,shipping_address,fulfillments';

const SHOPIFY_PAID: Record<string, string> = { pending: 'waiting for payment', authorized: 'payment approved, not charged yet', partially_paid: 'partly paid', paid: 'paid', partially_refunded: 'paid, partly refunded', refunded: 'refunded', voided: 'payment cancelled' };
const SHOPIFY_SENT: Record<string, string> = { fulfilled: 'shipped', partial: 'partly shipped', restocked: 'returned to stock' };
const SHOPIFY_SHIPMENT: Record<string, string> = { label_printed: 'a shipping label is ready, not with the carrier yet', label_purchased: 'a shipping label is ready, not with the carrier yet', confirmed: 'registered with the carrier', in_transit: 'on its way', out_for_delivery: 'out for delivery', attempted_delivery: 'a delivery was attempted', ready_for_pickup: 'waiting at the pickup point', picked_up: 'picked up', delivered: 'delivered', failure: 'the delivery failed' };

export function shopifyOrder(o: any): Order {
  const cancelled = Boolean(o?.cancelled_at);
  const paid = SHOPIFY_PAID[str(o?.financial_status)] || null;
  const sent = SHOPIFY_SENT[str(o?.fulfillment_status)] || 'not shipped yet';
  const shipments: Shipment[] = (o?.fulfillments || []).filter((f: any) => f && !['cancelled', 'error', 'failure'].includes(str(f.status))).map((f: any) => ({
    status: SHOPIFY_SHIPMENT[str(f.shipment_status)] || null,
    company: str(f.tracking_company) || null,
    number: str(f.tracking_number || f.tracking_numbers?.[0]) || null,
    url: webLink(f.tracking_url || f.tracking_urls?.[0]),
  }));
  return {
    number: str(o?.name) || str(o?.order_number),
    placed: o?.created_at || null,
    status: cancelled ? `cancelled${paid === 'refunded' ? ', refunded' : ''}` : [paid, sent].filter(Boolean).join(', '),
    emails: [o?.email, o?.contact_email, o?.customer?.email].map(str).filter(Boolean),
    phones: [o?.phone, o?.customer?.phone, o?.billing_address?.phone, o?.shipping_address?.phone].map(str).filter(Boolean),
    shipments,
  };
}

const bare = (n: string) => n.replace(/^#/, '').replace(/\s+/g, '').toLowerCase();

async function shopifyFind(api: Api, c: Creds, number: string): Promise<Order | null> {
  // Shopify's name is "#1042" (or the store's own prefix and suffix); a customer writes "1042".
  for (const name of number.startsWith('#') ? [number] : [`#${number}`, number]) {
    const data = await shopifyGet(api, c, `orders.json?status=any&limit=5&name=${encodeURIComponent(name)}&fields=${SHOPIFY_FIELDS}`);
    const o = (data?.orders || []).find((x: any) => bare(str(x?.name)) === bare(number) || str(x?.order_number) === bare(number));
    if (o) return shopifyOrder(o);
  }
  return null;
}

// ---- WooCommerce

const WOO_STATUS: Record<string, string> = {
  pending: 'waiting for payment',
  processing: 'paid, being prepared, not shipped yet',
  'on-hold': 'on hold, waiting for the store to confirm the payment',
  completed: 'completed (the store marks an order completed when it is sent or handed over)',
  cancelled: 'cancelled',
  refunded: 'refunded',
  failed: 'the payment did not go through',
  'checkout-draft': 'not placed: the checkout was not finished',
};

/**
 * The tracking a WooCommerce order carries. WooCommerce Shipment Tracking (woocommerce.com/document/shipment-tracking)
 * and Advanced Shipment Tracking (docs.zorem.com: "the Shipping Tracking plugin stores the tracking information in the
 * order meta with the meta key _wc_shipment_tracking_items") keep a list there: tracking_provider (a provider the
 * store picked from the plugin's list) or custom_tracking_provider (one it typed), tracking_number, and
 * custom_tracking_link when the store typed a link. The link of a provider from the list is built by the plugin and is
 * not in the meta, so wooTrackingLinks asks the plugin's own REST route for it. formatted_tracking_provider,
 * formatted_tracking_link and tracking_link are read too, where a plugin version keeps them in the meta (UNVERIFIED in
 * the meta: documented only in the REST route's answer).
 */
export function wooShipments(o: any): Shipment[] {
  const tracking = (o?.meta_data || []).find((m: any) => m?.key === '_wc_shipment_tracking_items')?.value;
  return (Array.isArray(tracking) ? tracking : []).filter((t: any) => t && typeof t === 'object').map((t: any) => ({
    status: null,
    company: str(t.custom_tracking_provider || t.formatted_tracking_provider || t.tracking_provider) || null,
    number: str(t.tracking_number) || null,
    url: webLink(t.custom_tracking_link || t.formatted_tracking_link || t.tracking_link),
  }));
}

/** A link from the store's data, kept only when it is an http(s) address (never javascript: or a bare word). */
export const webLink = (v: unknown): string | null => {
  const s = str(v);
  if (!s) return null;
  try {
    return /^https?:$/.test(new URL(s).protocol) ? s : null;
  } catch {
    return null;
  }
};

export function wooOrder(o: any): Order {
  const status = str(o?.status);
  const shipments = wooShipments(o);
  return {
    number: str(o?.number) || str(o?.id),
    placed: o?.date_created_gmt ? `${o.date_created_gmt}Z` : o?.date_created || null,
    status: WOO_STATUS[status] || `the store's own status "${status}"`,
    emails: [o?.billing?.email].map(str).filter(Boolean),
    phones: [o?.billing?.phone, o?.shipping?.phone].map(str).filter(Boolean),
    shipments,
  };
}

/** One call to the store's REST API with the owner's key (the automatic messages read orders and register webhooks with it too). */
export async function wooCall(api: Api, origin: string, c: Creds, path: string, { method = 'GET', body, ns = 'wc/v3', timeout }: { method?: Method; body?: unknown; ns?: string; timeout?: number } = {}): Promise<any> {
  const url = `${origin}/wp-json/${ns}/${path}`;
  try {
    return await call(api, url, { method, headers: { authorization: `Basic ${Buffer.from(`${c.key}:${c.secret}`).toString('base64')}` }, body, timeout });
  } catch (e) {
    if (!(e instanceof OrderApiError && e.status === 401)) throw e;
    // Some hosts drop the Authorization header before WordPress sees it; WooCommerce then takes the key in the query,
    // over HTTPS only (origin is always https here).
    return call(api, `${url}${path.includes('?') ? '&' : '?'}consumer_key=${encodeURIComponent(c.key!)}&consumer_secret=${encodeURIComponent(c.secret!)}`, { method, body, timeout });
  }
}
const wooGet = (api: Api, origin: string, c: Creds, path: string) => wooCall(api, origin, c, path);

/**
 * The links the tracking plugin builds for a provider picked from its list: GET wc-shipment-tracking/v3/orders/<id>/
 * shipment-trackings answers [{tracking_id, tracking_provider, tracking_link, tracking_number, date_shipped}]
 * (docs.zorem.com, "Shipment Tracking API", the same route as WooCommerce Shipment Tracking's). Asked only when a number
 * on the order has no link, with a short timeout; a store without the route keeps its numbers without links.
 */
async function wooTrackingLinks(api: Api, origin: string, c: Creds, o: any, order: Order): Promise<Order> {
  if (!o?.id || !order.shipments.some((s) => s.number && !s.url)) return order;
  try {
    const list = await wooCall(api, origin, c, `orders/${encodeURIComponent(str(o.id))}/shipment-trackings`, { ns: 'wc-shipment-tracking/v3', timeout: 4_000 });
    const links = new Map<string, string>();
    for (const t of Array.isArray(list) ? list : []) {
      const link = webLink(t?.tracking_link);
      if (str(t?.tracking_number) && link) links.set(str(t.tracking_number), link);
    }
    return { ...order, shipments: order.shipments.map((s) => (s.url || !s.number || !links.has(s.number) ? s : { ...s, url: links.get(s.number)! })) };
  } catch {
    return order;
  }
}

async function wooFind(api: Api, origin: string, c: Creds, number: string): Promise<Order | null> {
  const n = bare(number);
  if (/^\d+$/.test(n)) {
    try {
      const o = await wooGet(api, origin, c, `orders/${n}`);
      if (o && str(o.number || o.id) === n) return wooTrackingLinks(api, origin, c, o, wooOrder(o));
    } catch (e) {
      if (!(e instanceof OrderApiError && e.status === 404)) throw e;
    }
  }
  const list = await wooGet(api, origin, c, `orders?search=${encodeURIComponent(n)}&per_page=10`);
  const o = (Array.isArray(list) ? list : []).find((x: any) => str(x?.number).toLowerCase() === n);
  return o ? wooTrackingLinks(api, origin, c, o, wooOrder(o)) : null;
}

// ---- Wix

export const wixPost = (api: Api, c: Creds, path: string, body: unknown) => call(api, `${WIX_API}${path}`, { method: 'POST', headers: { authorization: c.apiKey!, 'wix-site-id': c.siteId! }, body });

const WIX_PAID: Record<string, string> = { NOT_PAID: 'not paid yet', PENDING: 'payment pending', PENDING_MERCHANT: 'waiting for the store to confirm the payment', PARTIALLY_PAID: 'partly paid', PAID: 'paid', AUTHORIZED: 'payment approved, not charged yet', PARTIALLY_REFUNDED: 'paid, partly refunded', FULLY_REFUNDED: 'refunded', DECLINED: 'the payment was declined', CANCELED: 'payment cancelled', VOIDED: 'payment cancelled' };
const WIX_SENT: Record<string, string> = { NOT_FULFILLED: 'not shipped yet', PARTIALLY_FULFILLED: 'partly shipped', FULFILLED: 'shipped' };

export function wixOrder(o: any, fulfillments: any[] = []): Order {
  const status = str(o?.status);
  const paid = WIX_PAID[str(o?.paymentStatus)] || null;
  const sent = WIX_SENT[str(o?.fulfillmentStatus)] || null;
  return {
    number: str(o?.number),
    placed: o?.createdDate || null,
    status: status === 'CANCELED' ? 'cancelled' : status === 'INITIALIZED' ? 'not placed: the checkout was not finished' : [paid, sent].filter(Boolean).join(', ') || 'placed',
    emails: [o?.buyerInfo?.email, o?.billingInfo?.contactDetails?.email].map(str).filter(Boolean),
    phones: [o?.billingInfo?.contactDetails?.phone, o?.shippingInfo?.logistics?.shippingDestination?.contactDetails?.phone, o?.recipientInfo?.contactDetails?.phone].map(str).filter(Boolean),
    shipments: fulfillments.map((f: any) => f?.trackingInfo).filter(Boolean).map((t: any) => ({ status: null, company: str(t.shippingProvider) || null, number: str(t.trackingNumber) || null, url: webLink(t.trackingLink) })),
  };
}

async function wixFind(api: Api, c: Creds, number: string): Promise<Order | null> {
  const data = await wixPost(api, c, '/ecom/v1/orders/search', { search: { filter: { number: { $eq: bare(number) } }, cursorPaging: { limit: 1 } } });
  const o = (data?.orders || []).find((x: any) => bare(str(x?.number)) === bare(number));
  if (!o) return null;
  let fulfillments: any[] = [];
  try {
    const f = await wixPost(api, c, '/ecom/v1/fulfillments/list-by-ids', { orderIds: [o.id] });
    fulfillments = f?.ordersWithFulfillments?.find((x: any) => x?.orderId === o.id)?.fulfillments || [];
  } catch {
    // A key that may read orders but not their fulfillments: the order's own status still stands, with no tracking.
  }
  return wixOrder(o, fulfillments);
}

// ---- Who may be told

const emailKey = (s: string) => s.trim().toLowerCase();
/** A phone as its last nine digits, so 054-0000000, 972540000000 and +972 54 000 0000 are one number. */
const phoneKey = (s: string) => {
  const intl = toIntl(s);
  return intl ? intl.slice(-9) : '';
};

/** The emails and phone numbers in what the customer wrote, the latest last. */
export function contactsIn(texts: string[]): { emails: string[]; phones: string[] } {
  const all = texts.join('\n');
  const emails = [...all.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)].map((m) => emailKey(m[0]));
  const phones = [...all.matchAll(/\+?\d[\d\s-]{7,16}\d/g)].map((m) => phoneKey(m[0])).filter(Boolean);
  return { emails, phones };
}

/**
 * Whether the person asking writes from the order's own contact: its phone on the store's WhatsApp, or its email address
 * on the store's email (the owner, 2026-11-09: "a customer must write from the phone number the order was placed from").
 */
export function fromOrder(o: Order, from: { waPhone?: string | null; email?: string | null }): boolean {
  if (from.waPhone && o.phones.map(phoneKey).filter(Boolean).includes(phoneKey(from.waPhone))) return true;
  return Boolean(from.email && o.emails.map(emailKey).includes(emailKey(from.email)));
}

/**
 * Whether the person gave the order's phone number in their own words (the latest few only, so a message with a list of
 * numbers proves nothing): asked of whoever does not write from the order's own contact ("if it does not match, toran
 * should ask for the phone number to make sure its really the person"). An email address someone types proves nothing,
 * since anyone may know it.
 */
export function phoneGiven(o: Order, said: { phones: string[] }): boolean {
  const phones = new Set(o.phones.map(phoneKey).filter(Boolean));
  return said.phones.slice(-3).some((p) => phones.has(p));
}

/** Whether the person asking may be told this order: writing from its contact, or giving its phone. */
export const matches = (o: Order, said: { phones: string[] }, from: { waPhone?: string | null; email?: string | null } = {}) => fromOrder(o, from) || phoneGiven(o, said);

// ---- The store's row

export type AccessRow = { platform: OrderPlatform; status: string; meta: any; connected_at: string };

export const orderAccessOf = (db: Db, storeId: number) => db.one<AccessRow>('SELECT platform, status, meta, connected_at FROM order_access WHERE store_id = $1', [storeId]);

const httpsOrigin = (url: string) => `https://${new URL(url).host}`;

/**
 * The store's platform and the owner's key, opened, for the automatic messages (auto/platforms.ts), which read the
 * store's checkouts and orders with the same key; null when there is none, or it is marked as refused.
 */
export async function openAccess(app: Pick<App, 'db' | 'env'>, storeId: number): Promise<{ platform: OrderPlatform; creds: Creds; origin: string } | null> {
  const row = await app.db.one<{ platform: OrderPlatform; secret: string; url: string; status: string }>('SELECT a.platform, a.secret, a.status, s.url FROM order_access a JOIN stores s ON s.id = a.store_id WHERE a.store_id = $1', [storeId]);
  if (!row || row.status !== 'active') return null;
  try {
    return { platform: row.platform, creds: JSON.parse(open(app.env, row.secret)), origin: httpsOrigin(row.url) };
  } catch (e) {
    if (e instanceof SecretError) await markError(app.db, storeId, 'the key does not open with this TORAN_SECRETS_KEY');
    return null;
  }
}

/** The platform refused the owner's key: the row says so, and the page asks for a new one. */
export const keyRefused = (db: Db, storeId: number, why: string) => markError(db, storeId, why);

/** The order with this number in the store's own system, or null; throws OrderApiError when the platform did not answer. */
export async function findOrder(app: Pick<App, 'db' | 'env' | 'api'>, storeId: number, number: string): Promise<Order | null> {
  const row = await app.db.one<{ platform: OrderPlatform; secret: string; url: string }>('SELECT a.platform, a.secret, s.url FROM order_access a JOIN stores s ON s.id = a.store_id WHERE a.store_id = $1', [storeId]);
  if (!row) return null;
  let c: Creds;
  try {
    c = JSON.parse(open(app.env, row.secret));
  } catch (e) {
    if (e instanceof SecretError) await markError(app.db, storeId, 'the key does not open with this TORAN_SECRETS_KEY');
    throw new OrderApiError(`the store's key does not open (${(e as Error).message})`, 0);
  }
  try {
    if (row.platform === 'shopify') return await shopifyFind(app.api, c, number);
    if (row.platform === 'woocommerce') return await wooFind(app.api, httpsOrigin(row.url), c, number);
    return await wixFind(app.api, c, number);
  } catch (e) {
    if (e instanceof OrderApiError && [401, 403].includes(e.status)) await markError(app.db, storeId, e.message);
    throw e;
  }
}

const markError = (db: Db, storeId: number, why: string) => db.query("UPDATE order_access SET status = 'error', meta = meta || $2::jsonb WHERE store_id = $1", [storeId, J({ why: why.slice(0, 200), checked_at: new Date().toISOString() })]);

// ---- Connecting

const HE = {
  closed: 'החיבור להזמנות עוד לא פתוח בשרת. כתבו לנו ונחבר יחד.',
  platform: 'אפשר לחבר הזמנות רק בחנות של Shopify, WooCommerce או Wix.',
  refused: 'החנות לא קיבלה את המפתח. כדאי לבדוק שהעתקתם אותו עד הסוף ושיש לו הרשאה לקרוא הזמנות.',
  // Shopify's shop_not_permitted: the client credentials grant works only for a store in the app's own organization.
  org: 'Shopify לא נתנה לאפליקציה גישה לחנות הזו. צריך ליצור את האפליקציה ב-Dev Dashboard מאותו חשבון שהחנות שייכת אליו, ולהתקין אותה על החנות.',
  install: 'Shopify לא נתנה גישה עם הפרטים האלה. כדאי לבדוק שהאפליקציה מותקנת על החנות (ב-Dev Dashboard, "Install app"), ושהעתקתם את ה-Client ID וה-Client secret שלה עד הסוף.',
  away: 'לא הצלחנו להגיע לחנות כדי לבדוק את המפתח. אפשר לנסות שוב בעוד כמה דקות.',
  other: 'המפתח הזה של חנות Shopify אחרת, לא של האתר הזה. צריך את הפרטים של האפליקציה שמותקנת על החנות של האתר.',
};

/** The owner's form as the platform's credentials, or the Hebrew reason it is not one. */
export async function credsOf(app: App, platform: OrderPlatform, origin: string, form: Record<string, string>): Promise<Creds> {
  if (platform === 'shopify') {
    // A Dev Dashboard app's Client ID and Client secret (since 2026), or an old custom app's shpat_ token.
    const token = str(form.token);
    const clientId = str(form.client_id);
    const clientSecret = str(form.client_secret);
    let shop = shopOf(str(form.shop));
    if (!str(form.shop)) shop = shopOf(str((await shopMeta(app.fetcher, origin)).myshopify_domain));
    if (!shop) throw new OrderConnectError('no myshopify address', 'צריך גם את הכתובת של החנות ב-myshopify, למשל my-store.myshopify.com. רואים אותה בניהול של Shopify, בהגדרות, תחת דומיינים.');
    if (token) {
      if (!/^shp[a-z]{2}_[A-Za-z0-9]{16,}$/.test(token)) throw new OrderConnectError('not a Shopify Admin API token', 'זה לא נראה כמו טוקן של Shopify. הוא מתחיל ב-shpat_ ומופיע באפליקציה, תחת API credentials.');
      return { token, shop };
    }
    if (!/^[A-Za-z0-9]{20,64}$/.test(clientId)) throw new OrderConnectError('not a Shopify Client ID', 'זה לא נראה כמו Client ID של Shopify. מעתיקים אותו מהאפליקציה ב-Dev Dashboard, בהגדרות (Settings).');
    if (!/^(shpss_)?[A-Za-z0-9_-]{20,}$/.test(clientSecret)) throw new OrderConnectError('not a Shopify Client secret', 'צריך גם את ה-Client secret, מאותו מקום בהגדרות של האפליקציה ב-Dev Dashboard.');
    return { clientId, clientSecret, shop };
  }
  if (platform === 'woocommerce') {
    const key = str(form.key);
    const secret = str(form.secret);
    if (!/^ck_[A-Za-z0-9]{20,}$/.test(key) || !/^cs_[A-Za-z0-9]{20,}$/.test(secret)) throw new OrderConnectError('not a WooCommerce key pair', 'צריך את שני החלקים של המפתח: Consumer key שמתחיל ב-ck_, ו-Consumer secret שמתחיל ב-cs_.');
    return { key, secret };
  }
  const apiKey = str(form.api_key);
  const siteId = (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(str(form.site_id)) || [''])[0].toLowerCase();
  if (apiKey.length < 20 || /\s/.test(apiKey)) throw new OrderConnectError('not a Wix API key', 'זה לא נראה כמו מפתח API של Wix. מעתיקים אותו מהחלון שנפתח כשיוצרים את המפתח.');
  if (!siteId) throw new OrderConnectError('no Wix site id', 'צריך גם את מזהה האתר (Site ID). הוא מופיע בכתובת של הדשבורד, אחרי /dashboard/.');
  return { apiKey, siteId };
}

/** "my-store", "my-store.myshopify.com", or a link with either (admin.shopify.com/store/my-store), as my-store.myshopify.com. */
export function shopOf(input: string): string | null {
  const s = input.trim().toLowerCase();
  const name = /admin\.shopify\.com\/store\/([a-z0-9][a-z0-9-]*)/.exec(s)?.[1] || /([a-z0-9][a-z0-9-]*)\.myshopify\.com/.exec(s)?.[1] || (/^[a-z0-9][a-z0-9-]*$/.test(s) ? s : null);
  return name ? `${name}.myshopify.com` : null;
}

/** One small read with the key: refused here, not by a customer later. */
export async function tryKey(api: Api, platform: OrderPlatform, origin: string, c: Creds) {
  if (platform === 'shopify') return shopifyGet(api, c, 'orders.json?status=any&limit=1&fields=id');
  if (platform === 'woocommerce') return wooGet(api, origin, c, 'orders?per_page=1');
  return wixPost(api, c, '/ecom/v1/orders/search', { search: { cursorPaging: { limit: 1 } } });
}

/** The owner's form as working credentials, tried once, or an OrderConnectError with the Hebrew reason. */
export async function checkKey(app: App, platform: OrderPlatform, origin: string, form: Record<string, string>): Promise<Creds> {
  const c = await credsOf(app, platform, origin, form);
  try {
    await tryKey(app.api, platform, origin, c);
  } catch (e) {
    if (e instanceof OrderApiError && e.status >= 400 && e.status < 500) {
      const he = c.clientId ? (/shop_not_permitted/i.test(e.message) ? HE.org : HE.install) : HE.refused;
      throw new OrderConnectError(`the key was refused: ${e.message}`, he);
    }
    throw new OrderConnectError(`the key could not be tried: ${(e as Error)?.message || e}`, HE.away);
  }
  return c;
}

/**
 * Whether a Shopify key that works is the shop at this site. Before 2026-11-09 a key was never matched to the store's
 * domain, so a key for any other shop was kept, and the store answered with another shop's orders. Now it is one of:
 *   - the site is that shop's own <name>.myshopify.com address
 *   - the site's public /meta.json gives the shop's myshopify_domain, and it is the shop the key works on (the key
 *     answered at https://<name>.myshopify.com/admin, so that is its shop's myshopify_domain; when /meta.json names
 *     another shop, nothing below can override it)
 *   - no /meta.json (a store behind its password page): the Admin API's GET shop.json says the shop's domain, "The
 *     shop's domain", is the site's, and its myshopify_domain, "The shop's .myshopify.com domain", is the key's
 *     (shopify.dev/docs/api/admin-rest/latest/resources/shop). Taken only when the site itself looks like Shopify
 *     (shopifySite): whether Shopify lets a shop make a domain primary before its DNS points there is UNVERIFIED, so a
 *     domain alone never proves a site that is not on Shopify. Whether shop.json needs a scope beyond read_orders is
 *     UNVERIFIED too: when it is refused, this way says no.
 */
export async function keyFitsSite(app: Pick<App, 'api' | 'fetcher'>, c: Creds, origin: string, shopifySite: boolean): Promise<boolean> {
  const shop = shopOf(str(c.shop));
  if (!shop) return false;
  const host = new URL(origin).hostname.toLowerCase().replace(/\.$/, '');
  if (host === shop) return true;
  const mine = shopOf(str((await shopMeta(app.fetcher, origin)).myshopify_domain));
  if (mine) return mine === shop;
  if (!shopifySite) return false;
  try {
    const s = (await shopifyCall(app.api, c, 'shop.json'))?.shop;
    const domain = canonicalDomain(str(s?.domain));
    return Boolean(domain) && domain === canonicalDomain(origin) && shopOf(str(s?.myshopify_domain)) === shop;
  } catch {
    return false;
  }
}

const hintOf = (s: string | undefined) => (s ? `…${s.slice(-4)}` : null);

/** A tried key, sealed into the store's order_access (from the knowledge page, or from the key that proved the site at /start). */
export async function keepAccess(app: App, storeId: number, platform: OrderPlatform, c: Creds, by: string) {
  const meta = { shop: c.shop || null, site_id: c.siteId || null, kind: c.clientId ? 'dev_dashboard' : c.token ? 'custom_app' : null, hint: hintOf(c.clientId || c.token || c.key || c.apiKey), by, checked_at: new Date().toISOString(), why: null };
  await app.db.query(
    `INSERT INTO order_access (store_id, platform, secret, status, meta) VALUES ($1, $2, $3, 'active', $4::jsonb)
     ON CONFLICT (store_id) DO UPDATE SET platform = EXCLUDED.platform, secret = EXCLUDED.secret, status = 'active', meta = EXCLUDED.meta, connected_at = now()`,
    [storeId, platform, seal(app.env, JSON.stringify(c)), J(meta)],
  );
  await audit(app.db, { actor: by, action: 'orders_connect', storeId, detail: { platform, hint: meta.hint } });
  await event(app.db, storeId, 'orders_connected', { platform });
}

export async function connectOrders(app: App, storeId: number, form: Record<string, string>, by: string) {
  if (!secretsReady(app.env)) throw new OrderConnectError('TORAN_SECRETS_KEY is not set', HE.closed);
  const s = await app.db.one<{ platform: string; url: string }>('SELECT platform, url FROM stores WHERE id = $1', [storeId]);
  if (!s || !ordersPlatform(s.platform)) throw new OrderConnectError(`no order reader for ${s?.platform}`, HE.platform);
  const origin = httpsOrigin(s.url);
  const c = await checkKey(app, s.platform, origin, form);
  if (s.platform === 'shopify' && !(await keyFitsSite(app, c, origin, true))) throw new OrderConnectError(`the key is for ${c.shop}, not this store's shop`, HE.other);
  await keepAccess(app, storeId, s.platform, c, by);
  return { platform: s.platform };
}

export async function disconnectOrders(app: App, storeId: number, by: string) {
  const r = await app.db.query('DELETE FROM order_access WHERE store_id = $1 RETURNING platform', [storeId]);
  if (!r.length) return false;
  await audit(app.db, { actor: by, action: 'orders_disconnect', storeId });
  await event(app.db, storeId, 'orders_disconnected', {});
  return true;
}
