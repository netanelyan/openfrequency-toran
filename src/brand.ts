import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './core/paths.ts';

// The OpenFrequency family's marks and tokens, in one place. Every page that shows a
// mark asks for it here; no page hand-copies SVG.
//
// The marks are the files in assets/brand/ (from openfrequency-brand.zip), used as
// they are: a rounded-square tile (rx 24 on a 100 viewBox) in the product's colour,
// the glyph in white. Never stretched, recoloured or redrawn: a mark is always square
// (one size for width and height) and its colours are these constants, which are the
// files' own.
//
//   Toran (תורן)     #0F7A54  three "typing..." dots   app icon, favicon, header, pitch pages, login
//   OpenFrequency    #2747D6  halftone dots            footer and "built by" only; the -small
//                                                       halftone at 48px and below
//   Teder (תדר)      #6A3FD6  one wave                 not used in Toran (shown on /brand)
//
// Colour rules for Toran's screens: the UI accent is Apple blue #0071E3 for buttons
// and links. Green #0F7A54 is the Toran mark, and the WhatsApp demo button on pitch
// pages, nowhere else. A pitch page takes the store's own colour for its chat bubbles
// and the store's initial.

export const BRAND_DIR = path.join(ROOT, 'assets', 'brand');

export const COLORS = {
  toran: '#0F7A54',
  openfrequency: '#2747D6',
  teder: '#6A3FD6',
  accent: '#0071E3', // the UI's buttons and links
  accentHover: '#0077ED',
  accentText: '#0066CC', // blue as text on a light tile (contrast 5.0:1)
  accentTextDark: '#2997FF',
  whatsapp: '#0F7A54', // the demo button is Toran green, by rule
} as const;

export const TOKENS = {
  fontText: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'SF Hebrew', system-ui, 'Segoe UI', 'Noto Sans Hebrew', 'Helvetica Neue', Arial, sans-serif",
  fontDisplay: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Hebrew', system-ui, 'Segoe UI', 'Noto Sans Hebrew', 'Helvetica Neue', Arial, sans-serif",
  radius: '18px', // a tile
  radiusM: '12px', // a field, an inset pane
  radiusS: '10px',
  radiusMark: '24%', // the mark's own corner (rx 24 of 100), for a CSS-drawn tile
  radiusPill: '980px',
} as const;

const read = (rel: string) => readFileSync(path.join(BRAND_DIR, rel), 'utf8');
/** The children of a glyph file's root <svg>: the mark's shapes, in currentColor. */
const inner = (svg: string) => svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');

const GLYPHS = {
  toran: inner(read('svg/toran-glyph.svg')),
  openfrequency: inner(read('svg/openfrequency-glyph.svg')),
  openfrequencySmall: inner(read('svg/openfrequency-glyph-small.svg')),
  teder: inner(read('svg/teder-glyph.svg')),
};

const LABEL = { toran: 'תורן', openfrequency: 'OpenFrequency', teder: 'תדר' } as const;

type MarkOpts = { label?: string | null; cls?: string };

/**
 * A mark as inline SVG: the tile in its colour, the glyph in white. `size` is CSS
 * pixels, the same for width and height (a mark is never stretched). The glyph's
 * currentColor is set by a presentation attribute, not a style, so the strict CSP
 * (no inline styles) has nothing to block.
 */
function mark(name: keyof typeof LABEL, glyph: string, size: number, { label = LABEL[name], cls = 'mk' }: MarkOpts = {}): string {
  const s = Math.max(8, Math.round(size));
  const a11y = label ? `role="img" aria-label="${label}"` : 'aria-hidden="true"';
  return `<svg class="${cls}" ${a11y} width="${s}" height="${s}" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100" rx="24" fill="${COLORS[name]}"/><g color="#fff">${glyph}</g></svg>`;
}

export const toranMark = (size: number, opts?: MarkOpts) => mark('toran', GLYPHS.toran, size, opts);
/** At 48px and below the simpler 5x5 halftone: the full one's smallest dots vanish. */
export const ofMark = (size: number, opts?: MarkOpts) => mark('openfrequency', size <= 48 ? GLYPHS.openfrequencySmall : GLYPHS.openfrequency, size, opts);
/** Teder's mark: for the family on /brand only. */
export const tederMark = (size: number, opts?: MarkOpts) => mark('teder', GLYPHS.teder, size, opts);

/** The tokens as CSS custom properties: /static/brand.css, loaded by the dashboard and every pitch page. */
export function brandCss(): string {
  return `/* Generated from src/brand.ts: the family's colours, radii and fonts. Edit them there. */
:root {
  --brand-toran: ${COLORS.toran};
  --brand-of: ${COLORS.openfrequency};
  --brand-teder: ${COLORS.teder};
  --brand-whatsapp: ${COLORS.whatsapp};
  --accent-fill: ${COLORS.accent};
  --accent-fill-2: ${COLORS.accentHover};
  --accent: ${COLORS.accentText};
  --text: ${TOKENS.fontText};
  --display: ${TOKENS.fontDisplay};
  --r: ${TOKENS.radius};
  --r-m: ${TOKENS.radiusM};
  --r-s: ${TOKENS.radiusS};
  --r-pill: ${TOKENS.radiusPill};
  --r-mark: ${TOKENS.radiusMark};
}
@media (prefers-color-scheme: dark) { :root { --accent: ${COLORS.accentTextDark}; } }
svg.mk { display: block; flex: none; }
`;
}

/** The files the server hands out as they are: favicon, apple-touch and manifest icons. */
export const ICON_FILES: Record<string, { file: string; type: string }> = {
  '/static/brand/toran.svg': { file: 'svg/toran.svg', type: 'image/svg+xml' },
  '/static/brand/toran-180.png': { file: 'png/toran-180.png', type: 'image/png' },
  '/static/brand/toran-512.png': { file: 'png/toran-512.png', type: 'image/png' },
  '/static/brand/openfrequency.svg': { file: 'svg/openfrequency.svg', type: 'image/svg+xml' },
  '/static/brand/openfrequency-small.svg': { file: 'svg/openfrequency-small.svg', type: 'image/svg+xml' },
  '/static/brand/teder.svg': { file: 'svg/teder.svg', type: 'image/svg+xml' },
};

export const MANIFEST = {
  name: 'תורן',
  short_name: 'תורן',
  description: 'לידים, דפי הצגה ושיחות דמו של תורן.',
  lang: 'he',
  dir: 'rtl',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: '#eeeff2',
  theme_color: '#eeeff2',
  icons: [
    { src: '/static/brand/toran-180.png', sizes: '180x180', type: 'image/png' },
    { src: '/static/brand/toran-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/static/brand/toran.svg', sizes: 'any', type: 'image/svg+xml' },
  ],
};

/** The <head> lines for the icons, shared by the dashboard and the pitch pages. */
export const iconLinks = () =>
  `<link rel="icon" href="/static/brand/toran.svg" type="image/svg+xml">\n<link rel="apple-touch-icon" href="/static/brand/toran-180.png">`;
