import type { Db } from '../db/index.ts';

// Who is talking, said to the customer in code, never left to the model (the owner, 2026-11-01: "the person has to know
// that he speaks with a bot. then, when a person is involved, toran should say that").
//
//   the bot's first answer in a conversation opens with its line: "כאן <name>, הבוט של <store>." The name is the one the
//   store's owner gave it ("מה תורן יודע", pages/customer.ts); without one it is just the store's bot. Our own support
//   (src/company.ts) is "תורן".
//   a person answering from the inbox (channels/owner.ts ownerReply): their first message after the bot opens with
//   "מכאן עונה לך בן אדם מהצוות של <store>.", and the conversation forgets that the bot introduced itself
//   the bot answering again after a person: "כאן שוב <name>, הבוט של <store>."
//
// conversations.introduced_at keeps whether the line was said (migration 043). A line the router sends itself in the
// bot's name (the demo's welcome, channels/demo.ts) says it too, and marks it.

/** Our own support's bot. */
export const OUR_BOT = 'תורן';
export const NAME_MAX = 30;

/** The bot's name for a store: the owner's, else ours for our own support, else none. */
export const botName = (s: { platform?: string | null; agent_name?: string | null }) => String(s.agent_name || '').trim() || (s.platform === 'company' ? OUR_BOT : null);

/**
 * A name as the owner typed it, or null when it cannot be one: letters (any language), digits, spaces, a hyphen, an
 * apostrophe or a geresh, at most NAME_MAX characters, and at least one letter. A link, an address or a line of
 * punctuation is never said to a customer as a name.
 */
export function cleanBotName(raw: unknown): string | null {
  const t = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!t || t.length > NAME_MAX) return null;
  if (!/^[\p{L}\p{N} '’׳\-]+$/u.test(t) || !/\p{L}/u.test(t)) return null;
  return t;
}

export type Opening = 'first' | 'again';

/** The bot's line, or the person's, in the customer's language. */
export function botLine(kind: Opening, name: string | null, store: string, english = false): string {
  if (english) {
    if (kind === 'again') return name ? `${name}, ${store}'s bot, here again.` : `${store}'s bot here again.`;
    return name ? `This is ${name}, ${store}'s bot.` : `This is ${store}'s bot.`;
  }
  if (kind === 'again') return name ? `כאן שוב ${name}, הבוט של ${store}.` : `כאן שוב הבוט של ${store}.`;
  return name ? `כאן ${name}, הבוט של ${store}.` : `כאן הבוט של ${store}.`;
}

export const personLine = (store: string, english = false) => (english ? `From here on, a person from ${store}'s team is answering.` : `מכאן עונה לך בן אדם מהצוות של ${store}.`);

/** What the model is told when the app opens its reply, so it does not greet or introduce itself a second time. */
export const OPENING_NOTE = "The app opens your reply with a line saying you are the store's bot, with your name if you have one. Do not greet or introduce yourself; start with the answer.";

/**
 * Whether the bot's next answer here opens with its line: null when it already said it since the last person, and in a
 * conversation with nobody on the other end (no peer: the demo page's sample chat, which a page about the bot frames).
 */
export async function openingOf(db: Db, conversationId: number): Promise<Opening | null> {
  const c = await db.one<{ peer: string | null; introduced_at: string | null; person: boolean }>("SELECT peer, introduced_at, EXISTS (SELECT 1 FROM messages WHERE conversation_id = $1 AND role = 'owner') AS person FROM conversations WHERE id = $1", [conversationId]);
  if (!c?.peer || c.introduced_at) return null;
  return c.person ? 'again' : 'first';
}

export const markIntroduced = (db: Pick<Db, 'query'>, conversationId: number) => db.query('UPDATE conversations SET introduced_at = now() WHERE id = $1', [conversationId]);

/** English when the text has Latin words and no Hebrew, as the guard decides (guard.ts). */
export const isEnglish = (t: string) => !/[א-ת]/.test(t) && /[a-z]{3}/i.test(t);
