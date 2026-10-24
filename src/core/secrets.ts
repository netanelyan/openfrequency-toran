import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

// A store's credentials at rest (channel_accounts.secret): a Meta access token is encrypted with AES-256-GCM under
// TORAN_SECRETS_KEY, which lives in private/.env only. Without the key nothing is stored, so a channel that needs a
// token cannot be connected (fail closed); with a different key a stored token does not open, and the channel stops
// until it is connected again.
//
// The format is "v1." + base64url(iv | tag | ciphertext). The key is any string of 32 characters or more, hashed to
// 32 bytes, so a long random string pasted into .env works as it is.

type Env = Record<string, string | undefined>;

const PREFIX = 'v1.';
const MIN_KEY = 32;

export class SecretError extends Error {}

export const secretsReady = (env: Env) => String(env.TORAN_SECRETS_KEY || '').trim().length >= MIN_KEY;

function keyOf(env: Env): Buffer {
  const k = String(env.TORAN_SECRETS_KEY || '').trim();
  if (k.length < MIN_KEY) throw new SecretError('TORAN_SECRETS_KEY is not set (32 characters or more)');
  return createHash('sha256').update(k).digest();
}

export function seal(env: Env, plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keyOf(env), iv);
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return PREFIX + Buffer.concat([iv, c.getAuthTag(), body]).toString('base64url');
}

export function open(env: Env, sealed: string): string {
  if (!String(sealed || '').startsWith(PREFIX)) throw new SecretError('not a sealed secret');
  const raw = Buffer.from(sealed.slice(PREFIX.length), 'base64url');
  if (raw.length < 29) throw new SecretError('a sealed secret too short to be one');
  const d = createDecipheriv('aes-256-gcm', keyOf(env), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  try {
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  } catch {
    throw new SecretError('the secret does not open with this TORAN_SECRETS_KEY');
  }
}
