import type { App } from '../app.ts';
import { toIntl } from '../core/urls.ts';
import type { Db } from '../db/index.ts';
import { audit } from '../db/log.ts';
import { mailDomainOf, ownAddresses } from './mailDomain.ts';

// One customer across a store's channels: the same person on WhatsApp, by email, on Messenger and on Instagram, so the
// inbox shows their other conversations beside each one. Only an exact id joins two conversations, never a name, a
// likeness or a guess:
//
//   wrote   the same id on the same channel (a phone, an address) is the same customer, as it always was
//   said    a customer gave an email address or a phone number in a conversation (an email's signature, "my number
//           is 050..."), and that is the id of another conversation of the store, or becomes one later
//   owner   the owner said in the inbox "זה אותו לקוח"; "זה לא אותו לקוח" splits one off again (apart), and what the
//           owner split is never joined again by what someone said
//
// What someone said joins only once: an id two different customers gave is left with the first. The store's own
// addresses and numbers, and ours, are never anyone's. The agent never reads another conversation: a customer who
// types someone else's address learns nothing from it; only the owner sees the link.

export type Id = { channel: string; value: string };
type Row = { channel: string; value: string; customer_id: number; how: 'wrote' | 'said' | 'owner' | 'apart'; conversation_id: number | null };

const EMAIL = /[a-z0-9][a-z0-9._%+-]{0,63}@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}/gi;
// An Israeli mobile in any common form (050-0000000, 050 000 0000, +972 50-000-0000, 972500000000), or an
// international number written with its "+".
const PHONE = /(?<![\d+])(?:(?:\+|00)?972[\s-]?0?5\d(?:[\s-]?\d){7}|05\d(?:[\s-]?\d){7}|\+[1-9](?:[\s-]?\d){7,13})(?!\d)/g;

/** The email addresses and phone numbers a message gives, as channel ids (an address; a WhatsApp number's digits). */
export function idsIn(text: string): Id[] {
  const out = new Map<string, Id>();
  const t = String(text || '').slice(0, 4000);
  for (const m of t.matchAll(EMAIL)) {
    const value = m[0].toLowerCase().replace(/\.+$/, '');
    out.set(`email:${value}`, { channel: 'email', value });
  }
  const noMail = t.replace(EMAIL, ' ');
  for (const m of noMail.matchAll(PHONE)) {
    const value = toIntl(m[0]);
    if (value) out.set(`whatsapp:${value}`, { channel: 'whatsapp', value });
  }
  return [...out.values()].slice(0, 5);
}

/** The ids that are the store's own, or ours: never a customer's. */
async function notACustomer(app: App, storeId: number): Promise<(id: Id) => boolean> {
  const s = await app.db.one<any>('SELECT domain, contact_email, contact_whatsapp, contact_phone FROM stores WHERE id = $1', [storeId]);
  const accounts = await app.db.query<{ external_id: string; meta: any }>('SELECT external_id, meta FROM channel_accounts WHERE store_id = $1', [storeId]);
  const d = await mailDomainOf(app, storeId);
  const env = app.env;
  const numbers = new Set([s?.contact_whatsapp, toIntl(s?.contact_phone || ''), env.DEMO_WA_NUMBER, env.TORAN_ASSISTANT_WA, env.TWILIO_WHATSAPP_FROM, env.TORAN_OWNER_WHATSAPP, ...accounts.map((a) => a.meta?.display_phone || a.meta?.phone || a.external_id)].map((n) => String(n || '').replace(/\D/g, '')).filter(Boolean));
  const addresses = new Set([s?.contact_email, ...accounts.map((a) => a.external_id), ...ownAddresses(d)].map((a) => String(a || '').toLowerCase()).filter((a) => a.includes('@')));
  const domains = [s?.domain, d?.domain, d?.receiving, app.mail?.domain, 'openfrequency.co.il'].map((x) => String(x || '').toLowerCase()).filter(Boolean);
  return (id) => {
    if (id.channel === 'whatsapp') return numbers.has(id.value);
    const host = id.value.split('@')[1] || '';
    return addresses.has(id.value) || domains.some((x) => host === x || host.endsWith(`.${x}`));
  };
}

const rowOf = (db: Db, storeId: number, id: Id) => db.one<Row>('SELECT channel, value, customer_id, how, conversation_id FROM customer_ids WHERE store_id = $1 AND channel = $2 AND value = $3', [storeId, id.channel, id.value]);

