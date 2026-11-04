import type { App } from '../app.ts';
import type { Out, Req, Route } from '../web/server.ts';
import type { RouteResult } from '../channels/demo.ts';
import { lineNumber, metaLinesAdapter } from '../channels/lines.ts';
import { reply } from '../channels/send.ts';
import type { ChannelAdapter, Inbound } from '../channels/types.ts';
import { cleanLine } from '../core/hebrew.ts';
import { J } from '../db/index.ts';
import { audit, event, usage } from '../db/log.ts';
import { internalRefusal } from '../ops/api.ts';
import { alertOperator } from '../ops/alert.ts';
import { setConsent } from '../owners/identity.ts';

// POST /internal/pay/remind: openfrequency-accounts hands Toran a payment reminder for one owner's WhatsApp (the owner,
// 2026-11-03: "add a reminder to pay for the new month, whatsapp, email and dashboard. A user has 72 hours to pay for a
// new month once their subscription has ended"). Accounts' daily run (its src/web/daily.js) decides who and when, by its
// own rule for the grace (72 hours, or 14 days for a workspace still on the older terms): the day before the paid month
// ends (soon1), the first day after it (due) and the last day of the grace (last), to each number accounts verified for
// the workspace's owners and to the number the workspace last paid from (its latest receipt marked paid), once each,
// beside the email, which goes whatever happens here. The contract is accounts' docs/contracts/pay-remind.json
// (test/fixtures/contracts here).
//
// Toran sends it from our number on Meta's Cloud API (channels/lines.ts, the owner line's number, which is where
// accounts' "לתשלום בוואטסאפ" leads), always the approved template payment_reminder below: outside the 24 hours after
// the owner last wrote to us WhatsApp takes nothing else. Its one button, "לתשלום", is a quick reply whose payload is
// the workspace's payment code (PAY-XXXXXX), never shown: pressed, it comes back as a message with the code
// (channels/meta.ts textOf), which the pay flow answers with the amount and the transfer's details and a wait for the
// receipt (channels/pay.ts), exactly as it answers the message accounts' button writes.
//
// Under the checks of ops/api.ts internalRefusal (503 not_configured, 403 forbidden from anywhere but this machine or
// through Caddy, 401 bad_token), then 405 for a GET and 400 bad_reminder, and the answer:
//
//   200 { ok: true, sent: true,  why: null }        Meta took it
//   200 { ok: true, sent: false, why: 'already' }   this reminder (workspace, kind, paid period) went to this phone before
//   200 { ok: true, sent: false, why: 'held' }      the limits below hold it
//   200 { ok: true, sent: false, why: 'stopped' }   the number wrote "הפסק" after a reminder (reminderWord, below)
//   200 { ok: true, sent: false, why: 'failed' }    Meta refused it or did not answer, or none of our numbers is on Meta
//
// The limits, from the events of kind pay_reminder_wa (each try: { key, workspace, kind, phone, state, id | code,
// error }): a reminder goes to a phone once (a retry is 'already'); a phone gets at most REMIND_WEEK_MAX in any
// REMIND_WEEK_DAYS; and after Meta refuses one (before the approval, every one is refused) none is tried for
// REMIND_HOLD_MINUTES.
//
// "הפסק" stops them, here, for any number: a number that got a reminder and writes "הפסק" (or "תפסיק", "stop", as the
// owner line reads it) to our number is kept in pay_remind_stops and gets none until it writes "התחל" (reminderWord,
// read on our number before anything but a demo request and a payment code). Toran keeps it because Toran hears it:
// accounts knows the number it paid from only by its receipts, and the owner line keeps "הפסק" only from an owner of a
// Toran store. Accounts is told too (its POST /internal/owner-phone/consent), which counts for a number linked there.
//
// Every outcome but sent is a log line, a refusal a loud one ("[remind] !!! ..."), and the
// operator hears of a refusal once a day (ops/alert.ts). Nothing here throws. A number in a log line is its last four
// digits.

export const REMIND_PATH = '/internal/pay/remind';
const PATH = /^\/internal\/pay\/remind$/;
const BODY_LIMIT = 4096;
export const REMIND_KINDS = ['soon1', 'due', 'last'] as const;
export type RemindKind = (typeof REMIND_KINDS)[number];
const PRODUCTS = ['teder', 'toran'] as const;
type Product = (typeof PRODUCTS)[number];
/** The products' names, as accounts writes them. */
export const PRODUCT_HE: Record<Product, string> = { teder: 'תדר', toran: 'תורן' };

