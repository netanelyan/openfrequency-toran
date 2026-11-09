import * as cheerio from 'cheerio';
import { contrast, hsl, isBrandish, luminance, normHex } from './brand.ts';

// The chat on a store's site dressed in that site's own look (the owner, 2026-11-09: "design the website widget better.
// make it according to the website's colors"). Two halves:
//
//   readPalette   at the site read (ingest/pack.ts), the colours, corner and type the store's site already uses, kept
//                 as they were found in stores.brand.palette (replaced at every re-read, as the rest of the brand is)
//   lookOf        when the chat is drawn (web/widget.ts): those, the owner's own choice over them (the chat's
//                 settings, channel_accounts.meta.look), and the rules every colour pair passes before a customer
//                 sees it (WCAG AA: 4.5:1 for text), as the tokens the chat's CSS reads (lookCss)
//
// Where each colour is read from, in order of trust (the first source that names one wins, field by field):
//   1. <meta name="theme-color">, for the main colour only and only when it is a colour (a white or black one is the
//      browser's toolbar, usually the header's background, not a button)
//   2. Shopify theme settings in the page's :root CSS: Dawn and its family's colour schemes (--color-button,
//      --color-button-text, --color-background, --color-foreground) and the older settings (--color-base-accent-1,
//      --color-base-solid-button-labels, --color-base-background-1, --color-base-text), --buttons-radius and
//      --font-body-family
//   3. WordPress and WooCommerce themes' variables: the block themes' presets (--wp--preset--color--primary, accent,
//      base, contrast...), Elementor's global colours (--e-global-color-primary...; its untouched defaults are skipped,
//      they are Elementor's colours, not the store's) and Astra's (--ast-global-color-0)
//   4. the CSS of the buttons that matter (add to cart, the primary button, a theme's .button) and the header: what
//      their rules declare. Declared, not computed: there is no browser at the site read, so a colour a script sets is
//      not seen
//   5. the brand's own colours (ingest/brand.ts: the most used saturated colour, or the logo's dominant one when the
//      site names none, logo.ts), given to lookOf, not read here
//
// The type: the site's body font when the chat may use it. The chat is a frame of ours, so it can never use a font the
// store's page loaded (a frame does not share the page's fonts), and it never loads one from anyone else. What stays:
// the system's own fonts, web-safe ones every device has, and Heebo, which we serve ourselves (static/fonts). Any other
// font the page loads (Assistant, Rubik from Google Fonts) is named first in the chat's stack all the same: a device
// that has it installed shows it, and every other one falls back to the system's, with nothing fetched.

export type Palette = {
  primary: string | null; // buttons, the launcher, the customer's bubbles
  onPrimary: string | null; // text on the primary colour
  background: string | null;
  text: string | null;
  accent: string | null;
  radius: number | null; // the buttons' corner, px (999 for a pill)
  font: string | null;
  icon: string | null; // a square icon of the site (apple-touch-icon, the favicon), for the chat's header
  from: string | null; // where the primary colour came from
};

/** A colour value as one #rrggbb: hex, rgb(), hsl(), Shopify's "18,18,18", white and black; null for anything else or see-through. */
export function colorOf(raw: string | null | undefined): string | null {
  const s = String(raw || '').trim().toLowerCase();
  if (!s || /^(transparent|none|inherit|initial|unset|currentcolor)$/.test(s)) return null;
  if (s === 'white') return '#ffffff';
  if (s === 'black') return '#000000';
  const hex8 = /#([0-9a-f]{6})([0-9a-f]{2})\b/.exec(s);
  if (hex8) return parseInt(hex8[2], 16) < 128 ? null : `#${hex8[1]}`;
  const hex4 = /#([0-9a-f]{3})([0-9a-f])\b/.exec(s);
  if (hex4 && !/#[0-9a-f]{6}/.test(s)) return parseInt(hex4[2] + hex4[2], 16) < 128 ? null : normHex(`#${hex4[1]}`);
  const hex = /#([0-9a-f]{6}|[0-9a-f]{3})\b/.exec(s);
  if (hex) return normHex(hex[0]);
  const rgb = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?/.exec(s);
  if (rgb) {
    if (rgb[4] !== undefined && alpha(rgb[4]) < 0.5) return null;
    return normHex(`#${[rgb[1], rgb[2], rgb[3]].map((x) => Math.min(255, Math.round(Number(x))).toString(16).padStart(2, '0')).join('')}`);
  }
  const h = /hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%(?:\s*[,/]\s*([\d.]+%?))?/.exec(s);
  if (h) {
    if (h[4] !== undefined && alpha(h[4]) < 0.5) return null;
    return fromHsl(Number(h[1]), Number(h[2]) / 100, Number(h[3]) / 100);
  }
  const triple = /^(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})$/.exec(s);
  if (triple) return normHex(s);
  return null;
}

