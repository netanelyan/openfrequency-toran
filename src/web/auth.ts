import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Db } from '../db/index.ts';
import { audit } from '../db/log.ts';

// The login in front of every dashboard page and button. Ported from Teder's auth.js.
//
// Passwords are scrypt hashes with a per-user salt. A session is a signed cookie: user
// id, expiry and an HMAC over both, keyed by SESSION_SECRET. HttpOnly, SameSite=Strict,
// Secure with the __Host- prefix behind HTTPS. Every state-changing request carries a
// CSRF token derived from the session, checked in constant time, and an Origin that is
// ours. Failed logins are limited per address (5 in 15 minutes); under a wider attack
// (20 failures in an hour from anywhere) each address gets one try, and the owner is
// never locked out globally.
//
// The pitch pages (/s/...) and the WhatsApp webhook (/wa/...) are public by design and
// do not pass through here; they have their own checks.

const DAY = 86_400_000;
export const SESSION_DAYS = 30;
type Env = Record<string, string | undefined>;

export function hashPassword(password: string, salt = randomBytes(16)): string {
  const key = scryptSync(String(password), salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

export function checkPassword(password: string, stored: string): boolean {
  const m = /^scrypt\$([0-9a-f]+)\$([0-9a-f]+)$/.exec(String(stored || ''));
  if (!m) return false;
  const want = Buffer.from(m[2], 'hex');
  const got = scryptSync(String(password), Buffer.from(m[1], 'hex'), want.length, { N: 16384, r: 8, p: 1 });
  return timingSafeEqual(want, got);
}

export async function addUser(db: Db, name: string, password: string, role = 'owner'): Promise<number> {
  if (String(password).length < 12) throw new Error('a password needs at least 12 characters');
  const r = await db.one<{ id: number }>('INSERT INTO users (name, password_hash, role) VALUES ($1, $2, $3) RETURNING id', [String(name).trim(), hashPassword(password), role]);
  await audit(db, { action: 'user_added', detail: { name, role } });
  return r!.id;
}

/** On first start with no users, create the owner from TORAN_ADMIN_USER / TORAN_ADMIN_PASSWORD. */
export async function bootstrapOwner(db: Db, env: Env = process.env): Promise<number | null> {
  const n = await db.one<{ n: number }>('SELECT COUNT(*)::int AS n FROM users');
  if (n?.n) return null;
  const pass = String(env.TORAN_ADMIN_PASSWORD || '');
  if (pass.length < 12) return null;
  return addUser(db, String(env.TORAN_ADMIN_USER || '').trim() || 'owner', pass, 'owner');
}

let ephemeral: string | null = null;
export function sessionSecret(env: Env = process.env): string {
  const s = String(env.SESSION_SECRET || '').trim();
  if (s.length >= 32) return s;
  // Without a setting, a per-process secret: sessions do not survive a restart, the safe failure.
  ephemeral ??= randomBytes(32).toString('hex');
  return ephemeral;
}

const sign = (body: string, secret: string) => createHmac('sha256', secret).update(body).digest('base64url');

export function makeSession(userId: number, secret: string, t = Date.now()): string {
  const body = `v1.${userId}.${t + SESSION_DAYS * DAY}`;
  return `${body}.${sign(body, secret)}`;
}

export function sessionUser(value: string | null | undefined, secret: string, t = Date.now()): number | null {
  const m = /^(v1\.(\d+)\.(\d+))\.([A-Za-z0-9_-]+)$/.exec(String(value || ''));
  if (!m) return null;
  const want = Buffer.from(sign(m[1], secret));
  const got = Buffer.from(m[4]);
  if (want.length !== got.length || !timingSafeEqual(want, got) || Number(m[3]) <= t) return null;
  return Number(m[2]);
}

export const csrfFor = (session: string, secret: string) => sign(`csrf:${session}`, secret).slice(0, 32);
export function csrfOk(given: unknown, session: string, secret: string): boolean {
  const want = Buffer.from(csrfFor(session, secret));
  const got = Buffer.from(String(given || ''));
  return want.length === got.length && timingSafeEqual(want, got);
}

export const cookieName = (secure: boolean) => (secure ? '__Host-tn' : 'tn');

export function sessionCookie(value: string, { secure, clear = false }: { secure: boolean; clear?: boolean }): string {
  const parts = [`${cookieName(secure)}=${clear ? '' : value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', clear ? 'Max-Age=0' : `Max-Age=${SESSION_DAYS * 86_400}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
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

export const sessionFrom = (req: IncomingMessage) => {
  const jar = cookies(req);
  return jar['__Host-tn'] || jar.tn || null;
};

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

export function createLimiter({ perIp = { max: 5, windowMs: 15 * 60_000 }, global = { max: 20, windowMs: 60 * 60_000 } } = {}) {
  const fails = new Map<string, number[]>();
  let all: number[] = [];
  const prune = (list: number[], windowMs: number, t: number) => list.filter((x) => t - x < windowMs);
  return {
    check(ip: string, t = Date.now()): number | null {
      all = prune(all, global.windowMs, t);
      const max = all.length >= global.max ? 1 : perIp.max;
      const mine = prune(fails.get(ip) || [], perIp.windowMs, t);
      fails.set(ip, mine);
      return mine.length >= max ? Math.ceil((perIp.windowMs - (t - mine[mine.length - max])) / 1000) : null;
    },
    fail(ip: string, t = Date.now()) {
      fails.set(ip, [...prune(fails.get(ip) || [], perIp.windowMs, t), t]);
      all = [...prune(all, global.windowMs, t), t];
    },
    succeed(ip: string) {
      fails.delete(ip);
    },
  };
}
