import type { App } from './app.ts';
import { J, V } from './db/index.ts';
import { event } from './db/log.ts';
import { normalize } from './core/hebrew.ts';
import { embed } from './ingest/embed.ts';
import { chunk } from './ingest/pages.ts';

// A company store: Toran answering for a business that sells a service, not a catalogue. OpenFrequency's own support
// is the first one: Toran answers people who write to us about Toran and Teder, from what openfrequency.co.il says.
//
// A company store is never found, scored or ingested. Its platform is 'company' (so ingest, the daily re-read, the
// pitch page and the build buttons, which take Shopify, WooCommerce, Wix and Cashcow only, all pass it by), its status is
// 'company' (so the review queue, the outreach and the follow-ups never list it), and it is not qualified (so the
// leads list shows it only under "everything"; the funnel leaves it out). It belongs to no workspace: the operator's.
//
// Its knowledge comes from one JSON file, the site's export (openfrequency-web, `npm run support`), synced here by
// `npm run company -- sync <file>`:
//   plans     product rows, one per plan, with the plan's sentence; get_plans reads them (agent/tools.ts)
//   faq       the site's questions, each with the answer that is true today (support.json's, else the site's) as
//             site_answer; the owner's own answers (the dashboard, the inbox's "save the answer") are never touched
//   pages     policies and their chunks: what Toran does today, who we are, the two price sections, the legal pages
//   status    what Toran does today and what not yet, kept in the store's config for the prompt (agent/prompt.ts),
//             because the site's own pages still describe the product at launch
// Re-syncing replaces what came from the file and keeps the rest.

export const COMPANY = 'company';
export const isCompany = (s: { platform?: string | null } | null | undefined) => s?.platform === COMPANY;

/**
 * One of our own WhatsApp numbers as an account of our support store, when TORAN_SUPPORT_STORE names one. Someone our
 * number cannot otherwise answer gets the support agent: on the owner line, a number no workspace linked (instead of
 * "not linked", owners/line.ts); on the demo number, which is also our public number, a phone with no demo (instead of
 * "press the button on the page", channels/demo.ts). The account's status is 'line', which accountFor
 * (channels/store.ts) never matches, so owners still reach their assistant and demo codes still bind. Unset, no such
 * company store, or no number: null, and the number answers as before.
 */
export async function supportAccount(app: App, adapter: { kind: string }, number: string | null | undefined) {
  const domain = String(app.env.TORAN_SUPPORT_STORE || '').trim().toLowerCase();
  const line = String(number || '').replace(/\D/g, '');
  if (!domain || !line) return null;
  const s = await app.db.one<{ id: number; name: string | null }>('SELECT id, name FROM stores WHERE domain = $1 AND platform = $2', [domain, COMPANY]);
  if (!s) return null;
  await app.db.query("INSERT INTO channel_accounts (store_id, channel, kind, external_id, name, status) VALUES ($1, 'whatsapp', $2, $3, $4, 'line') ON CONFLICT (channel, external_id) DO NOTHING", [s.id, adapter.kind, line, s.name]);
  return app.db.one<{ id: number; store_id: number; channel: string; external_id: string; kind: string; secret: string | null; meta: any; status: string }>(
    "SELECT id, store_id, channel, external_id, kind, secret, meta, status FROM channel_accounts WHERE channel = 'whatsapp' AND external_id = $1 AND store_id = $2 AND status = 'line'",
    [line, s.id],
  );
}

export type CompanyExport = {
  domain: string;
  url: string;
  name: string;
  status: string;
  tone: string;
  contact: { whatsapp?: string | null; email?: string | null };
  plans: { key: string; product: string; title: string; monthly: number; text: string; url: string }[];
  faq: { q: string; a: string; today: string | null; url: string }[];
  pages: { kind: string; title: string; url: string; text: string }[];
  generatedAt?: string;
};

/** The file, checked before anything is written: a half-read export never replaces a working one. */
export function readExport(json: unknown): CompanyExport {
  const d = json as CompanyExport;
  const fail = (why: string) => {
    throw new Error(`not a company export: ${why}`);
  };
  if (!d || typeof d !== 'object') fail('not an object');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(String(d.domain || ''))) fail('domain');
  if (!/^https:\/\//.test(String(d.url || ''))) fail('url');
  if (!String(d.status || '').trim()) fail('status');
  if (!Array.isArray(d.plans) || !d.plans.length || !d.plans.every((p) => p.key && p.title && Number.isFinite(p.monthly) && p.text)) fail('plans');
  if (!Array.isArray(d.faq) || !d.faq.every((f) => f.q && f.a)) fail('faq');
  if (!Array.isArray(d.pages) || !d.pages.every((p) => p.kind && p.title && p.url && p.text)) fail('pages');
  return d;
}

export type SyncSummary = { storeId: number; created: boolean; slug: string | null; plans: number; faqs: number; faqsRemoved: number; policies: number; chunks: number; embedded: boolean };

