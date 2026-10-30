import { timingSafeEqual } from 'node:crypto';
import type { App } from '../app.ts';
import type { Out, Req, Route } from '../web/server.ts';
import { accountsLinks, ADMIN } from '../web/accounts.ts';
import { syncTeder, tederUrl } from './sources.ts';
import { conversations, queue, RECONNECT_AGAIN_DAYS, stuckRequests, tederDemos } from './queue.ts';
import { funnels } from './funnel.ts';
import { demoLine, oneNumberRoles, ROLE_HE } from '../channels/lines.ts';
import { later, markLost, markReconnectTold, markReminded, markReplied, markSent, markWon, OpsError, reopen, sendDirect, sendTederDirect, setNext, type Kind } from './actions.ts';
import { queueState } from '../jobs/queue.ts';

// The operator's dashboard, as data for accounts' /admin, where it is shown (docs/operator.md section 4). Toran's
// own site shows Toran only; this is the work behind the dashboard: who to write to today, the conversations, the
// requests with nothing to send, the funnels, and the buttons' actions.
//
//   GET  /internal/ops                              everything the dashboard shows, in its order
//   POST /internal/ops/<toran|teder>/<id>/<action>  one button: sent, reminded, direct, replied, next, later, lost,
//                                                    reopen, pilot, paid, won
//
// From this machine only, with OF_INTERNAL_TOKEN and no X-Forwarded-For, like /internal/lead.

/** The caller is accounts (or Teder) on this machine: the shared token, a loopback socket, and not through Caddy. */
export function local(app: App, r: Req): boolean {
  const token = String(app.env.OF_INTERNAL_TOKEN || '').trim();
  if (token.length < 32 || r.req.headers['x-forwarded-for']) return false;
  if (!/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(r.req.socket.remoteAddress || '')) return false;
  const got = Buffer.from(String(r.req.headers.authorization || ''));
  const want = Buffer.from(`Bearer ${token}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

/**
 * Why an internal call from accounts is refused, as accounts' contracts say it (test/fixtures/contracts: setup.json,
 * toran-ops.json, workspaces-delete.json; Teder answers the same): 503 not_configured when OF_INTERNAL_TOKEN is not set
 * here, 403 forbidden when the call is not from this machine or came through Caddy, 401 bad_token when the bearer is
 * missing or wrong. Null when it may go on.
 */
export function internalRefusal(app: App, r: Req): Out | null {
  const token = String(app.env.OF_INTERNAL_TOKEN || '').trim();
  if (token.length < 32) return { status: 503, json: { error: 'not_configured' } };
  if (r.req.headers['x-forwarded-for'] || !/^(127.0.0.1|::1|::ffff:127.0.0.1)$/.test(r.req.socket.remoteAddress || '')) return { status: 403, json: { error: 'forbidden' } };
  const got = Buffer.from(String(r.req.headers.authorization || ''));
  const want = Buffer.from(`Bearer ${token}`);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { status: 401, json: { error: 'bad_token' } };
  return null;
}

/** A lead's page, where the operator opens it: Toran's dashboard under accounts' /admin (web/server.ts, ADMIN). */
const leadUrl = (app: App, id: number | string | null) => (id == null ? null : `${accountsLinks(app.env).home}${ADMIN}/lead/${id}`);
/** A Teder demo's page, where the operator opens it: Teder's own /demos/<id>, on its public address (TEDER_URL). */
const tederDemoUrl = (app: App, id: string) => `${tederUrl(app.env)}/demos/${encodeURIComponent(id)}`;

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
const TOLD = `סומן שאמרת להם לחבר מחדש את הוואטסאפ. אם עוד לא יחברו, זה יחזור לרשימה בעוד ${RECONNECT_AGAIN_DAYS} ימים.`;

export async function opsData(app: App) {
  const ok = await syncTeder(app);
  const [q, convs, stuck, f, one, line, teder] = await Promise.all([queue(app), conversations(app), stuckRequests(app), funnels(app, null), oneNumberRoles(app), demoLine(app), tederDemos(app)]);
  // The last stage, customers, is accounts' word: it fills it from its subscriptions.
  for (const s of [...f.toran, ...f.teder]) if (s.key === 'customers') Object.assign(s, { all: null, month: null });
  return {
    teder: { ok },
    items: q.items.map((i) => ({ ...i, leadUrl: i.product === 'toran' ? leadUrl(app, i.id) : null })),
    noContact: q.noContact.map((s) => ({ id: s.id, name: s.brand?.name || s.name || s.domain, domain: s.domain, score: s.score, leadUrl: leadUrl(app, s.id) })),
    // A Teder request links to its demo in Teder, once Teder took it.
    stuck: stuck.map(({ tederId, ...s }) => ({ ...s, leadUrl: s.storeId != null ? leadUrl(app, s.storeId) : tederId ? tederDemoUrl(app, tederId) : null })),
    // Every Teder demo not up yet, each linking to its page in Teder (queue.ts tederDemos).
    tederDemos: teder.map((d) => ({ ...d, leadUrl: tederDemoUrl(app, d.id) })),
    conversations: convs.map((c) => ({ ...c, leadUrl: c.product === 'toran' ? leadUrl(app, c.id) : null })),
    funnels: f,
    // Our one WhatsApp number (channels/lines.ts) and what it does now, in the order its messages are read; null
    // until our company store connects it.
    ourNumber: one ? { number: one.one.number, status: one.one.status, roles: one.roles.map((key) => ({ key, he: ROLE_HE[key] })), leadUrl: leadUrl(app, one.one.storeId) } : null,
    // The demo number as it sends now (channels/lines.ts demoLine): through Meta, Twilio or the simulator, and whether
    // that reaches anyone. Not live (the simulator on the VPS): nothing goes from it, and the links that go by
    // themselves wait.
    demoLine: { live: line.live, via: line.via, number: line.number },
    // The job queue (web/pages/queue.ts): what waits, how long the oldest customer message has waited, what failed.
    jobs: await queueState(app.db).then((s) => ({ queued: s.queued, running: s.running, messages: s.messages, oldestAt: s.oldestAt, failed: s.failed.length, url: `${accountsLinks(app.env).home}${ADMIN}/queue` })),
  };
}

export function opsRoutes(app: App): Route<Req>[] {
  return [
    ['GET', /^\/internal\/ops$/, async (r) => internalRefusal(app, r) ?? { json: await opsData(app), headers: { 'cache-control': 'no-store' } }],
    ['POST', /^\/internal\/ops\/(toran|teder)\/([\w.:%-]{1,100})\/([a-z]+)$/, async (r, m) => {
      const no = internalRefusal(app, r);
      if (no) return no;
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
      let said: string = SAID[what];
      try {
        if (what === 'sent' && kind === 'toran' && (await markReconnectTold(app, id, by))) said = TOLD;
        else if (what === 'sent') await markSent(app, kind, id, by);
        else if (what === 'reminded') await markReminded(app, kind, id, by);
        else if (what === 'direct') await (kind === 'toran' ? sendDirect(app, id, by) : sendTederDirect(app, id, by));
        else if (what === 'replied') await markReplied(app, kind, id, by);
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
      return { json: { ok: true, message: said } };
    }],
  ];
}