/** A phone's reminders: at most this many in this many days. A paid month owes three, days apart. */
export const REMIND_WEEK_MAX = 3;
export const REMIND_WEEK_DAYS = 7;
/** After Meta refuses one, none is tried for this long. */
export const REMIND_HOLD_MINUTES = 60;
/** A try still on its way counts as sent for this long, so a second request at the same moment is 'already'. */
const SENDING_MINUTES = 2;

export type ReminderTemplate = { name: string; category: 'UTILITY'; language: 'he'; body: string; button: string; example: string[] };

/**
 * The template, to be submitted in WhatsApp Manager exactly so (docs/whatsapp-templates.md is written from it by
 * scripts/templates-doc.ts). Its text is fixed and its four variables are facts: {{1}} the product (or both, "תדר
 * ותורן"), {{2}} the business, {{3}} the last day paid for, {{4}} the last day of the grace with its weekday, so it reads
 * as an update about the customer's own subscription, the same for every kind. One quick reply button, "לתשלום".
 */
export const PAYMENT_REMINDER: ReminderTemplate = {
  name: 'payment_reminder',
  category: 'UTILITY',
  language: 'he',
  body: 'המנוי ל{{1}} בחשבון של {{2}} ב-OpenFrequency שולם עד {{3}}. התשלום על החודש הבא צריך להגיע אלינו עד סוף {{4}}. אם הוא לא יגיע עד אז, השירות ייעצר עד שנקבל אותו.\n\nכדי לשלם, לוחצים על הכפתור ונשלח לכם כאן את הסכום ואת פרטי ההעברה. כבר שילמתם? אפשר להתעלם מההודעה הזו.',
  button: 'לתשלום',
  example: ['תדר', 'מאפיית השכונה', '21.11.2026', 'יום שלישי, 24.11.2026'],
};

/** One reminder, as accounts hands it over. Dates are Israel calendar days, YYYY-MM-DD, decided by accounts. */
export type Reminder = { workspace: number; phone: string; kind: RemindKind; business: string; products: Product[]; paidUntil: string; graceUntil: string; code: string };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const realDay = (v: unknown): v is string => typeof v === 'string' && DAY.test(v) && new Date(`${v}T00:00:00.000Z`).toISOString().slice(0, 10) === v;
/** International digits, as accounts keeps a number: a country code and the number, 8 to 15 digits. */
const PHONE = /^[1-9]\d{7,14}$/;
/** Accounts' payment code (its src/accounts/pay.js PAY_CODE). */
const PAY_CODE = /^PAY-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;

/** The reminder in a request's body, or null when it is not one. */
export function readReminder(raw: string | undefined): Reminder | null {
  const text = raw || '';
  if (Buffer.byteLength(text, 'utf8') > BODY_LIMIT) return null;
  let b: any;
  try {
    b = JSON.parse(text);
  } catch {
    return null;
  }
  if (!b || typeof b !== 'object' || Array.isArray(b)) return null;
  const { workspace, phone, kind, business, products, paidUntil, graceUntil, code } = b;
  if (!Number.isSafeInteger(workspace) || workspace <= 0) return null;
  if (typeof phone !== 'string' || !PHONE.test(phone)) return null;
  if (!(REMIND_KINDS as readonly string[]).includes(kind)) return null;
  if (typeof business !== 'string' || business.length > 200 || !cleanLine(business, 200)) return null;
  if (!Array.isArray(products) || !products.length || products.length > PRODUCTS.length || new Set(products).size !== products.length || !products.every((p) => (PRODUCTS as readonly string[]).includes(p))) return null;
  if (!realDay(paidUntil) || !realDay(graceUntil) || graceUntil <= paidUntil) return null;
  if (typeof code !== 'string' || !PAY_CODE.test(code)) return null;
  return { workspace, phone, kind, business, products: PRODUCTS.filter((p) => products.includes(p)), paidUntil, graceUntil, code };
}

/** A calendar day as accounts writes it: "1.12.2026". */
export const dayHe = (d: string) => `${Number(d.slice(8, 10))}.${Number(d.slice(5, 7))}.${d.slice(0, 4)}`;
const WEEKDAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
/** A day with its weekday, for a deadline, as accounts writes it: "יום שלישי, 24.11.2026". */
export const weekdayHe = (d: string) => `יום ${WEEKDAYS[new Date(`${d}T00:00:00.000Z`).getUTCDay()]}, ${dayHe(d)}`;

