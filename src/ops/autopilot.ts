import { timingSafeEqual } from 'node:crypto';
import type { App } from '../app.ts';
import type { Out, Req, Route } from '../web/server.ts';
import { customerQuiet, israelDate, now } from '../core/clock.ts';
import { cleanLine } from '../core/hebrew.ts';
import { J } from '../db/index.ts';
import { audit, event } from '../db/log.ts';
import { displayName } from '../ingest/brand.ts';
import { canIngest } from '../ingest/catalogue.ts';
import { publicBase } from '../auto/messages.ts';
import { monthSpend } from '../agent/spend.ts';
import { aboutOf, discoverLeads, stockOf } from './leadsAdmin.ts';
import { emailPitch, mailInsteadOf, MAIL_SAID_HE } from './emailPitch.ts';
import { MOBILE_IL, SAID_HE, sendPitch, type Product } from './outreach.ts';

// The lead autopilot's door (the owner, 2026-11-15: "i want the lead dashboard to be automatic. the dashboard chooses
// which stores should have a demo (teder/toran/both). sends it itself, sells the products himself. AUTOMATIC", then
// "20 leads a day, 10 at morning 10 at afternoon", "make the lead engine so strong that it gets customers without me
// even looking at it"). Twice a day a scheduled Claude Code task (on the owner's subscription, docs/autopilot.md) reads
// the stores here, looks at each one's site, chooses Toran, Teder, both or neither, and asks the chosen ones the
// question (ops/outreach.ts OUTREACH_ASK, by email when there is no mobile). Everything after a yes runs here by itself
// (ops/ask.ts), and our support sells from there. This door is the only way in: /autopilot/*, from the internet,
// with TORAN_AUTOPILOT_TOKEN (its own key, not the internal one), and it does lead work only: it reads candidates and
// the day's numbers, sets a lead's product or sets it aside, asks, starts a discovery, and keeps a note. It never
// touches a customer, a payment or a setting. TORAN_AUTOPILOT=1 turns its writes on; anything else, they are refused.
//
// Its own limits, over the outreach ones: at most TORAN_AUTOPILOT_DAILY (20) questions a day and TORAN_AUTOPILOT_BATCH
// (10) a batch (an Israel morning, before 13:00, and an afternoon), never at night, on Shabbat or a holiday.

export const AUTOPILOT_DAILY = 20;
export const AUTOPILOT_BATCH = 10;
const num = (v: unknown, d: number) => (Number(v) > 0 ? Math.floor(Number(v)) : d);
export const autopilotOn = (env: Record<string, string | undefined>) => String(env.TORAN_AUTOPILOT || '').trim() === '1';
const digits = (s: unknown) => String(s ?? '').replace(/\D/g, '');

/** The key: TORAN_AUTOPILOT_TOKEN, 32 characters at least, as a bearer; anything else is refused. */
export function autopilotRefusal(app: App, r: Req): Out | null {
  const token = String(app.env.TORAN_AUTOPILOT_TOKEN || '').trim();
  if (token.length < 32) return { status: 503, json: { error: 'not_configured' } };
  const got = Buffer.from(String(r.req.headers.authorization || ''));
  const want = Buffer.from(`Bearer ${token}`);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { status: 401, json: { error: 'bad_token' } };
  return null;
}

