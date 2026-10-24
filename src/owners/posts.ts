import type { App } from '../app.ts';
import { audit } from '../db/log.ts';
import type { Part } from '../channels/send.ts';
import type { Intent } from './intents.ts';
import { keepList } from './notify.ts';
import { coverOf, editField, type PostId, type TederClient, type TederPost, type TederStatus } from './teder.ts';

// What the owner line does with Teder's posts, for the reader in code (line.ts) and for the model's tools
// (assistant/index.ts) alike: show the posts waiting, act on numbered ones, send one ready to post, say the status.
// Every line about a post is made from what Teder answered: its cover line, its images, its caption, its own words
// when it refuses an edit. Every action is in the audit, with the owner's number as the actor (Teder records the
// person too).

export type PostsCtx = { app: App; teder: TederClient; workspaceId: number; phone: string };
export type ListItem = { id: PostId; hook: string };
export type Done = { lines: string[]; parts: Part[] };

/** The list the owner last saw (the last 7 days), or null. */
export async function lastList(app: App, phone: string, workspaceId: number): Promise<{ items: ListItem[]; source: string; at: string } | null> {
  const r = await app.db.one<{ items: ListItem[]; source: string; created_at: string }>("SELECT items, source, created_at FROM owner_lists WHERE phone = $1 AND workspace_id = $2 AND created_at > now() - interval '7 days' ORDER BY id DESC LIMIT 1", [phone, workspaceId]);
  return r ? { items: r.items, source: r.source, at: r.created_at } : null;
}

/** "1", "1 ו-3", "1, 2 ו-4". */
export const andList = (ns: (number | string)[]) => (ns.length < 2 ? String(ns[0] ?? '') : `${ns.slice(0, -1).join(', ')} ו-${ns[ns.length - 1]}`);

const PLATFORM_HE: Record<string, string> = { tiktok: 'טיקטוק', instagram: 'אינסטגרם', facebook: 'פייסבוק' };
export const platformHe = (p: string) => PLATFORM_HE[p] || p;
/** "טיקטוק", "טיקטוק ואינסטגרם". */
export const platformsHe = (ps: string[]) => andList(ps.map(platformHe)).replace(' ו-', ' ו');

/** The posts as a numbered message: a line, then each cover with its number and cover line. */
export function numbered(posts: TederPost[], head: string, hint: string | null): Part[] {
  const parts: Part[] = [{ text: head }];
  posts.forEach((p, i) => {
    const cover = coverOf(p);
    parts.push(cover ? { media: cover, caption: `${i + 1}. ${p.coverLine}` } : { text: `${i + 1}. ${p.coverLine}` });
  });
  if (hint) parts.push({ text: hint });
  return parts;
}

export const HINT_MANY = 'אפשר לענות לי במילים שלכם, למשל: אשר את 1 ו-3, את 2 תעשה קצר יותר.';
export const HINT_ONE = 'כדי לאשר כתבו "אשר", או כתבו לי מה לשנות.';
export const UNREACHABLE = 'לא הצלחתי להגיע לתדר כרגע, אז לא שיניתי כלום. נסו שוב עוד כמה דקות.';
const headOf = (n: number) => (n === 1 ? 'מצגת אחת מחכה לאישור:' : `${n} מצגות מחכות לאישור:`);

/** The posts waiting for approval, now, numbered and kept as the owner's list. */
export async function showPending(c: PostsCtx): Promise<Done & { posts: TederPost[] | null }> {
  const r = await c.teder.pending();
  if (!r.ok) return { lines: [UNREACHABLE], parts: [], posts: null };
  const posts = r.body.posts || [];
  if (!posts.length) return { lines: ['אין כרגע מצגות שמחכות לאישור.'], parts: [], posts };
  await keepList(c.app, c.phone, c.workspaceId, posts.map((p) => ({ id: p.id, hook: p.coverLine })), 'asked');
  return { lines: [], parts: numbered(posts, headOf(posts.length), posts.length === 1 ? HINT_ONE : HINT_MANY), posts };
}

