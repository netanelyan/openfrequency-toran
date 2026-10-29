import type { Db } from '../db/index.ts';

// What the owner's assistant can read about a store: Toran's own records, never the store's orders or carts (it has
// no access to them yet). Every function takes the store's id and reads only its rows; each returns plain lines the
// model quotes from, with the numbers in them, so the assistant's numbers are always these.

const CHANNEL_HE: Record<string, string> = { whatsapp: 'וואטסאפ', email: 'מייל', instagram: 'אינסטגרם', messenger: 'מסנג׳ר' };
export const channelHe = (c: string) => CHANNEL_HE[c] || c;
// Conversations that are not customers: the pitch page's sample chat, evaluations, the command line.
const NOT_CUSTOMERS = `('pitch', 'eval', 'cli')`;

/** A customer, as the owner is shown them: the channel and a part of the address, never all of it. */
export function who(channel: string, peer: string | null): string {
  const p = String(peer || '');
  const tail = channel === 'email' ? (p.includes('@') ? `${p.slice(0, 2)}…@${p.split('@')[1]}` : '') : p.replace(/\D/g, '').slice(-4);
  return `לקוח ב${channelHe(channel)}${tail ? ` (${channel === 'email' ? tail : `…${tail}`})` : ''}`;
}

const timeHe = (t: Date | string) => new Intl.DateTimeFormat('he-IL', { timeZone: 'Asia/Jerusalem', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(t));
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/**
 * What a customer wrote, as the assistant's tools hand it to the model: inside a marked block that the system prompt
 * calls data, never instructions (index.ts), any look-alike tag inside it taken apart (the audit's PRA-AI-003).
 */
export const customerText = (s: string, n: number) => `<customer_text>${clip(String(s).replace(/<\s*\/?\s*customer_text/gi, 'customer-text'), n)}</customer_text>`;

/** The conversations of the last `days` days, by channel: how many, how many customer messages, answered, handed over. */
export async function overview(db: Db, storeId: number, days: number): Promise<string> {
  const d = Math.max(1, Math.min(90, Math.round(days) || 1));
  const rows = await db.query<{ channel: string; conversations: number; asked: number; answered: number; handed: number }>(
    `SELECT c.channel, COUNT(DISTINCT c.id)::int AS conversations,
            COUNT(m.id) FILTER (WHERE m.role = 'customer')::int AS asked,
            COUNT(m.id) FILTER (WHERE m.role = 'agent' AND m.handoff IS NULL)::int AS answered,
            COUNT(m.id) FILTER (WHERE m.handoff IS NOT NULL)::int AS handed
       FROM conversations c JOIN messages m ON m.conversation_id = c.id
      WHERE c.store_id = $1 AND c.channel NOT IN ${NOT_CUSTOMERS} AND m.at > now() - make_interval(days => $2)
      GROUP BY c.channel ORDER BY 2 DESC`,
    [storeId, d],
  );
  const waitingNow = (await waiting(db, storeId, { raw: true })) as WaitingRow[];
  const span = d === 1 ? 'in the last 24 hours' : `in the last ${d} days`;
  if (!rows.length) return `No customer conversations ${span}. Questions waiting for the owner now: ${waitingNow.length}.`;
  const total = rows.reduce((a, r) => ({ c: a.c + r.conversations, q: a.q + r.asked, a: a.a + r.answered, h: a.h + r.handed }), { c: 0, q: 0, a: 0, h: 0 });
  return [
    `Customer conversations ${span}: ${total.c}. Customer messages: ${total.q}. Answered by Toran on its own: ${total.a}. Handed to the owner: ${total.h}.`,
    ...rows.map((r) => `- ${channelHe(r.channel)}: ${r.conversations} conversations, ${r.asked} customer messages, ${r.answered} answered by Toran, ${r.handed} handed over`),
    `Questions waiting for the owner now: ${waitingNow.length}.`,
  ].join('\n');
}

export type WaitingRow = { id: number; channel: string; peer: string | null; at: string; summary: string | null; question: string | null };

/** The questions Toran handed to the owner in the last 14 days that the owner has not answered in that conversation. */
export async function waiting(db: Db, storeId: number, { raw = false }: { raw?: boolean } = {}): Promise<string | WaitingRow[]> {
  const rows = await db.query<WaitingRow>(
    `SELECT c.id, c.channel, c.peer, h.at, h.handoff->>'summary' AS summary,
            (SELECT q.text FROM messages q WHERE q.conversation_id = c.id AND q.role = 'customer' AND q.id <= h.id ORDER BY q.id DESC LIMIT 1) AS question
       FROM conversations c
       JOIN LATERAL (SELECT id, at, handoff FROM messages WHERE conversation_id = c.id AND handoff IS NOT NULL ORDER BY id DESC LIMIT 1) h ON true
      WHERE c.store_id = $1 AND c.closed_at IS NULL AND c.channel NOT IN ${NOT_CUSTOMERS}
        AND h.at > now() - interval '14 days'
        AND NOT EXISTS (SELECT 1 FROM messages o WHERE o.conversation_id = c.id AND o.role = 'owner' AND o.id > h.id)
      ORDER BY h.at DESC LIMIT 20`,
    [storeId],
  );
  if (raw) return rows;
  if (!rows.length) return 'No questions are waiting for the owner.';
  return [`Questions waiting for the owner: ${rows.length}.`, ...rows.map((r) => `- [conversation ${r.id}] ${who(r.channel, r.peer)}, ${timeHe(r.at)}: ${r.question ? customerText(r.question, 220) : `"${clip(String(r.summary || ''), 220)}"`}`)].join('\n');
}

/** One conversation's last messages, for the owner to see what was said before answering. */
export async function conversation(db: Db, storeId: number, id: number): Promise<string | null> {
  const c = await db.one<{ id: number; channel: string; peer: string | null; agent_paused_until: string | null }>('SELECT id, channel, peer, agent_paused_until FROM conversations WHERE id = $1 AND store_id = $2', [id, storeId]);
  if (!c) return null;
  const msgs = (await db.query<{ role: string; text: string; at: string }>("SELECT role, text, at FROM messages WHERE conversation_id = $1 AND role IN ('customer', 'agent', 'owner') ORDER BY id DESC LIMIT 12", [id])).reverse();
  const by: Record<string, string> = { customer: 'customer', agent: 'Toran', owner: 'the owner' };
  const paused = c.agent_paused_until && new Date(c.agent_paused_until).getTime() > Date.now();
  return [
    `[conversation ${c.id}] ${who(c.channel, c.peer)}. Toran ${paused ? `is paused here until ${timeHe(c.agent_paused_until!)}` : 'answers here'}.`,
    ...msgs.map((m) => `- ${by[m.role]}, ${timeHe(m.at)}: ${m.role === 'customer' ? customerText(m.text.replace(/\s+/g, ' '), 300) : clip(m.text.replace(/\s+/g, ' '), 300)}`),
  ].join('\n');
}

/** What customers asked about in the last `days` days: the products Toran opened most and the words it searched for. */
export async function asked(db: Db, storeId: number, days: number): Promise<string> {
  const d = Math.max(1, Math.min(90, Math.round(days) || 7));
  const calls = await db.query<{ name: string; input: any }>(
    `SELECT t->>'name' AS name, t->'input' AS input
       FROM messages m JOIN conversations c ON c.id = m.conversation_id, jsonb_array_elements(m.tools) t
      WHERE c.store_id = $1 AND c.channel NOT IN ${NOT_CUSTOMERS} AND m.role = 'agent' AND m.at > now() - make_interval(days => $2)`,
    [storeId, d],
  );
  const products = new Map<number, number>();
  const words = new Map<string, number>();
  for (const c of calls) {
    if (c.name === 'get_product' && Number.isInteger(Number(c.input?.product_id))) products.set(Number(c.input.product_id), (products.get(Number(c.input.product_id)) || 0) + 1);
    if (c.name === 'search_products' && c.input?.query) {
      const q = String(c.input.query).trim().toLowerCase().slice(0, 60);
      if (q) words.set(q, (words.get(q) || 0) + 1);
    }
  }
  const top = [...products].sort((a, b) => b[1] - a[1]).slice(0, 8);
  const rows = top.length ? await db.query<{ id: number; title: string; available: boolean }>('SELECT id, title, available FROM products WHERE store_id = $1 AND id = ANY($2::int[])', [storeId, top.map(([id]) => id)]) : [];
  const title = new Map(rows.map((r) => [r.id, r]));
  const span = `in the last ${d} days`;
  if (!top.length && !words.size) return `No product questions ${span}.`;
  return [
    top.length ? `Products customers asked about most ${span}:` : '',
    ...top.filter(([id]) => title.has(id)).map(([id, n]) => `- [id ${id}] ${title.get(id)!.title}: ${n} times, ${title.get(id)!.available ? 'in stock' : 'out of stock'}`),
    words.size ? `What customers searched for ${span}:` : '',
    ...[...words].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([w, n]) => `- "${w}": ${n} times`),
  ].filter(Boolean).join('\n');
}

/** The products out of stock on the store's site, as Toran last read it. */
export async function outOfStock(db: Db, storeId: number): Promise<string> {
  const rows = await db.query<{ id: number; title: string }>('SELECT id, title FROM products WHERE store_id = $1 AND gone_at IS NULL AND available = false ORDER BY title LIMIT 30', [storeId]);
  const n = (await db.one<{ n: number }>('SELECT COUNT(*)::int AS n FROM products WHERE store_id = $1 AND gone_at IS NULL', [storeId]))?.n || 0;
  if (!rows.length) return `All ${n} products on the site are in stock, as Toran last read it.`;
  return [`Out of stock on the site: ${rows.length} of ${n} products, as Toran last read it.`, ...rows.map((r) => `- [id ${r.id}] ${r.title}`)].join('\n');
}
