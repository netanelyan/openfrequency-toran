import type { App } from '../app.ts';
import { open } from '../core/secrets.ts';
import { audit, event } from '../db/log.ts';
import { displayName } from '../ingest/brand.ts';
import { lineOf } from '../channels/lines.ts';
import { createTemplate, templatesNamed } from '../channels/meta.ts';
import { KINDS, MESSAGES, templateRequest, type Kind, type MessageKey } from './messages.ts';

// Toran's templates on a store's own WhatsApp account (wa_templates, migration 017). A message the store starts on
// WhatsApp is a template Meta approved for that store's WhatsApp Business Account (WABA), so each store has its own:
// submitTemplates() sends the seven of messages.ts to the store's WABA with the store's token (POST
// /<WABA>/message_templates), and keeps what Meta answered. Meta reviews them, usually within minutes and up to a day,
// and tells our webhook (message_template_status_update), which templateStatus() records; the worker also reads every
// template still pending once an hour (checkTemplates). A kind turns on for WhatsApp only once every template of it is
// APPROVED (approvedFor); Meta may approve a utility template as marketing, which the page shows.
//
// Meta bills the store's WhatsApp account for each template it sends, at its rate for the category and Israel, so the
// store adds a payment method in its WhatsApp Manager (the page says so). Never our shared demo number: a number
// that is one of ours (lines.ts) has no store templates.

type Account = { id: number; store_id: number; external_id: string; secret: string | null; meta: any; status: string };

/** The store's own WhatsApp number on Meta, when it is connected and not one of ours. */
export async function storeWa(app: App, storeId: number): Promise<Account | null> {
  const a = await app.db.one<Account>("SELECT id, store_id, external_id, secret, meta, status FROM channel_accounts WHERE store_id = $1 AND channel = 'whatsapp' AND kind = 'meta' AND status = 'active' AND secret IS NOT NULL ORDER BY id DESC LIMIT 1", [storeId]);
  if (!a || lineOf(app.env, a.external_id) || !a.meta?.waba_id) return null;
  return a;
}

const ALL: MessageKey[] = Object.values(KINDS).flatMap((k) => k.messages);

export type TemplateRow = { name: string; message: MessageKey; asked: string; category: string | null; status: string; why: string | null; submitted_at: string; checked_at: string | null };

export const templatesOf = (app: App, accountId: number) => app.db.query<TemplateRow>('SELECT name, message, asked, category, status, why, submitted_at, checked_at FROM wa_templates WHERE account_id = $1 ORDER BY name', [accountId]);

/**
 * Send the store's templates to Meta for review: every one that is not approved or waiting for Meta. One Meta
 * rejected is sent again; when Meta keeps the name, what it says about it stands, and the reason shows on the page.
 */
export async function submitTemplates(app: App, storeId: number, by: string) {
  const a = await storeWa(app, storeId);
  if (!a) return { sent: 0, refused: 0 };
  const s = await app.db.one<any>('SELECT name, domain, brand, brand_override FROM stores WHERE id = $1', [storeId]);
  const store = displayName(s?.brand_override?.name, s?.brand?.name, s?.name) || s?.domain;
  const token = open(app.env, a.secret!);
  const have = new Map((await templatesOf(app, a.id)).map((t) => [t.name, t]));
  let sent = 0;
  let refused = 0;
  for (const m of ALL) {
    const req = templateRequest(m, store);
    const body = req.components[0].text as string;
    const prev = have.get(req.name);
    if (prev && ['APPROVED', 'PENDING', 'IN_APPEAL'].includes(prev.status)) continue;
    let row: { meta_id: string | null; status: string; category: string | null; why: string | null };
    try {
      const out = await createTemplate(app.env, app.graph, a.meta.waba_id, token, req);
      row = { meta_id: String(out?.id || '') || null, status: String(out?.status || 'PENDING').toUpperCase(), category: String(out?.category || req.category).toUpperCase(), why: null };
      sent++;
    } catch (e: any) {
      // A template of this name is already on the account (from an earlier try): what Meta says about it stands.
      const there = /already exists|2388024/i.test(String(e?.message || '')) ? await readTemplate(app, a.meta.waba_id, token, req.name).catch(() => null) : null;
      row = there || { meta_id: null, status: 'error', category: null, why: String(e?.message || e).slice(0, 300) };
      if (!there) refused++;
    }
    await app.db.query(
      `INSERT INTO wa_templates (account_id, store_id, name, message, asked, category, meta_id, status, why, body, submitted_at, checked_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now(), now())
       ON CONFLICT (account_id, name) DO UPDATE SET asked = EXCLUDED.asked, category = EXCLUDED.category, meta_id = COALESCE(EXCLUDED.meta_id, wa_templates.meta_id), status = EXCLUDED.status, why = EXCLUDED.why, body = EXCLUDED.body, submitted_at = now(), checked_at = now()`,
      [a.id, storeId, req.name, m, req.category, row.category, row.meta_id, row.status, row.why, body],
    );
  }
  await audit(app.db, { actor: by, action: 'wa_templates_submit', storeId, detail: { sent, refused } });
  await event(app.db, storeId, 'wa_templates_submitted', { sent, refused });
  return { sent, refused };
}

