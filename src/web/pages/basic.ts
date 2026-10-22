import { iconLinks, toranMark } from '../../brand.ts';
import { esc, icon, layout, type PageCtx } from '../ui.ts';

/** Why accounts let nobody in, in OpenFrequency's voice. No redirect from any of them, so no loop with accounts. */
const REFUSALS = {
  closed: { title: 'החשבון סגור', h: 'החשבון הזה סגור', text: 'סגרנו את החשבון הזה, ולכן אי אפשר להיכנס דרכו לתורן. אם נראה לכם שזו טעות, כתבו לנו ונבדוק.', link: 'ליציאה מהחשבון' },
  not_in_plan: { title: 'תורן לא כלול', h: 'תורן לא כלול בחשבון שלכם', text: 'החשבון שלכם פתוח, אבל תורן עוד לא הופעל בו. כדי להוסיף אותו, כתבו לנו.', link: 'לחשבון שלכם' },
  error: { title: 'אי אפשר להיכנס כרגע', h: 'אי אפשר להיכנס כרגע', text: 'לא הצלחנו לבדוק מי מחובר, ולכן לא נכנסים לתורן עד שזה מסתדר. אפשר לנסות שוב בעוד כמה דקות. אם זה נמשך, כתבו לנו.', link: 'לנסות שוב' },
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
