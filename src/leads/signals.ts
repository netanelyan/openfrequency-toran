import * as cheerio from 'cheerio';
import { cleanEmail, canonicalDomain, toIntl } from '../core/urls.ts';
import { hebrewRatio } from '../core/hebrew.ts';

// What a store's home page says about it, read from the HTML alone (no extra
// requests). detect.ts adds what the platform's own endpoints say.
//
// Rewritten from tiyul-social's contactsFrom(), which took only the first mailto and
// knew two WhatsApp link shapes: here every email on the page is collected, plain-text
// ones included; every WhatsApp shape (wa.me/<n>, wa.me/message/<id>, api/web
// whatsapp.com/send?phone=, whatsapp://, and the chat-widget plugins that inject the
// button with JS) is recognised; Hebrew is a share of the visible letters, not "three
// Hebrew letters somewhere".
//
// The store's own Instagram, TikTok and Facebook (socialProfile): the first real profile of each, from the links in
// document order, then from anywhere else in the HTML (JSON-LD's sameAs, a theme's settings). A share button, a post,
// a reel or a video, the Facebook pixel and its plugins are not a profile, and neither is the platform's own account
// (a theme left pointing at Shopify's or Wix's) or a placeholder.

/** A store's profiles, each a full https URL in one form: www.instagram.com/<handle>/, www.tiktok.com/@<handle>, www.facebook.com/<page>. */
export type Social = { instagram: string | null; tiktok: string | null; facebook: string | null };

export type HomeSignals = {
  title: string;
  siteName: string | null;
  description: string | null;
  lang: string | null;
  dir: string | null;
  hebrewRatio: number;
  textLength: number;
  platformHints: string[];
  emails: string[];
  whatsappNumbers: string[];
  whatsappWidget: string | null; // the marker that showed a chat button without a number in the HTML
  phones: string[];
  social: Social;
  shekel: boolean;
  storeLocator: boolean; // a "find a branch" page: a chain
  cartMarkers: boolean;
  contactLinks: string[];
  policyLinks: { url: string; text: string }[];
  externalLinks: string[]; // other sites this one links to (the crawl frontier)
  logo: string | null;
  themeColor: string | null;
};

