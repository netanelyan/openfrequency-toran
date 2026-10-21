import { ensureDir, modelsDir } from '../core/paths.ts';

// Embeddings for policy text, on this machine's CPU: multilingual-e5-small (384
// dimensions, quantised), through transformers.js. $0 a call, no key, works offline on
// the VPS once the model (about 120 MB) is downloaded.
//
// e5 wants a prefix: "passage: " for what is stored, "query: " for what is asked.
// Measured on Hebrew policy text before choosing it: three questions (returns,
// shipping cost, paying by Bit), each ranked the right passage first.
//
// Prices never come from here. This finds the policy paragraph; the numbers in it
// reach the customer only as tool output, through the guard.
//
// TORAN_EMBED=off turns it off (tests, a machine without the model): chunks are stored
// without a vector and get_policy falls back to matching words.

export const DIMS = 384;
const MODEL = 'Xenova/multilingual-e5-small';

let extractor: Promise<any> | null = null;

export const embeddingsOn = (env: Record<string, string | undefined> = process.env) => String(env.TORAN_EMBED || '').toLowerCase() !== 'off';

async function load(env: Record<string, string | undefined>) {
  const t = await import('@huggingface/transformers');
  t.env.cacheDir = ensureDir(modelsDir(env));
  return t.pipeline('feature-extraction', MODEL, { dtype: 'q8' });
}

export async function embed(texts: string[], kind: 'passage' | 'query', env: Record<string, string | undefined> = process.env): Promise<number[][] | null> {
  if (!embeddingsOn(env) || !texts.length) return null;
  extractor ??= load(env);
  let ex;
  try {
    ex = await extractor;
  } catch {
    extractor = null;
    return null;
  }
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 16) {
    const batch = texts.slice(i, i + 16).map((t) => `${kind}: ${t}`);
    const res = await ex(batch, { pooling: 'mean', normalize: true });
    out.push(...(res.tolist() as number[][]));
  }
  return out;
}
