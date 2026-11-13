import type { App } from '../app.ts';
import type { Out, Req, Route } from '../web/server.ts';
import type { RouteResult } from '../channels/demo.ts';
import type { ChannelAdapter, Inbound } from '../channels/types.ts';
import { customerQuiet, israelDate, now } from '../core/clock.ts';
import { cleanLine } from '../core/hebrew.ts';
import { J } from '../db/index.ts';
import { audit, event, usage } from '../db/log.ts';
import { cloudSend, GRAPH, GraphError, numberQuality, templateHealth } from '../channels/meta.ts';
import { ourLines, tokenOf } from '../channels/lines.ts';
import { openConversation } from '../channels/conversations.ts';
import { supportAccount } from '../company.ts';
import { displayName } from '../ingest/brand.ts';
import { reply } from '../channels/send.ts';
import { le } from '../outreach.ts';
import { TEDER_DOES, TEDER_WHAT, TORAN_DOES, TORAN_WHAT } from '../pitchWords.ts';
import { alertOperator } from './alert.ts';
import { internalRefusal } from './internal.ts';
import { toranOnSale } from './signupSwitch.ts';

// A pitch on WhatsApp, sent by Toran from our number (the owner, 2026-11-08: "if i press the send button to a demo
// suggestion, i want it to go to whatsapp, so toran should send it", and on the risk: "i dont think people will report
// that, especially with something legit and an option to be removed from the advertising list. build that").
//
// Until that day the first message and the one reminder went from the operator's own phone, by hand (outreach.ts).
// Now the operator's "send" press sends them from our number, as an approved Marketing template (WhatsApp takes
// nothing else from a business to someone who has not written to it in the last 24 hours), for Toran's leads and
// Teder's alike: the operator's dashboard (ops/actions.ts), Toran's lead and follow-up pages, and Teder's /leads,
// which asks here (POST /internal/outreach/send, docs/contracts/outreach-send.json).
//
// Why the guardrails. Meta's rules ask for a person's opt-in before a business writes to them first
// (developers.facebook.com/docs/whatsapp/overview/getting-opt-in); a lead's number comes from its own website, which is
// not one. The law here allows one approach to a business that says who writes and how to stop (the Communications
// Law's section 30A, outreach.ts). Meta approves a template's wording only; what it does after is by what people do
// with the message: a template blocked or reported falls in quality and is paused for 3 hours, then 6, then disabled,
// and the number's own rating falls with it (docs/whatsapp-templates.md). Our number is also the demo, our support,
// the operator's alerts and the payment reminders, so nothing here may cost it its rating:
//
//   - the way out on the message itself: a quick reply, "הסירו אותי", pressed instead of "block"; that, or a reply
//     like "לא" or "הסר" to the pitch, keeps the number in outreach_stops, says so once, marks its leads lost, and no
//     pitch of either product goes to it again (outreachWord, read on our number before the demo and support)
//   - at most TORAN_OUTREACH_DAILY (10) a day, both products together, by Israel's calendar day
//   - never at night, on Shabbat or a holiday, or the afternoon before one (clock.ts customerQuiet)
//   - the number's quality and the template's, read from Meta before each send (cached ten minutes): anything but
//     GREEN (or UNKNOWN, a number or template too new to rate), a template not APPROVED, or Meta's own "paused" or
//     "disabled" on a send, and nothing more goes until it is GREEN again, with one alert to the operator a day
//   - a pitch goes once per number, product and stage (first, reminder), and only to the store's own WhatsApp (the
//     lead's contact_whatsapp, read from its website: the number it links to, else its Israeli mobile, leads/store.ts),
//     never to a number found anywhere else
//
// What happens when they answer is ops/leadReply.ts: our support answers them as a store we wrote to, the lead is
// marked answered, the operator is told, and the reminder no longer goes (wroteSinceFirst).
//
// META_OUTREACH_PHONE_ID moves the pitches to a number of their own with no other change; until it is set they go
// from the demo number. META_WABA_ID lets the template's own status and score be read; without it only the number's
// rating is, and a paused or disabled template is caught on the send itself (Meta's codes below).
//
// Nothing here throws to its caller. A number in a log line is its last four digits.

/** toran, teder, or both: one message with both demos (the owner, 2026-11-08: "i want to be able to send them 2 demos or 1"). */
export type Product = 'toran' | 'teder' | 'both';
/** first and reminder are a lead's pitch; launch is Toran's opening, to the people on its waitlist (TORAN_LAUNCH). */
export type Stage = 'first' | 'reminder' | 'launch';
export type PitchStage = Exclude<Stage, 'launch'>;

type UrlButton = { text: string; base: string; example: string };
export type OutreachTemplate = {
  name: string;
  product: Product;
  stage: Stage;
  category: 'MARKETING';
  language: 'he';
  body: string;
  /** A sample of each body variable, in order: {{1}} the store's name with its "ל", then each page's address (links). */
  example: string[];
  /** How many of the body's variables are the demos' addresses, after the name: the buttons' pages, written out too. */
  links?: 1 | 2;
  /** The version Meta approved before this one, sent until this one is approved (liveTemplate). */
  previous?: OutreachTemplate;
  /** The URL button: its text, the page's address up to the page's slug (the variable Meta appends), a sample slug. */
  url: UrlButton;
  /** A second URL button, after the first: the message with both demos (Teder's). Meta allows two URL buttons. */
  url2?: UrlButton;
  /** The quick reply that stops them. */
  stop: string;
};

/** The quick reply on every pitch, and the word the opt-out listens for first. */
export const STOP_BUTTON = 'הסירו אותי';

// The public pages, as the pitch's button opens them: Toran's pitch pages and Teder's demos (SERVER-FACTS.md, the
// sites behind Caddy). A template's URL is fixed when Meta approves it; only the slug after /s/ changes.
const TORAN_PAGES = 'https://toran.openfrequency.co.il/s/';
const TEDER_PAGES = 'https://teder.openfrequency.co.il/s/';

/**
 * The four templates, to be submitted exactly so (docs/whatsapp-templates.md is written from them by
 * scripts/templates-doc.ts). Meta's rules for their shape (developers.facebook.com/docs/whatsapp/business-management-api/
 * message-templates and its components page): a body may not start or end with a variable; a URL button takes one
 * variable, at the end of its address; quick reply buttons and the others are kept in two groups, so the URL button is
 * first and the quick reply after it (index 1 when sending). {{1}} is the store's name with its "ל" (outreach.ts le():
 * "לכלי חרס של נורית", "ל־Nike", "בשביל הדס"), so the preposition is always right.
 */
