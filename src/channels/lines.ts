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
// Our one number (oneNumber below; docs/company.md, "Toran on our own number"): OpenFrequency has one WhatsApp number,
// its public number on the WhatsApp Business app on the operator's phone. Once our company store (src/company.ts)
// connects it on its own WhatsApp page, that number is ours with no setting at all: it is the demo number, and the
// owner line too unless META_OWNER_PHONE_ID names another. Every message to it goes to the demo number's router
// (demo.ts), which sends a verified owner to the assistant, a code or a live demo to the demo, and anyone else to our
// support; every answer, the inbox's replies and the owner line's templates go out from it. Disconnecting it on that
// page ends this.
//
// The token: META_SYSTEM_TOKEN when it is set (a system user's token of our own business, made in Business Settings
// with the numbers' WhatsApp account assigned; it never expires), else the token Embedded Signup gave when the number
// was connected on a store's page (our company store's, docs/company.md), sealed in channel_accounts like a store's.
//
// One adapter speaks for both lines, as Twilio's provider does: a reply goes out from the number it answers (the
// inbound's Meta id), a message Toran starts from the number it names (`from`, TORAN_ASSISTANT_WA for the owner line),
// and anything else from the demo number.

export type Line = 'demo' | 'owner';
/** Our numbers' Meta ids: the settings', and our one number's (`one`) once our company store connected it. */
export type Lines = Record<Line, string | null> & { one?: string | null };

const digits = (s: unknown) => String(s ?? '').replace(/\D/g, '');

export function metaLines(env: Record<string, string | undefined>): Lines {
  return { demo: digits(env.META_DEMO_PHONE_ID) || null, owner: digits(env.META_OWNER_PHONE_ID) || null };
}

/** Our one number, as our company store's row of channel_accounts (waStore.ts) holds it. */
export type OneNumber = { accountId: number; storeId: number; phoneId: string; number: string | null; status: string };

/**
 * The WhatsApp number a company store connected on its WhatsApp page (kind 'meta', not off), or null. A number whose
 * token needs connecting again still counts: its messages still come, and they are still ours to route. With more
 * than one company store, TORAN_SUPPORT_STORE's first.
 */
export async function oneNumber(app: App): Promise<OneNumber | null> {
  const domain = String(app.env.TORAN_SUPPORT_STORE || '').trim().toLowerCase();
  const r = await app.db.one<{ id: number; store_id: number; external_id: string; status: string; meta: any }>(
    "SELECT a.id, a.store_id, a.external_id, a.status, a.meta FROM channel_accounts a JOIN stores s ON s.id = a.store_id WHERE a.channel = 'whatsapp' AND a.kind = 'meta' AND a.status IN ('active', 'pending', 'reconnect') AND s.platform = 'company' ORDER BY (s.domain = $1) DESC, a.id DESC LIMIT 1",
    [domain],
  );
  return r ? { accountId: r.id, storeId: r.store_id, phoneId: digits(r.external_id), number: digits(r.meta?.display_phone_number) || null, status: r.status } : null;
}

/** The settings' lines, with our one number in every role no setting gives another number. */
export function withOne(env: Record<string, string | undefined>, one: OneNumber | null): Lines {
  const l = metaLines(env);
  return one ? { demo: l.demo || one.phoneId, owner: l.owner || one.phoneId, one: one.phoneId } : l;
}

/** Our lines now: the settings', and our one number while it is connected. */
export const ourLines = async (app: App): Promise<Lines> => withOne(app.env, await oneNumber(app));

/** What our one number does, in the order its messages are read. */
export type Role = 'owner' | 'demo' | 'support';
export const ROLE_HE: Record<Role, string> = {
  owner: 'הקו של בעלי העסקים: מי שהמספר שלו מחובר לחשבון ב-OpenFrequency מדבר עם העוזר שלו',
  demo: 'הדמו: מי ששלח קוד מעמוד של חנות, או שהדמו שלו עוד פתוח',
  support: 'התמיכה שלנו: כל השאר, עם שאלות על תורן, על תדר ועל המחירים',
};

/** Our one number and the roles it plays now, for the operator's pages; null while it is not connected. */
export async function oneNumberRoles(app: App): Promise<{ one: OneNumber; roles: Role[] } | null> {
  const one = await oneNumber(app);
  if (!one) return null;
  // The owner line is elsewhere when META_OWNER_PHONE_ID names another number; support is off when
  // TORAN_SUPPORT_STORE names a store that is not here.
  const domain = String(app.env.TORAN_SUPPORT_STORE || '').trim().toLowerCase();
  const support = !domain || Boolean(await app.db.one("SELECT 1 FROM stores WHERE domain = $1 AND platform = 'company'", [domain]));
  const roles: Role[] = [...(withOne(app.env, one).owner === one.phoneId ? ['owner' as const] : []), 'demo', ...(support ? ['support' as const] : [])];
  return { one, roles };
}

/**
 * Which of our lines a Meta number id is, or null. One number set as both is the demo number, as on Twilio; our one
 * number is the demo number's router whatever the settings say, since that router answers all three roles.
 */
export function lineOf(env: Record<string, string | undefined>, phoneId: string | null | undefined, l: Lines = metaLines(env)): Line | null {
  const id = digits(phoneId);
  if (!id) return null;
  if (id === l.demo || id === l.one) return 'demo';
  if (id === l.owner) return 'owner';
  return null;
}

/** The number a line is known by everywhere else (the pitch pages' button, accounts' link code). */
export function lineNumber(env: Record<string, string | undefined>, line: Line): string | null {
  return (line === 'owner' ? digits(env.TORAN_ASSISTANT_WA) : digits(env.DEMO_WA_NUMBER) || digits(env.TWILIO_WHATSAPP_FROM)) || null;
}

/** The Meta id a message goes out from: the one it answers, else the line whose number it names, else the demo number. */
export function phoneFor(env: Record<string, string | undefined>, { account, number }: { account?: string | null; number?: string | null }, l: Lines = metaLines(env)): string | null {
  if (lineOf(env, account, l)) return digits(account);
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
    const phoneId = phoneFor(app.env, pick, await ourLines(app));
    if (!phoneId) throw new Error("none of our numbers is on Meta (META_DEMO_PHONE_ID, META_OWNER_PHONE_ID, or the company store's WhatsApp page)");
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
export const demoWa = async (app: App): Promise<WaProvider> => ((await ourLines(app)).demo ? metaLinesAdapter(app) : app.wa);

/** What the owner line sends through, the same way: our one number while it is connected and no setting names another. */
export const ownerWa = async (app: App): Promise<WaProvider> => ((await ourLines(app)).owner ? metaLinesAdapter(app) : app.wa);
