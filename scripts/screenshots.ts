// npm run screenshots [-- --base http://127.0.0.1:4711]
//
// Screenshots of the fictional store only (start `npm run demo` first): the brand page,
// the dashboard's pages and the pitch page, on a phone (390 wide) and a desk (1440), in
// light and dark. Written to docs/screenshots/, the one folder media may be committed in.

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/core/paths.ts';
import { DEMO_USER } from '../src/demoSeed.ts';

const args = process.argv.slice(2);
const base = args.includes('--base') ? args[args.indexOf('--base') + 1] : 'http://127.0.0.1:4711';
const only = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',') : null;
const out = path.join(ROOT, 'docs', 'screenshots');
mkdirSync(out, { recursive: true });

const pw: any = await import('playwright-core');
const { existsSync, readdirSync } = await import('node:fs');
const root = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'ms-playwright') : path.join(process.env.HOME || '', '.cache', 'ms-playwright');
const dir = readdirSync(root).filter((d: string) => /^chromium-\d+$/.test(d)).sort().reverse()[0];
const exe = ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe', 'chrome-linux/chrome', 'chrome-linux64/chrome'].map((r) => path.join(root, dir, r)).find((p) => existsSync(p));
const browser = await pw.chromium.launch({ executablePath: exe, headless: true });

const slug = await (async () => {
  const r = await fetch(`${base}/robots.txt`);
  if (!r.ok) throw new Error(`no demo at ${base}: run npm run demo first`);
  return null;
})();

const shots: { name: string; path: string; full?: boolean }[] = [
  { name: 'brand', path: '/brand' },
  { name: 'today', path: '/' },
  { name: 'leads', path: '/leads?all=1' },
  { name: 'lead', path: '/lead/1' },
  { name: 'review', path: '/review' },
  { name: 'edit', path: '/lead/1/review' },
  { name: 'chat', path: '/chat/1' },
  { name: 'followups', path: '/followups' },
  { name: 'settings', path: '/settings' },
  { name: 'login', path: '/login' },
];

for (const [device, viewport] of [['phone', { width: 390, height: 844 }], ['desk', { width: 1440, height: 900 }]] as const) {
  for (const scheme of ['light', 'dark'] as const) {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, locale: 'he-IL', colorScheme: scheme });
    const page = await ctx.newPage();
    await page.goto(`${base}/login`);
    await page.fill('input[name=user]', DEMO_USER.name);
    await page.fill('input[name=password]', DEMO_USER.password);
    await Promise.all([page.waitForNavigation(), page.click('button[type=submit]')]);
    // The pitch page's slug, from the lead page's link.
    await page.goto(`${base}/lead/1`);
    const href = await page.getAttribute('a[href*="/s/"]', 'href');
    const pitch = href ? new URL(href, base).pathname : null;
    const list = pitch ? [...shots, { name: 'pitch', path: pitch, full: true }] : shots;
    for (const s of list) {
      if (only && !only.includes(s.name)) continue;
      if (s.name === 'login') await ctx.clearCookies();
      await page.goto(`${base}${s.path}`, { waitUntil: 'load' });
      await page.waitForTimeout(300);
      const file = path.join(out, `${s.name}-${device}-${scheme}.png`);
      await page.screenshot({ path: file, fullPage: s.full ?? device === 'desk' });
      console.log(file);
    }
    await ctx.close();
  }
}
await browser.close();
void slug;
