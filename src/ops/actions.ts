import type { App } from '../app.ts';
import { DAY, HOUR, notOnShabbat, now } from '../core/clock.ts';
import { audit, event } from '../db/log.ts';
import { displayName } from '../ingest/brand.ts';
import { followupDue, pitchUrl } from '../outreach.ts';
import { reply } from '../channels/send.ts';
import { demoLine } from '../channels/lines.ts';
import { J } from '../db/index.ts';
import { reconnectSql } from './queue.ts';
import { LOST_REASONS, requestedLink, tederRequestedLink } from './messages.ts';
import { syncTeder } from './sources.ts';

// What the operator's buttons record, for a Toran store (stores) or a Teder demo (teder_leads), every one in the audit
// log with the operator as its actor:
//
//   sent       the first message went out: the one reminder comes due four days later, never on Shabbat. On a store
//              whose WhatsApp has to be connected again: they were told (markReconnectTold)
//   reminded   the reminder (or, for a store that tried the demo, the question in its place) went out: the last one
//   direct     the link to a demo someone asked for, sent now on the demo number where they asked (inside its 24
//              hours; a Teder demo inside its 23), then recorded as sent. A Toran page by this button (sendDirect) or by
//              itself (deliverRequested); a Teder demo asked for with a code the same way (sendTederDirect,
//              deliverTeder, with "auto" as its actor), never one asked for with a typed number, who never wrote to
//              us and so has no window to answer in. Only while our number is connected
//              (channels/lines.ts demoLine): until then the button is refused, nothing is sent or marked, and the
//              links that go out by themselves wait
//   replied    they answered: they leave the list for "in conversation"
//   next       the next step in a conversation, and when
//   later      off the list for a day or a week
//   lost       they said no, with a reason
//   won        a Toran pilot or a paying customer; a Teder customer

export type Kind = 'toran' | 'teder';
export class OpsError extends Error {}

/** The "send now" button while the demo number goes nowhere (demoLine: the simulator on the VPS). */
export const NOT_LIVE = 'המספר שלנו עוד לא מחובר, אז ההודעה לא נשלחה ולא סומנה. אפשר להעתיק אותה ולשלוח מהוואטסאפ שלך.';

const ISO = (t: number) => new Date(t).toISOString();

async function row(app: App, kind: Kind, id: string) {
  const r = kind === 'toran'
    ? await app.db.one<any>('SELECT * FROM stores WHERE id = $1', [Number(id) || 0])
    : await app.db.one<any>('SELECT * FROM teder_leads WHERE id = $1', [id]);
  if (!r) throw new OpsError('לא מצאתי את הליד');
  return r;
}

async function set(app: App, kind: Kind, id: string, sql: string, params: unknown[] = []) {
  const table = kind === 'toran' ? 'stores' : 'teder_leads';
  const key = kind === 'toran' ? Number(id) : id;
  await app.db.query(`UPDATE ${table} SET ${sql}${kind === 'toran' ? ', updated_at = now()' : ''} WHERE id = $1`, [key, ...params]);
}

async function log(app: App, kind: Kind, id: string, action: string, by: string, detail: Record<string, unknown> = {}) {
  const storeId = kind === 'toran' ? Number(id) : null;
  await audit(app.db, { actor: by, action: `ops_${action}`, storeId, detail: { kind, id, ...detail } });
  if (storeId) await event(app.db, storeId, action === 'sent' ? 'sent' : `ops_${action}`, { by, ...detail });
}

export async function markSent(app: App, kind: Kind, id: string, by: string) {
  const r = await row(app, kind, id);
  if (r.sent_at) throw new OpsError('כבר סומן שנשלח');
  const t = now();
  if (kind === 'toran') {
    if (!r.approved_at) throw new OpsError('צריך לאשר את הדף לפני ששולחים');
    await set(app, kind, id, "sent_at = $2, followup_due_at = $3, status = CASE WHEN status IN ('new', 'page_ready') THEN 'sent' ELSE status END", [ISO(t), ISO(followupDue(t))]);
  } else {
    await set(app, kind, id, 'sent_at = $2, reminder_due_at = $3', [ISO(t), ISO(followupDue(t))]);
  }
  await log(app, kind, id, 'sent', by);
}

/**
 * "שלחתי" on a store whose WhatsApp has to be connected again (queue.ts, reason reconnect): they were told. The card
 * comes back after RECONNECT_AGAIN_DAYS while the number still waits. False when the store has no such number.
 */
