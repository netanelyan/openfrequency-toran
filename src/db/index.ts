import { AsyncLocalStorage } from 'node:async_hooks';
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
//   tests        PGlite in memory, a fresh database per test; or, with TORAN_TEST_DATABASE_URL, a fresh database on
//                a real Postgres for each (test/helpers.ts testDb), as CI runs them (.github/workflows/test.yml)
//
// Everything above this file speaks plain SQL with $1 placeholders. JSON goes in as
// a string with a ::jsonb cast, a vector as '[...]' with ::vector, so both drivers
// see the same text.
//
// On Postgres every connection carries limits (PG_LIMITS): a statement that runs past 15 seconds, a lock waited on
// past 5, a transaction left open and idle past 30 are cancelled by the server, so one stuck query cannot hold a
// worker loop or a lock for good. A job that needs longer (an ingest's one big write) asks for it in its own
// transaction (tx's statementTimeoutMs, a SET LOCAL). Each such cancellation is logged with what was running
// (withDbLabel: the worker names the job kind).
//
// The schema: migrations are files, applied in name order, each recorded in schema_migrations. A database that holds
// a migration this build has no file for was moved on by a newer build, and nothing here opens it (an older build on
// a newer schema writes what the newer one no longer reads). With TORAN_MIGRATE=check the server applies nothing
// either: it starts only on a schema already up to date, and the deploy applies migrations as its own step after a
// backup (scripts/migrate.ts, deploy/deploy.sh).

export type Row = Record<string, any>;

export interface Db {
  kind: 'pglite' | 'postgres';
  query<T = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T = Row>(sql: string, params?: unknown[]): Promise<T | null>;
  /** Several statements, no parameters (migrations). */
  exec(sql: string): Promise<void>;
  /** A transaction. statementTimeoutMs raises (or lowers) the statement limit inside it alone. */
  tx<T>(fn: (db: Db) => Promise<T>, opts?: { statementTimeoutMs?: number }): Promise<T>;
  close(): Promise<void>;
}

type Env = Record<string, string | undefined>;
type Log = (m: string) => void;

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

/** The limits every production connection carries, in milliseconds (Postgres's own setting names). */
export const PG_LIMITS = { statement_timeout: 15_000, lock_timeout: 5_000, idle_in_transaction_session_timeout: 30_000 };

/** The driver's options for production, and for a test database (whose idle connections close at once, so a test file's process can end). */
export function pgOptions({ test = false }: { test?: boolean } = {}) {
  return {
    max: 8,
    onnotice: () => {},
    types: { json: JSON_TYPE },
    idle_timeout: test ? 1 : 60,
    connect_timeout: 10,
    connection: { application_name: test ? 'toran-test' : 'toran', ...PG_LIMITS },
  };
}

/** The server's ways of cancelling a query for running or waiting too long, by SQLSTATE. */
export const TIMEOUT_CODES: Record<string, string> = {
  '57014': 'statement timeout',
  '55P03': 'lock timeout',
  '25P03': 'idle-in-transaction timeout',
};

const labels = new AsyncLocalStorage<string>();

/** Run fn with a name for whatever the database is asked inside it ("job wa_inbound"), for the timeout log. */
export const withDbLabel = <T>(label: string, fn: () => Promise<T>): Promise<T> => labels.run(label, fn);

/** A cancelled query's log line, or null for any other error. */
export function timeoutLine(e: any, sql: string, label = labels.getStore()): string | null {
  const what = TIMEOUT_CODES[String(e?.code || '')];
  if (!what) return null;
  return `[db] ${what} in ${label || 'no job'}: ${String(sql).replace(/\s+/g, ' ').trim().slice(0, 160)}`;
}

/** Every query through `run`, its cancellations logged. */
function watched(log: Log | undefined) {
  return async <T>(sql: string, run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (e) {
      const line = timeoutLine(e, sql);
      if (line) (log || console.error)(line);
      throw e;
    }
  };
}

