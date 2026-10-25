import type { App } from '../app.ts';
import type { Db } from '../db/index.ts';
import { event } from '../db/log.ts';
import { toIntl } from '../core/urls.ts';
import { now } from '../core/clock.ts';

// What a store's customer agreed to hear, per channel and address (auto_consent, migration 017):
//
//   marketing   the cart and the review (messages.ts). Only with the customer's "yes" from the store's checkout:
//               Shopify's email and SMS marketing consent (the phone's counts for WhatsApp), WooCommerce's from the
//               consent plugins that keep it on the order, Wix's contact's subscription. Each row keeps its source and
//               the platform's own time of it.
//   all         every automatic message. Only ever "out": the customer wrote "הסר" or "STOP" (or pressed the
//               template's "הסר" button), on the channel they wrote on.
//
// Payment and shipping need no "yes": they are about an order the customer placed with that phone or email. They
// stop with "הסר" like the rest. The rows are read in time order: a later "yes" at a checkout counts again after an
// earlier "הסר", and a later "הסר" beats every earlier "yes".

export type Channel = 'whatsapp' | 'email';
export type Consent = { channel: Channel; address: string; scope: 'marketing' | 'all'; state: 'in' | 'out'; source: string; at: string };

/** The address as consent is kept by: a phone in international digits, an email lower-cased. */
export const addressOf = (channel: Channel, s: string | null | undefined): string | null => {
  if (!s) return null;
  if (channel === 'whatsapp') return toIntl(s);
  const e = String(s).trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) ? e : null;
};

export async function recordConsent(db: Db, storeId: number, rows: Consent[]) {
  for (const c of rows) {
    const address = addressOf(c.channel, c.address);
    if (!address || !c.at || Number.isNaN(new Date(c.at).getTime())) continue;
    await db.query('INSERT INTO auto_consent (store_id, channel, address, scope, state, source, at) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING', [storeId, c.channel, address, c.scope, c.state, c.source, new Date(c.at).toISOString()]);
  }
}

/** What this customer allows on this channel now: every automatic message (updates), and marketing too, with its source. */
export async function consentOf(db: Db, storeId: number, channel: Channel, raw: string): Promise<{ updates: boolean; marketing: boolean; source: string | null }> {
  const address = addressOf(channel, raw);
  if (!address) return { updates: false, marketing: false, source: null };
  const rows = await db.query<{ scope: string; state: string; source: string }>('SELECT scope, state, source FROM auto_consent WHERE store_id = $1 AND channel = $2 AND address = $3 ORDER BY at, id', [storeId, channel, address]);
  let out = false;
  let marketing: string | null = null;
  for (const r of rows) {
    if (r.scope === 'all' && r.state === 'out') {
      out = true;
      marketing = null;
    } else if (r.scope === 'marketing' && r.state === 'in') {
      out = false;
      marketing = r.source;
    } else if (r.scope === 'marketing' && r.state === 'out') marketing = null;
  }
  return { updates: !out, marketing: !out && Boolean(marketing), source: marketing };
}

/** A whole message that asks to stop: "הסר", "הסירו אותי", "STOP", "unsubscribe". */
export const OPT_OUT = /^\s*(?:הסר|הסירו|הסירו אותי|תסירו אותי|להסיר|הסרה|stop|unsubscribe)\s*[.!]*\s*$/i;

export const optOutReply = (store: string) => `בסדר, לא נשלח לכם יותר הודעות אוטומטיות מ${/^[֐-׿]/.test(store) ? '' : '-'}${store}. אם תכתבו לנו כאן, נענה כרגיל.`;

/** The customer asked to stop: every automatic message to this address on this channel, from now on. */
export async function optOut(app: App, storeId: number, channel: Channel, raw: string, word: string, conversationId: number | null) {
  const address = addressOf(channel, raw);
  if (!address) return;
  await recordConsent(app.db, storeId, [{ channel, address, scope: 'all', state: 'out', source: `customer:${word.trim().toLowerCase().slice(0, 20)}`, at: new Date(now()).toISOString() }]);
  const field = channel === 'whatsapp' ? 'phone' : 'email';
  await app.db.query(`UPDATE auto_events SET status = 'skipped', why = 'opted_out' WHERE store_id = $1 AND status = 'waiting' AND contact->>'${field}' = $2`, [storeId, address]);
  await event(app.db, storeId, 'auto_opt_out', { channel, conversationId });
}

/**
 * The customer wrote to the store: a cart reminder or a review request still waiting for them is dropped, since they
 * are talking to the store already (and a reply to the store is the store's to answer, not a reminder's).
 */
export async function customerWrote(app: App, storeId: number, channel: Channel, raw: string) {
  const address = addressOf(channel, raw);
  if (!address) return 0;
  const field = channel === 'whatsapp' ? 'phone' : 'email';
  const r = await app.db.query(`UPDATE auto_events SET status = 'skipped', why = 'replied' WHERE store_id = $1 AND status = 'waiting' AND kind IN ('cart', 'review') AND contact->>'${field}' = $2 RETURNING id`, [storeId, address]);
  if (r.length) await event(app.db, storeId, 'auto_replied', { channel, events: r.map((x: any) => x.id) });
  return r.length;
}
