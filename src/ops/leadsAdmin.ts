import type { App } from '../app.ts';
import type { Out, Req, Route } from '../web/server.ts';
import { brandColor, displayName, normHex } from '../ingest/brand.ts';
import { J } from '../db/index.ts';
import { audit, event } from '../db/log.ts';
import { enqueue } from '../jobs/queue.ts';
import { now } from '../core/clock.ts';
import { canonicalDomain, homeUrl } from '../core/urls.ts';
import { canIngest, INGESTIBLE_HE } from '../ingest/catalogue.ts';
import { contactTarget, firstMessage, le, pitchUrl, reminderMessage } from '../outreach.ts';
import { pageStats } from '../pitch/track.ts';
import { pitchGaps } from '../pitch/ready.ts';
import { storeAbout } from '../leads/about.ts';
import { forgetStorePrompt } from '../agent/loop.ts';
import { eraseStore } from '../erase.ts';
import { isCompany } from '../company.ts';
import { isSet } from '../core/env.ts';
import { selling } from '../web/workspace.ts';
import { internalRefusal } from './internal.ts';
import { later, markLost, markReminded, markReplied, markSent, OpsError, reopen, sendNow } from './actions.ts';
import { sendBoth, sendTeder } from './both.ts';
import { bothFirst, bothReminder, tederColdFirst, tederReminder } from './messages.ts';
import { outreachFilled, outreachLive, templateOf } from './outreach.ts';
import { tederBuild, tederDemoAct, tederList, tederMark, tederMove, tederState, type TederDemoAct, type TederLead, type TederMove } from './tederLeads.ts';
import { LOST_REASONS } from './messages.ts';

// The shared lead dashboard's data (the owner, 2026-11-08: "make the shared lead dashboard be in the admin dashboard,
// not in one of the products"). Accounts' /admin/leads shows one list for both products and one page a lead, and asks
// here, on this machine, with OF_INTERNAL_TOKEN (docs/contracts/admin-leads.json, accounts' own copy):
//
//   GET  /internal/leads?where=&q=        the list: Toran's stores that are leads, each with its Teder lead (by Toran's
//                                         id, else the domain), and Teder's leads Toran has no store for
//   GET  /internal/leads/<id>             one lead: both demos, which message is due and how it can go, the texts
//   POST /internal/leads/<id>/<action>    go-both, go-toran, go-teder, build-toran, build-teder, build-both,
//                                         send-both, send-toran, send-teder, mark-sent, mark-reminded, notes, skip
//
// The rest of a lead's buttons (they answered, the next step, later, not interested, a customer) are /internal/ops' own
// (ops/api.ts), which the dashboard already uses. Toran keeps the outreach and its rules (ops/outreach.ts, ops/both.ts):
// what does not go is said in the operator's words, and nothing is marked then. Approving a Toran page stays a look at
// it first, on Toran's own review page, which the lead links to.
//
// Each row says what can be built for it, so the list has a button to make a demo (the owner, 2026-11-11: "each leads
// should have a button for generating a demo for teder/toran/both. the message that is suggested being sent to the
// phone number on whatsapp should be according to that"). What the operator asks to make is kept (stores.demo_for,
// migration 077), and the lead's page leads with that one's message: Toran's, Teder's, or the one with both. Each
// message due is given as the store will read it, and "שלחתי" after one sent by hand marks the demo it was for.
//
// The choice is what the lead goes on with, whatever is built already (the owner, 2026-11-12: "i dont see a button for
// going on with teder/toran/both for each lead"): the button offered only what was missing, so a lead whose Toran page
// was up could no longer be taken on with both. go-both, go-toran and go-teder keep the choice as it is said and make
// only what it still lacks, nothing when it lacks nothing; build.go says, for each, whether it can be chosen and what
// it would make now. build-* stay as they were (build-toran is also "read the site again").

export type Where = 'new' | 'ready' | 'sent' | 'talking' | 'closed';
export const WHERE: Where[] = ['new', 'ready', 'sent', 'talking', 'closed'];
type DemoState = 'none' | 'building' | 'review' | 'ready' | 'failed' | 'removed';
/** idea: what Teder's demo is about (its topic), as Teder's own lead card said it; null for Toran's, and before it is chosen. */
type Demo = { state: DemoState; pageUrl: string | null; sentAt: string | null; reminderSentAt: string | null; reminderDue: boolean; error: string | null; idea: string | null };
/** A lead's demos as the operator picks them: Toran's, Teder's, or both in one message. */
type Product = 'both' | 'toran' | 'teder';
const PRODUCTS: Product[] = ['both', 'toran', 'teder'];
const productOf = (v: unknown): Product | null => (PRODUCTS.includes(v as Product) ? (v as Product) : null);
type Stage = 'first' | 'reminder';

const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
const https = (v: unknown) => (typeof v === 'string' && /^https:\/\/\S+$/.test(v) ? v : null);

function toranDemo(app: App, s: any, building: boolean): Demo {
  const due = s.sent_at && !s.followup_sent_at && ['sent', 'opened', 'demo_started'].includes(s.status) && s.followup_due_at && new Date(s.followup_due_at).getTime() <= now();
  const state: DemoState = s.taken_down_at ? 'removed' : !s.page_built_at ? (building ? 'building' : 'none') : !s.approved_at ? 'review' : 'ready';
  return {
    state,
    pageUrl: s.page_built_at && s.slug ? pitchUrl(app.env, s.slug) : null,
    sentAt: iso(s.sent_at),
    reminderSentAt: iso(s.followup_sent_at),
    reminderDue: Boolean(due),
    error: null,
    idea: null,
  };
}

function tederDemo(l: TederLead | null): Demo {
  const d = l?.demo;
  const state: DemoState = !d ? 'none' : d.status === 'removed' ? 'removed' : d.status === 'failed' ? 'failed' : d.pageUrl ? 'ready' : d.building || ['new', 'building'].includes(d.status) ? 'building' : 'review';
  return { state, pageUrl: d?.pageUrl || null, sentAt: l?.sentAt || null, reminderSentAt: l?.reminderSentAt || null, reminderDue: Boolean(l?.reminderDue), error: d?.error || null, idea: state === 'removed' ? null : d?.topic || null };
}

/**
 * Which of a demo's two messages is due: the first while its demo is up and waits to be sent, the one reminder once it
 * is due; null for neither, and while there is no demo up (being built, under review, failed or removed).
 */