/** The numbered list as a message Toran starts (a post is ready): the same parts, for notify.ts. */
export const readyMessage = (posts: TederPost[]) => numbered(posts, posts.length === 1 ? 'מצגת חדשה מוכנה לאישור:' : `${posts.length} מצגות מוכנות לאישור:`, posts.length === 1 ? HINT_ONE : HINT_MANY);

/** One post's images and the text to copy, the way it goes up: Instagram's set when there is one, else the first. */
export async function sendBundle(c: PostsCtx, n: number, item: ListItem): Promise<Done> {
  const r = await c.teder.bundle(item.id);
  if (!r.ok) {
    const why = r.status === 409 ? `את ${n} עוד אי אפשר לשלוח, היא עוד לא אושרה.` : r.status === 404 ? `את ${n} לא מצאתי בתדר.` : UNREACHABLE;
    return { lines: [why], parts: [] };
  }
  if (c.phone) await audit(c.app.db, { actor: `wa:${c.phone}`, action: 'teder_bundle', detail: { workspace: c.workspaceId, post: item.id } });
  const platforms = r.body.post?.platforms || {};
  const key = platforms.instagram ? 'instagram' : Object.keys(platforms)[0];
  const set = key ? platforms[key] : null;
  if (!set) return { lines: [`את ${n} לא מצאתי מוכנה להעלאה.`], parts: [] };
  const images = set.images || [];
  return {
    lines: [],
    parts: [
      { text: `"${r.body.post.coverLine || item.hook}", מוכן להעלאה ל${platformHe(key)}: ${images.length === 1 ? 'תמונה אחת' : `${images.length} תמונות`} לפי הסדר, ואחריהן הכיתוב להעתקה.` },
      ...images.map((url, i) => ({ media: url, caption: `${i + 1}/${images.length}` })),
      ...(set.text ? [{ text: set.text }] : []),
    ],
  };
}

/** The status in the owner's words, from Teder's numbers only: what waits, the week, the month's quota. */
export function statusLines(s: TederStatus, pending: number | null): string[] {
  const out: string[] = [];
  if (pending != null) out.push(pending ? (pending === 1 ? 'בתדר מחכה לאישור שלכם מצגת אחת.' : `בתדר מחכות לאישור שלכם ${pending} מצגות.`) : 'בתדר אין מצגות שמחכות לאישור.');
  const many = (s.accounts || []).length > 1;
  for (const a of s.accounts || []) {
    const who = many ? `${a.account.name}: ` : '';
    const views = a.week?.views != null ? `, עם ${a.week.views.toLocaleString('he-IL')} צפיות` : '';
    out.push(`${who}השבוע עלו ${a.week?.published ?? 0} פוסטים${views}.`);
    if (a.quota) out.push(`${many ? `${a.account.name}: ` : ''}החודש נשארו ${a.quota.suggestions.left} מתוך ${a.quota.suggestions.limit} הצעות למצגות, ו-${a.quota.redos.left} מתוך ${a.quota.redos.limit} כתיבות מחדש.`);
  }
  return out;
}

export async function status(c: PostsCtx): Promise<Done> {
  const [s, p] = await Promise.all([c.teder.status(), c.teder.pending()]);
  return { lines: s.ok ? statusLines(s.body, p.ok ? (p.body.posts || []).length : null) : ['לא הצלחתי להגיע לתדר כרגע. נסו שוב עוד כמה דקות.'], parts: [] };
}

/**
 * Numbered actions, done one by one against Teder, and said back: what was done and, for anything that was not, why.
 * `items` is the owner's list; every n in `intents` is on it (the reader and the tool check).
 */
