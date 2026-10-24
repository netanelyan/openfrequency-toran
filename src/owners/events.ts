import { createHash } from 'node:crypto';
import type { App } from '../app.ts';
import { enqueue } from '../jobs/queue.ts';
import type { Part } from '../channels/send.ts';
import { ownersOf, type Owner } from './identity.ts';
import { pushToOwner, type Push } from './notify.ts';
import { platformsHe, readyMessage, sendBundle } from './posts.ts';
import { isPostId, tederClient, type TederPost } from './teder.ts';

// Teder's events (openfrequency-teder's docs/assistant-api.md, "Events") as messages to the workspace's owner
// numbers. The webhook (web/public.ts) checks the signature, keeps the event once in teder_events by its id and
// queues a teder_event job; the job runs here. Teder already held each event through the customer's quiet hours and
// Shabbat, and dropped the ones that stopped being true, so what arrives goes out (notify.ts checks the rest: the
// number, the consent, the limit, the 24 hours).
//
// A post.ready names one post, and a run makes several at once: they are gathered for READY_WAIT_MS, then the whole
// list of posts waiting goes as one numbered message (teder_ready), so "1" always means what the owner sees.

export const EVENT_TYPES = ['post.ready', 'post.reminder', 'post.published', 'post.unposted', 'quota.low', 'weekly.summary'] as const;
export type EventType = (typeof EVENT_TYPES)[number];
export type TederEvent = { id: string; type: EventType; workspace: number; at?: string; data: any };

export const READY_WAIT_MS = 90_000;
const toran = { name: 'תורן' };
const dayMonth = (d: string) => new Intl.DateTimeFormat('he-IL', { timeZone: 'Asia/Jerusalem', day: 'numeric', month: 'numeric' }).format(new Date(d));
const postsHe = (n: number) => (n === 1 ? 'מצגת אחת' : `${n} מצגות`);
const okPost = (p: any): p is TederPost => Boolean(p) && isPostId(p.id) && typeof p.coverLine === 'string';
/** Where a post waits to go up, in words: the platforms the owner posts it to by hand, else TikTok. */
const whereHe = (platforms: Record<string, string> | undefined) => {
  const hand = Object.entries(platforms || {}).filter(([, s]) => s === 'by_hand' || s === 'failed' || s === 'waiting').map(([p]) => p);
  return platformsHe(hand.length ? hand : ['tiktok']);
};

/** The message an event becomes, inside the window and as a template outside it; null for nothing to say. */
async function messageFor(app: App, ev: TederEvent): Promise<Omit<Push, 'eventId' | 'workspaceId' | 'kind'> | null> {
  const d = ev.data || {};
  if (ev.type === 'post.reminder' || ev.type === 'post.unposted' || ev.type === 'post.published') {
    const p = d.post;
    if (!okPost(p)) return null;
    const list = { items: [{ id: p.id, hook: p.coverLine }], source: ev.type };
    if (ev.type === 'post.published') {
      // Good news, inside the 24 hours only: there is no template for it, and it asks nothing of the owner.
      return { session: [{ text: `"${p.coverLine}" עלה${d.tiktokUrl ? `: ${d.tiktokUrl}` : '.'}` }], template: null };
    }
    const where = whereHe(d.platforms);
    if (ev.type === 'post.reminder') {
      const sound = d.sound?.name ? `, עם הצליל "${d.sound.name}"${d.sound.artist ? ` של ${d.sound.artist}` : ''}` : '';
      const text = d.delivery === 'drafts'
        ? `הגיע הזמן להעלות את "${p.coverLine}". היא מחכה לכם בטיוטות של טיקטוק${sound}.`
        : `הגיע הזמן להעלות את "${p.coverLine}" ל${where}. כתבו "שלח" ואשלח לכאן את התמונות ואת הכיתוב.`;
      return { session: [{ text }], template: { name: 'teder_post_reminder', vars: [p.coverLine, d.delivery === 'drafts' ? 'טיקטוק' : where] }, list };
    }
    // Unposted: the whole bundle at once inside the window, as Teder gives it; outside it, the template asks first.
    const b = await sendBundle({ app, teder: tederClient(app, ev.workspace, toran), workspaceId: ev.workspace, phone: '' }, 1, list.items[0]);
    if (!b.parts.length) throw new Error(`no bundle from Teder for post ${p.id}: ${b.lines.join(' ')}`);
    const session: Part[] = [{ text: `"${p.coverLine}" עוד לא עלה ל${where}. הנה הכול, מוכן להעלאה.` }, ...b.parts.slice(1)];
    return { session, template: { name: 'teder_post_unposted', vars: [p.coverLine, where] }, list };
  }
  if (ev.type === 'quota.low') {
    const s = d.quota?.suggestions;
    if (!s || !Number.isFinite(Number(s.left)) || !Number.isFinite(Number(s.limit))) return null;
    const left = `${s.left} מתוך ${s.limit} הצעות למצגות`;
    return { session: [{ text: `בתדר נשארו לכם החודש ${left}${d.account?.name ? ` בחשבון ${d.account.name}` : ''}. בתחילת החודש הבא המונה מתחיל מחדש.` }], template: { name: 'teder_quota_low', vars: [left] } };
  }
  if (ev.type === 'weekly.summary') {
    const accounts: any[] = Array.isArray(d.accounts) ? d.accounts : [];
    if (!accounts.length || !d.from || !d.to) return null;
    const span = `${dayMonth(d.from)} עד ${dayMonth(d.to)}`;
    const many = accounts.length > 1;
    const views = (a: any) => (a.week?.views != null ? `, עם ${Number(a.week.views).toLocaleString('he-IL')} צפיות` : '');
    const line = (a: any) => `${many ? `${a.account?.name}: ` : ''}עלו ${a.week?.published ?? 0} פוסטים${views(a)}.${a.week?.best?.coverLine ? ` הכי נצפה: "${a.week.best.coverLine}".` : ''}${a.quota?.suggestions ? ` נשארו ${a.quota.suggestions.left} מתוך ${a.quota.suggestions.limit} הצעות למצגות.` : ''}`;
    const total = accounts.reduce((n, a) => n + (Number(a.week?.published) || 0), 0);
    const seen = accounts.filter((a) => a.week?.views != null);
    const short = `עלו ${total} פוסטים${seen.length ? `, עם ${seen.reduce((n, a) => n + Number(a.week.views), 0).toLocaleString('he-IL')} צפיות` : ''}`;
    return { session: [{ text: [`הסיכום השבועי מתדר, ${span}:`, ...accounts.map(line)].join('\n') }], template: { name: 'teder_weekly_summary', vars: [span, short] } };
  }
  return null;
}

