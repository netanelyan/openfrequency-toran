// The channel layer's shapes. A channel is where a customer writes to a store (WhatsApp today; email, Messenger and
// Instagram next); an adapter is one provider for it (Twilio or the simulator for WhatsApp). Everything past the
// adapter (routing, the agent, the ledgers) sees only these types.

export type Channel = 'whatsapp';

/** One message a customer sent, as its adapter parsed it. */
export type Inbound = {
  from: string; // the customer's id on the channel: international digits for WhatsApp
  text: string;
  id: string; // the provider's message id (idempotency)
  profileName?: string | null;
  channel?: Channel; // absent: whatsapp (messages queued before the channel layer have none)
  at?: number; // when the webhook received it; the reply window is measured from here
};

export type Sent = { id: string; usd: number };

/** What a channel allows, checked in code before every send (policy.ts), never left to the prompt. */
export type ChannelLimits = {
  maxChars: number; // one message, as the provider accepts it; a longer reply goes out in parts
  window: { hours: number } | null; // replies only this long after the customer's last message; null: no window
  outside: 'template' | 'tag' | null; // what the channel allows past the window (Toran sends neither yet)
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
  send(to: string, text: string, inReplyTo: Inbound): Promise<Sent>;
  /** The webhook's answer body. */
  ack(): { type: string; body: string };
  outbox?: { to: string; text: string; inReplyTo: string; at: number }[];
}
