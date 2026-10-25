import type { App } from '../app.ts';
import { now } from '../core/clock.ts';
import { event, usage } from '../db/log.ts';
import { fit, humanAgentOn, sendPlan } from './policy.ts';
import type { Channel, ChannelAdapter, Inbound, SendCtx } from './types.ts';

// The one place a message leaves Toran. Every send answers an inbound message (the one being handled, or for the
// owner's reply the customer's last), and goes out only when the channel's rules allow it (policy.ts): inside the
// reply window, never to an address that bounced, and in parts no longer than the provider takes. Each part is one
// billable unit in the ledgers.

/**
 * Each channel's event-kind prefix and usage kind (wa_in and wa_out are billed as bsp; mail_in and mail_out as mail;
 * Messenger's fb_ and Instagram's ig_ as dm, which Meta does not charge for).
 */
export const LEDGER: Record<Channel, { tag: string; kind: 'bsp' | 'mail' | 'dm' }> = { whatsapp: { tag: 'wa', kind: 'bsp' }, email: { tag: 'mail', kind: 'mail' }, messenger: { tag: 'fb', kind: 'dm' }, instagram: { tag: 'ig', kind: 'dm' } };

export type Blocked = 'window_closed' | 'suppressed';
export type Delivery = { ok: true; ids: string[] } | { ok: false; reason: Blocked };

/** Why nothing may go to this customer now, or null. The inbox asks (for the owner) before it offers the reply box. */
export async function blockedFor(app: App, adapter: ChannelAdapter, to: Inbound, who: 'agent' | 'owner' = 'agent'): Promise<Blocked | null> {
  const plan = sendPlan(adapter.limits, { lastCustomerAt: to.at ?? now(), now: now(), who, humanAgent: humanAgentOn(app.env) });
  if (!plan.ok) return plan.reason;
  if (adapter.channel === 'email' && (await app.db.one('SELECT 1 FROM mail_suppressed WHERE address = $1', [to.from]))) return 'suppressed';
  return null;
}

export async function reply(app: App, adapter: ChannelAdapter, to: Inbound, text: string, storeId: number | null, conversationId: number | null, ctx: SendCtx = { who: 'agent' }): Promise<Delivery> {
  const { tag, kind } = LEDGER[adapter.channel];
  const blocked = await blockedFor(app, adapter, to, ctx.who);
  if (blocked) {
    app.log(`[${tag}] not sent to conversation ${conversationId ?? '-'}: ${blocked}`);
    await event(app.db, storeId, `${tag}_blocked`, { conversationId, reason: blocked });
    return { ok: false, reason: blocked };
  }
  // Past the 24 hours, only the owner's answer reaches here (blockedFor), and it goes out tagged as a person's.
  const plan = sendPlan(adapter.limits, { lastCustomerAt: to.at ?? now(), now: now(), who: ctx.who, humanAgent: humanAgentOn(app.env) });
  let sendCtx: SendCtx = plan.ok && plan.mode === 'human_agent' ? { ...ctx, tag: 'HUMAN_AGENT' } : ctx;
  const ids: string[] = [];
  for (const [i, part] of fit(text, adapter.limits.maxChars, adapter.limits.maxBytes).entries()) {
    if (i === 1) sendCtx = { ...sendCtx, files: undefined }; // the owner's files go with the first part only
    const sent = await adapter.send(to.from, part, to, sendCtx);
    await usage(app.db, { storeId, conversationId, kind, backend: adapter.kind, units: 1, usd: sent.usd, apiUsd: sent.usd, tag: `${tag}_out` });
    await event(app.db, storeId, `${tag}_out`, { conversationId, id: sent.id });
    ids.push(sent.id);
  }
  return { ok: true, ids };
}

/** One piece of an answer on the owner line: text, or an image with its caption. */
export type Part = { text: string } | { media: string; caption?: string };

/**
 * An answer to the owner in parts (owners/line.ts): text the way reply() sends it, and images through push(), each
 * after the same window check, in order. Images go on WhatsApp only; elsewhere they are left out.
 */
export async function replyParts(app: App, adapter: ChannelAdapter, to: Inbound, parts: Part[], storeId: number | null): Promise<Delivery> {
  const ids: string[] = [];
  for (const p of parts) {
    if ('text' in p) {
      if (!p.text.trim()) continue;
      const d = await reply(app, adapter, to, p.text, storeId, null);
      if (!d.ok) return d;
      ids.push(...d.ids);
      continue;
    }
    const wa = adapter as ChannelAdapter & { push?: (to: string, m: { text?: string; mediaUrl?: string; from?: string | null }) => Promise<{ id: string; usd: number }> };
    if (adapter.channel !== 'whatsapp' || !wa.push) continue;
    const blocked = await blockedFor(app, adapter, to);
    if (blocked) return { ok: false, reason: blocked };
    const sent = await wa.push(to.from, { text: p.caption || '', mediaUrl: p.media, from: to.to });
    await usage(app.db, { storeId, kind: 'bsp', backend: adapter.kind, units: 1, usd: sent.usd, apiUsd: sent.usd, tag: 'wa_out' });
    await event(app.db, storeId, 'wa_out', { id: sent.id, media: true });
    ids.push(sent.id);
  }
  return { ok: true, ids };
}
