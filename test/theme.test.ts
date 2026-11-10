import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { chromium } from 'playwright-core';
import { brandCss } from '../src/brand.ts';
import { THEME_COLOR, themed, themeMeta, themeOf, type Theme } from '../src/web/theme.ts';
import { errorPage } from '../src/web/pages/basic.ts';
import { goneHtml } from '../src/pitch/page.ts';
import { customer, operator } from './helpers.ts';
import { serve } from './serve.ts';

// Light or dark, one choice for every OpenFrequency site (the owner, 2026-11-02: "make sure that every repo starts on
// light mode. changing it on one subdomain changes it on all of the subdomains."). Over HTTP: every page the dashboard
// renders (the operator's, a customer's, under accounts' /admin, a refusal, an error, not found) is light without the
// cookie of-theme, whatever else it holds, and dark with of-theme=dark, in its <html> and its one color-scheme and one
// theme-color, before any script; it carries the website's button outside any form and theme.js in the head; a pitch
// page and the message-settings page stay light, by the decision of 2026-10-22. No page stylesheet asks the device for
// dark. The cookie, in theme.js itself: .openfrequency.co.il on its sites, the host alone anywhere else, Secure on
// https. In a real browser on a device that prefers dark: light, one tap to dark at once (the metas and aria-pressed
// with it), the cookie written, the next page dark from the server, and the button inside the bar, apart from its
// neighbours, on a phone and a desk.

const STATIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'web', 'static');

