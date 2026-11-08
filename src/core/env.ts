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
  { name: 'TORAN_ASSISTANT_WA', group: 'whatsapp', he: 'הקו של בעלי העסק: מספר הוואטסאפ שבו בעלי חנות בתורן כותבים לעוזר. ספרות בלבד, לא מספר הדמו' },
  { name: 'TORAN_SUPPORT_STORE', group: 'whatsapp', he: 'הדומיין של חנות השירות שלנו (npm run company): מי שכותב לקו של בעלי העסק ולא מחובר לחשבון, או למספר הדמו בלי דמו, מקבל ממנה תשובה. ריק: כמו קודם' },
  { name: 'TWILIO_TEMPLATES', group: 'whatsapp', he: 'התבניות של הקו של בעלי העסק, שם=Content SID. לא בשימוש מאז 2.11.2026, כי את תדר מנהלים רק מלוח הבקרה. אפשר להשאיר ריק' },
  { name: 'DEMO_WA_NUMBER', group: 'whatsapp', he: 'המספר שכפתור הדמו בדף פותח (wa.me), בספרות בלבד' },
  { name: 'PUBLIC_BASE_URL', group: 'website', he: 'הכתובת הציבורית של דפי הדמו, למשל https://toran.example' },
  { name: 'PUBLIC_HOST', group: 'website', he: 'שם המארח של הדשבורד מאחורי Caddy' },
  { name: 'SESSION_SECRET', group: 'website', he: 'חתימה על אסימוני ה־CSRF בטפסים' },
  { name: 'OF_INTERNAL_TOKEN', group: 'website', he: 'המפתח המשותף עם openfrequency-accounts, שבודק מי מחובר. אותו ערך בכל השירותים' },
  { name: 'OF_ASSISTANT_SECRET', group: 'website', he: 'החתימה על הבקשות בין תורן לתדר, לפחות 32 תווים. אותו ערך גם בתדר' },
  { name: 'OF_WEB_INTERNAL', group: 'website', he: 'שירות הלידים של האתר בשרת הזה: ממנו הלוח שלך קורא את רשימת ההמתנה ואת הלידים שלא הגיעו לתורן או לתדר. ברירת המחדל http://127.0.0.1:4720' },
  { name: 'TORAN_SUPPORT_EXPORT_URL', group: 'website', he: 'הקובץ שהאתר מפרסם לתמיכה, https://openfrequency.co.il/support.json: ממנו חנות השירות שלנו מתעדכנת לבד, פעם ביום וכשתורן עולה, ורק כשמשהו בו השתנה. ריק: מעדכנים ביד (npm run company -- sync)' },
  { name: 'TEDER_URL', group: 'website', he: 'הכתובת הציבורית של תדר: ממנה הלוח שלך פותח דמו של תדר (/demos/<id>). ברירת המחדל https://teder.openfrequency.co.il' },
  { name: 'TEDER_SITE_INTERNAL', group: 'website', he: 'האתר של תדר בשרת הזה: ממנו מגיעות המצגות של תדר ללוח שלך, ואליו עוברות בקשות הדמו של תדר מהוואטסאפ. ברירת המחדל http://127.0.0.1:4700' },
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
  { name: 'TORAN_WA_PROVIDER', group: 'channels', he: 'איך חנות מחברת את הוואטסאפ שלה: kapso (דרך Kapso, בלי האישור של האפליקציה שלנו ב-Meta) או meta. ריק: meta. המספר שלנו תמיד ב-Meta' },
  { name: 'KAPSO_API_KEY', group: 'channels', he: 'Kapso: מפתח ה-API של הפרויקט, לחיבור המספרים של החנויות ולשליחה מהם' },
  { name: 'KAPSO_WEBHOOK_SECRET', group: 'channels', he: 'Kapso: סוד שאנחנו בוחרים (לפחות 16 תווים), שבו נחתמות ההודעות שמגיעות מהמספרים של החנויות ל-/kapso/webhook' },
  { name: 'KAPSO_EVENTS_SECRET', group: 'channels', he: 'Kapso: הסוד של ה-Platform webhook (/kapso/events) כפי ש-Kapso יצרה אותו: מספר שחובר, נותק או נמחק' },
  { name: 'KAPSO_META_BILLING', group: 'channels', he: 'Kapso: מי משלם ל-Meta על תבניות: customer_managed (החנות, ברירת המחדל) או partner_managed (אנחנו, מהקרדיט ב-Kapso). אי אפשר לשנות אחרי החיבור' },
  { name: 'KAPSO_BASE_URL', group: 'channels', he: 'Kapso: הכתובת של ה-API. ריק: https://api.kapso.ai' },
  { name: 'TORAN_DM_PROVIDER', group: 'channels', he: 'איך חנות מחברת את הדף בפייסבוק ואת האינסטגרם: zernio (דרך Zernio, בלי האישור של האפליקציה שלנו ב-Meta) או meta. ריק: meta' },
  { name: 'ZERNIO_API_KEY', group: 'channels', he: 'Zernio: מפתח ה-API (אותו מפתח של תדר), לחיבור הדפים והאינסטגרם של החנויות ולשליחה מהם' },
  { name: 'ZERNIO_WEBHOOK_SECRET', group: 'channels', he: 'Zernio: הסוד של ה-webhook ל-/zernio/webhook (לפחות 16 תווים), כפי שהוגדר ב-Zernio' },
  { name: 'ZERNIO_BASE', group: 'channels', he: 'Zernio: הכתובת של ה-API. ריק: https://zernio.com/api/v1' },
  { name: 'META_DEMO_PHONE_ID', group: 'whatsapp', he: 'Meta: המזהה (phone number ID) של מספר הדמו, כשהוא ב-Meta ולא ב-Twilio. ריק: המספר שחובר בדף הוואטסאפ של חנות השירות שלנו, ואם אין כזה, Twilio' },
  { name: 'META_OWNER_PHONE_ID', group: 'whatsapp', he: 'Meta: המזהה של הקו של בעלי העסק, כשהוא במספר אחר ב-Meta. ריק: המספר שחובר בדף הוואטסאפ של חנות השירות שלנו, ואם אין כזה, Twilio' },
  { name: 'META_OUTREACH_PHONE_ID', group: 'whatsapp', he: 'Meta: המזהה של מספר שממנו יוצאות ההודעות ללידים (ops/outreach.ts), כשהן במספר משלהן. ריק: מספר הדמו' },
  { name: 'META_WABA_ID', group: 'whatsapp', he: 'Meta: המזהה של חשבון הוואטסאפ (WABA) שבו התבניות, כדי לבדוק לפני כל פנייה ללידים שהתבנית מאושרת ושהאיכות שלה טובה. ריק: נבדק רק המספר' },
  { name: 'TORAN_OUTREACH_DAILY', group: 'whatsapp', he: 'כמה הודעות ללידים יוצאות ביום מהמספר שלנו, לתורן ולתדר יחד. ריק: 10' },
  { name: 'TORAN_SIGNUP_OPEN', group: 'website', he: 'תורן במכירה: 1 כשגם accounts מוכר אותו וגם האתר אומר שההרשמה פתוחה. עד אז לא יוצאת הודעה ללידים על תורן, ובדפי הדמו נשאר "לכתוב לתורן"' },
  { name: 'TORAN_SITE_EXPORT_URL', group: 'website', he: 'איפה האתר מפרסם אם ההרשמה פתוחה. ריק: https://openfrequency.co.il/support.json' },
  { name: 'META_SYSTEM_TOKEN', group: 'whatsapp', he: 'Meta: מפתח של system user בעסק שלנו, למספרים שלנו ב-Meta. ריק: המפתח שהתקבל כשחיברו את המספר בדף הוואטסאפ של חנות השירות' },
  { name: 'META_TEMPLATES', group: 'whatsapp', he: 'Meta: שמות התבניות של הקו של בעלי העסק, מופרדים בפסיק. לא בשימוש מאז 2.11.2026, כי את תדר מנהלים רק מלוח הבקרה. אפשר להשאיר ריק' },
  { name: 'TORAN_ALERT_WA', group: 'whatsapp', he: 'המספר שלך בוואטסאפ. ההתראות של תורן ושל תדר מגיעות אליו מהמספר של OpenFrequency, בתבנית operator_alert, עד 10 בשעה. אפשר לכתוב אותו בכל צורה. ריק: ההתראות לא נשלחות לוואטסאפ' },
  { name: 'TORAN_SECRETS_KEY', group: 'channels', he: 'המפתח שמצפין את המפתחות של החנויות במסד הנתונים, לפחות 32 תווים. בלעדיו אי אפשר לחבר' },
  { name: 'DATABASE_URL', group: 'database', he: 'Postgres בפרודקשן. בלעדיו: PGlite בתוך התיקייה הפרטית' },
];
