import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { App } from '../app.ts';
import { cleanLine } from '../core/hebrew.ts';
import { toIntl } from '../core/urls.ts';
import { J } from '../db/index.ts';
import { event, usage } from '../db/log.ts';
import { metaLinesAdapter } from '../channels/lines.ts';

// A word to the operator, for what nobody would otherwise see: a customer's message that failed every attempt, a
// message waiting in the queue too long, a store near or past its spend cap, a burst at one store, and Teder's alerts,
// which Teder hands over (alertRoute.ts, POST /internal/ops/alert). Each goes to:
//
//   the log            always, `[alert] <title>: <body>`
//   the alert command  TORAN_ALERT_CMD, else /usr/local/bin/of-alert when that file exists, as `<cmd> "<title>" "<body>"`
//                      (off: none). of-alert is the server set-up's (the ops repository): it was not on the server on
//                      2026-11-03 (SERVER-FACTS.md, and neither variable was set), so until `ls -l /usr/local/bin/of-alert`
//                      shows it, this is nothing. Teder's alerts are not run through it here: Teder runs its own
//   WhatsApp           TORAN_ALERT_WA, the owner's own number in any spelling (the owner, 2026-11-03: "alerts can be sent
//                      to my own whatsapp"): one message from our number on Meta's Cloud API (channels/lines.ts, the
//                      token and number our demo line uses), always the approved template operator_alert below. Outside
//                      the 24 hours after the owner last wrote to our number Meta allows nothing else, and a template
//                      goes inside them too, so it is the one kind that is always delivered. Empty: no WhatsApp
//
// Approved or not is Meta's to say. The template goes by its name and Meta's refusal is read, instead of a list of
// approved names in the settings as the owner line has (META_TEMPLATES): the alert after Meta approves it goes, with no
// setting to change and no restart, and a list can be wrong both ways, saying approved when Meta has not (refused the
// same way) or not updated when it has (every alert kept off the phone without a word).
//
// How often. The same key is said at most once in `everyMinutes` (an event of kind operator_alert keeps when; Teder's
// keys are teder:<its key>, in Teder's own window), so a stuck queue is one alert a window, not one a minute. The phone
// has three more limits over both products, from the events of kind operator_alert_wa (each try, sent or refused):
//   - one key reaches it at most once an hour, however short its window (Teder alerts on every start that finds its
//     sign-up switch wrong, ten minutes apart while it restarts over and over);
//   - after Meta refuses one (before approval, every one is refused), none is tried for an hour, since each alert in that
//     hour would be refused the same way;
//   - at most WA_HOUR_MAX in any hour, whatever their keys: a burst of different problems is not a burst of messages.
// What the phone does not get is still in the log and the command. Nothing here ever throws: an alert that cannot go
// out is a log line.

const DEFAULT_CMD = '/usr/local/bin/of-alert';

/** The window of the phone's limits, in minutes, and how many alerts it gets in one. */
export const WA_HOUR_MINUTES = 60;
export const WA_HOUR_MAX = 10;

export type AlertTemplate = { name: string; category: 'UTILITY'; language: 'he'; body: string; example: string[] };

/**
 * The template, as it was submitted in WhatsApp Manager on 2026-11-03 (docs/whatsapp-templates.md is written from it by
 * scripts/templates-doc.ts). {{1}} is the alert's title, {{2}} its body. No header, footer or button: it goes to the
 * owner alone, about their own system, and asks for nothing back. Submitted as Utility; Meta's precheck called it
 * Marketing, so it may be approved as that (it is still sent by its name) or rejected (every try is refused, loudly).
 */
export const OPERATOR_ALERT: AlertTemplate = {
  name: 'operator_alert',
  category: 'UTILITY',
  language: 'he',
  body: 'עדכון על החשבון שלכם ב-OpenFrequency:\n{{1}}\n{{2}}\nאת הפרטים המלאים אפשר לראות בלוח הבקרה של החשבון.',
  example: ['תדר: החשבון football לא הכין פוסט היום', 'בבדיקה של הבוקר לא נמצאה טיוטה חדשה.'],
};

/** Meta's limit on a body parameter (1,024 characters); here it is the limit on the whole message once both are in. */
const MESSAGE_MAX = 1024;
const TITLE_MAX = 200;

/** One line (cleanLine: every control character, newline and tab a space, every run of spaces one), at most `max` characters, clipped with "…". */
const clip = (s: unknown, max: number) => {
  const c = Array.from(cleanLine(s, 100_000));
  return c.length > max ? `${c.slice(0, max - 1).join('')}…` : c.join('');
};

