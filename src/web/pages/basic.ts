import { a11yHead, a11yWidget, accessibilityLink, iconLinks, toranMark } from '../../brand.ts';
import { esc, icon, layout, type PageCtx } from '../ui.ts';
import { themeButton, themeHead, themeMeta } from '../theme.ts';
import { ofWhatsapp } from '../../offer.ts';

/** "כתבו לנו" as a link to our WhatsApp, where a page says to write to us (TORAN-READINESS.md P1-22, as Teder's withSupport). */
export function writeToUs(env: Record<string, string | undefined> = process.env): string {
  const n = ofWhatsapp(env);
  return n ? `<a class="btn" href="https://wa.me/${n}" target="_blank" rel="noopener">${icon('send')}לכתוב לנו</a>` : '';
}

/** Why accounts let nobody in, in OpenFrequency's voice. No redirect from any of them, so no loop with accounts. */
const REFUSALS = {
  closed: { title: 'החשבון סגור', h: 'החשבון הזה סגור', text: 'סגרנו את החשבון הזה, ולכן אי אפשר להיכנס דרכו לתורן. אם נראה לכם שזו טעות, כתבו לנו ונבדוק.', link: 'ליציאה מהחשבון' },
  not_in_plan: { title: 'תורן לא כלול', h: 'תורן לא כלול בחשבון שלכם', text: 'החשבון שלכם פתוח, אבל תורן עוד לא הופעל בו. כדי להוסיף אותו, כתבו לנו.', link: 'לחשבון שלכם' },
  error: { title: 'אי אפשר להיכנס כרגע', h: 'אי אפשר להיכנס כרגע', text: 'לא הצלחנו לבדוק מי מחובר, ולכן לא נכנסים לתורן עד שזה מסתדר. אפשר לנסות שוב בעוד כמה דקות. אם זה נמשך, כתבו לנו.', link: 'לנסות שוב' },
  // The paywall (billing/entitlement.ts): accounts says the workspace has not paid for Toran, or could not be asked.
  // A workspace that never paid is a new customer, not one who stopped (TORAN-READINESS.md P0-8; the audit of
  // 2026-11-12, P1-10): before its store exists adding it is open (server.ts), after it what Toran read is. The button
  // is accounts' checklist with the way to pay, "איך משלמים" as the pay banner and Teder say it.
  new: { title: 'תורן נפתח כשהתשלום מגיע', h: 'תורן נפתח כשהתשלום מגיע', text: 'בינתיים אפשר להוסיף את החנות, ותורן קורא את האתר שלה. החיבור לערוצים ותשובות ללקוחות נפתחים כשהתשלום נרשם אצלנו. איך משלמים, ומה עוד נשאר, כתוב בדף ההקמה בחשבון.', link: 'איך משלמים' },
  unpaid: { title: 'התשלום לא פעיל', h: 'התשלום על תורן לא פעיל', text: 'עד שהתשלום מוסדר, תורן לא עונה ללקוחות בעצמו. מה שהם כותבים נשמר בשיחות, ואפשר לענות להם משם. מה שתורן יודע על החנות וההגדרות שלכם נשמרים כמו שהם.', link: 'איך משלמים' },
  unchecked: { title: 'אי אפשר לבדוק את התשלום',h: 'אי אפשר לבדוק את התשלום כרגע', text: 'לא הצלחנו לבדוק את מצב התשלום על תורן, ולכן לא נכנסים עד שזה מסתדר. אפשר לנסות שוב בעוד כמה דקות. אם זה נמשך, כתבו לנו.', link: 'לנסות שוב' },
} as const;

/** A new customer whose store exists: Toran read its site, and answers once the payment comes. */
const WAITING_PAY = { title: 'תורן מחכה לתשלום', h: 'תורן מחכה לתשלום', text: 'תורן עונה ללקוחות אחרי שהתשלום מגיע אלינו. עד אז אפשר כבר לראות מה הוא יודע על החנות, וכל מה שהוא קרא מהאתר נשמר.' };

/**
 * What server.ts knows for a pay page: the workspace has a store; its site being read ('working') or why reading it
 * failed; and for a store that stopped paying, when the channels connected through Zernio or Kapso are disconnected
 * (`channels`) and when the conversations are deleted, each null once past. `logout`: accounts' sign-out.
 */
export type PayFacts = { store: boolean; reading?: string | null; disconnect?: string | null; channels?: string[]; erase?: string | null; logout?: string | null };

const PAY_DAY = new Intl.DateTimeFormat('he-IL', { timeZone: 'Asia/Jerusalem', day: 'numeric', month: 'long' });
const THE_CHANNEL: Record<string, string> = { whatsapp: 'הוואטסאפ', instagram: 'האינסטגרם', messenger: 'המסנג׳ר' };

