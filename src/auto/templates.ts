import type { App } from '../app.ts';
import { open } from '../core/secrets.ts';
import { audit, event } from '../db/log.ts';
import { displayName } from '../ingest/brand.ts';
import { lineOf } from '../channels/lines.ts';
import { createTemplate, templatesNamed } from '../channels/meta.ts';
import { categoryOf, KINDS, LEGACY, MESSAGES, publicBase, templateRequest, type Kind, type MessageKey } from './messages.ts';

// Toran's templates on a store's own WhatsApp account (wa_templates, migration 017). A message the store starts on
// WhatsApp is a template Meta approved for that store's WhatsApp Business Account (WABA), so each store has its own:
// submitTemplates() sends the seven of messages.ts to the store's WABA with the store's token (POST
// /<WABA>/message_templates), and keeps what Meta answered. Meta reviews them, usually within minutes and up to a day,
// and tells our webhook (message_template_status_update), which templateStatus() records; the worker also reads every
// template still pending once an hour (checkTemplates). A kind turns on for WhatsApp only once every template of it is
// APPROVED (approvedFor); Meta may approve a utility template as marketing, which the page shows.
//
// The two marketing templates changed shape on 2026-10-26: the footer "כתבו הסר" and the quick reply "הסר" gave way
// to one URL button, "הגדרות הודעות", to the customer's page of message settings (messages.ts). A changed template goes
// back to Meta's review either way; under a new name (toran_cart_reminder_v2, toran_review_request_v2) the old one can
// keep sending while the new one waits. A store whose
// old one is approved keeps sending it (LEGACY) until the new one is approved; the worker submits the new ones for it
// by itself, once (scheduleResubmit), and the page shows the old one as approved in its old wording.
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
 * Send the store's templates to Meta for review: every one that is not approved or waiting for Meta (or only those of
 * `only`). One Meta rejected is sent again; when Meta keeps the name, what it says about it stands, and the reason
 * shows on the page. A marketing one needs PUBLIC_BASE_URL on https for its button; without it, it is not sent and the
 * page says why.
 */
export async function submitTemplates(app: App, storeId: number, by: string, { only }: { only?: MessageKey[] } = {}) {
  const a = await storeWa(app, storeId);
  if (!a) return { sent: 0, refused: 0 };
  const s = await app.db.one<any>('SELECT name, domain, brand, brand_override FROM stores WHERE id = $1', [storeId]);
  const store = displayName(s?.brand_override?.name, s?.brand?.name, s?.name) || s?.domain;
  const token = open(app.env, a.secret!);
  const have = new Map((await templatesOf(app, a.id)).map((t) => [t.name, t]));
  const base = publicBase(app.env);
  let sent = 0;
  let refused = 0;
  for (const m of only || ALL) {
    const req = templateRequest(m, store, base);
    const body = req.components[0].text as string;
    const prev = have.get(req.name);
    if (prev && ['APPROVED', 'PENDING', 'IN_APPEAL'].includes(prev.status)) continue;
    let row: { meta_id: string | null; status: string; category: string | null; why: string | null };
    if (categoryOf(m) === 'MARKETING' && !base.startsWith('https://')) {
      row = { meta_id: null, status: 'error', category: null, why: 'PUBLIC_BASE_URL is not set to an https address, so the button has nowhere to go' };
      refused++;
    } else {
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

/**
 * Whether every template of this kind is approved on this account, and what is missing. A marketing message whose new
 * template is not approved yet, but whose old one is, counts as approved and is listed in `legacy`: it goes out as the
 * old one.
 */
export async function approvedFor(app: App, accountId: number | null, kind: Kind): Promise<{ ok: boolean; missing: string[]; legacy: MessageKey[] }> {
  const msgs = KINDS[kind].messages;
  const names = msgs.map((m) => MESSAGES[m].template);
  if (!accountId) return { ok: false, missing: names, legacy: [] };
  const all = [...names, ...msgs.map((m) => LEGACY[m]?.template).filter((n): n is string => Boolean(n))];
  const rows = await app.db.query<{ name: string; status: string }>('SELECT name, status FROM wa_templates WHERE account_id = $1 AND name = ANY($2::text[])', [accountId, all]);
  const ok = new Set(rows.filter((r) => r.status === 'APPROVED').map((r) => r.name));
  const legacy = msgs.filter((m) => !ok.has(MESSAGES[m].template) && ok.has(LEGACY[m]?.template || ''));
  const missing = msgs.filter((m) => !ok.has(MESSAGES[m].template) && !legacy.includes(m)).map((m) => MESSAGES[m].template);
  return { ok: !missing.length, missing, legacy };
}

/**
 * A store whose old marketing template is approved and whose new one was never submitted: the new one, once, by the
 * worker (jobs.ts scheduleAuto), so the old wording ("כתבו הסר") goes away without the owner coming back to the page.
 */
export async function scheduleResubmit(app: App): Promise<number[]> {
  const pairs = Object.entries(LEGACY).map(([m, l]) => [l!.template, MESSAGES[m as MessageKey].template]);
  const rows = await app.db.query<{ store_id: number }>(
    `SELECT DISTINCT o.store_id FROM wa_templates o JOIN channel_accounts a ON a.id = o.account_id AND a.status = 'active'
      WHERE o.status = 'APPROVED' AND o.name = ANY($1::text[])
        AND NOT EXISTS (SELECT 1 FROM wa_templates n WHERE n.account_id = o.account_id AND n.name = ($2::jsonb)->>o.name)`,
    [pairs.map((p) => p[0]), JSON.stringify(Object.fromEntries(pairs))],
  );
  return rows.map((r) => r.store_id);
}
