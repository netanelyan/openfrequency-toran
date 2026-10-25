import type { App } from '../app.ts';
import { open } from '../core/secrets.ts';
import { cloudSend } from './meta.ts';
import { LIMITS } from './policy.ts';
import type { WaProvider } from './whatsapp.ts';

// OpenFrequency's own WhatsApp numbers on Meta's Cloud API: the demo number and the owner line, as the alternative to
// Twilio (whatsapp.ts). Each is a number of our own business, connected to our Meta app, and named by its Meta id:
//
//   META_DEMO_PHONE_ID    the demo number (demo.ts): codes bind a phone to a store, our support answers the rest
//   META_OWNER_PHONE_ID   the owner line (owners/line.ts): business owners and their assistant, Teder's news
//
// Either, both or neither may be set; a line that is not set stays on Twilio (or the simulator), as before. A message
// Meta sends us for one of these numbers is routed to that line (route.ts) before any store's account is looked at, so
// our number is never answered as a store's own WhatsApp, even when it was connected through a store's page.
//
// The token: META_SYSTEM_TOKEN when it is set (a system user's token of our own business, made in Business Settings
// with the numbers' WhatsApp account assigned; it never expires), else the token Embedded Signup gave when the number
// was connected on a store's page (our company store's, docs/company.md), sealed in channel_accounts like a store's.
//
// One adapter speaks for both lines, as Twilio's provider does: a reply goes out from the number it answers (the
// inbound's Meta id), a message Toran starts from the number it names (`from`, TORAN_ASSISTANT_WA for the owner line),
// and anything else from the demo number.

export type Line = 'demo' | 'owner';

const digits = (s: unknown) => String(s ?? '').replace(/\D/g, '');

export function metaLines(env: Record<string, string | undefined>): Record<Line, string | null> {
  return { demo: digits(env.META_DEMO_PHONE_ID) || null, owner: digits(env.META_OWNER_PHONE_ID) || null };
}

/** Which of our lines a Meta number id is, or null. One number set as both is the demo number, as on Twilio. */
export function lineOf(env: Record<string, string | undefined>, phoneId: string | null | undefined): Line | null {
  const l = metaLines(env);
  const id = digits(phoneId);
  if (!id) return null;
  if (id === l.demo) return 'demo';
  if (id === l.owner) return 'owner';
  return null;
}

/** The number a line is known by everywhere else (the pitch pages' button, accounts' link code). */
export function lineNumber(env: Record<string, string | undefined>, line: Line): string | null {
  return (line === 'owner' ? digits(env.TORAN_ASSISTANT_WA) : digits(env.DEMO_WA_NUMBER) || digits(env.TWILIO_WHATSAPP_FROM)) || null;
}

/** The Meta id a message goes out from: the one it answers, else the line whose number it names, else the demo number. */
export function phoneFor(env: Record<string, string | undefined>, { account, number }: { account?: string | null; number?: string | null }): string | null {
  const l = metaLines(env);
  if (lineOf(env, account)) return digits(account);
  const n = digits(number || account);
  if (n && l.owner && n === lineNumber(env, 'owner')) return l.owner;
  if (n && l.demo && n === lineNumber(env, 'demo')) return l.demo;
  return l.demo || l.owner;
}

async function tokenOf(app: App, phoneId: string): Promise<string> {
  const own = String(app.env.META_SYSTEM_TOKEN || '').trim();
  if (own) return own;
  const row = await app.db.one<{ secret: string }>("SELECT secret FROM channel_accounts WHERE channel = 'whatsapp' AND kind = 'meta' AND external_id = $1 AND secret IS NOT NULL ORDER BY (status = 'active') DESC, id DESC LIMIT 1", [phoneId]);
  if (!row) throw new Error(`no token for our number ${phoneId}: set META_SYSTEM_TOKEN, or connect the number on the company store's WhatsApp page`);
  return open(app.env, row.secret);
}

/** Our numbers on the Cloud API, as one WhatsApp provider. */
export function metaLinesAdapter(app: App): WaProvider {
  const out = async (pick: { account?: string | null; number?: string | null }, to: string, msg: Parameters<WaProvider['push']>[1]) => {
    const phoneId = phoneFor(app.env, pick);
    if (!phoneId) throw new Error('none of our numbers is on Meta (META_DEMO_PHONE_ID, META_OWNER_PHONE_ID)');
    return cloudSend(app.env, app.graph, phoneId, await tokenOf(app, phoneId), to, msg);
  };
  return {
    channel: 'whatsapp',
    kind: 'meta_line',
    limits: LIMITS.whatsapp,
    inboundUsd: 0,
    parse: () => null, // Meta's messages come to /meta/webhook (meta.ts parseWebhook)
    send: (to, text, inReplyTo) => out({ account: inReplyTo.account, number: inReplyTo.to }, to, { text }),
    push: (to, msg) => out({ number: msg.from }, to, msg),
    ack: () => ({ type: 'text/plain; charset=utf-8', body: 'ok' }),
  };
}

/** What the demo number sends through: Meta when it is on Meta, else the shared provider (Twilio or the simulator). */
export const demoWa = (app: App): WaProvider => (metaLines(app.env).demo ? metaLinesAdapter(app) : app.wa);

/** What the owner line sends through, the same way. */
export const ownerWa = (app: App): WaProvider => (metaLines(app.env).owner ? metaLinesAdapter(app) : app.wa);