const alpha = (a: string) => (a.endsWith('%') ? Number(a.slice(0, -1)) / 100 : Number(a));

/** A colour from hue (degrees), saturation and lightness (0..1). */
export function fromHsl(h: number, s: number, l: number): string {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return `#${[f(0), f(8), f(4)].map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('')}`;
}

/** The same colour at another lightness (0..1): its hue and saturation kept, so a brand stays itself. */
export function withLightness(hex: string, l: number): string {
  const c = hsl(hex);
  return fromHsl(c.h, c.s, Math.max(0, Math.min(1, l)));
}

/** Two colours mixed, `t` of the second (0..1). */
export function mix(a: string, b: string, t: number): string {
  const p = parseInt(a.slice(1), 16);
  const q = parseInt(b.slice(1), 16);
  const ch = (n: number, sh: number) => (n >> sh) & 255;
  return `#${[16, 8, 0].map((sh) => Math.round(ch(p, sh) * (1 - t) + ch(q, sh) * t).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * `fg` moved in lightness, away from `bg`, until the pair reads at `min`:1 (WCAG). Its hue stays; when no lightness of
 * it gets there (a mid grey on a mid grey), the nearest of near-black and white that does.
 */
export function readableOn(fg: string, bg: string, min = 4.5): string {
  if (contrast(fg, bg) >= min) return fg;
  const darker = luminance(bg) > 0.18;
  const { l } = hsl(fg);
  for (let i = 1; i <= 40; i++) {
    const c = withLightness(fg, darker ? l - (l * i) / 40 : l + ((1 - l) * i) / 40);
    if (contrast(c, bg) >= min) return c;
  }
  // One of black and white always reads at 4.58:1 or more.
  return contrast('#000000', bg) >= contrast('#ffffff', bg) ? '#000000' : '#ffffff';
}

// ---------------------------------------------------------------- reading the site

type Rule = { sel: string; decl: Map<string, string> };

/** A style sheet's rules, flat: each selector and its declarations (an @media's inner rules are found as any other). */
function rulesOf(css: string): Rule[] {
  const out: Rule[] = [];
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of clean.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const sel = m[1].trim();
    if (!sel || sel.startsWith('@')) continue;
    const decl = new Map<string, string>();
    for (const d of m[2].split(';')) {
      const i = d.indexOf(':');
      if (i < 0) continue;
      const k = d.slice(0, i).trim().toLowerCase();
      const v = d.slice(i + 1).replace(/!important/i, '').trim();
      if (k && v && !decl.has(k)) decl.set(k, v);
    }
    if (decl.size) out.push({ sel, decl });
  }
  return out;
}

// The rules a theme sets its site-wide variables in: the root, the body, Dawn's first colour scheme, Elementor's kit.
const ROOTISH = /(^|,)\s*(:root|html|body|\.color-scheme-1|\.color-background-1|\.elementor-kit-\d+)\s*(?=,|$)/i;
// The buttons that say what the site's main button looks like, most telling first.
const BUTTON_SELS = [
  /add[-_]?to[-_]?cart|single_add_to_cart_button|product-form__submit|product-form__cart-submit|btn--add-to-cart|shopify-payment-button__button--unbranded/i,
  /btn[-_]primary|button[-_]{1,2}primary|\bprimary[-_]button|wp-block-button__link|wp-element-button/i,
  /(^|[\s,])(\.button|\.btn|button\[type=["']?submit["']?\]|input\[type=["']?submit["']?\])(?=[\s,{]|$)/i,
];
const NOT_MAIN = /:hover|:focus|:active|:disabled|\[disabled\]|secondary|tertiary|outline|--link|ghost|::?before|::?after|\.is-style-outline/i;
const HEADER_SEL = /(^|,)\s*(header|\.site-header|\.header|#header|\.main-header|\.header-wrapper|#masthead|\.elementor-location-header|\.header__wrapper)\s*(?=,|$)/i;
// Elementor's own colours on a kit nobody changed: not the store's.
const ELEMENTOR_DEFAULTS = new Set(['#6ec1e4', '#54595f', '#7a7a7a', '#61ce70']);

const WEB_SAFE = new Set(['arial', 'helvetica', 'helvetica neue', 'tahoma', 'verdana', 'georgia', 'times new roman', 'trebuchet ms', 'segoe ui', 'courier new', 'heebo']);
const GENERIC = /^(sans-serif|serif|monospace|cursive|fantasy|system-ui|ui-sans-serif|ui-serif|-apple-system|blinkmacsystemfont|inherit|initial|unset|var\(.*)$/i;

/** A font name the chat may put in its stack, or null. */
function fontName(raw: string | null | undefined): string | null {
  const first = String(raw || '').split(',')[0].trim().replace(/^["']|["']$/g, '').trim();
  if (!first || GENERIC.test(first) || !/^[\p{L}\p{N} ._-]{2,40}$/u.test(first)) return null;
  return first;
}

/** A border-radius as px: 999 for a pill; null when it is not a length. */
function radiusOf(raw: string | null | undefined): number | null {
  const m = /^\s*(-?[\d.]+)(px|rem|em|%)?/.exec(String(raw || ''));
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) return null;
  const px = m[2] === 'rem' || m[2] === 'em' ? n * 16 : m[2] === '%' ? (n >= 50 ? 999 : n) : n;
  return px >= 40 ? 999 : Math.round(px);
}

/**
 * The look of a store's site, from its home page and the style sheets it links (ingest fetches up to three, cssLinks).
 * Every field is null when the site does not say it.
 */
export function readPalette(html: string, pageUrl: string, extraCss: string[] = []): Palette {
  const $ = cheerio.load(html);
  const inline = $('style').map((_, el) => $(el).text()).get().join('\n');
  const rules = rulesOf([...extraCss, inline].join('\n').slice(0, 3_000_000));
  const vars = new Map<string, string>();
  for (const r of rules) if (ROOTISH.test(r.sel)) for (const [k, v] of r.decl) if (k.startsWith('--') && !vars.has(k)) vars.set(k, v);
  // var(--x) inside a value, resolved through the root's variables (two levels: a preset naming another).
  const resolve = (v: string | null | undefined, depth = 0): string | null => {
    if (v == null) return null;
    if (depth > 3) return v;
    return v.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*(?:\([^()]*\))?[^()]*))?\)/g, (_, name, fb) => resolve(vars.get(name.toLowerCase()) ?? fb ?? '', depth + 1) || '');
  };
  const v = (...names: string[]) => {
    for (const n of names) {
      const c = colorOf(resolve(vars.get(n)));
      if (c) return c;
    }
    return null;
  };
  const vRaw = (...names: string[]) => {
    for (const n of names) if (vars.has(n)) return resolve(vars.get(n));
    return null;
  };

  const out: Palette = { primary: null, onPrimary: null, background: null, text: null, accent: null, radius: null, font: null, icon: null, from: null };
  const take = (p: Partial<Palette>, from: string) => {
    if (!out.primary && p.primary) {
      out.primary = p.primary;
      out.from = from;
      if (p.onPrimary) out.onPrimary = p.onPrimary;
    }
    for (const k of ['background', 'text', 'accent'] as const) if (!out[k] && p[k]) out[k] = p[k]!;
    if (out.radius == null && p.radius != null) out.radius = p.radius;
    if (!out.font && p.font) out.font = p.font;
  };

  // 1. theme-color, a colour only
  const theme = colorOf($('meta[name="theme-color"]').first().attr('content'));
  if (theme && isBrandish(theme)) take({ primary: theme }, 'theme-color');

  // 2. Shopify
  const shopify = [...vars.keys()].some((k) => /^--color-(button|base-|foreground|background)/.test(k));
  if (shopify) {
    take({
      primary: v('--color-button', '--color-base-accent-1', '--color-accent', '--color-primary', '--color-brand'),
      onPrimary: v('--color-button-text', '--color-base-solid-button-labels'),
      background: v('--color-background', '--color-base-background-1'),
      text: v('--color-foreground', '--color-base-text'),
      accent: v('--color-base-accent-2', '--color-link', '--color-accent-2'),
      radius: radiusOf(vRaw('--buttons-radius', '--buttons-radius-outset', '--button-border-radius')),
      font: fontName(vRaw('--font-body-family', '--font-body')),
    }, 'shopify');
  }

  // 3. WordPress block themes, Elementor, Astra
  const wp = (name: string) => v(`--wp--preset--color--${name}`);
  if ([...vars.keys()].some((k) => k.startsWith('--wp--preset--color--'))) {
    take({
      primary: wp('primary') || wp('accent') || wp('accent-1') || wp('vivid-primary'),
      background: wp('base') || wp('background'),
      text: wp('contrast') || wp('foreground') || wp('text') || wp('main'),
      accent: wp('secondary') || wp('accent-2'),
      font: fontName(vRaw('--wp--preset--font-family--body', '--wp--preset--font-family--primary', '--wp--preset--font-family--base', '--wp--preset--font-family--text')),
    }, 'wordpress');
  }
  const el = (name: string) => {
    const c = v(`--e-global-color-${name}`);
    return c && !ELEMENTOR_DEFAULTS.has(c) ? c : null;
  };
  if ([...vars.keys()].some((k) => k.startsWith('--e-global-'))) {
    take({ primary: el('primary') || el('accent'), text: el('text'), accent: el('accent') || el('secondary'), font: fontName(vRaw('--e-global-typography-text-font-family', '--e-global-typography-primary-font-family')) }, 'elementor');
  }
  if (vars.has('--ast-global-color-0')) take({ primary: v('--ast-global-color-0') }, 'astra');

  // 4. the buttons' and the header's own rules, and a button's style attribute
  const bg = (d: Map<string, string>) => colorOf(resolve(d.get('background-color'))) || colorOf(resolve(d.get('background')));
  const notWhite = (c: string | null) => (c && hsl(c).l < 0.94 ? c : null);
  for (const sel of BUTTON_SELS) {
    const hit = rules.find((r) => sel.test(r.sel) && !NOT_MAIN.test(r.sel) && notWhite(bg(r.decl)));
    if (hit) {
      take({ primary: notWhite(bg(hit.decl)), onPrimary: colorOf(resolve(hit.decl.get('color'))), radius: radiusOf(resolve(hit.decl.get('border-radius'))) }, 'button');
      if (out.radius == null) out.radius = radiusOf(resolve(hit.decl.get('border-radius')));
    }
  }
  if (!out.primary) {
    const btn = $('button[style], a.button[style], a.btn[style], .add-to-cart[style], [class*="add_to_cart"][style]').filter((_, e) => Boolean(notWhite(colorOf(/background(?:-color)?\s*:\s*([^;]+)/i.exec($(e).attr('style') || '')?.[1])))).first();
    if (btn.length) take({ primary: notWhite(colorOf(/background(?:-color)?\s*:\s*([^;]+)/i.exec(btn.attr('style') || '')?.[1])) }, 'button');
  }
  const header = rules.find((r) => HEADER_SEL.test(r.sel) && !NOT_MAIN.test(r.sel) && bg(r.decl));
  const headerBg = header ? bg(header.decl) : null;
  if (headerBg && (isBrandish(headerBg) || hsl(headerBg).l < 0.2)) take({ primary: headerBg }, 'header');

  // The page's own background, text and type, from the body's rule
  const body = rules.find((r) => /(^|,)\s*(body|html)\s*(?=,|$)/i.test(r.sel) && (r.decl.has('background-color') || r.decl.has('background') || r.decl.has('color') || r.decl.has('font-family')));
  if (body) take({ background: bg(body.decl), text: colorOf(resolve(body.decl.get('color'))), font: fontName(resolve(body.decl.get('font-family'))) }, 'body');
  if (!out.background && /\bdark\b/.test(String($('meta[name="color-scheme"]').attr('content') || '')) && !/\blight\b/.test(String($('meta[name="color-scheme"]').attr('content') || ''))) out.background = '#121212';

  // The font only when the chat may name it: web-safe, ours, or one the page itself loads (see the top of the file).
  if (out.font && !WEB_SAFE.has(out.font.toLowerCase())) {
    const loaded = [...extraCss, inline].some((c) => new RegExp(`@font-face\\s*\\{[^}]*font-family\\s*:\\s*["']?${escRe(out.font!)}["']?`, 'i').test(c))
      || $('link[href*="fonts.googleapis.com"], link[href*="fonts.bunny.net"]').toArray().some((l) => decodeURIComponent(($(l).attr('href') || '').replace(/\+/g, ' ')).toLowerCase().includes(`family=${out.font!.toLowerCase()}`));
    if (!loaded) out.font = null;
  }

  // A square icon: the apple-touch-icon is drawn for a tile; else a favicon that is not a .ico.
  const abs = (src: string) => {
    try {
      return new URL(src.startsWith('//') ? `https:${src}` : src, pageUrl).toString();
    } catch {
      return null;
    }
  };
  const touch = $('link[rel~="apple-touch-icon"], link[rel="apple-touch-icon-precomposed"]').first().attr('href');
  const fav = $('link[rel~="icon"]').toArray().map((l) => $(l).attr('href') || '').find((h) => h && !/\.ico(\?|$)/i.test(h));
  const icon = touch ? abs(touch) : fav ? abs(fav) : null;
  out.icon = icon && /^https:\/\//.test(icon) && icon.length <= 500 ? icon : null;
  return out;
}

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The style sheets a home page links that may hold its theme's colours: the theme's own, at most three, same site or its CDN. */
export function cssLinks(html: string, pageUrl: string): string[] {
  const $ = cheerio.load(html);
  let host = '';
  try {
    host = new URL(pageUrl).hostname.replace(/^www\./, '');
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const l of $('link[rel~="stylesheet"][href]').toArray()) {
    const href = $(l).attr('href') || '';
    let u: URL;
    try {
      u = new URL(href.startsWith('//') ? `https:${href}` : href, pageUrl);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(u.protocol)) continue;
    const ours = u.hostname.replace(/^www\./, '') === host || u.hostname === 'cdn.shopify.com' || u.hostname.endsWith(`.${host}`);
    if (!ours || /fonts\.|font-awesome|fontawesome|icons?\b|slick|swiper|animate|bootstrap\.min/i.test(u.pathname)) continue;
    // The theme's sheets first (Dawn's base.css, a WordPress theme's style.css, Elementor's kit), then the rest.
    const rank = /elementor\/css\/post-|global|theme|base\.css|style\.css|main|custom/i.test(u.pathname) ? 0 : 1;
    out.push(`${rank}${u.toString()}`);
  }
  return [...new Set(out)].sort().map((x) => x.slice(1)).slice(0, 3);
}

