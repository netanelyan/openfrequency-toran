import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Where everything lives.
//
// The repository is public and holds only the engine. Everything that belongs to a
// real store (its leads, its knowledge pack, every conversation, phone numbers, the
// database, keys) lives in TORAN_HOME, which defaults to ./private/ inside the repo
// and is gitignored entirely. Every data path below is derived from home().

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

type Env = Record<string, string | undefined>;

/** The private folder. A relative value resolves against the repo root, not the cwd. */
export function home(env: Env = process.env): string {
  const raw = String(env.TORAN_HOME || '').trim();
  return raw ? path.resolve(ROOT, raw) : path.join(ROOT, 'private');
}

export const dataDir = (env?: Env) => path.join(home(env), 'data');
export const pgliteDir = (env?: Env) => path.join(dataDir(env), 'pglite');
export const logsDir = (env?: Env) => path.join(home(env), 'logs');
export const cacheDir = (env?: Env) => path.join(home(env), 'cache');
export const evalDir = (env?: Env) => path.join(home(env), 'eval');

/**
 * Where the embedding model is kept. Outside the repo and short: on Windows a path past
 * 260 characters fails the model download silently (measured on the dev machine).
 */
export const modelsDir = (env: Env = process.env) => String(env.TORAN_MODELS_DIR || '').trim() || path.join(home(env), 'models');

/** The fictional store: tests, the demo and the screenshots use it, nothing real. */
export const examplesDir = path.join(ROOT, 'examples');

export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** A clear stop when the private folder has not been created yet. */
export function requireHome(env: Env = process.env): string {
  const h = home(env);
  if (!existsSync(h)) {
    const err = Object.assign(new Error(`No private folder at ${h}.\n  Run \`npm run init-private\` to create it (or set TORAN_HOME).\n  To try the engine with the fictional store only: \`npm run demo\`.`), { code: 'no_home' });
    throw err;
  }
  return h;
}
