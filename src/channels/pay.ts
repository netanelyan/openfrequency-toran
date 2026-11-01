import type { App } from '../app.ts';
import { cleanLine } from '../core/hebrew.ts';
import { audit, event } from '../db/log.ts';
import { alertOperator } from '../ops/alert.ts';
import { call } from '../owners/identity.ts';
import type { RouteResult } from './demo.ts';
import { cleanName, sniff } from './files.ts';
import { lineFile } from './lines.ts';
import { type Check, checkReceipt, type Expected } from './payCheck.ts';
import { reply } from './send.ts';
import type { Attachment, ChannelAdapter, Inbound } from './types.ts';

// Paying over WhatsApp. Payment is a bank transfer, recorded by the operator in accounts' /admin; this makes asking for
// it and sending its proof one conversation on our number. Accounts gives each customer a button that opens WhatsApp
// to our number with "היי, אני רוצה לשלם על המנוי של <business>. PAY-XXXXXX" filled in, and the two halves are:
//
//   the code     a message with a PAY code: Toran asks accounts what is due on it (GET /internal/pay) and answers
//                with the amount, accounts' lines of what it is for, and the transfer's details. The phone then
//                waits for its receipt for PAY_WAIT_DAYS (pay_waits; a new code from the same phone takes it over)
//   the receipt  a photo or a document from a phone that waits: Toran fetches it from Meta (lines.ts lineFile),
//                checks it is an image or a PDF of at most RECEIPT_MAX by its bytes, has a model read a screenshot
//                and code compare it with what is due (payCheck.ts), and hands it to accounts with the code, the
//                phone and that check (POST /internal/pay/receipt), where the operator sees it beside the payment to
//                record. The check is advice: a screenshot the model says is no transfer still goes, marked so, and
//                the customer is asked for the bank's own; an amount that differs is said to the customer; nothing
//                else follows from it. Toran never records money, and keeps no amount, no bank details and no file
//
// Both are read on our number before anything else but a demo request (demo.ts), so a verified owner who pays gets
// this, not their assistant; on a separate owner line too (route.ts). A text from a phone that waits goes where it
// went before (support, a demo, the owner's assistant), and so does a file from a phone that does not wait. Every
// answer here replies to the message being handled, inside its 24 hours (send.ts), and is kept nowhere: like the
// demo requests (request.ts), it is not a conversation. Accounts is asked as everywhere else (owners/identity.ts
// call): its internal API on 127.0.0.1, the bearer token, nothing believed but an answer in the contract's shape.
//
// The events (pay_code, pay_receipt) and the audit say what happened, with the code, the workspace and the check's
// verdicts; never the transfer's details, never what the model read but the amount, and never a file's bytes.

export const PAY_RE = /\bPAY-([A-Z0-9]{6})\b/i;
export const PAY_WAIT_DAYS = 7;
/** Accounts takes a receipt of at most 5MB, decoded. */
export const RECEIPT_MAX = 5 * 1024 * 1024;
/** The kinds accounts takes, by the bytes (files.ts sniff), with the extension a photo's name gets. */
const RECEIPT_TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };
/** An upload of up to 5MB, base64 in JSON, to a service on the same machine. */
const RECEIPT_TIMEOUT_MS = 20_000;

const HELLO = 'כאן תורן, הבוט של OpenFrequency.';

