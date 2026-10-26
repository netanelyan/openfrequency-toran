import { randomBytes } from 'node:crypto';
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
//               the platform's own time of it. "out" from the link in every marketing message (source 'link'):
//               the page /u/<token> (web/unsubscribe.ts), or a mail client's one-click unsubscribe (RFC 8058).
//   all         every automatic message. Only ever "out": the customer wrote "הסר" or "STOP" (or pressed the old
//               templates' "הסר" button), on the channel they wrote on. Nothing says to write it any more; it still
//               works.
//
// Payment and shipping need no "yes": they are about an order the customer placed with that phone or email. They
// stop with "הסר" like the rest, never with the link. The rows are read in time order: a later "yes" at a checkout
// counts again after an earlier "הסר" or link, and a later "הסר" beats every earlier "yes". The link's undo ("in",
// source 'link') gives back only the "yes" its "out" put aside, never one the customer did not give.
//
// The link's token (auto_links, migration 019) is random and bound to one store, channel and address, so the page
// knows whom it is about with nothing personal in the URL. Its "out" is recorded for that address and for the
// customer's other one, where an order or checkout of this store carried both, so the cart and the review stop on
// every channel.

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
  // The "yes" the latest link "out" put aside, while nothing came after it, for the link's undo.
  let aside: { source: string | null } | null = null;
  for (const r of rows) {
    if (r.scope === 'all' && r.state === 'out') {
      out = true;
      marketing = null;
      aside = null;
    } else if (r.scope === 'marketing' && r.state === 'in' && r.source === LINK) {
      if (aside) marketing = aside.source;
      aside = null;
    } else if (r.scope === 'marketing' && r.state === 'in') {
      out = false;
      marketing = r.source;
      aside = null;
    } else if (r.scope === 'marketing' && r.state === 'out') {
      if (r.source === LINK) aside ??= { source: marketing };
      else aside = null;
      marketing = null;
    }
  }
  return { updates: !out, marketing: !out && Boolean(marketing), source: marketing };
}

/** The source of a consent row from the link in a marketing message: its page, or a mail client's one-click. */
export const LINK = 'link';

const TOKEN = /^[A-Za-z0-9_-]{24}$/;
export const isToken = (s: string) => TOKEN.test(s);

/** The link's token for this address at this store: made once (18 random bytes), the same one every time after. */
export async function stopToken(db: Db, storeId: number, channel: Channel, raw: string): Promise<string | null> {
  const address = addressOf(channel, raw);
  if (!address) return null;
  const r = await db.one<{ token: string }>(
    'INSERT INTO auto_links (token, store_id, channel, address) VALUES ($1, $2, $3, $4) ON CONFLICT (store_id, channel, address) DO UPDATE SET address = EXCLUDED.address RETURNING token',
    [randomBytes(18).toString('base64url'), storeId, channel, address],
  );
  return r!.token;
}

export type StopLink = { token: string; store_id: number; channel: Channel; address: string; stopped_at: string | null };

export const linkOf = (db: Db, token: string) => (isToken(token) ? db.one<StopLink>('SELECT token, store_id, channel, address, stopped_at FROM auto_links WHERE token = $1', [token]) : Promise.resolve(null));

/** The link's address and the customer's other one, where one of this store's orders or checkouts carried both. */
async function addressesOf(db: Db, l: StopLink): Promise<{ channel: Channel; address: string }[]> {
  const [field, otherField] = l.channel === 'whatsapp' ? ['phone', 'email'] : ['email', 'phone'];
  const other: Channel = l.channel === 'whatsapp' ? 'email' : 'whatsapp';
  const rows = await db.query<{ a: string }>(`SELECT DISTINCT contact->>'${otherField}' AS a FROM auto_events WHERE store_id = $1 AND lower(contact->>'${field}') = $2 AND contact->>'${otherField}' IS NOT NULL LIMIT 5`, [l.store_id, l.address]);
  const out = [{ channel: l.channel, address: l.address }];
  for (const r of rows) {
    const a = addressOf(other, r.a);
    if (a && !out.some((x) => x.channel === other && x.address === a)) out.push({ channel: other, address: a });
  }
  return out;
}

/** The customer stopped the store's reminders from the link: the cart and the review, on every channel; payment and shipping go on. */
export async function stopFromLink(app: App, l: StopLink, via: 'page' | 'one-click') {
  const at = new Date(now()).toISOString();
  const who = await addressesOf(app.db, l);
  await recordConsent(app.db, l.store_id, who.map((w) => ({ ...w, scope: 'marketing' as const, state: 'out' as const, source: LINK, at })));
  for (const w of who) {
    const field = w.channel === 'whatsapp' ? 'phone' : 'email';
    await app.db.query(`UPDATE auto_events SET status = 'skipped', why = 'opted_out' WHERE store_id = $1 AND status = 'waiting' AND kind IN ('cart', 'review') AND lower(contact->>'${field}') = $2`, [l.store_id, w.address]);
  }
  await app.db.query('UPDATE auto_links SET stopped_at = $2 WHERE token = $1', [l.token, at]);
  await event(app.db, l.store_id, 'auto_link_stop', { channel: l.channel, via, channels: who.map((w) => w.channel) });
}

/** "בעצם כן": the link's stop undone, giving back the "yes" it put aside, on the same addresses. */
export async function undoFromLink(app: App, l: StopLink) {
  const at = new Date(now()).toISOString();
  const who = await addressesOf(app.db, l);
  await recordConsent(app.db, l.store_id, who.map((w) => ({ ...w, scope: 'marketing' as const, state: 'in' as const, source: LINK, at })));
  await app.db.query('UPDATE auto_links SET stopped_at = NULL WHERE token = $1', [l.token]);
  await event(app.db, l.store_id, 'auto_link_undo', { channel: l.channel });
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
