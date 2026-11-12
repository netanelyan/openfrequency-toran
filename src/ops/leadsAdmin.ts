import type { App } from '../app.ts';
import type { Out, Req, Route } from '../web/server.ts';
import { displayName } from '../ingest/brand.ts';
import { audit, event } from '../db/log.ts';
import { enqueue } from '../jobs/queue.ts';
import { now } from '../core/clock.ts';
import { canIngest, INGESTIBLE_HE } from '../ingest/catalogue.ts';
import { contactTarget, firstMessage, le, pitchUrl, reminderMessage } from '../outreach.ts';
import { pageStats } from '../pitch/track.ts';
import { selling } from '../web/workspace.ts';
import { accountsLinks, ADMIN } from '../web/accounts.ts';
import { internalRefusal } from './internal.ts';
import { markReminded, markSent, OpsError, sendNow } from './actions.ts';
import { sendBoth, sendTeder } from './both.ts';
import { bothFirst, bothReminder, tederColdFirst, tederReminder } from './messages.ts';
import { outreachFilled, outreachLive, templateOf } from './outreach.ts';
import { tederBuild, tederList, tederMark, tederState, type TederLead } from './tederLeads.ts';

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
type Demo = { state: DemoState; pageUrl: string | null; sentAt: string | null; reminderSentAt: string | null; reminderDue: boolean; url: string | null; error: string | null };
/** A lead's demos as the operator picks them: Toran's, Teder's, or both in one message. */
type Product = 'both' | 'toran' | 'teder';
const PRODUCTS: Product[] = ['both', 'toran', 'teder'];
const productOf = (v: unknown): Product | null => (PRODUCTS.includes(v as Product) ? (v as Product) : null);
type Stage = 'first' | 'reminder';

const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
const toranPage = (app: App, id: number) => `${accountsLinks(app.env).home}${ADMIN}/lead/${id}`;

function toranDemo(app: App, s: any, building: boolean): Demo {
  const due = s.sent_at && !s.followup_sent_at && ['sent', 'opened', 'demo_started'].includes(s.status) && s.followup_due_at && new Date(s.followup_due_at).getTime() <= now();
  const state: DemoState = s.taken_down_at ? 'removed' : !s.page_built_at ? (building ? 'building' : 'none') : !s.approved_at ? 'review' : 'ready';
  return {
    state,
    pageUrl: s.page_built_at && s.slug ? pitchUrl(app.env, s.slug) : null,
    sentAt: iso(s.sent_at),
    reminderSentAt: iso(s.followup_sent_at),
    reminderDue: Boolean(due),
    url: toranPage(app, s.id),
    error: null,
  };
}

function tederDemo(l: TederLead | null): Demo {
  const d = l?.demo;
  const state: DemoState = !d ? 'none' : d.status === 'removed' ? 'removed' : d.status === 'failed' ? 'failed' : d.pageUrl ? 'ready' : d.building || ['new', 'building'].includes(d.status) ? 'building' : 'review';
  return { state, pageUrl: d?.pageUrl || null, sentAt: l?.sentAt || null, reminderSentAt: l?.reminderSentAt || null, reminderDue: Boolean(l?.reminderDue), url: d?.reviewUrl || l?.leadUrl || null, error: d?.error || null };
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
  if ((s && (s.status === 'skipped' || s.status === 'paid' || s.taken_down_at)) || (t && ['joined', 'irrelevant'].includes(t.stage))) return 'closed';
  if ((s && (s.replied_at || s.status === 'pilot')) || t?.stage === 'replied') return 'talking';
  if (toran.sentAt || teder.sentAt) return 'sent';
  if (toran.state === 'ready' || teder.state === 'ready') return 'ready';
  return 'new';
}