const toranStageOf = (s: any, d: Demo): Stage | null => (d.state !== 'ready' ? null : !s.sent_at ? 'first' : !s.followup_sent_at && d.reminderDue ? 'reminder' : null);
const tederStageOf = (t: TederLead | null, d: Demo): Stage | null => (!t || d.state !== 'ready' ? null : t.stage === 'demo_ready' ? 'first' : t.reminderDue ? 'reminder' : null);

/** What going on with a product would do now: whether it can be chosen, and the demos it would make first. */
type Go = { can: boolean; makes: ('toran' | 'teder')[] };

/**
 * What can be built for the store now: Toran's page (also again, once it is built), Teder's demo (none yet, or one
 * that failed or was removed), and both at once while neither has one and nothing is being built. go: each choice of
 * what the lead goes on with (go-both, go-toran, go-teder), whatever is built already.
 */
function buildOf(s: any, t: TederLead | null, tederOk: boolean, building: boolean) {
  const toran = canIngest(s.platform) && !s.taken_down_at;
  const teder = tederOk && (!t?.demo || ['removed', 'failed'].includes(t.demo.status));
  const makes = { toran: toran && !s.page_built_at && !building, teder };
  const go = (p: Product): Go => {
    const can = !s.taken_down_at && (p === 'teder' || toran) && (p === 'toran' || tederOk);
    return { can, makes: can ? (['toran', 'teder'] as const).filter((q) => (p === 'both' || p === q) && makes[q]) : [] };
  };
  return {
    toran,
    teder,
    both: toran && teder && !s.page_built_at && !building && !t?.demo,
    toranWhyNot: canIngest(s.platform) ? null : `תורן קורא כרגע רק חנויות ${INGESTIBLE_HE}.`,
    go: { both: go('both'), toran: go('toran'), teder: go('teder') },
  };
}

/** Where the lead stands for both products together: what the list's tabs count. */
function whereOf(s: any | null, t: TederLead | null, toran: Demo, teder: Demo): Where {
  if ((s && (s.status === 'skipped' || s.status === 'paid' || s.taken_down_at || s.lost_at)) || (t && ['joined', 'irrelevant'].includes(t.stage))) return 'closed';
  if ((s && (s.replied_at || s.status === 'pilot')) || t?.stage === 'replied') return 'talking';
  if (toran.sentAt || teder.sentAt) return 'sent';
  if (toran.state === 'ready' || teder.state === 'ready') return 'ready';
  return 'new';
}

/** What Toran read of a store's catalogue: how many products, their prices, and the kinds most of them are. */
type Stock = { n: number; lo: number | null; hi: number | null; kinds: string[] };

/** The catalogue of each store Toran read (its products table), for the stores in ids; a store not read is not in it. */
async function stockOf(app: App, ids: number[]): Promise<Map<number, Stock>> {
  const out = new Map<number, Stock>();
  if (!ids.length) return out;
  // The prices are the merchandise's: a product hidden by hand, a fee sold as a line (shipping, gift wrap: tools.ts
  // isFee) and anything free are left out of them, never out of the count.
  const rows = await app.db.query<{ id: number; n: number; lo: number | null; hi: number | null }>(
    `SELECT store_id AS id, COUNT(*)::int AS n,
            MIN(price_min) FILTER (WHERE ${PRICED})::float AS lo, MAX(COALESCE(price_max, price_min)) FILTER (WHERE ${PRICED})::float AS hi
       FROM products WHERE store_id = ANY($1::int[]) AND gone_at IS NULL GROUP BY store_id`,
    [ids],
  );
  for (const r of rows) out.set(Number(r.id), { n: Number(r.n), lo: r.lo == null ? null : Number(r.lo), hi: r.hi == null ? null : Number(r.hi), kinds: [] });
  const kinds = await app.db.query<{ id: number; kind: string; n: number }>(
    "SELECT store_id AS id, btrim(product_type) AS kind, COUNT(*)::int AS n FROM products WHERE store_id = ANY($1::int[]) AND gone_at IS NULL AND btrim(COALESCE(product_type, '')) <> '' GROUP BY store_id, btrim(product_type) ORDER BY store_id, n DESC, kind",
    [ids],
  );
  for (const k of kinds) {
    const st = out.get(Number(k.id));
    if (st && st.kinds.length < KINDS_MAX && k.kind.length <= 40) st.kinds.push(k.kind);
  }
  return out;
}
const KINDS_MAX = 3;
const PRICED = `price_min > 0 AND NOT COALESCE((override->>'hidden')::boolean, false) AND title !~* '(משלוח|שילוח|אריזת מתנה|עטיפת מתנה|אחריות|ביטוח|פיקדון|shipping|delivery|gift ?wrap|warranty|insurance|deposit)'`;

/**
 * A store in a few words, for the operator to say Toran, Teder, both or neither (the owner, 2026-11-12: "i want each
 * store to have a short description, so that i will know if i should build toran/teder/both/neither for that store"):
 * its line in its own words (leads/about.ts, null when its site says nothing more than its name), and what Toran found
 * of it: its products (read, else counted when it was found: atLeast when the count stopped), their prices and kinds
 * once read, and its own Instagram, TikTok and Facebook. Nothing here is guessed or written by a model.
 */
function aboutOf(s: any, name: string, stock: Stock | undefined) {
  const sig = s.signals || {};
  const counted = Number.isInteger(sig.productCount) ? Number(sig.productCount) : null;
  return {
    about: storeAbout({ description: sig.description, title: sig.title, names: [name, s.brand_override?.name, s.brand?.name, s.name], domain: s.domain }),
    facts: {
      products: stock ? stock.n : counted,
      productsAtLeast: !stock && counted != null && sig.productCountCapped === true,
      priceMin: stock?.lo ?? null,
      priceMax: stock?.hi ?? null,
      currency: String(s.config?.currency || 'ILS'),
      kinds: stock?.kinds || [],
      social: { instagram: https(sig.social?.instagram), tiktok: https(sig.social?.tiktok), facebook: https(sig.social?.facebook) },
      // Whether its site was read for them: a store found before 2026-11-05 was not (leads/social.ts), and its having
      // none is then not known.
      socialRead: Boolean(sig.social) && typeof sig.social === 'object' && !Array.isArray(sig.social),
    },
  };
}

function rowOf(app: App, s: any, t: TederLead | null, building: boolean, tederOk: boolean, stock?: Stock) {
  const toran = toranDemo(app, s, building);
  const teder = tederDemo(t);
  const name = displayName(s.brand_override?.name, s.brand?.name, s.name) || s.domain;
  return {
    id: Number(s.id),
    name,
    domain: s.domain,
    url: s.url,
    platform: s.platform || null,
    ...aboutOf(s, name, stock),
    score: Number(s.score) || 0,
    qualified: Boolean(s.qualified),
    where: whereOf(s, t, toran, teder),
    contact: { whatsapp: s.contact_whatsapp || null, email: s.contact_email || null, phone: s.contact_phone || null },
    toran,
    teder,
    build: buildOf(s, t, tederOk, building),
    chosen: productOf(s.demo_for),
    updatedAt: iso(s.updated_at) || new Date(now()).toISOString(),
  };
}

