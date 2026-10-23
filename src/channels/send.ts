import type { App } from '../app.ts';
import { now } from '../core/clock.ts';
import { event, usage } from '../db/log.ts';
import { fit, sendPlan } from './policy.ts';
import type { Channel, ChannelAdapter, Inbound } from './types.ts';

// The one place a message leaves Toran. Every send answers the inbound message being handled, and goes out only when
// the channel's rules allow it (policy.ts): inside the reply window, and in parts no longer than the provider takes.
// Each part is one billable unit in the ledgers.

/** The prefix of each channel's event kinds and usage tags (wa_in, wa_out). */
export const LEDGER: Record<Channel, string> = { whatsapp: 'wa' };

export async function reply(app: App, adapter: ChannelAdapter, to: Inbound, text: string, storeId: number | null, conversationId: number | null) {
  const tag = LEDGER[adapter.channel];
  const plan = sendPlan(adapter.limits, { lastCustomerAt: to.at ?? now(), now: now() });
  if (!plan.ok) {
    app.log(`[${tag}] not sent to conversation ${conversationId ?? '-'}: ${plan.reason}`);
    await event(app.db, storeId, `${tag}_blocked`, { conversationId, reason: plan.reason });
    return;
  }
  for (const part of fit(text, adapter.limits.maxChars)) {
    const sent = await adapter.send(to.from, part, to);
    await usage(app.db, { storeId, conversationId, kind: 'bsp', backend: adapter.kind, units: 1, usd: sent.usd, apiUsd: sent.usd, tag: `${tag}_out` });
    await event(app.db, storeId, `${tag}_out`, { conversationId, id: sent.id });
  }
}
