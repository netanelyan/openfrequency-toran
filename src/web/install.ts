import { toranMark } from '../brand.ts';
import { esc, icon } from './ui.ts';

// Adding Toran to the phone as an app (the owner, 2026-11-09: "both toran and teder, add a little tutorial on how to add
// the website as an app to the phone"). On a phone, Today shows it once, as a card that closes with its x and stays
// closed in that browser (the cookie tn_install); Settings always has it, as "להוסיף לטלפון". Nothing of it is drawn
// inside the app once it is installed: style.css hides [data-install] in display-mode standalone, and static/app.js
// takes it away where only navigator.standalone says so (an iPhone's home-screen app), and remembers it.
//
// The steps are each browser's own, in the words its menu shows in Hebrew, checked on 2026-11-09:
// - iPhone, Safari (support.apple.com/he-il/guide/iphone/iphea86e5236/26/ios/26, and the iOS 18 page iph42ab2f3a7):
//   "שיתוף" (on iOS 26 behind "עוד", the ⋯, unless the tabs sit at the top or the bottom), then "הוספה למסך הבית",
//   "פתיחה ביישום רשת" on (iOS 26), and "הוסף".
// - iPhone, Chrome: since iOS 16.4 another browser may offer "Add to Home Screen" in its share menu (webkit.org, Safari
//   16.4), and Chrome does, from the share button by the address. Other iPhone browsers and apps' own browsers are
//   sent to Safari, with the link to copy: whether each one offers it is not something we checked.
// - Android, Chrome (support.google.com/chrome/answer/9658361): ⋮, "התקנה ויצירת קיצור דרך", "התקנה"; an older
//   Chrome says "הוספה למסך הבית" or "התקנת האפליקציה". Where Chrome offers its own prompt (beforeinstallprompt),
//   static/app.js swaps the steps for one button, "להתקין".
// - A desk (Settings only): Chrome's install icon in the address bar, or ⋮, "הפעלת Cast, שמירה ושיתוף", "התקנת
//   הדף כאפליקציה" (the same Google page); Edge has an install icon in the address bar too.
//
// One action at most, and the main one the most prominent (the owner's rule "easy for users"): the steps say where to
// tap in the browser's own menu, so there is no button of ours to press, except "להתקין" where Chrome lets a page
// start the install, and "להעתיק את הקישור" where the steps start in another browser.

export type InstallPlatform = 'ios-safari' | 'ios-chrome' | 'ios-other' | 'android-chrome' | 'android-other' | 'desktop';
/** What the page knows of the browser: its kind, and whether Today's card was closed or the app already seen installed. */
export type InstallCtx = { platform: InstallPlatform; closed: boolean };

export const INSTALL_COOKIE = 'tn_install';

/**
 * The browser by its user agent. An iPad on iPadOS 13 and later says it is a Mac; that one is a desk here, and
 * static/app.js turns it into Safari's steps by its touch screen. Apps' own browsers (Instagram, Facebook, Google's app,
 * a webview on Android) cannot add a page, so they get "open it in Safari / Chrome".
 */
