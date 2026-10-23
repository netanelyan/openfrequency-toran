import type { App } from '../app.ts';
import { HOUR, now } from '../core/clock.ts';
import { J } from '../db/index.ts';
import { audit, event } from '../db/log.ts';
import { displayName } from '../ingest/brand.ts';
import { adapterFor } from './adapters.ts';
import { blockedFor, reply, type Blocked, type Delivery } from './send.ts';
import type { Channel, ChannelAdapter, Inbound } from './types.ts';

// The store's owner in a conversation, on any channel: they answer from the inbox, and the agent steps back.
//
//   ownerReply()   sends the owner's text to the customer through the conversation's own channel, after the same
//                  checks as any send (the window, a suppressed address), and pauses the agent there for
//                  PAUSE_HOURS from the owner's last message
//   resumeAgent()  "להחזיר לתורן": the agent answers again from the next message
//   hold()         a customer message kept without an answer (the agent is paused, or the mail was automated)

export const PAUSE_HOURS = 12;

export async function isPaused(app: App, conversationId: number): Promise<boolean> {
  return Boolean(await app.db.one('SELECT 1 FROM conversations WHERE id = $1 AND agent_paused_until > now()', [conversationId]));
}

/** Keep a customer message without answering it. */
export async function hold(app: App, conversationId: number, inbound: Inbound, { automated = null }: { automated?: string | null } = {}) {
  await app.db.query('INSERT INTO messages (conversation_id, role, text, ext_id, attachments, automated) VALUES ($1, $2, $3, $4, $5::jsonb, $6) ON CONFLICT (ext_id) DO NOTHING', [conversationId, 'customer', inbound.text || '', inbound.id, J(inbound.attachments || []), automated]);
  await app.db.query('UPDATE conversations SET last_at = now() WHERE id = $1', [conversationId]);
}

type Target = { adapter: ChannelAdapter; to: Inbound; storeId: number; storeName: string; pausedUntil: number | null };

/** Who a reply in this conversation goes to, rebuilt from what the conversation kept; null when the customer never wrote. */
export async function replyTarget(app: App, conversationId: number): Promise<Target | null> {
  const c = await app.db.one<any>('SELECT c.id, c.channel, c.peer, c.meta, c.agent_paused_until, s.id AS store_id, s.name, s.domain, s.brand, s.brand_override, a.external_id AS account FROM conversations c JOIN stores s ON s.id = c.store_id LEFT JOIN channel_accounts a ON a.id = c.account_id WHERE c.id = $1', [conversationId]);
  if (!c?.peer) return null;
  const last = await app.db.one<{ ext_id: string | null; at: string }>("SELECT ext_id, at FROM messages WHERE conversation_id = $1 AND role = 'customer' ORDER BY id DESC LIMIT 1", [conversationId]);
  if (!last) return null;
  const adapter = adapterFor(app, c.channel as Channel);
  const id = last.ext_id || `conversation-${conversationId}`;
  const to: Inbound = {
    channel: c.channel,
    from: c.peer,
    text: '',
    id,
    at: new Date(last.at).getTime(),
    ...(c.account ? { account: c.account } : {}),
    ...(c.channel === 'email' ? { subject: c.meta?.subject || '', thread: { messageId: id, inReplyTo: null, references: c.meta?.ids || [] } } : {}),
  };
  const storeName = displayName(c.brand_override?.name, c.brand?.name, c.name) || c.domain;
  return { adapter, to, storeId: c.store_id, storeName, pausedUntil: c.agent_paused_until ? new Date(c.agent_paused_until).getTime() : null };
}

/** What the inbox shows above the reply box: whether a reply can go out, and until when. */
export async function replyState(app: App, conversationId: number): Promise<{ canReply: boolean; reason: Blocked | 'no_customer' | 'channel_off' | null; windowEnds: number | null; pausedUntil: number | null }> {
  let t: Target | null;
  try {
    t = await replyTarget(app, conversationId);
  } catch {
    return { canReply: false, reason: 'channel_off', windowEnds: null, pausedUntil: null };
  }
  if (!t) return { canReply: false, reason: 'no_customer', windowEnds: null, pausedUntil: null };
  const blocked = await blockedFor(app, t.adapter, t.to);
  const w = t.adapter.limits.window;
  const pausedUntil = t.pausedUntil && t.pausedUntil > now() ? t.pausedUntil : null;
  return { canReply: !blocked, reason: blocked, windowEnds: w ? t.to.at! + w.hours * HOUR : null, pausedUntil };
}

export async function ownerReply(app: App, conversationId: number, text: string, author: string): Promise<Delivery | { ok: false; reason: 'no_customer' }> {
  const t = await replyTarget(app, conversationId);
  if (!t) return { ok: false, reason: 'no_customer' };
  const d = await reply(app, t.adapter, t.to, text, t.storeId, conversationId, { who: 'owner', storeName: t.storeName });
  if (!d.ok) return d;
  await app.db.query('INSERT INTO messages (conversation_id, role, text, author, delivery) VALUES ($1, $2, $3, $4, $5::jsonb)', [conversationId, 'owner', text, author, J(d.ids)]);
  await app.db.query(`UPDATE conversations SET last_at = now(), agent_paused_until = now() + interval '${PAUSE_HOURS} hours' WHERE id = $1`, [conversationId]);
  await event(app.db, t.storeId, 'owner_reply', { conversationId });
  await audit(app.db, { actor: author, action: 'owner_reply', storeId: t.storeId, detail: { conversationId, chars: text.length } });
  return d;
}

export async function resumeAgent(app: App, conversationId: number, author: string) {
  const c = await app.db.one<{ store_id: number }>('UPDATE conversations SET agent_paused_until = NULL WHERE id = $1 RETURNING store_id', [conversationId]);
  if (c) await audit(app.db, { actor: author, action: 'resume_agent', storeId: c.store_id, detail: { conversationId } });
}
