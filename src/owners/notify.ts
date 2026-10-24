import type { App } from '../app.ts';
import { HOUR } from '../core/clock.ts';
import { J } from '../db/index.ts';
import { event, usage } from '../db/log.ts';
import type { Part } from '../channels/send.ts';
import type { WaOut } from '../channels/whatsapp.ts';
import { mayNotify, type Owner } from './identity.ts';
import { filled, templateSid, TEMPLATES } from './templates.ts';
import type { PostId } from './teder.ts';

// The one place Toran writes to someone who did not just write: a business owner's own number, about their own Teder
// account. Every rule is checked here, in code, before anything goes out, and every attempt is a row in
// owner_notifications, sent or not:
//
//   the number         accounts vouched for it a moment ago (the caller asked), and its workspace has Teder
//   consent            the latest word is an opt-in (accounts, and a "הפסק" kept here), else skipped
//   quiet time         Teder's own: it holds its events through the owner's quiet hours and Shabbat before it
//                      sends them (its docs/assistant-api.md), so what reaches here may go out
//   the limit          at most PUSHES_PER_DAY messages started to one number in 24 hours, else skipped
//   the window         inside 24 hours of the owner's last message: text and images; outside: the approved
//                      template only, or nothing ('no_template') while its SID is not set
//   the disclosure     the first message to each number says it is a digital assistant (a template's footer says
//                      it every time)
//
// A rule that cannot be checked (accounts or Teder did not answer) stops the message: the caller retries later.

export const PUSHES_PER_DAY = 8;
const WINDOW_MARGIN_MS = 10 * 60_000;
export const DISCLOSURE = 'כאן תורן, העוזר הדיגיטלי של OpenFrequency (תוכנה, לא בן אדם).';

/** The owner line's number: what Toran's messages to owners come from (TWILIO_WHATSAPP_FROM while it is unset). */
export const lineNumber = (env: Record<string, string | undefined>) => String(env.TORAN_ASSISTANT_WA || '').replace(/\D/g, '') || null;

export type Push = {
  kind: string; // the event's type
  eventId: string | null;
  workspaceId: number;
  session: Part[]; // inside the window
  template: { name: string; vars: string[] } | null; // outside it
  list?: { items: { id: PostId; hook: string }[]; source: string }; // the posts it shows, numbered from 1
};
export type Outcome = 'sent' | 'skipped' | 'failed';

/** The owner's row here: what accounts said a moment ago, kept with what only Toran knows (opt-out, disclosure, window). */
export async function rememberOwner(app: App, o: Owner, { inboundAt = null }: { inboundAt?: number | null } = {}) {
  return (await app.db.one<{ opted_out_at: string | null; disclosed_at: string | null; last_inbound_at: string | null }>(
    `INSERT INTO owner_numbers (phone, workspace_id, user_id, products, checked_at, last_inbound_at) VALUES ($1, $2, $3, $4, now(), $5)
     ON CONFLICT (phone) DO UPDATE SET workspace_id = EXCLUDED.workspace_id, user_id = EXCLUDED.user_id, products = EXCLUDED.products, checked_at = now(),
       last_inbound_at = COALESCE(EXCLUDED.last_inbound_at, owner_numbers.last_inbound_at)
     RETURNING opted_out_at, disclosed_at, last_inbound_at`,
    [o.phone, o.workspace.id, o.user.id, o.products, inboundAt ? new Date(inboundAt).toISOString() : null],
  ))!;
}

/** Keep the posts an owner was shown, in order: "1" in their next message is the first. */
export async function keepList(app: App, phone: string, workspaceId: number, items: { id: PostId; hook: string }[], source: string) {
  await app.db.query('INSERT INTO owner_lists (phone, workspace_id, items, source) VALUES ($1, $2, $3::jsonb, $4)', [phone, workspaceId, J(items), source]);
}

