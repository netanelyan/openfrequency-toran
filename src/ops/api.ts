import { timingSafeEqual } from 'node:crypto';
import type { App } from '../app.ts';
import type { Out, Req, Route } from '../web/server.ts';
import { accountsLinks, ADMIN } from '../web/accounts.ts';
import { syncTeder } from './sources.ts';
import { conversations, queue, stuckRequests } from './queue.ts';
import { funnels } from './funnel.ts';
import { later, markLost, markReminded, markReplied, markSent, markWon, OpsError, reopen, sendDirect, setNext, type Kind } from './actions.ts';

// The operator's dashboard, as data for accounts' /admin, where it is shown (docs/operator.md section 4). Toran's
// own site shows Toran only; this is the work behind the dashboard: who to write to today, the conversations, the
// requests with nothing to send, the funnels, and the buttons' actions.
//
//   GET  /internal/ops                              everything the dashboard shows, in its order
//   POST /internal/ops/<toran|teder>/<id>/<action>  one button: sent, reminded, direct, replied, next, later, lost,
//                                                    reopen, pilot, paid, won
//
// From this machine only, with OF_INTERNAL_TOKEN and no X-Forwarded-For, like /internal/lead.

function local(app: App, r: Req): boolean {
  const token = String(app.env.OF_INTERNAL_TOKEN || '').trim();
  if (token.length < 32 || r.req.headers['x-forwarded-for']) return false;
  if (!/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(r.req.socket.remoteAddress || '')) return false;
  const got = Buffer.from(String(r.req.headers.authorization || ''));
  const want = Buffer.from(`Bearer ${token}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

/** A lead's page, where the operator opens it: Toran's dashboard under accounts' /admin (web/server.ts, ADMIN). */
const leadUrl = (app: App, id: number | string | null) => (id == null ? null : `${accountsLinks(app.env).home}${ADMIN}/lead/${id}`);

const ACTIONS = ['sent', 'reminded', 'direct', 'replied', 'next', 'later', 'lost', 'reopen', 'pilot', 'paid', 'won'] as const;
const SAID: Record<(typeof ACTIONS)[number], string> = {
  sent: 'סומן שנשלח. התזכורת האחת תחכה ברשימה בעוד ארבעה ימים.',
  reminded: 'סומן. זו הייתה ההודעה האחרונה אליהם, אלא אם יכתבו.',
  direct: 'נשלח מהמספר של הדמו, וסומן שנשלח.',
  replied: 'עבר ל"בשיחה". הצעד הבא נקבע למחר, ואפשר לשנות אותו שם.',
  next: 'הצעד הבא נשמר.',
  later: 'יחזור לרשימה בזמן שבחרת.',
  lost: 'סומן שלא מעוניינים. לא נכתוב להם יותר.',
  reopen: 'חזר לרשימה.',
  pilot: 'סומן שהתחילו פיילוט.',
  paid: 'סומן שמשלמים.',
  won: 'סומן כלקוח.',
};

export async function opsData(app: App) {
  const ok = await syncTeder(app);
  const [q, convs, stuck, f] = await Promise.all([queue(app), conversations(app), stuckRequests(app), funnels(app, null)]);
  // The last stage, customers, is accounts' word: it fills it from its subscriptions.
  for (const s of [...f.toran, ...f.teder]) if (s.key === 'customers') Object.assign(s, { all: null, month: null });
  return {
    teder: { ok },
    items: q.items.map((i) => ({ ...i, leadUrl: i.product === 'toran' ? leadUrl(app, i.id) : null })),
    noContact: q.noContact.map((s) => ({ id: s.id, name: s.brand?.name || s.name || s.domain, domain: s.domain, score: s.score, leadUrl: leadUrl(app, s.id) })),
    stuck: stuck.map((s) => ({ ...s, leadUrl: leadUrl(app, s.storeId) })),
    conversations: convs.map((c) => ({ ...c, leadUrl: c.product === 'toran' ? leadUrl(app, c.id) : null })),
    funnels: f,
  };
}

export function opsRoutes(app: App): Route<Req>[] {
  const refuse: Out = { status: 403, json: { ok: false, error: 'forbidden' } };
  return [
    ['GET', /^\/internal\/ops$/, async (r) => (local(app, r) ? { json: await opsData(app), headers: { 'cache-control': 'no-store' } } : refuse)],
    ['POST', /^\/internal\/ops\/(toran|teder)\/([\w.:%-]{1,100})\/([a-z]+)$/, async (r, m) => {
      if (!local(app, r)) return refuse;
      const kind = m[1] as Kind;
      const id = decodeURIComponent(m[2]);
      const what = m[3] as (typeof ACTIONS)[number];
      if (!ACTIONS.includes(what)) return { status: 404, json: { ok: false, error: 'אין פעולה כזו' } };
      let b: any = {};
      try {
        b = r.raw ? JSON.parse(r.raw) : {};
      } catch {
        return { status: 400, json: { ok: false, error: 'bad' } };
      }
      const by = String(b.by || 'operator').slice(0, 120);
      try {
        if (what === 'sent') await markSent(app, kind, id, by);
        else if (what === 'reminded') await markReminded(app, kind, id, by);
        else if (what === 'direct') {
          if (kind !== 'toran') throw new OpsError('אפשר לשלוח מהמספר של הדמו רק את תורן');
          await sendDirect(app, id, by);
        } else if (what === 'replied') await markReplied(app, kind, id, by);
        else if (what === 'next') await setNext(app, kind, id, String(b.text || ''), Number(b.days) || 1, by);
        else if (what === 'later') await later(app, kind, id, Number(b.days) || 1, by);
        else if (what === 'lost') await markLost(app, kind, id, String(b.reason || ''), by);
        else if (what === 'reopen') await reopen(app, kind, id, by);
        else if (what === 'pilot' || what === 'paid') {
          if (kind !== 'toran') throw new OpsError('פיילוט ותשלום נרשמים כך רק לתורן');
          await markWon(app, kind, id, what, by);
        } else {
          if (kind !== 'teder') throw new OpsError('לקוח של תורן נרשם בפיילוט או בתשלום');
          await markWon(app, kind, id, 'paid', by);
        }
      } catch (e) {
        if (e instanceof OpsError) return { status: 400, json: { ok: false, error: e.message } };
        throw e;
      }
      return { json: { ok: true, message: SAID[what] } };
    }],
  ];
}