// ---------------------------------------------------------------- the chat's look

export type LookMode = 'site' | 'light' | 'dark';
/** The owner's own choice for the chat (channel_accounts.meta.look on the web account): a main colour, light or dark. */
export type LookChoice = { color?: string | null; mode?: LookMode | null };

export type Look = {
  primary: string;
  onPrimary: string;
  bg: string;
  surface: string; // the store's bubbles
  text: string;
  muted: string;
  line: string;
  accent: string; // links in the store's bubbles
  ink: string; // the main colour as text and as the focus ring: the questions to tap, the field in focus
  rCtl: number; // the field and the send button
  rBubble: number;
  rPanel: number;
  rLaunch: string; // '50%' or a px value
  font: string | null;
  dark: boolean;
  from: 'owner' | 'site' | 'none';
};

const SYSTEM_FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, 'Noto Sans Hebrew', Roboto, Arial, sans-serif";
const NEUTRAL = { light: { primary: '#2c2c30', bg: '#ffffff', text: '#1d1d1f' }, dark: { primary: '#f2f2f5', bg: '#161618', text: '#f5f5f7' } };

/**
 * The chat's colours, corners and type: the owner's choice over the site's look over the brand's colour, else a calm
 * neutral one. Every text colour passes 4.5:1 on what it sits on (WCAG AA); a colour that does not is moved in
 * lightness until it does, its hue kept.
 */
