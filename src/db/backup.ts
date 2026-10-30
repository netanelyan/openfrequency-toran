import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

// How old the newest backup is, for the deploy's migrate step (scripts/migrate.ts): a migration runs on the production
// database only after a backup under BACKUP_FRESH_MS old. The nightly job and the deploy write their dumps to
// TORAN_BACKUP_DIR (deploy/toran-backup.sh); a deploy that cannot read that folder (it is root's, mode 700) passes the
// time of the dump it took and checked as TORAN_BACKUP_TAKEN_AT.

export const BACKUP_FRESH_MS = 60 * 60_000;
export const DEFAULT_BACKUP_DIR = '/var/backups/toran';
/** The dumps the backup job writes (a deploy's carries a label: toran-20261029-120000-pre-1a2b3c.dump): the custom format, and the gzipped SQL of the job before it. */
const DUMP = /^toran-\d{8}-\d{4,6}(-[\w.-]+)?\.(dump|sql\.gz)$/;

type Env = Record<string, string | undefined>;

/** Milliseconds since the newest backup, or null when there is none to be seen. */
export function backupAgeMs(env: Env = process.env, now = Date.now()): number | null {
  const ages: number[] = [];
  const dir = String(env.TORAN_BACKUP_DIR || DEFAULT_BACKUP_DIR);
  try {
    for (const f of readdirSync(dir)) {
      if (!DUMP.test(f)) continue;
      const st = statSync(path.join(dir, f));
      if (st.size > 0) ages.push(now - st.mtimeMs);
    }
  } catch {
    /* not there, or not ours to read */
  }
  const taken = Date.parse(String(env.TORAN_BACKUP_TAKEN_AT || ''));
  if (Number.isFinite(taken)) ages.push(now - taken);
  const fresh = ages.filter((a) => a >= -60_000);
  return fresh.length ? Math.max(0, Math.min(...fresh)) : null;
}
