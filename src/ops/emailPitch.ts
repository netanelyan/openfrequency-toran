import type { App } from '../app.ts';
import type { RouteResult } from '../channels/demo.ts';
import type { ChannelAdapter, Inbound, SendCtx } from '../channels/types.ts';
import { conversationOf, type Account } from '../channels/store.ts';
import { stripQuoted } from '../channels/email.ts';
import { enabledChannels, storeAddress } from '../channels/config.ts';
import { ownAddress } from '../channels/mailDomain.ts';
import { reply } from '../channels/send.ts';
import { publicBase } from '../auto/messages.ts';
import { customerQuiet, DAY, israelDate, notOnShabbat, now } from '../core/clock.ts';
import { toranEnv } from '../core/env.ts';
import { cleanLine } from '../core/hebrew.ts';
import { J } from '../db/index.ts';
import { audit, event, usage } from '../db/log.ts';
import { displayName } from '../ingest/brand.ts';
import { le, pitchUrl } from '../outreach.ts';
import { alertOperator } from './alert.ts';
import { REPLY_DAYS } from './outreach.ts';
import { toranOnSale } from './signupSwitch.ts';
import { tederMove, tederState } from './tederLeads.ts';

// A pitch by email, from our company store's own address (the owner, 2026-11-15: "19 messages, 0 replies. redo that
// part. from start until the end. dont mind wasting my tokens, i want it working and i want costumers").
//
// Why email. Of the first 19 pitches on WhatsApp (ops/outreach.ts), 11 came back from Meta as 131026, a number that
// cannot get it: every landline and 073 number a store's site gave us, and nobody answered the rest. 37 leads not
// pitched yet have an email address and no phone at all. So a lead goes by email when it has no WhatsApp, when its
// number is not an Israeli mobile (9725 and eight digits, the one kind that reliably has WhatsApp; a number that wrote
// to us with a demo code has it too, whatever its kind), and when Meta could not deliver its WhatsApp pitch
// (emailFallbackDue, run by the worker every minute).
//
// What the law allows. Israel's Communications Law, section 30A, lets a business send another business one message
// asking whether it agrees to get offers, as long as it says who is writing and how to say no. So the first email does
// not sell: it says what we built for them and asks whether they want the link. "כן" gets the link; "הסר" (or "לא
// תודה") stops every email pitch to that address and marks its leads lost; the reminder, once, is the last. The
// sender's name is OpenFrequency, every email ends with our name and site, and each carries List-Unsubscribe (a mail to
// us with "הסר" as its subject, read the same way).
//
// The guardrails, as the WhatsApp pitch keeps them: once per address, product and stage (both counts as Toran's and
// Teder's), claimed and recorded in one statement so two presses send one; at most TORAN_OUTREACH_MAIL_DAILY (20) a
// day by Israel's calendar day; never at night, on Shabbat or a holiday (clock.ts customerQuiet: then nothing is
// recorded, and the next press or run sends it); never to an address on the stop list, one that bounced or complained
// (mail_suppressed), a number that asked to stop on WhatsApp, or a lead marked lost; and only with a page a visitor can
// open (pitch/ready.ts isPublic for Toran's; Teder's demo while it is up).
//
// Where the answer goes. The email goes out from our company store's address (src/company.ts: the platform 'company'
// store, TORAN_SUPPORT_STORE's first), its own domain's once that is verified at Resend (mailDomain.ts ownAddress),
// with Reply-To on our receiving domain, so the answer comes back through Resend's webhook to the company store's
// email account (channels/route.ts). A company store with no email account yet gets one here, <slug>@TORAN_MAIL_DOMAIN
// as the lead page's "לחבר מייל" makes it; one the operator turned off stays off, and nothing goes. The email is kept
// in our inbox in its own thread, and the answer lands in it (channels/store.ts threads by subject). mailPitchReply
// reads the answer before our support does: "הסר" and "כן" are answered here, anything else is our support's to
// answer, with the lead marked answered and the operator told once.
//
// Nothing here throws to its caller. An address in a log line is its first letter and its domain.

export type Product = 'toran' | 'teder' | 'both';
export type MailStage = 'first' | 'reminder';
/** Why a lead goes by email: no WhatsApp on its site, a number that is not a mobile, or Meta could not deliver. */
export type MailVia = 'no_mobile' | 'undelivered' | 'no_whatsapp';
export type MailWhy = 'no_store' | 'closed' | 'no_email' | 'bad_email' | 'not_on_sale' | 'stopped' | 'bounced' | 'already' | 'replied' | 'bad_page' | 'cap' | 'no_mail' | 'quiet' | 'failed';
export type MailOutcome = { sent: boolean; why: MailWhy | null; said: string };
/** tederUrl: Teder's demo as the caller read it from Teder (ops/both.ts); without it, our copy of Teder's demos. */
export type MailPitch = { storeId: number; product: Product; stage: MailStage; by: string; why: MailVia; tederUrl?: string | null };