/** This id's row, made (as "wrote", a customer of its own) when it has none yet. */
async function ensure(db: Db, storeId: number, id: Id, conversationId: number): Promise<Row> {
  const row = await rowOf(db, storeId, id);
  if (row) return row;
  const c = await db.one<{ id: number }>('INSERT INTO customers (store_id) VALUES ($1) RETURNING id', [storeId]);
  await db.query("INSERT INTO customer_ids (store_id, channel, value, customer_id, how, conversation_id) VALUES ($1, $2, $3, $4, 'wrote', $5)", [storeId, id.channel, id.value, c!.id, conversationId]);
  return { ...id, customer_id: c!.id, how: 'wrote', conversation_id: conversationId };
}

/** Every id of customer `from` becomes customer `into`'s. */
async function merge(db: Db, from: number, into: number) {
  if (from === into) return;
  await db.query('UPDATE customer_ids SET customer_id = $2 WHERE customer_id = $1', [from, into]);
  await db.query('DELETE FROM customers WHERE id = $1', [from]);
}

/**
 * A customer's message on one of the store's own channels: the addresses and numbers it gives join this customer to
 * the conversations they are the ids of (now, or when one of them writes later). Returns the ids joined.
 */
export async function noteCustomer(app: App, storeId: number, conversationId: number, me: Id, text: string): Promise<Id[]> {
  const ids = idsIn(text).filter((id) => !(id.channel === me.channel && id.value === me.value));
  if (!ids.length) return [];
  const skip = await notACustomer(app, storeId);
  const joined: Id[] = [];
  for (const id of ids) {
    if (skip(id)) continue;
    await app.db.tx(async (db) => {
      const mine = await ensure(db, storeId, me, conversationId);
      const theirs = await rowOf(db, storeId, id);
      if (!theirs) {
        await db.query("INSERT INTO customer_ids (store_id, channel, value, customer_id, how, conversation_id) VALUES ($1, $2, $3, $4, 'said', $5)", [storeId, id.channel, id.value, mine.customer_id, conversationId]);
        joined.push(id);
        return;
      }
      if (theirs.customer_id === mine.customer_id) return;
      // Someone else gave it first, or the owner split one of the two off: left as it is.
      if (theirs.how === 'said' || theirs.how === 'apart' || mine.how === 'apart') return;
      await merge(db, theirs.customer_id, mine.customer_id);
      joined.push(id);
    });
  }
  return joined;
}

type Conv = { id: number; store_id: number; channel: string; peer: string | null; account_id: number | null };
const convOf = (app: App, id: number) => app.db.one<Conv>('SELECT id, store_id, channel, peer, account_id FROM conversations WHERE id = $1', [id]);

/** Can these two be joined or split by the owner? Two conversations of one store, each on its own channels, with a customer. */
async function pair(app: App, a: number, b: number): Promise<[Conv, Conv] | null> {
  const [x, y] = [await convOf(app, a), await convOf(app, b)];
  if (!x || !y || x.id === y.id || x.store_id !== y.store_id || !x.peer || !y.peer || !x.account_id || !y.account_id) return null;
  return [x, y];
}

/** "זה אותו לקוח": the owner joins the other conversation's customer to this one's. */
export async function sameCustomer(app: App, conversationId: number, otherId: number, by: string): Promise<boolean> {
  const p = await pair(app, conversationId, otherId);
  if (!p) return false;
  const [x, y] = p;
  if (x.channel === y.channel && x.peer === y.peer) return true; // the same id is the same customer already
  await app.db.tx(async (db) => {
    const mine = await ensure(db, x.store_id, { channel: x.channel, value: x.peer! }, x.id);
    const theirs = await ensure(db, y.store_id, { channel: y.channel, value: y.peer! }, y.id);
    await merge(db, theirs.customer_id, mine.customer_id);
    // Both ids are now the owner's word, which what someone says later never undoes.
    await db.query("UPDATE customer_ids SET how = 'owner', conversation_id = $4 WHERE store_id = $1 AND channel = $2 AND value = $3", [y.store_id, y.channel, y.peer, y.id]);
    await db.query("UPDATE customer_ids SET how = 'owner' WHERE store_id = $1 AND channel = $2 AND value = $3 AND how IN ('wrote', 'apart')", [x.store_id, x.channel, x.peer]);
  });
  await audit(app.db, { actor: by, action: 'same_customer', storeId: x.store_id, detail: { conversationId, other: otherId } });
  return true;
}