export function installPlatform(ua: string): InstallPlatform {
  const u = String(ua || '');
  if (/iPhone|iPad|iPod/.test(u)) {
    if (/CriOS\//.test(u)) return 'ios-chrome';
    if (/FxiOS|EdgiOS|OPiOS|YaBrowser|GSA\/|FBAN|FBAV|Instagram|Line\/|WhatsApp/.test(u) || !/Version\/[\d.]+.*Safari\//.test(u)) return 'ios-other';
    return 'ios-safari';
  }
  if (/Android/.test(u)) return /Chrome\/\d/.test(u) && !/; wv\)|SamsungBrowser|EdgA|OPR\/|Firefox|YaBrowser|Instagram|FBAN|FBAV|GSA\//.test(u) ? 'android-chrome' : 'android-other';
  return 'desktop';
}

/** The request's: its user agent, and the cookie (closed, or the installed app was opened in this browser). */
export const installOf = (ua: string, jar: Record<string, string>): InstallCtx => ({ platform: installPlatform(ua), closed: jar[INSTALL_COOKIE] === 'hide' || jar[INSTALL_COOKIE] === 'app' });

const PHONE: InstallPlatform[] = ['ios-safari', 'ios-chrome', 'ios-other', 'android-chrome', 'android-other'];
const isPhone = (p: InstallPlatform) => PHONE.includes(p);

/** A step: the button to look for, small, as the browser draws it, and what to do with it. */
const step = (ic: string, html: string, more = '') => `<li><span class="key">${icon(ic)}</span><span>${html}${more ? `<small>${more}</small>` : ''}</span></li>`;
/** An icon inside a line of text, at the text's size. */
const inl = (ic: string) => icon(ic, 'i inl');

/**
 * The link to open in the other browser, copied by static/app.js's copy (data-copy): the field is filled there with the
 * page's own origin, so the link is the site the phone is on.
 */
const copy = (browser: string) => `<input type="hidden" data-install-url value=""><button class="btn primary" type="button" data-copy="[data-install-url]" data-done="${esc(`הקישור הועתק. עכשיו פותחים אותו ב${browser}.`)}">${icon('copy')}להעתיק את הקישור</button>`;

/** Each browser's steps; the one the server guessed shows, the rest wait hidden for static/app.js to pick another. */
function variants(shown: InstallPlatform | 'prompt'): string {
  const v = (key: InstallPlatform | 'prompt', inner: string) => `<div data-for="${key}"${key === shown ? '' : ' hidden'}>${inner}</div>`;
  return [
    v('ios-safari', `<ol class="isteps">
${step('share', `מקישים על <b>שיתוף</b>`, `לא רואים אותו? מקישים קודם על ${inl('dots')} ליד הכתובת.`)}
${step('addsq', 'גוללים למטה ובוחרים <b>הוספה למסך הבית</b>')}
${step('check', 'מקישים על <b>הוסף</b>', 'אם יש מתג של "פתיחה ביישום רשת", משאירים אותו דלוק.')}
</ol>`),
    v('ios-chrome', `<ol class="isteps">
${step('share', `מקישים על <b>שיתוף</b> ${inl('share')} ליד הכתובת`)}
${step('addsq', 'בוחרים <b>הוספה למסך הבית</b>')}
${step('check', 'מקישים על <b>הוסף</b>')}
</ol>`),
    v('ios-other', `<p class="m0">הכי פשוט להוסיף מספארי. מעתיקים את הקישור, פותחים אותו בספארי, ושם מקישים על ${inl('share')} <b>שיתוף</b> ואז <b>הוספה למסך הבית</b>.</p><div class="row mt12">${copy('ספארי')}</div>`),
    v('android-chrome', `<ol class="isteps">
${step('kebab', 'מקישים על שלוש הנקודות למעלה')}
${step('get', 'בוחרים <b>התקנה ויצירת קיצור דרך</b>', 'בגרסה ישנה של כרום זה נקרא "הוספה למסך הבית".')}
${step('check', 'מקישים על <b>התקנה</b>')}
</ol>`),
    v('android-other', `<p class="m0">הכי פשוט להתקין מכרום. מעתיקים את הקישור, פותחים אותו בכרום, ושם מקישים על ${inl('kebab')} ואז <b>התקנה</b>.</p><div class="row mt12">${copy('כרום')}</div>`),
    v('desktop', `<ol class="isteps">
${step('install', 'בכרום או באדג׳ לוחצים על סמל ההתקנה בשורת הכתובת', 'לא רואים אותו? בתפריט ⋮ של כרום בוחרים "הפעלת Cast, שמירה ושיתוף" ואז "התקנת הדף כאפליקציה".')}
</ol><p class="small muted mt12 m0">בטלפון פותחים את ההגדרות בתורן, ושם כתוב איך מוסיפים.</p>`),
    v('prompt', `<button class="btn primary" type="button" data-install-go>${icon('get')}להתקין</button>`),
  ].join('\n');
}

const WHY = 'תורן ייפתח מהאייקון כמו אפליקציה, ויוכל לשלוח לכם התראות.';

/**
 * Today's card: on a phone, until it is closed in this browser. Nothing on a desk, under accounts' /admin (ctx null),
 * or for a page that does not know the browser.
 */
export function installCard(install: InstallCtx | null | undefined): string {
  if (!install || install.closed || !isPhone(install.platform)) return '';
  return `<section class="panel install" id="install-card" data-install="card" aria-labelledby="install-h">
<header><span class="install-mark">${toranMark(40, { label: null })}</span><div><h2 id="install-h">להוסיף את תורן למסך הבית</h2><p class="small muted m0">${esc(WHY)}</p></div><button class="x" type="button" data-install-close aria-label="לסגור">${icon('x')}</button></header>
${variants(install.platform)}
</section>`;
}

/** Settings' panel, "להוסיף לטלפון": always there (but in the installed app), with this browser's steps first. */
export function installPanel(install: InstallCtx | null | undefined): string {
  if (!install) return '';
  return `<section class="panel install" id="install" data-install="panel" aria-labelledby="install-p">
<header><span class="install-mark">${toranMark(40, { label: null })}</span><div><h2 id="install-p">להוסיף לטלפון</h2><p class="small muted m0">${esc(WHY)}</p></div></header>
${variants(install.platform)}
</section>`;
}
