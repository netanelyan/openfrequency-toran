import * as cheerio from 'cheerio';
import { hebrewRatio } from '../core/hebrew.ts';

// A store's brand, from its own site: the logo, two main colours, and a tone sample
// in its own words. The pitch page dresses in it; the agent writes in the tone.
//
// Colours, in order of trust:
//   1. <meta name="theme-color">
//   2. Shopify themes' colour settings (--color-button, --color-accent, --color-base-
//      accent-1 in the inline :root CSS, "colors_accent_1" in the settings JSON)
//   3. the most used saturated colour in the page's inline CSS
// Near-white, near-black and greys are not a brand colour: they are skipped.
//
// The tone sample is the store's own copy, never ours: the home page's description
// and the longest Hebrew paragraphs from the page (the "about" voice), cut to a few
// sentences. It shows the agent how this store talks to its customers.

export type Brand = { name?: string | null; logo?: string | null; colors?: string[]; tone?: string | null; description?: string | null; themeColor?: string | null };

const HEX = /#([0-9a-f]{6}|[0-9a-f]{3})\b/gi;

export function normHex(h: string): string | null {
  let s = String(h || '').trim().toLowerCase();
  const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(s);
  if (rgb) s = `#${[rgb[1], rgb[2], rgb[3]].map((x) => Math.min(255, Number(x)).toString(16).padStart(2, '0')).join('')}`;
  const triple = /^(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})$/.exec(s); // Shopify's "--color-button: 18,18,18"
  if (triple) s = `#${[triple[1], triple[2], triple[3]].map((x) => Math.min(255, Number(x)).toString(16).padStart(2, '0')).join('')}`;
  if (/^#[0-9a-f]{3}$/.test(s)) s = `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  return /^#[0-9a-f]{6}$/.test(s) ? s : null;
}

/** Hue-saturation-lightness of a hex colour (s and l 0..1). */
export function hsl(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s, l };
}

/** A colour that can carry a brand: not white, not black, not grey. */
export const isBrandish = (hex: string) => {
  const { s, l } = hsl(hex);
  return s >= 0.18 && l >= 0.12 && l <= 0.85;
};

/** Relative luminance (WCAG), for picking white or dark text on a colour. */
export function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
export const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
/** White text on the colour if it reads (4.5:1), else near-black. */
export const inkOn = (hex: string) => (contrast(hex, '#ffffff') >= 4.5 ? '#ffffff' : '#1d1d1f');

/** The store's own colour, or null when the site gave none (the pitch page then waits for the owner to pick one). */
export function brandColor(b: Brand | null | undefined): string | null {
  return (b?.colors || []).map(normHex).find((x) => x && isBrandish(x)) || null;
}

/** The colour a store is shown in on the dashboard: its first brand colour, else a neutral graphite. */
export function storeColor(b: Brand | null | undefined): string {
  return brandColor(b) || '#4a4a52';
}

/**
 * The store's name as a person says it: a site title's tail after " | " or " – " is the tagline, not the name
 * ("כלי חרס של נורית | קרמיקה בעבודת יד"). Null when there is no name at all, never the domain as a guess.
 */
export function displayName(...names: (string | null | undefined)[]): string | null {
  for (const n of names) {
    const s = String(n || '').split(/\s[|–—·]\s|\s-\s/)[0].replace(/\s+/g, ' ').trim();
    if (s.length >= 2) return s.length > 60 ? `${s.slice(0, 57).trim()}...` : s;
  }
  return null;
}

/** A colour darkened until white text on it passes 4.5:1, for buttons and bubbles. */
export function readableShade(hex: string): string {
  let c = normHex(hex) || '#4a4a52';
  for (let i = 0; i < 12 && contrast(c, '#ffffff') < 4.5; i++) {
    const n = parseInt(c.slice(1), 16);
    const k = 0.88;
    c = `#${[(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(v * k).toString(16).padStart(2, '0')).join('')}`;
  }
  return c;
}

export function readBrand(html: string, pageUrl: string, { name, logo }: { name?: string | null; logo?: string | null } = {}): Brand {
  const $ = cheerio.load(html);
  const css = $('style').map((_, el) => $(el).text()).get().join('\n') + '\n' + $('[style]').map((_, el) => $(el).attr('style')).get().join(';');
  const counts = new Map<string, number>();
  const bump = (h: string | null, w = 1) => {
    if (h && isBrandish(h)) counts.set(h, (counts.get(h) || 0) + w);
  };
  const theme = normHex($('meta[name="theme-color"]').attr('content') || '');
  if (theme) bump(theme, 50);
  for (const m of css.matchAll(/--color-(?:button|accent|base-accent-1|base-accent-2|primary|brand|sale-badge|link)[\w-]*\s*:\s*([^;}\n]+)/gi)) bump(normHex(m[1]), 20);
  for (const m of html.matchAll(/"colors?_(?:accent|button|primary)[\w]*"\s*:\s*"(#[0-9a-fA-F]{3,6})"/g)) bump(normHex(m[1]), 15);
  for (const m of css.matchAll(HEX)) bump(normHex(m[0]), 1);
  for (const m of css.matchAll(/rgba?\([^)]*\)/gi)) bump(normHex(m[0]), 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([h]) => h);
  // Two colours that are not near-duplicates of each other.
  const colors: string[] = [];
  for (const h of ranked) {
    if (colors.length >= 2) break;
    if (colors.every((c) => Math.abs(hsl(c).h - hsl(h).h) > 18 || Math.abs(hsl(c).l - hsl(h).l) > 0.2)) colors.push(h);
  }

  // The store's own words.
  $('script, style, noscript, nav, header, footer, form, select, button').remove();
  const paras = $('p, .rte, [class*="about"], [class*="description"]')
    .map((_, el) => $(el).text().replace(/\s+/g, ' ').trim())
    .get()
    .filter((t) => t.length >= 60 && t.length <= 900 && hebrewRatio(t) >= 0.5 && !/cookie|עוגיות|©|כל הזכויות/i.test(t));
  const unique = [...new Set(paras)].sort((a, b) => b.length - a.length).slice(0, 2);
  const description = $('meta[name="description"]').attr('content')?.trim() || null;
  const tone = [description && hebrewRatio(description) > 0.4 ? description : null, ...unique].filter(Boolean).join('\n').slice(0, 700) || null;

  let lg = logo || null;
  if (!lg) {
    const img = $('img').filter((_, el) => /logo/i.test(`${$(el).attr('class') || ''} ${$(el).attr('alt') || ''} ${$(el).attr('src') || ''}`)).first();
    const src = img.attr('src') || img.attr('data-src');
    if (src) lg = new URL(src.startsWith('//') ? `https:${src}` : src, pageUrl).toString();
  }
  return { name: name || null, logo: lg, colors, tone, description, themeColor: theme };
}
