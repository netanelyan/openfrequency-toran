import type { App } from '../app.ts';
import { HOUR, now } from '../core/clock.ts';
import { displayName } from '../ingest/brand.ts';
import { INGESTIBLE_HE, canIngest } from '../ingest/catalogue.ts';
import { PLATFORM_HE, shortDate } from '../web/ui.ts';
import { contactTarget, firstMessage, pitchUrl, reminderMessage } from '../outreach.ts';
import { reconnectUrl, WARN_DAYS } from '../channels/waStore.ts';
import { demoLine } from '../channels/lines.ts';
import { reconnectWhatsapp, requestedLink, requestedLinkLater, tederFirst, tederReminder, triedDemo } from './messages.ts';

// Who the operator writes to today, about Toran or Teder, most urgent first (docs/operator.md section 4), and who is
// already in a conversation. Every entry carries its message and where to send it. Nothing here sends anything,
// except the one case Toran promised: the link to a demo someone asked for, on the demo number where they asked,
// inside its 24 hours (ops/actions.ts).
//
// The order, by rank:
//   110  reconnect        a store that has Toran, whose WhatsApp has to be connected again (its token ends or ended)
//   100  tried_demo      a Toran store that tried the demo: asking how it went takes the reminder's place
//    90  next_step        someone in a conversation whose next step is due
//    85  asked_toran      a Toran page someone asked for on the website, ready and not sent: they are waiting
//    85  asked_teder      the same for a Teder demo: one asked for with a code goes out by itself inside its 23 hours
//                         (ops/actions.ts deliverTeder), and is listed here when it did not
//  55-70 reminder         the one reminder, due; a page that was opened goes first
//  40-50 first_send       a Toran page found by discovery, ready to send, by its score
// A page with nothing to send it to is listed apart (noContact), to find a contact for.

export type Reason = 'reconnect' | 'tried_demo' | 'next_step' | 'asked_toran' | 'asked_teder' | 'reminder' | 'teder_reminder' | 'first_send';
export type Item = {
  key: string; // toran:12, teder:7
  product: 'toran' | 'teder';
  id: string;
  reason: Reason;
  rank: number;
  name: string;
  domain: string;
  why: string; // one Hebrew line: why now
  message: string | null;
  target: { kind: 'whatsapp' | 'email' | null; href: string | null; label: string };
  direct: boolean; // can go out now from the demo number, where they asked: inside the hours, and our number connected
  mark: 'sent' | 'reminded' | 'next'; // what "שלחתי" records
  page: string | null;
  at: string | null; // the moment the reason is counted from
};

/** A store's WhatsApp that has to be connected again: its token ended, or ends within WARN_DAYS. */
export const reconnectSql = (t = '') => `${t}channel = 'whatsapp' AND ${t}kind = 'meta' AND (${t}status = 'reconnect' OR (${t}status = 'active' AND ${t}token_expires_at < now() + interval '${WARN_DAYS} days'))`;
export const RECONNECT_AGAIN_DAYS = 3;

/** Not answered, not lost, not put off: still someone to write to. */
const open = (t = '') => `${t}lost_at IS NULL AND ${t}replied_at IS NULL AND (${t}snoozed_until IS NULL OR ${t}snoozed_until <= now())`;
/**
 * A Toran store still in the outreach: not skipped, not a pilot or a customer, its page not taken down, and nobody's
 * own store. A store in a workspace (web/workspace.ts) is a customer's, added from /start or given by the operator:
 * its pitch page may be built, but it is never a lead to write to.
 */
const live = (t = '') => `${t}status NOT IN ('skipped', 'pilot', 'paid') AND ${t}taken_down_at IS NULL AND ${t}workspace_id IS NULL AND ${open(t)}`;
const storeName = (s: any) => displayName(s.brand_override?.name, s.brand?.name, s.name) || s.domain;
const waTarget = (phone: string | null) => (phone ? { kind: 'whatsapp' as const, href: `https://wa.me/${phone}`, label: 'להעתיק ולפתוח וואטסאפ' } : { kind: null, href: null, label: 'להעתיק' });
const DIRECT_HOURS = 23;

/**
 * A demo asked for on the website (the number proven) that has no page to send yet, and why: the operator answers them.
 * A Teder request's why names Teder, and it has no store here (storeId null).
 */
