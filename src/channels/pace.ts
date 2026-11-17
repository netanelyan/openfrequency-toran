import type { App } from '../app.ts';
import { J } from '../db/index.ts';

// Another bot on the other side (the owner, 2026-11-17, on our support's conversation 409: "this cant be. make the bot
// smart, not a spam messanger"). A store we asked whether we may send an offer answered with its own AI bot, and the
// two bots wrote to each other 17 times in four minutes, until a person there wrote "Ghh", "חאלס" and "מהר הסר". Each
// of its messages came 7 to 10 seconds after ours, 75 to 180 characters, most with WhatsApp's *bold*: faster than
// anyone reads and types. Ours saw it was a bot by the fifth and handed off, and went on answering, since a handoff
// does not stop it.
//
// So a chat message (WhatsApp, Messenger, Instagram; channels/store.ts) is weighed as it arrives, against our last
// message in the conversation (Toran's or a person's of ours, the pitch kept there included):
//
//   machine-paced   MIN_CHARS or more, at MACHINE_CPS characters a second or faster since ours went out: nobody reads
//                   and types that fast. One within MIN_GAP_MS of ours was written before ours reached them, and says
//                   nothing of its pace (nor do a test's frozen clocks)
//   marked          a bot's words about itself ("אני כאן כדי לתת שירות ללקוחות", "התפקיד שלי", "מופעל על ידי"), an
//                   automatic reply's (AUTO_WORDS), or WhatsApp's *bold*, which people rarely type in a chat
//
// Two machine-paced messages in a row, or one that is also marked, and the other side is a bot: the conversation is
// marked (meta.bot), the message kept with no answer, and its owner (on our support, the operator) told once. From
// then on a message that is machine-paced or marked is kept with no answer and no new note, and one a person writes is
// answered as before: someone there can still talk to us, and their bot never gets an answer to answer. The model can
// say so too, with the handoff's reason "bot" (agent/tools.ts): nothing is sent then, and the same mark is made.

export const MACHINE_CPS = 8;
export const MIN_CHARS = 40;
export const MIN_GAP_MS = 1000;

/** Faster than a person writes: `chars` characters, `gapMs` after our last message went out. */
export const machinePaced = (chars: number, gapMs: number | null): boolean =>
  gapMs != null && gapMs >= MIN_GAP_MS && chars >= MIN_CHARS && chars / (gapMs / 1000) >= MACHINE_CPS;

/**
 * A business's automatic reply, in what such messages say: its WhatsApp Business greeting or away message (the two
 * "answers" of the first pitches, 2026-11-13: "שרות הלקוחות שלנו פעיל בין השעות 09:00-15:00 ... ונחזור אלייך בהקדם" and
 * "ראינו שהשארת לנו פנייה ... ספרו לנו במה אפשר לעזור"; ops/leadReply.ts automaticAnswer).
 */
export const AUTO_WORDS = /שעות (?:ה)?פעילות|פעיל(?:ה|ים)? בין השעות|שירות הלקוחות (?:שלנו )?(?:פעיל|זמין)|(?:נחזור|נענה|נשוב|נחזיר) (?:אלי(?:ך|יך|כם)|לך|לכם|בהקדם|תשובה)|קיבלנו את (?:פנייתך|פנייתכם|הפנייה|הודעתך|ההודעה)|תודה (?:על פנייתך|על פנייתכם|על הפנייה|שפנית|שפניתם|שכתבת|שכתבתם)|השארת לנו (?:פנייה|הודעה)|ספרו לנו במה (?:אפשר|נוכל) לעזור|במה (?:אפשר|נוכל) לעזור|הודעה אוטומטית|מענה אוטומטי|ימי עסקים|אינו מאויש|מחוץ לשעות/;

