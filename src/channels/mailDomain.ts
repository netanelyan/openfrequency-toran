import { getDomain } from 'tldts';
import type { App } from '../app.ts';
import { J } from '../db/index.ts';
import { audit, event } from '../db/log.ts';
import type { Account } from './store.ts';

// A store's own address for its email, e.g. support@theirstore.co.il, through Resend's domains API. Until the store
// has one, replies go out from its address on our domain (<slug>@TORAN_MAIL_DOMAIN), as before.
//
//   adding     the owner gives the address on Settings. Toran adds its domain at Resend for sending (POST /domains,
//              receiving off, so the domain's own mail is never touched), and shows the DNS records Resend lists: an
//              SPF TXT and an MX on a "send" subdomain, and a DKIM TXT. Optionally a subdomain the owner picks (e.g.
//              help.theirstore.co.il) is added as a second domain with receiving only: its MX brings mail straight
//              to Toran, without forwarding.
//   checking   "לבדוק עכשיו" asks Resend to verify (POST /domains/:id/verify, which it does in the background) and reads
//              the domain again (GET /domains/:id); the worker reads it again every ten minutes for three days.
//   verified   replies go out from the address, and Reply-To is the address too (on the receiving subdomain once that
//              is verified), so a customer's answer comes back the way the store's mail already comes: forwarded to
//              the address on our domain, or by the subdomain's MX. Mail still comes in on our domain as before.
//   removing   the domain is deleted at Resend and the replies go out from our domain again.
//
// Nothing here is real until Resend says "verified": the address is not used, and the subdomain's mail is not routed.

export type DomainRecord = { record: string; name: string; type: string; value: string; priority?: number | null; status: string };
export type DomainState = { id: string; name: string; status: string; records: DomainRecord[] };

/** Resend's domains API (resendDomains, in email.ts: the adapter is the one file that calls Resend), or the simulator's. */
export interface MailDomains {
  create(name: string, capabilities: { sending: boolean; receiving: boolean }): Promise<DomainState>;
  get(id: string): Promise<DomainState>;
  verify(id: string): Promise<void>;
  remove(id: string): Promise<void>;
}

export class DomainError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** A domain as Resend's API gives it (create, get), in the shape kept here. */
export const domainState = (d: any): DomainState => ({
  id: String(d?.id || ''),
  name: String(d?.name || ''),
  status: String(d?.status || 'not_started'),
  records: (Array.isArray(d?.records) ? d.records : []).map((r: any) => ({ record: String(r?.record || ''), name: String(r?.name ?? ''), type: String(r?.type || ''), value: String(r?.value || ''), priority: r?.priority == null ? null : Number(r.priority), status: String(r?.status || 'not_started') })),
});

/** The simulator: the records Resend would list, verified when a test (or the dev page) says so. */
export function simDomains(): MailDomains & { verifyNow(name: string, status?: string): void; calls: string[] } {
  const all = new Map<string, DomainState & { receiving: boolean }>();
  const calls: string[] = [];
  let n = 0;
  return {
    calls,
    async create(name, c) {
      calls.push(`create ${name}${c.receiving ? ' receiving' : ''}`);
      if ([...all.values()].some((d) => d.name === name)) throw new DomainError(`Resend refused POST /domains (403): The ${name} domain has already been registered.`, 403);
      const records: DomainRecord[] = c.receiving
        ? [{ record: 'Receiving', name: '', type: 'MX', value: 'inbound.resend.test', priority: 10, status: 'not_started' }]
        : [
            { record: 'DKIM', name: 'resend._domainkey', type: 'TXT', value: 'p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDsimulated', status: 'not_started' },
            { record: 'SPF', name: 'send', type: 'MX', value: 'feedback.send.resend.test', priority: 10, status: 'not_started' },
            { record: 'SPF', name: 'send', type: 'TXT', value: 'v=spf1 include:send.resend.test ~all', status: 'not_started' },
          ];
      const d = { id: `sim-domain-${++n}`, name, status: 'not_started', records, receiving: c.receiving };
      all.set(d.id, d);
      return domainState(d);
    },
    async get(id) {
      calls.push(`get ${id}`);
      const d = all.get(id);
      if (!d) throw new DomainError('Resend refused GET /domains/:id (404): not found', 404);
      return domainState(d);
    },
    async verify(id) {
      calls.push(`verify ${id}`);
      const d = all.get(id);
      if (d && d.status === 'not_started') d.status = 'pending';
    },
    async remove(id) {
      calls.push(`remove ${id}`);
      all.delete(id);
    },
    verifyNow(name, status = 'verified') {
      for (const d of all.values()) {
        if (d.name !== name) continue;
        d.status = status;
        d.records = d.records.map((r) => ({ ...r, status: status === 'verified' ? 'verified' : r.status }));
      }
    },
  };
}