/**
 * {{1}} and {{2}} as Meta takes them: no newline, no tab and never two spaces in a row (Meta refuses more than four),
 * never empty (a dash instead), the title at most 200 characters and the body at most what is left of 1,024 once the
 * template's own text and the title are in, so the message as the owner reads it is at most 1,024 characters.
 */
export function alertParams(title: unknown, body: unknown): [string, string] {
  const t = clip(title, TITLE_MAX) || '-';
  const room = MESSAGE_MAX - Array.from(OPERATOR_ALERT.body.replace(/\{\{\d+\}\}/g, '')).length - Array.from(t).length;
  return [t, clip(body, room) || '-'];
}

/** The template as the owner reads it, filled in. */
export const alertFilled = (vars: string[]) => OPERATOR_ALERT.body.replace(/\{\{(\d+)\}\}/g, (_, i) => vars[Number(i) - 1] ?? '');

/** TORAN_ALERT_WA in international digits (0500000123 and +972 50-000-0123 alike), or null: no WhatsApp alerts. */
export const alertNumber = (env: Record<string, string | undefined>): string | null => toIntl(String(env.TORAN_ALERT_WA || '').trim());

type Run = typeof execFile;

export async function alertOperator(
  app: App,
  key: string,
  title: string,
  body: string,
  { everyMinutes = 60, storeId = null, from = 'toran', run = execFile }: { everyMinutes?: number; storeId?: number | null; from?: 'toran' | 'teder'; run?: Run } = {},
): Promise<boolean> {
  // Recorded in the same statement that asks whether it was said in the window, so two at once rarely both go.
  let kept = false;
  try {
    const fresh = await app.db.one(
      `INSERT INTO events (store_id, kind, data) SELECT $1::integer, 'operator_alert', $2::jsonb
        WHERE NOT EXISTS (SELECT 1 FROM events WHERE kind = 'operator_alert' AND data->>'key' = $3 AND at > now() - ($4 || ' minutes')::interval)
        RETURNING id`,
      [storeId, J({ key, title: cleanLine(title, 120) }), key, String(everyMinutes)],
    );
    if (!fresh) return false;
    kept = true;
  } catch (e: any) {
    app.log(`[alert] could not record ${key}: ${e?.message || e}`);
  }
  app.log(`[alert] ${title}: ${cleanLine(body, 400)}`);
  await Promise.all([
    from === 'toran' ? command(app, title, body, run) : null,
    // Without the record its repeats could not be held back, so it does not go to the phone.
    kept ? toPhone(app, key, from === 'toran' ? `תורן: ${title}` : title, body) : alertNumber(app.env) ? app.log('[alert] !!! WhatsApp NOT SENT: the alert could not be recorded, so its repeats could not be held back') : null,
  ]);
  return true;
}

async function command(app: App, title: string, body: string, run: Run): Promise<void> {
  const cmd = String(app.env.TORAN_ALERT_CMD || '').trim() || (existsSync(DEFAULT_CMD) ? DEFAULT_CMD : '');
  if (!cmd || app.env.TORAN_ALERT_CMD === 'off') return;
  await new Promise<void>((resolve) => {
    run(cmd, [`תורן: ${cleanLine(title, 120)}`, cleanLine(body, 1000)], { timeout: 10_000 }, (err) => {
      if (err) app.log(`[alert] ${cmd} failed: ${err.message}`);
      resolve();
    });
  });
}

/** Why the phone does not get this one now (loud: because Meta refused one), or null when it may. */
async function heldBack(app: App, key: string): Promise<{ why: string; loud: boolean } | null> {
  const r = await app.db.one<{ sent: number; same: number; refused: Date | string | null }>(
    `SELECT COUNT(*) FILTER (WHERE data->>'ok' = 'true')::int AS sent,
            COUNT(*) FILTER (WHERE data->>'ok' = 'true' AND data->>'key' = $1)::int AS same,
            MAX(at) FILTER (WHERE data->>'ok' = 'false') AS refused
       FROM events WHERE store_id IS NULL AND kind = 'operator_alert_wa' AND at > now() - ($2 || ' minutes')::interval`,
    [key, String(WA_HOUR_MINUTES)],
  );
  if (r?.refused) return { why: `Meta refused one at ${new Date(r.refused).toISOString().slice(11, 16)} UTC, and none is tried for ${WA_HOUR_MINUTES} minutes after that`, loud: true };
  if (r?.same) return { why: `this alert went to WhatsApp in the last ${WA_HOUR_MINUTES} minutes`, loud: false };
  if ((r?.sent || 0) >= WA_HOUR_MAX) return { why: `${WA_HOUR_MAX} alerts went to WhatsApp in the last ${WA_HOUR_MINUTES} minutes`, loud: false };
  return null;
}