/** A bot's words about itself: what it is, what it is there for, who runs it. */
export const BOT_WORDS = /אני (?:ה)?(?:בוט|צ'?אט ?בוט|עוזר(?:ת)? (?:ה)?(?:וירטואלי|דיגיטלי|אוטומטי|חכם)(?:ת)?|נציג(?:ה)? (?:ה)?(?:וירטואלי|דיגיטלי|אוטומטי)(?:ת)?)|אני (?:כאן|פה|זמינ(?:ה)?)(?: (?:כאן|פה))? (?:כדי )?(?:לעזור|לתת|לסייע|לספק|לענות)|(?:התפקיד שלי|תפקידי) (?:הוא )?(?:לעזור|לתת|לסייע|לספק|לענות)|אני מיועד(?:ת)? ל|(?:מופעל|מופעלת|מופעלים|מופעלות) (?:על ידי|ע"י|ע״י|באמצעות)|הבוט ש(?:מפעיל|מריץ) אותי|\b(?:i am|i'm) (?:an? )?(?:ai|virtual|digital|automated) (?:assistant|agent)\b|\bthis is an automated (?:message|reply|response)\b/i;

/** WhatsApp's *bold* around a few words. */
const BOLD = /\*[^\s*][^*\n]{0,80}\*/;

/** The words of a bot or of an automatic reply. */
export const markedBot = (text: string): boolean => BOT_WORDS.test(text) || AUTO_WORDS.test(text) || BOLD.test(text);

export type Pace = { machine: boolean; newly: boolean; why: string | null };

/**
 * Weigh a chat message as it arrives (before it is kept), arrivedAt by the app's clock (Inbound.at): whether it came
 * from a machine, and whether that makes the other side a bot now. Keeps the run of machine-paced messages on the
 * conversation (meta.fast) and the mark (meta.bot). why: in Hebrew, for the owner's note.
 */
export async function paceOf(app: App, conversationId: number, text: string, arrivedAt: number): Promise<Pace> {
  const c = await app.db.one<{ meta: any; out: Date | string | null }>(
    "SELECT c.meta, (SELECT max(m.at) FROM messages m WHERE m.conversation_id = c.id AND m.role IN ('agent', 'owner')) AS out FROM conversations c WHERE c.id = $1",
    [conversationId],
  );
  if (!c) return { machine: false, newly: false, why: null };
  const gap = c.out ? arrivedAt - new Date(c.out).getTime() : null;
  const fast = machinePaced(text.length, gap);
  const marked = markedBot(text);
  const was = Number(c.meta?.fast || 0);
  const run = fast ? was + 1 : 0;
  const why = fast ? `הודעה של ${text.length} תווים, ${(gap! / 1000).toFixed(1)} שניות אחרי שלנו` : marked ? 'ההודעות שלו כתובות כמו של בוט' : null;
  if (c.meta?.bot) {
    if (run !== was) await app.db.query('UPDATE conversations SET meta = meta || $2::jsonb WHERE id = $1', [conversationId, J({ fast: run })]);
    return { machine: fast || marked, newly: false, why };
  }
  const bot = fast && (run >= 2 || marked);
  if (bot) await markBot(app, conversationId, why!, run);
  else if (run !== was) await app.db.query('UPDATE conversations SET meta = meta || $2::jsonb WHERE id = $1', [conversationId, J({ fast: run })]);
  return { machine: bot, newly: bot, why };
}

/** The other side of this conversation is a bot (paceOf, or the model's handoff with reason "bot"). */
export async function markBot(app: App, conversationId: number, why: string, run?: number): Promise<void> {
  await app.db.query("UPDATE conversations SET meta = meta || $2::jsonb WHERE id = $1 AND NOT (meta ? 'bot')", [conversationId, J({ bot: { why }, ...(run != null ? { fast: run } : {}) })]);
}

/**
 * A message that asks nothing and needs no answer once we answered: a thumbs-up or another sign, a thanks, "קיבלתי",
 * laughter, or a few letters of nothing ("Ghh"). A store we wrote to is not answered for it (channels/store.ts): an
 * answer to each would be one more message from us, with nothing in it they asked for.
 */
export function nothingToAnswer(text: string): boolean {
  const t = String(text || '').trim();
  if (!t) return false;
  if (/^[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}‍️\s.!,]+$/u.test(t)) return true;
  const words = t.replace(/[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}‍️.!,]+/gu, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  if (/^(?:תודה|תודה רבה|תודה רבה רבה|תנקס|קיבלתי|הבנתי|אוקי|אוקיי|ok|okay|k|thanks|thank you|thx|ty)$/.test(words)) return true;
  if (/^ח{3,}$/.test(words)) return true;
  return /^[a-z]{1,4}$/.test(words) && !/^(?:yes|no|hi|hey|yo|stop|help|why|how|what|who|when|info|cost|buy)$/.test(words);
}
