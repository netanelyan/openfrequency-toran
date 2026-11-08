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
import { outreachFilled, outreachLive, templateOf } from './outreach.ts';
import { tederBuild, tederList, tederState, type TederLead } from './tederLeads.ts';

// The shared lead dashboard's data (the owner, 2026-11-08: "make the shared lead dashboard be in the admin dashboard,
// not in one of the products"). Accounts' /admin/leads shows one list for both products and one page a lead, and asks
// here, on this machine, with OF_INTERNAL_TOKEN (docs/contracts/admin-leads.json, accounts' own copy):
//
//   GET  /internal/leads?where=&q=        the list: Toran's stores that are leads, each with its Teder lead (by Toran's
//                                         id, else the domain), and Teder's leads Toran has no store for
//   GET  /internal/leads/<id>             one lead: both demos, which message is due and how it can go, the texts
//   POST /internal/leads/<id>/<action>    build-toran, build-teder, build-both, send-both, send-toran, send-teder,
//                                         mark-sent, mark-reminded, notes, skip
//
// The rest of a lead's buttons (they answered, the next step, later, not interested, a customer) are /internal/ops' own
// (ops/api.ts), which the dashboard already uses. Toran keeps the outreach and its rules (ops/outreach.ts, ops/both.ts):
// what does not go is said in the operator's words, and nothing is marked then. Approving a Toran page stays a look at
// it first, on Toran's own review page, which the lead links to.

export type Where = 'new' | 'ready' | 'sent' | 'talking' | 'closed';
export const WHERE: Where[] = ['new', 'ready', 'sent', 'talking', 'closed'];
type DemoState = 'none' | 'building' | 'review' | 'ready' | 'failed' | 'removed';
type Demo = { state: DemoState; pageUrl: string | null; sentAt: string | null; reminderSentAt: string | null; reminderDue: boolean; url: string | null; error: string | null };

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

/** Where the lead stands for both products together: what the list's tabs count. */
function whereOf(s: any | null, t: TederLead | null, toran: Demo, teder: Demo): Where {
  if ((s && (s.status === 'skipped' || s.status === 'paid' || s.taken_down_at)) || (t && ['joined', 'irrelevant'].includes(t.stage))) return 'closed';
  if ((s && (s.replied_at || s.status === 'pilot')) || t?.stage === 'replied') return 'talking';
  if (toran.sentAt || teder.sentAt) return 'sent';
  if (toran.state === 'ready' || teder.state === 'ready') return 'ready';
  return 'new';
}

function rowOf(app: App, s: any, t: TederLead | null, building: boolean) {
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
  const tLeads = 'error' in tl ? [] : tl.leads;
  const byToran = new Map(tLeads.filter((l) => l.toranId).map((l) => [String(l.toranId), l]));
  const byDomain = new Map(tLeads.map((l) => [keyOf(l.domain), l]));
  const run = await building(app, stores.map((s) => Number(s.id)));
  const used = new Set<number>();
  const rows = stores.map((s) => {
    const t = byToran.get(String(s.id)) || byDomain.get(keyOf(s.domain)) || null;
    if (t) used.add(t.id);
    return rowOf(app, s, t, run.has(Number(s.id)));
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
    teder: { ok: !('error' in tl) },
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
  const row = rowOf(app, s, t, run.has(id));
  const name = row.name;
  const pitchable = Boolean(s.contact_whatsapp) && (await outreachLive(app));
  const toranStage = row.toran.state === 'ready' && !s.sent_at ? 'first' : s.sent_at && !s.followup_sent_at && row.toran.reminderDue ? 'reminder' : null;
  const tederStage = t?.stage === 'demo_ready' && row.teder.state === 'ready' ? 'first' : t?.reminderDue ? 'reminder' : null;
  const options: ('both' | 'toran' | 'teder')[] = [];
  if (pitchable && toranStage && tederStage && toranStage === tederStage) options.push('both');
  if (pitchable && toranStage) options.push('toran');
  if (pitchable && tederStage) options.push('teder');
  const stage = toranStage || tederStage || null;
  const waiting = s.sent_at && !s.followup_sent_at && !row.toran.reminderDue && s.followup_due_at && !s.taken_down_at ? iso(s.followup_due_at) : null;
  const url = row.toran.pageUrl;
  const target = contactTarget(s);
  const copyText = !url ? null : !s.sent_at ? firstMessage({ storeName: name, url }) : !s.followup_sent_at ? reminderMessage({ storeName: name, url }) : null;
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
      build: {
        toran: canIngest(s.platform) && !s.taken_down_at,
        teder: !('error' in st) && (!t?.demo || ['removed', 'failed'].includes(t.demo.status)),
        both: canIngest(s.platform) && !s.page_built_at && !s.taken_down_at && !('error' in st) && !t?.demo,
        toranWhyNot: canIngest(s.platform) ? null : `תורן קורא כרגע רק חנויות ${INGESTIBLE_HE}.`,
      },
      send: {
        stage,
        pitchable,
        options,
        main: options[0] || null,
        waitingUntil: waiting,
        bothText: stage ? outreachFilled(templateOf('both', stage), [le(name)]) : null,
        toranText: copyText,
        copy: copyText && target.href ? { href: target.href, label: target.label } : null,
      },
      links: { toranPage: row.toran.url, toranReview: s.page_built_at ? `${row.toran.url}/review` : null, tederLead: t?.leadUrl || null },
    },
  };
}

