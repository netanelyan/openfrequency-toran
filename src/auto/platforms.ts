import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { App } from '../app.ts';
import { J } from '../db/index.ts';
import { open, seal, secretsReady } from '../core/secrets.ts';
import { HOUR, now } from '../core/clock.ts';
import { toIntl } from '../core/urls.ts';
import { keyRefused, openAccess, OrderApiError, shopifyCall, wixPost, wooCall, type Creds, type OrderPlatform } from '../orders.ts';
import type { Consent } from './consent.ts';
import type { MessageKey } from './messages.ts';

// What happened at a store, read from its own platform with the owner's key (order_access, src/orders.ts), as the
// automatic messages need it: a checkout left without an order, an order paid, waiting for payment or failed, a
// shipment and its delivery. Each platform's object becomes Happenings (one per message it may cause), the consents it
// carries, and the orders it shows were placed (which cancel a cart reminder).
//
// Two ways in, and both end in the same rows (run.ts records by the platform's own ids, so nothing is sent twice):
//
//   webhooks   registered at the platform when the key allows it, to /hooks/<platform>/<store id>, signed:
//              Shopify      checkouts/create|update, orders/create|updated|paid, fulfillments/create|update; signed
//                           with the custom app's API secret key (X-Shopify-Hmac-Sha256), which the owner pastes in
//                           Settings, since the access token cannot sign anything. Without it, no webhooks.
//              WooCommerce  order.created and order.updated, through its webhooks API, signed with a secret Toran
//                           makes (X-WC-Webhook-Signature). A key with Read permission only cannot register them.
//              Wix          none: an API key cannot subscribe to Wix's events (only a Wix app can).
//   reading    the worker reads the orders and checkouts updated since the last reading, every 15 minutes without
//              working webhooks and every hour beside them (anything a webhook missed).
//
// Shopify's abandoned checkouts are its own (checkouts.json, read_orders). WooCommerce has none in its core: an
// order the customer left at the payment page ("pending", with its payment link) or a block checkout's draft is one.
// Wix's are its Abandoned Checkouts API, which the key must be allowed to read.

export type Contact = { name: string | null; phone: string | null; email: string | null };
export type Happening = {
  key: string;
  message: MessageKey;
  ref: string;
  at: string; // when it happened at the store
  contact: Contact;
  vars: { order?: string; link?: string };
  after?: 'shipped' | 'delivered'; // a review: counted from the shipment, or from the delivery
};
/** An order exists (id: the platform's own, as order:<id> or checkout:<id>): a cart reminder for its checkout, or for the same person before it, is not sent. */
export type Placed = { id: string; checkout: string | null; at: string; contact: Contact };
export type Read = { happenings: Happening[]; consent: Consent[]; placed: Placed[] };

