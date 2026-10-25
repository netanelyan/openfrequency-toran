import type { App } from '../app.ts';
import { afterQuiet, customerQuiet, DAY, now } from '../core/clock.ts';
import { open } from '../core/secrets.ts';
import { J } from '../db/index.ts';
import { audit, event, usage } from '../db/log.ts';
import { displayName } from '../ingest/brand.ts';
import { enqueue } from '../jobs/queue.ts';
import { cloudSend, GraphError, TOKEN_GONE } from '../channels/meta.ts';
import { needsReconnect } from '../channels/waStore.ts';
import { ownAddress } from '../channels/mailDomain.ts';
import { enabledChannels } from '../channels/config.ts';
import { orderAccessOf } from '../orders.ts';
import { addressOf, consentOf, recordConsent } from './consent.ts';
import { complete, emailText, firstName, isKind, KIND_KEYS, KINDS, kindOf, MESSAGES, waText, type Kind, type MessageKey } from './messages.ts';
import type { Happening, Placed, Read } from './platforms.ts';
import { approvedFor, storeWa } from './templates.ts';

// The automatic messages, from what happened at the store to a message in the customer's conversation:
//
//   record()    a platform's Read (platforms.ts) becomes rows of auto_events, once each by the platform's own id, for
//               the kinds the owner turned on and only for what happened since they did. The consents it carries
//               are kept (consent.ts). An order placed drops the cart reminder of its checkout and any earlier one of
//               the same person; a payment drops the "waiting" and "failed" of its order; a delivery, the "shipped" not
//               sent yet.
//   sendDue()   the worker, each minute: every row whose time has come is delivered or dropped, with why.
//
// deliver() decides, in code, in this order, and records every "no" with its reason:
//   - the kind is still on; it is not quiet now in Israel (the night, Shabbat, a holiday: core/clock.ts), else it
//     waits for the next hour that is not; it is not too late (a cart two days after it was due, the rest four)
//   - a cart: no order was placed since; a cart or a review: the customer has not written to the store since
//   - not this message to this person for this order before, and no cart or review to them in the last day
//   - WhatsApp first: the owner turned it on for the kind, the store's own number is connected (never our demo
//     number), every template of the kind is approved, the order has a phone, and the customer allows it (marketing:
//     their "yes" from the checkout; anything: no "הסר")
//   - else email: turned on, the store's email connected, an address on the order, not bounced, allowed the same way
// What goes out is kept in the customer's conversation on that channel (role agent, messages.auto says which), so the
// inbox shows it and an answer to it lands beside it. It is the store's side of the conversation, so it counts
// nothing in the plan until the customer answers (plans.ts counts the customers' messages).

const MINUTE = 60_000;
/** Nothing older than this is ever recorded, whatever a reading brings back. */
const MAX_AGE = 7 * DAY;
/**
 * How long past its time a message may still go out: a cart two days (one left on a Friday afternoon waits for
 * Sunday morning), the rest four (Rosh Hashana beside Shabbat is three days and their nights).
 */
const LATE: Record<Kind, number> = { cart: 2 * DAY, payment: 4 * DAY, shipping: 4 * DAY, review: 4 * DAY };
/** A review counted from the shipment, where the platform never says delivered: this much more for the delivery. */
const TRANSIT = 2 * DAY;

export class AutoError extends Error {
  he: string;
  constructor(message: string, he: string) {
    super(message);
    this.he = he;
  }
}

export type Setting = { kind: Kind; whatsapp: boolean; email: boolean; delay_minutes: number | null; link: string | null; on_since: string | null };
const isOn = (s: Setting | undefined) => Boolean(s && (s.whatsapp || s.email));

/** The owner's settings for every kind; a kind with no row is off. */
export async function settingsOf(app: App, storeId: number): Promise<Record<Kind, Setting>> {
  const rows = await app.db.query<Setting>('SELECT kind, whatsapp, email, delay_minutes, link, on_since FROM auto_settings WHERE store_id = $1', [storeId]);
  const out = Object.fromEntries(KIND_KEYS.map((k) => [k, { kind: k, whatsapp: false, email: false, delay_minutes: KINDS[k].delay?.default ?? null, link: null, on_since: null }])) as Record<Kind, Setting>;
  for (const r of rows) if (isKind(r.kind)) out[r.kind] = { ...r, delay_minutes: r.delay_minutes ?? KINDS[r.kind].delay?.default ?? null };
  return out;
}

export const anyOn = (s: Record<Kind, Setting>) => KIND_KEYS.some((k) => isOn(s[k]));

