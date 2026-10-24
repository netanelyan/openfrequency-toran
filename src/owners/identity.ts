import type { App } from '../app.ts';

// Who a WhatsApp number is: openfrequency-accounts answers (its docs/internal-owner-phone.md; docs/owner-line.md
// section 1 here). A number belongs to one user in one workspace once the number itself sent accounts' link code to
// the owner line; Toran tells accounts which number sent it (claim). Nothing typed on a dashboard makes a number an
// owner's.
//
// Asked live, on every message and before every message Toran starts, never cached: a number removed in accounts, a
// workspace closed or a product turned off stops the next message. Anything that is not a well-formed answer (a
// timeout, a refused connection, a 5xx, an unexpected shape) is 'unavailable', and an unavailable answer makes nobody
// an owner. Fail closed.

export type Owner = {
  phone: string;
  verifiedAt: string;
  user: { id: number; name?: string | null; email?: string };
  workspace: { id: number; slug?: string; name?: string; disabled: boolean };
  role: string;
  products: string[];
  optIn: { at: string; source: string } | null;
  optOut: { at: string; source: string } | null;
};

export type Refused = 'not_linked' | 'unavailable' | 'not_configured' | 'disabled' | 'unknown_code' | 'expired' | 'used' | 'phone_taken' | 'bad';
export type Lookup = { ok: true; owner: Owner } | { ok: false; reason: Refused };

const MIN_TOKEN = 32;
const PHONE = /^[1-9]\d{7,14}$/;
export const LINK_CODE = /\bLINK-([ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6})\b/i;

/** A 200 is believed only in the contract's shape. */
function wellFormed(b: any): b is Owner {
  if (!b || typeof b !== 'object' || typeof b.phone !== 'string' || !PHONE.test(b.phone)) return false;
  if (!b.user || !Number.isInteger(b.user.id)) return false;
  if (!b.workspace || !Number.isInteger(b.workspace.id) || typeof b.workspace.disabled !== 'boolean') return false;
  if (!Array.isArray(b.products) || typeof b.verifiedAt !== 'string') return false;
  for (const c of [b.optIn, b.optOut]) if (c != null && (typeof c !== 'object' || typeof c.at !== 'string')) return false;
  return true;
}

async function call(app: App, method: 'GET' | 'POST', pathQuery: string, body?: unknown): Promise<{ status: number; body: any }> {
  const base = String(app.env.OF_ACCOUNTS_INTERNAL || 'http://127.0.0.1:4741').trim().replace(/\/+$/, '');
  const token = String(app.env.OF_INTERNAL_TOKEN || '').trim();
  if (token.length < MIN_TOKEN) return { status: 503, body: { error: 'not_configured' } };
  let r: Response;
  try {
    r = await fetch(`${base}${pathQuery}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(3000),
    });
  } catch (e: any) {
    app.log(`[owners] accounts unreachable at ${base}: ${e?.name === 'TimeoutError' ? 'timed out' : e?.message}`);
    return { status: 503, body: { error: 'unavailable' } };
  }
  let out: any = null;
  try {
    out = await r.json();
  } catch {
    /* not JSON: handled by the caller's shape check */
  }
  return { status: r.status, body: out };
}

function answer(app: App, r: { status: number; body: any }): Lookup {
  if (r.status === 200) {
    if (!wellFormed(r.body)) {
      app.log('[owners] a 200 from accounts that is not an owner (docs/owner-line.md): refused');
      return { ok: false, reason: 'unavailable' };
    }
    return r.body.workspace.disabled ? { ok: false, reason: 'disabled' } : { ok: true, owner: r.body };
  }
  const error = String(r.body?.error || '');
  if (error === 'not_configured') return { ok: false, reason: 'not_configured' };
  if (['not_linked', 'unknown_code', 'expired', 'used', 'phone_taken'].includes(error)) return { ok: false, reason: error as Refused };
  if (r.status === 400) return { ok: false, reason: 'bad' };
  if (r.status >= 500 || ['bad_token', 'not_local', 'bad_host'].includes(error)) app.log(`[owners] accounts said ${r.status} ${error}`);
  return { ok: false, reason: 'unavailable' };
}

/** The owner a number is, asked now. */
export async function ownerByPhone(app: App, phone: string): Promise<Lookup> {
  if (!PHONE.test(phone)) return { ok: false, reason: 'bad' };
  return answer(app, await call(app, 'GET', `/internal/owner-phone?phone=${phone}`));
}

/** The verified numbers of a workspace, asked now; null when accounts did not answer. */
export async function ownersOf(app: App, workspaceId: number): Promise<Owner[] | null> {
  const r = await call(app, 'GET', `/internal/owner-phones?workspace=${Number(workspaceId)}`);
  if (r.status !== 200 || !Array.isArray(r.body?.phones)) {
    if (r.status !== 503 || r.body?.error !== 'not_configured') app.log(`[owners] no list of numbers for workspace ${workspaceId}: ${r.status} ${r.body?.error || ''}`);
    return null;
  }
  return r.body.phones.filter((o: any) => wellFormed(o) && !o.workspace.disabled && o.workspace.id === workspaceId);
}

/** The number that sent a link code is that code's user's: accounts links and verifies it. */
export async function claimLink(app: App, code: string, phone: string): Promise<Lookup> {
  return answer(app, await call(app, 'POST', '/internal/owner-phone/claim', { code, phone }));
}

/** "הפסק" and "התחל", told to accounts, where the consent lives. */
export async function setConsent(app: App, phone: string, optIn: boolean): Promise<Lookup> {
  return answer(app, await call(app, 'POST', '/internal/owner-phone/consent', { phone, optIn, source: 'whatsapp' }));
}

const time = (s: string | null | undefined) => (s ? new Date(s).getTime() : 0);

/**
 * May Toran start a message to this owner? Only after an opt-in that is the latest word, in accounts and here: a "הפסק"
 * Toran kept while accounts could not be told still stops everything until a later opt-in.
 */
export function mayNotify(owner: Owner, localOptOut: string | Date | null): boolean {
  if (!owner.optIn) return false;
  const inAt = time(owner.optIn.at);
  if (owner.optOut && time(owner.optOut.at) >= inAt) return false;
  if (localOptOut && new Date(localOptOut).getTime() >= inAt) return false;
  return true;
}