// A store the operator added here by its address is listed whatever its score (migration 078). One lead's page and its
// buttons take any store that is no customer's and not our own, so a store Teder has a lead of opens here even when it
// left the list (its score fell since Teder took it).
const ONE_SQL = `${selling()} AND status <> 'company'`;
const LEADS_SQL = `${ONE_SQL} AND (qualified OR page_built_at IS NOT NULL OR sent_at IS NOT NULL OR added_at IS NOT NULL)`;

/** The stores whose Toran page is being built now: their site read (ingest), or their sample chat made again (pitch). */
async function building(app: App, ids: number[]): Promise<Set<number>> {
  if (!ids.length) return new Set();
  const rows = await app.db.query<{ id: number }>("SELECT (payload->>'storeId')::int AS id FROM jobs WHERE kind IN ('ingest', 'pitch') AND status IN ('queued', 'running') AND (payload->>'storeId')::int = ANY($1::int[])", [ids]);
  return new Set(rows.map((r) => Number(r.id)));
}

/** The discovery sources the operator can run from the list (worker.ts 'discover'); brave only with its key. */
const SOURCES = ['storecensus', 'crawl', 'brave', 'seeds'] as const;
type Source = (typeof SOURCES)[number];
const ADDING_HOURS = 24;

/**
 * What the operator asked to find, from the list: each store added by its address in the last day that is not a lead
 * yet (still being read, or refused with the reason), and whether a discovery run is on now, with the last one's numbers.
 */
async function findings(app: App) {
  const adds = await app.db.query<any>(
    `SELECT id, status, payload->>'url' AS url, last_error, created_at FROM jobs
      WHERE kind = 'add_store' AND payload->>'added' = 'true' AND created_at > now() - make_interval(hours => ${ADDING_HOURS}) AND status IN ('queued', 'running', 'failed')
      ORDER BY id DESC LIMIT 10`,
  );
  const running = await app.db.one<{ source: string }>("SELECT payload->>'source' AS source FROM jobs WHERE kind = 'discover' AND status IN ('queued', 'running') ORDER BY id DESC LIMIT 1");
  const last = await app.db.one<any>('SELECT source, started_at, finished_at, stats FROM discovery_runs WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1');
  return {
    adding: adds.map((j) => ({ url: String(j.url || ''), state: j.status === 'failed' ? 'failed' : 'reading', error: j.status === 'failed' ? String(j.last_error || '').slice(0, 300) : null, at: iso(j.created_at) })),
    discovery: {
      running: running ? running.source : null,
      sources: SOURCES.filter((x) => x !== 'brave' || isSet('BRAVE_API_KEY', app.env)),
      last: last ? { source: String(last.source), at: iso(last.finished_at), found: Number(last.stats?.leads) || 0, fit: Number(last.stats?.qualified) || 0, looked: Number(last.stats?.candidates) || 0 } : null,
    },
  };
}

const keyOf = (d: string) => String(d || '').toLowerCase().replace(/^www\./, '');

/**
 * The list, both products together, with how many stand where. all: the stores discovery found that did not pass the
 * score too (as Toran's own lead page shows them), so one can be chosen by hand.
 */
export async function leadsList(app: App, { where = '', q = '', all = false }: { where?: string; q?: string; all?: boolean } = {}) {
  const tl = await tederList(app);
  const tederOk = !('error' in tl);
  const tLeads = 'error' in tl ? [] : tl.leads;
  const tIds = tLeads.map((l) => Number(l.toranId)).filter((n) => Number.isInteger(n) && n > 0);
  const tDomains = tLeads.map((l) => keyOf(l.domain)).filter(Boolean);
  const stores = await app.db.query<any>(
    `SELECT * FROM stores WHERE ${ONE_SQL} AND (${all ? 'true' : '(qualified OR page_built_at IS NOT NULL OR sent_at IS NOT NULL OR added_at IS NOT NULL)'} OR id = ANY($1::int[]) OR lower(regexp_replace(domain, '^www\\.', '')) = ANY($2::text[]))
      ORDER BY updated_at DESC NULLS LAST, score DESC LIMIT 1000`,
    [tIds, tDomains],
  );
  const byToran = new Map(tLeads.filter((l) => l.toranId).map((l) => [String(l.toranId), l]));
  const byDomain = new Map(tLeads.map((l) => [keyOf(l.domain), l]));
  const ids = stores.map((s) => Number(s.id));
  const run = await building(app, ids);
  const stock = await stockOf(app, ids);
  const used = new Set<number>();
  const rows = stores.map((s) => {
    const t = byToran.get(String(s.id)) || byDomain.get(keyOf(s.domain)) || null;
    if (t) used.add(t.id);
    return rowOf(app, s, t, run.has(Number(s.id)), tederOk, stock.get(Number(s.id)));
  });
  const tederOnly = tLeads
    .filter((l) => !used.has(l.id))
    .map((l) => {
      const teder = tederDemo(l);
      return { tederId: l.id, name: l.name || l.domain, domain: l.domain, where: whereOf(null, l, toranDemo(app, { id: 0 }, false), teder), teder };
    });
  const needle = q.trim().toLowerCase();
  const hit = (x: { name: string; domain: string }) => !needle || x.name.toLowerCase().includes(needle) || x.domain.toLowerCase().includes(needle);
  const counts = Object.fromEntries(WHERE.map((w) => [w, rows.filter((r) => r.where === w).length + tederOnly.filter((r) => r.where === w).length])) as Record<Where, number>;
  const wanted = (WHERE as string[]).includes(where) ? where : '';
  return {
    ok: true,
    teder: { ok: tederOk },
    counts: { all: rows.length + tederOnly.length, ...counts },
    leads: rows.filter((r) => (!wanted || r.where === wanted) && hit(r)).slice(0, 300),
    tederOnly: tederOnly.filter((r) => (!wanted || r.where === wanted) && hit(r)).slice(0, 100),
    ...(await findings(app)),
  };
}

const NOT_NOW_REMINDER = 'עוד לא הזמן לתזכורת.';

