import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { home } from './paths.ts';

// Keys live in $TORAN_HOME/.env (private/.env) and nowhere else. A tiny parser rather
// than a dependency: KEY=value lines, # comments, optional quotes. Values already in
// the environment win, so a container or a test can override the file.

type Env = Record<string, string | undefined>;

export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    out[m[1]] = v;
  }
  return out;
}

let loaded = false;

/** Load $TORAN_HOME/.env into the environment once. Returns the file's path, or null. */
export function loadEnv(env: Env = process.env): string | null {
  if (loaded) return null;
  loaded = true;
  const file = path.join(home(env), '.env');
  if (!existsSync(file)) return null;
  for (const [k, v] of Object.entries(parseEnv(readFileSync(file, 'utf8')))) {
    if (env[k] === undefined) env[k] = v;
  }
  return file;
}

/** Is a key set (non-empty)? Never returns the value. */
export const isSet = (name: string, env: Env = process.env) => Boolean(String(env[name] || '').trim());

/** dev (a laptop, the default) or prod (the VPS). */
export const toranEnv = (env: Env = process.env): 'dev' | 'prod' => (String(env.TORAN_ENV || '').trim().toLowerCase() === 'prod' ? 'prod' : 'dev');

/**
 * Every variable the engine reads, for the Settings page and the test that
 * .env.example lists them all. Values are never shown anywhere.
 */
export const KEYS: { name: string; group: string; he: string }[] = [
  { name: 'ANTHROPIC_API_KEY', group: 'agent', he: 'Claude דרך ה-API: הסוכן בפרודקשן. בפיתוח הסוכן רץ על המנוי דרך Claude Code' },
  { name: 'ANTHROPIC_WORKSPACE_ID', group: 'agent', he: 'מזהה ה-workspace, למפתח שלא שייך לאחד' },
  { name: 'BRAVE_API_KEY', group: 'leads', he: 'Brave Search: חיפוש חנויות חדשות' },
  { name: 'TWILIO_ACCOUNT_SID', group: 'whatsapp', he: 'Twilio: החשבון של מספר הדמו' },
  { name: 'TWILIO_AUTH_TOKEN', group: 'whatsapp', he: 'Twilio: חתימה על ה-webhook ושליחת תשובות' },
  { name: 'TWILIO_WHATSAPP_FROM', group: 'whatsapp', he: 'מספר הדמו בוואטסאפ, בפורמט +972...' },
  { name: 'TORAN_OWNER_WHATSAPP', group: 'whatsapp', he: 'המספר של OpenFrequency בוואטסאפ: הכפתור "לכתוב לנו" והבקשה להוריד עמוד. לא מספר הדמו' },
  { name: 'DEMO_WA_NUMBER', group: 'whatsapp', he: 'המספר שכפתור הדמו בדף פותח (wa.me), בספרות בלבד' },
  { name: 'PUBLIC_BASE_URL', group: 'website', he: 'הכתובת הציבורית של דפי הדמו, למשל https://toran.example' },
  { name: 'PUBLIC_HOST', group: 'website', he: 'שם המארח של הדשבורד מאחורי Caddy' },
  { name: 'SESSION_SECRET', group: 'website', he: 'חתימה על אסימוני ה־CSRF בטפסים' },
  { name: 'OF_INTERNAL_TOKEN', group: 'website', he: 'המפתח המשותף עם openfrequency-accounts, שבודק מי מחובר. אותו ערך בכל השירותים' },
  { name: 'TORAN_CHANNELS', group: 'channels', he: 'הערוצים שהקוד שלהם פועל, למשל whatsapp,email. וואטסאפ תמיד פועל' },
  { name: 'RESEND_API_KEY', group: 'channels', he: 'Resend: שליחת תשובות במייל וקריאת המיילים שמגיעים' },
  { name: 'RESEND_WEBHOOK_SECRET', group: 'channels', he: 'Resend: הסוד (whsec_...) שבודק את החתימה על ה־webhook' },
  { name: 'TORAN_MAIL_DOMAIN', group: 'channels', he: 'הדומיין שמקבל את המייל של החנויות, למשל in.openfrequency.co.il' },
  { name: 'DATABASE_URL', group: 'database', he: 'Postgres בפרודקשן. בלעדיו: PGlite בתוך התיקייה הפרטית' },
];
