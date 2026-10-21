import { iconLinks, toranMark } from '../../brand.ts';
import { esc, icon, layout, type PageCtx } from '../ui.ts';

export function loginPage({ error = null }: { error?: string | null }): string {
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex, nofollow">
<title>כניסה · תורן</title>
<link rel="stylesheet" href="/static/brand.css">
<link rel="stylesheet" href="/static/style.css">
${iconLinks()}
<link rel="manifest" href="/static/manifest.webmanifest">
</head>
<body class="login">
<form class="card" method="post" action="/login">
  <div class="hero">${toranMark(72, { label: null })}<b>תורן</b></div>
  <p>הלידים, דפי ההצגה ושיחות הדמו.</p>
  ${error ? `<div class="err" role="alert">${esc(error)}</div>` : ''}
  <label class="f">שם משתמש<input type="text" name="user" autocomplete="username" required autofocus></label>
  <label class="f">סיסמה<input type="password" name="password" autocomplete="current-password" required></label>
  <button class="btn primary" type="submit">כניסה</button>
</form>
</body>
</html>`;
}

export function notFoundPage(ctx: PageCtx): string {
  return layout({ ...ctx, title: 'לא נמצא' }, `<div class="empty">${icon('alert')}<b>הדף הזה לא קיים</b>אולי הקישור ישן. <a href="/">חזרה להיום</a></div>`);
}