async function record(app: App, p: Push, phone: string, status: Outcome | 'deferred', f: { mode?: string | null; template?: string | null; reason?: string | null; dueAt?: string | null; detail?: Record<string, unknown> } = {}) {
  await app.db.query(
    'INSERT INTO owner_notifications (event_id, workspace_id, phone, kind, status, mode, template, reason, due_at, detail) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb) ON CONFLICT DO NOTHING',
    [p.eventId, p.workspaceId, phone, p.kind, status, f.mode ?? null, f.template ?? null, f.reason ?? null, f.dueAt ?? null, J(f.detail || {})],
  );
  await event(app.db, null, `owner_push_${status}`, { kind: p.kind, eventId: p.eventId, workspace: p.workspaceId, reason: f.reason ?? null, mode: f.mode ?? null });
}

/** One message (in parts) Toran starts to one owner, under every rule above. */
export async function pushToOwner(app: App, owner: Owner, p: Push): Promise<Outcome> {
  const phone = owner.phone;
  if (p.eventId && (await app.db.one("SELECT 1 FROM owner_notifications WHERE event_id = $1 AND phone = $2 AND status = 'sent'", [p.eventId, phone]))) return 'sent';
  const row = await rememberOwner(app, owner);
  const skip = async (reason: string) => {
    await record(app, p, phone, 'skipped', { reason });
    return 'skipped' as const;
  };
  if (owner.workspace.id !== p.workspaceId || owner.workspace.disabled) return skip('not_this_workspace');
  if (!owner.products.includes('teder')) return skip('no_teder');
  if (!mayNotify(owner, row.opted_out_at)) return skip(owner.optIn ? 'opted_out' : 'no_opt_in');
  const today = await app.db.one<{ n: number }>("SELECT COUNT(*)::int AS n FROM owner_notifications WHERE phone = $1 AND status = 'sent' AND at > now() - interval '24 hours'", [phone]);
  if ((today?.n || 0) >= PUSHES_PER_DAY) return skip('rate_limited');

  const inWindow = row.last_inbound_at && Date.now() - new Date(row.last_inbound_at).getTime() < 24 * HOUR - WINDOW_MARGIN_MS;
  let messages: WaOut[];
  let mode: 'session' | 'template';
  if (inWindow) {
    mode = 'session';
    messages = p.session.map((x) => ('text' in x ? { text: x.text } : { text: x.caption || '', mediaUrl: x.media }));
    if (!row.disclosed_at) {
      const first = messages.findIndex((m) => !m.mediaUrl);
      if (first >= 0) messages[first] = { text: `${DISCLOSURE}\n\n${messages[first].text}` };
      else messages.unshift({ text: DISCLOSURE });
    }
  } else {
    mode = 'template';
    const t = p.template ? TEMPLATES[p.template.name] : null;
    const sid = t ? templateSid(app.env, t.name) : null;
    if (!t || !p.template || !sid) return skip('no_template');
    messages = [{ template: { name: t.name, sid, vars: p.template.vars } }];
  }

  const ids: string[] = [];
  try {
    for (const m of messages) {
      const sent = await app.wa.push(phone, { ...m, from: lineNumber(app.env) });
      await usage(app.db, { kind: 'bsp', backend: app.wa.kind, units: 1, usd: sent.usd, apiUsd: sent.usd, tag: mode === 'template' ? 'wa_template' : 'wa_push' });
      ids.push(sent.id);
    }
  } catch (e: any) {
    app.log(`[owners] push ${p.kind} to …${phone.slice(-4)} failed after ${ids.length} of ${messages.length}: ${e?.message || e}`);
    await record(app, p, phone, 'failed', { mode, reason: String(e?.message || e).slice(0, 300), detail: { sent: ids.length, of: messages.length } });
    return 'failed';
  }
  await app.db.query('UPDATE owner_numbers SET disclosed_at = COALESCE(disclosed_at, now()) WHERE phone = $1', [phone]);
  if (p.list) await keepList(app, phone, p.workspaceId, p.list.items, p.list.source);
  const t = mode === 'template' ? TEMPLATES[p.template!.name] : null;
  await record(app, p, phone, 'sent', { mode, template: t?.name ?? null, detail: { ids, ...(t ? { text: filled(t, p.template!.vars) } : { parts: p.session.length }) } });
  return 'sent';
}