/** One lead: both demos, the message due and the ways it can go, the texts, and what can be built. */
export async function leadOne(app: App, id: number) {
  const s = await app.db.one<any>(`SELECT * FROM stores WHERE id = $1 AND ${ONE_SQL}`, [id]);
  if (!s) return null;
  const st = await tederState(app, s);
  const t = 'error' in st ? null : st.lead;
  const run = await building(app, [id]);
  const row = rowOf(app, s, t, run.has(id), !('error' in st), (await stockOf(app, [id])).get(id));
  const name = row.name;
  const pitchable = Boolean(s.contact_whatsapp) && (await outreachLive(app));
  const toranStage = toranStageOf(s, row.toran);
  const tederStage = tederStageOf(t, row.teder);
  // One message carries both demos only at the same stage: both first, or both reminders.
  const stages: Record<Product, Stage | null> = { both: toranStage && toranStage === tederStage ? toranStage : null, toran: toranStage, teder: tederStage };
  // From our number, each one due; the one the operator chose to make comes first when it can go, else both, as before.
  const options = pitchable ? PRODUCTS.filter((p) => stages[p]) : [];
  if (row.chosen && options.includes(row.chosen)) options.unshift(...options.splice(options.indexOf(row.chosen), 1));
  const stage = toranStage || tederStage || null;
  const waiting = s.sent_at && !s.followup_sent_at && !row.toran.reminderDue && s.followup_due_at && !s.taken_down_at ? iso(s.followup_due_at) : null;
  // Each message due, as the store will read it: from our number the approved template's words (its buttons open the
  // demos), else the text the operator copies to send from their own WhatsApp, with each demo's link in it.
  const toranUrl = row.toran.pageUrl || '';
  const tederUrl = row.teder.pageUrl || '';
  const copied: Record<Product, Record<Stage, () => string>> = {
    toran: { first: () => firstMessage({ storeName: name, url: toranUrl }), reminder: () => reminderMessage({ storeName: name, url: toranUrl }) },
    teder: { first: () => tederColdFirst({ storeName: name, url: tederUrl }), reminder: () => tederReminder({ storeName: name, url: tederUrl }) },
    both: { first: () => bothFirst({ storeName: name, toranUrl, tederUrl }), reminder: () => bothReminder({ storeName: name, toranUrl, tederUrl }) },
  };
  const text = (p: Product) => {
    const at = stages[p];
    return !at ? null : pitchable ? outreachFilled(templateOf(p, at), [le(name)]) : copied[p][at]();
  };
  const texts = { bothText: text('both'), toranText: text('toran'), tederText: text('teder') };
  // The chat or the mail it goes by, with no text in it: accounts writes in the message shown. A mail's subject is
  // what we made for them, whichever demo it is.
  const target = contactTarget(s);
  const href = target.kind === 'email' ? `mailto:${s.contact_email}?subject=${encodeURIComponent(`מה שהכנו ${le(name)}`)}` : target.href;
  const stats = s.page_built_at ? await pageStats(app, id) : null;
  return {
    ok: true,
    lead: {
      ...row,
      status: s.status,
      notes: s.notes || '',
      demoCode: s.demo_code || null,
      opens: Number(stats?.opens || 0),
      stats: stats ? { opens: Number(stats.opens) || 0, visitors: Number(stats.visitors) || 0, depth: Number(stats.depth) || 0, clicks: Number(stats.clicks) || 0, lastOpen: iso(stats.last) } : null,
      demoStartedAt: iso(s.demo_started_at),
      tederOk: !('error' in st),
      takedownAskedAt: iso(s.takedown_asked_at),
      scoreParts: (Array.isArray(s.score_breakdown) ? s.score_breakdown : []).map((f: any) => ({ factor: String(f.factor || ''), he: FACTOR_HE[f.factor] || String(f.factor || ''), points: Number(f.points) || 0, max: Number(f.max) || 0, evidence: String(f.evidence || '').slice(0, 200) })),
      review: s.page_built_at ? await toranReview(app, s, run.has(id)) : null,
      send: {
        stage,
        pitchable,
        options,
        main: options[0] || null,
        waitingUntil: waiting,
        ...texts,
        copy: Object.values(texts).some(Boolean) && href ? { href, label: target.label } : null,
      },
    },
  };
}

/** The parts of a lead's score, as Toran's own lead page names them (web/pages/leads.ts). */
const FACTOR_HE: Record<string, string> = { platform: 'פלטפורמה', catalogue: 'קטלוג', hebrew: 'עברית', whatsapp: 'וואטסאפ', email: 'מייל', phone: 'טלפון', alive: 'פעילות', israeli: 'ישראלי', chain: 'רשת', restricted: 'קטגוריה' };

/**
 * Toran's page, checked here and not on Toran's own review page (the owner, 2026-11-12: it "MUST not send me to old
 * fronts"): what holds it back (pitch/ready.ts, each fixed on the lead's page: the name and the colour, the sample chat
 * made again), the name and colour it shows and the colours found on the site, the sample chat and what the last build
 * turned down (pitch/review.ts), whether it is approved, and held back by hand ("לבטל את האישור") since it was built.
 */
async function toranReview(app: App, s: any, building: boolean) {
  const gaps = await pitchGaps(app, s);
  const pitch = await app.db.one<{ sample_chat: any[] }>('SELECT sample_chat FROM pitches WHERE store_id = $1', [s.id]);
  const built = await app.db.one<any>("SELECT data FROM events WHERE store_id = $1 AND kind = 'page_built' ORDER BY at DESC, id DESC LIMIT 1", [s.id]);
  const held = await app.db.one<{ n: number }>(
    "SELECT COUNT(*)::int AS n FROM events WHERE store_id = $1 AND kind = 'unapproved' AND at >= COALESCE((SELECT MAX(at) FROM events WHERE store_id = $1 AND kind = 'page_built'), '-infinity'::timestamptz)",
    [s.id],
  );
  const brand = { ...(s.brand || {}), ...(s.brand_override || {}) };
  const turned = Array.isArray(built?.data?.turnedDown) ? built.data.turnedDown : [];
  return {
    gaps: gaps.map((g) => ({ key: g.key, he: g.he })),
    approved: Boolean(s.approved_at),
    held: !s.approved_at && Boolean(held?.n),
    building,
    name: displayName(s.brand_override?.name, s.brand?.name, s.name),
    color: brandColor(brand),
    colorsFound: (Array.isArray(s.brand?.colors) ? s.brand.colors : []).filter((c: unknown) => typeof c === 'string' && normHex(c)).slice(0, 6),
    chat: (Array.isArray(pitch?.sample_chat) ? pitch!.sample_chat : []).map((m: any) => ({ role: m.role === 'agent' ? 'agent' : 'customer', text: String(m.text || '').slice(0, 2000) })),
    turnedDown: turned.slice(0, 8).map((x: any) => ({ product: String(x.product || '').slice(0, 200), why: String(x.why || '').slice(0, 400) })),
    builtAt: iso(s.page_built_at),
  };
}