/** Meta's code for a template it does not have in that language: not approved yet, rejected, or never created (its error-code page). */
const NO_SUCH_TEMPLATE = 132001;

// A WhatsApp alert that did not reach the phone is said loudly ("[alert] !!! ..."), never left out: the template not
// approved, Meta not answering, no number of ours on Meta, or a message Meta took and then could not deliver.

async function toPhone(app: App, key: string, title: string, body: string): Promise<void> {
  const to = alertNumber(app.env);
  if (!to) {
    if (String(app.env.TORAN_ALERT_WA || '').trim()) app.log('[alert] !!! TORAN_ALERT_WA is not a phone number, so no alert goes to WhatsApp');
    return;
  }
  const who = `WhatsApp to …${to.slice(-4)}`;
  let held: { why: string; loud: boolean } | null;
  try {
    held = await heldBack(app, key);
  } catch (e: any) {
    held = { why: `the last ${WA_HOUR_MINUTES} minutes could not be read: ${e?.message || e}`, loud: true };
  }
  if (held) return app.log(held.loud ? `[alert] !!! ${who} NOT SENT: ${held.why}; the alert is in this log` : `[alert] ${who}: not sent (${held.why}); the alert is in this log`);
  let id = '';
  try {
    const sent = await metaLinesAdapter(app).push(to, { template: { name: OPERATOR_ALERT.name, sid: OPERATOR_ALERT.name, vars: alertParams(title, body) }, from: null });
    id = sent.id;
    await usage(app.db, { kind: 'bsp', backend: 'meta_line', units: 1, usd: sent.usd, apiUsd: sent.usd, tag: 'wa_alert' }).catch(() => {});
  } catch (e: any) {
    const code = typeof e?.code === 'number' ? e.code : null;
    const why = cleanLine(e?.message || e, 300);
    await refused(app, key, code, why);
    const hint = code === NO_SUCH_TEMPLATE ? ` (${OPERATOR_ALERT.name} is not approved in WhatsApp Manager: in review, rejected, or never created there; docs/whatsapp-templates.md)` : '';
    app.log(`[alert] !!! ${who} FAILED: ${why}${hint}. No WhatsApp alert is tried for ${WA_HOUR_MINUTES} minutes; the alert is in this log`);
    return;
  }
  await event(app.db, null, 'operator_alert_wa', { key, ok: true, id: id || null }).catch((e) => app.log(`[alert] ${who}: sent, but not recorded: ${e?.message || e}`));
  app.log(`[alert] ${who}: sent`);
}

/** A try Meta refused, kept so the phone is not tried again for the hour. */
const refused = (app: App, key: string, code: number | null, error: string) => event(app.db, null, 'operator_alert_wa', { key, ok: false, code, error }).catch(() => {});

/**
 * Meta's later word that a message from our number failed (waStore.ts deliveryStatus, the webhook's failed status): when
 * it was an alert, it is said loudly and kept as a refusal, so the hour after it holds the phone as a refusal does
 * (a Marketing template over Meta's limit for one person, say). True when it was an alert.
 */
export async function alertNotDelivered(app: App, s: { id: string; error: string | null }): Promise<boolean> {
  if (!s.id) return false;
  const r = await app.db.one<{ key: string }>("SELECT data->>'key' AS key FROM events WHERE store_id IS NULL AND kind = 'operator_alert_wa' AND data->>'id' = $1 LIMIT 1", [s.id]);
  if (!r) return false;
  const code = Number(/^(d+):/.exec(String(s.error || ''))?.[1]) || null;
  await refused(app, r.key, code, `not delivered: ${cleanLine(s.error || 'no reason given', 200)}`);
  app.log(`[alert] !!! WhatsApp FAILED: Meta took the alert ${r.key} and then could not deliver it (${cleanLine(s.error || 'no reason given', 200)}). No WhatsApp alert is tried for ${WA_HOUR_MINUTES} minutes`);
  return true;
}

/** The operator_alert section of docs/whatsapp-templates.md (scripts/templates-doc.ts). */
export function alertTemplateDoc(): string {
  const t = OPERATOR_ALERT;
  return [
    `### ${t.name}`,
    '',
    '| | |',
    '|---|---|',
    `| Name | ${t.name} |`,
    '| Category | Utility |',
    `| Language | Hebrew (${t.language}) |`,
    '| Header, footer, buttons | none |',
    `| Variables (sample) | ${t.example.map((e, i) => `{{${i + 1}}} = ${e}`).join('; ')} |`,
    '',
    'The body, four lines, exactly:',
    '',
    '```',
    t.body,
    '```',
    '',
    `As the owner reads it: ${alertFilled(t.example).split('\n').join(' / ')}`,
    '',
  ].join('\n');
}