const setLocal = (ms: number) => `SET LOCAL statement_timeout = ${Math.max(0, Math.floor(ms))}`;

async function pglite(dataDir?: string, log?: Log): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  const { vector } = await import('@electric-sql/pglite-pgvector');
  const pg = await PGlite.create({ dataDir, extensions: { vector } });
  const watch = watched(log);
  const wrap = (q: { query: (s: string, p?: unknown[]) => Promise<{ rows: unknown[] }>; exec: (s: string) => Promise<unknown> }, inTx: boolean): Db => {
    const db: Db = {
      kind: 'pglite',
      async query<T>(sql: string, params: unknown[] = []) {
        return watch(sql, async () => (await q.query(sql, params)).rows as T[]);
      },
      async one<T>(sql: string, params: unknown[] = []) {
        return watch(sql, async () => ((await q.query(sql, params)).rows[0] as T) ?? null);
      },
      async exec(sql: string) {
        await watch(sql, () => q.exec(sql));
      },
      async tx<T>(fn: (d: Db) => Promise<T>, opts: { statementTimeoutMs?: number } = {}) {
        if (inTx) return fn(db);
        return pg.transaction(async (t) => {
          if (opts.statementTimeoutMs != null) await t.exec(setLocal(opts.statementTimeoutMs));
          return fn(wrap(t as never, true));
        }) as Promise<T>;
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

/** Errors that mean the server is not there yet (Docker still starting it after a reboot), not that something is wrong. */
const NOT_UP = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'CONNECT_TIMEOUT', 'CONNECTION_CLOSED', 'CONNECTION_ENDED', '57P03']);

/**
 * The first connection, tried again while the server is starting: after a reboot the service can come up before
 * Docker has started Postgres. Waits 0.5, 1, 2, 4, 8, 8... seconds, for up to `withinMs` in all, and logs each try.
 */
export async function firstConnection(ping: () => Promise<unknown>, { withinMs = 60_000, log = console.error as Log, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)) } = {}): Promise<number> {
  const start = Date.now();
  for (let attempt = 1, wait = 500; ; attempt++, wait = Math.min(wait * 2, 8_000)) {
    try {
      await ping();
      if (attempt > 1) log(`[db] connected on try ${attempt}`);
      return attempt;
    } catch (e: any) {
      const code = String(e?.code || '');
      const left = withinMs - (Date.now() - start);
      if (!NOT_UP.has(code) || left <= 0) throw e;
      log(`[db] the database is not answering yet (${code}), try ${attempt}; again in ${Math.min(wait, left)} ms`);
      await sleep(Math.min(wait, left));
    }
  }
}

async function postgresDb(url: string, { log, test = false, connectWithinMs = 60_000 }: { log?: Log; test?: boolean; connectWithinMs?: number } = {}): Promise<Db> {
  const { default: postgres } = await import('postgres');
  const sql = postgres(url, pgOptions({ test }) as never);
  const watch = watched(log);
  const wrap = (s: any, inTx: boolean): Db => {
    const db: Db = {
      kind: 'postgres',
      async query<T>(text: string, params: unknown[] = []) {
        return watch(text, async () => [...(await s.unsafe(text, params as never[]))] as T[]);
      },
      async one<T>(text: string, params: unknown[] = []) {
        return watch(text, async () => ((await s.unsafe(text, params as never[]))[0] as T) ?? null);
      },
      async exec(text: string) {
        await watch(text, () => s.unsafe(text));
      },
      async tx<T>(fn: (d: Db) => Promise<T>, opts: { statementTimeoutMs?: number } = {}) {
        if (inTx) return fn(db);
        return sql.begin(async (t: any) => {
          if (opts.statementTimeoutMs != null) await t.unsafe(setLocal(opts.statementTimeoutMs));
          return fn(wrap(t, true));
        }) as Promise<T>;
      },
      async close() {
        if (!inTx) await sql.end({ timeout: 5 });
      },
    };
    return db;
  };
  try {
    await firstConnection(() => sql`select 1`, { withinMs: connectWithinMs, log: log || console.error });
  } catch (e) {
    await sql.end({ timeout: 1 }).catch(() => {});
    throw e;
  }
  return wrap(sql, false);
}