// The words approved on 2026-11-08: each template's `previous`, sent while Meta reviews the words that replace them.
const APPROVED_2026_11_08: Record<`${Product}_${PitchStage}`, OutreachTemplate> = {
  toran_first: {
    name: 'toran_pitch',
    product: 'toran',
    stage: 'first',
    category: 'MARKETING',
    language: 'he',
    body: 'היי, כאן OpenFrequency. בנינו {{1}} תורן, שעונה ללקוחות שלכם בוואטסאפ על מחירים ומלאי לפי מה שכתוב באתר שלכם. אפשר לנסות אותו עכשיו מהטלפון, בכפתור כאן למטה.\n\nאם זה מעניין אתכם, אפשר לענות כאן ונספר עוד. לא רלוונטי? לוחצים על "הסירו אותי" ולא נכתוב שוב.',
    example: ['לכלי חרס של נורית'],
    url: { text: 'לנסות את תורן', base: TORAN_PAGES, example: 'nurit-ceramics' },
    stop: STOP_BUTTON,
  },
  toran_reminder: {
    name: 'toran_pitch_reminder',
    product: 'toran',
    stage: 'reminder',
    category: 'MARKETING',
    language: 'he',
    body: 'היי, יצא לכם להציץ בתורן שהכנו {{1}}? הוא מחכה לכם בכפתור כאן למטה.\n\nזו ההודעה האחרונה שלנו בנושא. לא רלוונטי? לוחצים על "הסירו אותי".',
    example: ['לכלי חרס של נורית'],
    url: { text: 'לנסות את תורן', base: TORAN_PAGES, example: 'nurit-ceramics' },
    stop: STOP_BUTTON,
  },
  teder_first: {
    name: 'teder_pitch',
    product: 'teder',
    stage: 'first',
    category: 'MARKETING',
    language: 'he',
    body: 'היי, כאן OpenFrequency. בנינו את תדר, שמכין לחנויות אונליין מצגות בעברית לטיקטוק ולאינסטגרם. הוא קורא את האתר של החנות, וכותב ומעצב מצגות על נושאים מהתחום שלה. כל מצגת מחכה לאישור שלכם לפני שהיא עולה.\n\nהכנו {{1}} מצגת אחת לדוגמה, כדי שתראו איך זה ייראה אצלכם. היא בכפתור כאן למטה.\n\nאם זה מעניין אתכם, אפשר לענות כאן ונספר עוד. לא רלוונטי? לוחצים על "הסירו אותי" ולא נכתוב שוב.',
    example: ['לכלי חרס של נורית'],
    url: { text: 'לראות את המצגת', base: TEDER_PAGES, example: 'nurit-ceramics-a1b2c3' },
    stop: STOP_BUTTON,
  },
  teder_reminder: {
    name: 'teder_pitch_reminder',
    product: 'teder',
    stage: 'reminder',
    category: 'MARKETING',
    language: 'he',
    body: 'היי, יצא לכם להציץ במצגת שהכנו {{1}}? היא מחכה לכם בכפתור כאן למטה.\n\nזו ההודעה האחרונה שלנו בנושא. לא רלוונטי? לוחצים על "הסירו אותי".',
    example: ['לכלי חרס של נורית'],
    url: { text: 'לראות את המצגת', base: TEDER_PAGES, example: 'nurit-ceramics-a1b2c3' },
    stop: STOP_BUTTON,
  },
  both_first: {
    name: 'openfrequency_pitch',
    product: 'both',
    stage: 'first',
    category: 'MARKETING',
    language: 'he',
    body: 'היי, כאן OpenFrequency. הכנו {{1}} שני דברים לנסות: תורן, שעונה ללקוחות שלכם בוואטסאפ על מחירים ומלאי לפי מה שכתוב באתר שלכם, ומצגת לדוגמה של תדר, שכותב ומעצב לחנויות מצגות בעברית לטיקטוק ולאינסטגרם. שניהם בכפתורים כאן למטה.\n\nאם זה מעניין אתכם, אפשר לענות כאן ונספר עוד. לא רלוונטי? לוחצים על "הסירו אותי" ולא נכתוב שוב.',
    example: ['לכלי חרס של נורית'],
    url: { text: 'לנסות את תורן', base: TORAN_PAGES, example: 'nurit-ceramics' },
    url2: { text: 'לראות את המצגת', base: TEDER_PAGES, example: 'nurit-ceramics-a1b2c3' },
    stop: STOP_BUTTON,
  },
  both_reminder: {
    name: 'openfrequency_pitch_reminder',
    product: 'both',
    stage: 'reminder',
    category: 'MARKETING',
    language: 'he',
    body: 'היי, יצא לכם להציץ במה שהכנו {{1}}? תורן והמצגת של תדר מחכים לכם בכפתורים כאן למטה.\n\nזו ההודעה האחרונה שלנו בנושא. לא רלוונטי? לוחצים על "הסירו אותי".',
    example: ['לכלי חרס של נורית'],
    url: { text: 'לנסות את תורן', base: TORAN_PAGES, example: 'nurit-ceramics' },
    url2: { text: 'לראות את המצגת', base: TEDER_PAGES, example: 'nurit-ceramics-a1b2c3' },
    stop: STOP_BUTTON,
  },
};

const STORE_EX = 'לכלי חרס של נורית';
const TORAN_EX = `${TORAN_PAGES}nurit-ceramics`;
const TEDER_EX = `${TEDER_PAGES}nurit-ceramics-a1b2c3`;

// What Toran and Teder are, said as the website says them (openfrequency-web site.config.json toran.today, the Teder
// page), with each demo's address in the words as well as on its button (the owner, 2026-11-12: "urls have to be
// present, in case buttons dont show. also, toran is much more than a bot that answers about prices and quantity,
// showcase him correctly. same with teder, its for creating a nice community etc").
const MORE = 'אם זה מעניין אתכם, אפשר לענות כאן ונספר עוד. לא רלוונטי? לוחצים על "הסירו אותי" ולא נכתוב שוב.';
const LAST = 'זו ההודעה האחרונה שלנו בנושא. לא רלוונטי? לוחצים על "הסירו אותי".';

/**
 * The six templates, to be submitted exactly so (docs/whatsapp-templates.md is written from them by
 * scripts/templates-doc.ts). Meta's rules for their shape (developers.facebook.com/docs/whatsapp/business-management-api/
 * message-templates and its components page): a body may not start or end with a variable; a URL button takes one
 * variable, at the end of its address; quick reply buttons and the others are kept in two groups, so the URL button is
 * first and the quick reply after it (index 1 when sending). {{1}} is the store's name with its "ל" (outreach.ts le():
 * "לכלי חרס של נורית", "ל־Nike", "בשביל הדס"), so the preposition is always right; {{2}} (and {{3}}) the demos' pages,
 * as their buttons open them.
 */