// ---- the store's row

export type MailDomain = { store_id: number; domain: string; local: string; resend_id: string | null; status: string; records: DomainRecord[]; receiving: string | null; receiving_id: string | null; receiving_status: string | null; receiving_records: DomainRecord[]; created_at: string; checked_at: string | null; verified_at: string | null };

export async function mailDomainOf(app: App, storeId: number): Promise<MailDomain | null> {
  return app.db.one<MailDomain>('SELECT * FROM mail_domains WHERE store_id = $1', [storeId]);
}

/**
 * Where a store's email replies go out from, once its domain is verified at Resend; null until then, and they go out
 * from its address on our domain. Reply-To is on the receiving subdomain once that is verified too.
 */
export async function ownAddress(app: App, storeId: number): Promise<{ from: string; replyTo: string } | null> {
  const d = await mailDomainOf(app, storeId);
  if (!d || d.status !== 'verified') return null;
  const from = `${d.local}@${d.domain}`;
  return { from, replyTo: d.receiving && d.receiving_status === 'verified' ? `${d.local}@${d.receiving}` : from };
}

/** The addresses mail from which is the store writing to itself: its own address, on the domain and the subdomain. */
export const ownAddresses = (d: MailDomain | null) => (d ? [`${d.local}@${d.domain}`, ...(d.receiving ? [`${d.local}@${d.receiving}`] : [])] : []);

/** The store's email account an address on a verified receiving subdomain belongs to (mail that came by its MX). */
export async function receivingAccount(app: App, address: string): Promise<Account | null> {
  const domain = String(address || '').toLowerCase().split('@')[1];
  if (!domain) return null;
  return app.db.one<Account>("SELECT a.id, a.store_id, a.channel, a.external_id, a.kind, a.secret, a.meta, a.status FROM mail_domains d JOIN channel_accounts a ON a.store_id = d.store_id AND a.channel = 'email' AND a.status = 'active' WHERE d.receiving = $1 AND d.receiving_status = 'verified' ORDER BY a.id DESC LIMIT 1", [domain]);
}

const LOCAL = /^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const HOST = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

/** The owner's address and subdomain, checked: { local, domain, receiving }, or why not in Hebrew. */
export function parseOwnAddress(address: string, sub: string, ours: string[]): { ok: true; local: string; domain: string; receiving: string | null } | { ok: false; he: string } {
  const a = String(address || '').trim().toLowerCase().replace(/^mailto:/, '');
  const at = a.lastIndexOf('@');
  const local = a.slice(0, at);
  const domain = a.slice(at + 1).replace(/\.$/, '');
  if (at < 1 || !LOCAL.test(local) || !HOST.test(domain)) return { ok: false, he: 'הכתובת לא נראית כמו כתובת מייל. כותבים אותה כך: support@yourstore.co.il' };
  if (!getDomain(domain)) return { ok: false, he: 'הדומיין לא נראה כמו דומיין של אתר.' };
  const theirs = (d: string) => ours.some((o) => o && (d === o || d.endsWith(`.${o}`) || o.endsWith(`.${d}`)));
  if (theirs(domain)) return { ok: false, he: 'זו כתובת על הדומיין שלנו. כותבים כאן כתובת על הדומיין של החנות.' };
  const label = String(sub || '').trim().toLowerCase().replace(/\.+$/, '');
  if (!label) return { ok: true, local, domain, receiving: null };
  const receiving = label.endsWith(`.${domain}`) ? label : `${label}.${domain}`;
  if (!receiving.slice(0, -domain.length - 1).split('.').every((l) => LABEL.test(l))) return { ok: false, he: 'תת הדומיין לא תקין. כותבים רק אותיות באנגלית, ספרות ומקף, למשל help.' };
  return { ok: true, local, domain, receiving };
}

/** Why Resend would not take a domain, for the owner. */
function refusedHe(e: unknown): string {
  const m = String((e as Error)?.message || e);
  if (/already|registered|exists/i.test(m)) return 'הדומיין הזה כבר רשום אצלנו. אם הוא של החנות, כתבו לנו ונסדר את זה.';
  return 'לא הצלחנו להוסיף את הדומיין עכשיו. כדאי לנסות שוב בעוד כמה דקות.';
}

export class OwnDomainError extends Error {}