/**
 * "זה לא אותו לקוח": the other conversation's id is split off into a customer of its own, with what was said in its
 * conversations, and what someone says later never joins it back.
 */
export async function apartCustomer(app: App, conversationId: number, otherId: number, by: string): Promise<boolean> {
  const p = await pair(app, conversationId, otherId);
  if (!p) return false;
  const [x, y] = p;
  if (x.channel === y.channel && x.peer === y.peer) return false; // the same id is the same customer
  await app.db.tx(async (db) => {
    const theirs = await rowOf(db, y.store_id, { channel: y.channel, value: y.peer! });
    if (!theirs) return;
    const c = await db.one<{ id: number }>('INSERT INTO customers (store_id) VALUES ($1) RETURNING id', [y.store_id]);
    await db.query("UPDATE customer_ids SET customer_id = $4, how = 'apart', conversation_id = $5 WHERE store_id = $1 AND channel = $2 AND value = $3", [y.store_id, y.channel, y.peer, c!.id, y.id]);
    // What was said in the other's own conversations goes with it.
    await db.query("UPDATE customer_ids SET customer_id = $2 WHERE customer_id = $3 AND how = 'said' AND conversation_id IN (SELECT id FROM conversations WHERE store_id = $1 AND channel = $4 AND peer = $5)", [y.store_id, c!.id, theirs.customer_id, y.channel, y.peer]);
  });
  await audit(app.db, { actor: by, action: 'apart_customer', storeId: x.store_id, detail: { conversationId, other: otherId } });
  return true;
}

export type Why = 'same' | 'wrote' | 'said' | 'owner';

/**
 * The customer's other conversations on the store's own channels: the same id's (another email thread, a week-old
 * chat), and those of every id joined to it, each with why. The ROW_SQL columns come with them (web/inbox.ts).
 */
export async function otherConversations(app: App, conversationId: number, rowSql: string): Promise<(Record<string, any> & { why: Why })[]> {
  const me = await convOf(app, conversationId);
  if (!me?.peer || !me.account_id) return [];
  const mine = await rowOf(app.db, me.store_id, { channel: me.channel, value: me.peer });
  const ids = mine ? await app.db.query<Row>('SELECT channel, value, how FROM customer_ids WHERE customer_id = $1', [mine.customer_id]) : [{ channel: me.channel, value: me.peer, how: 'wrote' as const }];
  const rows = await app.db.query<any>(
    `SELECT ${rowSql}, c.peer, c.meta->>'name' AS name FROM conversations c
     JOIN (SELECT * FROM unnest($3::text[], $4::text[]) AS t(channel, value)) ids ON ids.channel = c.channel AND ids.value = c.peer
     WHERE c.store_id = $1 AND c.account_id IS NOT NULL AND c.id <> $2 ORDER BY c.last_at DESC LIMIT 20`,
    [me.store_id, me.id, ids.map((i) => i.channel), ids.map((i) => i.value)],
  );
  const how = new Map(ids.map((i) => [`${i.channel}:${i.value}`, i.how]));
  return rows.map((r) => ({ ...r, why: r.channel === me.channel && r.peer === me.peer ? 'same' : ((how.get(`${r.channel}:${r.peer}`) || 'wrote') as Why) }));
}

/** The store's other recent conversations the owner may say are this customer's. */
export async function candidates(app: App, conversationId: number, exclude: number[], rowSql: string): Promise<Record<string, any>[]> {
  const me = await convOf(app, conversationId);
  if (!me?.peer || !me.account_id) return [];
  return app.db.query<any>(
    `SELECT ${rowSql}, c.peer, c.meta->>'name' AS name FROM conversations c WHERE c.store_id = $1 AND c.account_id IS NOT NULL AND c.peer IS NOT NULL AND c.id <> $2 AND NOT (c.channel = $3 AND c.peer = $4) AND NOT (c.id = ANY($5::int[])) ORDER BY c.last_at DESC LIMIT 30`,
    [me.store_id, me.id, me.channel, me.peer, exclude],
  );
}