export const OUTREACH_TEMPLATES: Record<`${Product}_${PitchStage}`, OutreachTemplate> = {
  toran_first: {
    ...APPROVED_2026_11_08.toran_first,
    name: 'toran_pitch_2',
    body: `היי, כאן OpenFrequency. בנינו {{1}} תורן, ש${TORAN_WHAT}.\n\n${TORAN_DOES}\n\nאפשר לכתוב לו עכשיו מהטלפון, כמו לקוח: {{2}}\n\n${MORE}`,
    example: [STORE_EX, TORAN_EX],
    links: 1,
    previous: APPROVED_2026_11_08.toran_first,
  },
  toran_reminder: {
    ...APPROVED_2026_11_08.toran_reminder,
    name: 'toran_pitch_reminder_2',
    body: `היי, יצא לכם לנסות את תורן שבנינו {{1}}? הוא מחכה לכם כאן: {{2}}\n\n${LAST}`,
    example: [STORE_EX, TORAN_EX],
    links: 1,
    previous: APPROVED_2026_11_08.toran_reminder,
  },
  teder_first: {
    ...APPROVED_2026_11_08.teder_first,
    name: 'teder_pitch_2',
    body: `היי, כאן OpenFrequency. בנינו את תדר, ש${TEDER_WHAT}.\n\n${TEDER_DOES}\n\nהכנו {{1}} מצגת אחת לדוגמה מהאתר שלכם: {{2}}\n\n${MORE}`,
    example: [STORE_EX, TEDER_EX],
    links: 1,
    previous: APPROVED_2026_11_08.teder_first,
  },
  teder_reminder: {
    ...APPROVED_2026_11_08.teder_reminder,
    name: 'teder_pitch_reminder_2',
    body: `היי, יצא לכם להציץ במצגת שהכנו {{1}}? היא מחכה לכם כאן: {{2}}\n\n${LAST}`,
    example: [STORE_EX, TEDER_EX],
    links: 1,
    previous: APPROVED_2026_11_08.teder_reminder,
  },
  // One message, both demos: Toran's page and Teder's slideshow, each its own button (Meta: up to two URL buttons in a
  // template, with quick replies beside them as a group of their own; developers.facebook.com/docs/whatsapp/
  // business-management-api/message-templates/components, "Buttons"). The quick reply is third (index 2 when sending).
  both_first: {
    ...APPROVED_2026_11_08.both_first,
    name: 'openfrequency_pitch_2',
    body: `היי, כאן OpenFrequency. הכנו {{1}} שני דברים לנסות.\n\nתורן ${TORAN_WHAT}. ${TORAN_DOES} אפשר לכתוב לו עכשיו כמו לקוח: {{2}}\n\nתדר ${TEDER_WHAT}. ${TEDER_DOES} הכנו לכם מצגת אחת לדוגמה: {{3}}\n\n${MORE}`,
    example: [STORE_EX, TORAN_EX, TEDER_EX],
    links: 2,
    previous: APPROVED_2026_11_08.both_first,
  },
  both_reminder: {
    ...APPROVED_2026_11_08.both_reminder,
    name: 'openfrequency_pitch_reminder_2',
    body: `היי, יצא לכם להציץ במה שהכנו {{1}}?\n\nתורן, שעונה ללקוחות שלכם בכל שעה: {{2}}\nהמצגת שתדר הכין מהאתר שלכם: {{3}}\n\n${LAST}`,
    example: [STORE_EX, TORAN_EX, TEDER_EX],
    links: 2,
    previous: APPROVED_2026_11_08.both_reminder,
  },
};

/**
 * Toran's opening, to the people who asked on the website's waitlist to hear when it opens (TORAN-READINESS.md P1-16):
 * they asked, so it may go, once, under every guardrail of a pitch (the way out, the quiet hours, the day's cap, Meta's
 * quality), and only once Toran is on sale. Its button opens the website's Toran page, where sign-up is. {{1}} is the
 * business's name with its "ל", as on the pitches. Not submitted to Meta yet.
 */
export const TORAN_LAUNCH: OutreachTemplate = {
  name: 'toran_launch',
  product: 'toran',
  stage: 'launch',
  category: 'MARKETING',
  language: 'he',
  body: 'היי, כאן OpenFrequency. ביקשתם שנעדכן כשתורן נפתח, והוא פתוח עכשיו {{1}}: הוא עונה ללקוחות שלכם בוואטסאפ, באינסטגרם, במסנג׳ר, במייל ובצ׳אט באתר, בכל שעה, לפי מה שכתוב באתר שלכם, ומעביר אליכם רק את מה שהוא לא יודע.\n\nהמחירים וההרשמה כאן: {{2}}\n\nלא רלוונטי יותר? לוחצים על "הסירו אותי" ולא נכתוב שוב.',
  example: ['לכלי חרס של נורית', 'https://openfrequency.co.il/toran'],
  links: 1,
  url: { text: 'להצטרף לתורן', base: 'https://openfrequency.co.il/', example: 'toran' },
  stop: STOP_BUTTON,
};

export const templateOf = (product: Product, stage: Stage): OutreachTemplate => (stage === 'launch' ? TORAN_LAUNCH : OUTREACH_TEMPLATES[`${product}_${stage}`]);

/** A template by the name Meta approved it under: the six, the words approved before them, and Toran's opening. */
export const templateNamed = (name: string): OutreachTemplate | undefined =>
  [...Object.values(OUTREACH_TEMPLATES), ...Object.values(OUTREACH_TEMPLATES).map((t) => t.previous!).filter(Boolean), TORAN_LAUNCH].find((t) => t.name === name);

/** The template as the store reads it, filled in. */
export const outreachFilled = (t: OutreachTemplate, vars: string[] = t.example) => t.body.replace(/\{\{(\d+)\}\}/g, (_, i) => vars[Number(i) - 1] ?? '');

/** The address Toran's opening sends to: the website's Toran page, where sign-up is. */
export const LAUNCH_PAGE = 'https://openfrequency.co.il/toran';

/** A template's body variables: the store's name with its "ל", then the pages its words carry (its buttons' pages). */
export const pitchVars = (t: OutreachTemplate, storeName: string, url: string, url2?: string | null): string[] =>
  [le(storeName), ...(t.links ? [url, ...(t.links > 1 ? [String(url2 || '')] : [])] : [])];