export type MigrateMode = 'auto' | 'check' | 'none' | 'raw';

/**
 * Open the database for this environment and bring its schema up to date: `migrate` auto applies what is missing
 * (development, tests, and the server until TORAN_MIGRATE=check is set), check refuses to open a schema that is not
 * up to date, none opens it as it is (scripts/migrate.ts). Every mode refuses a schema ahead of this build, except
 * raw, which checks nothing (scripts/migrate.ts --files, comparing it with another build's migrations).
 */
export async function openDb({ env = process.env, memory = false, url = null, log, migrate: mode, test = false, connectWithinMs }: { env?: Env; memory?: boolean; url?: string | null; log?: Log; migrate?: MigrateMode; test?: boolean; connectWithinMs?: number } = {}): Promise<Db> {
  const dbUrl = String(url ?? env.DATABASE_URL ?? '').trim();
  const db = memory ? await pglite(undefined, log) : dbUrl ? await postgresDb(dbUrl, { log, test, connectWithinMs }) : await pglite(ensureDir(pgliteDir(env)), log);
  const how: MigrateMode = mode || (String(env.TORAN_MIGRATE || '').trim() === 'check' ? 'check' : 'auto');
  try {
    if (how === 'auto') await migrate(db);
    else if (how === 'check') await migrate(db, { apply: false });
    else if (how === 'none') {
      const s = await migrationStatus(db);
      if (s.unknown.length) throw schemaAhead(s.unknown);
    }
  } catch (e) {
    await db.close().catch(() => {});
    throw e;
  }
  return db;
}

/** The migration files this build has (or another build's folder of them: deploy/rollback.sh), in the order they apply. */
export const migrationFiles = (dir = MIGRATIONS) => readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

/** What the database has against what this build knows (or the build whose migrations are in `dir`): { applied, pending (files not applied), unknown (applied, with no file here) }. */
export async function migrationStatus(db: Db, dir = MIGRATIONS): Promise<{ applied: string[]; pending: string[]; unknown: string[] }> {
  await db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const applied = (await db.query<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name')).map((r) => r.name);
  const files = migrationFiles(dir);
  const done = new Set(applied);
  const known = new Set(files);
  return { applied, pending: files.filter((f) => !done.has(f)), unknown: applied.filter((n) => !known.has(n)) };
}

export class SchemaError extends Error {
  code: 'schema_ahead' | 'schema_behind';
  names: string[];
  constructor(code: 'schema_ahead' | 'schema_behind', names: string[], message: string) {
    super(message);
    this.code = code;
    this.names = names;
  }
}

const schemaAhead = (names: string[]) =>
  new SchemaError('schema_ahead', names, `the database has migrations this build does not know (${names.join(', ')}): a newer build moved it on. Deploy that build again, or restore the backup taken before it (docs/restore.md); never run an older build on it.`);

/**
 * Apply every migration not applied yet, in file-name order, each in its own transaction. Refuses a database that
 * holds a migration with no file here (SchemaError schema_ahead); with apply false, also one that lacks a migration
 * (schema_behind), and applies nothing.
 */
export async function migrate(db: Db, { apply = true }: { apply?: boolean } = {}): Promise<string[]> {
  const { pending, unknown } = await migrationStatus(db);
  if (unknown.length) throw schemaAhead(unknown);
  if (!apply) {
    if (pending.length) throw new SchemaError('schema_behind', pending, `the database lacks migrations (${pending.join(', ')}) and TORAN_MIGRATE=check applies none: run the deploy's migrate step (npm run migrate, after a backup) first.`);
    return [];
  }
  const applied: string[] = [];
  for (const f of pending) {
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
