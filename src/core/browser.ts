import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// The headless fallback, for the stores whose home page is an empty shell that
// JavaScript fills in (Wix, some custom builds). Optional: playwright-core is a dev
// dependency and the browser is whatever Playwright already installed on the
// machine; without them, detection simply works from the raw HTML.
//
// It renders one page at a time, blocks images, media and fonts, and waits for the
// DOM, not for the network to idle (a chat widget can keep a socket open forever).

let browserP: Promise<any> | null = null;
let idle: NodeJS.Timeout | null = null;

function chromiumPath(): string | undefined {
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'ms-playwright'), path.join(os.homedir(), '.cache', 'ms-playwright')].filter(Boolean) as string[];
  for (const r of roots) {
    if (!existsSync(r)) continue;
    const dirs = readdirSync(r).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse();
    for (const d of dirs) {
      for (const rel of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe', 'chrome-linux/chrome', 'chrome-linux64/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
        const p = path.join(r, d, rel);
        if (existsSync(p)) return p;
      }
    }
  }
  return undefined;
}

export async function renderHtml(url: string, { timeoutMs = 25_000, userAgent }: { timeoutMs?: number; userAgent?: string } = {}): Promise<string | null> {
  let pw: any;
  try {
    pw = await import('playwright-core');
  } catch {
    return null;
  }
  const exe = chromiumPath();
  if (!exe) return null;
  browserP ??= pw.chromium.launch({ executablePath: exe, headless: true });
  const browser = await browserP;
  if (idle) clearTimeout(idle);
  const ctx = await browser.newContext({ userAgent, locale: 'he-IL' });
  try {
    const page = await ctx.newPage();
    await page.route('**/*', (route: any) => (['image', 'media', 'font'].includes(route.request().resourceType()) ? route.abort() : route.continue()));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.waitForTimeout(1500);
    return await page.content();
  } catch {
    return null;
  } finally {
    await ctx.close().catch(() => {});
    idle = setTimeout(() => closeBrowser(), 60_000);
    idle.unref?.();
  }
}

export async function closeBrowser() {
  if (!browserP) return;
  const b = await browserP.catch(() => null);
  browserP = null;
  await b?.close().catch(() => {});
}

/** A screenshot of a page (the pitch page screenshots in docs/). */
export async function screenshot(url: string, file: string, { width = 390, height = 844, fullPage = true, dark = false } = {}): Promise<boolean> {
  let pw: any;
  try {
    pw = await import('playwright-core');
  } catch {
    return false;
  }
  const exe = chromiumPath();
  if (!exe) return false;
  const browser = await pw.chromium.launch({ executablePath: exe, headless: true });
  try {
    const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, locale: 'he-IL', colorScheme: dark ? 'dark' : 'light' });
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
    await page.screenshot({ path: file, fullPage });
    return true;
  } finally {
    await browser.close();
  }
}