export type Stuck = { domain: string; phone: string; at: string; why: string; storeId: number | null };

/** Why a Teder request has no link yet: Teder has not taken it, or its demo is not up (Teder's statuses, src/demos/build.js). */
const tederWhy = (r: any) =>
  !r.teder_id ? (r.job === 'queued' || r.job === 'running' ? 'הבקשה בדרך לתדר' : 'תדר לא קיבל את הבקשה')
  : r.status === 'failed' ? 'תדר לא הצליח לבנות את הדמו'
  : r.status === 'removed' || r.removed_at ? 'הדמו של תדר הוסר'
  : r.status === 'ready' ? 'הדמו של תדר מחכה לבדיקה בתדר'
  : 'הדמו של תדר בבנייה';

export async function stuckRequests(app: App): Promise<Stuck[]> {
  const rows = await app.db.query<any>(
    `SELECT r.domain, r.phone, r.claimed_at, s.id, s.platform, s.page_built_at, s.approved_at, s.sent_at, s.status,
            (SELECT status FROM jobs WHERE dedupe_key = 'add:' || r.domain ORDER BY id DESC LIMIT 1) AS job
       FROM demo_requests r LEFT JOIN stores s ON s.domain = r.domain
      WHERE r.product = 'toran' AND r.claimed_at > now() - interval '14 days' AND (s.id IS NULL OR (s.sent_at IS NULL AND (s.approved_at IS NULL OR s.page_built_at IS NULL)))
      ORDER BY r.claimed_at`,
  );
  // A Teder request whose demo has no public page yet (teder_leads, as last read from Teder), its link not sent.
  const teder = await app.db.query<any>(
    `SELECT r.domain, r.phone, r.claimed_at, r.teder_id, t.status, t.removed_at,
            (SELECT status FROM jobs WHERE dedupe_key = 'teder_lead:' || r.id ORDER BY id DESC LIMIT 1) AS job
       FROM demo_requests r LEFT JOIN teder_leads t ON t.id = r.teder_id
      WHERE r.product = 'teder' AND r.claimed_at > now() - interval '14 days' AND r.delivered_at IS NULL AND t.page_url IS NULL
      ORDER BY r.claimed_at`,
  );
  const toran: Stuck[] = rows.map((r) => ({
    domain: r.domain,
    phone: r.phone,
    at: r.claimed_at,
    storeId: r.id ?? null,
    why: r.job === 'queued' || r.job === 'running' ? 'הדף בבנייה'
      : r.id && r.platform && !canIngest(r.platform) ? `האתר על ${PLATFORM_HE[r.platform] || r.platform}, ותורן בונה דמו רק לחנויות ${INGESTIBLE_HE}`
      : !r.id ? 'לא הצלחנו לקרוא את האתר'
      : !r.page_built_at ? 'הדף לא נבנה'
      : 'הדף מחכה לבדיקה, חסר בו משהו',
  }));
  const time = (at: unknown) => new Date(at as string).getTime();
  return [...toran, ...teder.map((r) => ({ domain: r.domain, phone: r.phone, at: r.claimed_at, storeId: null, why: tederWhy(r) }))].sort((a, b) => time(a.at) - time(b.at));
}

