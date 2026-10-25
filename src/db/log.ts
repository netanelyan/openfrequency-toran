import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ensureDir, home } from '../core/paths.ts';
import { type Db, J } from './index.ts';

// The three ledgers every part of the engine writes to:
//   event()   what happened, per store: the funnel and the dashboard read it
//   audit()   what a person did in the dashboard
//   usage()   every billable unit, per store, from day one (tokens, BSP messages, searches)

export async function event(db: Db, storeId: number | null, kind: string, data: Record<string, unknown> = {}, visitor: string | null = null) {
  await db.query('INSERT INTO events (store_id, kind, data, visitor) VALUES ($1, $2, $3::jsonb, $4)', [storeId, kind, J(data), visitor]);
}

export async function audit(db: Db, { actor = null, action, storeId = null, detail = {} }: { actor?: string | null; action: string; storeId?: number | null; detail?: Record<string, unknown> }) {
  await db.query('INSERT INTO audit (actor, action, store_id, detail) VALUES ($1, $2, $3, $4::jsonb)', [actor, action, storeId, J(detail)]);
}

export type Usage = {
  storeId?: number | null;
  conversationId?: number | null;
  kind: 'llm' | 'bsp' | 'mail' | 'dm' | 'search' | 'fetch' | 'embed';
  backend?: string;
  model?: string | null;
  inTokens?: number;
  cacheRead?: number;
  cacheWrite?: number;
  outTokens?: number;
  units?: number;
  usd?: number;
  apiUsd?: number;
  tag?: string;
};

export async function usage(db: Db, u: Usage) {
  await db.query(
    `INSERT INTO usage (store_id, conversation_id, kind, backend, model, in_tokens, cache_read, cache_write, out_tokens, units, usd, api_usd, tag)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [u.storeId ?? null, u.conversationId ?? null, u.kind, u.backend ?? null, u.model ?? null, u.inTokens || 0, u.cacheRead || 0, u.cacheWrite || 0, u.outTokens || 0, u.units || 0, u.usd || 0, u.apiUsd || 0, u.tag ?? null],
  );
}

/**
 * Every real store the engine has touched is named in private/known-stores.txt, one
 * domain or name a line. check:public reads it and refuses a commit that mentions any
 * of them: a fixture copied from a real store is the likeliest leak in this repo.
 */
export function rememberPrivateName(...names: (string | null | undefined)[]) {
  const h = home();
  if (!existsSync(h)) return;
  const file = path.join(ensureDir(h), 'known-stores.txt');
  const have = new Set(existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/) : []);
  // The fictional stores (*.example, and the free Wix site <name>-example.wixsite.com, which must live on Wix's host)
  // are not private: they are the only stores the repository may name.
  if (names.some((n) => /\.example$|^[a-z0-9-]+-example\.wixsite\.com$/i.test(String(n || '')))) return;
  const add = names.map((n) => String(n || '').trim()).filter((n) => n.length >= 4 && !have.has(n));
  if (add.length) appendFileSync(file, add.map((n) => `${n}\n`).join(''));
}