/** What the operator reads for each outcome, as ops/outreach.ts SAID_HE says it for WhatsApp. */
export const MAIL_SAID_HE: Record<MailWhy, string> = {
  no_store: 'לא מצאתי את החנות הזו, אז לא נשלח כלום.',
  closed: 'הליד הזה סגור (סומן שלא מעוניין, דילגו עליו, ביקשו להוריד את הדף שלו, או שהוא כבר לקוח), אז לא שולחים לו מייל.',
  no_email: 'אין לליד הזה כתובת מייל, אז אין לאן לשלוח.',
  bad_email: 'כתובת המייל של הליד לא נראית תקינה, אז לא שלחנו אליה.',
  not_on_sale: 'תורן עוד לא במכירה באתר, אז מייל על תורן לא יוצא וכלום לא סומן. מייל על תדר לבד אפשר לשלוח.',
  stopped: 'הליד הזה ביקש שנסיר אותו, אז לא נשלח כלום ולא נכתוב לו יותר.',
  bounced: 'מיילים לכתובת הזו חזרו או סומנו כספאם, אז לא שולחים אליה.',
  already: 'ההודעה הזו כבר נשלחה לליד הזה, במייל או בוואטסאפ.',
  replied: 'הם כבר ענו לנו, אז תזכורת לא יוצאת. ממשיכים מהשיחה איתם בתיבה של התמיכה.',
  bad_page: 'הדף או המצגת שהמייל מציע עוד לא פתוחים לכולם, אז אין מה לשלוח.',
  cap: 'הגענו היום למכסת המיילים ללידים, אז לא נשלח כלום. מחר אפשר שוב.',
  no_mail: 'המייל שלנו לא מחובר (אין חנות שירות עם כתובת מייל פעילה, או שהמייל כבוי בשרת), אז לא נשלח כלום ולא סומן.',
  quiet: 'עכשיו לילה, שבת או חג, אז לא שולחים ללידים. המייל לא נשלח ולא סומן, ואפשר לשלוח כשייגמר.',
  failed: 'שירות המייל לא קיבל את ההודעה, ושום דבר לא סומן. אפשר לנסות שוב בעוד רגע.',
};
export const mailSentSaid = (email: string) => `נשלח במייל ${le(email)}.`;
const no = (why: MailWhy): MailOutcome => ({ sent: false, why, said: MAIL_SAID_HE[why] });

/** The line back to "הסר", once. */
export const MAIL_STOPPED_SAID = 'הסרנו אתכם, ולא נשלח לכם יותר מיילים כאלה. סליחה על ההפרעה.';

// ---- the words

/** The sender's name on every pitch and every answer to one. */
const FROM_NAME = 'OpenFrequency';
const SIGN = 'OpenFrequency\nopenfrequency.co.il';

const MIDDLE: Record<Product, (name: string) => string> = {
  toran: (n) => `בנינו ${le(n)} את תורן, עוזר שעונה ללקוחות שלכם בוואטסאפ, באינסטגרם ובצ׳אט באתר לפי המוצרים, המחירים והמלאי שבאתר שלכם. מה שהוא לא יודע עובר אליכם.\n\nהוא כבר מכיר את החנות. רוצים לנסות אותו? אפשר לענות "כן" למייל הזה ונשלח לכם קישור.`,
  teder: (n) => `הכנו ${le(n)} מצגת לטיקטוק ולאינסטגרם על נושא מהתחום שלכם, בעיצוב של החנות. תדר מכין מצגות כאלה כמה פעמים בשבוע, וכל אחת עולה רק אחרי שאישרתם אותה.\n\nרוצים לראות אותה? אפשר לענות "כן" למייל הזה ונשלח לכם קישור.`,
  both: (n) => `הכנו ${le(n)} שני דברים לנסות: את תורן, שעונה ללקוחות שלכם בוואטסאפ לפי המוצרים והמחירים שבאתר, ומצגת לדוגמה של תדר לטיקטוק ולאינסטגרם על נושא מהתחום שלכם.\n\nרוצים לראות? אפשר לענות "כן" למייל הזה ונשלח לכם קישורים.`,
};
const WAITING: Record<Product, (name: string) => string> = {
  toran: (n) => `תורן שבנינו ${le(n)} עדיין מחכה.`,
  teder: (n) => `המצגת שהכנו ${le(n)} עדיין מחכה.`,
  both: (n) => `תורן והמצגת שהכנו ${le(n)} עדיין מחכים.`,
};

/** The email, as the store reads it: plain text (the adapter sends it as HTML too, right to left, channels/email.ts). */
export function mailPitchText(product: Product, stage: MailStage, name: string): string {
  if (stage === 'first') return `שלום,\n\nכאן OpenFrequency. ${MIDDLE[product](name)}\n\nלא רלוונטי? עונים "הסר" ולא נכתוב שוב.\n\n${SIGN}`;
  return `שלום שוב,\n\n${WAITING[product](name)} אם תענו "כן" נשלח לכם ${product === 'both' ? 'קישורים' : 'קישור'}.\n\nזו ההודעה האחרונה שלנו בנושא. לא רלוונטי? עונים "הסר".\n\n${SIGN}`;
}

/** The first email's subject; the reminder's is "Re: " and the first one's, so the two are one thread on both sides. */
export const mailPitchSubject = (product: Product, name: string) =>
  product === 'toran' ? `עוזר וואטסאפ ${le(name)}` : product === 'teder' ? `מצגת לטיקטוק ${le(name)}` : `עוזר וואטסאפ ומצגת לטיקטוק ${le(name)}`;

const TORAN_YES = (name: string, url: string) => `זה תורן של ${name}: ${url}\nבעמוד יש כפתור שפותח איתו שיחה בוואטסאפ. כותבים לו כמו לקוח, למשל שאלה על מוצר או על משלוח, ורואים איך הוא עונה.`;
const TEDER_YES = (name: string, url: string) => `זו המצגת שתדר הכין ${le(name)}: ${url}`;

/** The answer to "כן": the links of what the email offered, those still up. */
export function mailYesText(name: string, toranUrl: string | null, tederUrl: string | null): string {
  if (toranUrl && tederUrl) return `מעולה. ${TORAN_YES(name, toranUrl)}\n\nו${TEDER_YES(name, tederUrl)}\n\nאם משהו לא מדויק, או שרוצים לראות איך תדר עובד אצלכם כל שבוע, אפשר לענות כאן.`;
  if (toranUrl) return `מעולה. ${TORAN_YES(name, toranUrl)}\n\nאם משהו לא מדויק, אפשר לענות כאן ונתקן.`;
  return `מעולה. ${TEDER_YES(name, String(tederUrl))}\nאם רוצים לראות איך זה עובד אצלכם כל שבוע, אפשר לענות כאן.`;
}

