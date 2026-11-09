import { type Db, J } from '../db/index.ts';

// Which conversation a customer's message belongs to, found or started in one step.
//
// A customer of a store's account (WhatsApp, Messenger, Instagram) has one open conversation with it, and a phone on a
// demo store one with that store, until a week of silence. Two messages of a new customer can be handled at once (two
// worker loops), and a lookup followed by an insert then started two conversations. Here the lookup and the insert run
// in one transaction under an advisory lock on the customer's key, so the second waits for the first and finds its
// conversation; the partial unique indexes of migration 022 are the second guard. Anything slow (Meta's profile name)
// is asked before the transaction, never inside it. Email is not here: a customer's emails keep one conversation per
// thread (channels/store.ts).
//
// A conversation silent for `within` is closed when the customer writes again, and a new one starts; the daily pass
// closes the ones silent for 14 days (jobs/retention.ts). On closing, what an order lookup said about a shipment's
// tracking (its number and link, which can open a page with the recipient's name and address) is taken out of the
// stored tool results; the order's status words stay.

export type OpenSpec = {
  storeId: number;
  channel: string;
  peer: string;
  /** The store's account the customer wrote to; null for a demo conversation (no account). */
  accountId?: number | null;
  /** Asked only when a conversation is started: what goes in its meta (the profile name). */
  meta?: () => Promise<Record<string, unknown>> | Record<string, unknown>;
  within?: string;
};

const keyOf = (s: OpenSpec) => (s.accountId != null ? `conv:a:${s.accountId}:${s.peer}` : `conv:d:${s.storeId}:${s.channel}:${s.peer}`);

async function find(db: Db, s: OpenSpec, within: string) {
  return s.accountId != null
    ? db.one<{ id: number }>(`SELECT id FROM conversations WHERE account_id = $1 AND peer = $2 AND last_at > now() - interval '${within}' AND closed_at IS NULL ORDER BY last_at DESC LIMIT 1`, [s.accountId, s.peer])
    : db.one<{ id: number }>(`SELECT id FROM conversations WHERE store_id = $1 AND peer = $2 AND channel = $3 AND last_at > now() - interval '${within}' AND closed_at IS NULL ORDER BY last_at DESC LIMIT 1`, [s.storeId, s.peer, s.channel]);
}

/** The open conversation for this customer, or a new one: { id, created }. */
export async function openConversation(db: Db, s: OpenSpec): Promise<{ id: number; created: boolean }> {
  const within = s.within || '7 days';
  const hit = await find(db, s, within);
  if (hit) return { id: Number(hit.id), created: false };
  const meta = s.meta ? await s.meta() : {};
  const closed: number[] = [];
  const out = await db.tx(async (t) => {
    await t.query('SELECT pg_advisory_xact_lock(hashtext($1))', [keyOf(s)]);
    const again = await find(t, s, within);
    if (again) return { id: Number(again.id), created: false };
    // The one left open from before the silence is closed, so this customer has one open conversation.
    const old = s.accountId != null
      ? await t.query<{ id: number }>('UPDATE conversations SET closed_at = now() WHERE account_id = $1 AND peer = $2 AND closed_at IS NULL AND channel <> $3 RETURNING id', [s.accountId, s.peer, 'email'])
      : await t.query<{ id: number }>('UPDATE conversations SET closed_at = now() WHERE store_id = $1 AND channel = $2 AND peer = $3 AND account_id IS NULL AND closed_at IS NULL RETURNING id', [s.storeId, s.channel, s.peer]);
    closed.push(...old.map((r) => Number(r.id)));
    const r = await t.one<{ id: number }>('INSERT INTO conversations (store_id, channel, peer, account_id, meta) VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING id', [s.storeId, s.channel, s.peer, s.accountId ?? null, J(meta || {})]);
    return { id: Number(r!.id), created: true };
  });
  if (closed.length) await forgetTracking(db, closed);
  return out;
}

/**
 * The daily pass: close the conversations silent for `days` (email threads stay open, a reply finds its thread by its
 * ids), and take the tracking out of what every conversation that fell silent then kept, email included.
 */
export async function closeSilent(db: Db, days = 14): Promise<number> {
  const d = Math.max(1, Math.floor(days));
  const rows = await db.query<{ id: number }>(`UPDATE conversations SET closed_at = now() WHERE closed_at IS NULL AND channel NOT IN ('pitch', 'eval', 'cli', 'email') AND last_at < now() - interval '${d} days' RETURNING id`);
  const mail = await db.query<{ id: number }>(`SELECT id FROM conversations WHERE channel = 'email' AND last_at < now() - interval '${d} days' AND last_at >= now() - interval '${d + 3} days'`);
  const ids = [...rows, ...mail].map((r) => Number(r.id));
  if (ids.length) await forgetTracking(db, ids);
  return rows.length;
}

/** A get_order_status result without its tracking numbers and links: "- shipped, with Israel Post" stays. */
export function withoutTracking(result: string): string {
  return String(result || '')
    .replace(/,\s*tracking number [^,\n]+/g, '')
    .replace(/,\s*tracking link: \S+/g, '')
    .replace(/Rule: tell the customer this status in your own short words, with the tracking link exactly as written when there is one\./, 'Rule: tell the customer this status in your own short words.');
}

/** Take the shipments' tracking out of the order lookups these conversations kept. */
export async function forgetTracking(db: Db, conversationIds: number[]): Promise<number> {
  if (!conversationIds.length) return 0;
  const rows = await db.query<{ id: number; tools: any[] }>("SELECT id, tools FROM messages WHERE conversation_id = ANY($1::int[]) AND tools @> '[{\"name\": \"get_order_status\"}]'::jsonb", [conversationIds]);
  let n = 0;
  for (const m of rows) {
    const tools = (m.tools || []).map((t: any) => (t?.name === 'get_order_status' && typeof t.result === 'string' ? { ...t, result: withoutTracking(t.result) } : t));
    if (JSON.stringify(tools) === JSON.stringify(m.tools)) continue;
    await db.query('UPDATE messages SET tools = $2::jsonb WHERE id = $1', [m.id, J(tools)]);
    n++;
  }
  return n;
}

/**
 * Is this id one of our own sends coming back (an owner's echo of it): a message kept under "echo:<id>", or one whose
 * delivery holds the id. Two queries, each on its own index (the unique ext_id, and migration 022's GIN on delivery).
 */
export async function sentByUs(db: Db, id: string): Promise<boolean> {
  if (await db.one('SELECT 1 FROM messages WHERE ext_id = $1', [`echo:${id}`])) return true;
  return Boolean(await db.one('SELECT 1 FROM messages WHERE delivery @> $1::jsonb', [J([id])]));
}
