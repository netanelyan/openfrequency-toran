// npm run migrate [-- --check [--files <a release's src/db/migrations>]] [-- --no-backup-check]
//
// The deploy's migrate step (deploy/deploy.sh): bring the database's schema up to date, and say what it applied.
//
//   --check            apply nothing: exit 0 when the schema is this build's, 2 when it lacks migrations, 3 when it
//                      holds one this build does not know (a newer build moved it on: rolling back onto it is refused,
//                      deploy/rollback.sh). --files checks against another build's migrations: the release a
//                      rollback would start, which may be older than this script
//   in production      (TORAN_ENV=prod on Postgres) a migration is applied only after a backup under an hour old: the
//                      newest dump in TORAN_BACKUP_DIR (/var/backups/toran), or TORAN_BACKUP_TAKEN_AT, which the deploy
//                      sets after the dump it took and checked. --no-backup-check skips that, for a database that
//                      holds nothing yet.
import { loadEnv } from '../src/core/env.ts';
import { openDb, migrate, migrationStatus, SchemaError, type Db } from '../src/db/index.ts';
import { backupAgeMs, BACKUP_FRESH_MS } from '../src/db/backup.ts';

loadEnv();
const argv = process.argv.slice(2);
const args = new Set(argv);
const files = argv.includes('--files') ? argv[argv.indexOf('--files') + 1] : null;
let db: Db;
try {
  // Against another build's migrations, this build's own may be behind the database: open it without its check.
  db = await openDb({ migrate: files ? 'raw' : 'none' });
} catch (e) {
  if (!(e instanceof SchemaError && e.code === 'schema_ahead')) throw e;
  console.error(e.message);
  process.exit(3);
}
try {
  const s = await migrationStatus(db, files || undefined);
  if (s.unknown.length) {
    console.error(`the database holds migrations this build does not know: ${s.unknown.join(', ')}`);
    process.exitCode = 3;
  } else if (args.has('--check') || files) {
    console.log(s.pending.length ? `pending: ${s.pending.join(', ')}` : `up to date (${db.kind}, ${s.applied.length} applied)`);
    process.exitCode = s.pending.length ? 2 : 0;
  } else if (!s.pending.length) {
    console.log(`up to date (${db.kind})`);
  } else {
    const prod = process.env.TORAN_ENV === 'prod' && db.kind === 'postgres';
    const age = backupAgeMs(process.env);
    if (prod && !args.has('--no-backup-check') && !(age != null && age < BACKUP_FRESH_MS)) {
      console.error(`refused: ${s.pending.length} migration(s) to apply and ${age == null ? 'no backup found' : `the newest backup is ${Math.round(age / 60_000)} minutes old`}. Take one first (deploy/toran-backup.sh), then run this again.`);
      process.exitCode = 4;
    } else {
      const applied = await migrate(db);
      console.log(`applied: ${applied.join(', ')}`);
    }
  }
} finally {
  await db.close();
}