export async function act(c: PostsCtx, items: ListItem[], intents: Intent[]): Promise<Done> {
  const approved: number[] = [];
  const lines: string[] = [];
  const parts: Part[] = [];
  const actor = `wa:${c.phone}`;
  const log = (action: string, item: ListItem, detail: Record<string, unknown>) => audit(c.app.db, { actor, action, detail: { workspace: c.workspaceId, post: item.id, ...detail } });
  const failed = (n: number, verb: string, r: { status: number }) =>
    r.status === 409 ? `את ${n} כבר אי אפשר ${verb}, היא לא מחכה לאישור.` : r.status === 404 ? `את ${n} לא מצאתי בתדר.` : `את ${n} לא ${verb === 'לאשר' ? 'אישרתי' : verb === 'להחזיר' ? 'החזרתי' : 'שיניתי'}, כי לא הצלחתי להגיע לתדר. נסו שוב עוד כמה דקות.`;
  for (const it of intents) {
    if (it.kind === 'show' || it.kind === 'status') continue;
    const item = items[it.n - 1];
    if (!item) continue;
    if (it.kind === 'bundle') {
      const b = await sendBundle(c, it.n, item);
      lines.push(...b.lines);
      parts.push(...b.parts);
      continue;
    }
    if (it.kind === 'approve') {
      const r = await c.teder.approve(item.id);
      await log('teder_approve', item, { ok: r.ok, status: r.status, error: r.ok ? null : r.error });
      if (r.ok) approved.push(it.n);
      else lines.push(failed(it.n, 'לאשר', r));
      continue;
    }
    if (it.kind === 'reject') {
      const r = await c.teder.reject(item.id, it.reason, it.note);
      await log('teder_reject', item, { ok: r.ok, reason: it.reason, note: it.note, status: r.status, error: r.ok ? null : r.error, redo: r.ok ? r.body.redo : null });
      if (!r.ok) lines.push(failed(it.n, 'להחזיר', r));
      else if (r.body.redo === 'writing') lines.push(`את ${it.n} החזרתי לכתיבה מחדש${it.note ? ` עם ההערה "${it.note}"` : ''}. כשהגרסה החדשה תהיה מוכנה, אשלח אותה לכאן.`);
      else if (r.body.redo === 'none') lines.push(`את ${it.n} דחיתי. הכתיבות מחדש של החודש נגמרו, אז לא תיכתב במקומה גרסה חדשה.`);
      else if (r.body.redo === 'paused') lines.push(`את ${it.n} דחיתי. החשבון לא כותב עכשיו, אז לא נכתבה גרסה חדשה ולא ירדה כתיבה מחדש.`);
      else lines.push(`את ${it.n} דחיתי.`);
      continue;
    }
    const field = editField(it.slide, it.line);
    if (!field) {
      lines.push(`בכל שקופית אפשר לשנות שתי שורות: הכותרת (שורה 1) והטקסט שמתחתיה (שורה 2).`);
      continue;
    }
    const r = await c.teder.edit(item.id, it.slide, field, it.text);
    await log('teder_edit', item, { ok: r.ok, slide: it.slide, field, text: it.text, status: r.status, error: r.ok ? null : r.error });
    if (r.ok) {
      lines.push(`שיניתי ב-${it.n}, בשקופית ${it.slide}, את ${field === 'hook' || field === 'title' ? 'הכותרת' : 'הטקסט'} ל: "${it.text}".`);
      const image = r.body.post?.slides?.find((s) => s.n === it.slide)?.image;
      if (image) parts.push({ media: image, caption: `${it.n}, שקופית ${it.slide}` });
    } else if (r.status === 422) {
      const max = r.body?.max ? ` (עד ${r.body.max} תווים)` : '';
      const said = r.error === 'not_editable' ? 'את השקופית האחרונה אי אפשר לערוך.'
        : r.error === 'too_long' ? `הטקסט ארוך מדי לשורה הזו${max}.`
        : typeof r.body?.message === 'string' ? r.body.message : 'השינוי לא עבר את הבדיקות של תדר.';
      lines.push(`את ${it.n} לא שיניתי. ${said}`);
    } else lines.push(failed(it.n, 'לשנות', r));
  }
  if (approved.length) lines.unshift(`אישרתי את ${andList(approved)}.`);
  return { lines, parts };
}
