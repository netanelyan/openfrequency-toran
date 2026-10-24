import type { App } from '../app.ts';
import { audit } from '../db/log.ts';
import type { Part } from '../channels/send.ts';
import type { Intent } from './intents.ts';
import { keepList } from './notify.ts';
import type { TederClient, TederPost, TederStatus } from './teder.ts';

// What the owner line does with Teder's posts, for the reader in code (line.ts) and for the model's tools
// (assistant/index.ts) alike: show the posts waiting, act on numbered ones, send one ready to post, say the status.
// Every line about a post is made from what Teder answered: its hook, its images, its caption, its own problems
// with an edit. Every action is in the audit, with the owner's number as the actor.

export type PostsCtx = { app: App; teder: TederClient; workspaceId: number; phone: string };
export type ListItem = { id: number; hook: string };
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

/** The posts as a numbered message: a line, then each cover with its number and hook. */
export function numbered(posts: TederPost[], head: string, hint: string | null): Part[] {
  const parts: Part[] = [{ text: head }];
  posts.forEach((p, i) => parts.push(p.cover?.url ? { media: p.cover.url, caption: `${i + 1}. ${p.hook}` } : { text: `${i + 1}. ${p.hook}` }));
  if (hint) parts.push({ text: hint });
  return parts;
}

export const HINT_MANY = 'אפשר לענות לי במילים שלכם, למשל: אשר את 1 ו-3, את 2 תעשה קצר יותר.';
export const HINT_ONE = 'כדי לאשר כתבו "אשר", או כתבו לי מה לשנות.';
export const UNREACHABLE = 'לא הצלחתי להגיע לטדר כרגע, אז לא שיניתי כלום. נסו שוב עוד כמה דקות.';

/** The posts waiting for approval, now, numbered and kept as the owner's list. */
export async function showPending(c: PostsCtx): Promise<Done & { posts: TederPost[] | null }> {
  const r = await c.teder.pending();
  if (!r.ok) return { lines: [UNREACHABLE], parts: [], posts: null };
  const posts = r.body.posts || [];
  if (!posts.length) return { lines: ['אין כרגע מצגות שמחכות לאישור.'], parts: [], posts };
  await keepList(c.app, c.phone, c.workspaceId, posts.map((p) => ({ id: p.id, hook: p.hook })), 'asked');
  const head = posts.length === 1 ? 'מצגת אחת מחכה לאישור:' : `${posts.length} מצגות מחכות לאישור:`;
  return { lines: [], parts: numbered(posts, head, posts.length === 1 ? HINT_ONE : HINT_MANY), posts };
}

/** One post's images and caption, the way it goes up: the images in order, then the caption alone to copy. */
export async function sendBundle(c: PostsCtx, n: number, item: ListItem): Promise<Done> {
  const r = await c.teder.bundle(item.id);
  if (!r.ok) return { lines: [r.status === 404 ? `את ${n} לא מצאתי בטדר.` : UNREACHABLE], parts: [] };
  await audit(c.app.db, { actor: c.phone ? `wa:${c.phone}` : 'teder_event', action: 'teder_bundle', detail: { workspace: c.workspaceId, post: item.id } });
  const images = r.body.images || [];
  return {
    lines: [],
    parts: [
      { text: `"${r.body.post?.hook || item.hook}", מוכן להעלאה: ${images.length === 1 ? 'תמונה אחת' : `${images.length} תמונות`} לפי הסדר, ואחריהן הכיתוב להעתקה.` },
      ...images.map((im, i) => ({ media: im.url, caption: `${i + 1}/${images.length}` })),
      ...(r.body.caption ? [{ text: r.body.caption }] : []),
    ],
  };
}

