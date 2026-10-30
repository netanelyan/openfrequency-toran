import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { App } from '../app.ts';
import { cleanLine } from '../core/hebrew.ts';
import { event } from '../db/log.ts';

// A word to the operator, for what nobody would otherwise see: a customer's message that failed every attempt, a
// message waiting in the queue too long, a store near or past its spend cap, a burst at one store. It goes to the log
// always, and to the server's alert command (TORAN_ALERT_CMD, else /usr/local/bin/of-alert when that file exists) as
// `<cmd> "<title>" "<body>"`. of-alert is the server set-up's (the ops repository): it is not on the server as of
// 2026-10-29 (SERVER-FACTS.md), so until `ls -l /usr/local/bin/of-alert` shows it, an alert is a log line. The same key is said at
// most once in `everyMinutes` (an event of kind operator_alert keeps when), so a stuck queue is one message, not one a
// minute. Nothing here ever throws: an alert that cannot go out is a log line.

const DEFAULT_CMD = '/usr/local/bin/of-alert';

export async function alertOperator(app: App, key: string, title: string, body: string, { everyMinutes = 60, storeId = null }: { everyMinutes?: number; storeId?: number | null } = {}): Promise<boolean> {
  try {
    const seen = await app.db.one("SELECT 1 FROM events WHERE kind = 'operator_alert' AND data->>'key' = $1 AND at > now() - ($2 || ' minutes')::interval", [key, String(everyMinutes)]);
    if (seen) return false;
    await event(app.db, storeId, 'operator_alert', { key, title: cleanLine(title, 120) });
  } catch (e: any) {
    app.log(`[alert] could not record ${key}: ${e?.message || e}`);
  }
  app.log(`[alert] ${title}: ${cleanLine(body, 400)}`);
  const cmd = String(app.env.TORAN_ALERT_CMD || '').trim() || (existsSync(DEFAULT_CMD) ? DEFAULT_CMD : '');
  if (!cmd || app.env.TORAN_ALERT_CMD === 'off') return true;
  await new Promise<void>((resolve) => {
    execFile(cmd, [`תורן: ${cleanLine(title, 120)}`, cleanLine(body, 1000)], { timeout: 10_000 }, (err) => {
      if (err) app.log(`[alert] ${cmd} failed: ${err.message}`);
      resolve();
    });
  });
  return true;
}
