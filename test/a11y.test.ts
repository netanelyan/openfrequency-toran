import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { customer, operator } from './helpers.ts';
import { serve } from './serve.ts';

// The accessibility panel on every page Toran serves (the owner, 2026-10-31: "accesebillity widget should be available
// in each subdomain. not only on the web repo"): the website's (openfrequency.co.il) four switches, its words, its key
// in the browser (of-a11y) and its statement, on the dashboard, its refusals and errors, the pitch pages and the
// message-settings page. Over HTTP: every page has the panel, its stylesheet and its script in the head, and the files
// are served. In a real browser: the button is reached by Tab, opens the panel, a switch puts its class on <html> and
// it is still there after a reload (before the page is painted), Escape and a click outside close it, nothing breaks the
// CSP, the button never sits on the tab bar or the page's own bar, and no page scrolls sideways at 390 with larger text.
//
// The browser is Playwright's own Chromium (npx playwright-core install chromium), else the installed Chrome; with
// neither the test fails, since a check that did not run is not a pass.

const STATEMENT = 'href="https://openfrequency.co.il/accessibility"';
const SWITCHES = [['big', 'טקסט גדול יותר'], ['contrast', 'ניגודיות גבוהה'], ['links', 'קו מתחת לקישורים'], ['still', 'לעצור תנועה']];

/** The panel's markup and its files in the head, as every page must carry them. */
function carries(html: string, where: string, base = '') {
  const head = html.slice(0, html.indexOf('</head>'));
  assert.match(head, new RegExp(`<link rel="stylesheet" href="${base}/static/a11y\\.css(\\?v=\\w+)?">`), `${where}: a11y.css in the head`);
  assert.match(head, new RegExp(`<script src="${base}/static/a11y\\.js(\\?v=\\w+)?"></script>`), `${where}: a11y.js in the head, without defer, so the saved switches are on before paint`);
  const at = html.indexOf('<div class="a11y-w" data-a11y hidden>');
  assert.ok(at > 0 && at > html.indexOf('<body'), `${where}: the panel in the body`);
  const panel = html.slice(at, html.indexOf('</div>\n</div>', at));
  assert.match(panel, /<button class="a11y-btn" type="button" aria-expanded="false" aria-controls="a11y-p">[^]*<span class="sr">נגישות<\/span><\/button>\n<div class="a11y-p" id="a11y-p" role="group" aria-labelledby="a11y-h" hidden>/, `${where}: the button, then its panel`);
  for (const [k, label] of SWITCHES) assert.ok(panel.includes(`<button type="button" data-a="${k}" aria-pressed="false">${label}</button>`), `${where}: the switch ${k}`);
  assert.ok(panel.includes('<button type="button" class="a11y-reset" data-a11y-reset>לאפס</button>'), `${where}: the reset`);
  assert.ok(panel.includes(`<a ${STATEMENT} rel="noopener">הצהרת הנגישות</a>`), `${where}: the statement, on the website`);
}