/** "הוואטסאפ, האינסטגרם והמסנג׳ר": a list of the channels with ה, the last joined with ו. */
const listHe = (names: string[]) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} ו${names[names.length - 1]}`);

/**
 * The dates a stopped store reads (the audit of 2026-11-12, P1-10: "הידע וההגדרות נשמרים" said nothing of the channels
 * disconnected after three days or the conversations deleted after thirty, jobs/retention.ts).
 */
function stopDates(f: PayFacts | null): string {
  if (!f) return '';
  const lines: string[] = [];
  const names = Object.keys(THE_CHANNEL).filter((c) => (f.channels || []).includes(c)).map((c) => THE_CHANNEL[c]);
  if (f.disconnect && names.length) lines.push(`אם התשלום לא יגיע עד ${PAY_DAY.format(new Date(f.disconnect))}, ננתק מתורן את ${listHe(names)} של החנות, ויהיה צריך לחבר ${names.length === 1 ? 'אותו' : 'אותם'} שוב.`);
  if (f.erase) lines.push(`אם הוא לא יגיע עד ${PAY_DAY.format(new Date(f.erase))}, נמחק את השיחות. עד אז אפשר <a href="/export/conversations.csv">להוריד אותן</a>.`);
  return lines.length ? `<p class="small">${lines.join(' ')}</p>` : '';
}

/**
 * A refusal page. On the pay pages (new, unpaid), `csrf` adds "לבדוק שוב": accounts is asked afresh (server.ts
 * POST /paywall/check), and the pages that stay open meanwhile: adding the store, what Toran knows, the conversations.
 */
export function refusalPage(kind: keyof typeof REFUSALS, href: string, csrf: string | null = null, facts: PayFacts | null = null): string {
  const r = kind === 'new' && facts?.store ? { ...REFUSALS.new, ...WAITING_PAY } : REFUSALS[kind];
  const pay = kind === 'new' || kind === 'unpaid';
  const again = pay && csrf ? `<form method="post" action="/paywall/check" class="mt8"><input type="hidden" name="_csrf" value="${esc(csrf)}"><button class="btn ghost wide" type="submit">${icon('refresh')}לבדוק שוב</button></form>` : '';
  const more = kind === 'new' ? (facts?.store ? `<a class="btn wide mt8" href="/knowledge">${icon('book')}מה תורן יודע</a>` : `<a class="btn wide mt8" href="/start">${icon('plus')}להוסיף את החנות</a>`) : kind === 'unpaid' ? `<a class="btn wide mt8" href="/chats">${icon('chat')}לשיחות</a>` : '';
  // How reading the site went, for a new customer whose store exists: /start is not theirs to see any more (it goes to
  // Today, which waits for the payment), so its progress or its failure is said here.
  const reading = kind === 'new' && facts?.store && facts.reading ? `<p class="small">${facts.reading === 'working' ? 'תורן קורא עכשיו את האתר של החנות. זה לוקח כמה דקות, ומה שנקרא מופיע ב"מה תורן יודע".' : esc(facts.reading)}</p>` : '';
  const out = pay && facts?.logout ? `<p class="small mt12 m0"><a href="${esc(facts.logout)}">יציאה</a></p>` : '';
  return `<!doctype html>
<html lang="he" dir="rtl" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
${themeMeta()}
<meta name="robots" content="noindex, nofollow">
<title>${esc(r.title)} · תורן</title>
<link rel="stylesheet" href="/static/brand.css">
<link rel="stylesheet" href="/static/style.css">
${a11yHead()}
${themeHead()}
${iconLinks()}
</head>
<body class="login">
<main class="card" data-refusal="${kind}">
  <div class="hero">${toranMark(72, { label: null })}<b>תורן</b></div>
  <h1>${esc(r.h)}</h1>
  <p>${esc(r.text)}</p>
  ${reading}${kind === 'unpaid' ? stopDates(facts) : ''}
  <a class="btn primary" href="${esc(href)}">${esc(r.link)}</a>${more}${again}${/כתבו לנו/.test(`${r.text} ${reading}`) ? `<p class="mt8 m0">${writeToUs()}</p>` : ''}
  ${out}<p class="small muted mt12 m0">${accessibilityLink()}</p>
</main>
${themeButton('corner')}
${a11yWidget()}
</body>
</html>`;
}

export function notFoundPage(ctx: PageCtx): string {
  return layout({ ...ctx, title: 'לא נמצא' }, `<div class="empty">${icon('alert')}<b>הדף הזה לא קיים</b>אולי הקישור ישן. <a href="/">חזרה להיום</a></div>`);
}

const ERROR_TITLE: Record<number, string> = { 400: 'הבקשה לא הובנה', 403: 'אי אפשר לעשות את זה מכאן', 404: 'הדף הזה לא קיים', 409: 'זה כבר לא כאן', 413: 'הקובץ גדול מדי', 415: 'אי אפשר לצרף את זה כאן', 421: 'הכתובת הזו לא שלנו', 429: 'רגע, מהר מדי' };

/**
 * An error a browser gets, as Toran's own page in Hebrew with the way back (the audit's PRA-FE-005): the page before
 * and Today. The words are ours, never an exception's: what went wrong in code goes to the log.
 */
export function errorPage(status: number, text: string, back = '/'): string {
  const title = ERROR_TITLE[status] || 'משהו לא עבד';
  return `<!doctype html>
<html lang="he" dir="rtl" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
${themeMeta()}
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)} · תורן</title>
<link rel="stylesheet" href="/static/brand.css">
<link rel="stylesheet" href="/static/style.css">
${a11yHead()}
${themeHead()}
${iconLinks()}
</head>
<body class="login">
<main class="card" data-error-status="${status}">
  <div class="hero">${toranMark(72, { label: null })}<b>תורן</b></div>
  <h1>${esc(title)}</h1>
  <p>${esc(text)}</p>
  <div class="row">${back !== '/' ? `<a class="btn primary" href="${esc(back)}">חזרה לדף הקודם</a>` : ''}<a class="btn${back === '/' ? ' primary' : ''}" href="/">להיום</a>${status >= 500 ? writeToUs() : ''}</div>
  <p class="small muted mt12 m0">${accessibilityLink()}</p>
</main>
${themeButton('corner')}
${a11yWidget()}
</body>
</html>`;
}