// go-none: neither (the owner, 2026-11-12: "toran/teder/both/neither"). approve-toran, hold-toran, brand and sample:
// Toran's page checked and fixed on the lead's page (toranReview). replied, later, lost and reopen: where the lead stands,
// as /internal/ops records it for Toran, with Teder's lead moved to match. teder-*: its demo worked (tederLeads.ts
// tederDemoAct). takedown and delete: the store asked, or it is not one.
const ACTIONS = [
  'go-both', 'go-toran', 'go-teder', 'go-none', 'build-toran', 'build-teder', 'build-both', 'send-both', 'send-toran', 'send-teder', 'mark-sent', 'mark-reminded', 'notes', 'skip',
  'approve-toran', 'hold-toran', 'brand', 'sample', 'replied', 'later', 'lost', 'reopen', 'teder-approve', 'teder-redo', 'teder-other', 'teder-remove', 'takedown', 'delete',
] as const;
type Action = (typeof ACTIONS)[number];

/** What holds Toran's page back, in a few words, for a refusal to approve it (pitch/ready.ts says where to fix it). */
const GAP_SHORT: Record<string, string> = { name: 'אין שם לחנות', color: 'אין צבע מותג', products: 'לא נמצאו מוצרים באתר', sample: 'אין שיחת דוגמה', price: 'המחיר של תורן עוד לא נקבע', of_number: 'אין מספר וואטסאפ של OpenFrequency', demo_number: 'אין מספר דמו' };

/**
 * Teder's lead of the store moved to match what the operator said here: nothing when Teder has no lead of it, a line
 * when Teder did not take it. The move Teder already has ("כבר מסומנת כך", "כבר ברשימה") is not a failure.
 */
async function tederFollow(app: App, s: any, stage: TederMove, by: string): Promise<string> {
  const st = await tederState(app, s);
  if ('error' in st) return ` ${st.error}`;
  if (!st.lead) return '';
  if (stage === 'back' && st.lead.stage !== 'irrelevant') return '';
  if (stage !== 'back' && (st.lead.stage === stage || (stage === 'replied' && st.lead.stage === 'joined'))) return '';
  const out = await tederMove(app, s, stage, by);
  if ('error' in out) return /כבר/.test(out.error) ? '' : ` תדר לא סימן את זה אצלו: ${out.error}`;
  await audit(app.db, { actor: by, action: 'teder_moved', storeId: s.id, detail: { stage, from: 'admin' } });
  return '';
}

/**
 * Going on with a product (go-both, go-toran, go-teder): the choice kept as it is said, and only what it still lacks
 * made, Teder's first (a Teder that does not answer stops it before anything is made). ready: nothing was left to make
 * and nothing is being made, so its message can go now.
 */
async function goOn(app: App, s: any, p: Product, by: string, ingest: () => Promise<void>, teder: () => Promise<string>): Promise<{ message: string; ready: boolean }> {
  const st = p === 'toran' ? { lead: null } : await tederState(app, s);
  if ('error' in st) throw new OpsError(st.error);
  const run = await building(app, [s.id]);
  const b = buildOf(s, st.lead, true, run.has(s.id)).go[p];
  if (!b.can) throw new OpsError(s.taken_down_at ? 'העמוד של החנות הוסר, ולא כותבים להם יותר.' : `תורן קורא כרגע רק חנויות ${INGESTIBLE_HE}. אפשר להמשיך רק עם תדר.`);
  const made: string[] = [];
  if (b.makes.includes('teder')) made.push(`תדר: ${await teder()}`);
  if (b.makes.includes('toran')) {
    await ingest();
    made.push('תורן קורא את האתר ובונה את הדף. זה לוקח דקה או שתיים.');
  }
  await app.db.query('UPDATE stores SET demo_for = $2, updated_at = now() WHERE id = $1', [s.id, p]);
  await audit(app.db, { actor: by, action: 'lead_go', storeId: s.id, detail: { product: p, makes: b.makes, from: 'admin' } });
  const what = { both: 'עם תורן ותדר', toran: 'עם תורן', teder: 'עם תדר' }[p];
  if (made.length) return { message: `ממשיכים ${what}. ${made.join(' ')}`, ready: false };
  // Nothing to make: what is still being built or waits to be looked at, else the message can go now.
  const pending: string[] = [];
  if (p !== 'teder') {
    if (run.has(s.id)) pending.push('תורן עוד בונה את הדף');
    else if (!s.approved_at) pending.push('הדף של תורן מחכה לבדיקה');
  }
  if (p !== 'toran' && !st.lead?.demo?.pageUrl) pending.push('הדמו של תדר עוד לא מוכן');
  return pending.length ? { message: `ממשיכים ${what}. ${pending.join(', ו')}.`, ready: false } : { message: `ממשיכים ${what}. ההודעה מוכנה לשליחה.`, ready: true };
}

/** One button of the lead's page: the operator's line when done, OpsError with the reason when not. */
type Body = { by?: unknown; notes?: unknown; reason?: unknown; product?: unknown; name?: unknown; color?: unknown; days?: unknown };

export async function leadAct(app: App, id: number, action: Action, b: Body): Promise<string> {
  return (await leadDo(app, id, action, b)).message;
}