export function lookOf({ palette, colors, choice }: { palette?: Partial<Palette> | null; colors?: (string | null | undefined)[] | null; choice?: LookChoice | null }): Look {
  const p = palette || {};
  const mode: LookMode = choice?.mode === 'light' || choice?.mode === 'dark' ? choice.mode : 'site';
  // The site's background is the chat's when it is clearly dark or clearly light; a mid one (a teal page, a grey one)
  // makes a poor place to read a conversation, so the chat is then light and neutral.
  const siteBg = colorOf(p.background);
  const siteDark = Boolean(siteBg) && luminance(siteBg!) < 0.08;
  const siteLight = Boolean(siteBg) && luminance(siteBg!) >= 0.6;
  const dark = mode === 'dark' || (mode === 'site' && siteDark);
  const n = dark ? NEUTRAL.dark : NEUTRAL.light;
  const bg = dark ? (siteDark ? siteBg! : n.bg) : siteLight ? siteBg! : n.bg;

  // Text: the site's when it is on the right side of the background, made to read; else the neutral one.
  const siteText = colorOf(p.text);
  let text = siteText && contrast(siteText, bg) >= 3 ? readableOn(siteText, bg) : n.text;
  const surface = mix(bg, text, dark ? 0.12 : 0.055);
  text = readableOn(text, surface);
  if (contrast(text, bg) < 4.5) text = n.text;
  let muted = readableOn(mix(text, bg, 0.38), bg);
  if (contrast(muted, bg) < 4.5) muted = text;
  const line = mix(bg, text, dark ? 0.16 : 0.1);

  // The main colour: the owner's, the site's, the brand's, or the neutral one.
  const own = colorOf(choice?.color);
  const brand = (colors || []).map((c) => colorOf(c)).find((c) => c && isBrandish(c)) || null;
  let primary = own || colorOf(p.primary) || brand || n.primary;
  const from: Look['from'] = own ? 'owner' : colorOf(p.primary) || brand ? 'site' : 'none';
  // The launcher sits on the store's page: never the page's own background colour, where it would vanish.
  if (contrast(primary, bg) < 1.5) primary = readableOn(primary, bg, 1.5);
  // Text on it: the site's own button text when it reads, else white, else near-black, else the colour moves.
  const siteOn = !own && colorOf(p.primary) ? colorOf(p.onPrimary) : null;
  let onPrimary = siteOn && contrast(siteOn, primary) >= 4.5 ? siteOn : contrast('#ffffff', primary) >= 4.5 ? '#ffffff' : contrast('#111114', primary) >= 4.5 ? '#111114' : null;
  if (!onPrimary) {
    onPrimary = contrast('#ffffff', primary) >= contrast('#111114', primary) ? '#ffffff' : '#111114';
    primary = readableOn(primary, onPrimary, 4.5);
  }
  const accent = readableOn(colorOf(p.accent) && contrast(colorOf(p.accent)!, bg) >= 1.5 ? colorOf(p.accent)! : primary, surface);

  // Corners: a square site gets a squarer chat, a pill site a round one, the rest the middle.
  const r = typeof p.radius === 'number' && Number.isFinite(p.radius) ? p.radius : null;
  const rCtl = r == null ? 22 : r >= 20 ? 999 : Math.max(6, Math.min(16, r + 4));
  const rBubble = r == null ? 18 : r <= 2 ? 8 : r <= 8 ? 12 : 18;
  const rPanel = r == null ? 20 : r <= 2 ? 10 : r <= 8 ? 14 : 20;
  const rLaunch = r != null && r <= 2 ? '18px' : '50%';
  const font = fontName(p.font);
  const ink = readableOn(primary, surface);
  return { primary, onPrimary, bg, surface, text, muted, line, accent, ink, rCtl, rBubble, rPanel, rLaunch, font, dark, from };
}

