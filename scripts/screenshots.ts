// npm run screenshots [-- --base http://localhost:4711]
//
// Screenshots of the fictional store only (start `npm run demo` first): the brand page,
// the dashboard's pages and the pitch page, on a phone (390 wide) and a desk (1440), in
// light and dark. Written to docs/screenshots/, the one folder media may be committed in.

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/core/paths.ts';

const args = process.argv.slice(2);
// localhost, not 127.0.0.1: the demo's sign-in cookie belongs to that name (scripts/demo-accounts.ts).
const base = args.includes('--base') ? args[args.indexOf('--base') + 1] : 'http://localhost:4711';
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
  { name: 'followups', path: '/followups' },
  { name: 'settings', path: '/settings' },
];

for (const [device, viewport] of [['phone', { width: 390, height: 844 }], ['desk', { width: 1440, height: 900 }]] as const) {
  for (const scheme of ['light', 'dark'] as const) {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, locale: 'he-IL', colorScheme: scheme });
    const page = await ctx.newPage();
    // The first visit goes through the demo's stand-in for accounts, which signs the browser in and comes back.
    await page.goto(`${base}/`);
    // The pitch page's slug, from the lead page's link.
    await page.goto(`${base}/lead/1`);
    const href = await page.getAttribute('a[href*="/s/"]', 'href');
    const pitch = href ? new URL(href, base).pathname : null;
    // The first WhatsApp demo conversation, from the chats list.
    await page.goto(`${base}/chats`);
    const chatHref = await page.getAttribute('.list a[href^="/chat/"]', 'href').catch(() => null);
    const list: { name: string; path: string; full?: boolean }[] = [...shots, ...(chatHref ? [{ name: 'chat', path: chatHref }] : []), ...(pitch ? [{ name: 'pitch', path: pitch, full: true }] : [])];
    for (const s of list) {
      if (only && !only.includes(s.name)) continue;
      await page.goto(`${base}${s.path}`, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('load', { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(600);
      const file = path.join(out, `${s.name}-${device}-${scheme}.png`);
      await page.screenshot({ path: file, fullPage: s.full ?? false });
      console.log(file);
    }
    await ctx.close();
  }
}
await browser.close();
void slug;
