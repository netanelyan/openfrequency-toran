// npm run worker: the job worker alone (WhatsApp messages, ingest, the daily re-scrape).
// With PGlite (development) run `npm start` instead: PGlite is one process's database.
import { makeApp } from '../src/app.ts';
import { startWorker } from '../src/jobs/worker.ts';

const app = await makeApp();
if (app.db.kind === 'pglite') app.log('[worker] note: with PGlite, run the worker inside `npm start` instead of beside it');
const w = startWorker(app);
app.log('[worker] running');
const stop = async () => {
  await w.stop();
  await app.db.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