const msg = {
  due: (business: string, total: string, summary: string, payHow: string) =>
    `${HELLO}\n\nלתשלום על המנוי של ${business}: ${total} ₪, כולל מע״מ.${summary ? `\n${summary}` : ''}\n\nפרטי ההעברה:\n${payHow}\n\nאחרי ההעברה שולחים לי כאן צילום מסך של האישור. נציג יבדוק שההעברה הגיעה, ותקבלו מייל כשהתשלום נרשם.`,
  nothingDue: (business: string, paidThrough: string | null) => `${HELLO}\n\n${paidThrough ? `המנוי של ${business} משולם עד ${dayHe(paidThrough)}, אז כרגע אין מה לשלם.` : `על המנוי של ${business} אין כרגע מה לשלם.`}`,
  noDetails: (business: string, total: string) => `${HELLO}\n\nלתשלום על המנוי של ${business}: ${total} ₪, כולל מע״מ. את פרטי ההעברה ישלח לכם כאן נציג.`,
  gone: 'הקישור הזה לתשלום כבר לא בתוקף. אפשר ללחוץ שוב על "לתשלום בוואטסאפ" בחשבון שלכם ב־accounts.openfrequency.co.il.',
  down: 'לא הצלחתי לבדוק את הסכום כרגע. אפשר לשלוח את ההודעה שוב בעוד כמה דקות.',
  received: 'קיבלתי את האישור, תודה. נציג יבדוק שההעברה הגיעה, ותקבלו מייל כשהתשלום נרשם.',
  unreadable: 'לא הצלחתי לפתוח את הקובץ. אפשר לשלוח אותו שוב כתמונה?',
  tooMany: 'קיבלתי כבר כמה אישורים היום. נציג יבדוק אותם ויחזור אליכם כאן אם חסר משהו.',
  receiptDown: 'לא הצלחתי להעביר את האישור כרגע. אפשר לשלוח אותו שוב בעוד כמה דקות.',
  // The check's two lines (payCheck.ts): only the amounts, never the payee's name or the reference the model read.
  mismatch: (seen: string, expected: string) => `בצילום רואים העברה של ${seen} ₪, והסכום לתשלום הוא ${expected} ₪. העברתי את זה לנציג, והוא יחזור אליכם כאן.`,
  notTransfer: 'זה לא נראה כמו אישור של העברה בנקאית. אפשר לשלוח צילום מסך של האישור מהבנק?',
};