test('every page Toran serves carries the accessibility panel, its stylesheet and script in the head; the files are served', async () => {
  const s = await serve();
  try {
    const slug = (await s.app.db.one<{ slug: string }>('SELECT slug FROM stores WHERE id = $1', [s.seeded.storeId]))!.slug;
    const id = s.seeded.storeId;
    s.login();
    for (const p of ['/', '/leads', `/lead/${id}`, '/review', `/lead/${id}/review`, '/chats', '/followups', '/settings', '/assistant', '/brand', '/no-such-page']) {
      const res = await s.get(p);
      carries(await res.text(), `operator ${p}`);
      assert.match(String(res.headers.get('content-security-policy')), /script-src 'self'(;| )/, `${p}: script from this site only`);
    }
    // The operator's dashboard under accounts' /admin: the files under the prefix too.
    carries(await (await s.get('/admin/toran/leads', { 'x-of-admin-prefix': '/admin/toran' })).text(), '/admin/toran/leads', '/admin/toran');
    // A store owner's pages.
    s.as(s.accounts.session(customer(1)).cookie);
    for (const p of ['/', '/chats', '/knowledge', '/plan', '/settings']) carries(await (await s.get(p)).text(), `customer ${p}`);
    // A workspace that has not paid: the refusal page.
    s.accounts.paid(2, 'unpaid');
    s.as(s.accounts.session(customer(2)).cookie);
    const refused = await s.get('/');
    assert.equal(refused.status, 402);
    carries(await refused.text(), 'the unpaid refusal');
    // The public pages: a pitch page, one not there, the message settings of a link that is not ours, an address that
    // does not parse, a dead Messenger connect link.
    s.login();
    carries(await (await s.get(`/s/${slug}`)).text(), 'the pitch page');
    s.as('');
    carries(await (await s.get('/s/no-such-page')).text(), 'a pitch page that is not there');
    const stop = await s.get('/u/not-a-real-token-at-all');
    carries(await stop.text(), 'the message settings page');
    // Its CSP lets this site's one script in, and still nothing else and no connection anywhere.
    assert.match(String(stop.headers.get('content-security-policy')), /script-src 'self'; connect-src 'none'/);
    const bad = await s.get('/%E0%A4%A');
    assert.equal(bad.status, 400);
    carries(await bad.text(), 'an address that does not parse');

    // The files: the script keeps the website's key and its four switches; the stylesheet has the switches' rules, and
    // each page's own stylesheet its high contrast.
    const js = await s.get('/static/a11y.js');
    assert.equal(js.status, 200);
    assert.match(String(js.headers.get('content-type')), /^text\/javascript/);
    const code = await js.text();
    assert.ok(code.includes("const KEY = 'of-a11y';") && code.includes("['big', 'contrast', 'links', 'still']"), 'the website\'s key and switches');
    const css = await (await s.get('/static/a11y.css')).text();
    for (const rule of ['.a11y-w { position: fixed;', 'html.a-big body { zoom: 1.2; }', 'html.a-links a {', 'html.a-still *,', '.tabbar ~ .a11y-w {', 'body:has(.actionbar) .tabbar ~ .a11y-w {', '.dock.show ~ .a11y-w {']) assert.ok(css.includes(rule), `a11y.css: ${rule}`);
    assert.match(await (await s.get('/static/style.css')).text(), /html\.a-contrast \{ --ink-2: #1d1d1f;[^]*@media \(prefers-color-scheme: dark\) \{\n  html\.a-contrast \{ --ink-2: #f5f5f7;/);
    assert.match(await (await s.get('/static/pitch.css')).text(), /html\.a-contrast \{ --ink-2: #1d1d1f;/);
  } finally {
    await s.close();
  }
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
  throw new Error(`no browser for the accessibility panel's check (install one: npx playwright-core install chromium)\n${errors.join('\n')}`);
}

const overlap = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

test('in a real browser: Tab reaches the button, a switch stays on after a reload, Escape and a click outside close it, no CSP refusal, no sideways scroll with larger text', async () => {
  const s = await serve();
  const browser = await launch();
  try {
    const slug = (await s.app.db.one<{ slug: string }>('SELECT slug FROM stores WHERE id = $1', [s.seeded.storeId]))!.slug;
    const id = s.seeded.storeId;
    const op = s.accounts.session(operator());
    const cu = s.accounts.session(customer(1));
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    // What the page knew when its body began (the switches must be on before anything paints), and every CSP refusal.
    await context.addInitScript(() => {
      const w = window as any;
      w.__csp = [];
      document.addEventListener('securitypolicyviolation', (e) => w.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
      const mo = new MutationObserver(() => {
        if (document.body && w.__atBody === undefined) {
          w.__atBody = document.documentElement.className;
          mo.disconnect();
        }
      });
      mo.observe(document, { childList: true, subtree: true });
    });
    await context.addCookies([{ name: 'of_session', value: op.sid, url: s.base }]);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('console', (m: any) => m.type() === 'error' && /Content Security Policy|Refused/.test(m.text()) && errors.push(m.text()));
    page.on('pageerror', (e: Error) => errors.push(e.message));
    const html = () => page.evaluate(() => document.documentElement.className);

    await page.goto(`${s.base}/`, { waitUntil: 'load' });
    assert.equal(await page.isVisible('.a11y-btn'), true, 'the button shows once its script runs');
    assert.equal(await page.isVisible('.a11y-p'), false, 'the panel starts closed');
    // Tab reaches it: from the tab bar's last tab, the next stop is the button, with a visible focus ring.
    await page.focus('.tabbar a:last-of-type');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.className), 'a11y-btn');
    assert.notEqual(await page.$eval('.a11y-btn', (b: Element) => getComputedStyle(b).outlineStyle), 'none', 'the focus is visible');
    await page.keyboard.press('Enter');
    assert.equal(await page.getAttribute('.a11y-btn', 'aria-expanded'), 'true');
    assert.equal(await page.isVisible('.a11y-p'), true);
    // The next Tab is the first switch; Enter turns it on.
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement)?.dataset.a), 'big');
    await page.keyboard.press('Enter');
    assert.match(await html(), /\ba-big\b/);
    assert.equal(await page.getAttribute('[data-a="big"]', 'aria-pressed'), 'true');
    assert.equal(await page.evaluate(() => localStorage.getItem('of-a11y')), '{"big":true}', 'kept under the website\'s key');
    // The panel and its button stay inside the screen, and the button never on the tab bar.
    const box = (sel: string) => page.$eval(sel, (el: Element) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
    const pb = await box('.a11y-p');
    assert.ok(pb.x >= 0 && pb.x + pb.width <= 390 && pb.y >= 0, `the open panel is on the screen (${JSON.stringify(pb)})`);
    // Escape closes it, and the focus is back on the button.
    await page.keyboard.press('Escape');
    assert.equal(await page.isVisible('.a11y-p'), false);
    assert.equal(await page.getAttribute('.a11y-btn', 'aria-expanded'), 'false');
    assert.equal(await page.evaluate(() => document.activeElement?.className), 'a11y-btn');
    // A click outside closes it too.
    await page.click('.a11y-btn');
    assert.equal(await page.isVisible('.a11y-p'), true);
    await page.click('h1');
    assert.equal(await page.isVisible('.a11y-p'), false, 'a click outside closes it');

    // After a reload: on before the body began, and the switch says so.
    await page.reload({ waitUntil: 'load' });
    assert.match(await page.evaluate(() => (window as any).__atBody), /\ba-big\b/, 'the larger text is on <html> before the body is parsed');
    assert.equal(await page.getAttribute('[data-a="big"]', 'aria-pressed'), 'true');

    // Every page reached, with larger text on: the button shows, sits on neither the tab bar nor the page's own bar
    // (a store's review), and nothing scrolls sideways.
    const pages: [string | null, string][] = [
      [op.sid, '/'], [op.sid, '/leads'], [op.sid, `/lead/${id}`], [op.sid, '/review'], [op.sid, `/lead/${id}/review`], [op.sid, '/chats'], [op.sid, '/followups'], [op.sid, '/settings'], [op.sid, '/assistant'], [op.sid, '/brand'], [op.sid, '/queue'], [op.sid, '/start'], [op.sid, '/no-such-page'],
      [cu.sid, '/'], [cu.sid, '/chats'], [cu.sid, '/knowledge'], [cu.sid, '/plan'], [cu.sid, '/settings'],
      [op.sid, `/s/${slug}`], [null, '/s/no-such-page'], [null, '/u/not-a-real-token-at-all'], [null, '/%E0%A4%A'],
    ];
    for (const [sid, p] of pages) {
      await context.clearCookies();
      if (sid) await context.addCookies([{ name: 'of_session', value: sid, url: s.base }]);
      await page.goto(`${s.base}${p}`, { waitUntil: 'load' });
      assert.match(await html(), /\ba-big\b/, `${p}: larger text on`);
      assert.equal(await page.isVisible('.a11y-btn'), true, `${p}: the button`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0, `${p}: no sideways scroll at 390 with larger text`);
      const btn = await box('.a11y-btn');
      for (const bar of ['.tabbar', '.actionbar']) {
        if (await page.$(bar)) assert.ok(!overlap(btn, await box(bar)), `${p}: the button is off the ${bar}`);
      }
    }
    // A pitch page's docked WhatsApp button, once the hero's has scrolled away: the button rises over it.
    await context.clearCookies();
    await context.addCookies([{ name: 'of_session', value: op.sid, url: s.base }]);
    await page.goto(`${s.base}/s/${slug}`, { waitUntil: 'load' });
    assert.ok(await page.$('.dock'), 'the pitch page has its dock (the demo number is set)');
    // As a reader scrolls: past the hero's own button (it has to have been on the screen for the dock to know it left).
    await page.$eval('.read-cta .wa', (el: Element) => el.scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(300);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForSelector('.dock.show');
    await page.waitForTimeout(400);
    assert.ok(!overlap(await box('.a11y-btn'), await box('.dock .wa')), 'the button is off the docked WhatsApp button');

    // The reset takes every switch off, here and in the browser.
    await page.click('.a11y-btn');
    await page.click('[data-a="links"]');
    assert.match(await html(), /\ba-links\b/);
    await page.click('[data-a11y-reset]');
    assert.doesNotMatch(await html(), /\ba-(big|contrast|links|still)\b/);
    assert.equal(await page.evaluate(() => localStorage.getItem('of-a11y')), '{}');

    // On a desk: the panel opens inside the screen.
    const desk = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await desk.addCookies([{ name: 'of_session', value: op.sid, url: s.base }]);
    const d = await desk.newPage();
    await d.goto(`${s.base}/`, { waitUntil: 'load' });
    await d.click('.a11y-btn');
    const dp = await d.$eval('.a11y-p', (el: Element) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom }; });
    assert.ok(dp.x >= 0 && dp.y >= 0 && dp.right <= 1440 && dp.bottom <= 900, `the panel on a desk is on the screen (${JSON.stringify(dp)})`);
    await desk.close();

    assert.deepEqual(await page.evaluate(() => (window as any).__csp), [], 'no CSP refusal on the last page');
    assert.deepEqual(errors, [], 'no CSP refusal or script error on any page');
    await context.close();
  } finally {
    await browser.close();
    await s.close();
  }
});