function rowOf(app: App, s: any, t: TederLead | null, building: boolean, tederOk: boolean) {
  const toran = toranDemo(app, s, building);
  const teder = tederDemo(t);
  return {
    id: Number(s.id),
    name: displayName(s.brand_override?.name, s.brand?.name, s.name) || s.domain,
    domain: s.domain,
    url: s.url,
    platform: s.platform || null,
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

const LEADS_SQL = `${selling()} AND status <> 'company' AND (qualified OR page_built_at IS NOT NULL OR sent_at IS NOT NULL)`;

async function building(app: App, ids: number[]): Promise<Set<number>> {
  if (!ids.length) return new Set();
  const rows = await app.db.query<{ id: number }>("SELECT (payload->>'storeId')::int AS id FROM jobs WHERE kind = 'ingest' AND status IN ('queued', 'running') AND (payload->>'storeId')::int = ANY($1::int[])", [ids]);
  return new Set(rows.map((r) => Number(r.id)));
}

const keyOf = (d: string) => String(d || '').toLowerCase().replace(/^www\./, '');

/** The list, both products together, with how many stand where. */
export async function leadsList(app: App, { where = '', q = '' }: { where?: string; q?: string } = {}) {
  const stores = await app.db.query<any>(`SELECT * FROM stores WHERE ${LEADS_SQL} ORDER BY updated_at DESC NULLS LAST, score DESC LIMIT 1000`);
  const tl = await tederList(app);
  const tederOk = !('error' in tl);
  const tLeads = 'error' in tl ? [] : tl.leads;
  const byToran = new Map(tLeads.filter((l) => l.toranId).map((l) => [String(l.toranId), l]));
  const byDomain = new Map(tLeads.map((l) => [keyOf(l.domain), l]));
  const run = await building(app, stores.map((s) => Number(s.id)));
  const used = new Set<number>();
  const rows = stores.map((s) => {
    const t = byToran.get(String(s.id)) || byDomain.get(keyOf(s.domain)) || null;
    if (t) used.add(t.id);
    return rowOf(app, s, t, run.has(Number(s.id)), tederOk);
  });
  const tederOnly = tLeads
    .filter((l) => !used.has(l.id))
    .map((l) => {
      const teder = tederDemo(l);
      return { tederId: l.id, name: l.name || l.domain, domain: l.domain, where: whereOf(null, l, toranDemo(app, { id: 0 }, false), teder), teder, leadUrl: l.leadUrl };
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
  };
}

const NOT_NOW_REMINDER = 'עוד לא הזמן לתזכורת.';

/** One lead: both demos, the message due and the ways it can go, the texts, and what can be built. */
export async function leadOne(app: App, id: number) {
  const s = await app.db.one<any>(`SELECT * FROM stores WHERE id = $1 AND ${LEADS_SQL}`, [id]);
  if (!s) return null;
  const st = await tederState(app, s);
  const t = 'error' in st ? null : st.lead;
  const run = await building(app, [id]);
  const row = rowOf(app, s, t, run.has(id), !('error' in st));
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
      demoStartedAt: iso(s.demo_started_at),
      tederOk: !('error' in st),
      send: {
        stage,
        pitchable,
        options,
        main: options[0] || null,
        waitingUntil: waiting,
        ...texts,
        copy: Object.values(texts).some(Boolean) && href ? { href, label: target.label } : null,
      },
      links: { toranPage: row.toran.url, toranReview: s.page_built_at ? `${row.toran.url}/review` : null, tederLead: t?.leadUrl || null },
    },
  };
}

const ACTIONS = ['go-both', 'go-toran', 'go-teder', 'build-toran', 'build-teder', 'build-both', 'send-both', 'send-toran', 'send-teder', 'mark-sent', 'mark-reminded', 'notes', 'skip'] as const;
type Action = (typeof ACTIONS)[number];

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
export async function leadAct(app: App, id: number, action: Action, b: { by?: unknown; notes?: unknown; reason?: unknown; product?: unknown }): Promise<string> {
  return (await leadDo(app, id, action, b)).message;
}

/** leadAct's line, and for going on with a product whether its message can go now. */
export async function leadDo(app: App, id: number, action: Action, b: { by?: unknown; notes?: unknown; reason?: unknown; product?: unknown }): Promise<{ message: string; ready?: boolean }> {
  const said = (message: string) => ({ message });
  const s = await app.db.one<any>(`SELECT * FROM stores WHERE id = $1 AND ${LEADS_SQL}`, [id]);
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
      await app.db.query("UPDATE stores SET status = 'skipped', skipped_at = now(), notes = CASE WHEN $2 <> '' THEN COALESCE(notes || E'\\n', '') || $2 ELSE notes END, updated_at = now() WHERE id = $1", [s.id, String(b.reason ?? '').slice(0, 300)]);
      await event(app.db, s.id, 'skipped', { reason: b.reason || null, by });
      await audit(app.db, { actor: by, action: 'skip', storeId: s.id, detail: { from: 'admin' } });
      return said('דילגת על החנות. היא לא תופיע יותר ברשימה של מי לכתוב לו.');
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

export function leadsAdminRoutes(app: App): Route<Req>[] {
  const refusal = (r: Req): Out | null => internalRefusal(app, r);
  return [
    ['GET', /^\/internal\/leads$/, async (r) => refusal(r) ?? { json: await leadsList(app, { where: r.url.searchParams.get('where') || '', q: (r.url.searchParams.get('q') || '').slice(0, 100) }), headers: { 'cache-control': 'no-store' } }],
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
      if (!(await app.db.one(`SELECT 1 FROM stores WHERE id = $1 AND ${LEADS_SQL}`, [Number(m[1])]))) return { status: 404, json: { ok: false, error: 'אין ליד כזה' } };
      try {
        return { json: { ok: true, ...(await leadDo(app, Number(m[1]), action, b)) } };
      } catch (e) {
        if (e instanceof OpsError) return { status: 400, json: { ok: false, error: e.message } };
        throw e;
      }
    }],
  ];
}
