import { HOUR } from '../core/clock.ts';
import type { Channel, ChannelLimits } from './types.ts';

// Each channel's rules, in code: how long after the customer's last message a reply may go out, what the channel
// allows past that, how long one message may be. send.ts asks sendPlan() before every send and splits with fit().

export const LIMITS: Record<Channel, ChannelLimits> = {
  // Meta's service window is 24 hours from the customer's last message; past it only an approved template goes out.
  whatsapp: { maxChars: 4096, window: { hours: 24 }, outside: 'template', markup: 'whatsapp', attachments: { inbound: false, outbound: false } },
  // Email has no window. A reply is one message however long; the cap only stops a runaway one. Attachments that come
  // in are listed for the owner (the agent is told it cannot open them); none go out.
  email: { maxChars: 8000, window: null, outside: null, markup: 'plain', attachments: { inbound: true, outbound: false } },
};

export type SendPlan = { ok: true; mode: 'response' } | { ok: false; reason: 'window_closed' };

/** Whether a reply may go out now, given when the customer last wrote. */
export function sendPlan(limits: ChannelLimits, { lastCustomerAt, now }: { lastCustomerAt: number; now: number }): SendPlan {
  if (limits.window && now - lastCustomerAt > limits.window.hours * HOUR) return { ok: false, reason: 'window_closed' };
  return { ok: true, mode: 'response' };
}

/** The text in parts of at most maxChars: cut at a blank line, else a line, else a space, else hard. */
export function fit(text: string, maxChars: number): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    const head = rest.slice(0, maxChars + 1);
    const cut = [head.lastIndexOf('\n\n'), head.lastIndexOf('\n'), head.lastIndexOf(' ')].find((i) => i > maxChars / 2) ?? maxChars;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest || !parts.length) parts.push(rest);
  return parts;
}
