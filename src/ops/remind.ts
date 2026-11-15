import type { App } from '../app.ts';
import { customerQuiet, now } from '../core/clock.ts';
import { cleanLine } from '../core/hebrew.ts';
import { J } from '../db/index.ts';
import { OpsError, sendNow } from './actions.ts';
import { sendBoth, sendTeder } from './both.ts';
import { outreachLive, SAID_HE } from './outreach.ts';

// The one reminder, sent by itself (the owner, 2026-11-15: "19 messages, 0 replies. redo that part. from start until the
// end ... i want it working and i want costumers"). Until that day it went only when the operator pressed send on a lead
// whose "הגיע הזמן לתזכורת" showed, and none of the 19 got one. Now the schedule presses it: the same send the
// operator's button makes (ops/actions.ts sendNow, ops/both.ts sendBoth and sendTeder), with every one of its checks (the
// reminder's own day, four days on and off Shabbat; the lead's state; and sendPitch's way out, quiet hours, day's cap and
// Meta's quality), for a first pitch that reached the store (Meta took it and did not say it failed) and that nobody
// answered, pressed yes on, or tried the demo of since. One that did not arrive is written to by email instead
// (ops/emailPitch.ts). TORAN_OUTREACH_AUTO=0 stops it.

/** The operator's name on a reminder the schedule sent. */
export const AUTO_BY = 'תזכורת אוטומטית';
/** How many reminders one pass sends at most: the day's cap holds anyway, and a pass runs every minute. */
const PER_PASS = 3;
/**
 * sendPitch's refusals that pass (the operator's sends throw them as they are): the pitch waits, nothing is kept. A send
 * Meta refused is not among them: asked again every minute, a rejected template would fail all day.
 */
const HOLD = new Set([SAID_HE.cap, SAID_HE.quiet, SAID_HE.quality, SAID_HE.no_line]);

export const autoOutreach = (env: Record<string, string | undefined>) => String(env.TORAN_OUTREACH_AUTO ?? '1').trim() !== '0';

type Due = { id: number; product: 'toran' | 'teder' | 'both'; ref: string; storeId: number };

/** The first pitches whose reminder is due: reached, unanswered, four days old at least, two weeks at most. */
async function dueReminders(app: App): Promise<Due[]> {
  const rows = await app.db.query<{ id: number; data: any }>(
    `SELECT e.id, e.data FROM events e
     WHERE e.store_id IS NULL AND e.kind = 'outreach_wa' AND e.data->>'stage' = 'first' AND e.data->>'state' = 'sent'
       AND e.data->>'yes' IS NULL AND e.data->>'replied' IS NULL AND e.data->>'remind' IS NULL
       AND e.at < now() - interval '4 days' AND e.at > now() - interval '14 days'
       AND NOT EXISTS (SELECT 1 FROM outreach_stops s WHERE s.phone = e.data->>'phone')
       AND NOT EXISTS (SELECT 1 FROM events r WHERE r.store_id IS NULL AND r.kind = 'outreach_wa' AND r.data->>'phone' = e.data->>'phone' AND r.data->>'stage' = 'reminder' AND r.data->>'state' IN ('sending', 'sent', 'undelivered'))
     ORDER BY e.id LIMIT 20`,
  );
  const out: Due[] = [];
  for (const r of rows) {
    const m = /^(?:toran|store):(\d+)$/.exec(String(r.data?.ref || ''));
    const product = r.data?.product;
    if (!m || !['toran', 'teder', 'both'].includes(product)) {
      // A pitch of Teder's own lists or the website's demo requests: theirs to remind, not ours.
      await skip(app, r.id, 'not_ours');
      continue;
    }
    out.push({ id: r.id, product, ref: String(r.data.ref), storeId: Number(m[1]) });
  }
  return out;
}

/** A pitch whose reminder will not go, kept so the next pass does not ask again. */
const skip = (app: App, id: number, why: string) => app.db.query("UPDATE events SET data = data || $2::jsonb WHERE id = $1 AND kind = 'outreach_wa'", [id, J({ remind: why })]);

/** What stops a reminder for this store: lost, set aside, taken down, or they tried the demo since the pitch. */
async function settled(app: App, d: Due): Promise<string | null> {
  const s = await app.db.one<{ lost: boolean; skipped: boolean; down: boolean; tried: boolean }>(
    `SELECT lost_at IS NOT NULL AS lost, status = 'skipped' AS skipped, taken_down_at IS NOT NULL AS down,
            demo_started_at IS NOT NULL AND demo_started_at > (SELECT at FROM events WHERE id = $2) AS tried
     FROM stores WHERE id = $1`,
    [d.storeId, d.id],
  );
  if (!s) return 'no_store';
  return s.lost ? 'lost' : s.skipped ? 'skipped' : s.down ? 'taken_down' : s.tried ? 'tried' : null;
}

/**
 * The reminders due now, sent as the operator's button sends them. Returns how many went. A refusal that will not
 * change (already reminded, answered, stopped, the page gone) is kept on the pitch so it is not asked again; one that
 * will (night, Shabbat, the day's cap, Meta's quality, not yet the day) ends the pass and is asked again later.
 */
export async function remindDue(app: App): Promise<number> {
  if (!autoOutreach(app.env) || customerQuiet(now())) return 0;
  const due = await dueReminders(app);
  if (!due.length || !(await outreachLive(app))) return 0;
  let sent = 0;
  for (const d of due) {
    if (sent >= PER_PASS) break;
    const held = await settled(app, d);
    if (held) {
      await skip(app, d.id, held);
      continue;
    }
    try {
      const said = d.product === 'both' ? await sendBoth(app, d.storeId, AUTO_BY) : d.product === 'teder' ? await sendTeder(app, d.storeId, AUTO_BY) : await sendNow(app, 'toran', String(d.storeId), AUTO_BY);
      sent++;
      app.log(`[outreach] reminder ${d.product} ${d.ref}: ${cleanLine(said, 160)}`);
    } catch (e: any) {
      const said = String(e?.message || e);
      // Not yet its day (Shabbat moved it): asked again on a later pass, quietly.
      if (/^עוד לא הזמן לתזכורת/.test(said)) continue;
      // The day's cap, Meta's quality or our number: nothing more goes on this pass, and the pitch is asked again later.
      if (HOLD.has(said)) {
        app.log(`[outreach] reminders held: ${cleanLine(said, 160)}`);
        break;
      }
      if (!(e instanceof OpsError)) app.log(`[outreach] !!! reminder ${d.product} ${d.ref} failed: ${cleanLine(said, 200)}`);
      await skip(app, d.id, cleanLine(said, 120) || 'refused');
    }
  }
  return sent;
}
