import type { App } from '../app.ts';
import { enqueue } from '../jobs/queue.ts';
import type { Part } from '../channels/send.ts';
import { ownersOf } from './identity.ts';
import { pushToOwner, recordDeferred, type Push } from './notify.ts';
import { HINT_MANY, HINT_ONE, numbered, platformHe, sendBundle } from './posts.ts';
import { tederClient, type TederPost } from './teder.ts';

// Teder's events (docs/owner-line.md section 2) as messages to the workspace's owner numbers. The webhook
// (web/public.ts) checks the signature, keeps the event once in teder_events and queues a teder_event job; the job
// runs here:
//
//   1. the workspace's verified numbers, from accounts (no answer: the job fails and is retried)
//   2. Teder's quiet time now (no answer: the same). Quiet: every number gets a 'deferred' row and the job is queued
//      again for the end of it
//   3. the message, made from the event's own data (and, for an unposted post, the bundle Teder gives for it)
//   4. pushToOwner() for each number, which checks the rest (notify.ts)

export const EVENT_TYPES = ['post.ready', 'post.reminder', 'post.unposted', 'quota.low', 'weekly.summary'] as const;
export type EventType = (typeof EVENT_TYPES)[number];
export type TederEvent = { id: string; type: EventType; workspace: number; at?: string; data: any };

const KIND_HE: Record<string, string> = { suggested: 'הצעות לפוסטים', redos: 'כתיבות מחדש' };
const dayMonth = (d: string) => {
  const m = /^\d{4}-(\d{2})-(\d{2})/.exec(String(d || ''));
  return m ? `${Number(m[2])}.${Number(m[1])}` : String(d || '');
};
const postsHe = (n: number) => (n === 1 ? 'מצגת חדשה אחת' : `${n} מצגות חדשות`);

/** The message an event becomes, inside the window and as a template outside it. */
async function messageFor(app: App, ev: TederEvent): Promise<Omit<Push, 'eventId' | 'workspaceId' | 'kind'> | null> {
  const d = ev.data || {};
  if (ev.type === 'post.ready') {
    const posts: TederPost[] = (Array.isArray(d.posts) ? d.posts : []).filter((p: any) => Number.isInteger(p?.id) && typeof p?.hook === 'string');
    if (!posts.length) return null;
    const head = posts.length === 1 ? 'מצגת חדשה אחת מוכנה לאישור:' : `${posts.length} מצגות חדשות מוכנות לאישור:`;
    return {
      session: numbered(posts, head, posts.length === 1 ? HINT_ONE : HINT_MANY),
      template: { name: 'teder_posts_ready', vars: [postsHe(posts.length)] },
      list: { items: posts.map((p) => ({ id: p.id, hook: p.hook })), source: 'post.ready' },
    };
  }
  if (ev.type === 'post.reminder' || ev.type === 'post.unposted') {
    const p: TederPost | undefined = d.post;
    if (!p || !Number.isInteger(p.id) || typeof p.hook !== 'string') return null;
    const where = platformHe(String(d.platform || 'instagram'));
    const list = { items: [{ id: p.id, hook: p.hook }], source: ev.type };
    if (ev.type === 'post.reminder') {
      return { session: [{ text: `הגיע הזמן להעלות את "${p.hook}" ל${where}. כתבו "שלח" ואשלח לכאן את התמונות ואת הכיתוב.` }], template: { name: 'teder_post_reminder', vars: [p.hook, where] }, list };
    }
    // Unposted: the whole bundle at once inside the window, as Teder gives it; outside it, the template asks first.
    const b = await sendBundle({ app, teder: tederClient(app, ev.workspace, 'toran'), workspaceId: ev.workspace, phone: '' }, 1, list.items[0]);
    if (!b.parts.length) throw new Error(`no bundle from Teder for post ${p.id}: ${b.lines.join(' ')}`);
    const session: Part[] = [{ text: `"${p.hook}" עוד לא עלה ל${where}. הנה הכול, מוכן להעלאה.` }, ...b.parts.slice(1)];
    return { session, template: { name: 'teder_post_unposted', vars: [p.hook, where] }, list };
  }
  if (ev.type === 'quota.low') {
    const used = Number(d.used);
    const limit = Number(d.limit);
    if (!Number.isFinite(used) || !Number.isFinite(limit) || !KIND_HE[d.kind]) return null;
    const left = `${Math.max(0, limit - used)} מתוך ${limit} ${KIND_HE[d.kind]}`;
    return { session: [{ text: `בטדר נשארו לכם החודש ${left}. בתחילת החודש הבא המונה מתחיל מחדש.` }], template: { name: 'teder_quota_low', vars: [left] } };
  }
  if (ev.type === 'weekly.summary') {
    const n = (k: string) => (Number.isFinite(Number(d[k])) ? Number(d[k]) : null);
    if ([n('made'), n('approved'), n('published')].some((x) => x == null)) return null;
    const span = `${dayMonth(d.from)} עד ${dayMonth(d.to)}`;
    const lines = [`הסיכום השבועי מטדר, ${span}:`, `נוצרו ${n('made')} פוסטים. אישרתם ${n('approved')}${n('rejected') != null ? ` ודחיתם ${n('rejected')}` : ''}.`, `עלו ${n('published')}.${n('pending') ? ` ${n('pending') === 1 ? 'מצגת אחת מחכה' : `${n('pending')} מצגות מחכות`} לאישור.` : ''}`];
    return { session: [{ text: lines.join('\n') }], template: { name: 'teder_weekly_summary', vars: [span, String(n('made')), String(n('approved')), String(n('published'))] } };
  }
  return null;
}

/** The teder_event job. */
export async function handleTederEvent(app: App, id: string): Promise<Record<string, unknown>> {
  const row = await app.db.one<{ id: string; type: EventType; workspace_id: number; at: string | null; data: any }>('SELECT id, type, workspace_id, at, data FROM teder_events WHERE id = $1', [id]);
  if (!row) return { skipped: 'no_event' };
  const ev: TederEvent = { id: row.id, type: row.type, workspace: row.workspace_id, at: row.at || undefined, data: row.data };
  const owners = await ownersOf(app, ev.workspace);
  if (!owners) throw new Error('accounts did not answer for the workspace\'s numbers');
  const withTeder = owners.filter((o) => o.products.includes('teder'));
  if (!withTeder.length) return { sent: 0, numbers: 0 };

  const st = await tederClient(app, ev.workspace, 'toran').status();
  if (!st.ok) throw new Error(`Teder did not say whether it is quiet now (${st.status} ${st.error})`);
  const msg = await messageFor(app, ev);
  if (!msg) return { skipped: 'nothing_to_say' };
  const push: Push = { kind: ev.type, eventId: ev.id, workspaceId: ev.workspace, ...msg };

  if (st.body.quiet?.now) {
    const until = st.body.quiet.until && new Date(st.body.quiet.until).getTime() > Date.now() ? new Date(st.body.quiet.until) : new Date(Date.now() + 60 * 60_000);
    for (const o of withTeder) await recordDeferred(app, push, o.phone, until.toISOString(), st.body.quiet.reason || 'quiet');
    await enqueue(app.db, 'teder_event', { id: ev.id }, { runAt: new Date(until.getTime() + 60_000), dedupeKey: `teder:${ev.id}:${until.getTime()}` });
    return { deferred: until.toISOString(), numbers: withTeder.length };
  }
  const out: Record<string, number> = {};
  for (const o of withTeder) {
    const r = await pushToOwner(app, o, push);
    out[r] = (out[r] || 0) + 1;
  }
  return { ...out, numbers: withTeder.length };
}
