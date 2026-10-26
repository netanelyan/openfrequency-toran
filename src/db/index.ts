import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDir, pgliteDir } from '../core/paths.ts';

// One database door for the engine: Postgres with pgvector.
//
//   production   real Postgres (the pgvector image in deploy/docker-compose.yml), via
//                DATABASE_URL and the `postgres` driver
//   development  PGlite, Postgres compiled to WASM, with the pgvector extension, in
//                private/data/pglite: the same SQL and the same migrations with
//                nothing to install
//   tests        PGlite in memory, a fresh database per test file
//
// Everything above this file speaks plain SQL with $1 placeholders. JSON goes in as
// a string with a ::jsonb cast, a vector as '[...]' with ::vector, so both drivers
// see the same text.

export type Row = Record<string, any>;

export interface Db {
  kind: 'pglite' | 'postgres';
  query<T = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T = Row>(sql: string, params?: unknown[]): Promise<T | null>;
  /** Several statements, no parameters (migrations). */
  exec(sql: string): Promise<void>;
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

type Env = Record<string, string | undefined>;

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

async function pglite(dataDir?: string): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  const { vector } = await import('@electric-sql/pglite-pgvector');
  const pg = await PGlite.create({ dataDir, extensions: { vector } });
  const wrap = (q: { query: (s: string, p?: unknown[]) => Promise<{ rows: unknown[] }>; exec: (s: string) => Promise<unknown> }, inTx: boolean): Db => {
    const db: Db = {
      kind: 'pglite',
      async query<T>(sql: string, params: unknown[] = []) {
        return (await q.query(sql, params)).rows as T[];
      },
      async one<T>(sql: string, params: unknown[] = []) {
        return ((await q.query(sql, params)).rows[0] as T) ?? null;
      },
      async exec(sql: string) {
        await q.exec(sql);
      },
      async tx<T>(fn: (d: Db) => Promise<T>) {
        if (inTx) return fn(db);
        return pg.transaction(async (t) => fn(wrap(t as never, true))) as Promise<T>;
      },
      async close() {
        if (!inTx) await pg.close();
      },
    };
    return db;
  };
  return wrap(pg as never, false);
}

/**
 * json and jsonb parameters as PGlite takes them: text is already JSON (every caller passes J(...)) and goes as it is.
 * The driver's own serializer JSON.stringify()s whatever it gets, so J()'s text arrived as one JSON string, and a job's
 * payload read back as "{\"storeId\":95}", not { storeId: 95 } (migration 020 repairs what was written so).
 */
export const JSON_TYPE = { to: 114, from: [114, 3802], serialize: (x: unknown) => (typeof x === 'string' ? x : JSON.stringify(x)), parse: (x: string) => JSON.parse(x) };

async function postgresDb(url: string): Promise<Db> {
  const { default: postgres } = await import('postgres');
  const sql = postgres(url, { max: 8, onnotice: () => {}, types: { json: JSON_TYPE } });
  const wrap = (s: any, inTx: boolean): Db => {
    const db: Db = {
      kind: 'postgres',
      async query<T>(text: string, params: unknown[] = []) {
        return [...(await s.unsafe(text, params as never[]))] as T[];
      },
      async one<T>(text: string, params: unknown[] = []) {
        return ((await s.unsafe(text, params as never[]))[0] as T) ?? null;
      },
      async exec(text: string) {
        await s.unsafe(text);
      },
      async tx<T>(fn: (d: Db) => Promise<T>) {
        if (inTx) return fn(db);
        return sql.begin(async (t: any) => fn(wrap(t, true))) as Promise<T>;
      },
      async close() {
        if (!inTx) await sql.end({ timeout: 5 });
      },
    };
    return db;
  };
  return wrap(sql, false);
}

/** Open the database for this environment and bring its schema up to date. */
export async function openDb({ env = process.env, memory = false }: { env?: Env; memory?: boolean } = {}): Promise<Db> {
  const url = String(env.DATABASE_URL || '').trim();
  const db = memory ? await pglite() : url ? await postgresDb(url) : await pglite(ensureDir(pgliteDir(env)));
  await migrate(db);
  return db;
}

/** Apply every migration not applied yet, in file-name order, each in its own transaction. */
export async function migrate(db: Db): Promise<string[]> {
  await db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const done = new Set((await db.query<{ name: string }>('SELECT name FROM schema_migrations')).map((r) => r.name));
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = readFileSync(path.join(MIGRATIONS, f), 'utf8');
    await db.tx(async (t) => {
      await t.exec(sql);
      await t.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
    });
    applied.push(f);
  }
  return applied;
}

/** A JSON value as a parameter: pass with a ::jsonb cast. */
export const J = (v: unknown) => JSON.stringify(v ?? null);

/** An embedding as a parameter: pass with a ::vector cast. */
export const V = (v: ArrayLike<number>) => `[${Array.from(v, (x) => (Number.isFinite(x) ? x.toFixed(6) : '0')).join(',')}]`;