// Which version of a template goes now: the newest once Meta approved it, else the one before (approved already), so
// the pitches go on while Meta reviews new words. Read from Meta with the account's id (META_WABA_ID), kept ten minutes;
// without the id, or when Meta does not answer, the one before.
const approvedNow = new Map<string, { at: number; ok: boolean }>();

export async function liveTemplate(app: App, t: OutreachTemplate, token?: string): Promise<OutreachTemplate> {
  if (!t.previous) return t;
  const waba = digits(app.env.META_WABA_ID);
  if (!waba) return t.previous;
  const kept = approvedNow.get(t.name);
  if (kept && now() - kept.at < QUALITY_TTL_MS) return kept.ok ? t : t.previous;
  let ok = false;
  try {
    let tok = token;
    if (!tok) {
      const phoneId = await outreachPhoneId(app);
      tok = phoneId ? await tokenOf(app, phoneId) : '';
    }
    ok = Boolean(tok) && (await templateHealth(app.env, app.graph, waba, tok!, t.name))?.status === 'APPROVED';
  } catch {
    ok = false;
  }
  approvedNow.set(t.name, { at: now(), ok });
  return ok ? t : t.previous;
}

// ---- the limits

export const DAILY_DEFAULT = 10;
export const dailyCap = (env: Record<string, string | undefined>) => {
  const n = Math.floor(Number(env.TORAN_OUTREACH_DAILY));
  return Number.isFinite(n) && n >= 0 && String(env.TORAN_OUTREACH_DAILY ?? '').trim() !== '' ? Math.min(n, 1000) : DAILY_DEFAULT;
};
/** How long Meta's word on our number's and the template's quality is trusted. */
export const QUALITY_TTL_MS = 10 * 60_000;
/** A send on its way counts as sent this long, so two presses at once send one. */
const SENDING_MINUTES = 2;
/** A reply to a pitch is read as an answer to it this long after it went. */
export const REPLY_DAYS = 30;
/** Meta's codes for a template paused or disabled for its quality, and for one it does not have. */
const PAUSED = new Set([132015, 132016]);
const NO_SUCH_TEMPLATE = 132001;

/** International digits: a country code and the number, 8 to 15 digits. */
const PHONE = /^[1-9]\d{7,14}$/;
const digits = (s: unknown) => String(s ?? '').replace(/\D/g, '');
/** Any run of 8 digits or more (a phone, a Meta id) as its last four, for a log line. */
const masked = (s: string) => s.replace(/\d{8,}/g, (d) => `…${d.slice(-4)}`);

export type Why = 'stopped' | 'already' | 'replied' | 'cap' | 'quiet' | 'quality' | 'no_line' | 'bad_page' | 'bad_phone' | 'failed' | 'not_on_sale';
export type Outcome = { sent: boolean; why: Why | null; said: string };

/** What the operator reads for each outcome, on the dashboard, on Toran's pages and on Teder's /leads. */
export const SAID_HE: Record<Why | 'sent', string> = {
  sent: 'נשלח בוואטסאפ מהמספר שלנו.',
  stopped: 'המספר הזה ביקש שנסיר אותו, אז לא נשלח כלום ולא נשלח אליו יותר.',
  already: 'ההודעה הזו כבר נשלחה למספר הזה.',
  replied: 'כבר כתבו לנו מהמספר הזה אחרי ההודעה הראשונה, אז תזכורת לא יוצאת. עונים להם מהשיחה איתם בתורן, עד 24 שעות מההודעה האחרונה שלהם.',
  cap: 'הגענו היום למכסת ההודעות ללידים, אז לא נשלח כלום. מחר אפשר שוב.',
  quiet: 'עכשיו לילה, שבת או חג, אז לא שולחים ללידים. ההודעה לא נשלחה ולא סומנה, ואפשר לשלוח כשייגמר.',
  quality: 'Meta הורידה את הדירוג של המספר או של התבנית, אז עצרנו את ההודעות ללידים כדי לא לסכן את המספר. שום דבר לא נשלח. זה חוזר כשהדירוג חוזר לירוק.',
  no_line: 'המספר שלנו עוד לא מחובר ל-Meta, אז ההודעה לא נשלחה ולא סומנה. אפשר להעתיק אותה ולשלוח מהוואטסאפ שלך.',
  bad_page: 'אין לליד הזה עמוד באוויר, אז אין מה לשלוח.',
  bad_phone: 'אין באתר של הליד הזה וואטסאפ או מספר נייד, אז מהמספר שלנו לא שולחים לו.',
  failed: 'Meta לא קיבלה את ההודעה, ושום דבר לא סומן. אם זה חוזר, כנראה שהתבנית עוד לא אושרה (docs/whatsapp-templates.md).',
  not_on_sale: 'תורן עוד לא במכירה באתר (שם כתוב "בקרוב"), אז הודעה על תורן לא יוצאת וכלום לא סומן. כשפותחים את המכירה (TORAN_SIGNUP_OPEN), זה נפתח. הודעה על תדר לבד אפשר לשלוח.',
};
const no = (why: Why): Outcome => ({ sent: false, why, said: SAID_HE[why] });

// ---- Meta's word on quality, kept ten minutes

const quality = new Map<string, { at: number; ok: boolean; why: string }>();
/** For the tests: forget what Meta said. */
export const forgetQuality = () => {
  quality.clear();
  approvedNow.clear();
};

const goodScore = (s: string) => s === 'GREEN' || s === 'UNKNOWN' || s === '';

async function qualityOk(app: App, phoneId: string, token: string, t: OutreachTemplate): Promise<{ ok: boolean; why: string }> {
  const key = `${phoneId}:${t.name}`;
  const kept = quality.get(key);
  if (kept && now() - kept.at < QUALITY_TTL_MS) return kept;
  let out: { ok: boolean; why: string };
  try {
    const rating = await numberQuality(app.env, app.graph, phoneId, token);
    const waba = digits(app.env.META_WABA_ID);
    const health = waba ? await templateHealth(app.env, app.graph, waba, token, t.name) : null;
    if (!goodScore(rating)) out = { ok: false, why: `the number's quality is ${rating}` };
    else if (waba && !health) out = { ok: false, why: `the account has no template ${t.name} (not created, or deleted)` };
    else if (health && health.status !== 'APPROVED') out = { ok: false, why: `the template ${t.name} is ${health.status}` };
    else if (health && !goodScore(health.quality)) out = { ok: false, why: `the template ${t.name}'s quality is ${health.quality}` };
    else out = { ok: true, why: '' };
  } catch (e: any) {
    // Not read is not known to be good: nothing goes until Meta answers.
    out = { ok: false, why: `Meta did not say the quality (${masked(cleanLine(e?.message || e, 200))})` };
  }
  quality.set(key, { at: now(), ...out });
  return out;
}

