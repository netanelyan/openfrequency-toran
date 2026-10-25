import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { App } from '../app.ts';
import { ensureDir, filesDir } from '../core/paths.ts';
import { J } from '../db/index.ts';
import type { Attachment, ChannelAdapter, Inbound, OutFile } from './types.ts';

// The files in a conversation: what a customer sends (an email's attachments, a photo on Messenger or Instagram) and
// what the owner attaches to an answer from the inbox (email only). The agent never opens one and never sends one: it
// is told a file came (store.ts), and the owner sees it in the inbox.
//
//   kept      images (JPEG, PNG, GIF, WebP) and PDFs up to MAX_BYTES, the kind told by the bytes themselves, never by
//             the name or the type the sender gave; the bytes go to the private folder under their SHA-256 (the same
//             file twice is kept once), and a row in files says whose they are
//   listed    anything else, or bigger, or that the provider would not give: a row with why, and no bytes
//
// The inbox serves a kept file only inside its conversation's workspace (server.ts checks /chat/<id>/...), with the
// type the bytes are, no sniffing, and a sandbox: an image shows in the page, a PDF downloads.

export const MAX_BYTES = 10 * 1024 * 1024;
/** The files of one message that are fetched; the rest are listed. */
export const MAX_PER_MESSAGE = 10;

export const KINDS: Record<string, string> = { 'image/jpeg': 'JPEG', 'image/png': 'PNG', 'image/gif': 'GIF', 'image/webp': 'WebP', 'application/pdf': 'PDF' };

/** What the bytes are, from their first bytes, among the kinds the inbox shows; null for anything else. */
export function sniff(b: Buffer): string | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (b.length >= 5 && b.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  return null;
}