async function tederOwners(app: App, workspaceId: number): Promise<Owner[]> {
  const owners = await ownersOf(app, workspaceId);
  if (!owners) throw new Error("accounts did not answer for the workspace's numbers");
  return owners.filter((o) => o.products.includes('teder'));
}

async function pushAll(app: App, owners: Owner[], push: Push) {
  const out: Record<string, number> = {};
  for (const o of owners) {
    const r = await pushToOwner(app, o, push);
    out[r] = (out[r] || 0) + 1;
  }
  return { ...out, numbers: owners.length };
}

/** The teder_event job. */
export async function handleTederEvent(app: App, id: string): Promise<Record<string, unknown>> {
  const row = await app.db.one<{ id: string; type: EventType; workspace_id: number; at: string | null; data: any }>('SELECT id, type, workspace_id, at, data FROM teder_events WHERE id = $1', [id]);
  if (!row) return { skipped: 'no_event' };
  const ev: TederEvent = { id: row.id, type: row.type, workspace: row.workspace_id, at: row.at || undefined, data: row.data };
  if (ev.type === 'post.ready') {
    await enqueue(app.db, 'teder_ready', { workspace: ev.workspace }, { dedupeKey: `teder_ready:${ev.workspace}`, runAt: new Date(Date.now() + READY_WAIT_MS) });
    return { gathered: true };
  }
  const owners = await tederOwners(app, ev.workspace);
  if (!owners.length) return { sent: 0, numbers: 0 };
  const msg = await messageFor(app, ev);
  if (!msg) return { skipped: 'nothing_to_say' };
  return pushAll(app, owners, { kind: ev.type, eventId: ev.id, workspaceId: ev.workspace, ...msg });
}

/** The teder_ready job: every post waiting now, as one numbered list, once per list. */
export async function handleTederReady(app: App, workspaceId: number): Promise<Record<string, unknown>> {
  const owners = await tederOwners(app, workspaceId);
  if (!owners.length) return { sent: 0, numbers: 0 };
  const r = await tederClient(app, workspaceId, toran).pending();
  if (!r.ok) throw new Error(`no list of posts from Teder (${r.status} ${r.error})`);
  const posts = (r.body.posts || []).filter(okPost);
  if (!posts.length) return { skipped: 'nothing_waiting' };
  // The same list is never sent twice: its id is the posts it holds.
  const eventId = `ready:${workspaceId}:${createHash('sha256').update(posts.map((p) => p.id).join(',')).digest('hex').slice(0, 16)}`;
  return pushAll(app, owners, {
    kind: 'post.ready',
    eventId,
    workspaceId,
    session: readyMessage(posts),
    template: { name: 'teder_posts_ready', vars: [postsHe(posts.length)] },
    list: { items: posts.map((p) => ({ id: p.id, hook: p.coverLine })), source: 'post.ready' },
  });
}
