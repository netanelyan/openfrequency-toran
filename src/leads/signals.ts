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