export async function syncCompany(app: App, data: CompanyExport, { slug = 'support' }: { slug?: string } = {}): Promise<SyncSummary> {
  const { db } = app;
  const d = readExport(data);
  const pieces = d.pages.flatMap((p, i) => chunk(p.text).map((text) => ({ page: i, kind: p.kind, text: text.startsWith(p.title) ? text : `${p.title}\n${text}` })));
  const vectors = await embed(pieces.map((p) => p.text), 'passage', app.env);

  const existing = await db.one<{ id: number; platform: string; slug: string | null }>('SELECT id, platform, slug FROM stores WHERE domain = $1', [d.domain]);
  if (existing && existing.platform !== COMPANY) throw new Error(`${d.domain} is already a store here (platform ${existing.platform}), not a company store`);
  const slugFree = !(await db.one('SELECT 1 FROM stores WHERE slug = $1 AND domain <> $2', [slug, d.domain]));

  let storeId = existing?.id ?? 0;
  let faqsRemoved = 0;
  await db.tx(async (t) => {
    const brand = { name: d.name, tone: d.tone };
    const config = { currency: 'ILS', company: { status: d.status, generatedAt: d.generatedAt || null } };
    if (!storeId) {
      const row = await t.one<{ id: number }>(
        `INSERT INTO stores (domain, url, name, platform, status, qualified, source, source_detail, contact_email, contact_whatsapp, slug, brand, config, ingested_at)
         VALUES ($1, $2, $3, $4, $4, false, 'manual', $5::jsonb, $6, $7, $8, $9::jsonb, $10::jsonb, now()) RETURNING id`,
        [d.domain, d.url, d.name, COMPANY, J({ company: true }), d.contact?.email || null, d.contact?.whatsapp || null, slugFree ? slug : null, J(brand), J(config)],
      );
      storeId = row!.id;
    } else {
      await t.query(
        `UPDATE stores SET url = $2, name = $3, contact_email = $4, contact_whatsapp = $5, slug = COALESCE(slug, $6), brand = $7::jsonb, config = config || $8::jsonb, ingested_at = now(), updated_at = now() WHERE id = $1`,
        [storeId, d.url, d.name, d.contact?.email || null, d.contact?.whatsapp || null, slugFree ? slug : null, J(brand), J(config)],
      );
    }

    // The plans: one product row each, always available, its sentence as the description.
    for (const p of d.plans) {
      await t.query(
        `INSERT INTO products (store_id, ext_id, handle, title, product_type, url, currency, price_min, price_max, available, variants, body_text, search_text, scraped_at, gone_at)
         VALUES ($1, $2, $2, $3, $4, $5, 'ILS', $6, $6, true, '[]'::jsonb, $7, $8, now(), NULL)
         ON CONFLICT (store_id, ext_id) DO UPDATE SET title = EXCLUDED.title, product_type = EXCLUDED.product_type, url = EXCLUDED.url, price_min = EXCLUDED.price_min, price_max = EXCLUDED.price_max,
           available = true, body_text = EXCLUDED.body_text, search_text = EXCLUDED.search_text, scraped_at = now(), gone_at = NULL`,
        [storeId, p.key, p.title, p.product, p.url, p.monthly, p.text, normalize(`${p.title} ${p.product} ${p.text}`)],
      );
    }
    await t.query('UPDATE products SET gone_at = now() WHERE store_id = $1 AND gone_at IS NULL AND NOT (ext_id = ANY($2::text[]))', [storeId, d.plans.map((p) => p.key)]);

    // The questions: today's answer as the site's. A question the site dropped goes, unless the owner answered it or
    // it was saved from a conversation.
    for (const f of d.faq) {
      const answer = f.today || f.a;
      const have = await t.one<{ id: number }>('SELECT id FROM faqs WHERE store_id = $1 AND question = $2', [storeId, f.q]);
      if (have) await t.query('UPDATE faqs SET site_answer = $2, source_url = $3 WHERE id = $1', [have.id, answer, f.url]);
      else await t.query('INSERT INTO faqs (store_id, question, site_answer, source_url) VALUES ($1, $2, $3, $4)', [storeId, f.q, answer, f.url]);
    }
    const gone = await t.query<{ id: number }>(
      'DELETE FROM faqs WHERE store_id = $1 AND answer IS NULL AND conversation_id IS NULL AND source_url = ANY($2::text[]) AND NOT (question = ANY($3::text[])) RETURNING id',
      [storeId, [...new Set(d.faq.map((f) => f.url))], d.faq.map((f) => f.q)],
    );
    faqsRemoved = gone.length;

    // The pages: replaced, an owner's correction carried over by URL and title.
    const key = (url: string, title: string) => `${url} ${title}`;
    const keep = new Map((await t.query<{ url: string; title: string; override_text: string }>('SELECT url, title, override_text FROM policies WHERE store_id = $1 AND override_text IS NOT NULL', [storeId])).map((r) => [key(r.url, r.title), r.override_text]));
    await t.query('DELETE FROM policies WHERE store_id = $1', [storeId]);
    const policyIds: number[] = [];
    for (const p of d.pages) {
      const row = await t.one<{ id: number }>('INSERT INTO policies (store_id, kind, title, url, text, override_text) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id', [storeId, p.kind, p.title.slice(0, 200), p.url, p.text, keep.get(key(p.url, p.title)) ?? null]);
      policyIds.push(row!.id);
    }
    for (const [i, c] of pieces.entries()) {
      await t.query(`INSERT INTO chunks (store_id, policy_id, kind, text, embedding) VALUES ($1, $2, $3, $4, ${vectors ? '$5::vector' : 'NULL'})`, vectors ? [storeId, policyIds[c.page], c.kind, c.text, V(vectors[i])] : [storeId, policyIds[c.page], c.kind, c.text]);
    }
  });
  const slugNow = (await db.one<{ slug: string | null }>('SELECT slug FROM stores WHERE id = $1', [storeId]))?.slug ?? null;
  const summary: SyncSummary = { storeId, created: !existing, slug: slugNow, plans: d.plans.length, faqs: d.faq.length, faqsRemoved, policies: d.pages.length, chunks: pieces.length, embedded: Boolean(vectors) };
  await event(db, storeId, 'company_sync', { ...summary, generatedAt: d.generatedAt || null });
  return summary;
}