// ---- the limits

export const MAIL_DAILY_DEFAULT = 20;
export const mailDailyCap = (env: Record<string, string | undefined>) => {
  const raw = String(env.TORAN_OUTREACH_MAIL_DAILY ?? '').trim();
  const n = Math.floor(Number(raw));
  return raw !== '' && Number.isFinite(n) && n >= 0 ? Math.min(n, 1000) : MAIL_DAILY_DEFAULT;
};
/** An email on its way counts as sent this long, so two presses at once send one. */
const SENDING_MINUTES = 2;
/** How long after Meta could not deliver a WhatsApp pitch the email goes in its place. */
export const FALLBACK_DAYS = 14;
/** The one kind of Israeli number that reliably has WhatsApp (the owner, 2026-11-13: "if a phone start with +9725 whatsapp is 99% available"). */
export const ISRAELI_MOBILE = /^9725\d{8}$/;

const digits = (s: unknown) => String(s ?? '').replace(/\D/g, '');
const ADDRESS = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
/** An address as we keep it (lower-cased, no "mailto:"), or null when it is not one. */
export const mailAddress = (s: unknown): string | null => {
  const a = String(s ?? '').trim().toLowerCase().replace(/^mailto:/, '').split('?')[0];
  return a.length <= 254 && ADDRESS.test(a) ? a : null;
};
/** An address as a log line shows it: its first letter and its domain. */
export const maskEmail = (a: string) => {
  const [local, domain] = String(a).split('@');
  return domain ? `${local.slice(0, 1)}…@${domain}` : '…';
};
/** Any address (first letter and domain) and any run of 8 digits or more (last four) in a line for the log. */
const masked = (s: string) => s.replace(/[^\s@<>"'(),;:]+@([^\s@<>"'(),;:]+)/g, (m, d) => `${m.slice(0, 1)}…@${d}`).replace(/\d{8,}/g, (d) => `…${d.slice(-4)}`);
const productsOf = (p: Product): Product[] => (p === 'both' ? ['toran', 'teder', 'both'] : [p, 'both']);
const PRODUCTS = new Set<string>(['toran', 'teder', 'both']);
const page = (u: unknown) => (typeof u === 'string' && /^https?:\/\/\S+$/.test(u) ? u : null);
const bareSubject = (s: unknown) => String(s || '').replace(/^\s*((re|fwd?|תשובה|השב|הועבר)\s*:\s*)+/i, '').trim().toLowerCase();
const mark = (app: App, id: number | string, data: Record<string, unknown>) => app.db.query("UPDATE events SET data = data || $2::jsonb WHERE id = $1 AND kind = 'outreach_mail'", [id, J(data)]);

/** The same pitch, sent or on its way: this address, a product it counts as, this stage. */
const SAME = `kind = 'outreach_mail' AND data->>'email' = $1 AND data->>'product' = ANY($2::text[]) AND data->>'stage' = $3 AND (data->>'state' = 'sent' OR (data->>'state' = 'sending' AND at > now() - interval '${SENDING_MINUTES} minutes'))`;

/** Our own addresses are never a lead's. */
const ours = (app: App, address: string) => {
  const domain = address.split('@')[1] || '';
  return [app.mail?.domain, String(app.env.TORAN_MAIL_DOMAIN || '').toLowerCase(), 'openfrequency.co.il'].some((d) => d && (domain === d || domain.endsWith(`.${d}`)));
};

/**
 * Whether a lead's pitch goes by email instead of WhatsApp, and why: it has an address, email is on here, and its
 * WhatsApp is none, or a number that is not an Israeli mobile and never wrote to us (a demo asked for with its code
 * proves a number has WhatsApp). Null: WhatsApp, as before.
 */
export async function mailInsteadOf(app: App, phone: string | null | undefined, email: string | null | undefined): Promise<MailVia | null> {
  if (!mailAddress(email) || !mailOn(app)) return null;
  const n = digits(phone);
  if (!n) return 'no_whatsapp';
  if (ISRAELI_MOBILE.test(n)) return null;
  if (await app.db.one('SELECT 1 FROM demo_requests WHERE phone = $1 AND claimed_at IS NOT NULL LIMIT 1', [n])) return null;
  return 'no_mobile';
}

// ---- our mailbox

/** Email can really go from here: an adapter, the channel's code on, and not the simulator on the production server. */
const mailOn = (app: App) => Boolean(app.mail && enabledChannels(app.env).has('email') && !(app.mail.kind === 'sim' && toranEnv(app.env) === 'prod'));

type Mailbox = { storeId: number; accountId: number; address: string; from: string; replyTo: string };

/**
 * Where a pitch goes out from and where its answer comes back: our company store's email account (TORAN_SUPPORT_STORE's
 * store first, as payCheck.ts finds it), connected here when it has none, as the lead page's "לחבר מייל" connects one;
 * one turned off stays off. From the company's own domain once Resend verified it, Reply-To always on an address that
 * comes back to us. Null: no mail here (no adapter, email off, or the simulator on the production server, which would
 * send nothing and mark it sent), no company store, or its email off.
 */
async function ourMailbox(app: App): Promise<Mailbox | null> {
  if (!mailOn(app)) return null;
  const domain = String(app.env.TORAN_SUPPORT_STORE || '').trim().toLowerCase();
  const s = await app.db.one<{ id: number; slug: string | null; name: string | null }>("SELECT id, slug, name FROM stores WHERE platform = 'company' ORDER BY (domain = $1) DESC, id LIMIT 1", [domain]);
  if (!s) return null;
  const find = () => app.db.one<{ id: number; external_id: string; status: string }>("SELECT id, external_id, status FROM channel_accounts WHERE store_id = $1 AND channel = 'email' ORDER BY (status = 'active') DESC, id DESC LIMIT 1", [s.id]);
  let a = await find();
  if (!a) {
    const address = storeAddress(s, app.mail!.domain);
    const made = await app.db.one("INSERT INTO channel_accounts (store_id, channel, kind, external_id, name) VALUES ($1, 'email', $2, $3, $4) ON CONFLICT (channel, external_id) DO NOTHING RETURNING id", [s.id, app.mail!.kind, address, s.name || FROM_NAME]);
    if (made) {
      await audit(app.db, { actor: 'outreach', action: 'email_connect', storeId: s.id, detail: { address, why: 'the first email pitch' } });
      app.log(`[outreach-mail] our company store ${s.id} had no email address: connected ${address}, where the answers to the pitches come`);
    }
    a = await find();
  }
  if (!a || a.status !== 'active') return null;
  const own = await ownAddress(app, s.id);
  return { storeId: s.id, accountId: a.id, address: a.external_id, from: own?.from || a.external_id, replyTo: own && own.replyTo !== own.from ? own.replyTo : a.external_id };
}

// ---- one pitch

/**
 * One email pitch to a lead's store, unless a limit holds it. Never throws: the outcome says why, in the operator's
 * words (said). Recorded as an events row of kind outreach_mail on the store, claimed before the send.
 */
export async function emailPitch(app: App, p: MailPitch): Promise<MailOutcome> {
  try {
    return await pitchByMail(app, p);
  } catch (e: any) {
    app.log(`[outreach-mail] !!! store ${Number(p?.storeId) || '?'}: NOT SENT, ${masked(cleanLine(e?.message || e, 300))}`);
    return no('failed');
  }
}

async function pitchByMail(app: App, p: MailPitch): Promise<MailOutcome> {
  if (!PRODUCTS.has(p.product) || (p.stage !== 'first' && p.stage !== 'reminder')) return no('failed');
  const s = await app.db.one<any>(
    'SELECT id, name, brand, brand_override, domain, slug, status, platform, contact_email, contact_whatsapp, approved_at, page_built_at, takedown_asked_at, taken_down_at, lost_at, replied_at, workspace_id FROM stores WHERE id = $1',
    [Number(p.storeId) || 0],
  );
  if (!s) return no('no_store');
  // Lost, skipped, a store that asked us to take its page down, or one that is a customer already: no pitch.
  if (s.platform === 'company' || ['company', 'skipped', 'pilot', 'paid'].includes(s.status) || s.workspace_id || s.lost_at || s.takedown_asked_at || s.taken_down_at) return no('closed');
  if (!String(s.contact_email || '').trim()) return no('no_email');
  const email = mailAddress(s.contact_email);
  if (!email || ours(app, email)) return no('bad_email');
  // An email about Toran asks whether they want to try it: only once Toran is sold (ops/signupSwitch.ts), as on WhatsApp.
  if (p.product !== 'teder' && !toranOnSale(app.env)) return no('not_on_sale');
  const name = cleanLine(displayName(s.brand_override?.name, s.brand?.name, s.name) || s.domain, 80) || 'החנות';
  const products = productsOf(p.product);
  const phone = digits(s.contact_whatsapp);
  const who = `${p.product} ${p.stage} email to ${maskEmail(email)} (store ${s.id}, ${p.why})`;

  if (await app.db.one('SELECT 1 FROM outreach_mail_stops WHERE email = $1', [email])) return no('stopped');
  if (phone && (await app.db.one('SELECT 1 FROM outreach_stops WHERE phone = $1', [phone]))) return no('stopped');
  if (await app.db.one('SELECT 1 FROM mail_suppressed WHERE address = $1', [email])) return no('bounced');
  if (await app.db.one(`SELECT 1 FROM events WHERE ${SAME}`, [email, products, p.stage])) return no('already');
  // The same message on WhatsApp, taken by Meta and not reported undelivered, was the one approach the law allows.
  if (await app.db.one("SELECT 1 FROM events WHERE store_id IS NULL AND kind = 'outreach_wa' AND data->>'ref' = ANY($1::text[]) AND data->>'product' = ANY($2::text[]) AND data->>'stage' = $3 AND data->>'state' = 'sent' LIMIT 1", [[`store:${s.id}`, `toran:${s.id}`], products, p.stage])) return no('already');
  // A store that answered us is talked with, never reminded.
  if (p.stage === 'reminder' && (s.replied_at || (await app.db.one("SELECT 1 FROM events WHERE kind = 'outreach_mail' AND data->>'email' = $1 AND data->>'state' = 'sent' AND data->>'answered' IS NOT NULL LIMIT 1", [email])))) return no('replied');

  // The pages it offers, only while a visitor can open them: Toran's pitch page as the page itself decides
  // (pitch/ready.ts), Teder's demo while Teder has it up.
  let toranUrl: string | null = null;
  let tederUrl: string | null = null;
  if (p.product !== 'teder') {
    const { pitchGaps, isPublic } = await import('../pitch/ready.ts');
    if (!s.slug || !s.page_built_at || !isPublic(s, await pitchGaps(app, s))) return no('bad_page');
    toranUrl = pitchUrl(app.env, s.slug);
  }
  if (p.product !== 'toran') {
    tederUrl = page(p.tederUrl) || (await tederPage(app, s.domain, phone));
    if (!tederUrl) return no('bad_page');
  }

  const day = israelDate(now());
  const cap = mailDailyCap(app.env);
  const today = (await app.db.one<{ n: number }>(`SELECT COUNT(*)::int AS n FROM events WHERE kind = 'outreach_mail' AND data->>'day' = $1 AND (data->>'state' = 'sent' OR (data->>'state' = 'sending' AND at > now() - interval '${SENDING_MINUTES} minutes'))`, [day]))?.n || 0;
  if (today >= cap) {
    app.log(`[outreach-mail] ${who}: not sent (${cap} went today, the day's cap)`);
    return no('cap');
  }
  const box = await ourMailbox(app);
  if (!box) {
    app.log(`[outreach-mail] !!! ${who}: NOT SENT, no mailbox of ours to send from (email off here, no company store, or its email turned off)`);
    return no('no_mail');
  }
  // Quiet hours last: nothing is recorded, so the operator's next press, or the next run, sends it.
  if (customerQuiet(now())) return no('quiet');

  // The reminder answers the first email when one went to this address, so the two are one thread; after a WhatsApp
  // first message, it has a subject of its own (a "Re:" on nothing reads as a trick).
  const first = p.stage === 'reminder'
    ? await app.db.one<{ subject: string | null }>("SELECT data->>'subject' AS subject FROM events WHERE kind = 'outreach_mail' AND data->>'email' = $1 AND data->>'product' = ANY($2::text[]) AND data->>'stage' = 'first' AND data->>'state' = 'sent' ORDER BY id DESC LIMIT 1", [email, products])
    : null;
  const subject = first?.subject ? `Re: ${first.subject}` : mailPitchSubject(p.product, name);
  const by = cleanLine(p.by, 120) || 'operator';
  const claim = await app.db
    .one<{ id: number }>(`INSERT INTO events (store_id, kind, data) SELECT $4::integer, 'outreach_mail', $5::jsonb WHERE NOT EXISTS (SELECT 1 FROM events WHERE ${SAME}) RETURNING id`, [
      email,
      products,
      p.stage,
      s.id,
      J({ product: p.product, stage: p.stage, email, ref: `store:${s.id}`, by, why: p.why, day, state: 'sending', subject, name, toran_url: toranUrl, teder_url: tederUrl }),
    ])
    .catch(() => null);
  if (!claim) return no('already');

  const text = mailPitchText(p.product, p.stage, name);
  let sentId = '';
  try {
    const ctx: SendCtx = { who: 'owner', storeName: FROM_NAME, from: box.from, replyTo: box.replyTo, subject, headers: { 'List-Unsubscribe': `<mailto:${box.replyTo}?subject=${encodeURIComponent('הסר')}>` } };
    const sent = await app.mail!.send(email, text, { channel: 'email', from: email, text: '', id: `outreach-mail-${claim.id}`, account: box.address, subject }, ctx);
    sentId = sent.id || '';
    await mark(app, claim.id, { state: 'sent', id: sentId || null });
  } catch (e: any) {
    const why = masked(cleanLine(e?.message || e, 300));
    await mark(app, claim.id, { state: 'failed', error: why }).catch(() => {});
    app.log(`[outreach-mail] !!! ${who} FAILED: ${why}`);
    return no('failed');
  }
  await usage(app.db, { storeId: box.storeId, kind: 'mail', backend: app.mail!.kind, units: 1, usd: 0, apiUsd: 0, tag: 'mail_outreach' }).catch(() => {});
  await keepMail(app, box, { eventId: claim.id, email, name, subject, text, by, sentId }).catch((e) => app.log(`[outreach-mail] ${who}: sent, and not kept in our inbox (${masked(cleanLine(e?.message || e, 200))})`));
  app.log(`[outreach-mail] ${who}: sent`);
  return { sent: true, why: null, said: mailSentSaid(email) };
}

/** Teder's demo of the store in our copy of Teder's demos (ops/sources.ts syncTeder), by its domain or its number. */
async function tederPage(app: App, domain: string, phone: string): Promise<string | null> {
  const r = await app.db.one<{ page_url: string }>(
    "SELECT page_url FROM teder_leads WHERE (domain = $1 OR (whatsapp IS NOT NULL AND whatsapp = $2)) AND page_url IS NOT NULL AND removed_at IS NULL AND lost_at IS NULL ORDER BY synced_at DESC LIMIT 1",
    [domain, phone || '-'],
  );
  return page(r?.page_url);
}

/**
 * The email in our own inbox, as the WhatsApp pitch is (outreach.ts keepPitch): in a thread of its own on our company
 * store's email account, the operator's message, with the store's name; the reminder in the first one's thread. Their
 * answer finds the thread by its subject (channels/store.ts threadFor), so our support answers it with the pitch in view.
 */
async function keepMail(app: App, box: Mailbox, k: { eventId: number; email: string; name: string; subject: string; text: string; by: string; sentId: string }) {
  const bare = bareSubject(k.subject);
  const c =
    (await app.db.one<{ id: number }>("SELECT id FROM conversations WHERE account_id = $1 AND peer = $2 AND meta->>'bare' = $3 ORDER BY last_at DESC LIMIT 1", [box.accountId, k.email, bare])) ||
    (await app.db.one<{ id: number }>("INSERT INTO conversations (store_id, channel, peer, account_id, meta) VALUES ($1, 'email', $2, $3, $4::jsonb) RETURNING id", [box.storeId, k.email, box.accountId, J({ subject: k.subject, bare, ids: [], name: k.name })]));
  await app.db.query("INSERT INTO messages (conversation_id, role, text, author, auto, delivery) VALUES ($1, 'owner', $2, $3, 'outreach', $4::jsonb)", [c!.id, k.text, k.by === 'auto' ? 'אוטומטי' : k.by, J(k.sentId ? [k.sentId] : [])]);
  await app.db.query('UPDATE conversations SET last_at = now() WHERE id = $1', [c!.id]);
  await mark(app, k.eventId, { kept: c!.id });
}

// ---- their answer

// Read on the whole message, as STOP_REPLY is on WhatsApp (ops/outreach.ts): a short answer made only of these words,
// with at least one that decides it. An email often has a greeting and a name around the word ("היי,\nכן\nדני"), so the
// first line alone is read too when what follows it is a name, not a question. A "לא" or "no" anywhere is never a yes.
const STOP_CORE = new Set(['הסר', 'הסירו', 'תסירו', 'להסיר', 'הסירי', 'לא', 'unsubscribe', 'stop', 'no', 'remove']);
const STOP_WORDS = new Set([...STOP_CORE, 'אותי', 'אותנו', 'אותם', 'בבקשה', 'נא', 'מהרשימה', 'מהרשימות', 'תודה', 'מעוניין', 'מעוניינת', 'מעוניינים', 'מעוניינות', 'רלוונטי', 'רלוונטית', 'לנו', 'לי', 'כרגע', 'me', 'thanks', 'thank', 'you', 'please']);
const YES_CORE = new Set(['כן', 'בטח', 'אשמח', 'נשמח', 'תשלחו', 'שלחו', 'תשלח', 'סבבה', 'יאללה', 'אוקיי', 'אוקי', 'בשמחה', 'מעוניין', 'מעוניינת', 'מעוניינים', 'מעוניינות', 'yes', 'ok', 'okay', 'sure', 'yep', 'yeah']);
const YES_WORDS = new Set([...YES_CORE, 'בבקשה', 'תודה', 'לראות', 'לנסות', 'את', 'הקישור', 'קישור', 'הקישורים', 'קישורים', 'לינק', 'הלינק', 'לי', 'לנו', 'please', 'thanks', 'send', 'it', 'the', 'link']);
const NEVER_YES = new Set(['לא', 'no', 'not', 'אל', 'אין']);
const GREETING = /^(?:היי|הי|שלום|אהלן|הלו|בוקר טוב|ערב טוב|צהריים טובים|hi|hello|hey)(?=[\s,.!:]|$)[\s,.!:]*/i;

const wordsOf = (s: string) => s.replace(GREETING, '').toLowerCase().replace(/[.,!?;:"'״׳()[\]…–—-]+/g, ' ').split(/\s+/).filter(Boolean);

function wordOf(words: string[]): 'stop' | 'yes' | null {
  if (!words.length || words.length > 6) return null;
  if (words.every((w) => STOP_WORDS.has(w)) && words.some((w) => STOP_CORE.has(w))) return 'stop';
  if (words.join(' ') === 'אין צורך' || words.join(' ') === 'אין צורך תודה') return 'stop';
  if (!words.some((w) => NEVER_YES.has(w)) && words.every((w) => YES_WORDS.has(w)) && words.some((w) => YES_CORE.has(w))) return 'yes';
  return null;
}

/** "הסר" or "כן" (or neither) in an answer: its new text, else its subject (List-Unsubscribe's mail has only that). */
export function mailWord(text: string, subject?: string | null): 'stop' | 'yes' | null {
  const body = stripQuoted(String(text || '')).trim();
  if (!body) return wordOf(wordsOf(bareSubject(subject)));
  const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);
  const whole = wordOf(wordsOf(lines.join(' ')));
  if (whole || lines.length < 2) return whole;
  // A greeting on a line of its own, then the word.
  const start = GREETING.test(lines[0]) && !wordsOf(lines[0]).length ? 1 : 0;
  const rest = lines.slice(start + 1).join(' ');
  const signature = wordsOf(rest).length <= 3 && !/[?\d@]/.test(rest);
  return signature ? wordOf(wordsOf(lines[start] || '')) : null;
}

/**
 * An answer to one of our email pitches, on our company store's email account, before our support reads it: the latest
 * pitch sent to this address in the last REPLY_DAYS. "הסר" (and the rest of the way out) puts the address on the stop
 * list, marks its leads lost, says so once; "כן" sends the links and tells the operator; anything else marks the lead
 * answered, tells the operator once, and is our support's to answer (null). Null too for anything that is not an answer
 * to a pitch, or that a machine wrote (channels/email.ts automated: an out-of-office is no answer).
 */
export async function mailPitchReply(app: App, adapter: ChannelAdapter, inbound: Inbound, account: Account): Promise<RouteResult | null> {
  if (adapter.channel !== 'email' || inbound.automated) return null;
  const email = mailAddress(inbound.from);
  if (!email) return null;
  // The address index (migration 081) finds the few pitches there are.
  const e = await app.db.one<{ id: number; store_id: number | null; data: any }>(
    `SELECT id, store_id, data FROM events WHERE kind = 'outreach_mail' AND data->>'email' = $1 AND data->>'state' = 'sent' AND at > now() - interval '${REPLY_DAYS} days' ORDER BY id DESC LIMIT 1`,
    [email],
  );
  if (!e) return null;
  if (!(await app.db.one("SELECT 1 FROM stores WHERE id = $1 AND platform = 'company'", [account.store_id]))) return null;
  const d = e.data || {};
  const lead = { eventId: Number(e.id), storeId: e.store_id ? Number(e.store_id) : null, email, product: (PRODUCTS.has(d.product) ? d.product : 'toran') as Product, name: cleanLine(d.name, 80) || 'החנות' };
  const said = cleanLine(stripQuoted(String(inbound.text || '')) || bareSubject(inbound.subject), 300);
  const word = mailWord(String(inbound.text || ''), inbound.subject);
  if (word === 'stop') return mailStop(app, adapter, inbound, account, lead, said);
  if (word === 'yes') {
    const r = await mailYes(app, adapter, inbound, account, lead, d, said);
    if (r) return r;
  }
  await mailReplied(app, lead, d, said);
  return null;
}

type Lead = { eventId: number; storeId: number | null; email: string; product: Product; name: string };

/** How an answer to them goes: from the address the pitch went from, Reply-To back to us, with our name. */
async function answerCtx(app: App, account: Account): Promise<SendCtx> {
  const own = await ownAddress(app, account.store_id);
  return { who: 'agent', storeName: FROM_NAME, ...(own ? { from: own.from, replyTo: own.replyTo !== own.from ? own.replyTo : account.external_id } : {}) };
}

/**
 * Their message and our answer, in the thread, before the answer goes (its parts' ids kept as each goes): a webhook
 * delivered twice is then a duplicate (route.ts reads ext_id), and a job run again after a failed send sends what did
 * not go out (store.ts resendUndelivered, by reply_to).
 */
async function answer(app: App, adapter: ChannelAdapter, inbound: Inbound, account: Account, text: string, auto: string): Promise<number> {
  const conv = await conversationOf(app, adapter, account, inbound);
  await app.db.query("INSERT INTO messages (conversation_id, role, text, ext_id) VALUES ($1, 'customer', $2, $3) ON CONFLICT (ext_id) DO NOTHING", [conv, String(inbound.text || ''), inbound.id]);
  const m = await app.db.one<{ id: number }>("INSERT INTO messages (conversation_id, role, text, author, auto, reply_to, delivery) VALUES ($1, 'agent', $2, 'אוטומטי', $3, $4, '[]'::jsonb) RETURNING id", [conv, text, auto, inbound.id]);
  const c = await app.db.one<{ meta: any }>('SELECT meta FROM conversations WHERE id = $1', [conv]);
  const ids = [...new Set([...(c?.meta?.ids || []), ...[inbound.thread?.messageId, ...(inbound.thread?.references || [])].filter(Boolean)])].slice(-50);
  await app.db.query('UPDATE conversations SET last_at = now(), meta = meta || $2::jsonb WHERE id = $1', [conv, J({ ids })]);
  await reply(app, adapter, inbound, text, account.store_id, conv, await answerCtx(app, account), { onPart: (sent) => app.db.query('UPDATE messages SET delivery = $2::jsonb WHERE id = $1', [m!.id, J(sent)]) });
  return conv;
}

async function mailStop(app: App, adapter: ChannelAdapter, inbound: Inbound, account: Account, l: Lead, said: string): Promise<RouteResult> {
  const fresh = await app.db.one('INSERT INTO outreach_mail_stops (email, product, said) VALUES ($1, $2, $3) ON CONFLICT (email) DO NOTHING RETURNING email', [l.email, l.product, cleanLine(said, 200)]);
  if (!fresh) {
    const conv = await conversationOf(app, adapter, account, inbound);
    await app.db.query("INSERT INTO messages (conversation_id, role, text, ext_id) VALUES ($1, 'customer', $2, $3) ON CONFLICT (ext_id) DO NOTHING", [conv, String(inbound.text || ''), inbound.id]);
    return { action: 'outreach_stop_again', storeId: account.store_id };
  }
  await mark(app, l.eventId, { answered: 'stop' });
  // Every lead with this address is lost (opted_out, as outreach.ts outreachWord marks them), in both products, and its
  // WhatsApp is on that stop list too: they asked us to stop writing, not to stop emailing.
  const stores = await app.db.query<{ id: number; domain: string; contact_whatsapp: string | null }>(
    "UPDATE stores SET lost_at = COALESCE(lost_at, now()), lost_reason = COALESCE(lost_reason, 'opted_out'), updated_at = now() WHERE (id = $1 OR lower(trim(contact_email)) = $2) AND platform IS DISTINCT FROM 'company' RETURNING id, domain, contact_whatsapp",
    [l.storeId || 0, l.email],
  );
  const domains = stores.map((s) => s.domain).filter(Boolean);
  if (domains.length) await app.db.query("UPDATE teder_leads SET lost_at = COALESCE(lost_at, now()), lost_reason = COALESCE(lost_reason, 'opted_out') WHERE domain = ANY($1::text[])", [domains]);
  for (const phone of new Set(stores.map((s) => digits(s.contact_whatsapp)).filter(Boolean))) {
    await app.db.query('INSERT INTO outreach_stops (phone, product, said) VALUES ($1, $2, $3) ON CONFLICT (phone) DO NOTHING', [phone, l.product, cleanLine(`${said} (במייל)`, 200)]);
  }
  await event(app.db, l.storeId, 'outreach_mail_stop', { email: maskEmail(l.email), product: l.product });
  await audit(app.db, { actor: `mail:${l.email}`, action: 'outreach_stop', storeId: l.storeId, detail: { product: l.product, via: 'email' } });
  app.log(`[outreach-mail] ${maskEmail(l.email)} asked to be removed (${l.product}): no pitch goes to it again`);
  await answer(app, adapter, inbound, account, MAIL_STOPPED_SAID, 'outreach_stop');
  return { action: 'outreach_stop', storeId: account.store_id, reply: MAIL_STOPPED_SAID };
}

/** The pages the pitch offered that are still up: Toran's while its store has not taken it down. */
async function stillUp(app: App, l: Lead, d: any): Promise<{ toranUrl: string | null; tederUrl: string | null }> {
  let toranUrl = l.product === 'teder' ? null : page(d.toran_url);
  if (toranUrl && l.storeId && (await app.db.one('SELECT 1 FROM stores WHERE id = $1 AND taken_down_at IS NOT NULL', [l.storeId]))) toranUrl = null;
  return { toranUrl, tederUrl: l.product === 'toran' ? null : page(d.teder_url) };
}

/** The lead answered: marked as leadReplied marks it (ops/leadReply.ts), in our stores and our copy of Teder's, and Teder's own. */
async function leadAnswered(app: App, l: Lead) {
  const next = new Date(notOnShabbat(now() + DAY)).toISOString();
  const s = l.storeId ? await app.db.one<{ id: number; domain: string }>('UPDATE stores SET replied_at = COALESCE(replied_at, now()), snoozed_until = NULL, next_step_at = COALESCE(next_step_at, $2), updated_at = now() WHERE id = $1 RETURNING id, domain', [l.storeId, next]) : null;
  if (!s || l.product === 'toran') return;
  await app.db.query('UPDATE teder_leads SET replied_at = COALESCE(replied_at, now()), snoozed_until = NULL, next_step_at = COALESCE(next_step_at, $2) WHERE domain = $1 AND lost_at IS NULL', [s.domain, next]);
  try {
    const st = await tederState(app, s);
    if ('error' in st || !st.lead || !['demo_ready', 'sent', 'opened'].includes(st.lead.stage)) return;
    const r = await tederMove(app, s, 'replied', 'תורן');
    if ('error' in r) app.log(`[outreach-mail] Teder did not mark ${s.domain} answered: ${r.error}`);
  } catch (e: any) {
    app.log(`[outreach-mail] Teder's lead of ${s.domain} was not marked answered: ${e?.message || e}`);
  }
}

async function mailYes(app: App, adapter: ChannelAdapter, inbound: Inbound, account: Account, l: Lead, d: any, said: string): Promise<RouteResult | null> {
  const { toranUrl, tederUrl } = await stillUp(app, l, d);
  // Nothing of what we offered is up any more: our support answers them, and the operator hears of it.
  if (!toranUrl && !tederUrl) return null;
  const fresh = await app.db.one("UPDATE events SET data = data || $2::jsonb WHERE id = $1 AND kind = 'outreach_mail' AND data->>'yes' IS NULL RETURNING id", [l.eventId, J({ yes: new Date(now()).toISOString(), answered: 'yes' })]);
  const text = mailYesText(l.name, toranUrl, tederUrl);
  const conv = await answer(app, adapter, inbound, account, text, 'outreach_yes');
  await leadAnswered(app, l);
  if (fresh) {
    const links = toranUrl && tederUrl ? 'שני הקישורים' : 'הקישור';
    await alertOperator(app, `lead_mail_yes:${l.eventId}`, `${l.name} ביקשו את הקישור במייל`, `"${said || 'כן'}". שלחנו להם את ${links} במייל. ממשיכים מהשיחה: ${publicBase(app.env)}/chat/${conv}`, { storeId: l.storeId, everyMinutes: REPLY_DAYS * 24 * 60 }).catch((e) => app.log(`[outreach-mail] the operator alert failed: ${e?.message || e}`));
  }
  app.log(`[outreach-mail] ${maskEmail(l.email)} said yes (${l.product}): the links went`);
  return { action: 'answered', storeId: account.store_id, reply: text };
}

/** Anything else they wrote: the lead answered, the operator told once; our support answers them. */
async function mailReplied(app: App, l: Lead, d: any, said: string) {
  const fresh = await app.db.one("UPDATE events SET data = data || $2::jsonb WHERE id = $1 AND kind = 'outreach_mail' AND data->>'replied' IS NULL RETURNING id", [l.eventId, J({ replied: new Date(now()).toISOString(), ...(d.answered ? {} : { answered: 'replied' }) })]);
  if (!fresh) return;
  await leadAnswered(app, l);
  const where = `${publicBase(app.env)}${d.kept ? `/chat/${Number(d.kept)}` : '/chats'}`;
  await alertOperator(app, `lead_mail_reply:${l.eventId}`, `${l.name} ענו למייל שלנו`, `"${said || 'מייל בלי טקסט'}". תורן עונה להם מהתמיכה. ממשיכים מהשיחה: ${where}`, { storeId: l.storeId, everyMinutes: REPLY_DAYS * 24 * 60 }).catch((e) => app.log(`[outreach-mail] the operator alert failed: ${e?.message || e}`));
}

// ---- the email in place of a WhatsApp pitch Meta could not deliver

/**
 * Every WhatsApp pitch of the last FALLBACK_DAYS that Meta took and then could not deliver (131026 and the rest,
 * outreach.ts pitchNotDelivered), to a lead whose store has an address and no email of that product and stage yet: the
 * email goes in its place, under the same limits. The WhatsApp pitch keeps what came of it (mailed), so each is tried
 * once; the day's cap, the quiet hours and no mailbox stop the run and leave the rest for the next. Returns how many went.
 * For the worker, every minute: nothing at all is read while email is off or it is quiet, and one indexed query when
 * nothing is due.
 */
export async function emailFallbackDue(app: App): Promise<number> {
  if (!mailOn(app) || customerQuiet(now())) return 0;
  const due = await app.db.query<{ id: number; store_id: number; data: any }>(
    `SELECT e.id, s.id AS store_id, e.data FROM events e
       JOIN stores s ON s.id = substring(e.data->>'ref' from '^(?:store|toran):([0-9]{1,9})$')::integer
      WHERE e.store_id IS NULL AND e.kind = 'outreach_wa' AND e.at > now() - interval '${FALLBACK_DAYS} days' AND e.data->>'state' = 'undelivered'
        AND e.data->>'mailed' IS NULL AND e.data->>'stage' IN ('first', 'reminder') AND e.data->>'product' IN ('toran', 'teder', 'both')
        AND COALESCE(trim(s.contact_email), '') <> '' AND s.lost_at IS NULL AND s.replied_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM events m WHERE m.store_id = s.id AND m.kind = 'outreach_mail' AND m.data->>'stage' = e.data->>'stage' AND m.data->>'state' IN ('sent', 'sending')
              AND (m.data->>'product' = e.data->>'product' OR m.data->>'product' = 'both' OR e.data->>'product' = 'both'))
      ORDER BY e.id LIMIT 20`,
  );
  let n = 0;
  for (const r of due) {
    const d = r.data || {};
    const product = d.product as Product;
    const out = await emailPitch(app, { storeId: Number(r.store_id), product, stage: d.stage, by: 'auto', why: 'undelivered', tederUrl: product === 'teder' ? d.url : product === 'both' ? d.url2 : null });
    if (out.why === 'cap' || out.why === 'quiet' || out.why === 'no_mail') break;
    await app.db.query("UPDATE events SET data = data || $2::jsonb WHERE id = $1 AND kind = 'outreach_wa'", [r.id, J({ mailed: out.sent ? 'sent' : out.why })]);
    if (out.sent) n++;
  }
  return n;
}