/** What a page says about its theme: <html>'s data-theme, every color-scheme and every theme-color in its head. */
function themeIn(html: string) {
  const head = html.slice(0, html.indexOf('</head>'));
  return {
    attr: /<html\b[^>]*\sdata-theme="([^"]*)"/.exec(head)?.[1] ?? null,
    schemes: [...head.matchAll(/<meta name="color-scheme" content="([^"]*)">/g)].map((m) => m[1]),
    colors: [...head.matchAll(/<meta name="theme-color"([^>]*)>/g)].map((m) => m[1]),
  };
}
function isTheme(html: string, t: Theme, where: string) {
  const got = themeIn(html);
  assert.equal(got.attr, t, `${where}: <html data-theme="${t}">`);
  assert.deepEqual(got.schemes, [t], `${where}: one color-scheme, ${t}`);
  assert.deepEqual(got.colors, [` content="${THEME_COLOR[t]}"`], `${where}: one theme-color, ${THEME_COLOR[t]}, with no media query`);
}
/** The website's button, once, in the body and in no form, and theme.js in the head without defer. */
function hasSwitch(html: string, where: string, base = '') {
  const head = html.slice(0, html.indexOf('</head>'));
  assert.match(head, new RegExp(`<script src="${base}/static/theme\\.js(\\?v=\\w+)?"></script>`), `${where}: theme.js in the head, without defer`);
  const buttons = [...html.matchAll(/<button class="theme( corner)?" type="button" data-theme-toggle aria-pressed="false" aria-label="מצב כהה"><svg class="moon" viewBox="0 0 24 24" aria-hidden="true"><path [^>]+\/><\/svg><svg class="sun" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"\/><path [^>]+\/><\/svg><\/button>/g)];
  assert.equal(buttons.length, 1, `${where}: the website's button, once`);
  const before = html.slice(0, buttons[0].index);
  assert.equal((before.match(/<form\b/g) || []).length, (before.match(/<\/form>/g) || []).length, `${where}: the button is in no form`);
}

test('themeOf, themeMeta and themed: dark only for of-theme=dark; a light page turned dark; a page with no data-theme left alone', () => {
  assert.equal(themeOf({}), 'light');
  assert.equal(themeOf({ 'of-theme': 'dark' }), 'dark');
  for (const junk of ['light', 'DARK', 'Dark', 'dark ', 'darker', '1', '', 'auto', 'system']) assert.equal(themeOf({ 'of-theme': junk }), 'light', `"${junk}" is light`);
  assert.equal(themeOf({ of_theme: 'dark', theme: 'dark' }), 'light', 'only the cookie of-theme');
  assert.equal(themeMeta(), '<meta name="color-scheme" content="light">\n<meta name="theme-color" content="#eeeff2">');
  assert.equal(themeMeta('dark'), '<meta name="color-scheme" content="dark">\n<meta name="theme-color" content="#111113">');
  const light = errorPage(404, 'x');
  isTheme(light, 'light', 'the error page as rendered');
  assert.equal(themed(light, 'light'), light);
  isTheme(themed(light, 'dark'), 'dark', 'the error page for a dark reader');
  assert.equal(themed(light, 'dark').replace('data-theme="dark"', 'data-theme="light"').replace(themeMeta('dark'), themeMeta('light')), light, 'nothing else changes');
  // A page that is light only has no data-theme, and stays as it is.
  const gone = goneHtml(false);
  assert.equal(themed(gone, 'dark'), gone);
  // Only the <html> tag and the head: words in the body that look like them are text.
  const body = '<!doctype html>\n<html lang="he" data-theme="light">\n<head>\n' + themeMeta() + '\n</head>\n<body><p>data-theme="light"</p><pre>' + themeMeta() + '</pre></body></html>';
  assert.equal(themed(body, 'dark').split('</head>')[1], body.split('</head>')[1]);
});

test('every page the dashboard renders: light with no cookie or a junk one, dark with of-theme=dark, before any script; the button on each', async () => {
  const s = await serve();
  try {
    const slug = (await s.app.db.one<{ slug: string }>('SELECT slug FROM stores WHERE id = $1', [s.seeded.storeId]))!.slug;
    const id = s.seeded.storeId;
    const op = s.accounts.session(operator()).cookie;
    const cu = s.accounts.session(customer(1)).cookie;
    s.accounts.paid(2, 'unpaid');
    const unpaid = s.accounts.session(customer(2)).cookie;
    const pages: [string, string, Record<string, string>?][] = [
      [op, '/'], [op, '/leads'], [op, `/lead/${id}`], [op, '/review'], [op, '/chats'], [op, '/settings'], [op, '/brand'], [op, '/no-such-page'],
      [cu, '/'], [cu, '/chats'], [cu, '/knowledge'], [cu, '/plan'], [cu, '/settings'],
      // accounts' /admin: the operator's pages under its prefix
      [op, '/admin/toran/leads', { 'x-of-admin-prefix': '/admin/toran' }],
      [unpaid, '/'], // the refusal: this workspace has not paid
      ['', '/%E0%A4%A'], // an error: an address that does not parse
    ];
    for (const [cookie, theme] of [['', 'light'], ['of-theme=dark', 'dark'], ['of-theme=purple', 'light'], ['of-theme=DARK', 'light'], ['of-theme=', 'light'], ['of-theme=light', 'light'], ['theme=dark; of_theme=dark', 'light']] as [string, Theme][]) {
      for (const [session, p, headers] of pages) {
        s.as([session, cookie].filter(Boolean).join('; '));
        const r = await s.get(p, headers);
        const html = await r.text();
        const where = `${p} with "${cookie || 'no cookie'}"`;
        assert.match(String(r.headers.get('content-type')), /^text\/html/, where);
        isTheme(html, theme, where);
        hasSwitch(html, where, p.startsWith('/admin/toran') ? '/admin/toran' : '');
        assert.equal(r.headers.get('cache-control'), 'no-store', `${where}: never cached, since the cookie decides it`);
      }
    }
    // The light-only pages: a pitch page, one not there, the message settings of a link that is not ours.
    for (const cookie of ['', 'of-theme=dark']) {
      for (const [session, p] of [[op, `/s/${slug}`], ['', '/s/no-such-page'], ['', '/u/not-a-real-token-at-all']]) {
        s.as([session, cookie].filter(Boolean).join('; '));
        const html = await (await s.get(p)).text();
        const got = themeIn(html);
        assert.equal(got.attr, null, `${p}: light only, no data-theme`);
        assert.deepEqual(got.schemes, ['light'], `${p} with "${cookie || 'no cookie'}": light`);
        assert.ok(!html.includes('data-theme-toggle') && !html.includes('/static/theme.js'), `${p}: no button, no theme script`);
      }
    }
    const js = await s.get('/static/theme.js');
    assert.equal(js.status, 200);
    assert.match(String(js.headers.get('content-type')), /^text\/javascript/);
    assert.match(String(js.headers.get('content-security-policy')), /script-src 'self';/, 'the policy is the same: script from this site only');
  } finally {
    await s.close();
  }
});

test('no page stylesheet asks the device for dark: every dark rule hangs on data-theme', () => {
  const sheets: [string, string][] = [
    ['style.css', readFileSync(path.join(STATIC, 'style.css'), 'utf8')],
    ['pitch.css', readFileSync(path.join(STATIC, 'pitch.css'), 'utf8')],
    ['a11y.css', readFileSync(path.join(STATIC, 'a11y.css'), 'utf8')],
    ['brand.css', brandCss()],
    // The pro look's layer (style.ts), sent after style.css unless TORAN_STYLE=glass.
    ['style-pro.css', readFileSync(path.join(STATIC, 'style-pro.css'), 'utf8')],
  ];
  for (const [name, css] of sheets) {
    assert.doesNotMatch(css, /prefers-color-scheme/, `${name}: no prefers-color-scheme`);
    assert.doesNotMatch(css, /color-scheme:\s*light\s+dark|light dark/, `${name}: no "light dark"`);
  }
  const style = sheets[0][1];
  assert.match(style, /:root \{\n  color-scheme: light;\n  --bg: #eeeff2;/, 'light is the page as it is');
  assert.match(style, /:root\[data-theme="dark"\] \{\n  color-scheme: dark;\n  --bg: #111113;/, 'dark is the choice');
  assert.match(style, /html\[data-theme="dark"\]\.a-contrast \{ --ink-2: #f5f5f7;/, 'the accessibility panel\'s high contrast in dark');
  assert.match(sheets[3][1], /:root\[data-theme="dark"\] \{ --accent: #2997FF; \}/, 'the blue as text in dark');
  // The button's own rules, the website's: the moon in light, the sun in dark.
  assert.ok(style.includes('.theme .sun, [data-theme="dark"] .theme .moon { display: none; }') && style.includes('[data-theme="dark"] .theme .sun { display: block; }'));
});

/** theme.js run against a page of its own: `host` and `protocol` its location, `html` its data-theme, `cookie` what it can read. */
function runTheme({ host, protocol = 'https:', html = 'light', cookie = '' }: { host: string; protocol?: string; html?: Theme; cookie?: string }) {
  const code = readFileSync(path.join(STATIC, 'theme.js'), 'utf8');
  const written: string[] = [];
  const attrs: Record<string, string> = { 'data-theme': html };
  const classes = new Set<string>();
  const metas: Record<string, { content: string }> = { 'meta[name="color-scheme"]': { content: html }, 'meta[name="theme-color"]': { content: THEME_COLOR[html] } };
  const clicks: (() => void)[] = [];
  const button = { pressed: '', setAttribute(k: string, v: string) { if (k === 'aria-pressed') this.pressed = v; }, addEventListener(t: string, f: () => void) { if (t === 'click') clicks.push(f); } };
  const document = {
    documentElement: { classList: { add: (c: string) => classes.add(c) }, getAttribute: (k: string) => attrs[k] ?? null, setAttribute: (k: string, v: string) => { attrs[k] = v; } },
    readyState: 'complete',
    querySelector: (sel: string) => (metas[sel] ? { setAttribute: (_k: string, v: string) => { metas[sel].content = v; } } : null),
    querySelectorAll: (sel: string) => (sel === '[data-theme-toggle]' ? [button] : []),
    get cookie() { return cookie; },
    set cookie(v: string) { written.push(v); },
    addEventListener() {},
  };
  vm.runInNewContext(code, { document, location: { hostname: host, protocol }, window: { addEventListener() {} } });
  return { written, attrs, classes, metas, button, click: () => clicks.forEach((f) => f()) };
}

test('the cookie theme.js writes: .openfrequency.co.il on its sites, the host alone anywhere else, Secure on https, a year, Lax', () => {
  const tail = '; Path=/; Max-Age=31536000; SameSite=Lax';
  const cases: [string, string, string][] = [
    ['toran.openfrequency.co.il', 'https:', `of-theme=dark; Domain=.openfrequency.co.il${tail}; Secure`],
    ['accounts.openfrequency.co.il', 'https:', `of-theme=dark; Domain=.openfrequency.co.il${tail}; Secure`],
    ['openfrequency.co.il', 'https:', `of-theme=dark; Domain=.openfrequency.co.il${tail}; Secure`],
    ['TORAN.OpenFrequency.co.il', 'https:', `of-theme=dark; Domain=.openfrequency.co.il${tail}; Secure`],
    ['localhost', 'http:', `of-theme=dark${tail}`],
    ['127.0.0.1', 'http:', `of-theme=dark${tail}`],
    ['localhost', 'https:', `of-theme=dark${tail}; Secure`],
    ['notopenfrequency.co.il', 'https:', `of-theme=dark${tail}; Secure`],
    ['openfrequency.co.il.example.com', 'https:', `of-theme=dark${tail}; Secure`],
  ];
  for (const [host, protocol, want] of cases) {
    const t = runTheme({ host, protocol });
    assert.ok(t.classes.has('theme-js'), `${host}: theme-js on <html>, which shows the button`);
    assert.equal(t.button.pressed, 'false');
    t.click();
    assert.deepEqual(t.written, [want], `${protocol}//${host}`);
    // The click turns the page dark at once, with its metas and the button.
    assert.equal(t.attrs['data-theme'], 'dark');
    assert.equal(t.metas['meta[name="color-scheme"]'].content, 'dark');
    assert.equal(t.metas['meta[name="theme-color"]'].content, '#111113');
    assert.equal(t.button.pressed, 'true');
    t.click();
    assert.equal(t.written[1], want.replace('of-theme=dark', 'of-theme=light'), `${host}: and back`);
    assert.equal(t.attrs['data-theme'], 'light');
    assert.equal(t.metas['meta[name="theme-color"]'].content, '#eeeff2');
    assert.equal(t.button.pressed, 'false');
  }
  // A cookie the page can read and the server did not see (accounts' /admin passes Toran only tn_ cookies): on before paint.
  const proxied = runTheme({ host: 'accounts.openfrequency.co.il', html: 'light', cookie: 'a=1; of-theme=dark' });
  assert.equal(proxied.attrs['data-theme'], 'dark');
  assert.equal(proxied.metas['meta[name="theme-color"]'].content, '#111113');
  assert.deepEqual(proxied.written, [], 'reading writes nothing');
  assert.equal(runTheme({ host: 'toran.openfrequency.co.il', html: 'dark', cookie: 'of-theme=light' }).attrs['data-theme'], 'light');
  assert.equal(runTheme({ host: 'toran.openfrequency.co.il', html: 'dark', cookie: 'of-theme=purple' }).attrs['data-theme'], 'light', 'junk is light');
  // None it can read: the server's theme stands.
  assert.equal(runTheme({ host: 'toran.openfrequency.co.il', html: 'dark', cookie: 'x-of-theme=light' }).attrs['data-theme'], 'dark');
  assert.equal(runTheme({ host: 'toran.openfrequency.co.il', html: 'dark' }).attrs['data-theme'], 'dark');
});

async function launch() {
  const errors: string[] = [];
  for (const opts of [{}, { channel: 'chrome' }] as { channel?: string }[]) {
    try {
      return await chromium.launch(opts);
    } catch (e) {
      errors.push(`${opts.channel || 'playwright chromium'}: ${String((e as Error).message).split('\n')[0]}`);
    }
  }
  throw new Error(`no browser for the theme's check (install one: npx playwright-core install chromium)\n${errors.join('\n')}`);
}

type Box = { x: number; y: number; width: number; height: number };
const inside = (a: Box, b: Box) => a.x >= b.x && a.y >= b.y && a.x + a.width <= b.x + b.width && a.y + a.height <= b.y + b.height;
/** The gap between two boxes that do not overlap (0 when they touch or overlap). */
const gap = (a: Box, b: Box) => Math.max(0, Math.max(b.x - (a.x + a.width), a.x - (b.x + b.width), b.y - (a.y + a.height), a.y - (b.y + b.height)));

test('in a real browser on a device that prefers dark: light, one tap to dark and back, the cookie, the next page dark from the server, the button apart from its neighbours', async () => {
  const s = await serve();
  const browser = await launch();
  try {
    const op = s.accounts.session(operator());
    const cu = s.accounts.session(customer(1));
    for (const [device, viewport] of [['phone', { width: 390, height: 844 }], ['desk', { width: 1280, height: 800 }]] as const) {
      const context = await browser.newContext({ viewport, colorScheme: 'dark', ...(device === 'phone' ? { isMobile: true, hasTouch: true } : {}) });
      await context.addInitScript(() => {
        const w = window as any;
        w.__csp = [];
        document.addEventListener('securitypolicyviolation', (e) => w.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
        // The theme the page had when its body began: the server's, before anything painted.
        const mo = new MutationObserver(() => {
          if (document.body && w.__atBody === undefined) {
            w.__atBody = document.documentElement.getAttribute('data-theme');
            w.__shownAtBody = document.documentElement.classList.contains('theme-js');
            mo.disconnect();
          }
        });
        mo.observe(document, { childList: true, subtree: true });
      });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e: Error) => errors.push(e.message));
      page.on('console', (m: any) => m.type() === 'error' && /Content Security Policy|Refused/.test(m.text()) && errors.push(m.text()));
      const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      const meta = (name: string) => page.getAttribute(`meta[name="${name}"]`, 'content');
      // In the page's own px: a desk shows the page at 90% (style.css --z), and the sizes below are the design's.
      const box = (sel: string) => page.$eval(sel, (el: Element) => { const r = el.getBoundingClientRect(); const z = Number(getComputedStyle(document.documentElement).zoom) || 1; return { x: r.x / z, y: r.y / z, width: r.width / z, height: r.height / z }; });

      for (const [sid, p] of [[op.sid, '/'], [cu.sid, '/'], [cu.sid, '/plan']] as const) {
        const where = `${device} ${p} (${sid === op.sid ? 'operator' : 'customer'})`;
        await context.clearCookies();
        await context.addCookies([{ name: 'of_session', value: sid, url: s.base }]);
        await page.goto(`${s.base}${p}`, { waitUntil: 'load' });
        assert.equal(await page.evaluate(() => document.documentElement.getAttribute('data-theme')), 'light', `${where}: light, though the device prefers dark`);
        assert.equal(await bg(), 'rgb(238, 239, 242)', `${where}: the light wallpaper`);
        assert.equal(await page.isVisible('.top [data-theme-toggle]'), true, `${where}: the button in the top bar`);
        assert.equal(await page.evaluate(() => (window as any).__shownAtBody), true, `${where}: shown from the head, so the bar never moves`);
        assert.equal(await page.getAttribute('[data-theme-toggle]', 'aria-pressed'), 'false');
        // In the bar, apart from the meter and the sign-out beside it.
        const bar = await box('.top .wrap');
        const btn = await box('.top [data-theme-toggle]');
        assert.ok(inside(btn, bar), `${where}: inside the bar (${JSON.stringify(btn)} in ${JSON.stringify(bar)})`);
        assert.ok(btn.width >= 40 && btn.height >= 40, `${where}: a 40px target at least`);
        // 8px from the meter and the sign-out beside it; on a desk the meter is the row above, 4px up as the side bar's rows are.
        for (const n of ['.top .spend', '.top .logout']) {
          const g = gap(btn, await box(n));
          assert.ok(g >= (device === 'desk' && n === '.top .spend' ? 4 : 8) - 0.25, `${where}: ${g}px from ${n}`);
        }

        await page.click('[data-theme-toggle]');
        assert.equal(await page.evaluate(() => document.documentElement.getAttribute('data-theme')), 'dark', `${where}: dark at once`);
        assert.equal(await bg(), 'rgb(17, 17, 19)', `${where}: the dark wallpaper`);
        assert.equal(await meta('theme-color'), '#111113');
        assert.equal(await meta('color-scheme'), 'dark');
        assert.equal(await page.getAttribute('[data-theme-toggle]', 'aria-pressed'), 'true');
        assert.equal(await page.isVisible('[data-theme-toggle] .sun'), true, `${where}: a sun while dark`);
        assert.equal(await page.isVisible('[data-theme-toggle] .moon'), false);
        const c = (await context.cookies()).find((x: any) => x.name === 'of-theme');
        assert.ok(c, `${where}: the cookie is written`);
        assert.deepEqual([c.value, c.domain, c.path, c.sameSite, c.httpOnly, c.secure], ['dark', '127.0.0.1', '/', 'Lax', false, false], `${where}: this host alone over http`);
        assert.ok(c.expires * 1000 - Date.now() > 364 * 86_400_000, `${where}: for a year`);

        // The next page comes dark from the server: dark when its body began, and the error page too.
        await page.reload({ waitUntil: 'load' });
        assert.equal(await page.evaluate(() => (window as any).__atBody), 'dark', `${where}: dark before the body`);
        assert.equal(await meta('theme-color'), '#111113');
        assert.equal(await page.getAttribute('[data-theme-toggle]', 'aria-pressed'), 'true');
        // And back to light, written as light.
        await page.click('[data-theme-toggle]');
        assert.equal(await bg(), 'rgb(238, 239, 242)');
        assert.equal((await context.cookies()).find((x: any) => x.name === 'of-theme')?.value, 'light');
        await page.reload({ waitUntil: 'load' });
        assert.equal(await page.evaluate(() => (window as any).__atBody), 'light', `${where}: light again from the server`);
      }

      // A page with no bar (an error, signed out): the button beside the accessibility panel's, dark from the cookie.
      await context.clearCookies();
      await context.addCookies([{ name: 'of-theme', value: 'dark', url: s.base }]);
      await page.goto(`${s.base}/%E0%A4%A`, { waitUntil: 'load' });
      assert.equal(await page.evaluate(() => (window as any).__atBody), 'dark', `${device}: the error page dark from the server`);
      assert.equal(await bg(), 'rgb(17, 17, 19)');
      const t = await box('.theme.corner');
      const a = await box('.a11y-btn');
      assert.ok(t.width >= 44 && Math.abs(t.y - a.y) < 1, `${device}: beside the accessibility button, in one line (${JSON.stringify(t)} ${JSON.stringify(a)})`);
      assert.ok(gap(t, a) >= 8, `${device}: ${gap(t, a)}px from the accessibility button`);
      assert.ok(gap(t, await box('main.card')) >= 8 || t.y > (await box('main.card')).y + (await box('main.card')).height, `${device}: off the card`);
      await page.click('.theme.corner');
      assert.equal(await bg(), 'rgb(238, 239, 242)');
      assert.equal((await context.cookies()).find((x: any) => x.name === 'of-theme')?.value, 'light');

      assert.deepEqual(await page.evaluate(() => (window as any).__csp), [], `${device}: no CSP refusal`);
      assert.deepEqual(errors, [], `${device}: no CSP refusal or script error`);
      await context.close();
    }
  } finally {
    await browser.close();
    await s.close();
  }
});
