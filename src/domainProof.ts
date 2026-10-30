import { randomBytes } from 'node:crypto';
import { resolveTxt } from 'node:dns/promises';
import type { App } from './app.ts';

// A customer proves a site is theirs before Toran takes it as their store (the audit's PRA-SEC-003). Anyone with a
// workspace could otherwise type a store's address at /start, take its knowledge and its pitch page, keep the real
// owner out ("already connected to another account"), and connect their own WhatsApp to answer as that store.
//
// /start keeps a claim (domain_claims, migration 030): the workspace, the domain and a random token. The site is
// proven when either of these, both read by Toran itself, carries `toran-verify=<token>`:
//   - a DNS TXT record on the domain itself, or on _toran-verify.<domain>
//   - a meta tag on the home page: <meta name="toran-verify" content="<token>">, fetched through the same fetcher as
//     every store page (core/http.ts, with its address rule)
// Only then is the store added (or an operator's lead moved into the workspace, web/pages/start.ts). A store the
// operator gave a workspace with workspace:assign is the operator's word and needs no claim; the operator releases a
// disputed domain from the lead's page (POST /lead/<id>/release). A working Shopify or WooCommerce order key would be a
// third proof, but a key is pasted only once the store exists (orders.ts), so it is not offered here.

export const TXT_HOST = '_toran-verify';
export const META = 'toran-verify';

export type Claim = { id: number; workspace_id: number; domain: string; url: string; token: string; created_at: string; checked_at: string | null; proven_at: string | null; how: string | null };

/** The tests' seam: the DNS lookup. */
export const proofDeps = { resolveTxt: (host: string) => resolveTxt(host) };

/** The workspace's claim on a domain, new or as it was (its token kept, so instructions already followed stay right). */
export async function claimFor(app: App, workspaceId: number, domain: string, url: string): Promise<Claim> {
  await app.db.query('INSERT INTO domain_claims (workspace_id, domain, url, token) VALUES ($1, $2, $3, $4) ON CONFLICT (workspace_id, domain) DO UPDATE SET url = EXCLUDED.url', [workspaceId, domain, url, randomBytes(15).toString('base64url')]);
  return (await app.db.one<Claim>('SELECT * FROM domain_claims WHERE workspace_id = $1 AND domain = $2', [workspaceId, domain]))!;
}

/** The workspace's newest claim not yet proven, or null. */
export const pendingClaim = (app: App, workspaceId: number) => app.db.one<Claim>('SELECT * FROM domain_claims WHERE workspace_id = $1 AND proven_at IS NULL ORDER BY id DESC LIMIT 1', [workspaceId]);

/** Has this workspace proven this domain? */
export async function proven(app: App, workspaceId: number, domain: string): Promise<boolean> {
  return Boolean(await app.db.one('SELECT 1 FROM domain_claims WHERE workspace_id = $1 AND domain = $2 AND proven_at IS NOT NULL', [workspaceId, domain]));
}

const metaToken = (html: string) => {
  for (const m of String(html || '').matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const name = /\bname\s*=\s*["']?([^"'\s>]+)/i.exec(tag)?.[1];
    if (name?.toLowerCase() !== META) continue;
    const content = /\bcontent\s*=\s*["']?([^"'\s>]+)/i.exec(tag)?.[1];
    if (content) return content;
  }
  return null;
};

/** Look for the token now. Marks the claim proven, and says how, or why not. */
export async function checkClaim(app: App, claim: Claim): Promise<{ ok: boolean; how: 'dns' | 'meta' | null; why: string | null }> {
  const want = `${META}=${claim.token}`;
  let how: 'dns' | 'meta' | null = null;
  const why: string[] = [];
  for (const host of [claim.domain, `${TXT_HOST}.${claim.domain}`]) {
    try {
      if ((await proofDeps.resolveTxt(host)).some((parts) => parts.join('').trim() === want)) how = 'dns';
    } catch (e: any) {
      why.push(`dns ${host}: ${e?.code || e?.message || e}`);
    }
    if (how) break;
  }
  if (!how) {
    try {
      const r = await app.fetcher(claim.url, { maxBytes: 2 * 1024 * 1024, timeoutMs: 15_000 });
      if (metaToken(r.text) === claim.token) how = 'meta';
    } catch (e: any) {
      why.push(`page: ${e?.code || e?.message || e}`);
    }
  }
  await app.db.query(`UPDATE domain_claims SET checked_at = now()${how ? ', proven_at = now(), how = $2' : ''} WHERE id = $1`, how ? [claim.id, how] : [claim.id]);
  return { ok: Boolean(how), how, why: how ? null : why.join('; ') || 'the token was not found' };
}
