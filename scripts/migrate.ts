// npm run migrate: bring the database's schema up to date (openDb does it too; this says what it applied).
import { loadEnv } from '../src/core/env.ts';
import { openDb, migrate } from '../src/db/index.ts';

loadEnv();
const db = await openDb();
const applied = await migrate(db);
console.log(applied.length ? `applied: ${applied.join(', ')}` : `up to date (${db.kind})`);
await db.close();