/** Start the store's own address: its domain (and subdomain) added at Resend, and the row with the records to add. */
export async function startDomain(app: App, storeId: number, address: string, sub: string, by: string): Promise<MailDomain> {
  const domains = app.mail?.domains;
  if (!domains) throw new OwnDomainError('המייל עוד כבוי בשרת (TORAN_CHANNELS).');
  const ours = [app.mail!.domain, 'openfrequency.co.il', String(app.env.TORAN_MAIL_DOMAIN || '').toLowerCase()];
  const p = parseOwnAddress(address, sub, ours);
  if (!p.ok) throw new OwnDomainError(p.he);
  const taken = await app.db.one<{ store_id: number }>('SELECT store_id FROM mail_domains WHERE (domain = $1 OR receiving = $2 OR domain = $2 OR receiving = $1) AND store_id <> $3', [p.domain, p.receiving || '', storeId]);
  if (taken) throw new OwnDomainError('הדומיין הזה כבר מחובר לחנות אחרת.');
  await dropDomain(app, storeId, by, { quiet: true });
  let sending: DomainState;
  try {
    sending = await domains.create(p.domain, { sending: true, receiving: false });
  } catch (e) {
    app.log(`[mail-domain] store ${storeId}: ${String((e as Error)?.message || e)}`);
    throw new OwnDomainError(refusedHe(e));
  }
  let receiving: DomainState | null = null;
  if (p.receiving) {
    try {
      receiving = await domains.create(p.receiving, { sending: false, receiving: true });
    } catch (e) {
      app.log(`[mail-domain] store ${storeId}: ${String((e as Error)?.message || e)}`);
      await domains.remove(sending.id).catch(() => {});
      throw new OwnDomainError(refusedHe(e));
    }
  }
  await app.db.query(
    'INSERT INTO mail_domains (store_id, domain, local, resend_id, status, records, receiving, receiving_id, receiving_status, receiving_records, created_by) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10::jsonb, $11)',
    [storeId, p.domain, p.local, sending.id, sending.status, J(sending.records), p.receiving, receiving?.id || null, receiving?.status || null, J(receiving?.records || []), by],
  );
  await audit(app.db, { actor: by, action: 'mail_domain_add', storeId, detail: { domain: p.domain, receiving: p.receiving } });
  return (await mailDomainOf(app, storeId))!;
}

/**
 * Read the store's domains at Resend again (after asking it to verify, on "לבדוק עכשיו"); the row gets each one's status
 * and records. Returns the row, or null when the store has none.
 */
export async function checkDomain(app: App, storeId: number, { verify = true }: { verify?: boolean } = {}): Promise<MailDomain | null> {
  const d = await mailDomainOf(app, storeId);
  const domains = app.mail?.domains;
  if (!d || !domains) return d;
  const read = async (id: string | null) => {
    if (!id) return null;
    if (verify) await domains.verify(id);
    return domains.get(id);
  };
  const [s, r] = [await read(d.resend_id), await read(d.receiving_id)];
  const newly = s?.status === 'verified' && d.status !== 'verified';
  await app.db.query(
    "UPDATE mail_domains SET status = COALESCE($2, status), records = COALESCE($3::jsonb, records), receiving_status = COALESCE($4, receiving_status), receiving_records = COALESCE($5::jsonb, receiving_records), checked_at = now(), verified_at = CASE WHEN $2 = 'verified' THEN COALESCE(verified_at, now()) ELSE NULL END WHERE store_id = $1",
    [storeId, s?.status || null, s ? J(s.records) : null, r?.status || null, r ? J(r.records) : null],
  );
  if (newly) await event(app.db, storeId, 'mail_domain_verified', { domain: d.domain });
  return mailDomainOf(app, storeId);
}

/** Remove the store's own domain, at Resend and here: replies go out from our domain again. */
export async function dropDomain(app: App, storeId: number, by: string, { quiet = false }: { quiet?: boolean } = {}) {
  const d = await mailDomainOf(app, storeId);
  if (!d) return;
  for (const id of [d.resend_id, d.receiving_id]) if (id) await app.mail?.domains?.remove(id).catch((e) => app.log(`[mail-domain] remove ${d.domain}: ${String(e?.message || e)}`));
  await app.db.query('DELETE FROM mail_domains WHERE store_id = $1', [storeId]);
  if (!quiet) await audit(app.db, { actor: by, action: 'mail_domain_remove', storeId, detail: { domain: d.domain } });
}

/** The domains still waiting, read again by the worker: every ten minutes, for the three days Resend keeps trying. */
export async function domainsToCheck(app: App): Promise<number[]> {
  const rows = await app.db.query<{ store_id: number }>("SELECT store_id FROM mail_domains WHERE (status <> 'verified' OR (receiving IS NOT NULL AND receiving_status IS DISTINCT FROM 'verified')) AND created_at > now() - interval '3 days' AND COALESCE(checked_at, 'epoch') < now() - interval '10 minutes'");
  return rows.map((r) => r.store_id);
}