/** leadAct's line, and for going on with a product whether its message can go now. */
export async function leadDo(app: App, id: number, action: Action, b: Body): Promise<{ message: string; ready?: boolean; gone?: boolean }> {
  const said = (message: string) => ({ message });
  const s = await app.db.one<any>(`SELECT * FROM stores WHERE id = $1 AND ${ONE_SQL}`, [id]);
  if (!s) throw new OpsError('אין ליד כזה');
  const by = String(b.by || 'operator').slice(0, 120);
  const ingest = async () => {
    if (!canIngest(s.platform)) throw new OpsError(`תורן קורא כרגע רק חנויות ${INGESTIBLE_HE}. אפשר לבנות רק את תדר.`);
    if (s.taken_down_at) throw new OpsError('העמוד של החנות הוסר, ולא בונים לה דף.');
    await enqueue(app.db, 'ingest', { storeId: s.id }, { dedupeKey: `ingest:${s.id}` });
    await audit(app.db, { actor: by, action: 'ingest', storeId: s.id, detail: { from: 'admin' } });
  };
  const teder = async () => {
    const out = await tederBuild(app, s.id, by);
    if ('error' in out) throw new OpsError(out.error);
    await audit(app.db, { actor: by, action: 'teder_build', storeId: s.id, detail: { from: 'admin' } });
    return out.message;
  };
  // The demo the operator asked to make here, kept for the lead's message; asking for the other one too makes it both.
  const choose = (p: 'toran' | 'teder') => app.db.query("UPDATE stores SET demo_for = CASE WHEN demo_for IS NULL OR demo_for = $2 THEN $2 ELSE 'both' END WHERE id = $1", [s.id, p]);
  switch (action) {
    case 'go-both':
    case 'go-toran':
    case 'go-teder':
      return goOn(app, s, action.slice(3) as Product, by, ingest, teder);
    case 'build-toran':
      await ingest();
      // Reading a built page again is not a choice of Toran.
      if (!s.page_built_at) await choose('toran');
      return said(s.page_built_at ? 'תורן קורא את האתר מחדש ובונה את הדף מחדש.' : 'תורן קורא את האתר ובונה את הדף. זה לוקח דקה או שתיים.');
    case 'build-teder': {
      const msg = await teder();
      await choose('teder');
      return said(`תדר: ${msg}`);
    }
    case 'build-both': {
      const msg = await teder();
      await choose('teder');
      await ingest();
      await choose('toran');
      return said(`בונים את שניהם: תורן קורא את האתר ובונה את הדף, ותדר: ${msg}`);
    }
    case 'send-toran':
      return said(await sendNow(app, 'toran', String(s.id), by));
    case 'send-teder':
      return said(await sendTeder(app, s.id, by));
    case 'send-both':
      return said(await sendBoth(app, s.id, by));
    case 'mark-sent':
      return said(await markByHand(app, s, 'first', productOf(b.product) || 'toran', by));
    case 'mark-reminded':
      return said(await markByHand(app, s, 'reminder', productOf(b.product) || 'toran', by));
    case 'notes':
      await app.db.query('UPDATE stores SET notes = $2, updated_at = now() WHERE id = $1', [s.id, String(b.notes ?? '').slice(0, 4000)]);
      return said('ההערות נשמרו.');
    case 'skip':
    case 'go-none': {
      // Neither, or skipped: nobody writes to them from either product. Teder hides a store Toran skipped at its next
      // sync (ops/stores.ts optedOut); its lead is marked not relevant now, so the two say the same at once.
      const reason = String(b.reason ?? '').trim().slice(0, 300) || (action === 'go-none' ? 'לא מתאים לתורן ולא לתדר' : '');
      await app.db.query("UPDATE stores SET status = 'skipped', skipped_at = now(), notes = CASE WHEN $2 <> '' THEN COALESCE(notes || E'\\n', '') || $2 ELSE notes END, updated_at = now() WHERE id = $1", [s.id, reason]);
      await event(app.db, s.id, 'skipped', { reason: reason || null, by });
      await audit(app.db, { actor: by, action: action === 'go-none' ? 'lead_none' : 'skip', storeId: s.id, detail: { from: 'admin' } });
      const teder = await tederFollow(app, s, 'irrelevant', by);
      return said(`${action === 'go-none' ? 'לא ממשיכים עם החנות הזו, לא עם תורן ולא עם תדר.' : 'דילגת על החנות.'} היא עברה לסגורים, ולא כותבים לה.${teder}`);
    }
    case 'approve-toran': {
      if (!s.page_built_at) throw new OpsError('לחנות עוד אין דף של תורן.');
      if (s.taken_down_at) throw new OpsError('העמוד הזה הוסר, ואי אפשר לאשר אותו שוב.');
      if (s.approved_at) throw new OpsError('הדף כבר מאושר.');
      const gaps = await pitchGaps(app, s);
      if (gaps.length) throw new OpsError(`עוד אי אפשר לאשר: ${gaps.map((g) => GAP_SHORT[g.key] || g.he).join(', ')}.`);
      await app.db.query('UPDATE stores SET approved_at = now(), updated_at = now() WHERE id = $1', [s.id]);
      await event(app.db, s.id, 'approved', { by });
      await audit(app.db, { actor: by, action: 'approve', storeId: s.id, detail: { from: 'admin' } });
      return said('הדף של תורן אושר, ואפשר לשלוח אותו.');
    }
    case 'hold-toran': {
      if (!s.approved_at) throw new OpsError('הדף של תורן לא מאושר.');
      await app.db.query('UPDATE stores SET approved_at = NULL, updated_at = now() WHERE id = $1', [s.id]);
      // A hold: the page does not approve itself again until it is built again (pitch/ready.ts autoApprove).
      await event(app.db, s.id, 'unapproved', { by });
      await audit(app.db, { actor: by, action: 'unapprove', storeId: s.id, detail: { from: 'admin' } });
      return said('האישור בוטל. הדף לא נפתח לאף אחד עד שמאשרים אותו שוב.');
    }
    case 'brand': {
      // The two a page waits for (pitch/ready.ts): the name it shows and its colour, over what was read from the site,
      // kept through the daily re-read like every correction on Toran's own review page.
      if (!s.page_built_at) throw new OpsError('לחנות עוד אין דף של תורן.');
      const o: Record<string, unknown> = { ...(s.brand_override || {}) };
      const name = String(b.name ?? '').trim();
      const color = String(b.color ?? '').trim();
      if (!name && !color) throw new OpsError('אין מה לשמור.');
      if (name) o.name = name.slice(0, 80);
      if (color) {
        const c = normHex(color);
        if (!c) throw new OpsError('הצבע צריך להיות בצורה #b4532a.');
        o.colors = [c];
      }
      await app.db.query('UPDATE stores SET brand_override = $2::jsonb, updated_at = now() WHERE id = $1', [s.id, J(o)]);
      forgetStorePrompt(s.id);
      await audit(app.db, { actor: by, action: 'brand_override', storeId: s.id, detail: { ...(name ? { name } : {}), ...(color ? { color } : {}), from: 'admin' } });
      return said('נשמר. הדף מציג את זה מעכשיו.');
    }
    case 'sample': {
      if (!s.page_built_at) throw new OpsError('לחנות עוד אין דף של תורן. קודם בונים אותו.');
      if (s.taken_down_at) throw new OpsError('העמוד הזה הוסר, ולא בונים לו שיחה.');
      await enqueue(app.db, 'pitch', { storeId: s.id, by }, { dedupeKey: `pitch:${s.id}`, maxAttempts: 1 });
      await audit(app.db, { actor: by, action: 'rebuild_sample', storeId: s.id, detail: { from: 'admin' } });
      return said('תורן בונה את שיחת הדוגמה מחדש. זה לוקח דקה או שתיים.');
    }
    case 'replied':
      await markReplied(app, 'toran', String(s.id), by);
      return said(`עבר ל"בשיחה". לא שולחים להם יותר תזכורת.${await tederFollow(app, s, 'replied', by)}`);
    case 'later': {
      const days = Number(b.days) >= 7 ? 7 : 1;
      await later(app, 'toran', String(s.id), days, by);
      return said(days === 7 ? 'יחזור לרשימה של מי לכתוב לו בעוד שבוע.' : 'יחזור לרשימה של מי לכתוב לו מחר.');
    }
    case 'lost': {
      const reason = String(b.reason ?? '');
      if (!LOST_REASONS[reason]) throw new OpsError('צריך לבחור למה.');
      await markLost(app, 'toran', String(s.id), reason, by);
      return said(`סומן שלא מעוניינים. לא נכתוב להם יותר.${await tederFollow(app, s, 'irrelevant', by)}`);
    }
    case 'reopen': {
      if (s.taken_down_at || s.takedown_asked_at) throw new OpsError('הם ביקשו להוריד את העמוד, ולא כותבים להם יותר.');
      // A skip undone: the store stands where it was by what happened to it.
      if (s.status === 'skipped') await app.db.query("UPDATE stores SET status = CASE WHEN sent_at IS NOT NULL THEN 'sent' WHEN page_built_at IS NOT NULL THEN 'page_ready' ELSE 'new' END, skipped_at = NULL, updated_at = now() WHERE id = $1", [s.id]);
      await reopen(app, 'toran', String(s.id), by);
      return said(`החנות חזרה לרשימה.${await tederFollow(app, s, 'back', by)}`);
    }
    case 'teder-approve':
    case 'teder-redo':
    case 'teder-other':
    case 'teder-remove': {
      const act = action.slice(6) as TederDemoAct;
      const out = await tederDemoAct(app, s, act, by);
      if ('error' in out) throw new OpsError(out.error);
      await audit(app.db, { actor: by, action: `teder_${act}`, storeId: s.id, detail: { from: 'admin' } });
      return said(`תדר: ${out.message}.`);
    }
    case 'takedown': {
      // The store asked: its Toran page and demo code stop, the reminder is cancelled, and nobody writes to it (a
      // takedown is an opt-out, migration 002); its Teder demo comes down with it.
      if (s.taken_down_at) throw new OpsError('העמוד כבר הוסר.');
      await app.db.tx(async (t) => {
        await t.query("UPDATE stores SET taken_down_at = now(), status = 'skipped', skipped_at = COALESCE(skipped_at, now()), followup_due_at = NULL, updated_at = now() WHERE id = $1", [s.id]);
        await t.query('DELETE FROM wa_users WHERE store_id = $1', [s.id]);
        await event(t, s.id, 'taken_down', { by, asked: Boolean(s.takedown_asked_at) });
      });
      await audit(app.db, { actor: by, action: 'takedown', storeId: s.id, detail: { from: 'admin' } });
      const st = await tederState(app, s);
      let teder = '';
      if ('error' in st) teder = ` את הדמו של תדר לא הורדנו: ${st.error}`;
      else if (st.lead?.demo && st.lead.demo.status !== 'removed') {
        const out = await tederDemoAct(app, s, 'remove', by);
        teder = 'error' in out ? ` את הדמו של תדר לא הורדנו: ${out.error}` : ' גם הדמו של תדר הורד.';
      }
      return said(`${s.page_built_at ? 'העמוד של תורן הוסר. הקישור והקוד של הדמו כבר לא עובדים.' : 'החנות סומנה כמי שביקשה שלא נכתוב לה.'}${teder}`);
    }
    case 'delete': {
      if (isCompany(s)) throw new OpsError('את החנות של OpenFrequency לא מוחקים מכאן.');
      // Teder's lead first, so it does not stay on the list as Teder's alone: marked not relevant there.
      const teder = await tederFollow(app, s, 'irrelevant', by);
      try {
        await eraseStore(app, s.id, by);
      } catch (e: any) {
        app.log(`[erase] store ${s.id} not deleted: ${e?.message || e}`);
        throw new OpsError('לא הצלחנו לנתק את אחד הערוצים של החנות, אז לא נמחק כלום. נסו שוב בעוד כמה דקות.');
      }
      return { message: `החנות נמחקה מתורן, עם הדף, השיחות וכל מה שנקרא מהאתר.${teder}`, gone: true };
    }
  }
}