const str = (v: unknown) => (v == null ? '' : String(v).trim());
const first = (...xs: unknown[]) => xs.map(str).find(Boolean) || null;
const iso = (v: unknown) => {
  const t = new Date(str(v)).getTime();
  return Number.isFinite(t) && t > 0 ? new Date(t).toISOString() : null;
};
const contactOf = (name: unknown, phone: unknown[], email: unknown[]): Contact => ({
  name: str(name) || null,
  phone: phone.map((p) => toIntl(str(p))).find(Boolean) || null,
  email: email.map((e) => str(e).toLowerCase()).find((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) || null,
});
const empty = (): Read => ({ happenings: [], consent: [], placed: [] });

// ---- Shopify

/** A consent object Shopify keeps on a customer (email_marketing_consent, sms_marketing_consent), as rows. */
function shopifyConsent(channel: 'email' | 'whatsapp', address: string | null, c: any, source: string, fallbackAt: string | null): Consent[] {
  const state = str(c?.state);
  if (!address || !['subscribed', 'unsubscribed', 'not_subscribed'].includes(state)) return [];
  const at = iso(c?.consent_updated_at) || fallbackAt;
  if (!at || state === 'not_subscribed') return [];
  return [{ channel, address, scope: 'marketing', state: state === 'subscribed' ? 'in' : 'out', source, at }];
}

function shopifyConsents(x: any, contact: Contact, at: string | null): Consent[] {
  const out: Consent[] = [];
  if (x?.buyer_accepts_marketing === true && contact.email && at) out.push({ channel: 'email', address: contact.email, scope: 'marketing', state: 'in', source: 'shopify:buyer_accepts_marketing', at });
  // The checkout's "text me with news and offers" box, for the phone it names: what the customer agreed to on the phone.
  const smsPhone = toIntl(str(x?.sms_marketing_phone)) || contact.phone;
  if (x?.buyer_accepts_sms_marketing === true && smsPhone && at) out.push({ channel: 'whatsapp', address: smsPhone, scope: 'marketing', state: 'in', source: 'shopify:buyer_accepts_sms_marketing', at });
  out.push(...shopifyConsent('email', contact.email, x?.customer?.email_marketing_consent, 'shopify:email_marketing_consent', at));
  out.push(...shopifyConsent('whatsapp', toIntl(str(x?.customer?.phone)) || contact.phone, x?.customer?.sms_marketing_consent, 'shopify:sms_marketing_consent', at));
  return out;
}

const shopifyContact = (x: any): Contact => contactOf(
  first(x?.customer?.first_name, x?.billing_address?.first_name, x?.shipping_address?.first_name),
  [x?.phone, x?.sms_marketing_phone, x?.customer?.phone, x?.shipping_address?.phone, x?.billing_address?.phone],
  [x?.email, x?.contact_email, x?.customer?.email],
);

/** An abandoned checkout (checkouts/create|update, checkouts.json): a cart reminder, or, once completed, an order placed. */
export function shopifyCheckout(c: any): Read {
  const r = empty();
  const id = first(c?.token, c?.id);
  const at = iso(c?.created_at);
  if (!id || !at) return r;
  const contact = shopifyContact(c);
  r.consent.push(...shopifyConsents(c, contact, iso(c?.updated_at) || at));
  if (c?.completed_at) {
    r.placed.push({ id: `checkout:${id}`, checkout: id, at: iso(c.completed_at) || at, contact });
    return r;
  }
  const link = str(c?.abandoned_checkout_url);
  if (link) r.happenings.push({ key: `shopify:checkout:${id}:cart`, message: 'cart', ref: `checkout ${id.slice(0, 12)}`, at, contact, vars: { link } });
  return r;
}

/** An order (orders/*, a fulfillment's order, orders.json): placed, paid or waiting for payment, its shipments. */
export function shopifyOrderRead(o: any): Read {
  const r = empty();
  const id = str(o?.id);
  const created = iso(o?.created_at);
  if (!id || !created) return r;
  const contact = shopifyContact(o);
  const order = first(o?.name, o?.order_number) || id;
  r.consent.push(...shopifyConsents(o, contact, iso(o?.updated_at) || created));
  r.placed.push({ id: `order:${id}`, checkout: first(o?.checkout_token, o?.checkout_id), at: created, contact });
  if (o?.cancelled_at) return r;
  const fin = str(o?.financial_status);
  if (fin === 'paid') r.happenings.push({ key: `shopify:order:${id}:paid`, message: 'paid', ref: order, at: iso(o?.processed_at) || created, contact, vars: { order } });
  if (fin === 'pending') r.happenings.push({ key: `shopify:order:${id}:pending`, message: 'pending', ref: order, at: created, contact, vars: { order } });
  for (const f of Array.isArray(o?.fulfillments) ? o.fulfillments : []) {
    if (str(f?.status) !== 'success' || !f?.id) continue;
    const shippedAt = iso(f.created_at) || created;
    const link = first(f.tracking_url, f.tracking_urls?.[0], o?.order_status_url) || '';
    r.happenings.push({ key: `shopify:fulfillment:${f.id}:shipped`, message: 'shipped', ref: order, at: shippedAt, contact, vars: { order, link } });
    r.happenings.push({ key: `shopify:order:${id}:review`, message: 'review', ref: order, at: shippedAt, contact, vars: { order }, after: 'shipped' });
    if (str(f.shipment_status) === 'delivered') {
      const deliveredAt = iso(f.updated_at) || shippedAt;
      r.happenings.push({ key: `shopify:fulfillment:${f.id}:delivered`, message: 'delivered', ref: order, at: deliveredAt, contact, vars: { order } });
      r.happenings.push({ key: `shopify:order:${id}:review`, message: 'review', ref: order, at: deliveredAt, contact, vars: { order }, after: 'delivered' });
    }
  }
  return r;
}

export const SHOPIFY_TOPICS = ['checkouts/create', 'checkouts/update', 'orders/create', 'orders/updated', 'orders/paid', 'fulfillments/create', 'fulfillments/update'];
const SHOPIFY_ORDER_FIELDS = 'id,name,order_number,email,contact_email,phone,created_at,updated_at,processed_at,cancelled_at,financial_status,fulfillment_status,customer,billing_address,shipping_address,fulfillments,order_status_url,checkout_token,checkout_id,buyer_accepts_marketing,sms_marketing_phone';

/** X-Shopify-Hmac-Sha256: base64 of the raw body's HMAC-SHA256 under the app's API secret key. */
export function shopifyHmacOk(secret: string, raw: string, header: unknown): boolean {
  if (!secret) return false;
  const want = Buffer.from(createHmac('sha256', secret).update(Buffer.from(raw, 'utf8')).digest('base64'));
  const got = Buffer.from(str(header));
  return got.length === want.length && timingSafeEqual(got, want);
}
export const shopifySign = (secret: string, raw: string) => createHmac('sha256', secret).update(Buffer.from(raw, 'utf8')).digest('base64');

// ---- WooCommerce

/** Order fields that consent plugins keep on a WooCommerce order: Mailchimp for WooCommerce, and the common ones. */
const WOO_CONSENT_KEYS = ['mailchimp_woocommerce_is_subscribed', '_wc_marketing_consent', 'marketing_consent', '_marketing_consent', 'whatsapp_opt_in', '_whatsapp_opt_in'];
const yes = (v: unknown) => v === true || ['yes', '1', 'on', 'true', 'subscribed'].includes(str(v).toLowerCase());

export function wooOrderRead(o: any, origin: string): Read {
  const r = empty();
  const id = str(o?.id);
  const created = iso(o?.date_created_gmt ? `${o.date_created_gmt}Z` : o?.date_created);
  if (!id || !created) return r;
  const gmt = (k: string) => iso(o?.[`${k}_gmt`] ? `${o[`${k}_gmt`]}Z` : o?.[k]);
  const contact = contactOf(first(o?.billing?.first_name, o?.shipping?.first_name), [o?.billing?.phone, o?.shipping?.phone], [o?.billing?.email]);
  const order = first(o?.number) || id;
  const status = str(o?.status);
  for (const m of Array.isArray(o?.meta_data) ? o.meta_data : []) {
    if (!WOO_CONSENT_KEYS.includes(str(m?.key)) || !yes(m?.value)) continue;
    const source = `woocommerce:${str(m.key)}`;
    if (contact.email) r.consent.push({ channel: 'email', address: contact.email, scope: 'marketing', state: 'in', source, at: created });
    if (contact.phone && /whatsapp/.test(str(m.key))) r.consent.push({ channel: 'whatsapp', address: contact.phone, scope: 'marketing', state: 'in', source, at: created });
  }
  const payLink = str(o?.payment_url);
  if (status === 'pending' || status === 'checkout-draft') {
    // Left at the payment page (its own link to pay) or in a block checkout's draft (the first item, back in a cart).
    const item = (o?.line_items || [])[0];
    const add = item ? `${origin}/?add-to-cart=${encodeURIComponent(str(item.variation_id && Number(item.variation_id) ? item.variation_id : item.product_id))}&quantity=${Math.max(1, Number(item.quantity) || 1)}` : '';
    const link = (status === 'pending' && payLink) || add;
    if (link) r.happenings.push({ key: `woocommerce:order:${id}:cart`, message: 'cart', ref: order, at: created, contact, vars: { link } });
    return r;
  }
  r.placed.push({ id: `order:${id}`, checkout: id, at: created, contact });
  if (status === 'on-hold') r.happenings.push({ key: `woocommerce:order:${id}:pending`, message: 'pending', ref: order, at: created, contact, vars: { order } });
  if (status === 'failed') r.happenings.push({ key: `woocommerce:order:${id}:failed`, message: 'failed', ref: order, at: gmt('date_modified') || created, contact, vars: { order, link: payLink || `${origin}/` } });
  if ((status === 'processing' || status === 'completed') && (o?.date_paid_gmt || o?.date_paid)) r.happenings.push({ key: `woocommerce:order:${id}:paid`, message: 'paid', ref: order, at: gmt('date_paid') || created, contact, vars: { order } });
  if (status === 'completed') {
    // WooCommerce marks an order completed when it is sent or handed over; the Shipment Tracking extension's link when the store typed one.
    const tracking = (o?.meta_data || []).find((m: any) => m?.key === '_wc_shipment_tracking_items')?.value;
    const link = (Array.isArray(tracking) ? tracking : []).map((t: any) => str(t?.custom_tracking_link)).find(Boolean) || '';
    const at = gmt('date_completed') || gmt('date_modified') || created;
    r.happenings.push({ key: `woocommerce:order:${id}:shipped`, message: 'shipped', ref: order, at, contact, vars: { order, link } });
    r.happenings.push({ key: `woocommerce:order:${id}:review`, message: 'review', ref: order, at, contact, vars: { order }, after: 'shipped' });
  }
  return r;
}

export const WOO_TOPICS = ['order.created', 'order.updated'];

/** X-WC-Webhook-Signature: base64 of the raw body's HMAC-SHA256 under the webhook's secret. */
export const wooSignatureOk = shopifyHmacOk;
export const wooSign = shopifySign;

// ---- Wix

export function wixOrderRead(o: any, fulfillments: any[], origin: string): Read {
  const r = empty();
  const id = str(o?.id);
  const created = iso(o?.createdDate);
  if (!id || !created || str(o?.status) === 'INITIALIZED') return r;
  const cd = o?.billingInfo?.contactDetails || {};
  const contact = contactOf(first(cd.firstName, o?.recipientInfo?.contactDetails?.firstName), [cd.phone, o?.shippingInfo?.logistics?.shippingDestination?.contactDetails?.phone, o?.recipientInfo?.contactDetails?.phone], [o?.buyerInfo?.email, cd.email]);
  const order = str(o?.number) || id;
  r.placed.push({ id: `order:${id}`, checkout: str(o?.checkoutId) || null, at: created, contact });
  if (str(o?.status) === 'CANCELED') return r;
  const pay = str(o?.paymentStatus);
  if (pay === 'PAID') r.happenings.push({ key: `wix:order:${id}:paid`, message: 'paid', ref: order, at: created, contact, vars: { order } });
  if (['PENDING', 'PENDING_MERCHANT', 'NOT_PAID'].includes(pay) && str(o?.status) === 'APPROVED') r.happenings.push({ key: `wix:order:${id}:pending`, message: 'pending', ref: order, at: created, contact, vars: { order } });
  if (pay === 'DECLINED') r.happenings.push({ key: `wix:order:${id}:failed`, message: 'failed', ref: order, at: iso(o?.updatedDate) || created, contact, vars: { order, link: `${origin}/` } });
  for (const f of fulfillments) {
    const t = f?.trackingInfo;
    if (!f?.id) continue;
    const at = iso(f.createdDate) || created;
    r.happenings.push({ key: `wix:fulfillment:${f.id}:shipped`, message: 'shipped', ref: order, at, contact, vars: { order, link: str(t?.trackingLink) } });
    r.happenings.push({ key: `wix:order:${id}:review`, message: 'review', ref: order, at, contact, vars: { order }, after: 'shipped' });
  }
  return r;
}

export function wixCheckoutRead(c: any): Read {
  const r = empty();
  const id = first(c?.checkoutId, c?.id);
  const at = iso(c?.createdDate || c?._createdDate);
  if (!id || !at) return r;
  const contact = contactOf(first(c?.contactDetails?.firstName, c?.buyerInfo?.firstName), [c?.contactDetails?.phone], [c?.buyerInfo?.email, c?.contactDetails?.email]);
  if (str(c?.status) === 'RECOVERED') {
    r.placed.push({ id: `checkout:${id}`, checkout: id, at, contact });
    return r;
  }
  const link = first(c?.checkoutUrl, c?.checkoutRecoveryUrl) || '';
  if (str(c?.status) === 'ABANDONED' && link) r.happenings.push({ key: `wix:checkout:${id}:cart`, message: 'cart', ref: `checkout ${id.slice(0, 12)}`, at, contact, vars: { link } });
  return r;
}

/** A Wix contact's subscriptions (Contacts API), as consent: its email's and its phone's. */
async function wixConsent(api: typeof fetch, c: Creds, contactId: string, contact: Contact): Promise<Consent[]> {
  const res = await api(`https://www.wixapis.com/contacts/v4/contacts/${encodeURIComponent(contactId)}`, { headers: { authorization: c.apiKey!, 'wix-site-id': c.siteId!, accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return [];
  const x: any = (await res.json().catch(() => null))?.contact || {};
  const at = iso(x.updatedDate) || new Date(now()).toISOString();
  const out: Consent[] = [];
  const e = str(x.primaryEmail?.subscriptionStatus);
  const p = str(x.primaryPhone?.subscriptionStatus);
  if (contact.email && ['SUBSCRIBED', 'UNSUBSCRIBED'].includes(e)) out.push({ channel: 'email', address: contact.email, scope: 'marketing', state: e === 'SUBSCRIBED' ? 'in' : 'out', source: 'wix:contact_email', at });
  if (contact.phone && ['SUBSCRIBED', 'UNSUBSCRIBED'].includes(p)) out.push({ channel: 'whatsapp', address: contact.phone, scope: 'marketing', state: p === 'SUBSCRIBED' ? 'in' : 'out', source: 'wix:contact_phone', at });
  return out;
}

// ---- Where a store's events come from

export type Source = { store_id: number; platform: OrderPlatform; secret: string | null; hooks: { topic: string; id: string }[]; can: any; read_from: string | null; polled_at: string | null; hook_at: string | null };

export const sourceOf = (app: App, storeId: number) => app.db.one<Source>('SELECT store_id, platform, secret, hooks, can, read_from, polled_at, hook_at FROM auto_sources WHERE store_id = $1', [storeId]);

const base = (env: Record<string, string | undefined>) => str(env.PUBLIC_BASE_URL).replace(/\/+$/, '');
export const hookUrl = (env: Record<string, string | undefined>, platform: string, storeId: number) => `${base(env)}/hooks/${platform}/${storeId}`;

const why = (e: unknown) => (e instanceof OrderApiError ? e.message : String((e as Error)?.message || e)).slice(0, 200);
const refused = (e: unknown) => e instanceof OrderApiError && [401, 403].includes(e.status);

/**
 * Set a store up: register the webhooks its key allows, find out whether it can read abandoned checkouts, and keep
 * what it found (auto_sources.can, with the reasons the settings page shows). `secret`: Shopify's API secret key, when
 * the owner just pasted one. Safe to run again: a webhook already there is kept, not added twice.
 */
export async function setupSource(app: App, storeId: number, { secret }: { secret?: string } = {}) {
  const access = await openAccess(app, storeId);
  if (!access) return null;
  const prev = await sourceOf(app, storeId);
  let hookSecret = secret != null ? secret.trim() : prev?.secret ? open(app.env, prev.secret) : '';
  const can: any = { webhooks: false, checkouts: null, why: {} };
  const hooks: { topic: string; id: string }[] = [];
  const { creds: c, origin } = access;
  if (!base(app.env).startsWith('https://')) can.why.webhooks = 'no_public_url';
  if (access.platform === 'shopify') {
    try {
      await shopifyCall(app.api, c, 'checkouts.json?limit=1');
      can.checkouts = true;
    } catch (e) {
      can.checkouts = false;
      can.why.checkouts = why(e);
    }
    if (!hookSecret) can.why.webhooks ||= 'no_secret';
    if (!can.why.webhooks) {
      const address = hookUrl(app.env, 'shopify', storeId);
      try {
        const have = ((await shopifyCall(app.api, c, 'webhooks.json?limit=250'))?.webhooks || []).filter((w: any) => w?.address === address);
        const missing: string[] = [];
        for (const topic of SHOPIFY_TOPICS) {
          const there = have.find((w: any) => w.topic === topic);
          if (there) {
            hooks.push({ topic, id: str(there.id) });
            continue;
          }
          try {
            const w = await shopifyCall(app.api, c, 'webhooks.json', { method: 'POST', body: { webhook: { topic, address, format: 'json' } } });
            hooks.push({ topic, id: str(w?.webhook?.id) });
          } catch (e) {
            missing.push(`${topic}: ${why(e)}`);
          }
        }
        can.webhooks = hooks.length > 0;
        if (missing.length) can.why.webhooks = `missing ${missing.join('; ')}`.slice(0, 400);
      } catch (e) {
        can.why.webhooks = why(e);
      }
    }
  } else if (access.platform === 'woocommerce') {
    can.checkouts = true; // the orders left at the payment page, read like any order
    if (!can.why.webhooks) {
      hookSecret ||= randomBytes(24).toString('base64url');
      const address = hookUrl(app.env, 'woocommerce', storeId);
      try {
        const have = (await wooCall(app.api, origin, c, 'webhooks?per_page=100')) || [];
        for (const topic of WOO_TOPICS) {
          const there = (Array.isArray(have) ? have : []).find((w: any) => w?.delivery_url === address && w?.topic === topic && w?.status === 'active');
          // A webhook of ours from before carries a secret we may no longer hold: a new one replaces it.
          if (there && prev?.secret && secret == null) {
            hooks.push({ topic, id: str(there.id) });
            continue;
          }
          if (there) await wooCall(app.api, origin, c, `webhooks/${there.id}?force=true`, { method: 'DELETE' }).catch(() => null);
          const w = await wooCall(app.api, origin, c, 'webhooks', { method: 'POST', body: { name: `Toran ${topic}`, topic, delivery_url: address, secret: hookSecret, status: 'active' } });
          hooks.push({ topic, id: str(w?.id) });
        }
        can.webhooks = true;
      } catch (e) {
        // A key with Read permission only is refused here: Toran reads instead.
        can.why.webhooks = refused(e) ? 'read_only' : why(e);
      }
    }
  } else {
    can.why.webhooks = 'wix_keys';
    try {
      await wixPost(app.api, c, '/ecom/v1/abandoned-checkout/query', { query: { cursorPaging: { limit: 1 } } });
      can.checkouts = true;
    } catch (e) {
      can.checkouts = false;
      can.why.checkouts = why(e);
    }
  }
  const sealed = hookSecret && secretsReady(app.env) ? seal(app.env, hookSecret) : null;
  await app.db.query(
    `INSERT INTO auto_sources (store_id, platform, secret, hooks, can, read_from, checked_at) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, now())
     ON CONFLICT (store_id) DO UPDATE SET platform = EXCLUDED.platform, secret = EXCLUDED.secret, hooks = EXCLUDED.hooks, can = EXCLUDED.can, checked_at = now()`,
    // The first reading goes an hour back, never further: turning the messages on does not write to last week's customers.
    [storeId, access.platform, sealed, J(hooks), J(can), new Date(now() - HOUR).toISOString()],
  );
  return { platform: access.platform, can, hooks };
}

/** Forget a store's source: its webhooks deleted at the platform (as far as the key still allows), and the row. */
export async function dropSource(app: App, storeId: number) {
  const s = await sourceOf(app, storeId);
  if (!s) return false;
  const access = await openAccess(app, storeId);
  if (access) {
    for (const h of s.hooks || []) {
      if (!h.id) continue;
      const done = access.platform === 'shopify' ? shopifyCall(app.api, access.creds, `webhooks/${h.id}.json`, { method: 'DELETE' }) : access.platform === 'woocommerce' ? wooCall(app.api, access.origin, access.creds, `webhooks/${h.id}?force=true`, { method: 'DELETE' }) : null;
      await done?.catch((e) => app.log(`[auto] store ${storeId}: webhook ${h.id} not deleted: ${why(e)}`));
    }
  }
  await app.db.query('DELETE FROM auto_sources WHERE store_id = $1', [storeId]);
  return true;
}

/** The secret a store's webhooks are signed with, or null. */
export async function hookSecretOf(app: App, storeId: number, platform: string): Promise<string | null> {
  const s = await sourceOf(app, storeId);
  if (!s?.secret || s.platform !== platform) return null;
  try {
    return open(app.env, s.secret);
  } catch {
    return null;
  }
}

/** One webhook's body as Reads (the worker's auto_hook job). A Shopify fulfillment names only its order, which is read. */
export async function readHook(app: App, storeId: number, platform: string, topic: string, body: any): Promise<Read[]> {
  const access = await openAccess(app, storeId);
  if (!access || access.platform !== platform) return [];
  if (platform === 'shopify') {
    if (topic.startsWith('checkouts/')) return [shopifyCheckout(body)];
    if (topic.startsWith('orders/')) return [shopifyOrderRead(body)];
    if (topic.startsWith('fulfillments/') && body?.order_id) {
      const o = await shopifyCall(app.api, access.creds, `orders/${encodeURIComponent(str(body.order_id))}.json?fields=${SHOPIFY_ORDER_FIELDS}`);
      return o?.order ? [shopifyOrderRead(o.order)] : [];
    }
    return [];
  }
  if (platform === 'woocommerce' && topic.startsWith('order.')) return [wooOrderRead(body, access.origin)];
  return [];
}

/** The key reads orders but not checkouts (it was changed at the platform): the page says so, and the orders go on. */
async function noCheckouts(app: App, storeId: number, e: unknown): Promise<null> {
  if (!refused(e)) throw e;
  await app.db.query("UPDATE auto_sources SET can = jsonb_set(jsonb_set(can, '{checkouts}', 'false'), '{why}', COALESCE(can->'why', '{}'::jsonb) || $2::jsonb) WHERE store_id = $1", [storeId, J({ checkouts: why(e) })]);
  return null;
}

/**
 * Read what changed since the last reading: orders, and checkouts where the key reads them. Returns the Reads and the
 * latest update time seen, which the next reading starts from (a little before it, since the platforms' "since" is
 * inclusive and dedupe makes the overlap free).
 */
export async function poll(app: App, storeId: number, { checkouts = true, consent = false }: { checkouts?: boolean; consent?: boolean } = {}): Promise<{ reads: Read[]; upto: string | null }> {
  const access = await openAccess(app, storeId);
  if (!access) return { reads: [], upto: null };
  const s = await sourceOf(app, storeId);
  const since = s?.read_from ? new Date(s.read_from).toISOString() : new Date(now() - HOUR).toISOString();
  const reads: Read[] = [];
  let upto: string | null = null;
  const seen = (t: unknown) => {
    const x = iso(t);
    if (x && (!upto || x > upto)) upto = x;
  };
  const { creds: c, origin } = access;
  try {
    if (access.platform === 'shopify') {
      const orders = (await shopifyCall(app.api, c, `orders.json?status=any&limit=250&updated_at_min=${encodeURIComponent(since)}&fields=${SHOPIFY_ORDER_FIELDS}`))?.orders || [];
      for (const o of orders) {
        reads.push(shopifyOrderRead(o));
        seen(o.updated_at);
      }
      if (checkouts && s?.can?.checkouts !== false) {
        const list = (await shopifyCall(app.api, c, `checkouts.json?limit=250&updated_at_min=${encodeURIComponent(since)}`).catch((e) => noCheckouts(app, storeId, e)))?.checkouts || [];
        for (const x of list) {
          reads.push(shopifyCheckout(x));
          seen(x.updated_at);
        }
      }
    } else if (access.platform === 'woocommerce') {
      const q = `orders?per_page=100&orderby=modified&order=asc&dates_are_gmt=true&modified_after=${encodeURIComponent(since.replace(/\.\d+Z$/, ''))}`;
      const list = [...((await wooCall(app.api, origin, c, `${q}&status=any`)) || [])];
      // A block checkout's drafts are not in "any".
      if (checkouts) list.push(...((await wooCall(app.api, origin, c, `${q}&status=checkout-draft`).catch(() => [])) || []));
      for (const o of list) {
        reads.push(wooOrderRead(o, origin));
        seen(o?.date_modified_gmt ? `${o.date_modified_gmt}Z` : o?.date_modified);
      }
    } else {
      const data = await wixPost(app.api, c, '/ecom/v1/orders/search', { search: { filter: { updatedDate: { $gte: since } }, sort: [{ fieldName: 'updatedDate', order: 'ASC' }], cursorPaging: { limit: 100 } } });
      const orders: any[] = data?.orders || [];
      const shipped = orders.filter((o) => ['FULFILLED', 'PARTIALLY_FULFILLED'].includes(str(o?.fulfillmentStatus))).map((o) => o.id);
      const byOrder = new Map<string, any[]>();
      if (shipped.length) {
        try {
          const f = await wixPost(app.api, c, '/ecom/v1/fulfillments/list-by-ids', { orderIds: shipped });
          for (const x of f?.ordersWithFulfillments || []) byOrder.set(str(x?.orderId), x?.fulfillments || []);
        } catch {
          // A key that reads orders and not their fulfillments: no shipping messages, the rest stands.
        }
      }
      for (const o of orders) {
        const read = wixOrderRead(o, byOrder.get(str(o.id)) || [], origin);
        if (consent && o?.buyerInfo?.contactId && read.placed[0]) read.consent.push(...(await wixConsent(app.api, c, str(o.buyerInfo.contactId), read.placed[0].contact).catch(() => [])));
        reads.push(read);
        seen(o.updatedDate);
      }
      if (checkouts && s?.can?.checkouts !== false) {
        const ab = await wixPost(app.api, c, '/ecom/v1/abandoned-checkout/query', { query: { filter: { _updatedDate: { $gte: since } }, cursorPaging: { limit: 100 } } }).catch((e) => noCheckouts(app, storeId, e));
        for (const x of ab?.abandonedCheckouts || []) {
          const read = wixCheckoutRead(x);
          const who = read.happenings[0]?.contact;
          if (consent && x?.buyerInfo?.contactId && who) read.consent.push(...(await wixConsent(app.api, c, str(x.buyerInfo.contactId), who).catch(() => [])));
          reads.push(read);
          seen(x._updatedDate || x.updatedDate);
        }
      }
    }
  } catch (e) {
    // The key was taken back at the platform: the knowledge page asks for a new one, and nothing more is read.
    if (refused(e)) await keyRefused(app.db, storeId, why(e));
    throw e;
  }
  return { reads, upto };
}