/** The status in the owner's words, from Teder's numbers only. */
export function statusLines(s: TederStatus): string[] {
  const out = [s.pending ? (s.pending === 1 ? 'בטדר מחכה לאישור שלכם מצגת אחת.' : `בטדר מחכות לאישור שלכם ${s.pending} מצגות.`) : 'בטדר אין מצגות שמחכות לאישור.'];
  if (s.approvedThisWeek != null && s.publishedThisWeek != null) out.push(`השבוע אישרתם ${s.approvedThisWeek} ועלו ${s.publishedThisWeek}.`);
  if (s.quota) out.push(`החודש השתמשתם ב-${s.quota.suggested.used} מתוך ${s.quota.suggested.limit} הצעות לפוסטים, וב-${s.quota.redos.used} מתוך ${s.quota.redos.limit} כתיבות מחדש.`);
  return out;
}

export async function status(c: PostsCtx): Promise<Done> {
  const r = await c.teder.status();
  return { lines: r.ok ? statusLines(r.body) : ['לא הצלחתי להגיע לטדר כרגע. נסו שוב עוד כמה דקות.'], parts: [] };
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
      else lines.push(r.status === 409 ? `את ${it.n} כבר אי אפשר לאשר, היא לא מחכה לאישור.` : r.status === 404 ? `את ${it.n} לא מצאתי בטדר.` : `את ${it.n} לא אישרתי, כי לא הצלחתי להגיע לטדר. נסו שוב עוד כמה דקות.`);
      continue;
    }
    if (it.kind === 'reject') {
      const r = await c.teder.reject(item.id, it.reason, it.note);
      await log('teder_reject', item, { ok: r.ok, reason: it.reason, note: it.note, status: r.status, error: r.ok ? null : r.error, replacement: r.ok ? r.body.replacement?.id ?? null : null });
      if (!r.ok) lines.push(r.status === 409 ? `את ${it.n} כבר אי אפשר להחזיר, היא לא מחכה לאישור.` : r.status === 404 ? `את ${it.n} לא מצאתי בטדר.` : `את ${it.n} לא החזרתי, כי לא הצלחתי להגיע לטדר. נסו שוב עוד כמה דקות.`);
      else if (r.body.replacement) lines.push(`את ${it.n} החזרתי לכתיבה מחדש${it.note ? ` עם ההערה "${it.note}"` : ''}. הגרסה החדשה תגיע לאישור כשתהיה מוכנה.`);
      else lines.push(`את ${it.n} דחיתי.${r.body.redosLeft === 0 ? ' הכתיבות מחדש של החודש נגמרו, אז לא תיכתב במקומה גרסה חדשה.' : ''}`);
      continue;
    }
    const r = await c.teder.edit(item.id, it.slide, it.line, it.text);
    await log('teder_edit', item, { ok: r.ok, slide: it.slide, line: it.line, text: it.text, status: r.status, error: r.ok ? null : r.error });
    if (r.ok) {
      lines.push(`שיניתי ב-${it.n}, בשקופית ${it.slide}, את שורה ${it.line} ל: "${it.text}".`);
      if (r.body.slide?.image?.url) parts.push({ media: r.body.slide.image.url, caption: `${it.n}, שקופית ${it.slide}` });
    } else if (r.status === 422) {
      const problems = Array.isArray(r.body?.problems) ? r.body.problems.map(String).slice(0, 4) : [];
      lines.push(`השינוי ב-${it.n} לא עבר את הבדיקות של טדר, אז לא שיניתי כלום${problems.length ? `: ${problems.join('; ')}` : '.'}`);
    } else if (r.status === 400) lines.push(`ב-${it.n}, בשקופית ${it.slide}, אין שורה ${it.line}.`);
    else if (r.status === 409) lines.push(`את ${it.n} כבר אי אפשר לשנות, היא לא מחכה לאישור.`);
    else lines.push(r.status === 404 ? `את ${it.n} לא מצאתי בטדר.` : UNREACHABLE);
  }
  if (approved.length) lines.unshift(`אישרתי את ${andList(approved)}.`);
  return { lines, parts };
}
