import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installPlatform } from '../src/web/install.ts';
import { customer } from './helpers.ts';
import { serve } from './serve.ts';

// Adding Toran to the phone as an app (src/web/install.ts; the owner, 2026-11-09: "both toran and teder, add a little
// tutorial on how to add the website as an app to the phone"): the manifest Chrome installs from, Today's card on a
// phone until it is closed, never on a desk, and Settings' panel with this browser's steps.

const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
  iphoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.7390.41 Mobile/15E148 Safari/604.1',
  iphoneInstagram: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 400.0.0.0.0',
  android: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
  samsung: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36',
  desk: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
};

/** The steps a page shows: the one [data-for] block without hidden. */
const shown = (html: string) => [...html.matchAll(/<div data-for="([\w-]+)"( hidden)?>/g)].filter((m) => !m[2]).map((m) => m[1]);

test('the browser by its user agent: Safari, Chrome and the rest on an iPhone, Chrome and the rest on Android, a desk', () => {
  assert.equal(installPlatform(UA.iphone), 'ios-safari');
  assert.equal(installPlatform(UA.iphoneChrome), 'ios-chrome');
  assert.equal(installPlatform(UA.iphoneInstagram), 'ios-other');
  assert.equal(installPlatform(UA.android), 'android-chrome');
  assert.equal(installPlatform(UA.samsung), 'android-other');
  assert.equal(installPlatform(UA.desk), 'desktop');
  assert.equal(installPlatform(''), 'desktop');
});

test('the manifest: Hebrew, right to left, standalone from the home page, icons of 192 and 512 and maskable ones, each served', async () => {
  const s = await serve();
  try {
    const r = await s.get('/static/manifest.webmanifest');
    assert.equal(r.status, 200);
    assert.match(String(r.headers.get('content-type')), /application\/manifest\+json/);
    const m = await r.json();
    assert.deepEqual([m.name, m.short_name, m.lang, m.dir, m.start_url, m.display], ['תורן', 'תורן', 'he', 'rtl', '/', 'standalone']);
    assert.equal(m.prefer_related_applications, undefined);
    assert.match(m.theme_color, /^#[0-9a-f]{6}$/i);
    assert.match(m.background_color, /^#[0-9a-f]{6}$/i);
    const has = (size: string, purpose: string) => m.icons.find((i: any) => i.sizes === size && i.type === 'image/png' && String(i.purpose || 'any').split(' ').includes(purpose));
    for (const size of ['192x192', '512x512']) for (const purpose of ['any', 'maskable']) assert.ok(has(size, purpose), `${size} ${purpose}`);
    for (const i of m.icons) {
      const got = await s.get(i.src);
      assert.equal(got.status, 200, i.src);
      assert.equal(got.headers.get('content-type'), i.type, i.src);
      if (i.type !== 'image/png') continue;
      const png = Buffer.from(await got.arrayBuffer());
      assert.equal(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`, i.sizes, `${i.src}: the size it says`);
    }
    s.login();
    const html = await (await s.get('/', { 'user-agent': UA.iphone })).text();
    assert.match(html, /<link rel="manifest" href="\/static\/manifest\.webmanifest">/);
    assert.match(html, /<link rel="apple-touch-icon" href="\/static\/brand\/toran-180\.png">/);
    assert.match(html, /<meta name="apple-mobile-web-app-capable" content="yes">/);
    assert.match(html, /<meta name="apple-mobile-web-app-title" content="תורן">/);
  } finally {
    await s.close();
  }
});

test('Today\'s card: on a phone with that browser\'s steps, never on a desk, gone once closed or opened as the app', async () => {
  const s = await serve();
  try {
    const sess = s.login();
    const today = async (ua: string, extra = '') => (await s.get('/', { 'user-agent': ua, cookie: `${sess.cookie}${extra}` })).text();
    const iphone = await today(UA.iphone);
    assert.match(iphone, /data-install="card"/);
    assert.match(iphone, /להוסיף את תורן למסך הבית/);
    assert.deepEqual(shown(iphone), ['ios-safari']);
    assert.match(iphone, /<b>שיתוף<\/b>[^]*<b>הוספה למסך הבית<\/b>[^]*<b>הוסף<\/b>/);
    assert.match(iphone, /data-install-close aria-label="לסגור"/);
    assert.ok(!/style="/.test(iphone), 'no inline style (the CSP forbids them)');
    assert.deepEqual(shown(await today(UA.iphoneChrome)), ['ios-chrome']);
    assert.deepEqual(shown(await today(UA.iphoneInstagram)), ['ios-other']);
    const android = await today(UA.android);
    assert.deepEqual(shown(android), ['android-chrome']);
    assert.match(android, /data-for="prompt" hidden>[^]*data-install-go[^]*להתקין/, 'the one button waits for Chrome\'s offer');
    assert.ok(!/data-install=/.test(await today(UA.desk)), 'nothing on a desk');
    assert.ok(!/data-install=/.test(await today(UA.iphone, '; tn_install=hide')), 'closed in this browser');
    assert.ok(!/data-install=/.test(await today(UA.android, '; tn_install=app')), 'the app was opened in this browser');
    // The customer's own Today too.
    await s.app.db.query('UPDATE stores SET workspace_id = 31 WHERE id = $1', [s.seeded.storeId]);
    const own = s.accounts.session(customer(31)).cookie;
    assert.match(await (await s.get('/', { 'user-agent': UA.iphone, cookie: own })).text(), /data-install="card"/);
    assert.ok(!/data-install=/.test(await (await s.get('/', { 'user-agent': UA.desk, cookie: own })).text()));
  } finally {
    await s.close();
  }
});

test('Settings: "להוסיף לטלפון" always, the desk\'s hint on a desk, a phone\'s steps on a phone, closed or not', async () => {
  const s = await serve();
  try {
    await s.app.db.query('UPDATE stores SET workspace_id = 32 WHERE id = $1', [s.seeded.storeId]);
    const own = s.accounts.session(customer(32)).cookie;
    const desk = await (await s.get('/settings', { 'user-agent': UA.desk, cookie: own })).text();
    assert.match(desk, /<section class="panel install" id="install" data-install="panel"/);
    assert.match(desk, /להוסיף לטלפון/);
    assert.deepEqual(shown(desk), ['desktop']);
    assert.match(desk, /סמל ההתקנה בשורת הכתובת/);
    assert.match(desk, /<a href="#install">/, 'the iPhone\'s line under notifications points to it');
    const phone = await (await s.get('/settings', { 'user-agent': UA.iphone, cookie: `${own}; tn_install=hide` })).text();
    assert.deepEqual(shown(phone), ['ios-safari'], 'closing Today\'s card does not take it out of Settings');
    s.login();
    assert.match(await (await s.get('/settings', { 'user-agent': UA.desk })).text(), /data-install="panel"/, 'the operator\'s Settings too');
  } finally {
    await s.close();
  }
});

test('the page\'s script keeps the x in a cookie the server reads, and the installed app shows none of it', () => {
  const js = readFileSync(new URL('../src/web/static/app.js', import.meta.url), 'utf8');
  assert.match(js, /tn_install=\$\{v\}; Path=\/; Max-Age=31536000/);
  assert.match(js, /keep\('hide'\)/);
  assert.match(js, /navigator\.standalone === true/);
  assert.match(js, /beforeinstallprompt/);
  const css = readFileSync(new URL('../src/web/static/style.css', import.meta.url), 'utf8');
  assert.match(css, /@media \(display-mode: standalone\)[^{]*\{ \[data-install\] \{ display: none !important; \} \}/);
});
