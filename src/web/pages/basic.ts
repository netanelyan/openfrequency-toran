import { iconLinks, toranMark } from '../../brand.ts';
import { esc, icon, layout, type PageCtx } from '../ui.ts';

/** Why accounts let nobody in, in OpenFrequency's voice. No redirect from any of them, so no loop with accounts. */
const REFUSALS = {
  closed: { title: 'החשבון סגור', h: 'החשבון הזה סגור', text: 'סגרנו את החשבון הזה, ולכן אי אפשר להיכנס דרכו לתורן. אם נראה לכם שזו טעות, כתבו לנו ונבדוק.', link: 'ליציאה מהחשבון' },
  not_in_plan: { title: 'תורן לא כלול', h: 'תורן לא כלול בחשבון שלכם', text: 'החשבון שלכם פתוח, אבל תורן עוד לא הופעל בו. כדי להוסיף אותו, כתבו לנו.', link: 'לחשבון שלכם' },
  error: { title: 'אי אפשר להיכנס כרגע', h: 'אי אפשר להיכנס כרגע', text: 'לא הצלחנו לבדוק מי מחובר, ולכן לא נכנסים לתורן עד שזה מסתדר. אפשר לנסות שוב בעוד כמה דקות. אם זה נמשך, כתבו לנו.', link: 'לנסות שוב' },
  // The paywall (billing/entitlement.ts): accounts says the workspace has not paid for Toran, or could not be asked.
  unpaid: { title: 'התשלום לא פעיל', h: 'התשלום על תורן לא פעיל', text: 'כדי להמשיך להשתמש בתורן צריך להסדיר את התשלום בחשבון שלכם. עד אז תורן לא עונה ללקוחות בעצמו, וכל הודעה שלהם עוברת אליכם. הידע, השיחות וההגדרות של החנות נשמרים כמו שהם.', link: 'להסדרת התשלום' },
  unchecked: { title: 'אי אפשר לבדוק את התשלום', h: 'אי אפשר לבדוק את התשלום כרגע', text: 'לא הצלחנו לבדוק את מצב התשלום על תורן, ולכן לא נכנסים עד שזה מסתדר. אפשר לנסות שוב בעוד כמה דקות. אם זה נמשך, כתבו לנו.', link: 'לנסות שוב' },
} as const;

export function refusalPage(kind: keyof typeof REFUSALS, href: string): string {
  const r = REFUSALS[kind];
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex, nofollow">
<title>${esc(r.title)} · תורן</title>
<link rel="stylesheet" href="/static/brand.css">
<link rel="stylesheet" href="/static/style.css">
${iconLinks()}
</head>
<body class="login">
<main class="card" data-refusal="${kind}">
  <div class="hero">${toranMark(72, { label: null })}<b>תורן</b></div>
  <h1>${esc(r.h)}</h1>
  <p>${esc(r.text)}</p>
  <a class="btn primary" href="${esc(href)}">${esc(r.link)}</a>
</main>
</body>
</html>`;
}

export function notFoundPage(ctx: PageCtx): string {
  return layout({ ...ctx, title: 'לא נמצא' }, `<div class="empty">${icon('alert')}<b>הדף הזה לא קיים</b>אולי הקישור ישן. <a href="/">חזרה להיום</a></div>`);
}