export async function markReconnectTold(app: App, id: string, by: string): Promise<boolean> {
  const r = await app.db.query(`UPDATE channel_accounts SET meta = meta || $2::jsonb WHERE store_id = $1 AND ${reconnectSql()} RETURNING id`, [Number(id) || 0, J({ reconnect_told_at: ISO(now()), reconnect_told_by: by })]);
  if (!r.length) return false;
  await log(app, 'toran', id, 'reconnect_told', by);
  return true;
}

export async function markReminded(app: App, kind: Kind, id: string, by: string) {
  const r = await row(app, kind, id);
  if (kind === 'toran') {
    if (r.followup_sent_at) throw new OpsError('כבר נשלחה להם הודעה שנייה. מכאן לא כותבים להם יותר, אלא אם יכתבו.');
    await set(app, kind, id, 'followup_sent_at = now(), sent_at = COALESCE(sent_at, now())');
  } else {
    if (!r.sent_at) throw new OpsError('עוד לא נשלחה הודעה ראשונה');
    if (r.reminded_at) throw new OpsError('כבר נשלחה תזכורת אחת. מכאן לא כותבים להם יותר.');
    await set(app, kind, id, 'reminded_at = now()');
  }
  await log(app, kind, id, 'reminded', by);
}

/**
 * A Toran demo someone asked for on the website: the link, on the demo number where they asked, as request.ts promised
 * them. Only inside the 24 hours after their message (send.ts checks it again); after that the operator sends it by hand.
 */
export async function sendDirect(app: App, id: string, by: string): Promise<void> {
  const s = await row(app, 'toran', id);
  if (s.sent_at) throw new OpsError('כבר סומן שנשלח');
  if (!s.approved_at || !s.page_built_at) throw new OpsError('הדף עוד לא מוכן');
  const req = await app.db.one<{ code: string; phone: string; claimed_at: string }>("SELECT code, phone, claimed_at FROM demo_requests WHERE domain = $1 AND product = 'toran' AND claimed_at IS NOT NULL ORDER BY claimed_at DESC LIMIT 1", [s.domain]);
  if (!req) throw new OpsError('לא ביקשו את הדמו הזה באתר');
  if (now() - new Date(req.claimed_at).getTime() >= 24 * HOUR) throw new OpsError('עברו 24 שעות מההודעה שלהם, אז מהמספר של הדמו אי אפשר לשלוח. אפשר לשלוח מהוואטסאפ שלך.');
  const line = await demoLine(app);
  if (!line.live) throw new OpsError(NOT_LIVE);
  const name = displayName(s.brand_override?.name, s.brand?.name, s.name) || s.domain;
  const d = await reply(app, line.wa, { from: req.phone, text: '', id: `req-${req.code}`, at: new Date(req.claimed_at).getTime(), channel: 'whatsapp' }, requestedLink({ storeName: name, url: pitchUrl(app.env, s.slug) }), s.id, null);
  if (!d.ok) throw new OpsError('ההודעה לא יצאה: עברו 24 שעות מההודעה שלהם. אפשר לשלוח מהוואטסאפ שלך.');
  await markSent(app, 'toran', id, by);
  await log(app, 'toran', id, 'direct', by, { code: req.code });
}

/** A Teder demo's link goes on the demo number only this long after the number wrote (queue.ts DIRECT_HOURS). */
export const TEDER_DIRECT_HOURS = 23;

/** A Teder demo's request by a code, still to get its link: the newest, with when its number wrote (its window). */
const tederRequest = (app: App, tederId: string) =>
  app.db.one<{ id: number; code: string; phone: string; claimed_at: string }>(
    "SELECT id, code, phone, claimed_at FROM demo_requests WHERE product = 'teder' AND teder_id = $1 AND claimed_at IS NOT NULL AND delivered_at IS NULL ORDER BY claimed_at DESC LIMIT 1",
    [tederId],
  );

/**
 * A Teder demo's link to the number of one request, on the demo number, once: delivered_at is set before the send and
 * given back if it did not go (then this throws). False when it was sent already.
 */