/** The store's email channel, when it is connected and email is on here. */
export async function storeEmail(app: App, storeId: number) {
  if (!app.mail || !enabledChannels(app.env).has('email')) return null;
  return app.db.one<{ id: number; external_id: string }>("SELECT id, external_id FROM channel_accounts WHERE store_id = $1 AND channel = 'email' AND status = 'active' ORDER BY id DESC LIMIT 1", [storeId]);
}

const httpsLink = (s: string) => {
  try {
    const u = new URL(s.trim());
    return u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
};

/** The owner's choice for one kind, checked: WhatsApp only once its templates are approved, email once it is connected. */
export async function saveSetting(app: App, storeId: number, kind: Kind, input: { whatsapp: boolean; email: boolean; delay?: number | null; link?: string | null }, by: string) {
  const access = await orderAccessOf(app.db, storeId);
  if ((input.whatsapp || input.email) && access?.status !== 'active') throw new AutoError('no order access', 'קודם מחברים את ההזמנות של החנות, ב"מה תורן יודע". משם תורן יודע מה קרה בחנות.');
  if (input.whatsapp) {
    const wa = await storeWa(app, storeId);
    if (!wa) throw new AutoError('no store WhatsApp', 'בשביל וואטסאפ צריך לחבר קודם את המספר של החנות.');
    const t = await approvedFor(app, wa.id, kind);
    if (!t.ok) throw new AutoError(`templates not approved: ${t.missing.join(', ')}`, 'אי אפשר להפעיל בוואטסאפ לפני ש-Meta מאשרת את התבניות של ההודעה הזו. רואים כאן למטה איפה כל תבנית עומדת.');
  }
  if (input.email && !(await storeEmail(app, storeId))) throw new AutoError('no store email', 'בשביל מייל צריך לחבר קודם את המייל של החנות.');
  const def = KINDS[kind].delay;
  const delay = def ? (def.options.some((o) => o.minutes === Number(input.delay)) ? Number(input.delay) : def.default) : null;
  let link: string | null = null;
  if (kind === 'review') {
    link = input.link ? httpsLink(input.link) : null;
    if ((input.whatsapp || input.email) && !link) throw new AutoError('no review link', 'צריך לינק לדף שבו כותבים ביקורת, שמתחיל ב-https://. למשל הדף של החנות בגוגל.');
  }
  const prev = (await settingsOf(app, storeId))[kind];
  const on = input.whatsapp || input.email;
  // Turned on now: from this moment. Already on: the moment it was turned on stays. Off: none.
  const since = on ? (isOn(prev) && prev.on_since ? prev.on_since : new Date(now()).toISOString()) : null;
  await app.db.query(
    `INSERT INTO auto_settings (store_id, kind, whatsapp, email, delay_minutes, link, on_since, updated_by, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
     ON CONFLICT (store_id, kind) DO UPDATE SET whatsapp = EXCLUDED.whatsapp, email = EXCLUDED.email, delay_minutes = EXCLUDED.delay_minutes, link = EXCLUDED.link, on_since = EXCLUDED.on_since, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [storeId, kind, input.whatsapp, input.email, delay, link, since, by],
  );
  // Turned off: what was waiting for this kind is not sent.
  if (!on) await app.db.query("UPDATE auto_events SET status = 'skipped', why = 'off' WHERE store_id = $1 AND kind = $2 AND status = 'waiting'", [storeId, kind]);
  await audit(app.db, { actor: by, action: 'auto_setting', storeId, detail: { kind, whatsapp: input.whatsapp, email: input.email, delay, link: Boolean(link) } });
  // The first kind on: the store's source is set up (its webhooks registered where the key allows), in the worker.
  if (on && !(await app.db.one('SELECT 1 FROM auto_sources WHERE store_id = $1', [storeId]))) await enqueue(app.db, 'auto_setup', { storeId }, { dedupeKey: `auto_setup:${storeId}`, maxAttempts: 2 });
}

const baseOf = (key: string) => key.slice(0, key.lastIndexOf(':'));
const SUPERSEDES: Partial<Record<MessageKey, MessageKey[]>> = { paid: ['pending', 'failed'], delivered: ['shipped'] };

/** Keep what one reading or webhook brought: consents, orders placed, and the messages they may cause. */
export async function record(app: App, storeId: number, platform: string, read: Read, source: 'webhook' | 'poll') {
  const settings = await settingsOf(app, storeId);
  await recordConsent(app.db, storeId, read.consent);
  for (const p of read.placed) await placed(app, storeId, platform, p, isOn(settings.cart));
  let added = 0;
  for (const h of read.happenings) if (await happen(app, storeId, settings, h, source)) added++;
  return added;
}

async function placed(app: App, storeId: number, platform: string, p: Placed, cartOn: boolean) {
  const keys = p.checkout ? [`${platform}:checkout:${p.checkout}:cart`, `${platform}:order:${p.checkout}:cart`] : [];
  await app.db.query(
    `UPDATE auto_events SET status = 'skipped', why = 'ordered' WHERE store_id = $1 AND status = 'waiting' AND message = 'cart'
       AND (key = ANY($2::text[]) OR (happened_at <= $3 AND ((contact->>'phone') = $4 OR (contact->>'email') = $5)))`,
    [storeId, keys, p.at, p.contact.phone || '-', p.contact.email || '-'],
  );
  // Kept while carts are on, so a checkout read after its order (a reading's order) is still known to be ordered.
  if (cartOn) await app.db.query("INSERT INTO auto_events (store_id, key, kind, message, ref, contact, vars, source, happened_at, due_at, status, why) VALUES ($1, $2, 'order', 'placed', $3, $4::jsonb, $5::jsonb, 'platform', $6, $6, 'noted', NULL) ON CONFLICT (store_id, key) DO NOTHING", [storeId, `${platform}:placed:${p.id}`, p.id, J(p.contact), J({ checkout: p.checkout }), p.at]);
}

async function happen(app: App, storeId: number, settings: Record<Kind, Setting>, h: Happening, source: string): Promise<boolean> {
  const kind = kindOf(h.message);
  const st = settings[kind];
  const at = new Date(h.at).getTime();
  // A payment arrived, or the parcel did: what it makes untrue is not sent, whether or not this kind is on.
  for (const m of SUPERSEDES[h.message] || []) await app.db.query("UPDATE auto_events SET status = 'skipped', why = $3 WHERE store_id = $1 AND key = $2 AND status = 'waiting'", [storeId, `${baseOf(h.key)}:${m}`, h.message]);
  if (!isOn(st) || !st.on_since || !Number.isFinite(at) || at < new Date(st.on_since).getTime() || at < now() - MAX_AGE) return false;
  const delay = (st.delay_minutes || 0) * MINUTE;
  const due = h.message === 'cart' ? at + delay : h.message === 'review' ? at + delay + (h.after === 'shipped' ? TRANSIT : 0) : now();
  const r = await app.db.query<{ id: number; inserted: boolean }>(
    `INSERT INTO auto_events (store_id, key, kind, message, ref, contact, vars, source, happened_at, due_at) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10)
     ON CONFLICT (store_id, key) DO UPDATE SET contact = EXCLUDED.contact, vars = EXCLUDED.vars,
       -- a review counted from the shipment moves to the delivery's time once the carrier says it arrived
       due_at = CASE WHEN auto_events.message = 'review' AND $11 THEN EXCLUDED.due_at ELSE auto_events.due_at END
     WHERE auto_events.status = 'waiting'
     RETURNING id, (xmax = 0) AS inserted`,
    [storeId, h.key, kind, h.message, h.ref, J(h.contact), J(h.vars), source, new Date(at).toISOString(), new Date(due).toISOString(), h.after === 'delivered'],
  );
  return Boolean(r[0]?.inserted);
}

/** Deliver every message whose time has come (the worker, each minute). */
export async function sendDue(app: App, { limit = 50 }: { limit?: number } = {}) {
  const rows = await app.db.query<any>(
    `UPDATE auto_events SET status = 'sending' WHERE id IN (SELECT id FROM auto_events WHERE status = 'waiting' AND due_at <= $1 ORDER BY due_at, id LIMIT ${Number(limit) || 50}) RETURNING *`,
    [new Date(now()).toISOString()],
  );
  const out: Record<string, number> = {};
  for (const ev of rows) {
    let r: Outcome;
    try {
      r = await deliver(app, ev);
    } catch (e: any) {
      r = { status: 'failed', why: String(e?.message || e).slice(0, 300) };
      app.log(`[auto] event ${ev.id} (store ${ev.store_id}, ${ev.message}) failed: ${r.why}`);
    }
    if (r.status === 'waiting') await app.db.query("UPDATE auto_events SET status = 'waiting', due_at = $2 WHERE id = $1", [ev.id, new Date(r.until).toISOString()]);
    else if (r.status === 'sent') await app.db.query("UPDATE auto_events SET status = 'sent', why = NULL, basis = $2, channel = $3, conversation_id = $4, sent_at = $5 WHERE id = $1", [ev.id, r.basis, r.channel, r.conversationId, new Date(now()).toISOString()]);
    else await app.db.query('UPDATE auto_events SET status = $2, why = $3 WHERE id = $1', [ev.id, r.status, r.why]);
    out[r.status] = (out[r.status] || 0) + 1;
    if (r.status !== 'waiting') await event(app.db, ev.store_id, `auto_${r.status}`, { id: ev.id, message: ev.message, ...(r.status === 'sent' ? { channel: r.channel } : { why: r.why }) });
  }
  return out;
}

type Outcome = { status: 'sent'; channel: 'whatsapp' | 'email'; basis: string; conversationId: number } | { status: 'skipped' | 'failed'; why: string } | { status: 'waiting'; until: number };

async function deliver(app: App, ev: any): Promise<Outcome> {
  const kind = ev.kind as Kind;
  const m = ev.message as MessageKey;
  const st = (await settingsOf(app, ev.store_id))[kind];
  if (!isOn(st)) return { status: 'skipped', why: 'off' };
  const t = now();
  if (customerQuiet(t)) return { status: 'waiting', until: afterQuiet(t) };
  if (t - new Date(ev.due_at).getTime() > LATE[kind]) return { status: 'skipped', why: 'late' };
  const c = ev.contact || {};
  const marketing = KINDS[kind].marketing;
  if (m === 'cart') {
    const ordered = await app.db.one(
      `SELECT 1 FROM auto_events WHERE store_id = $1 AND message = 'placed' AND (vars->>'checkout' = $2 OR (happened_at >= $3 AND ((contact->>'phone') = $4 OR (contact->>'email') = $5))) LIMIT 1`,
      [ev.store_id, ev.key.split(':').slice(-2, -1)[0], ev.happened_at, c.phone || '-', c.email || '-'],
    );
    if (ordered) return { status: 'skipped', why: 'ordered' };
  }
  if (marketing) {
    const wrote = await app.db.one(
      `SELECT 1 FROM messages x JOIN conversations v ON v.id = x.conversation_id WHERE v.store_id = $1 AND x.role = 'customer' AND x.at > $2 AND ((v.channel = 'whatsapp' AND v.peer = $3) OR (v.channel = 'email' AND v.peer = $4)) LIMIT 1`,
      [ev.store_id, ev.happened_at, c.phone || '-', c.email || '-'],
    );
    if (wrote) return { status: 'skipped', why: 'replied' };
  }
  const same = await app.db.one(
    "SELECT 1 FROM auto_events WHERE store_id = $1 AND id <> $2 AND status = 'sent' AND message = $3 AND ref = $4 AND ((contact->>'phone') = $5 OR (contact->>'email') = $6) LIMIT 1",
    [ev.store_id, ev.id, m, ev.ref, c.phone || '-', c.email || '-'],
  );
  if (same) return { status: 'skipped', why: 'duplicate' };
  if (marketing) {
    const recent = await app.db.one(
      "SELECT 1 FROM auto_events WHERE store_id = $1 AND status = 'sent' AND message = $2 AND sent_at > $3 AND ((contact->>'phone') = $4 OR (contact->>'email') = $5) LIMIT 1",
      [ev.store_id, m, new Date(t - DAY).toISOString(), c.phone || '-', c.email || '-'],
    );
    if (recent) return { status: 'skipped', why: 'recent' };
  }

  const s = await app.db.one<any>('SELECT name, domain, brand, brand_override FROM stores WHERE id = $1', [ev.store_id]);
  const store = displayName(s?.brand_override?.name, s?.brand?.name, s?.name) || s?.domain;
  const vars = { name: firstName(c.name), order: String(ev.vars?.order || ev.ref || ''), link: m === 'review' ? String(st.link || '') : String(ev.vars?.link || '') };
  const no: string[] = [];

  if (st.whatsapp) {
    const wa = await storeWa(app, ev.store_id);
    const phone = addressOf('whatsapp', c.phone);
    const ok = wa ? await approvedFor(app, wa.id, kind) : null;
    const allowed = phone ? await consentOf(app.db, ev.store_id, 'whatsapp', phone) : null;
    if (!wa) no.push('whatsapp: not connected');
    else if (!ok!.ok) no.push('whatsapp: template not approved');
    else if (!phone) no.push('whatsapp: no phone');
    else if (!allowed!.updates) no.push('whatsapp: opted out');
    else if (marketing && !allowed!.marketing) no.push('whatsapp: no consent');
    else if (!complete(m, vars)) no.push('whatsapp: no link');
    else {
      const { params, text } = waText(m, store, vars);
      const name = MESSAGES[m].template;
      let id: string;
      try {
        id = (await cloudSend(app.env, app.graph, wa.external_id, open(app.env, wa.secret!), phone, { template: { name, sid: name, vars: params } })).id;
      } catch (e: any) {
        if (e instanceof GraphError && e.code === TOKEN_GONE) await needsReconnect(app, wa.id, 'token');
        return { status: 'failed', why: `whatsapp: ${String(e?.message || e).slice(0, 240)}` };
      }
      const conversationId = await keep(app, ev, 'whatsapp', wa.id, phone, text, id, null);
      await usage(app.db, { storeId: ev.store_id, conversationId, kind: 'bsp', backend: 'meta', units: 1, usd: 0, apiUsd: 0, tag: 'wa_template' });
      return { status: 'sent', channel: 'whatsapp', basis: marketing ? `consent ${allowed!.source}` : "the order's phone", conversationId };
    }
  }
  if (st.email) {
    const account = await storeEmail(app, ev.store_id);
    const to = addressOf('email', c.email);
    const allowed = to ? await consentOf(app.db, ev.store_id, 'email', to) : null;
    const bounced = to ? await app.db.one('SELECT 1 FROM mail_suppressed WHERE address = $1', [to]) : null;
    if (!account) no.push('email: not connected');
    else if (!to) no.push('email: no address');
    else if (bounced) no.push('email: suppressed');
    else if (!allowed!.updates) no.push('email: opted out');
    else if (marketing && !allowed!.marketing) no.push('email: no consent');
    else if (m !== 'shipped' && !complete(m, vars)) no.push('email: no link');
    else {
      const { subject, text } = emailText(m, store, vars);
      const own = await ownAddress(app, ev.store_id);
      const replyTo = own?.replyTo || account.external_id;
      const headers: Record<string, string> = { 'Auto-Submitted': 'auto-generated', ...(marketing ? { 'List-Unsubscribe': `<mailto:${replyTo}?subject=${encodeURIComponent('הסר')}>` } : {}) };
      const sent = await app.mail!.send(to, text, { channel: 'email', from: to, text: '', id: `auto-${ev.id}`, account: account.external_id, subject }, { who: 'agent', storeName: store, ...(own || {}), subject, headers });
      const conversationId = await keep(app, ev, 'email', account.id, to, text, sent.id, subject);
      await usage(app.db, { storeId: ev.store_id, conversationId, kind: 'mail', backend: app.mail!.kind, units: 1, usd: 0, apiUsd: 0, tag: 'mail_auto' });
      return { status: 'sent', channel: 'email', basis: marketing ? `consent ${allowed!.source}` : "the order's email", conversationId };
    }
  }
  return { status: 'skipped', why: no.join('; ') || 'no channel' };
}

/** The message, in the customer's conversation on that channel: the open one on WhatsApp, a new thread by email. */
async function keep(app: App, ev: any, channel: 'whatsapp' | 'email', accountId: number, peer: string, text: string, sentId: string, subject: string | null): Promise<number> {
  let c = channel === 'whatsapp' ? await app.db.one<{ id: number }>("SELECT id FROM conversations WHERE account_id = $1 AND peer = $2 AND last_at > now() - interval '7 days' AND closed_at IS NULL ORDER BY last_at DESC LIMIT 1", [accountId, peer]) : null;
  // An email starts a thread of its own; the customer's answer ("Re:" and the same subject) finds it (channels/store.ts).
  c ??= await app.db.one<{ id: number }>('INSERT INTO conversations (store_id, channel, peer, account_id, meta) VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING id', [ev.store_id, channel, peer, accountId, J(channel === 'email' ? { subject, bare: String(subject || '').trim().toLowerCase(), ids: [] } : {})]);
  await app.db.query("INSERT INTO messages (conversation_id, role, text, author, auto, delivery) VALUES ($1, 'agent', $2, 'אוטומטי', $3, $4::jsonb)", [c!.id, text, ev.message, J([sentId])]);
  await app.db.query('UPDATE conversations SET last_at = now() WHERE id = $1', [c!.id]);
  return c!.id;
}

/** The latest automatic message in a conversation, for the agent's context when the customer answers it. */
export async function lastAuto(app: App, conversationId: number): Promise<string | undefined> {
  const r = await app.db.one<{ text: string; auto: string }>("SELECT text, auto FROM messages WHERE conversation_id = $1 AND auto IS NOT NULL AND at > now() - interval '7 days' ORDER BY id DESC LIMIT 1", [conversationId]);
  if (!r || !(r.auto in MESSAGES)) return undefined;
  return `Before the customer wrote, the store sent them an automatic message (${r.auto}): "${r.text.slice(0, 400)}". If they answer it, answer as the store; you do not know more about their order than it says.`;
}