// Platform fingerprints in the raw HTML (and headers, in detect.ts). Order matters only for display.
const PLATFORM_HINTS: [string, RegExp][] = [
  ['shopify', /cdn\.shopify\.com|Shopify\.theme|shopify-section|\.myshopify\.com/],
  ['woocommerce', /woocommerce|wp-content\/plugins\/woocommerce|wc-block-/],
  ['wordpress', /wp-content\/|wp-includes\//],
  ['wix', /static\.wixstatic\.com|wix-code|wixstores|_wixCIDX|X-Wix/],
  ['konimbo', /konimbo/i],
  ['cashcow', /cashcow\.co\.il|cashcow-cdn/i],
  ['magento', /Magento_|mage\/cookies|static\/version\d+\/frontend/],
  ['bigcommerce', /cdn\d*\.bigcommerce\.com/],
];

// The hosts a store links to that are never another store.
const NOT_A_STORE = /(^|\.)(facebook|fb|messenger|meta|threads|snapchat|apps\.apple|play|instagram|tiktok|youtube|youtu|twitter|x|linkedin|pinterest|whatsapp|wa|google|goo|apple|microsoft|shopify|myshopify|wix|wixsite|wordpress|woocommerce|paypal|bit|payboxapp|cardcom|tranzila|meshulam|grow|icount|greeninvoice|morning|cloudflare|jsdelivr|gstatic|googleapis|w3|schema|creativecommons|waze|maps|t|telegram|spotify|vimeo|amazon|aliexpress|ebay|zap|wikipedia|gov|cbs|bing|yahoo|hotjar|klaviyo|mailchimp|judge|stamped|yotpo|okendo|sentry|doubleclick|trustpilot|storecensus|elfsight|getbutton|tidio|zendesk|intercom)\.[a-z.]+$/i;

const WA_NUMBER = [
  /(?:https?:)?\/\/(?:wa\.me|api\.whatsapp\.com\/send\/?\?(?:[^"'\s]*?&)?phone=|web\.whatsapp\.com\/send\/?\?(?:[^"'\s]*?&)?phone=)\/?(?:%2B|\+)?(\d{9,15})/gi,
  /whatsapp:\/\/send\/?\?(?:[^"'\s]*?&)?phone=(?:%2B|\+)?(\d{9,15})/gi,
];
const WA_ANY = /wa\.me\/message\/\w+|api\.whatsapp\.com|web\.whatsapp\.com|whatsapp:\/\//i;
const WA_WIDGET = /joinchat|wa-chat|click-to-chat|whatsapp-button|wa-widget|floating-whatsapp|elfsight[^"']*whatsapp|getbutton\.io|whatsapp-chat|wati\.io|chaty|qlwapp/i;
const EMAIL_TEXT = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const IL_PHONE = /(?<![\d])(?:\+?972[-\s]?|0)(?:[23489]|5\d|7\d)[-\s]?\d{3}[-\s]?\d{4}(?![\d])/g;
const CONTACT_TEXT = /צור[\s-]*קשר|יצירת[\s-]*קשר|contact/i;
const POLICY_TEXT = /משלוח|החזר|החלפ|ביטול|תקנון|מדיניות|תשלום|אחריות|shipping|refund|return|policy|terms|delivery|faq|שאלות/i;
const LOCATOR = /איתור\s*סניפ|סניפי\s*הרשת|סניפים|הסניפים שלנו|רשימת\s*(?:ה)?חנויות|חנויות\s*הרשת|store\s*locator|find a store|our stores/i;
const LOCATOR_HREF = /store-?locator|\/(?:pages\/)?(?:branches|stores|our-stores|snifim|סניפים)\/?$/i;
const CART = /\/cart\b|add[-_ ]to[-_ ]cart|הוסף?\s*ל(?:סל|עגלה)|הוספה\s*ל(?:סל|עגלה)|לסל הקניות|checkout/i;

// ---- social profiles
const IG_HOST = /^(?:www\.|m\.)?(?:instagram\.com|instagr\.am)$/;
const TT_HOST = /^(?:www\.|m\.)?tiktok\.com$/;
// facebook.com and fb.com, bare or on www, m, web, mobile, touch or a language (he-il.facebook.com); never l. or lm.
// (the outbound redirect), business. or developers.
const FB_HOST = /^(?:(?:www|m|web|mobile|touch|[a-z]{2}-[a-z]{2})\.)?(?:facebook\.com|fb\.com)$/;
/** Instagram's own paths: a post, a reel, the explore page, a share link, the login. */
const IG_NOT = new Set(['p', 'reel', 'reels', 'tv', 'explore', 'stories', 'accounts', 'direct', 'about', 'legal', 'developer', 'web', 's', 'share', 'oauth', 'challenge', 'emails', 'api', 'static', 'privacy', 'terms', 'help', 'lite', 'download', 'nametag', 'session', 'embed', 'invites', 'topics', 'locations', 'tags']);
/** Facebook's own paths: the share and like buttons, the pixel (/tr), the dialogs, a post, a photo, a group, an event. */
const FB_NOT = new Set(['sharer', 'share', 'dialog', 'tr', 'plugins', 'login', 'logout', 'recover', 'home', 'events', 'groups', 'watch', 'hashtag', 'help', 'policies', 'privacy', 'legal', 'terms', 'business', 'ads', 'marketplace', 'gaming', 'photo', 'photos', 'video', 'videos', 'story', 'permalink', 'posts', 'search', 'settings', 'notes', 'messages', 'messenger', 'friends', 'reel', 'reels', 'stories', 'media', 'fundraisers', 'jobs', 'places', 'public', 'about', 'connect', 'fbml', 'careers', 'directory', 'lite', 'mobile', 'notifications', 'bookmarks', 'saved', 'live', 'me', 'ajax', 'security', 'campaign', 'offsite_event', 'l', 'pages', 'people', 'pg', 'profile', 'n', 'x', 'a']);
/** A TikTok profile's path: @ and the handle. Everything else on tiktok.com is TikTok's own (a video, an embed, a tag). */
const TT_HANDLE = /^@([a-z0-9._]{2,24})$/i;
/**
 * The platforms' and the networks' own accounts, which a theme links to until the store fills in its own, and a
 * theme's placeholders: never the store's. Compared in lower case without dots, dashes and underscores.
 */
const NOT_THE_STORE = new Set(['shopify', 'shopifyplus', 'wix', 'wixcom', 'woocommerce', 'wordpress', 'wordpressdotcom', 'automattic', 'elementor', 'magento', 'adobe', 'bigcommerce', 'squarespace', 'godaddy', 'konimbo', 'cashcow', 'facebook', 'instagram', 'tiktok', 'meta', 'openfrequency', 'username', 'yourusername', 'yourname', 'yourpage', 'yourbrand', 'yourstore', 'yourshop', 'yourcompany', 'yourhandle', 'pagename', 'handle', 'account', 'page', 'profile', 'example', 'test']);
/** A path segment with its %-escapes read; a malformed one is left as it is (and then refused as a name). */
const decoded = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};
const ownAccount = (name: string) => NOT_THE_STORE.has(name.toLowerCase().replace(/[._-]/g, ''));
/** A file on the network's site (its embed script, an image), which a name with a dot in it can look like. */
const FILE = /\.(?:js|php|html?|css|json|xml|png|jpe?g|gif|svg|webp|ico)$/i;
/** Social URLs anywhere in the HTML: in a script's JSON (slashes escaped as \/ or /), JSON-LD's sameAs, an attribute. */
const SOCIAL_IN_HTML = /(?:https?:)?\/\/(?:[a-z0-9-]+\.)?(?:instagram\.com|instagr\.am|tiktok\.com|facebook\.com|fb\.com)\/[^\s"'<>\\()]*/gi;

/**
 * The network and the profile's URL in its one form, when a link is a store's profile on Instagram, TikTok or
 * Facebook; null for anything else (a share button, a post, the pixel, the platform's own account).
 */
export function socialProfile(href: string): { network: keyof Social; url: string } | null {
  let u: URL;
  try {
    u = new URL(href.startsWith('//') ? `https:${href}` : href);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split('/').filter(Boolean);
  if (IG_HOST.test(host)) {
    // instagram.com/_u/<handle> is the app's deep link to a profile.
    const p = parts[0] === '_u' ? parts.slice(1) : parts;
    const h = p.length === 1 ? p[0].toLowerCase() : '';
    if (!/^[a-z0-9._]{1,30}$/.test(h) || /^\.|\.$|\.\./.test(h) || FILE.test(h) || IG_NOT.has(h) || ownAccount(h)) return null;
    return { network: 'instagram', url: `https://www.instagram.com/${h}/` };
  }
  if (TT_HOST.test(host)) {
    const h = parts.length === 1 ? TT_HANDLE.exec(parts[0])?.[1]?.toLowerCase() : null;
    if (!h || ownAccount(h)) return null;
    return { network: 'tiktok', url: `https://www.tiktok.com/@${h}` };
  }
  if (FB_HOST.test(host)) {
    const first = (parts[0] || '').toLowerCase();
    // A profile with no name of its own, and the older forms of a Page with no name of its own.
    if (first === 'profile.php' && parts.length === 1) {
      const id = u.searchParams.get('id') || '';
      return /^\d{5,20}$/.test(id) ? { network: 'facebook', url: `https://www.facebook.com/profile.php?id=${id}` } : null;
    }
    if ((first === 'pages' || first === 'people') && parts.length === 3 && /^\d{5,20}$/.test(parts[2]) && !ownAccount(decoded(parts[1]))) return { network: 'facebook', url: `https://www.facebook.com/${first}/${parts[1]}/${parts[2]}` };
    // facebook.com/pg/<page>/... is an older address of the Page itself.
    const page = first === 'pg' ? parts[1] : parts.length === 1 ? parts[0] : '';
    if (!page) return null;
    const name = decoded(page);
    if (!/^[\p{L}\p{N}._-]{2,100}$/u.test(name) || FILE.test(name) || /^v\d+(\.\d+)?$/i.test(name) || FB_NOT.has(name.toLowerCase()) || ownAccount(name)) return null;
    return { network: 'facebook', url: `https://www.facebook.com/${page}` };
  }
  return null;
}

/** The first real profile of each network, from the links in document order, then from the rest of the HTML. */
function socialOf(hrefs: string[], html: string, base: URL): Social {
  const found: Social = { instagram: null, tiktok: null, facebook: null };
  const inHtml = [...html.replace(/\\\/|\\u002f/gi, '/').matchAll(SOCIAL_IN_HTML)].map((m) => m[0].replace(/&amp;/g, '&'));
  for (const href of [...hrefs, ...inHtml]) {
    let abs: string;
    try {
      abs = href.startsWith('//') ? `https:${href}` : new URL(href, base).toString();
    } catch {
      continue;
    }
    const p = socialProfile(abs);
    if (p && !found[p.network]) found[p.network] = p.url;
  }
  return found;
}

export function readHome(html: string, pageUrl: string): HomeSignals {
  const $ = cheerio.load(html);
  const base = new URL(pageUrl);
  const ownDomain = canonicalDomain(pageUrl);

  const lang = ($('html').attr('lang') || '').trim().toLowerCase() || null;
  const dir = ($('html').attr('dir') || $('body').attr('dir') || '').trim().toLowerCase() || null;
  const title = $('title').first().text().trim();
  const siteName = $('meta[property="og:site_name"]').attr('content')?.trim() || null;
  const description = $('meta[name="description"]').attr('content')?.trim() || $('meta[property="og:description"]').attr('content')?.trim() || null;
  const themeColor = $('meta[name="theme-color"]').attr('content')?.trim() || null;

  // Links, before the scripts go: hrefs, plus the raw HTML for patterns that live in scripts and attributes.
  const hrefs: { href: string; text: string }[] = [];
  $('a[href]').each((_, el) => {
    hrefs.push({ href: String($(el).attr('href') || ''), text: $(el).text().replace(/\s+/g, ' ').trim() });
  });

  const emails = new Set<string>();
  for (const { href } of hrefs) if (/^mailto:/i.test(href)) {
    const e = cleanEmail(decodeURIComponent(href));
    if (e) emails.add(e);
  }

  const wa = new Set<string>();
  for (const re of WA_NUMBER) for (const m of html.matchAll(re)) {
    const n = toIntl(m[1]);
    if (n) wa.add(n);
  }
  const whatsappWidget = wa.size ? null : (WA_ANY.exec(html)?.[0] || WA_WIDGET.exec(html)?.[0] || null);

  const phones = new Set<string>();
  for (const { href } of hrefs) if (/^tel:/i.test(href)) {
    const n = toIntl(href.slice(4));
    if (n) phones.add(n);
  }

  // The visible text: what a customer reads.
  $('script, style, noscript, template, svg').remove();
  const text = $('body').text().replace(/\s+/g, ' ').trim();
  for (const m of text.matchAll(EMAIL_TEXT)) {
    const e = cleanEmail(m[0]);
    if (e) emails.add(e);
  }
  for (const m of text.matchAll(IL_PHONE)) {
    const n = toIntl(m[0]);
    if (n) phones.add(n);
  }

  const abs = (href: string) => {
    try {
      return new URL(href, base).toString();
    } catch {
      return null;
    }
  };
  const contactLinks = new Set<string>();
  const policyLinks = new Map<string, string>();
  const external = new Set<string>();
  for (const { href, text: t } of hrefs) {
    if (/^(mailto|tel|javascript|whatsapp):/i.test(href) || href.startsWith('#')) continue;
    const u = abs(href);
    if (!u || !/^https?:/.test(u)) continue;
    const d = canonicalDomain(u);
    if (!d) continue;
    if (d === ownDomain) {
      const p = new URL(u).pathname;
      if (CONTACT_TEXT.test(t) || /\/(pages\/)?(contact|contact-us|צור-קשר)\/?$/i.test(decodeURIComponent(p))) contactLinks.add(u.split('#')[0]);
      if (POLICY_TEXT.test(t) || /\/policies\/|\/pages\/(shipping|returns|faq)/i.test(p)) if (!policyLinks.has(u.split('#')[0])) policyLinks.set(u.split('#')[0], t.slice(0, 80));
    } else if (!NOT_A_STORE.test(new URL(u).hostname)) {
      external.add(`https://${new URL(u).hostname}/`);
    }
  }

  // The logo: an <img> whose class, id, alt or src says logo, inside the header if there is one.
  let logo: string | null = null;
  const logoImg = $('header img, .header img, #header img, img').filter((_, el) => /logo/i.test(`${$(el).attr('class') || ''} ${$(el).attr('id') || ''} ${$(el).attr('alt') || ''} ${$(el).attr('src') || ''}`)).first();
  const src = logoImg.attr('src') || logoImg.attr('data-src') || (logoImg.attr('srcset') || '').split(/\s+/)[0];
  if (src) logo = abs(src.startsWith('//') ? `https:${src}` : src);
  if (!logo) {
    const og = $('meta[property="og:image"]').attr('content');
    if (og) logo = abs(og);
  }

  return {
    title,
    siteName,
    description,
    lang,
    dir,
    hebrewRatio: Number(hebrewRatio(`${title} ${text}`).toFixed(3)),
    textLength: text.length,
    platformHints: PLATFORM_HINTS.filter(([, re]) => re.test(html)).map(([k]) => k),
    emails: [...emails].sort((a, b) => Number(b.endsWith(`@${ownDomain}`)) - Number(a.endsWith(`@${ownDomain}`))).slice(0, 8),
    whatsappNumbers: [...wa].slice(0, 5),
    whatsappWidget,
    phones: [...phones].slice(0, 5),
    social: socialOf(hrefs.map((h) => h.href), html, base),
    shekel: /₪|ש"ח|ש״ח|\bILS\b|שקל/.test(text),
    storeLocator: LOCATOR.test(text) || hrefs.some(({ href, text: t }) => LOCATOR_HREF.test(href.split('?')[0]) || /^(?:סניפים|איתור סניף|הסניפים שלנו|חנויות הרשת)$/.test(t)),
    cartMarkers: CART.test(html),
    contactLinks: [...contactLinks].slice(0, 3),
    policyLinks: [...policyLinks].map(([url, t]) => ({ url, text: t })).slice(0, 20),
    externalLinks: [...external].slice(0, 60),
    logo,
    themeColor,
  };
}
