// Light or dark, one choice for every OpenFrequency site (the owner, 2026-11-02: "make sure that every repo starts on
// light mode. changing it on one subdomain changes it on all of the subdomains."): the cookie of-theme, "light" or
// "dark", for .openfrequency.co.il on any of its sites and for this host alone anywhere else, for a year, Secure over
// https. The server already sent the page in the theme the cookie says (src/web/theme.ts); this file loads in the head
// without defer and only keeps up with a cookie it can read that says otherwise, before the page paints: a page that came
// through accounts' /admin, which passes Toran only its own tn_ cookies, or a page back from the browser's history after
// another site changed it. The button (theme.ts themeButton, the website's) flips data-theme at once, says so in
// aria-pressed, the color-scheme and the browser's bar (theme-color), and writes the cookie. It shows once this file
// has put theme-js on <html>, here in the head, so it is in the top bar from the first paint and nothing moves; without
// script it stays hidden and the page is the theme the server sent. The CSP allows no inline script.
(() => {
  const root = document.documentElement;
  root.classList.add('theme-js');
  const NAME = 'of-theme';
  const COLOR = { light: '#eeeff2', dark: '#111113' };
  const SITE = 'openfrequency.co.il';

  /** The cookie that keeps `theme`: every OpenFrequency site's on one of them, this host's alone anywhere else. */
  const cookieFor = (theme) => {
    const host = location.hostname.toLowerCase();
    const shared = host === SITE || host.endsWith(`.${SITE}`);
    return `${NAME}=${theme}${shared ? `; Domain=.${SITE}` : ''}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`;
  };
  /** What the cookie says, or null when this page sees none (then the server's theme stands). */
  const saved = () => {
    try {
      const m = /(?:^|;\s*)of-theme=([^;]*)/.exec(document.cookie);
      return m ? (m[1] === 'dark' ? 'dark' : 'light') : null;
    } catch {
      return null;
    }
  };
  const now = () => (root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');
  const set = (theme) => {
    root.setAttribute('data-theme', theme);
    document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', theme);
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', COLOR[theme]);
    for (const b of document.querySelectorAll('[data-theme-toggle]')) b.setAttribute('aria-pressed', String(theme === 'dark'));
  };
  const keep = () => {
    const s = saved();
    if (s && s !== now()) set(s);
  };
  keep();
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) keep();
  });

  const wire = () => {
    for (const b of document.querySelectorAll('[data-theme-toggle]')) {
      b.addEventListener('click', () => {
        const next = now() === 'dark' ? 'light' : 'dark';
        set(next);
        try {
          document.cookie = cookieFor(next);
        } catch {}
      });
    }
    set(now());
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire, { once: true });
  else wire();
})();