async function qualityStop(app: App, why: string) {
  app.log(`[outreach] !!! pitches stopped: ${masked(why)}`);
  await alertOperator(app, 'outreach_quality', 'ההודעות ללידים בוואטסאפ נעצרו', `${why}. כדי לא לסכן את המספר שלנו, תורן לא שולח הודעות ללידים עד שהדירוג חוזר לירוק. אפשר לבדוק ב-WhatsApp Manager.`, { everyMinutes: 24 * 60 }).catch(() => {});
}

// ---- one pitch

/** url is the page of the template's first button; url2, Teder's demo, only for both. */
export type Pitch = { product: Product; stage: Stage; phone: string; name: string; url: string; url2?: string | null; ref: string; by: string };

/**
 * The products a pitch counts as, for "once per number, product and stage": both is Toran's and Teder's at once, so a
 * message with both demos is refused after either one alone went at that stage, and either alone after it.
 */
const productsOf = (p: Product): Product[] => (p === 'both' ? ['toran', 'teder', 'both'] : [p, 'both']);

const mark = (app: App, id: number | string, data: Record<string, unknown>) => app.db.query("UPDATE events SET data = data || $2::jsonb WHERE id = $1 AND kind = 'outreach_wa'", [id, J(data)]);

/** The page's slug, as the template's button appends it: the path /s/<slug> of the pitch page or the demo. */
export function slugOf(url: string): string | null {
  try {
    const m = /^\/s\/([A-Za-z0-9_-]{1,120})\/?$/.exec(new URL(url).pathname);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** The number a pitch goes out from: META_OUTREACH_PHONE_ID, else the demo number on Meta. */
export const outreachPhoneId = async (app: App): Promise<string | null> => digits(app.env.META_OUTREACH_PHONE_ID) || (await ourLines(app)).demo || null;

/** Whether a pitch can go from our number now at all (our number on Meta): the dashboard offers the button only then. */
export const outreachLive = async (app: App) => Boolean(await outreachPhoneId(app));

/** A number that asked us to stop. */
export const stoppedNumber = async (app: App, phone: string) => Boolean(await app.db.one('SELECT 1 FROM outreach_stops WHERE phone = $1', [digits(phone)]));

/**
 * Whether this number wrote to our support since our first pitch to it went (a message of theirs in a conversation on
 * our own number's support account, status 'line'): a store that answered us is talked with, inside the 24 hours each of
 * its messages opens, and is never sent the reminder template (the owner, 2026-11-12: "make sure the behavior is
 * defined"). Writing to its own Toran on the demo is trying the demo, not answering us: the one reminder still goes then.
 */
export async function wroteSinceFirst(app: App, phone: string): Promise<boolean> {
  const first = await app.db.one<{ at: Date | string | null }>("SELECT MIN(at) AS at FROM events WHERE store_id IS NULL AND kind = 'outreach_wa' AND data->>'phone' = $1 AND data->>'stage' = 'first' AND data->>'state' IN ('sent', 'undelivered')", [digits(phone)]);
  if (!first?.at) return false;
  return Boolean(await app.db.one("SELECT 1 FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN channel_accounts a ON a.id = c.account_id WHERE a.status = 'line' AND c.channel = 'whatsapp' AND c.peer = $1 AND m.role = 'customer' AND m.at > $2 LIMIT 1", [digits(phone), new Date(first.at).toISOString()]));
}

/**
 * One pitch: the template to the store's WhatsApp, unless a limit holds it. Never throws: the outcome says why, in the
 * operator's words (said).
 */
export async function sendPitch(app: App, p: Pitch): Promise<Outcome> {
  const phone = digits(p.phone);
  const newest = templateOf(p.product, p.stage);
  let t = newest;
  let who = `${t.name} to …${phone.slice(-4)} (${p.product} ${p.ref})`;
  if (!PHONE.test(phone)) return no('bad_phone');
  // A pitch for Toran ("אפשר לנסות אותו עכשיו") goes only once Toran is sold (ops/signupSwitch.ts; TORAN-READINESS.md
  // P0-6): while the site says "בקרוב", Teder's pitch alone may go, and Toran's or the combined one may not.
  if (p.product !== 'teder' && !toranOnSale(app.env)) return no('not_on_sale');
  if (p.stage === 'launch' && p.product !== 'toran') return no('bad_page');
  // The opening's button is the website's Toran page (TORAN_LAUNCH), not a store's pitch page.
  const slug = p.stage === 'launch' ? TORAN_LAUNCH.url.example : slugOf(p.url);
  if (!slug) return no('bad_page');
  const slug2 = t.url2 ? slugOf(String(p.url2 || '')) : null;
  if (t.url2 && !slug2) return no('bad_page');
  const name = cleanLine(p.name, 80) || 'החנות';
  const page = p.stage === 'launch' ? LAUNCH_PAGE : p.url;
  const same = `kind = 'outreach_wa' AND data->>'phone' = $1 AND data->>'product' = ANY($2::text[]) AND data->>'stage' = $3 AND (data->>'state' = 'sent' OR (data->>'state' = 'sending' AND at > now() - interval '${SENDING_MINUTES} minutes'))`;
  const products = productsOf(p.product);
  const day = israelDate(now());
  let claim: { id: number | string } | null;
  try {
    if (await stoppedNumber(app, phone)) return no('stopped');
    if (await app.db.one(`SELECT 1 FROM events WHERE ${same}`, [phone, products, p.stage])) return no('already');
    if (p.stage === 'reminder' && (await wroteSinceFirst(app, phone))) return no('replied');
    const cap = dailyCap(app.env);
    const today = (await app.db.one<{ n: number }>("SELECT COUNT(*)::int AS n FROM events WHERE kind = 'outreach_wa' AND data->>'day' = $1 AND (data->>'state' IN ('sent', 'undelivered') OR (data->>'state' = 'sending' AND at > now() - interval '2 minutes'))", [day]))?.n || 0;
    if (today >= cap) {
      app.log(`[outreach] ${who}: not sent (${cap} pitches went today, the day's cap)`);
      return no('cap');
    }
  } catch (e: any) {
    app.log(`[outreach] !!! ${who} NOT SENT: the pitches sent before could not be read (${masked(cleanLine(e?.message || e, 200))})`);
    return no('failed');
  }
  const phoneId = await outreachPhoneId(app);
  if (!phoneId) return no('no_line');
  // The quiet hours after the line: with no number connected, "wait until morning" would only send the operator back
  // to a send that fails then too.
  if (customerQuiet(now())) return no('quiet');
  let token: string;
  try {
    token = await tokenOf(app, phoneId);
  } catch (e: any) {
    app.log(`[outreach] !!! ${who} NOT SENT: ${masked(cleanLine(e?.message || e, 200))}`);
    return no('no_line');
  }
  // The newest words once Meta approved them, else the ones before (liveTemplate).
  t = await liveTemplate(app, newest, token);
  who = `${t.name} to …${phone.slice(-4)} (${p.product} ${p.ref})`;
  const q = await qualityOk(app, phoneId, token, t);
  if (!q.ok) {
    await qualityStop(app, q.why);
    return no('quality');
  }
  // Asked and recorded in one statement, so two presses at once send one. The store's name and the pages it was sent
  // are kept with it: their answer is read with them (ops/leadReply.ts), whatever the template's words carried.
  claim = await app.db
    .one<{ id: number }>(`INSERT INTO events (store_id, kind, data) SELECT NULL, 'outreach_wa', $4::jsonb WHERE NOT EXISTS (SELECT 1 FROM events WHERE ${same}) RETURNING id`, [phone, products, p.stage, J({ product: p.product, stage: p.stage, phone, ref: p.ref, by: p.by, day, template: t.name, name, url: page, url2: p.url2 || null, state: 'sending' })])
    .catch(() => null);
  if (!claim) return no('already');
  try {
    // The quick reply comes after every URL button: index 1 after one, 2 after the two of the message with both demos.
    const urls = slug2 ? [slug, slug2] : [slug];
    const sent = await cloudSend(app.env, app.graph, phoneId, token, phone, { template: { name: t.name, sid: t.name, vars: pitchVars(t, name, page, p.url2), urls, payload: 'OUTREACH_STOP', payloadIndex: urls.length } });
    await mark(app, claim.id, { state: 'sent', id: sent.id || null });
    await usage(app.db, { kind: 'bsp', backend: 'meta_line', units: 1, usd: sent.usd, apiUsd: sent.usd, tag: 'wa_outreach' }).catch(() => {});
    await keepPitch(app, { eventId: claim.id, phone, storeName: name, text: pitchShown(t, pitchVars(t, name, page, p.url2)), by: p.by, sentId: sent.id || null }).catch((e) => app.log(`[outreach] ${who}: sent, and not kept in our inbox (${masked(cleanLine(e?.message || e, 200))})`));
  } catch (e: any) {
    const code = e instanceof GraphError ? e.code : null;
    const why = masked(cleanLine(e?.message || e, 300));
    await mark(app, claim.id, { state: 'failed', code, error: why }).catch(() => {});
    if (code != null && PAUSED.has(code)) {
      quality.set(`${phoneId}:${t.name}`, { at: now(), ok: false, why: `Meta paused or disabled the template ${t.name}` });
      await qualityStop(app, `Meta paused or disabled the template ${t.name} (code ${code})`);
      return no('quality');
    }
    const hint = code === NO_SUCH_TEMPLATE ? ` (${t.name} is not approved in WhatsApp Manager: docs/whatsapp-templates.md)` : '';
    app.log(`[outreach] !!! ${who} FAILED: ${why}${hint}`);
    return no('failed');
  }
  app.log(`[outreach] ${who}: sent`);
  return { sent: true, why: null, said: SAID_HE.sent };
}

/**
 * Why Meta did not deliver a pitch, in the operator's words, as a line under it in our inbox. Meta's codes
 * (developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes): 131049, Meta's own limit on the marketing
 * messages one person gets; 131026, a number that cannot get it (no WhatsApp, or an old app); 130472, a number in one of
 * Meta's tests that gets no marketing messages. Anything else, with Meta's own words.
 */
export function notDeliveredHe(error: string | null | undefined): string {
  const e = String(error || '');
  const code = /\b(1\d{5})\b/.exec(e)?.[1];
  const why =
    code === '131049' ? 'Meta עצרה אותה כדי לא להציף את הנמען בהודעות שיווקיות. זו מגבלה של Meta על כל אדם, ואפשר לנסות שוב בעוד כמה ימים.'
    : code === '131026' ? 'המספר לא יכול לקבל אותה: אולי אין בו וואטסאפ, או שהאפליקציה בו ישנה.'
    : code === '130472' ? 'המספר נמצא בניסוי של Meta שלא מקבל הודעות שיווקיות, אז היא לא נשלחה אליו.'
    : `Meta לא מסרה אותה${e ? ` (${cleanLine(e, 200)})` : ''}.`;
  return `ההודעה הזו לא הגיעה לנמען. ${why}`;
}

/** The line under a kept pitch that Meta did not deliver, once. */
async function noteNotDelivered(app: App, eventId: number | string, conversationId: number, error: string | null | undefined) {
  await app.db.query("INSERT INTO messages (conversation_id, role, text, author, auto) VALUES ($1, 'system', $2, 'אוטומטי', 'outreach_failed')", [conversationId, notDeliveredHe(error)]);
  await mark(app, eventId, { noted: true });
}

/** A pitch as it reads in the chat: its words, and its buttons under them as the store sees them. */
export const pitchShown = (t: OutreachTemplate, vars: string[]) => `${outreachFilled(t, vars)}\n\n${[t.url.text, ...(t.url2 ? [t.url2.text] : []), t.stop].map((b) => `[${b}]`).join(' ')}`;

/**
 * A pitch, in our own inbox (the owner, 2026-11-12: "i also sent a lead message and cant see it in the inbox"): in the
 * conversation with that number on our support's account on our number (company.ts supportAccount), the one its answer
 * comes into (channels/demo.ts: a phone with no demo is our support's), as the operator's message (role owner, its
 * author the operator), with the store's name on a conversation it starts. Only for a pitch from our public number
 * (DEMO_WA_NUMBER): one from a number of its own (META_OUTREACH_PHONE_ID) is answered there. The event keeps the
 * conversation (kept), so it is kept once.
 */
async function keepPitch(app: App, k: { eventId: number | string; phone: string; storeName: string; text: string; by: string; sentId: string | null }): Promise<number | null> {
  if (digits(app.env.META_OUTREACH_PHONE_ID)) return null;
  const number = digits(app.env.DEMO_WA_NUMBER);
  const support = number ? await supportAccount(app, { kind: 'meta' }, number) : null;
  if (!support) return null;
  const c = await openConversation(app.db, { storeId: support.store_id, channel: 'whatsapp', peer: k.phone, accountId: support.id, meta: () => ({ name: k.storeName }) });
  await app.db.query("INSERT INTO messages (conversation_id, role, text, author, auto, delivery) VALUES ($1, 'owner', $2, $3, 'outreach', $4::jsonb)", [c.id, k.text, k.by, J(k.sentId ? [k.sentId] : [])]);
  await app.db.query('UPDATE conversations SET last_at = now() WHERE id = $1', [c.id]);
  await mark(app, k.eventId, { kept: c.id });
  return c.id;
}

/**
 * The pitches sent from our number before they were kept in our inbox: each in its conversation, as keepPitch keeps a
 * new one, with the store's name from the lead's own row (ref toran:<id> or store:<id>) and the words of the template it
 * went as; one Meta took and then could not deliver too (state undelivered), since it went from here. Says how many it
 * kept, and why it left any (no lead row, a template it does not know, no support account on our number).
 */
export async function keepSentPitches(app: App): Promise<{ kept: number; seen: number; noStore: number; noTemplate: number; noSupport: number }> {
  const out = { kept: 0, seen: 0, noStore: 0, noTemplate: 0, noSupport: 0 };
  // Kept already, not delivered, and no line yet (kept before the line was written): the line now.
  for (const e of await app.db.query<{ id: number; data: any }>("SELECT id, data FROM events WHERE kind = 'outreach_wa' AND data->>'state' = 'undelivered' AND data->>'kept' IS NOT NULL AND data->>'noted' IS NULL ORDER BY id")) {
    await noteNotDelivered(app, e.id, Number(e.data.kept), e.data.error);
  }
  const sent = await app.db.query<{ id: number; data: any }>("SELECT id, data FROM events WHERE kind = 'outreach_wa' AND data->>'state' IN ('sent', 'undelivered') AND data->>'kept' IS NULL ORDER BY id");
  for (const e of sent) {
    out.seen++;
    const t = templateNamed(String(e.data?.template || ''));
    const id = /^(?:toran|store):(\d+)$/.exec(String(e.data?.ref || ''))?.[1];
    const s = id ? await app.db.one<any>('SELECT name, brand, brand_override, domain FROM stores WHERE id = $1', [Number(id)]) : null;
    if (!t) {
      out.noTemplate++;
      continue;
    }
    if (!s) {
      out.noStore++;
      continue;
    }
    const name = displayName(s.brand_override?.name, s.brand?.name, s.name) || s.domain;
    const c = await keepPitch(app, { eventId: e.id, phone: String(e.data.phone || ''), storeName: name, text: pitchShown(t, [le(name)]), by: String(e.data.by || 'operator'), sentId: e.data.id || null });
    if (!c) {
      out.noSupport++;
      continue;
    }
    out.kept++;
    if (e.data.state === 'undelivered') await noteNotDelivered(app, e.id, c, e.data.error);
  }
  return out;
}

/**
 * Meta's later word that a pitch failed (the webhook's failed status, waStore.ts deliveryStatus): kept as undelivered,
 * said once. True when it was a pitch.
 */
export async function pitchNotDelivered(app: App, s: { id: string; error: string | null }): Promise<boolean> {
  if (!s.id) return false;
  const r = await app.db.one<{ id: number; data: any }>("SELECT id, data FROM events WHERE kind = 'outreach_wa' AND data->>'id' = $1 LIMIT 1", [s.id]);
  if (!r) return false;
  const error = masked(cleanLine(s.error || 'no reason given', 200));
  await mark(app, r.id, { state: 'undelivered', error });
  if (r.data?.kept && !r.data?.noted) await noteNotDelivered(app, r.id, Number(r.data.kept), error).catch(() => {});
  app.log(`[outreach] !!! ${r.data?.template} to …${String(r.data?.phone || '').slice(-4)} FAILED: Meta took it and then could not deliver it (${error})`);
  return true;
}

// ---- the way out

/** A whole message that asks us to stop: the quick reply, or a short "no" in Hebrew or English. */
export const STOP_REPLY = /^\s*(?:הסירו אותי|הסירו אותנו|הסירו|תסירו אותי|תסירו אותנו|תסירו|הסר|להסיר|הסר אותי|לא|לא תודה|לא מעוניין|לא מעוניינת|לא מעוניינים|לא רלוונטי|stop|unsubscribe|no)\s*[.!,]*\s*$/i;
/** Only these are read as the way out even after a demo began: a bare "לא" may be an answer in the demo itself. */
const STOP_ALWAYS = /^\s*(?:הסירו אותי|הסירו אותנו|הסירו|תסירו אותי|תסירו אותנו|תסירו|הסר|להסיר|הסר אותי|unsubscribe)\s*[.!,]*\s*$/i;

export const STOPPED_SAID = 'הסרנו אתכם, ולא נשלח לכם יותר הודעות כאלה. סליחה על ההפרעה.';

/**
 * "הסירו אותי" (the pitch's button) or a "לא" to a pitch, from a number that got one in the last REPLY_DAYS: kept in
 * outreach_stops, its leads in both products marked lost (opted_out), one line back inside the 24 hours their message
 * opened. A bare "לא" counts only while they have not written to us since the pitch (in a demo, to our support), where
 * it may be an answer to something else. Our own messages are not theirs: the pitch itself is kept in our support's
 * conversation with them (keepPitch), which then counted as talking, and "לא מעוניין" to it was answered as a question
 * (the trace of 2026-11-12). Null for anything else, which goes on as before.
 */
export async function outreachWord(app: App, adapter: ChannelAdapter, inbound: Inbound): Promise<RouteResult | null> {
  const text = String(inbound.text || '');
  if (!STOP_REPLY.test(text)) return null;
  const phone = digits(inbound.from);
  const pitch = await app.db.one<{ product: Product; at: Date | string }>(
    `SELECT data->>'product' AS product, at FROM events WHERE kind = 'outreach_wa' AND data->>'phone' = $1 AND data->>'state' IN ('sent', 'undelivered') AND at > now() - interval '${REPLY_DAYS} days' ORDER BY id DESC LIMIT 1`,
    [phone],
  );
  if (!pitch) return null;
  if (!STOP_ALWAYS.test(text)) {
    const talking = await app.db.one("SELECT 1 FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.channel = 'whatsapp' AND c.peer = $1 AND m.role = 'customer' AND m.at > $2 LIMIT 1", [phone, new Date(pitch.at).toISOString()]);
    if (talking) return null;
  }
  const fresh = await app.db.one('INSERT INTO outreach_stops (phone, product, said) VALUES ($1, $2, $3) ON CONFLICT (phone) DO NOTHING RETURNING phone', [phone, pitch.product, cleanLine(text, 200)]);
  if (!fresh) return { action: 'outreach_stop_again' };
  await app.db.query("UPDATE stores SET lost_at = COALESCE(lost_at, now()), lost_reason = COALESCE(lost_reason, 'opted_out'), updated_at = now() WHERE contact_whatsapp = $1", [phone]);
  await app.db.query("UPDATE teder_leads SET lost_at = COALESCE(lost_at, now()), lost_reason = COALESCE(lost_reason, 'opted_out') WHERE whatsapp = $1", [phone]);
  await event(app.db, null, 'outreach_stop', { last4: phone.slice(-4), product: pitch.product });
  await audit(app.db, { actor: `wa:${phone}`, action: 'outreach_stop', detail: { product: pitch.product } });
  app.log(`[outreach] …${phone.slice(-4)} asked to be removed (${pitch.product}): no pitch goes to it again`);
  await reply(app, adapter, inbound, STOPPED_SAID, null, null);
  return { action: 'outreach_stop', reply: STOPPED_SAID };
}

// ---- POST /internal/outreach/send, for Teder's /leads

export const OUTREACH_PATH = '/internal/outreach/send';
const PATH = /^\/internal\/outreach\/send$/;
const BODY_LIMIT = 4096;

/** The pitch in a request's body, or null when it is not one (docs/contracts/outreach-send.json). */
export function readPitch(raw: string | undefined): Pitch | null {
  const text = raw || '';
  if (Buffer.byteLength(text, 'utf8') > BODY_LIMIT) return null;
  let b: any;
  try {
    b = JSON.parse(text);
  } catch {
    return null;
  }
  if (!b || typeof b !== 'object' || Array.isArray(b)) return null;
  const { product, stage, phone, name, url, url2, ref, by } = b;
  if (product !== 'teder' && product !== 'toran' && product !== 'both') return null;
  if (stage !== 'first' && stage !== 'reminder' && stage !== 'launch') return null;
  if (typeof phone !== 'string' || !PHONE.test(phone)) return null;
  if (typeof name !== 'string' || !cleanLine(name, 200)) return null;
  const page = (u: unknown) => typeof u === 'string' && /^https?:\/\//.test(u) && Boolean(slugOf(u));
  // Toran's opening (accounts' waitlist): Toran's alone, and its button is the website, so it carries no page.
  if (stage === 'launch') return product === 'toran' && url == null && url2 == null && typeof ref === 'string' && /^[\w.:-]{1,100}$/.test(ref) ? { product, stage, phone, name, url: '', ref, by: typeof by === 'string' ? cleanLine(by, 120) || 'operator' : 'operator' } : null;
  if (!page(url)) return null;
  // both: url is Toran's page and url2 Teder's demo; a single product takes no url2.
  if (product === 'both' ? !page(url2) : url2 != null) return null;
  if (typeof ref !== 'string' || !/^[\w.:-]{1,100}$/.test(ref)) return null;
  return { product, stage, phone, name, url, ...(product === 'both' ? { url2 } : {}), ref, by: typeof by === 'string' ? cleanLine(by, 120) || 'operator' : 'operator' };
}

export function outreachRoutes(app: App): Route<Req>[] {
  return [
    ['POST', PATH, async (r): Promise<Out> => {
      const refused = internalRefusal(app, r);
      if (refused) return refused;
      const pitch = readPitch(r.raw);
      if (!pitch) return { status: 400, json: { error: 'bad_pitch' } };
      return { json: { ok: true, ...(await sendPitch(app, pitch)) }, headers: { 'cache-control': 'no-store' } };
    }],
    ['GET', PATH, async (r): Promise<Out> => internalRefusal(app, r) || { status: 405, json: { error: 'method_not_allowed' } }],
  ];
}

// ---- the submission sheet (docs/whatsapp-templates.md, scripts/templates-doc.ts)

/** The JSON Meta's POST <WABA id>/message_templates takes for one template, exactly as Toran sends it. */
export function submission(t: OutreachTemplate) {
  return {
    name: t.name,
    language: t.language,
    category: t.category,
    components: [
      { type: 'BODY', text: t.body, example: { body_text: [t.example] } },
      {
        type: 'BUTTONS',
        buttons: [
          ...[t.url, ...(t.url2 ? [t.url2] : [])].map((u) => ({ type: 'URL', text: u.text, url: `${u.base}{{1}}`, example: [`${u.base}${u.example}`] })),
          { type: 'QUICK_REPLY', text: t.stop },
        ],
      },
    ],
  };
}

export function outreachTemplateDoc(): string {
  return [...Object.values(OUTREACH_TEMPLATES), TORAN_LAUNCH]
    .map((t) =>
      [
        `### ${t.name}`,
        '',
        '| | |',
        '|---|---|',
        `| Name | ${t.name} |`,
        '| Category | Marketing |',
        `| Language | Hebrew (${t.language}) |`,
        '| Header, footer | none |',
        t.url2
          ? `| Buttons | two URL buttons: "${t.url.text}", to ${t.url.base}{{1}} (sample ${t.url.example}), and "${t.url2.text}", to ${t.url2.base}{{1}} (sample ${t.url2.example}); then a quick reply, "${t.stop}" |`
          : `| Buttons | a URL button, "${t.url.text}", to ${t.url.base}{{1}} (sample ${t.url.example}); then a quick reply, "${t.stop}" |`,
        `| Variables (sample) | ${t.example.map((e, i) => `{{${i + 1}}} = ${e}`).join('; ')} |`,
        ...(t.previous ? [`| Replaces | ${t.previous.name}, sent until Meta approves this one |`] : []),
        '',
        'The body, exactly:',
        '',
        '```',
        t.body,
        '```',
        '',
        `As the store reads it: ${outreachFilled(t).split('\n').filter(Boolean).join(' / ')} [${t.url.text}]${t.url2 ? ` [${t.url2.text}]` : ''} [${t.stop}]`,
        '',
        'Submitted with (the token is META_SYSTEM_TOKEN, the account is our WhatsApp account, META_WABA_ID):',
        '',
        '```sh',
        `curl -sS -X POST "${GRAPH}/v23.0/$META_WABA_ID/message_templates" \\`,
        '  -H "Authorization: Bearer $META_SYSTEM_TOKEN" -H "Content-Type: application/json" \\',
        `  --data '${JSON.stringify(submission(t))}'`,
        '```',
        '',
      ].join('\n'),
    )
    .join('\n');
}
