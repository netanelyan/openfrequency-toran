// npm run demo: the whole product on the fictional store, offline, no keys.
//
// A throwaway home in .demo/ (gitignored), the fictional store run through the real
// pipeline, a WhatsApp demo through the router, and the dashboard on
// http://127.0.0.1:4711 (user "demo", password "demo-password-123"). The model is a
// scripted stand-in unless --live, which uses the Claude Code CLI on the subscription.

import { rmSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/core/paths.ts';
import { makeApp } from '../src/app.ts';
import { openDb } from '../src/db/index.ts';
import { exampleFetcher } from '../src/demo.ts';
import { scriptedClient } from '../src/agent/llm/scripted.ts';
import { cliClient } from '../src/agent/llm/cli.ts';
import { simProvider } from '../src/wa/providers.ts';
import { listen } from '../src/web/server.ts';
import { startWorker } from '../src/jobs/worker.ts';
import { DEMO_USER, seedDemo } from '../src/demoSeed.ts';

const home = path.join(ROOT, '.demo');
if (!process.argv.includes('--keep')) rmSync(home, { recursive: true, force: true });
const live = process.argv.includes('--live');
const env: Record<string, string | undefined> = { ...process.env, TORAN_HOME: home, TORAN_EMBED: process.env.TORAN_EMBED || 'off', PORT: '4711', DEMO_WA_NUMBER: '972500000999', PUBLIC_BASE_URL: 'http://127.0.0.1:4711', SESSION_SECRET: 'demo-session-secret-not-for-production-use-0000', DATABASE_URL: '', TORAN_OWNER_WHATSAPP: '972500000777' };
const db = await openDb({ env });
const app = await makeApp({ env, db, fetcher: exampleFetcher(), llm: live ? cliClient({ env }) : scriptedClient(), wa: simProvider() });
app.render = async () => null;
console.log(`seeding the fictional store (${live ? 'the agent on the Claude Code CLI' : 'a scripted model'})...`);
const seeded = await seedDemo(app);
const { port } = await listen(app, { port: 4711 });
const worker = startWorker(app);
console.log(`\nthe dashboard: http://127.0.0.1:${port}  (user ${DEMO_USER.name}, password ${DEMO_USER.password})`);
console.log(`the pitch page: http://127.0.0.1:${port}/s/${seeded.slug}`);
console.log('ctrl+c to stop');
process.on('SIGINT', async () => {
  await worker.stop();
  await app.db.close();
  process.exit(0);
});