async function tederLink(app: App, wa: Awaited<ReturnType<typeof demoLine>>['wa'], r: { id: number; code: string; phone: string; claimed_at: string }, d: any): Promise<boolean> {
  if (!(await app.db.one('UPDATE demo_requests SET delivered_at = now() WHERE id = $1 AND delivered_at IS NULL RETURNING id', [r.id]))) return false;
  try {
    const out = await reply(app, wa, { from: r.phone, text: '', id: `req-${r.code}`, at: new Date(r.claimed_at).getTime(), channel: 'whatsapp' }, tederRequestedLink({ storeName: d.name || d.domain, url: d.page_url }), null, null);
    if (!out.ok) throw new Error(out.reason);
  } catch (e) {
    await app.db.query('UPDATE demo_requests SET delivered_at = NULL WHERE id = $1', [r.id]);
    throw e;
  }
  return true;
}

/**
 * "Send now" on a Teder demo asked for with a code: its link, on the demo number to the number that wrote, inside the 23
 * hours after it wrote (Meta's window), as deliverTeder sends it by itself. A demo asked for with a typed number has
 * no window, since that number never wrote to us: the operator sends it from their own WhatsApp.
 */
export async function sendTederDirect(app: App, id: string, by: string): Promise<void> {
  const d = await row(app, 'teder', id);
  if (d.sent_at) throw new OpsError('כבר סומן שנשלח');
  if (!d.page_url || d.removed_at) throw new OpsError('הדמו של תדר עוד לא באוויר');
  const req = await tederRequest(app, String(d.id));
  if (!req) throw new OpsError('את הדמו הזה ביקשו באתר עם מספר שהקלידו, והם לא כתבו לנו בוואטסאפ, אז מהמספר של הדמו אי אפשר לשלוח. אפשר לשלוח מהוואטסאפ שלך.');
  if (now() - new Date(req.claimed_at).getTime() >= TEDER_DIRECT_HOURS * HOUR) throw new OpsError('עברו 23 שעות מההודעה שלהם, אז מהמספר של הדמו אי אפשר לשלוח. אפשר לשלוח מהוואטסאפ שלך.');
  const line = await demoLine(app);
  if (!line.live) throw new OpsError(NOT_LIVE);
  try {
    if (!(await tederLink(app, line.wa, req, d))) throw new OpsError('כבר נשלח');
  } catch (e: any) {
    if (e instanceof OpsError) throw e;
    app.log(`[ops] the Teder demo ${id} was not sent: ${e?.message || e}`);
    throw new OpsError('ההודעה לא יצאה, ושום דבר לא סומן. אפשר לנסות שוב, או לשלוח מהוואטסאפ שלך.');
  }
  await markSent(app, 'teder', id, by);
  await log(app, 'teder', id, 'direct', by, { code: req.code });
}

export async function markReplied(app: App, kind: Kind, id: string, by: string) {
  await row(app, kind, id);
  await set(app, kind, id, 'replied_at = COALESCE(replied_at, now()), snoozed_until = NULL, next_step_at = COALESCE(next_step_at, $2)', [ISO(notOnShabbat(now() + DAY))]);
  await log(app, kind, id, 'replied', by);
}

export async function setNext(app: App, kind: Kind, id: string, text: string, days: number, by: string) {
  await row(app, kind, id);
  const d = Math.max(0, Math.min(90, Math.round(days) || 0));
  await set(app, kind, id, 'next_step = $2, next_step_at = $3, replied_at = COALESCE(replied_at, now())', [text.trim().slice(0, 300) || null, ISO(notOnShabbat(now() + d * DAY))]);
  await log(app, kind, id, 'next', by, { days: d });
}

export async function later(app: App, kind: Kind, id: string, days: number, by: string) {
  await row(app, kind, id);
  const d = days >= 7 ? 7 : 1;
  await set(app, kind, id, 'snoozed_until = $2', [ISO(notOnShabbat(now() + d * DAY))]);
  await log(app, kind, id, 'later', by, { days: d });
}

export async function markLost(app: App, kind: Kind, id: string, reason: string, by: string) {
  await row(app, kind, id);
  const why = LOST_REASONS[reason] ? reason : 'other';
  await set(app, kind, id, 'lost_at = now(), lost_reason = $2', [why]);
  await log(app, kind, id, 'lost', by, { reason: why });
}

/** Back on the list: undoes "not interested" and "later". */
export async function reopen(app: App, kind: Kind, id: string, by: string) {
  await row(app, kind, id);
  await set(app, kind, id, 'lost_at = NULL, lost_reason = NULL, snoozed_until = NULL');
  await log(app, kind, id, 'reopen', by);
}

