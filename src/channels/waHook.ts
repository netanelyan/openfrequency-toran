import type { App } from '../app.ts';
import { enqueue } from '../jobs/queue.ts';
import { outreachPhoneId } from '../ops/outreach.ts';
import type { parseWebhook } from './meta.ts';

type Parsed = ReturnType<typeof parseWebhook>;

/**
 * A WhatsApp webhook in Meta's shape, read (meta.ts parseWebhook), into the queue: the customers' messages, the
 * owner's answers from the phone, failed deliveries, template news and account changes. Meta's own webhook
 * (/meta/webhook) and Kapso's forward of it (/kapso/webhook, kapso.ts) both come here, so a store's number behaves the
 * same whichever way it is connected. `keep`, when given, is the set of phone number ids this webhook may speak for:
 * anything about another number is dropped (Kapso's forward speaks only for numbers connected through Kapso).
 * Every job is keyed by Meta's own id, so a delivery that comes twice is queued once.
 */
export async function takeWhatsapp(app: App, w: Parsed, keep?: Set<string> | null, { prefix = '' }: { prefix?: string } = {}) {
  const ok = (account: string) => !keep || keep.has(String(account || '').replace(/\D/g, ''));
  let dropped = 0;
  // Stamped on arrival, as on Twilio's: the reply window is measured from here.
  for (const msg of w.messages) {
    if (!ok(msg.account || '')) {
      dropped++;
      continue;
    }
    await enqueue(app.db, 'wa_inbound', { ...msg, at: Date.now() }, { dedupeKey: `wa:${msg.id}` });
  }
  for (const e of w.echoes) {
    if (!ok(e.account)) {
      dropped++;
      continue;
    }
    await enqueue(app.db, 'wa_echo', e, { dedupeKey: `wa_echo:${e.id}` });
  }
  // A failure of any number's message; and on our outreach number, a delivery and a read too, so a pitch shows how far it
  // got (ops/outreach.ts pitchStatus). Every other number's deliveries and reads are not kept.
  const outreach = w.statuses.some((x) => x.status === 'delivered' || x.status === 'read') ? await outreachPhoneId(app).catch(() => null) : null;
  for (const s of w.statuses.filter((x) => x.status === 'failed' || ((x.status === 'delivered' || x.status === 'read') && outreach && String(x.account) === outreach))) {
    if (!ok(s.account)) {
      dropped++;
      continue;
    }
    await enqueue(app.db, 'wa_status', s, { dedupeKey: s.status === 'failed' ? `wa_status:${s.id}` : `wa_status:${s.id}:${s.status}`, maxAttempts: 1 });
  }
  // A store's template approved, rejected or moved to another category (auto/templates.ts), matched by the store's WABA.
  for (const t of w.templates) await enqueue(app.db, 'wa_template_status', t, { maxAttempts: 2 });
  for (const waba of w.accounts) {
    const rows = await app.db.query<{ id: number }>("SELECT id FROM channel_accounts WHERE channel = 'whatsapp' AND kind IN ('meta', 'kapso') AND status <> 'off' AND meta->>'waba_id' = $1", [waba]);
    for (const a of rows) await enqueue(app.db, 'wa_check', { accountId: a.id }, { dedupeKey: `${prefix}wa_check:${a.id}`, maxAttempts: 1 });
  }
  return { dropped };
}