async function readTemplate(app: App, waba: string, token: string, name: string) {
  const out = await templatesNamed(app.env, app.graph, waba, token, name);
  const t = (out?.data || []).find((x: any) => x?.name === name && (!x.language || x.language === 'he'));
  if (!t) return null;
  return { meta_id: String(t.id || '') || null, status: String(t.status || '').toUpperCase(), category: t.category ? String(t.category).toUpperCase() : null, why: t.rejected_reason && t.rejected_reason !== 'NONE' ? String(t.rejected_reason) : null };
}

/** Read again every template of this account that Meta has not decided on yet (the worker, hourly). */
export async function checkTemplates(app: App, accountId: number) {
  const a = await app.db.one<Account>("SELECT id, store_id, external_id, secret, meta, status FROM channel_accounts WHERE id = $1 AND kind = 'meta' AND status = 'active'", [accountId]);
  if (!a?.secret || !a.meta?.waba_id) return { checked: 0 };
  const token = open(app.env, a.secret);
  const rows = await app.db.query<{ name: string }>("SELECT name FROM wa_templates WHERE account_id = $1 AND status IN ('PENDING', 'IN_APPEAL')", [a.id]);
  for (const r of rows) {
    const t = await readTemplate(app, a.meta.waba_id, token, r.name).catch(() => null);
    if (t) await app.db.query('UPDATE wa_templates SET status = $3, category = COALESCE($4, category), why = $5, checked_at = now() WHERE account_id = $1 AND name = $2', [a.id, r.name, t.status, t.category, t.why]);
    else await app.db.query('UPDATE wa_templates SET checked_at = now() WHERE account_id = $1 AND name = $2', [a.id, r.name]);
  }
  return { checked: rows.length };
}

export type TemplateUpdate = { waba: string; name: string; status: string | null; category: string | null; reason: string | null };

/** Meta's word on one template (the webhook's message_template_status_update or template_category_update). */
export async function templateStatus(app: App, u: TemplateUpdate) {
  const rows = await app.db.query<{ account_id: number; store_id: number }>("UPDATE wa_templates t SET status = COALESCE($3, t.status), category = COALESCE($4, t.category), why = CASE WHEN $3::text IS NULL THEN t.why ELSE $5 END, checked_at = now() FROM channel_accounts a WHERE a.id = t.account_id AND a.meta->>'waba_id' = $1 AND t.name = $2 RETURNING t.account_id, t.store_id", [u.waba, u.name, u.status ? u.status.toUpperCase() : null, u.category ? u.category.toUpperCase() : null, u.reason && u.reason !== 'NONE' ? u.reason.slice(0, 300) : null]);
  for (const r of rows) await event(app.db, r.store_id, 'wa_template_status', { name: u.name, status: u.status, category: u.category });
  return { updated: rows.length };
}

/** Whether every template of this kind is approved on this account, and what is missing. */
export async function approvedFor(app: App, accountId: number | null, kind: Kind): Promise<{ ok: boolean; missing: string[] }> {
  const names = KINDS[kind].messages.map((m) => MESSAGES[m].template);
  if (!accountId) return { ok: false, missing: names };
  const rows = await app.db.query<{ name: string; status: string }>('SELECT name, status FROM wa_templates WHERE account_id = $1 AND name = ANY($2::text[])', [accountId, names]);
  const ok = new Set(rows.filter((r) => r.status === 'APPROVED').map((r) => r.name));
  const missing = names.filter((n) => !ok.has(n));
  return { ok: !missing.length, missing };
}