const ACTIONS = ['build-toran', 'build-teder', 'build-both', 'send-both', 'send-toran', 'send-teder', 'mark-sent', 'mark-reminded', 'notes', 'skip'] as const;
type Action = (typeof ACTIONS)[number];

/** One button of the lead's page: the operator's line when done, OpsError with the reason when not. */
export async function leadAct(app: App, id: number, action: Action, b: { by?: unknown; notes?: unknown; reason?: unknown }): Promise<string> {
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
  switch (action) {
    case 'build-toran':
      await ingest();
      return s.page_built_at ? 'תורן קורא את האתר מחדש ובונה את הדף מחדש.' : 'תורן קורא את האתר ובונה את הדף. זה לוקח דקה או שתיים.';
    case 'build-teder':
      return `תדר: ${await teder()}`;
    case 'build-both': {
      const msg = await teder();
      await ingest();
      return `בונים את שניהם: תורן קורא את האתר ובונה את הדף, ותדר: ${msg}`;
    }
    case 'send-toran':
      return sendNow(app, 'toran', String(s.id), by);
    case 'send-teder':
      return sendTeder(app, s.id, by);
    case 'send-both':
      return sendBoth(app, s.id, by);
    case 'mark-sent':
      await markSent(app, 'toran', String(s.id), by);
      return 'סומן שנשלח. התזכורת האחת תחכה בעוד ארבעה ימים.';
    case 'mark-reminded':
      if (!s.sent_at) throw new OpsError('עוד לא נשלחה הודעה ראשונה.');
      if (s.followup_due_at && new Date(s.followup_due_at).getTime() > now()) throw new OpsError(NOT_NOW_REMINDER);
      await markReminded(app, 'toran', String(s.id), by);
      return 'התזכורת סומנה. זו הייתה האחרונה.';
    case 'notes':
      await app.db.query('UPDATE stores SET notes = $2, updated_at = now() WHERE id = $1', [s.id, String(b.notes ?? '').slice(0, 4000)]);
      return 'ההערות נשמרו.';
    case 'skip':
      await app.db.query("UPDATE stores SET status = 'skipped', skipped_at = now(), notes = CASE WHEN $2 <> '' THEN COALESCE(notes || E'\\n', '') || $2 ELSE notes END, updated_at = now() WHERE id = $1", [s.id, String(b.reason ?? '').slice(0, 300)]);
      await event(app.db, s.id, 'skipped', { reason: b.reason || null, by });
      await audit(app.db, { actor: by, action: 'skip', storeId: s.id, detail: { from: 'admin' } });
      return 'דילגת על החנות. היא לא תופיע יותר ברשימה של מי לכתוב לו.';
  }
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
        return { json: { ok: true, message: await leadAct(app, Number(m[1]), action, b) } };
      } catch (e) {
        if (e instanceof OpsError) return { status: 400, json: { ok: false, error: e.message } };
        throw e;
      }
    }],
  ];
}
