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
  // Messenger and Instagram (Meta's Send API): 24 hours from the customer's last message for anything; past it, only a
  // person's answer with the HUMAN_AGENT tag, up to 7 days, once Meta has approved the app for it (META_HUMAN_AGENT).
  // The agent never answers past the 24 hours. Messenger takes 2,000 characters; Instagram 1,000 bytes of UTF-8,
  // which is about 500 Hebrew letters.
  messenger: { maxChars: 2000, window: { hours: 24 }, outside: 'tag', humanAgent: { hours: 7 * 24 }, markup: 'plain', attachments: { inbound: true, outbound: false } },
  instagram: { maxChars: 1000, maxBytes: 1000, window: { hours: 24 }, outside: 'tag', humanAgent: { hours: 7 * 24 }, markup: 'plain', attachments: { inbound: true, outbound: false } },
};

export type SendPlan = { ok: true; mode: 'response' | 'human_agent' } | { ok: false; reason: 'window_closed' };

/**
 * Whether a reply may go out now, given when the customer last wrote. Past the window, the owner's own answer goes out
 * tagged HUMAN_AGENT where the channel has that and Meta approved it (humanAgent); the agent's never does.
 */
export function sendPlan(limits: ChannelLimits, { lastCustomerAt, now, who = 'agent', humanAgent = false }: { lastCustomerAt: number; now: number; who?: 'agent' | 'owner'; humanAgent?: boolean }): SendPlan {
  if (!limits.window || now - lastCustomerAt <= limits.window.hours * HOUR) return { ok: true, mode: 'response' };
  if (who === 'owner' && humanAgent && limits.humanAgent && now - lastCustomerAt <= limits.humanAgent.hours * HOUR) return { ok: true, mode: 'human_agent' };
  return { ok: false, reason: 'window_closed' };
}

/** May the owner's answers past the 24 hours go out tagged HUMAN_AGENT? Only once Meta approved it for the app. */
export const humanAgentOn = (env: Record<string, string | undefined>) => String(env.META_HUMAN_AGENT || '').trim() === '1';

const bytes = (s: string) => Buffer.byteLength(s, 'utf8');

/**
 * The text in parts of at most maxChars (and maxBytes of UTF-8, when the channel counts bytes): cut at a blank line,
 * else a line, else a space, else hard.
 */
export function fit(text: string, maxChars: number, maxBytes = Infinity): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    const head = rest.slice(0, maxChars + 1);
    const cut = [head.lastIndexOf('\n\n'), head.lastIndexOf('\n'), head.lastIndexOf(' ')].find((i) => i > maxChars / 2) ?? maxChars;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest || !parts.length) parts.push(rest);
  if (!Number.isFinite(maxBytes)) return parts;
  // A part over the bytes is cut again, shorter in proportion; each pass is strictly shorter, so it ends.
  return parts.flatMap((p) => (bytes(p) <= maxBytes || p.length < 2 ? [p] : fit(p, Math.max(1, Math.min(p.length - 1, Math.floor((p.length * maxBytes) / bytes(p)))), maxBytes)));
}