// --scheme is the panel's colour scheme, not the frame's: a frame whose page says "dark" while the store's page does
// not is painted opaque by the browser, a dark square around the closed button.
/** The look as the chat's CSS tokens. Every value is a checked colour, number or font name: nothing a site wrote reaches the CSS as it was. */
export function lookCss(l: Look): string {
  const hex = (c: string) => (/^#[0-9a-f]{6}$/.test(c) ? c : '#000000');
  const font = l.font && /^[\p{L}\p{N} ._-]{2,40}$/u.test(l.font) ? `'${l.font}', ${SYSTEM_FONT}` : SYSTEM_FONT;
  return `:root{--p:${hex(l.primary)};--on-p:${hex(l.onPrimary)};--bg:${hex(l.bg)};--surface:${hex(l.surface)};--text:${hex(l.text)};--muted:${hex(l.muted)};--line:${hex(l.line)};--accent:${hex(l.accent)};--ink:${hex(l.ink)};--r-ctl:${Math.round(l.rCtl)}px;--r-bubble:${Math.round(l.rBubble)}px;--r-panel:${Math.round(l.rPanel)}px;--r-launch:${/^(50%|\d{1,3}px)$/.test(l.rLaunch) ? l.rLaunch : '50%'};--font:${font};--bad:${l.dark ? '#ff8a8a' : '#b3261e'};--sh:${l.dark ? 'rgba(0,0,0,.6)' : 'rgba(0,0,0,.3)'};--store:${hex(l.primary)};--store-ink:${hex(l.onPrimary)};--scheme:${l.dark ? 'dark' : 'light'}}\n`;
}