/** {{1}} to {{4}}, each one line as Meta takes it (no newline, tab or run of spaces), never empty. */
export function reminderParams(r: Pick<Reminder, 'products' | 'business' | 'paidUntil' | 'graceUntil'>): [string, string, string, string] {
  const names = r.products.map((p) => PRODUCT_HE[p]);
  return [names.length > 1 ? `${names.slice(0, -1).join(', ')} ו${names.at(-1)}` : names[0], cleanLine(r.business, 80) || '-', dayHe(r.paidUntil), weekdayHe(r.graceUntil)];
}

/** The template as the customer reads it, filled in. */
export const reminderFilled = (vars: string[]) => PAYMENT_REMINDER.body.replace(/\{\{(\d+)\}\}/g, (_, i) => vars[Number(i) - 1] ?? '');

/** Any run of 8 digits or more (a phone, our number's Meta id) as its last four, for a log line. */
const masked = (s: string) => s.replace(/\d{8,}/g, (d) => `…${d.slice(-4)}`);

export type Outcome = { sent: boolean; why: 'already' | 'held' | 'stopped' | 'failed' | null };

/** Meta's code for a template it does not have in that language: not approved yet, rejected, or never created. */
const NO_SUCH_TEMPLATE = 132001;

const mark = (app: App, id: number | string, data: Record<string, unknown>) => app.db.query("UPDATE events SET data = data || $2::jsonb WHERE id = $1 AND kind = 'pay_reminder_wa'", [id, J(data)]);

/** Why this phone does not get a reminder now (loud: because Meta refused one), or null when it may. */
async function heldBack(app: App, phone: string): Promise<{ why: string; loud: boolean } | null> {
  const r = await app.db.one<{ week: number; refused: Date | string | null }>(
    `SELECT COUNT(*) FILTER (WHERE data->>'phone' = $1 AND data->>'state' = 'sent')::int AS week,
            MAX(at) FILTER (WHERE data->>'state' = 'failed' AND at > now() - ($2 || ' minutes')::interval) AS refused
       FROM events WHERE store_id IS NULL AND kind = 'pay_reminder_wa' AND at > now() - ($3 || ' days')::interval`,
    [phone, String(REMIND_HOLD_MINUTES), String(REMIND_WEEK_DAYS)],
  );
  if (r?.refused) return { why: `Meta refused one at ${new Date(r.refused).toISOString().slice(11, 16)} UTC, and none is tried for ${REMIND_HOLD_MINUTES} minutes after that`, loud: true };
  if ((r?.week || 0) >= REMIND_WEEK_MAX) return { why: `${REMIND_WEEK_MAX} payment reminders went to this number in the last ${REMIND_WEEK_DAYS} days`, loud: false };
  return null;
}

