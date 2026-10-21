// npm run web             the dashboard, the pitch pages and the webhook (no worker)
// npm start               the same, with the worker in the process (what the VPS runs)
import { makeApp } from '../src/app.ts';
import { listen } from '../src/web/server.ts';
import { startWorker } from '../src/jobs/worker.ts';

const app = await makeApp();
const { port } = await listen(app);
app.log(`[web] http://127.0.0.1:${port} (model: ${app.llm.backend}, WhatsApp: ${app.wa.kind}, db: ${app.db.kind})`);
const worker = process.argv.includes('--worker') ? startWorker(app) : null;
if (worker) app.log('[worker] running');
const stop = async () => {
  await worker?.stop();
  await app.db.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