/** The half of the Israel day a question goes in: the morning batch before 13:00, the afternoon's after. */
const halfOf = (t: number) => (Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', hour12: false }).format(new Date(t))) < 13 ? 'morning' : 'afternoon');

/** The questions the autopilot sent today, and in this half of the day (each kept with its day and half, autopilotAsk). */
async function askedToday(app: App): Promise<{ day: number; half: number }> {
  const r = await app.db.one<{ day: number; half: number }>(
    "SELECT COUNT(*)::int AS day, COUNT(*) FILTER (WHERE data->>'half' = $2)::int AS half FROM events WHERE kind = 'autopilot_ask' AND data->>'day' = $1",
    [israelDate(now()), halfOf(now())],
  );
  return { day: r?.day || 0, half: r?.half || 0 };
}

/** A store the autopilot may ask: a qualified lead never written to, not set aside, lost or a customer, reachable. */
const CANDIDATE_SQL = `
  s.qualified AND s.status IN ('new', 'page_ready') AND s.platform IS DISTINCT FROM 'company' AND s.workspace_id IS NULL
  AND s.lost_at IS NULL AND s.skipped_at IS NULL AND s.sent_at IS NULL AND s.taken_down_at IS NULL AND s.takedown_asked_at IS NULL
  AND (s.contact_whatsapp ~ '^9725[0-9]{8}$' OR COALESCE(trim(s.contact_email), '') <> '')
  AND NOT EXISTS (SELECT 1 FROM events e WHERE e.store_id IS NULL AND e.kind = 'outreach_wa' AND (e.data->>'ref' IN ('store:' || s.id, 'toran:' || s.id) OR e.data->>'phone' = s.contact_whatsapp))
  AND NOT EXISTS (SELECT 1 FROM events e WHERE e.kind = 'outreach_mail' AND e.store_id = s.id)
  AND NOT EXISTS (SELECT 1 FROM outreach_stops o WHERE o.phone = s.contact_whatsapp)`;

/** The day as the autopilot reads it: on or off, quiet or not, what went today and in this batch, the pool, spend. */
export async function autopilotState(app: App) {
  const asked = await askedToday(app);
  const pool = (await app.db.one<{ n: number }>(`SELECT COUNT(*)::int AS n FROM stores s WHERE ${CANDIDATE_SQL}`))?.n || 0;
  const undecided = (await app.db.one<{ n: number }>(`SELECT COUNT(*)::int AS n FROM stores s WHERE ${CANDIDATE_SQL} AND s.demo_for IS NULL`))?.n || 0;
  const since = "now() - interval '24 hours'";
  const day = await app.db.one<any>(
    `SELECT COUNT(*) FILTER (WHERE data->>'stage' = 'ask' AND data->>'state' = 'sent')::int AS asked,
            COUNT(*) FILTER (WHERE data->>'stage' = 'ask' AND data->>'yes' IS NOT NULL)::int AS yes,
            COUNT(*) FILTER (WHERE data->>'stage' = 'ask' AND data->>'deliver' = 'sent')::int AS delivered,
            COUNT(*) FILTER (WHERE data->>'stage' = 'ask' AND data->>'deliver' IN ('failed', 'expired'))::int AS delivery_failed,
            COUNT(*) FILTER (WHERE data->>'state' = 'undelivered')::int AS undelivered
     FROM events WHERE kind IN ('outreach_wa', 'outreach_mail') AND at > ${since}`,
  );
  const lastDiscovery = await app.db.one<{ at: string | null; source: string | null; status: string | null }>("SELECT created_at AS at, payload->>'source' AS source, status FROM jobs WHERE kind = 'discover' ORDER BY id DESC LIMIT 1");
  const cap = Number(app.env.TORAN_MONTHLY_CAP_USD) || 0;
  return {
    on: autopilotOn(app.env),
    quiet: customerQuiet(now()),
    half: halfOf(now()),
    limits: { day: num(app.env.TORAN_AUTOPILOT_DAILY, AUTOPILOT_DAILY), batch: num(app.env.TORAN_AUTOPILOT_BATCH, AUTOPILOT_BATCH) },
    asked,
    pool: { askable: pool, undecided, daysLeft: Math.floor(pool / num(app.env.TORAN_AUTOPILOT_DAILY, AUTOPILOT_DAILY)) },
    last24h: day,
    spend: { monthUsd: Math.round((await monthSpend(app.db)) * 100) / 100, capUsd: cap },
    lastDiscovery,
  };
}

/** The stores the autopilot may ask, best first, each as the leads page says it (ops/leadsAdmin.ts aboutOf). */
export async function autopilotCandidates(app: App, limit = 30) {
  const rows = await app.db.query<any>(`SELECT s.* FROM stores s WHERE ${CANDIDATE_SQL} ORDER BY s.score DESC NULLS LAST, s.id LIMIT $1`, [Math.min(Math.max(limit, 1), 60)]);
  const stock = await stockOf(app, rows.map((r) => Number(r.id)));
  return rows.map((s) => {
    const name = displayName(s.brand_override?.name, s.brand?.name, s.name) || s.domain;
    const sig = s.signals || {};
    const mobile = MOBILE_IL.test(digits(s.contact_whatsapp));
    return {
      id: Number(s.id),
      name,
      domain: s.domain,
      url: s.url || `https://${s.domain}/`,
      platform: s.platform,
      score: s.score,
      scoreParts: s.score_breakdown || null,
      ...aboutOf(s, name, stock.get(Number(s.id))),
      reach: mobile ? 'whatsapp' : 'email',
      whatsappOnSite: Boolean(sig.whatsappWidget) || (Array.isArray(sig.whatsappNumbers) && sig.whatsappNumbers.length > 0),
      toranCan: canIngest(s.platform),
      chosen: s.demo_for || null,
      notes: s.notes || '',
    };
  });
}

const PRODUCTS: (Product | 'none')[] = ['toran', 'teder', 'both', 'none'];

/** The autopilot's choice for a store: its product, kept for the question's yes, or set aside with the reason. */
export async function autopilotDecide(app: App, id: number, product: unknown, reason: unknown): Promise<{ ok: boolean; message: string }> {
  const why = cleanLine(reason, 300);
  if (!PRODUCTS.includes(product as any)) return { ok: false, message: 'product must be toran, teder, both or none' };
  const s = await app.db.one<any>(`SELECT s.* FROM stores s WHERE s.id = $1 AND ${CANDIDATE_SQL}`, [id]);
  if (!s) return { ok: false, message: 'not a store the autopilot may decide (written to, set aside, a customer, or unreachable)' };
  if (product === 'none') {
    await app.db.query("UPDATE stores SET status = 'skipped', skipped_at = now(), notes = CASE WHEN $2 <> '' THEN COALESCE(notes || E'\\n', '') || $2 ELSE notes END, updated_at = now() WHERE id = $1", [id, `האוטומט: לא מתאים. ${why}`.trim()]);
    await audit(app.db, { actor: 'autopilot', action: 'lead_skip', storeId: id, detail: { why } });
    return { ok: true, message: 'set aside' };
  }
  if (product !== 'teder' && !canIngest(s.platform)) return { ok: false, message: `Toran cannot read a ${s.platform || 'unknown'} store: only teder` };
  await app.db.query("UPDATE stores SET demo_for = $2, notes = CASE WHEN $3 <> '' THEN COALESCE(notes || E'\\n', '') || $3 ELSE notes END, updated_at = now() WHERE id = $1", [id, product, why ? `האוטומט בחר ${product}: ${why}` : '']);
  await audit(app.db, { actor: 'autopilot', action: 'lead_choose', storeId: id, detail: { product, why } });
  return { ok: true, message: `chose ${product}` };
}

/**
 * The question to one store: on WhatsApp to its mobile, else by email, for the product chosen for it; within the day's
 * and the batch's limits. The store leaves the list then (sent_at), with no reminder due: the question has none.
 */
export async function autopilotAsk(app: App, id: number): Promise<{ sent: boolean; why: string | null; said: string }> {
  if (!autopilotOn(app.env)) return { sent: false, why: 'off', said: 'TORAN_AUTOPILOT is off' };
  if (customerQuiet(now())) return { sent: false, why: 'quiet', said: SAID_HE.quiet };
  const s = await app.db.one<any>(`SELECT s.* FROM stores s WHERE s.id = $1 AND ${CANDIDATE_SQL}`, [id]);
  if (!s) return { sent: false, why: 'not_candidate', said: 'not a store the autopilot may ask' };
  if (!s.demo_for) return { sent: false, why: 'no_product', said: 'decide its product first (POST /autopilot/decide)' };
  const asked = await askedToday(app);
  if (asked.day >= num(app.env.TORAN_AUTOPILOT_DAILY, AUTOPILOT_DAILY)) return { sent: false, why: 'day_cap', said: "today's questions went" };
  if (asked.half >= num(app.env.TORAN_AUTOPILOT_BATCH, AUTOPILOT_BATCH)) return { sent: false, why: 'batch_cap', said: "this batch's questions went" };
  const name = displayName(s.brand_override?.name, s.brand?.name, s.name) || s.domain;
  const product = s.demo_for as Product;
  const via = await mailInsteadOf(app, s.contact_whatsapp, s.contact_email);
  const out = via
    ? await emailPitch(app, { storeId: id, product, stage: 'ask', by: 'autopilot', why: via })
    : await sendPitch(app, { product, stage: 'ask', phone: digits(s.contact_whatsapp), name, url: '', ref: `store:${id}`, by: 'autopilot' });
  if (out.sent) {
    await app.db.query("UPDATE stores SET sent_at = COALESCE(sent_at, now()), status = CASE WHEN status IN ('new', 'page_ready') THEN 'sent' ELSE status END, updated_at = now() WHERE id = $1", [id]);
    await event(app.db, id, 'autopilot_ask', { product, via: via ? 'email' : 'whatsapp', day: israelDate(now()), half: halfOf(now()) });
  }
  return { sent: out.sent, why: out.why, said: out.said || (out.why ? (MAIL_SAID_HE as any)[out.why] || (SAID_HE as any)[out.why] || '' : '') };
}

/** What happened in the last hours, for the autopilot's review: every question, its yes, its demo, its answer. */
export async function autopilotRecent(app: App, hours = 24) {
  const rows = await app.db.query<any>(
    `SELECT e.id, e.kind, e.at, e.store_id, e.data FROM events e WHERE e.kind IN ('outreach_wa', 'outreach_mail') AND e.at > now() - ($1 || ' hours')::interval ORDER BY e.id DESC LIMIT 200`,
    [String(Math.min(Math.max(hours, 1), 24 * 14))],
  );
  return rows.map((e) => {
    const d = e.data || {};
    const store = e.store_id || Number(/^(?:toran|store):(\d+)$/.exec(String(d.ref || ''))?.[1]) || null;
    return {
      at: e.at,
      channel: e.kind === 'outreach_mail' ? 'email' : 'whatsapp',
      store,
      name: d.name || null,
      product: d.product,
      stage: d.stage,
      state: d.state,
      delivered: d.delivered || null,
      read: d.read || null,
      yes: d.yes || null,
      deliver: d.deliver || null,
      replied: d.replied != null,
      autoAnswer: d.auto_answer ? cleanLine(d.auto_answer, 120) : null,
      error: d.error ? cleanLine(d.error, 120) : null,
      chat: d.kept ? `${publicBase(app.env)}/chat/${Number(d.kept)}` : null,
    };
  });
}

/** A note of the autopilot's, kept for the owner (the leads page shows the last ones). */
export async function autopilotNote(app: App, text: unknown): Promise<{ ok: boolean }> {
  const t = String(text ?? '').trim().slice(0, 4000);
  if (!t) return { ok: false };
  await event(app.db, null, 'autopilot_note', { text: t });
  return { ok: true };
}

export const autopilotNotes = (app: App, n = 10) => app.db.query<{ at: string; text: string }>("SELECT at, data->>'text' AS text FROM events WHERE kind = 'autopilot_note' ORDER BY id DESC LIMIT $1", [n]);

const BODY_LIMIT = 8192;
function bodyOf(r: Req): any {
  const raw = r.raw || '';
  if (Buffer.byteLength(raw, 'utf8') > BODY_LIMIT) return null;
  try {
    const b = JSON.parse(raw || '{}');
    return b && typeof b === 'object' && !Array.isArray(b) ? b : null;
  } catch {
    return null;
  }
}

const json = (j: unknown, status = 200): Out => ({ status, json: j, headers: { 'cache-control': 'no-store' } });

export function autopilotRoutes(app: App): Route<Req>[] {
  const guard = (r: Req) => autopilotRefusal(app, r);
  const writes = (r: Req) => guard(r) || (autopilotOn(app.env) ? null : json({ error: 'off' }, 409));
  return [
    ['GET', /^\/autopilot\/state$/, async (r) => guard(r) || json(await autopilotState(app))],
    ['GET', /^\/autopilot\/candidates$/, async (r) => guard(r) || json({ candidates: await autopilotCandidates(app, Number(r.url.searchParams.get('limit')) || 30) })],
    ['GET', /^\/autopilot\/recent$/, async (r) => guard(r) || json({ recent: await autopilotRecent(app, Number(r.url.searchParams.get('hours')) || 24) })],
    ['GET', /^\/autopilot\/notes$/, async (r) => guard(r) || json({ notes: await autopilotNotes(app) })],
    ['POST', /^\/autopilot\/decide$/, async (r) => {
      const refused = writes(r);
      if (refused) return refused;
      const b = bodyOf(r);
      if (!b || !Number.isInteger(b.id)) return json({ error: 'bad_request' }, 400);
      return json(await autopilotDecide(app, b.id, b.product, b.reason));
    }],
    ['POST', /^\/autopilot\/ask$/, async (r) => {
      const refused = writes(r);
      if (refused) return refused;
      const b = bodyOf(r);
      if (!b || !Number.isInteger(b.id)) return json({ error: 'bad_request' }, 400);
      return json(await autopilotAsk(app, b.id));
    }],
    ['POST', /^\/autopilot\/discover$/, async (r) => {
      const refused = writes(r);
      if (refused) return refused;
      const b = bodyOf(r) || {};
      try {
        return json({ ok: true, ...(await discoverLeads(app, { source: b.source, by: 'autopilot' })) });
      } catch (e: any) {
        return json({ ok: false, message: cleanLine(e?.message || e, 200) });
      }
    }],
    ['POST', /^\/autopilot\/note$/, async (r) => {
      const refused = guard(r);
      if (refused) return refused;
      return json(await autopilotNote(app, (bodyOf(r) || {}).text));
    }],
  ];
}
