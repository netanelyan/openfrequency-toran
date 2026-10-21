import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type App, makeApp } from '../src/app.ts';
import { openDb } from '../src/db/index.ts';
import { exampleFetcher } from '../src/demo.ts';
import { scriptedClient, type Script } from '../src/agent/llm/scripted.ts';
import { simProvider } from '../src/wa/providers.ts';

// A throwaway app for a test: an in-memory database, the fictional store as the whole
// internet, a scripted model, the simulated WhatsApp provider, and a private folder in
// the temp directory. No network, no keys, no subscription.

export async function testApp({ script }: { script?: Script } = {}): Promise<App> {
  const home = mkdtempSync(path.join(os.tmpdir(), 'toran-test-'));
  const env = { TORAN_HOME: home, TORAN_EMBED: 'off', TORAN_LLM: 'scripted', SESSION_SECRET: 'x'.repeat(40), TORAN_ADMIN_PASSWORD: 'correct horse battery', TORAN_ADMIN_USER: 'owner' } as Record<string, string>;
  const db = await openDb({ memory: true });
  const app = await makeApp({ env, db, fetcher: exampleFetcher(), llm: scriptedClient(script), wa: simProvider(), quiet: true });
  app.render = async () => null;
  return app;
}
