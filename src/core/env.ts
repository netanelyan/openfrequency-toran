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
  { name: 'TORAN_ASSISTANT_WA', group: 'whatsapp', he: 'הקו של בעלי העסק: מספר הוואטסאפ שבו הם כותבים לעוזר ומקבלים הודעות מתדר. ספרות בלבד, לא מספר הדמו' },
  { name: 'TORAN_SUPPORT_STORE', group: 'whatsapp', he: 'הדומיין של חנות השירות שלנו (npm run company): מי שכותב לקו של בעלי העסק ולא מחובר לחשבון, או למספר הדמו בלי דמו, מקבל ממנה תשובה. ריק: כמו קודם' },
  { name: 'TWILIO_TEMPLATES', group: 'whatsapp', he: 'התבניות שמטא אישרה, שם=Content SID, למשל teder_posts_ready=HX...' },
  { name: 'DEMO_WA_NUMBER', group: 'whatsapp', he: 'המספר שכפתור הדמו בדף פותח (wa.me), בספרות בלבד' },
  { name: 'PUBLIC_BASE_URL', group: 'website', he: 'הכתובת הציבורית של דפי הדמו, למשל https://toran.example' },
  { name: 'PUBLIC_HOST', group: 'website', he: 'שם המארח של הדשבורד מאחורי Caddy' },
  { name: 'SESSION_SECRET', group: 'website', he: 'חתימה על אסימוני ה־CSRF בטפסים' },
  { name: 'OF_INTERNAL_TOKEN', group: 'website', he: 'המפתח המשותף עם openfrequency-accounts, שבודק מי מחובר. אותו ערך בכל השירותים' },
  { name: 'OF_ASSISTANT_SECRET', group: 'website', he: 'החתימה על הבקשות בין תורן לתדר, לפחות 32 תווים. אותו ערך גם בתדר' },
  { name: 'TEDER_SITE_INTERNAL', group: 'website', he: 'האתר של תדר בשרת הזה, ללוח שלך: ממנו מגיעות המצגות של תדר. ברירת המחדל http://127.0.0.1:4700' },
  { name: 'TORAN_CHANNELS', group: 'channels', he: 'הערוצים שהקוד שלהם פועל, למשל whatsapp,email. וואטסאפ תמיד פועל' },
  { name: 'RESEND_API_KEY', group: 'channels', he: 'Resend: שליחת תשובות במייל וקריאת המיילים שמגיעים' },
  { name: 'RESEND_WEBHOOK_SECRET', group: 'channels', he: 'Resend: הסוד (whsec_...) שבודק את החתימה על ה־webhook' },
  { name: 'TORAN_MAIL_DOMAIN', group: 'channels', he: 'הדומיין שמקבל את המייל של החנויות, למשל in.openfrequency.co.il' },
  { name: 'META_APP_ID', group: 'channels', he: 'Meta: מזהה האפליקציה, לחיבור הוואטסאפ, הדף בפייסבוק והאינסטגרם של החנויות' },
  { name: 'META_APP_SECRET', group: 'channels', he: 'Meta: הסוד של האפליקציה. בודק את החתימה על ה-webhook ומחליף את הקוד של החיבור במפתח' },
  { name: 'META_WA_CONFIG_ID', group: 'channels', he: 'Meta: מזהה ההגדרה של Embedded Signup לוואטסאפ, עם חיבור של WhatsApp Business קיים' },
  { name: 'META_WEBHOOK_VERIFY_TOKEN', group: 'channels', he: 'Meta: מחרוזת שבוחרים, אותה אחת כאן ובהגדרת ה-webhook באפליקציה' },
  { name: 'META_FB_CONFIG_ID', group: 'channels', he: 'Meta: מזהה ההגדרה של Facebook Login for Business למסנג׳ר. ריק: הכניסה מבקשת את ההרשאות בעצמה' },
  { name: 'META_IG_APP_ID', group: 'channels', he: 'Meta: מזהה האפליקציה של אינסטגרם (API setup with Instagram login), לחיבור האינסטגרם של החנויות' },
  { name: 'META_IG_APP_SECRET', group: 'channels', he: 'Meta: הסוד של אפליקציית האינסטגרם. מחליף את הקוד של החיבור במפתח' },
  { name: 'META_HUMAN_AGENT', group: 'channels', he: 'Meta: 1 כש-Meta אישרה את Human Agent. אז תשובה שלכם במסנג׳ר ובאינסטגרם יוצאת עד 7 ימים מההודעה של הלקוח' },
  { name: 'META_GRAPH_VERSION', group: 'channels', he: 'Meta: גרסת ה-Graph API, למשל v23.0' },
  { name: 'META_DEMO_PHONE_ID', group: 'whatsapp', he: 'Meta: המזהה (phone number ID) של מספר הדמו, כשהוא ב-Meta ולא ב-Twilio. ריק: המספר שחובר בדף הוואטסאפ של חנות השירות שלנו, ואם אין כזה, Twilio' },
  { name: 'META_OWNER_PHONE_ID', group: 'whatsapp', he: 'Meta: המזהה של הקו של בעלי העסק, כשהוא במספר אחר ב-Meta. ריק: המספר שחובר בדף הוואטסאפ של חנות השירות שלנו, ואם אין כזה, Twilio' },
  { name: 'META_SYSTEM_TOKEN', group: 'whatsapp', he: 'Meta: מפתח של system user בעסק שלנו, למספרים שלנו ב-Meta. ריק: המפתח שהתקבל כשחיברו את המספר בדף הוואטסאפ של חנות השירות' },
  { name: 'META_TEMPLATES', group: 'whatsapp', he: 'Meta: שמות התבניות של הקו של בעלי העסק שמטא אישרה, מופרדים בפסיק, למשל teder_posts_ready,teder_post_reminder' },
  { name: 'TORAN_SECRETS_KEY', group: 'channels', he: 'המפתח שמצפין את המפתחות של החנויות במסד הנתונים, לפחות 32 תווים. בלעדיו אי אפשר לחבר' },
  { name: 'DATABASE_URL', group: 'database', he: 'Postgres בפרודקשן. בלעדיו: PGlite בתוך התיקייה הפרטית' },
];
