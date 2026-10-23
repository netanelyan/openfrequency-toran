import type { App } from '../app.ts';
import { now } from '../core/clock.ts';
import { event, usage } from '../db/log.ts';
import { fit, sendPlan } from './policy.ts';
import type { Channel, ChannelAdapter, Inbound, SendCtx } from './types.ts';

// The one place a message leaves Toran. Every send answers an inbound message (the one being handled, or for the
// owner's reply the customer's last), and goes out only when the channel's rules allow it (policy.ts): inside the
// reply window, never to an address that bounced, and in parts no longer than the provider takes. Each part is one
// billable unit in the ledgers.

/** Each channel's event-kind prefix and usage kind (wa_in and wa_out are billed as bsp; mail_in and mail_out as mail). */
export const LEDGER: Record<Channel, { tag: string; kind: 'bsp' | 'mail' }> = { whatsapp: { tag: 'wa', kind: 'bsp' }, email: { tag: 'mail', kind: 'mail' } };

export type Blocked = 'window_closed' | 'suppressed';
export type Delivery = { ok: true; ids: string[] } | { ok: false; reason: Blocked };

/** Why nothing may go to this customer now, or null. The inbox asks before it offers the reply box. */
export async function blockedFor(app: App, adapter: ChannelAdapter, to: Inbound): Promise<Blocked | null> {
  const plan = sendPlan(adapter.limits, { lastCustomerAt: to.at ?? now(), now: now() });
  if (!plan.ok) return plan.reason;
  if (adapter.channel === 'email' && (await app.db.one('SELECT 1 FROM mail_suppressed WHERE address = $1', [to.from]))) return 'suppressed';
  return null;
}

export async function reply(app: App, adapter: ChannelAdapter, to: Inbound, text: string, storeId: number | null, conversationId: number | null, ctx: SendCtx = { who: 'agent' }): Promise<Delivery> {
  const { tag, kind } = LEDGER[adapter.channel];
  const blocked = await blockedFor(app, adapter, to);
  if (blocked) {
    app.log(`[${tag}] not sent to conversation ${conversationId ?? '-'}: ${blocked}`);
    await event(app.db, storeId, `${tag}_blocked`, { conversationId, reason: blocked });
    return { ok: false, reason: blocked };
  }
  const ids: string[] = [];
  for (const part of fit(text, adapter.limits.maxChars)) {
    const sent = await adapter.send(to.from, part, to, ctx);
    await usage(app.db, { storeId, conversationId, kind, backend: adapter.kind, units: 1, usd: sent.usd, apiUsd: sent.usd, tag: `${tag}_out` });
    await event(app.db, storeId, `${tag}_out`, { conversationId, id: sent.id });
    ids.push(sent.id);
  }
  return { ok: true, ids };
}
