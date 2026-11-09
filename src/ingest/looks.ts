import type { App } from '../app.ts';
import { usage as recordUsage } from '../db/log.ts';
import { agentModel } from '../agent/llm/index.ts';
import type { Block } from '../agent/llm/types.ts';
import { imageBlock, productPhoto, THUMB_WIDTH } from '../agent/images.ts';
import { capFor } from '../agent/spend.ts';

// What each product's main photo shows, read once (migration 071; the owner, 2026-11-09: a customer asked for "איזה
// חולצה צהובה יפה" and was offered a completely red kit, because the store's titles are a team and a season and say
// nothing of colour). The agent's search can only find what some text says, so the photo is put into words once, in
// Hebrew and English, and kept beside the product: "חולצה צהובה" then finds the yellow kits (agent/tools.ts rank), and
// the search lines say each photo's colours. The agent still looks at the photos themselves before offering one
// (view_product_images); this only puts the right ones in front of it.
//
// When: after each ingest, for the products whose photo is new or changed (looks_image is the address read), as a job
// of its own ('looks', jobs/worker.ts), so a store's ingest never waits on it. The photos go BATCH at a time, small
// (THUMB_WIDTH, about 140 input tokens each on Shopify), to the agent's model at low effort: a 250-product store is
// about 32 calls and well under a dollar once (docs/costs.md). On the Claude Code CLI (development) nothing is read:
// it cannot be shown an image. A store past its spend cap, or everyone past theirs, is skipped until next time.
// TORAN_LOOKS=off turns it off.
//
// What comes back is the model's reading of a photo, and a photo can carry any text: each line is cut to letters,
// spaces and a few marks, digits out (a number in a tool result would back a price in the guard), at most LOOKS_MAX
// characters, so it can say a colour and never an instruction or a price.

export const BATCH = 8;
export const LOOKS_MAX = 90;
/** The products read in one job, the rest in the next ingest's. */
export const PER_RUN = 400;

export const LOOKS_PROMPT = `You describe product photos for an online store's search. For each photo, write one short line: the product's main colours, then its pattern or look if it has one (stripes, checks, a big print, a logo), in Hebrew and then in English, like "צהוב, כחול / yellow, blue; פסים / stripes". Only what you plainly see on the product itself, not the background, the model wearing it or the packaging. No brand names, no numbers, no opinions.
Answer with one JSON object and nothing else: each product's id as the key, its line as the value.`;

/** A line fit to keep: letters (any script), spaces and , / ; - ( ) only, no digits, trimmed to LOOKS_MAX. */
export function cleanLooks(v: unknown): string | null {
  const s = String(v ?? '')
    .replace(/<[^>]*>|\S+:\/\/\S+/g, ' ')
    .replace(/[^\p{L}\s,/;()\-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, LOOKS_MAX)
    .trim();
  return s.length >= 2 ? s : null;
}

/** The model's JSON answer, read leniently (a code fence or a word before it is dropped). */
export function parseLooks(text: string): Record<string, string> {
  const m = /\{[\s\S]*\}/.exec(text || '');
  if (!m) return {};
  try {
    const o = JSON.parse(m[0]);
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch {
    return {};
  }
}

export type LooksRun = { read: number; failed: number; skipped?: string };

/** Read the looks of a store's products whose photo was not read yet, or changed. */
export async function readLooks(app: App, storeId: number, { perRun = PER_RUN }: { perRun?: number } = {}): Promise<LooksRun> {
  if (/^(0|off|no|false)$/i.test(String(app.env.TORAN_LOOKS || '').trim())) return { read: 0, failed: 0, skipped: 'TORAN_LOOKS is off' };
  if (app.llm.backend === 'claude-cli') return { read: 0, failed: 0, skipped: 'the Claude Code CLI cannot be shown photos' };
  const store = await app.db.one<{ id: number; config: any }>('SELECT id, config FROM stores WHERE id = $1', [storeId]);
  if (!store) return { read: 0, failed: 0, skipped: 'no such store' };
  if (app.llm.backend === 'api' && (await capFor(app, store))) return { read: 0, failed: 0, skipped: 'past a spend cap' };
  const due = await app.db.query<{ id: number; title: string; image: string }>(
    'SELECT id, title, image FROM products WHERE store_id = $1 AND gone_at IS NULL AND image IS NOT NULL AND looks_image IS DISTINCT FROM image ORDER BY id LIMIT $2',
    [storeId, perRun],
  );
  const model = String(app.env.TORAN_MODEL_LOOKS || '').trim() || agentModel(app.env);
  let read = 0;
  let failed = 0;
  for (let i = 0; i < due.length; i += BATCH) {
    const batch = due.slice(i, i + BATCH);
    const photos = await Promise.all(batch.map((p) => productPhoto(app.images, p.image, THUMB_WIDTH)));
    const shown = batch.filter((_, k) => photos[k]);
    failed += batch.length - shown.length;
    if (!shown.length) continue;
    const content: Block[] = [];
    batch.forEach((p, k) => {
      if (!photos[k]) return;
      content.push({ type: 'text', text: `Product id ${p.id}:` }, imageBlock(photos[k]!));
    });
    content.push({ type: 'text', text: `The ids: ${shown.map((p) => p.id).join(', ')}.` });
    let answer = '';
    try {
      const res = await app.llm.turn({ system: [{ text: LOOKS_PROMPT }], messages: [{ role: 'user', content }], tools: [], model, maxTokens: 2000, effort: 'low', tag: `looks store ${storeId}` });
      await recordUsage(app.db, { storeId, kind: 'llm', backend: res.backend, model: res.model, inTokens: res.usage.input_tokens, cacheRead: res.usage.cache_read_input_tokens, cacheWrite: res.usage.cache_creation_input_tokens, outTokens: res.usage.output_tokens, usd: res.usd, apiUsd: res.apiUsd, tag: 'looks' });
      answer = res.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n');
    } catch (e: any) {
      app.log(`[looks] store ${storeId}: a batch of ${shown.length} photos was not read: ${String(e?.message || e).slice(0, 200)}`);
      failed += shown.length;
      if (e?.code === 'api_refused') break; // development without --allow-api: no batch will be
      continue;
    }
    const got = parseLooks(answer);
    for (const p of shown) {
      const line = cleanLooks(got[String(p.id)]);
      if (!line) {
        failed++;
        continue;
      }
      await app.db.query('UPDATE products SET looks = $2, looks_image = $3, looks_at = now() WHERE id = $1', [p.id, line, p.image]);
      read++;
    }
  }
  if (due.length) app.log(`[looks] store ${storeId}: ${read} photos read, ${failed} not`);
  return { read, failed };
}