/**
 * "שלחתי" after the operator sent the message from their own WhatsApp: the demo it was for (Toran's, Teder's, or
 * both) marked as a send from our number marks it, the first message or the one reminder. Teder's is checked before
 * anything is marked; when Teder does not take the mark after Toran's was made, the line says so.
 */
async function markByHand(app: App, s: any, stage: Stage, p: Product, by: string): Promise<string> {
  if (p !== 'toran') {
    const st = await tederState(app, s);
    if ('error' in st) throw new OpsError(st.error);
    if (tederStageOf(st.lead, tederDemo(st.lead)) !== stage) throw new OpsError(stage === 'first' ? 'לתדר אין עכשיו הודעה ראשונה לסמן לחנות הזו.' : 'עוד לא הזמן לתזכורת של תדר.');
  }
  if (p !== 'teder') {
    if (stage === 'first') await markSent(app, 'toran', String(s.id), by);
    else {
      if (!s.sent_at) throw new OpsError('עוד לא נשלחה הודעה ראשונה.');
      if (s.followup_due_at && new Date(s.followup_due_at).getTime() > now()) throw new OpsError(NOT_NOW_REMINDER);
      await markReminded(app, 'toran', String(s.id), by);
    }
  }
  const said = {
    toran: { first: 'סומן שנשלח. התזכורת האחת תחכה בעוד ארבעה ימים.', reminder: 'התזכורת סומנה. זו הייתה האחרונה.' },
    teder: { first: 'סומן שנשלח בתדר. התזכורת האחת תחכה בעוד ארבעה ימים.', reminder: 'התזכורת של תדר סומנה. זו הייתה האחרונה.' },
    both: { first: 'סומן ששני הדמואים נשלחו. התזכורת האחת תחכה בעוד ארבעה ימים.', reminder: 'התזכורת לשניהם סומנה. זו הייתה האחרונה.' },
  }[p][stage];
  if (p === 'toran') return said;
  const marked = await tederMark(app, s, stage, by);
  if ('error' in marked) {
    if (p === 'teder') throw new OpsError(marked.error);
    return `${said} תדר לא סימן את זה אצלו (${marked.error}), אז כדאי לסמן ב/leads של תדר.`;
  }
  await audit(app.db, { actor: by, action: 'teder_marked', storeId: s.id, detail: { stage, from: 'admin' } });
  return said;
}

