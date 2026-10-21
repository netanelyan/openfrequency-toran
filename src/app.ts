import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { loadEnv } from './core/env.ts';
import { ensureDir, logsDir } from './core/paths.ts';
import { cleanLine } from './core/hebrew.ts';
import { type Fetcher, liveFetcher } from './core/http.ts';
import { renderHtml } from './core/browser.ts';
import { type Db, openDb } from './db/index.ts';
import { type Llm, makeLlm } from './agent/llm/index.ts';
import { type WaProvider, makeWaProvider } from './wa/providers.ts';

// The one object every part of the engine is handed: the database, the settings, a
// log, the fetcher, the model and the WhatsApp provider. Tests build their own with a
// fixture fetcher, a scripted model and the simulated provider.

export type Env = Record<string, string | undefined>;

export type App = {
  db: Db;
  env: Env;
  log: (m: string) => void;
  fetcher: Fetcher;
  render?: (url: string) => Promise<string | null>;
  llm: Llm;
  wa: WaProvider;
};

/** A log line to the console and to private/logs/toran.log, one line each (no forged entries). */
export function makeLog(env: Env = process.env, { quiet = false } = {}): (m: string) => void {
  let file: string | null = null;
  try {
    file = path.join(ensureDir(logsDir(env)), 'toran.log');
  } catch {
    file = null;
  }
  return (m: string) => {
    const line = `${new Date().toISOString()} ${cleanLine(m, 2000)}`;
    if (!quiet) console.log(line);
    if (file) {
      try {
        appendFileSync(file, `${line}\n`);
      } catch {
        /* the log line is lost, not the work */
      }
    }
  };
}

export async function makeApp({ env = process.env, db, fetcher, llm, wa, quiet = false }: { env?: Env; db?: Db; fetcher?: Fetcher; llm?: Llm; wa?: WaProvider; quiet?: boolean } = {}): Promise<App> {
  if (env === process.env) loadEnv(env);
  const log = makeLog(env, { quiet });
  const theDb = db || (await openDb({ env }));
  return {
    db: theDb,
    env,
    log,
    fetcher: fetcher || liveFetcher(),
    render: (url) => renderHtml(url),
    llm: llm || makeLlm(env, { log }),
    wa: wa || makeWaProvider(env, { log }),
  };
}
