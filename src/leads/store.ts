import { randomBytes } from 'node:crypto';
import { type Db, J } from '../db/index.ts';
import { event, rememberPrivateName } from '../db/log.ts';
import { leadKeys } from '../core/urls.ts';
import type { Detection } from './detect.ts';
import type { Score } from './score.ts';

// Leads in the database. One store is one row, whatever found it and however many
// times: every lead is known by all its keys (site, email, WhatsApp, phone), and a
// new find with any key in common is the same lead, merged into it.
//
// Discovery never overwrites what the owner did: a lead past `new` keeps its status,
// and only its signals and score are refreshed.

export type SavedLead = { id: number; created: boolean; mergedBy: string | null };

export async function findByKeys(db: Db, keys: string[]): Promise<{ store_id: number; key: string } | null> {
  if (!keys.length) return null;
  return db.one<{ store_id: number; key: string }>('SELECT store_id, key FROM lead_keys WHERE key = ANY($1::text[]) ORDER BY key LIMIT 1', [keys]);
}

/** A slug for /s/<slug>: the domain's first label in Latin letters, and four random characters so pages cannot be guessed. */
export function makeSlug(domain: string): string {
  const base = domain.split('.')[0].toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24) || 'store';
  return `${base}-${randomBytes(3).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, 'x').slice(0, 4)}`;
}

export async function saveLead(db: Db, d: Detection, s: Score, source: string, detail: Record<string, unknown> = {}): Promise<SavedLead> {
  const keys = leadKeys({ domain: d.domain, email: d.email, whatsapp: d.whatsapp, phone: d.phone });
  const signals = {
    url: d.url,
    platformEvidence: d.platformEvidence,
    productCount: d.productCount,
    productCountSource: d.productCountSource,
    productCountCapped: d.productCountCapped,
    newestProductAt: d.newestProductAt,
    hebrewRatio: d.home.hebrewRatio,
    catalogHebrewRatio: d.catalogHebrewRatio,
    lang: d.home.lang,
    emails: d.home.emails,
    whatsappNumbers: d.home.whatsappNumbers,
    whatsappWidget: d.home.whatsappWidget,
    phones: d.home.phones,
    shekel: d.home.shekel,
    storeLocator: d.home.storeLocator,
    franchiseOf: d.franchiseOf,
    contactLinks: d.home.contactLinks,
    policyLinks: d.home.policyLinks,
    logo: d.home.logo,
    themeColor: d.home.themeColor,
    title: d.home.title,
    description: d.home.description,
    rendered: d.rendered,
    errors: d.errors,
  };
  return db.tx(async (t) => {
    const hit = await findByKeys(t, keys);
    if (hit) {
      await t.query(
        `UPDATE stores SET signals = $2::jsonb, score = $3, score_breakdown = $4::jsonb, qualified = $5, reject_reason = $6, platform = $7,
           contact_email = COALESCE(contact_email, $8), contact_whatsapp = COALESCE(contact_whatsapp, $9), contact_phone = COALESCE(contact_phone, $10), updated_at = now()
         WHERE id = $1`,
        [hit.store_id, J(signals), s.score, J(s.breakdown), s.qualified, s.reject, d.platform, d.email, d.whatsapp, d.phone],
      );
      for (const k of keys) await t.query('INSERT INTO lead_keys (key, store_id) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [k, hit.store_id]);
      await markSeen(t, d.domain, 'lead');
      return { id: hit.store_id, created: false, mergedBy: hit.key };
    }
    const row = await t.one<{ id: number }>(
      `INSERT INTO stores (domain, url, name, platform, score, score_breakdown, qualified, reject_reason, signals, source, source_detail, contact_email, contact_whatsapp, contact_phone, slug, brand)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9::jsonb,$10,$11::jsonb,$12,$13,$14,$15,$16::jsonb) RETURNING id`,
      [d.domain, d.url, d.name, d.platform, s.score, J(s.breakdown), s.qualified, s.reject, J(signals), source, J(detail), d.email, d.whatsapp, d.phone, makeSlug(d.domain), J({ name: d.name, logo: d.home.logo, themeColor: d.home.themeColor })],
    );
    const id = row!.id;
    for (const k of keys) await t.query('INSERT INTO lead_keys (key, store_id) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [k, id]);
    await markSeen(t, d.domain, 'lead');
    await event(t, id, 'lead_found', { source, score: s.score, qualified: s.qualified });
    rememberPrivateName(d.domain, d.name);
    return { id, created: true, mergedBy: null };
  });
}

export async function markSeen(db: Db, domain: string, verdict: 'lead' | 'rejected' | 'failed', reason: string | null = null) {
  await db.query(
    `INSERT INTO seen_domains (domain, verdict, reason) VALUES ($1, $2, $3)
     ON CONFLICT (domain) DO UPDATE SET verdict = EXCLUDED.verdict, reason = EXCLUDED.reason, seen_at = now()`,
    [domain, verdict, reason],
  );
}

/** Has discovery already looked at this domain (as a lead, a rejection or a failure)? */
export async function seen(db: Db, domain: string): Promise<string | null> {
  // A rejection is permanent; a failure (a timeout, a server down) is tried again after a day.
  const r = await db.one<{ verdict: string }>("SELECT verdict FROM seen_domains WHERE domain = $1 AND (verdict <> 'failed' OR seen_at > now() - interval '1 day')", [domain]);
  if (r) return r.verdict;
  const k = await db.one('SELECT 1 FROM lead_keys WHERE key = $1', [`site:${domain}`]);
  return k ? 'lead' : null;
}