/** A file name fit to show and to send: no folders, no control characters, at most 120 characters. */
export const cleanName = (s: unknown) => String(s || '').replace(/[\u0000-\u001f\u007f"\\/]+/g, ' ').replace(/\s+/g, ' ').trim().slice(-120) || 'file';

const pathOf = (env: Record<string, string | undefined>, sha: string) => path.join(filesDir(env), sha.slice(0, 2), sha);

export type FileRow = { id: number; conversation_id: number; direction: 'in' | 'out'; name: string; type: string; size: number; sha256: string | null; skipped: string | null };

/** Keep one file's bytes in a conversation, or list it with why not. Returns what messages.attachments holds. */
async function keep(app: App, conversationId: number, direction: 'in' | 'out', f: { name: string; type: string; size: number; bytes: Buffer | null; why?: string }): Promise<Attachment> {
  const name = cleanName(f.name);
  let type = String(f.type || '').toLowerCase().slice(0, 100);
  let sha: string | null = null;
  let skipped: string | null = f.why || null;
  if (!skipped && f.bytes) {
    const real = sniff(f.bytes);
    if (f.bytes.length > MAX_BYTES) skipped = 'too_big';
    else if (!real) skipped = 'type';
    else {
      type = real;
      sha = createHash('sha256').update(f.bytes).digest('hex');
      const at = pathOf(app.env, sha);
      if (!existsSync(at)) {
        ensureDir(path.dirname(at));
        writeFileSync(at, f.bytes);
      }
    }
  } else if (!skipped) skipped = 'unavailable';
  const size = f.bytes ? f.bytes.length : Math.max(0, Math.round(Number(f.size) || 0));
  const row = await app.db.one<{ id: number }>('INSERT INTO files (conversation_id, direction, name, type, size, sha256, skipped) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id', [conversationId, direction, name, type, size, sha, skipped]);
  return { id: row!.id, name, type, size, ...(skipped ? { skipped } : {}) };
}

/**
 * The files a customer's message carries, fetched from the provider and kept: each one listed in the conversation,
 * kept when it is an image or a PDF within the limit. A provider that fails is logged; the message still goes on.
 */
export async function keepInbound(app: App, adapter: ChannelAdapter, inbound: Inbound, conversationId: number): Promise<Attachment[]> {
  const out: Attachment[] = [];
  for (const [i, a] of (inbound.attachments || []).entries()) {
    if (a.id) {
      out.push(a); // kept already (a message handled twice)
      continue;
    }
    const base = { name: a.name, type: a.type, size: a.size };
    if (i >= MAX_PER_MESSAGE) out.push(await keep(app, conversationId, 'in', { ...base, bytes: null, why: 'too_many' }));
    else if (Number(a.size) > MAX_BYTES) out.push(await keep(app, conversationId, 'in', { ...base, bytes: null, why: 'too_big' }));
    else if (!a.ref || !adapter.fetchFile) out.push(await keep(app, conversationId, 'in', { ...base, bytes: null }));
    else {
      let bytes: Buffer | null = null;
      let why: string | undefined;
      try {
        bytes = await adapter.fetchFile(inbound, a, MAX_BYTES);
      } catch (e: any) {
        why = /too big/.test(String(e?.message)) ? 'too_big' : 'failed';
        app.log(`[files] ${adapter.channel} file ${cleanName(a.name)} in conversation ${conversationId}: ${String(e?.message || e).slice(0, 200)}`);
      }
      out.push(await keep(app, conversationId, 'in', { ...base, bytes, why }));
    }
  }
  return out;
}

/** The owner's files on an answer that went out, kept in the conversation. */
export async function keepOutbound(app: App, conversationId: number, files: OutFile[]): Promise<Attachment[]> {
  const out: Attachment[] = [];
  for (const f of files) out.push(await keep(app, conversationId, 'out', { name: f.name, type: f.type, size: f.bytes.length, bytes: f.bytes }));
  return out;
}

/** A file the owner chose to attach: within the limit and of a kind the inbox shows (by its bytes), or why not, in Hebrew. */
export function checkUpload(name: string, bytes: Buffer): { ok: true; file: OutFile } | { ok: false; he: string } {
  if (!bytes.length) return { ok: false, he: 'הקובץ ריק.' };
  if (bytes.length > MAX_BYTES) return { ok: false, he: `הקובץ גדול מדי. אפשר לצרף עד ${MAX_BYTES / 1024 / 1024}MB.` };
  const type = sniff(bytes);
  if (!type) return { ok: false, he: 'אפשר לצרף רק תמונה (JPEG, PNG, GIF, WebP) או PDF.' };
  return { ok: true, file: { name: cleanName(name), type, bytes } };
}

/** A kept file of this conversation, with its bytes; null when there is none or it was not kept. */
export async function fileOf(app: App, conversationId: number, fileId: number): Promise<{ row: FileRow; bytes: Buffer } | null> {
  const row = await app.db.one<FileRow>('SELECT * FROM files WHERE id = $1 AND conversation_id = $2 AND sha256 IS NOT NULL', [fileId, conversationId]);
  if (!row) return null;
  try {
    return { row, bytes: readFileSync(pathOf(app.env, row.sha256!)) };
  } catch {
    return null;
  }
}

/** Point a message's attachments at the files kept for it. */
export async function setAttachments(app: App, extId: string, files: Attachment[]) {
  if (files.length) await app.db.query('UPDATE messages SET attachments = $2::jsonb WHERE ext_id = $1', [extId, J(files)]);
}

/**
 * Up to max bytes from a URL, refused past it (by Content-Length first, then as they come). The providers' file links
 * (Resend's download_url, Meta's CDN) need no key.
 */
export async function download(fetchImpl: typeof fetch, url: string, max: number, headers: Record<string, string> = {}): Promise<Buffer> {
  if (!/^https:\/\//i.test(url)) throw new Error('a file link that is not https');
  const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`the file link answered ${res.status}`);
  if (Number(res.headers.get('content-length')) > max) throw new Error('the file is too big');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of (res.body || []) as AsyncIterable<Uint8Array>) {
    size += c.length;
    if (size > max) throw new Error('the file is too big');
    chunks.push(Buffer.from(c));
  }
  return Buffer.concat(chunks);
}
