// Light or dark, one choice for every OpenFrequency site (the owner, 2026-11-02: "make sure that every repo starts on
// light mode. changing it on one subdomain changes it on all of the subdomains."). The choice is the cookie of-theme,
// "light" or "dark", which openfrequency.co.il, Teder, accounts and Toran all read and write: the button
// (static/theme.js) writes it for .openfrequency.co.il on any of them, for the host alone anywhere else. No cookie, or
// anything else in it, is light; the device's own setting is never asked.
//
// Every page is rendered light: data-theme="light" on its <html>, themeMeta() in its head. send() (server.ts) hands a
// reader whose cookie says dark the same page dark (themed()), so it is dark before it paints. A page that is light
// only (a pitch page, the message-settings page: the store's own, in its colours, docs/decisions.md 2026-10-22) has no
// data-theme and is left as it is.

export const THEME_COOKIE = 'of-theme';
/** The browser's own bar in each theme: the wallpaper's colour (style.css --bg). */
export const THEME_COLOR = { light: '#eeeff2', dark: '#111113' } as const;
export type Theme = keyof typeof THEME_COLOR;

/** The theme a request's cookies ask for: dark only when of-theme is exactly "dark". */
export const themeOf = (jar: Record<string, string>): Theme => (jar[THEME_COOKIE] === 'dark' ? 'dark' : 'light');

/** The head's two lines for a theme: one color-scheme, one theme-color. */
export const themeMeta = (t: Theme = 'light') => `<meta name="color-scheme" content="${t}">\n<meta name="theme-color" content="${THEME_COLOR[t]}">`;

/** The theme's script, in the head after the stylesheets and without defer, as a11y.js is (the CSP allows no inline script). */
export const themeHead = (v?: string | number) => `<script src="/static/theme.js${v ? `?v=${encodeURIComponent(String(v))}` : ''}"></script>`;

/**
 * The website's button (openfrequency-web src/layout.mjs themeButton): a moon while light, a sun while dark, one name,
 * pressed while dark. Shown once static/theme.js runs (style.css .theme-js), so a page without script never shows a dead
 * button. `cls` places it: in the top bar, or beside the accessibility panel's button on a page without one.
 */
export const themeButton = (cls = '') => `<button class="theme${cls ? ` ${cls}` : ''}" type="button" data-theme-toggle aria-pressed="false" aria-label="מצב כהה"><svg class="moon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/></svg><svg class="sun" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/></svg></button>`;

const LIGHT_HTML = /(<html\b[^>]*?\s)data-theme="light"/;

/** A page rendered light, as the reader who chose `t` gets it. Only a page whose <html> says data-theme="light" changes. */
export function themed(html: string, t: Theme): string {
  if (t === 'light') return html;
  const end = html.indexOf('</head>');
  if (end < 0) return html;
  const head = html.slice(0, end);
  if (!LIGHT_HTML.test(head)) return html;
  return head.replace(LIGHT_HTML, `$1data-theme="${t}"`).replace(themeMeta('light'), themeMeta(t)) + html.slice(end);
}