export async function queue(app: App): Promise<{ items: Item[]; noContact: any[] }> {
  const { db } = app;
  const items: Item[] = [];
  const base = live();
  // While our number is not connected (channels/lines.ts demoLine) nothing goes from it: the message is the one for
  // the operator's own WhatsApp.
  const connected = (await demoLine(app)).live;

  // A store whose WhatsApp has to be connected again (channels/waStore.ts) comes first: its customers are waiting.
  // "שלחתי" records that they were told, and the card comes back after RECONNECT_AGAIN_DAYS while it is still so.
  for (const s of await db.query<any>(
    `SELECT s.*, a.status AS wa_status, a.token_expires_at FROM channel_accounts a JOIN stores s ON s.id = a.store_id
      WHERE ${reconnectSql('a.')} AND COALESCE((a.meta->>'reconnect_told_at')::timestamptz, 'epoch') < now() - interval '${RECONNECT_AGAIN_DAYS} days'
      ORDER BY a.status = 'reconnect' DESC, a.token_expires_at`,
  )) {
    const name = storeName(s);
    const ended = s.wa_status === 'reconnect';
    const ends = ended ? null : shortDate(s.token_expires_at);
    items.push({ key: `toran:${s.id}`, product: 'toran', id: String(s.id), reason: 'reconnect', rank: 110, name, domain: s.domain, why: ended ? 'החיבור של הוואטסאפ הסתיים, תורן לא עונה בו' : `צריך לחבר מחדש את הוואטסאפ עד ${ends}`, message: reconnectWhatsapp({ storeName: name, url: reconnectUrl(app.env, s.id), ends }), target: contactTarget(s), direct: false, mark: 'sent', page: reconnectUrl(app.env, s.id), at: s.token_expires_at });
  }

  for (const s of await db.query<any>(`SELECT * FROM stores WHERE ${base} AND demo_started_at IS NOT NULL AND followup_sent_at IS NULL ORDER BY demo_started_at DESC`)) {
    const name = storeName(s);
    items.push({ key: `toran:${s.id}`, product: 'toran', id: String(s.id), reason: 'tried_demo', rank: 100, name, domain: s.domain, why: 'ניסו את הדמו', message: triedDemo({ storeName: name }), target: contactTarget(s), direct: false, mark: 'reminded', page: pitchUrl(app.env, s.slug), at: s.demo_started_at });
  }

  // Asked on the website: the request was claimed from their number, so the page goes to that number.
  const asked = await db.query<any>(
    `SELECT s.*, r.phone AS req_phone, r.claimed_at AS req_at, r.code AS req_code FROM stores s
       JOIN demo_requests r ON r.domain = s.domain AND r.product = 'toran' AND r.claimed_at IS NOT NULL
      WHERE ${live('s.')} AND s.approved_at IS NOT NULL AND s.page_built_at IS NOT NULL AND s.sent_at IS NULL
      ORDER BY r.claimed_at`,
  );
  const askedIds = new Set(asked.map((s) => s.id));
  for (const s of asked) {
    const name = storeName(s);
    const url = pitchUrl(app.env, s.slug);
    const direct = connected && now() - new Date(s.req_at).getTime() < DIRECT_HOURS * HOUR;
    items.push({ key: `toran:${s.id}`, product: 'toran', id: String(s.id), reason: 'asked_toran', rank: 85, name, domain: s.domain, why: 'ביקשו דמו באתר, הדף מוכן', message: direct ? requestedLink({ storeName: name, url }) : requestedLinkLater({ storeName: name, url }), target: waTarget(s.req_phone || s.contact_whatsapp), direct, mark: 'sent', page: url, at: s.req_at });
  }

  for (const s of await db.query<any>(`SELECT * FROM stores WHERE ${base} AND sent_at IS NOT NULL AND followup_sent_at IS NULL AND followup_due_at <= now() AND demo_started_at IS NULL ORDER BY opened_at IS NULL, followup_due_at`)) {
    const name = storeName(s);
    items.push({ key: `toran:${s.id}`, product: 'toran', id: String(s.id), reason: 'reminder', rank: s.opened_at ? 70 : 60, name, domain: s.domain, why: s.opened_at ? 'התזכורת, והדף נפתח' : 'התזכורת, הדף עוד לא נפתח', message: reminderMessage({ storeName: name, url: pitchUrl(app.env, s.slug) }), target: contactTarget(s), direct: false, mark: 'reminded', page: pitchUrl(app.env, s.slug), at: s.followup_due_at });
  }

  const ready = await db.query<any>(`SELECT * FROM stores WHERE ${base} AND approved_at IS NOT NULL AND page_built_at IS NOT NULL AND sent_at IS NULL ORDER BY score DESC`);
  const noContact: any[] = [];
  for (const s of ready) {
    if (askedIds.has(s.id)) continue;
    if (!s.contact_whatsapp && !s.contact_email) {
      noContact.push(s);
      continue;
    }
    const name = storeName(s);
    items.push({ key: `toran:${s.id}`, product: 'toran', id: String(s.id), reason: 'first_send', rank: 40 + Math.min(10, Math.round((Number(s.score) || 0) / 10)), name, domain: s.domain, why: `מוכן לשליחה, ציון ${s.score}`, message: firstMessage({ storeName: name, url: pitchUrl(app.env, s.slug) }), target: contactTarget(s), direct: false, mark: 'sent', page: pitchUrl(app.env, s.slug), at: s.approved_at });
  }

  const tbase = `removed_at IS NULL AND won_at IS NULL AND ${open()}`;
  for (const d of await db.query<any>(`SELECT * FROM teder_leads WHERE ${tbase} AND page_url IS NOT NULL AND sent_at IS NULL ORDER BY approved_at`)) {
    const name = d.name || d.domain;
    items.push({ key: `teder:${d.id}`, product: 'teder', id: String(d.id), reason: 'asked_teder', rank: 85, name, domain: d.domain, why: 'ביקשו דמו של תדר באתר, המצגת מוכנה', message: tederFirst({ storeName: name, url: d.page_url }), target: waTarget(d.whatsapp), direct: false, mark: 'sent', page: d.page_url, at: d.approved_at });
  }
  for (const d of await db.query<any>(`SELECT * FROM teder_leads WHERE ${tbase} AND page_url IS NOT NULL AND sent_at IS NOT NULL AND reminded_at IS NULL AND reminder_due_at <= now() ORDER BY opens = 0, reminder_due_at`)) {
    const name = d.name || d.domain;
    items.push({ key: `teder:${d.id}`, product: 'teder', id: String(d.id), reason: 'teder_reminder', rank: d.opens ? 65 : 55, name, domain: d.domain, why: d.opens ? `התזכורת, המצגת נפתחה ${d.opens} פעמים` : 'התזכורת, המצגת עוד לא נפתחה', message: tederReminder({ storeName: name, url: d.page_url }), target: waTarget(d.whatsapp), direct: false, mark: 'reminded', page: d.page_url, at: d.reminder_due_at });
  }

  for (const c of await conversations(app)) {
    if (!c.next_step_at || new Date(c.next_step_at).getTime() > now()) continue;
    items.push({ key: c.key, product: c.product, id: c.id, reason: 'next_step', rank: 90, name: c.name, domain: c.domain, why: `הצעד הבא: ${c.next_step || 'לחזור אליהם'}`, message: null, target: c.target, direct: false, mark: 'next', page: c.page, at: c.next_step_at });
  }

  // Within a rank the one waiting longer comes first. `at` arrives as a Date from the database and as an ISO string from
  // Teder, so it is compared as a time: as text, "Mon Oct 26" sorted before "Sun Oct 25".
  const time = (at: unknown) => (at ? new Date(at as string).getTime() || Infinity : Infinity);
  items.sort((a, b) => b.rank - a.rank || time(a.at) - time(b.at));
  // A store that fits two reasons (it tried the demo and was never sent the page) is listed once, for the first.
  const seen = new Set<string>();
  return { items: items.filter((i) => !seen.has(i.key) && seen.add(i.key)), noContact };
}