/**
 * A store added to the list by its address (POST /internal/leads/add): read and scored as discovery reads a store, and
 * listed whatever its score (migration 078), with nothing built until the operator says what for. One already here is
 * listed again; a customer's site is refused.
 */
export async function addLead(app: App, b: Body & { url?: unknown }): Promise<{ message: string; id?: number }> {
  const url = homeUrl(String(b.url || ''));
  const domain = url ? canonicalDomain(url) : null;
  if (!url || !domain) throw new OpsError('זו לא כתובת של אתר.');
  const by = String(b.by || 'operator').slice(0, 120);
  const known = await app.db.one<{ id: number; workspace_id: number | null; status: string }>('SELECT id, workspace_id, status FROM stores WHERE domain = $1', [domain]);
  if (known?.workspace_id || known?.status === 'company') throw new OpsError('זה האתר של לקוח שלנו.');
  if (known) {
    await app.db.query('UPDATE stores SET added_at = now(), updated_at = now() WHERE id = $1', [known.id]);
    await audit(app.db, { actor: by, action: 'lead_added', storeId: known.id, detail: { url, again: true } });
    return { message: known.status === 'skipped' ? 'החנות כבר ברשימה, בסגורים.' : 'החנות כבר ברשימה.', id: Number(known.id) };
  }
  // A site that did not answer last time is asked again, and so is a lead deleted since (its domain is still marked
  // seen, with no store); one that is not a store stays refused, with its reason.
  await app.db.query("DELETE FROM seen_domains WHERE domain = $1 AND verdict IN ('failed', 'lead')", [domain]);
  await enqueue(app.db, 'add_store', { url, by, added: true }, { dedupeKey: `add:${domain}`, maxAttempts: 1 });
  await audit(app.db, { actor: by, action: 'add_store', detail: { url, from: 'admin' } });
  return { message: 'קוראים את האתר. בעוד דקה החנות תופיע ברשימה, עם התיאור שלה.' };
}

/**
 * More stores found (POST /internal/leads/discover), as Toran's settings page runs it: Shopify's directory of Israeli
 * stores by default, each run from the page after the last one's, or the links between stores, Brave's search (with its
 * key) or the seeds file.
 */
export async function discoverLeads(app: App, b: Body & { source?: unknown }): Promise<{ message: string }> {
  const source: Source = SOURCES.includes(b.source as Source) ? (b.source as Source) : 'storecensus';
  if (source === 'brave' && !isSet('BRAVE_API_KEY', app.env)) throw new OpsError('חסר המפתח של החיפוש של Brave (BRAVE_API_KEY).');
  const last = await app.db.one<{ from: string | null }>("SELECT payload->>'from' AS from FROM jobs WHERE kind = 'discover' AND payload->>'source' = 'storecensus' ORDER BY id DESC LIMIT 1");
  const from = source === 'storecensus' && last?.from ? Math.min(500, (Number(last.from) || 1) + STORECENSUS_PAGES) : 1;
  const by = String(b.by || 'operator').slice(0, 120);
  await enqueue(app.db, 'discover', { source, from }, { dedupeKey: `discover:${source}`, maxAttempts: 1 });
  await audit(app.db, { actor: by, action: 'discover', detail: { source, from, by: 'admin' } });
  return { message: 'מחפשים חנויות. מה שיימצא יופיע ברשימה בעוד כמה דקות, עם התיאור של כל חנות.' };
}
/** The pages of Shopify's directory one run reads (worker.ts 'discover'). */
const STORECENSUS_PAGES = 3;

export function leadsAdminRoutes(app: App): Route<Req>[] {
  const refusal = (r: Req): Out | null => internalRefusal(app, r);
  const body = (r: Req): any => {
    try {
      const b = r.raw ? JSON.parse(r.raw) : {};
      return b && typeof b === 'object' && !Array.isArray(b) ? b : null;
    } catch {
      return null;
    }
  };
  const run = async (r: Req, f: (b: any) => Promise<Record<string, unknown>>): Promise<Out> => {
    const no = refusal(r);
    if (no) return no;
    const b = body(r);
    if (!b) return { status: 400, json: { ok: false, error: 'bad' } };
    try {
      return { json: { ok: true, ...(await f(b)) } };
    } catch (e) {
      if (e instanceof OpsError) return { status: 400, json: { ok: false, error: e.message } };
      throw e;
    }
  };
  return [
    ['POST', /^\/internal\/leads\/add$/, (r) => run(r, (b) => addLead(app, b))],
    ['POST', /^\/internal\/leads\/discover$/, (r) => run(r, (b) => discoverLeads(app, b))],
    ['GET', /^\/internal\/leads$/, async (r) => refusal(r) ?? { json: await leadsList(app, { where: r.url.searchParams.get('where') || '', q: (r.url.searchParams.get('q') || '').slice(0, 100), all: r.url.searchParams.get('all') === '1' }), headers: { 'cache-control': 'no-store' } }],
    ['GET', /^\/internal\/leads\/(\d{1,9})$/, async (r, m) => {
      const no = refusal(r);
      if (no) return no;
      const one = await leadOne(app, Number(m[1]));
      return one ? { json: one, headers: { 'cache-control': 'no-store' } } : { status: 404, json: { ok: false, error: 'אין ליד כזה' } };
    }],
    ['POST', /^\/internal\/leads\/(\d{1,9})\/([a-z-]{1,20})$/, async (r, m) => {
      const no = refusal(r);
      if (no) return no;
      const action = m[2] as Action;
      if (!ACTIONS.includes(action)) return { status: 404, json: { ok: false, error: 'אין פעולה כזו' } };
      let b: any = {};
      try {
        b = r.raw ? JSON.parse(r.raw) : {};
      } catch {
        return { status: 400, json: { ok: false, error: 'bad' } };
      }
      if (!b || typeof b !== 'object') return { status: 400, json: { ok: false, error: 'bad' } };
      if (!(await app.db.one(`SELECT 1 FROM stores WHERE id = $1 AND ${ONE_SQL}`, [Number(m[1])]))) return { status: 404, json: { ok: false, error: 'אין ליד כזה' } };
      try {
        return { json: { ok: true, ...(await leadDo(app, Number(m[1]), action, b)) } };
      } catch (e) {
        if (e instanceof OpsError) return { status: 400, json: { ok: false, error: e.message } };
        throw e;
      }
    }],
  ];
}