/** One reminder: the template to the phone, unless it went before or the limits hold it. Never throws. */
export async function sendReminder(app: App, r: Reminder): Promise<Outcome> {
  const key = `${r.workspace}:${r.kind}:${r.paidUntil}`;
  const who = `WhatsApp to …${r.phone.slice(-4)} (workspace ${r.workspace}, ${r.kind})`;
  // Sent before, or on its way this very moment.
  const same = `kind = 'pay_reminder_wa' AND data->>'key' = $1 AND data->>'phone' = $2 AND (data->>'state' = 'sent' OR (data->>'state' = 'sending' AND at > now() - interval '${SENDING_MINUTES} minutes'))`;
  let claim: { id: number | string } | null;
  try {
    const stop = await app.db.one<{ stopped_at: Date | string }>('SELECT stopped_at FROM pay_remind_stops WHERE phone = $1', [r.phone]);
    if (stop) {
      app.log(`[remind] ${who}: not sent (the number wrote "הפסק" on ${new Date(stop.stopped_at).toISOString().slice(0, 10)}); accounts' email is not affected`);
      return { sent: false, why: 'stopped' };
    }
    if (await app.db.one(`SELECT 1 FROM events WHERE ${same}`, [key, r.phone])) {
      app.log(`[remind] ${who}: not sent (it went before); nothing to do`);
      return { sent: false, why: 'already' };
    }
    const held = await heldBack(app, r.phone);
    if (held) {
      app.log(held.loud ? `[remind] !!! ${who} NOT SENT: ${held.why}; accounts' email is not affected` : `[remind] ${who}: not sent (${held.why}); accounts' email is not affected`);
      return { sent: false, why: 'held' };
    }
    // Asked and recorded in one statement, so the same reminder twice at once goes once.
    claim = await app.db.one<{ id: number }>(
      `INSERT INTO events (store_id, kind, data) SELECT NULL, 'pay_reminder_wa', $3::jsonb WHERE NOT EXISTS (SELECT 1 FROM events WHERE ${same}) RETURNING id`,
      [key, r.phone, J({ key, workspace: r.workspace, kind: r.kind, phone: r.phone, state: 'sending' })],
    );
  } catch (e: any) {
    app.log(`[remind] !!! ${who} NOT SENT: the reminders sent before could not be read (${masked(cleanLine(e?.message || e, 200))}), so a second one could not be ruled out`);
    return { sent: false, why: 'failed' };
  }
  if (!claim) {
    app.log(`[remind] ${who}: not sent (it went before); nothing to do`);
    return { sent: false, why: 'already' };
  }
  let id = '';
  try {
    const sent = await metaLinesAdapter(app).push(r.phone, { template: { name: PAYMENT_REMINDER.name, sid: PAYMENT_REMINDER.name, vars: reminderParams(r), payload: r.code }, from: lineNumber(app.env, 'owner') });
    id = sent.id;
    await usage(app.db, { kind: 'bsp', backend: 'meta_line', units: 1, usd: sent.usd, apiUsd: sent.usd, tag: 'wa_pay_reminder' }).catch(() => {});
  } catch (e: any) {
    const code = typeof e?.code === 'number' ? e.code : null;
    const why = masked(cleanLine(e?.message || e, 300));
    await mark(app, claim.id, { state: 'failed', code, error: why }).catch(() => {});
    const hint = code === NO_SUCH_TEMPLATE ? ` (${PAYMENT_REMINDER.name} is not approved in WhatsApp Manager: in review, rejected, or never created there; docs/whatsapp-templates.md)` : '';
    app.log(`[remind] !!! ${who} FAILED: ${why}${hint}. No payment reminder is tried for ${REMIND_HOLD_MINUTES} minutes; accounts' email is not affected`);
    await alertOperator(app, 'pay_remind_failed', 'תזכורת לתשלום לא נשלחה בוואטסאפ', `Meta לא קיבלה את התבנית ${PAYMENT_REMINDER.name}: ${why}. המייל ללקוח יוצא מ-accounts בכל מקרה. בשעה הקרובה לא נשלחות תזכורות בוואטסאפ. אם התבנית עוד לא נוצרה ב-WhatsApp Manager, או ש-Meta עוד לא אישרה אותה, ההוראות ב-docs/whatsapp-templates.md.`, { everyMinutes: 24 * 60 }).catch(() => {});
    return { sent: false, why: 'failed' };
  }
  await mark(app, claim.id, { state: 'sent', id: id || null }).catch((e) => app.log(`[remind] ${who}: sent, but not recorded: ${masked(cleanLine(e?.message || e, 200))}`));
  app.log(`[remind] ${who}: sent`);
  return { sent: true, why: null };
}

/**
 * Meta's later word that a message from our number failed (waStore.ts deliveryStatus, the webhook's failed status): when
 * it was a payment reminder, it is said loudly and kept as undelivered. It holds nothing else: it is about that number
 * alone (not on WhatsApp, say). True when it was a reminder.
 */
export async function reminderNotDelivered(app: App, s: { id: string; error: string | null }): Promise<boolean> {
  if (!s.id) return false;
  const r = await app.db.one<{ id: number; data: any }>("SELECT id, data FROM events WHERE store_id IS NULL AND kind = 'pay_reminder_wa' AND data->>'id' = $1 LIMIT 1", [s.id]);
  if (!r) return false;
  const error = masked(cleanLine(s.error || 'no reason given', 200));
  await mark(app, r.id, { state: 'undelivered', error });
  app.log(`[remind] !!! WhatsApp to …${String(r.data?.phone || '').slice(-4)} (workspace ${r.data?.workspace}, ${r.data?.kind}) FAILED: Meta took the payment reminder and then could not deliver it (${error}); accounts' email is not affected`);
  return true;
}

/** A whole message that stops the reminders, or starts them again: the owner line's words (owners/line.ts STOP, START). */
export const STOP_WORD = /^\s*(?:הפסק|תפסיק|תפסיקו|stop|unsubscribe)\s*[.!]*\s*$/i;
export const START_WORD = /^\s*(?:התחל|תתחיל|תתחילו|start)\s*[.!]*\s*$/i;

