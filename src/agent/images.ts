import type { Fetcher } from '../core/http.ts';
import { sniff } from '../channels/files.ts';
import type { ImageBlock } from './llm/types.ts';

// The photos the model looks at (the owner, 2026-11-09, on a red kit offered for "a nice yellow shirt": "make the AI
// have a way to watch pictures"). A product's main photo, read from the store's own catalogue address with the
// engine's fetcher (core/http.ts: the address rule on every hop, robots.txt, a size cap), never by the model's own
// link: a store's image field is a stranger's text, and the fetcher is what keeps it off our own machine.
//
// SIZE. A photo costs about width x height / 750 input tokens, and the API shrinks anything past 1568 pixels anyway.
// Shopify's CDN gives any width asked for (?width=640 on a 1080 PNG answered 640x640, checked 2026-11-09), so a
// Shopify photo is asked for at PHOTO_WIDTH (about 550 tokens) or THUMB_WIDTH for the catalogue's looks (about 140);
// other platforms' photos come as they are, up to MAX_PHOTO_BYTES.
//
// A photo read once is kept in memory (CACHE_SIZE of them, the oldest dropped first), so a customer's second question
// about the same shirts costs no second download.

export const PHOTO_WIDTH = 640;
export const THUMB_WIDTH = 320;
/** The API's limit is 5 MB an image as sent; base64 is 4/3 of the bytes. */
export const MAX_PHOTO_BYTES = 3_700_000;
const CACHE_SIZE = 150;

export type Photo = ImageBlock['source'];
const API_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/** The address to read a photo from: a Shopify CDN photo at the width asked for, anything else as it is. */
export function sizedUrl(url: string, width = PHOTO_WIDTH): string {
  try {
    const u = new URL(url, 'https://x.invalid');
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return url;
    if (/(^|\.)cdn\.shopify\.com$/i.test(u.hostname) || /^\/cdn\/shop\//.test(u.pathname)) {
      u.searchParams.set('width', String(width));
      return u.toString();
    }
  } catch {
    /* not a URL: read as it is, and refused by the fetcher */
  }
  return url;
}

const cache = new Map<string, Photo>();
function remember(key: string, p: Photo) {
  cache.delete(key);
  cache.set(key, p);
  while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
}
export const forgetPhotos = () => cache.clear();

/** Bytes as the API takes them, or null: a kind it reads (by the bytes, never the name), within the size. */
export function asPhoto(bytes: Uint8Array | Buffer | null | undefined): Photo | null {
  if (!bytes || !bytes.length || bytes.length > MAX_PHOTO_BYTES) return null;
  const b = Buffer.from(bytes);
  const type = sniff(b);
  if (!type || !API_TYPES.has(type)) return null;
  return { type: 'base64', media_type: type as Photo['media_type'], data: b.toString('base64') };
}

/** One product photo, read (or remembered), or null when it could not be: no address, refused, too big, not an image. */
export async function productPhoto(fetcher: Fetcher, url: string | null | undefined, width = PHOTO_WIDTH): Promise<Photo | null> {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const at = sizedUrl(url, width);
  if (cache.has(at)) {
    const hit = cache.get(at)!;
    remember(at, hit);
    return hit;
  }
  let photo: Photo | null = null;
  try {
    const r = await fetcher(at, { accept: 'image/webp,image/png,image/jpeg,image/*;q=0.8', binary: true, maxBytes: MAX_PHOTO_BYTES, timeoutMs: 10_000 });
    photo = asPhoto(r.bytes);
  } catch {
    photo = null;
  }
  // A failure is not remembered: the next question tries again.
  if (photo) remember(at, photo);
  return photo;
}

export const imageBlock = (p: Photo): ImageBlock => ({ type: 'image', source: p });