export type Conversation = { key: string; product: 'toran' | 'teder'; id: string; name: string; domain: string; replied_at: string; next_step: string | null; next_step_at: string | null; target: Item['target']; page: string | null; status: string };

/** Everyone who answered and has not said no, nor become a customer. */
export async function conversations(app: App): Promise<Conversation[]> {
  const toran = await app.db.query<any>("SELECT * FROM stores WHERE replied_at IS NOT NULL AND lost_at IS NULL AND status NOT IN ('paid', 'skipped') ORDER BY next_step_at NULLS LAST, replied_at DESC");
  const teder = await app.db.query<any>('SELECT * FROM teder_leads WHERE replied_at IS NOT NULL AND lost_at IS NULL AND won_at IS NULL ORDER BY next_step_at NULLS LAST, replied_at DESC');
  return [
    ...toran.map((s) => ({ key: `toran:${s.id}`, product: 'toran' as const, id: String(s.id), name: storeName(s), domain: s.domain, replied_at: s.replied_at, next_step: s.next_step, next_step_at: s.next_step_at, target: contactTarget(s), page: s.slug ? pitchUrl(app.env, s.slug) : null, status: s.status })),
    ...teder.map((d) => ({ key: `teder:${d.id}`, product: 'teder' as const, id: String(d.id), name: d.name || d.domain, domain: d.domain, replied_at: d.replied_at, next_step: d.next_step, next_step_at: d.next_step_at, target: waTarget(d.whatsapp), page: d.page_url, status: d.status })),
  ].sort((a, b) => String(a.next_step_at || '9999').localeCompare(String(b.next_step_at || '9999')));
}