/** What Toran says back, in the reminders' own voice. */
export const STOP_SAID = {
  stopped: 'רשמנו. מעכשיו לא נשלח לכם כאן תזכורות לתשלום, והן ימשיכו להגיע במייל. כדי לקבל אותן כאן שוב, כותבים "התחל".',
  started: 'רשמנו. נזכיר לכם כאן שוב לשלם על החודש הבא, כמו במייל.',
};

/**
 * "הפסק" from a number that got a payment reminder: no more of them to it (pay_remind_stops), accounts told, one line
 * back; "התחל" from a number that stopped them: they start again. Null for anything else, which goes on as before: a
 * "הפסק" from a number that never got a reminder is the owner line's, or a store's, as it always was.
 */
export async function reminderWord(app: App, adapter: ChannelAdapter, inbound: Inbound): Promise<RouteResult | null> {
  const text = String(inbound.text || '');
  const stop = STOP_WORD.test(text);
  if (!stop && !START_WORD.test(text)) return null;
  const phone = inbound.from;
  const stopped = await app.db.one('SELECT 1 FROM pay_remind_stops WHERE phone = $1', [phone]);
  if (stop) {
    const got = stopped || (await app.db.one("SELECT 1 FROM events WHERE store_id IS NULL AND kind = 'pay_reminder_wa' AND data->>'phone' = $1 AND data->>'state' IN ('sent', 'undelivered') LIMIT 1", [phone]));
    if (!got) return null;
    await app.db.query('INSERT INTO pay_remind_stops (phone) VALUES ($1) ON CONFLICT (phone) DO UPDATE SET stopped_at = now()', [phone]);
    // As the owner line keeps an owner's "הפסק" (owners/line.ts), for a number that is one.
    await app.db.query('UPDATE owner_numbers SET opted_out_at = now() WHERE phone = $1', [phone]);
  } else {
    if (!stopped) return null;
    await app.db.query('DELETE FROM pay_remind_stops WHERE phone = $1', [phone]);
  }
  // Accounts keeps the word for a number linked there; for any other it answers not_linked, and the row here is all.
  const told = await setConsent(app, phone, !stop);
  if (!told.ok && told.reason !== 'not_linked' && told.reason !== 'disabled') app.log(`[remind] WhatsApp …${phone.slice(-4)} wrote "${stop ? 'הפסק' : 'התחל'}": kept here, and accounts could not be told (${told.reason})`);
  await event(app.db, null, stop ? 'pay_reminder_stop' : 'pay_reminder_start', { last4: phone.slice(-4) });
  await audit(app.db, { actor: `wa:${phone}`, action: stop ? 'pay_reminder_stop' : 'pay_reminder_start', detail: { accounts: told.ok ? 'told' : told.reason } });
  const line = stop ? STOP_SAID.stopped : STOP_SAID.started;
  await reply(app, adapter, inbound, line, null, null);
  return { action: stop ? 'pay_remind_stop' : 'pay_remind_start', reply: line };
}

export function remindRoutes(app: App): Route<Req>[] {
  return [
    ['POST', PATH, async (r): Promise<Out> => {
      const no = internalRefusal(app, r);
      if (no) return no;
      const reminder = readReminder(r.raw);
      if (!reminder) return { status: 400, json: { error: 'bad_reminder' } };
      return { json: { ok: true, ...(await sendReminder(app, reminder)) }, headers: { 'cache-control': 'no-store' } };
    }],
    // Another method: refused as the contract says, after the same checks (a GET from outside learns nothing more).
    ['GET', PATH, async (r): Promise<Out> => internalRefusal(app, r) || { status: 405, json: { error: 'method_not_allowed' } }],
  ];
}

/** The payment_reminder section of docs/whatsapp-templates.md (scripts/templates-doc.ts). */
export function reminderTemplateDoc(): string {
  const t = PAYMENT_REMINDER;
  return [
    `### ${t.name}`,
    '',
    '| | |',
    '|---|---|',
    `| Name | ${t.name} |`,
    '| Category | Utility |',
    `| Language | Hebrew (${t.language}) |`,
    '| Header, footer | none |',
    `| Buttons | one quick reply: ${t.button} |`,
    `| Variables (sample) | ${t.example.map((e, i) => `{{${i + 1}}} = ${e}`).join('; ')} |`,
    '',
    'The body, two paragraphs with an empty line between them, exactly:',
    '',
    '```',
    t.body,
    '```',
    '',
    `As the customer reads it: ${reminderFilled(t.example).split('\n').filter(Boolean).join(' / ')} [${t.button}]`,
    '',
  ].join('\n');
}
