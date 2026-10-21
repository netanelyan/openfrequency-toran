import { getDomain, getHostname } from 'tldts';

// Canonical names for stores and contacts, so one store is one lead however it was
// found. tiyul-social keyed sites by hostname minus www, so shop.x.co.il and x.co.il
// were two leads; here the key is the registrable domain (eTLD+1, which knows that
// co.il is a suffix), and *.myshopify.com keeps its subdomain because there the
// subdomain is the store.

/** The registrable domain of a URL or host, or null for an IP, localhost or garbage. */
export function canonicalDomain(input: string): string | null {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const host = getHostname(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
  if (!host) return null;
  const h = host.toLowerCase().replace(/\.$/, '');
  if (/\.myshopify\.com$/.test(h)) return h;
  const d = getDomain(h, { allowPrivateDomains: false });
  return d ? d.toLowerCase() : null;
}

/** A homepage URL to start from: https, the host as given (www kept: some stores only answer on it). */
export function homeUrl(input: string): string | null {
  const raw = String(input || '').trim();
  if (!raw) return null;
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (!/^https?:$/.test(u.protocol)) return null;
    return `https://${u.hostname.toLowerCase()}/`;
  } catch {
    return null;
  }
}

/**
 * A phone number as international digits (972...), or null. Israeli local forms
 * (05X-XXXXXXX, 0X-XXXXXXX) become 972 + the number without its 0. Ported from
 * tiyul-social's phoneKey/toIntl.
 */
export function toIntl(input: string): string | null {
  let d = String(input || '').replace(/[^\d+]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  if (d.startsWith('00')) d = d.slice(2);
  if (/^0\d{8,9}$/.test(d)) d = `972${d.slice(1)}`;
  if (d.startsWith('9720')) d = `972${d.slice(4)}`;
  return /^\d{10,15}$/.test(d) ? d : null;
}

/** An Israeli mobile number (the kind WhatsApp lives on). */
export const isIsraeliMobile = (intl: string | null) => Boolean(intl && /^9725\d{8}$/.test(intl));

/** An email address, normalised, or null when it is not one or is a platform's own. */
export function cleanEmail(input: string): string | null {
  const e = String(input || '').trim().toLowerCase().replace(/^mailto:/, '').split('?')[0];
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(e)) return null;
  if (/\.(png|jpe?g|gif|webp|svg)$/.test(e)) return null; // logo@2x.png
  if (/@(example\.|sentry|wixpress\.com|wix\.com|shopify\.com|domain\.com|email\.com|yourdomain|test\.)/.test(e)) return null;
  if (/^(noreply|no-reply|donotreply)@/.test(e)) return null;
  return e;
}

/** The dedupe keys of a lead. Any key in common means the same store. */
export function leadKeys(l: { domain?: string | null; email?: string | null; whatsapp?: string | null; phone?: string | null }): string[] {
  const keys: string[] = [];
  if (l.domain) keys.push(`site:${l.domain}`);
  if (l.email) keys.push(`email:${l.email}`);
  if (l.whatsapp) keys.push(`wa:${l.whatsapp}`);
  if (l.phone && l.phone !== l.whatsapp) keys.push(`phone:${l.phone}`);
  return keys;
}
