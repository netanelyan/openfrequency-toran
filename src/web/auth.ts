import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

// What is left of Toran's own auth now that openfrequency-accounts signs people in (accounts.ts): the CSRF token on
// every dashboard form, the cookie parser, and which requests came through our proxy over HTTPS.
//
// The CSRF token is derived from the accounts session id with an HMAC keyed by SESSION_SECRET, checked in constant
// time, alongside an Origin that is ours (Teder's csrfFor). It changes when the session does, and is worthless on
// another session.
//
// The pitch pages (/s/...), the beacon and the WhatsApp webhook (/wa/...) are public by design and do not pass
// through here; they have their own checks.

type Env = Record<string, string | undefined>;

let ephemeral: string | null = null;
/** The key the CSRF tokens are signed with. */
export function sessionSecret(env: Env = process.env): string {
  const s = String(env.SESSION_SECRET || '').trim();
  if (s.length >= 32) return s;
  // Without a setting, a per-process secret: an open page's token stops working on a restart, the safe failure.
  ephemeral ??= randomBytes(32).toString('hex');
  return ephemeral;
}

const sign = (body: string, secret: string) => createHmac('sha256', secret).update(body).digest('base64url');

export const csrfFor = (session: string, secret: string) => sign(`csrf:${session}`, secret).slice(0, 32);
export function csrfOk(given: unknown, session: string, secret: string): boolean {
  const want = Buffer.from(csrfFor(session, secret));
  const got = Buffer.from(String(given || ''));
  return want.length === got.length && timingSafeEqual(want, got);
}

export function cookies(req: IncomingMessage): Record<string, string> {
  return Object.fromEntries(
    String(req.headers.cookie || '')
      .split(';')
      .map((c) => c.trim().split('='))
      .filter((p) => p.length >= 2)
      .map(([k, ...v]) => {
        try {
          return [k, decodeURIComponent(v.join('='))];
        } catch {
          return [k, v.join('=')];
        }
      }),
  );
}

const fromProxy = (req: IncomingMessage) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(String(req.socket?.remoteAddress)) || process.env.TORAN_TRUST_PROXY === '1';

/** Did this request reach us over HTTPS? Only the proxy in front of us may say so. */
export const isHttps = (req: IncomingMessage) => fromProxy(req) && String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https';

export function clientIp(req: IncomingMessage): string {
  if (fromProxy(req)) {
    const f = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (f) return f;
  }
  return req.socket?.remoteAddress || 'unknown';
}