/** A Toran store starts a pilot or pays; a Teder demo's store becomes a customer. */
export async function markWon(app: App, kind: Kind, id: string, stage: 'pilot' | 'paid', by: string) {
  const r = await row(app, kind, id);
  if (kind === 'toran') await set(app, kind, id, 'status = $2, replied_at = COALESCE(replied_at, now())', [stage]);
  else await set(app, kind, id, 'won_at = COALESCE(won_at, now()), replied_at = COALESCE(replied_at, now())');
  await log(app, kind, id, 'won', by, { stage, from: r.status });
}

/**
 * The link to every Toran demo asked for on the website, sent by itself once its page is ready: the worker runs this
 * each minute. A request counts from the moment the person wrote with its code (their number is then proven), and
 * the link goes on the demo number inside the 23 hours after that (send.ts holds the 24-hour line). A page that is not
 * public yet (something missing, held back) waits; one past the 23 hours stays on the operator's list, to send by hand.
 * While our number is not connected (demoLine) nothing goes, and nothing is marked: the requests wait.
 */
export async function deliverRequested(app: App): Promise<number> {
  if (!(await demoLine(app)).live) return 0;
  const { pitchGaps, isPublic } = await import('../pitch/ready.ts');
  const due = await app.db.query<any>(
    `SELECT DISTINCT s.* FROM demo_requests r JOIN stores s ON s.domain = r.domain
      WHERE r.product = 'toran' AND r.claimed_at > now() - interval '23 hours' AND s.approved_at IS NOT NULL AND s.page_built_at IS NOT NULL AND s.sent_at IS NULL
        AND s.taken_down_at IS NULL AND s.status <> 'skipped' AND s.lost_at IS NULL`,
  );
  let n = 0;
  for (const s of due) {
    if (!isPublic(s, await pitchGaps(app, s))) continue;
    try {
      await sendDirect(app, String(s.id), 'auto');
      n++;
    } catch (e: any) {
      app.log(`[ops] the requested demo for store ${s.id} was not sent: ${e?.message || e}`);
    }
  }
  return n;
}

/**
 * The link to every Teder demo asked for on the website, sent by itself once Teder has its page up: the worker runs
 * this each minute, beside deliverRequested. A request Teder took (channels/request.ts handToTeder) waits for its demo
 * in Teder's GET /internal/demos (read again here, into teder_leads, only while one waits): public once it has a pageUrl,
 * which Teder gives an approved demo alone. The link goes on the demo number to the number that asked, inside the 23
 * hours after it wrote, once (demo_requests.delivered_at, set before the send and given back if it did not go). Two
 * numbers that asked for the same store each get its one demo. The first send marks the Teder lead sent, as the
 * operator's "שלחתי" would, so its one reminder comes due; past the 23 hours it stays on the operator's list
 * (queue.ts, asked_teder). While our number is not connected (demoLine) nothing goes, and nothing is marked: the
 * requests wait, as Toran's do.
 */
export async function deliverTeder(app: App): Promise<number> {
  const line = await demoLine(app);
  if (!line.live) return 0;
  const waiting = await app.db.query<{ id: number; code: string; phone: string; claimed_at: string; teder_id: string }>(
    `SELECT id, code, phone, claimed_at, teder_id FROM demo_requests
      WHERE product = 'teder' AND teder_id IS NOT NULL AND delivered_at IS NULL AND claimed_at > now() - interval '23 hours' ORDER BY claimed_at`,
  );
  if (!waiting.length) return 0;
  // Teder not answering leaves the copy from before, which may already have the page.
  await syncTeder(app);
  let n = 0;
  for (const r of waiting) {
    const d = await app.db.one<any>('SELECT * FROM teder_leads WHERE id = $1 AND page_url IS NOT NULL AND removed_at IS NULL AND lost_at IS NULL', [r.teder_id]);
    if (!d) continue;
    try {
      if (!(await tederLink(app, line.wa, r, d))) continue;
    } catch (e: any) {
      app.log(`[ops] the requested Teder demo ${r.teder_id} was not sent: ${e?.message || e}`);
      continue;
    }
    if (!d.sent_at) await markSent(app, 'teder', String(d.id), 'auto');
    await log(app, 'teder', String(d.id), 'direct', 'auto', { code: r.code });
    n++;
  }
  return n;
}
