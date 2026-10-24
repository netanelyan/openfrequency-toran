// The channel layer's shapes. A channel is where a customer writes to a store (WhatsApp, email, and behind the
// TORAN_CHANNELS flag Messenger and Instagram); an adapter is one provider for it (Twilio, Meta or the simulator for
// WhatsApp, Resend or the simulator for email, Meta for Messenger and Instagram). Everything past the adapter
// (routing, the agent, the ledgers) sees only these types.

export type Channel = 'whatsapp' | 'email' | 'messenger' | 'instagram';

/** One message a customer sent, as its adapter parsed it. */
export type Inbound = {
  from: string; // the customer's id on the channel: international digits for WhatsApp, the address for email, the
  // Page-scoped id (PSID) on Messenger, the Instagram-scoped id (IGSID) on Instagram
  text: string;
  id: string; // the provider's message id (idempotency): Twilio's MessageSid, the email's Message-ID, Meta's mid
  profileName?: string | null;
  channel?: Channel; // absent: whatsapp (messages queued before the channel layer have none)
  at?: number; // when the webhook received it; the reply window is measured from here
  account?: string; // the store's own account it came to (an address, a number's, a Page's or an Instagram account's
  // id); absent: the WhatsApp demo number
  to?: string | null; // the WhatsApp number it was written to (international digits): the demo number or the owner line
  subject?: string;
  thread?: { messageId: string; inReplyTo: string | null; references: string[] }; // email's threading headers
  attachments?: { name: string; type: string; size: number }[];
  automated?: string | null; // why it must not be answered: an auto-reply, a bounce, a mailing list
  pending?: string; // the provider's id to fetch the rest from (Resend sends an email's body separately)
  report?: 'bounced' | 'complained'; // not a message: the provider saying mail to `from` failed or was marked spam
};

export type Sent = { id: string; usd: number };

/**
 * Who a send speaks for: the agent (an automatic reply) or the store's owner, from the inbox. tag is the message tag
 * Meta needs on Messenger and Instagram past the 24 hours (HUMAN_AGENT: a person answering, up to 7 days).
 */
export type SendCtx = { who: 'agent' | 'owner'; storeName?: string; tag?: 'HUMAN_AGENT' };

/** What a channel allows, checked in code before every send (policy.ts), never left to the prompt. */
export type ChannelLimits = {
  maxChars: number; // one message, as the provider accepts it; a longer reply goes out in parts
  maxBytes?: number; // the same in UTF-8 bytes, where the provider counts bytes (Instagram: 1000)
  window: { hours: number } | null; // replies only this long after the customer's last message; null: no window
  outside: 'template' | 'tag' | null; // what the channel allows past the window (Toran sends no template yet)
  humanAgent?: { hours: number }; // past the window, the owner's own answer with the HUMAN_AGENT tag, this long
  markup: 'whatsapp' | 'plain' | 'html';
  attachments: { inbound: boolean; outbound: boolean }; // whether Toran reads or sends them
};

export interface ChannelAdapter {
  channel: Channel;
  kind: string;
  limits: ChannelLimits;
  /** What the provider charges for one inbound message. */
  inboundUsd: number;
  /** Parse a webhook call; null when its signature does not check out. */
  parse(input: { raw: string; form: Record<string, string>; headers: Record<string, string | string[] | undefined>; url: string }): Inbound[] | null;
  /** Fetch what the webhook left out (an email's body and headers), in the worker. */
  complete?(inbound: Inbound): Promise<Inbound>;
  send(to: string, text: string, inReplyTo: Inbound, ctx?: SendCtx): Promise<Sent>;
  /** The customer's name as the provider gives it, for the inbox (Messenger and Instagram, whose ids mean nothing). */
  profile?(peer: string): Promise<string | null>;
  /** The webhook's answer body. */
  ack(): { type: string; body: string };
  outbox?: { to: string; text: string; inReplyTo: string; at: number; [k: string]: unknown }[];
}