/** Shekels as accounts writes them (its copy.js ils): 990, or 1,746.40 when there are agorot. */
export const shekels = (n: number) => Number(n).toLocaleString('he-IL', Number.isInteger(Number(n)) ? {} : { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const TOTAL_WORDS = /סך\s+הכו?ל/;

/**
 * Accounts' summary without its "סך הכול" line, since our own first line says the total: the customer reads the amount
 * once. Only that line goes: an item's line stays even when its amount happens to equal the total (one product, VAT
 * included), so the customer always sees what the money is for.
 */
export function withoutTotal(summary: string, _total?: string): string {
  return summary.split('\n').filter((l) => l.trim() && !TOTAL_WORDS.test(l)).join('\n');
}

/** 'YYYY-MM-DD' as Israelis write a date: 31.12.2026. */
const dayHe = (d: string) => d.split('-').reverse().join('.');

/** What accounts says is due on a code, as Toran uses it. */
export type Due = { code: string; workspace: { id: number; name: string }; items: number; total: number; summary: string; payHow: string | null; paidThrough: string | null };
type Read = { ok: true; due: Due } | { ok: false; reason: 'unknown' | 'expired' | 'unavailable' };

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A 200 is believed only in the contract's shape, and only about the code that was asked. */
function wellFormed(b: any, code: string): boolean {
  if (!b || typeof b !== 'object' || typeof b.code !== 'string' || b.code.toUpperCase() !== code) return false;
  if (!b.workspace || !Number.isInteger(b.workspace.id) || typeof b.workspace.name !== 'string') return false;
  if (!Array.isArray(b.items) || typeof b.total !== 'number' || !Number.isFinite(b.total) || b.total < 0) return false;
  if (b.payHow != null && typeof b.payHow !== 'string') return false;
  if (b.paidThrough != null && !(typeof b.paidThrough === 'string' && DAY.test(b.paidThrough))) return false;
  if (b.summary != null && typeof b.summary !== 'string' && !(Array.isArray(b.summary) && b.summary.every((s: unknown) => typeof s === 'string'))) return false;
  return true;
}

function readDue(app: App, code: string, r: { status: number; body: any }): Read {
  if (r.status === 200) {
    if (!wellFormed(r.body, code)) {
      app.log('[pay] a 200 from accounts that is not a payment (GET /internal/pay): refused');
      return { ok: false, reason: 'unavailable' };
    }
    const b = r.body;
    const summary = (Array.isArray(b.summary) ? b.summary.join('\n') : String(b.summary || '')).trim();
    return { ok: true, due: { code, workspace: { id: b.workspace.id, name: b.workspace.name }, items: b.items.length, total: b.total, summary, payHow: String(b.payHow || '').trim() || null, paidThrough: b.paidThrough || null } };
  }
  const error = String(r.body?.error || '');
  if (error === 'unknown_code') return { ok: false, reason: 'unknown' };
  if (error === 'expired') return { ok: false, reason: 'expired' };
  // Anything else (accounts down, its token refused, a route it does not have yet) is no answer.
  if (error !== 'not_configured') app.log(`[pay] accounts said ${r.status} ${error} about a PAY code`);
  return { ok: false, reason: 'unavailable' };
}

/** One answer to the message being handled, kept nowhere (no conversation: request.ts does the same). */
const speaker = (app: App, adapter: ChannelAdapter, inbound: Inbound) => async (text: string, action: RouteResult['action']): Promise<RouteResult> => {
  await reply(app, adapter, inbound, text, null, null);
  return { action, reply: text };
};

/** A message with a PAY code: what is due on it, and how to pay it. Null when the message holds no PAY code. */
export async function payCode(app: App, adapter: ChannelAdapter, inbound: Inbound): Promise<RouteResult | null> {
  const m = PAY_RE.exec(String(inbound.text || ''));
  if (!m) return null;
  const code = `PAY-${m[1].toUpperCase()}`;
  const say = speaker(app, adapter, inbound);
  const read = readDue(app, code, await call(app, 'GET', `/internal/pay?code=${encodeURIComponent(code)}`));
  if (!read.ok) {
    await event(app.db, null, 'pay_code', { code, outcome: read.reason });
    return read.reason === 'unavailable' ? say(msg.down, 'pay_unavailable') : say(msg.gone, 'pay_bad_code');
  }
  const { due } = read;
  const business = cleanLine(due.workspace.name, 80);
  const workspace = due.workspace.id;
  // Nothing owed: no items (accounts counts a month falling due within 7 days as owed, so this is the paid-ahead or
  // complimentary workspace), or a total of nothing.
  if (!due.items || !(due.total > 0)) {
    await event(app.db, null, 'pay_code', { code, outcome: 'nothing_due', workspace });
    return say(msg.nothingDue(business, due.paidThrough), 'pay_nothing_due');
  }
  // From now the phone's next photo or document is this payment's receipt.
  await app.db.query(
    `INSERT INTO pay_waits (phone, code, workspace_id, workspace_name, created_at, expires_at) VALUES ($1, $2, $3, $4, now(), now() + ($5 || ' days')::interval)
     ON CONFLICT (phone) DO UPDATE SET code = EXCLUDED.code, workspace_id = EXCLUDED.workspace_id, workspace_name = EXCLUDED.workspace_name, created_at = now(), expires_at = EXCLUDED.expires_at`,
    [inbound.from, code, workspace, business, String(PAY_WAIT_DAYS)],
  );
  const total = shekels(due.total);
  if (!due.payHow) {
    // Accounts has no transfer details to give: the amount goes out, and the operator sends the details by hand.
    await event(app.db, null, 'pay_code', { code, outcome: 'no_details', workspace });
    await alertOperator(app, `pay_details:${workspace}`, `${business} רוצה לשלם, ואין ב-accounts פרטי העברה`, `ההודעה הגיעה מ-${inbound.from}, על ${total} ₪ (workspace ${workspace}). תורן ענה שנציג ישלח את פרטי ההעברה. אפשר לענות בוואטסאפ עד 24 שעות מההודעה, ולהוסיף את הפרטים ב-accounts כדי שבפעם הבאה הם יישלחו מיד.`);
    return say(msg.noDetails(business, total), 'pay_no_details');
  }
  await event(app.db, null, 'pay_code', { code, outcome: 'ok', workspace });
  return say(msg.due(business, total, withoutTotal(due.summary, total), due.payHow), 'pay');
}

type Wait = { code: string; workspace_id: number; workspace_name: string; created_at: string | Date };
type Fetched = { ok: true; size: number; file: { name: string; type: string; data: string } } | { ok: false; why: 'too_big' | 'type' | 'failed' };

/** A photo comes with no name of its own (parseWebhook calls it "image"); a document keeps its name, with its kind's extension. */
function receiptName(name: string, type: string): string {
  const ext = RECEIPT_TYPES[type];
  if (!name || name === 'image' || name === 'document') return `receipt.${ext}`;
  const clean = cleanName(name);
  return /\.[a-z0-9]{2,5}$/i.test(clean) ? clean : `${clean}.${ext}`;
}

/** The receipt's bytes from Meta, and whether they are a kind accounts takes. */
async function fetchReceipt(app: App, inbound: Inbound, a: Attachment): Promise<Fetched> {
  let bytes: Buffer;
  try {
    bytes = await lineFile(app, String(inbound.account), String(a.ref), RECEIPT_MAX);
  } catch (e: any) {
    const big = /too big/.test(String(e?.message));
    if (!big) app.log(`[pay] a receipt from …${inbound.from.slice(-4)} could not be fetched from Meta: ${cleanLine(String(e?.message || e), 200)}`);
    return { ok: false, why: big ? 'too_big' : 'failed' };
  }
  const type = sniff(bytes);
  if (!type || !RECEIPT_TYPES[type]) return { ok: false, why: 'type' };
  return { ok: true, size: bytes.length, file: { name: receiptName(a.name, type), type, data: bytes.toString('base64') } };
}

type Sent = 'sent' | 'gone' | 'refused' | 'too_many' | 'unavailable';

/**
 * What accounts said to a receipt (its docs/contracts/pay.json). A 201 with its id is the contract's; a 200 with one
 * was stored too. A file accounts will not take (413 too_large, 415 bad_type, 400 bad: the body or the file not in its
 * shape) is not posted again; 429 rate_limited is a sixth receipt from one code in an Israel day.
 */
function sentOutcome(r: { status: number; body: any }): Sent {
  const error = String(r.body?.error || '');
  if ((r.status === 201 || r.status === 200) && r.body?.id != null) return 'sent';
  if (error === 'unknown_code' || error === 'expired') return 'gone';
  if (r.status === 413 || r.status === 415 || ['too_large', 'bad_type', 'bad'].includes(error)) return 'refused';
  if (r.status === 429) return 'too_many';
  return 'unavailable';
}

/** What is due on the wait's code now (GET /internal/pay again), for the check; nulls when accounts does not say. */
async function expectedOf(app: App, wait: Wait): Promise<Expected> {
  const read = readDue(app, wait.code, await call(app, 'GET', `/internal/pay?code=${encodeURIComponent(wait.code)}`));
  return { total: read.ok ? read.due.total : null, payHow: read.ok ? read.due.payHow : null, since: wait.created_at };
}

/** The check in the events and the audit: its verdicts and the amounts, never the payee's name or the reference. */
const verdicts = (c: Check) =>
  c.readable ? { readable: true, isTransfer: c.isTransfer, amount: c.amount.verdict, seen: c.amount.seen, expected: c.amount.expected, date: c.date.verdict, account: c.account.verdict } : { readable: false, why: c.why };

/**
 * The answer to a receipt accounts took: a request for the bank's own confirmation when the model saw no transfer, the
 * amount the screenshot shows when it is not the amount due, else the usual line.
 */
const tookLine = (c: { isTransfer?: unknown; amount?: unknown; seen?: unknown; expected?: unknown } | null | undefined) => {
  if (c?.isTransfer === false) return msg.notTransfer;
  return c?.amount === 'mismatch' && typeof c.seen === 'number' && typeof c.expected === 'number' ? msg.mismatch(shekels(c.seen), shekels(c.expected)) : msg.received;
};

/**
 * A photo or a document (an attachment with Meta's media id, meta.ts) on our number on Meta, from a phone that waits
 * for its receipt: checked (payCheck.ts) and handed to accounts. Null for anything else, which goes on as before.
 */
export async function payReceipt(app: App, adapter: ChannelAdapter, inbound: Inbound): Promise<RouteResult | null> {
  const file = (inbound.attachments || []).find((a) => a.ref);
  if (!file || adapter.kind !== 'meta_line' || !inbound.account) return null;
  const wait = await app.db.one<Wait>('SELECT code, workspace_id, workspace_name, created_at FROM pay_waits WHERE phone = $1 AND expires_at > now()', [inbound.from]);
  if (!wait) return null;
  const say = speaker(app, adapter, inbound);
  const workspace = wait.workspace_id;
  // The same message again (its job run again after the answer failed to go out): accounts has it already, and the
  // answer is the one it had, with no second look at the image.
  const done = await app.db.one<{ data: any }>("SELECT data FROM events WHERE kind = 'pay_receipt' AND data->>'msg' = $1 AND data->>'outcome' = 'sent' ORDER BY id DESC LIMIT 1", [inbound.id]);
  if (done) return say(tookLine(done.data?.check), 'pay_receipt');

  const got = await fetchReceipt(app, inbound, file);
  if (!got.ok) {
    await event(app.db, null, 'pay_receipt', { outcome: 'unreadable', why: got.why, code: wait.code, workspace });
    return say(msg.unreadable, 'pay_receipt_refused');
  }
  // Not a transfer, by the model's word, still goes to accounts (isTransfer false), so a mistake of the model's never
  // leaves a customer unseen; the customer is asked for the bank's own confirmation.
  const check = await checkReceipt(app, got.file, () => expectedOf(app, wait), inbound.from);
  const seen = verdicts(check);
  const r = await call(app, 'POST', '/internal/pay/receipt', { code: wait.code, phone: inbound.from, file: got.file, check }, RECEIPT_TIMEOUT_MS);
  const outcome = sentOutcome(r);
  const error = String(r.body?.error || '');
  const detail = { outcome, code: wait.code, workspace, type: got.file.type, bytes: got.size, check: seen, ...(outcome === 'sent' ? { id: r.body.id } : { status: r.status, error: error || null }) };
  await event(app.db, null, 'pay_receipt', { ...detail, msg: inbound.id });
  await audit(app.db, { actor: `wa:${inbound.from}`, action: 'pay_receipt', detail });
  switch (outcome) {
    case 'sent':
      if (check.readable && check.amount.verdict === 'mismatch') {
        // The customer is told a person will come back to them: the operator hears of it now.
        const business = cleanLine(wait.workspace_name, 80);
        await alertOperator(app, `pay_mismatch:${workspace}`, `העברה בסכום אחר על המנוי של ${business}`, `בצילום ששלחו מ-${inbound.from} רואים העברה של ${shekels(check.amount.seen!)} ₪, והסכום לתשלום הוא ${shekels(check.amount.expected!)} ₪ (workspace ${workspace}). האישור נמצא ב-accounts. תורן ענה שנציג יחזור אליהם בוואטסאפ, אז כדאי לענות עד 24 שעות מההודעה.`);
      }
      return say(tookLine(seen), 'pay_receipt');
    case 'gone':
      // The code ended since it was read: this phone waits for nothing now.
      await app.db.query('DELETE FROM pay_waits WHERE phone = $1', [inbound.from]);
      return say(msg.gone, 'pay_receipt_refused');
    case 'refused':
      return say(msg.unreadable, 'pay_receipt_refused');
    case 'too_many':
      return say(msg.tooMany, 'pay_receipt_refused');
    default:
      if (error !== 'not_configured') app.log(`[pay] accounts said ${r.status} ${error} to a receipt`);
      await alertOperator(app, 'pay_receipt_down', 'אישור העברה לא עבר ל-accounts', `אישור העברה מ-${inbound.from}, על המנוי של ${cleanLine(wait.workspace_name, 80)} (workspace ${workspace}), לא עבר: accounts ענה ${r.status}${error ? ` ${error}` : ''}. תורן ביקש לשלוח אותו שוב בעוד כמה דקות.`);
      return say(msg.receiptDown, 'pay_receipt_refused');
  }
}

/** On a line with no demo router (a separate owner line, route.ts): a PAY code or a receipt, read the same way. */
export async function payMessage(app: App, adapter: ChannelAdapter, inbound: Inbound): Promise<RouteResult | null> {
  return (await payCode(app, adapter, inbound)) || (await payReceipt(app, adapter, inbound));
}
