import * as cheerio from 'cheerio';
import type { Fetcher } from '../core/http.ts';
import { hebrewRatio } from '../core/hebrew.ts';
import { htmlText } from './rows.ts';

// A store's policy and help pages: shipping, returns, payment, contact, about, FAQ,
// terms. Read as the store wrote them; the agent quotes them through get_policy and
// nowhere else.
//
// Where they are: every link on the home page whose text or address says shipping,
// returns, payment, terms, FAQ or contact; the platform's standard addresses (Shopify's
// /policies/shipping-policy and /pages/faq, WooCommerce's /refund_returns/, the Hebrew
// FAQ slugs stores give that page on each platform); and, off Shopify, the pages the
// store's sitemap lists whose address says the same (Wix, WordPress and Cashcow have no
// standard policy paths, and their slugs are often Hebrew).
//
// Questions are read three ways (readFaqs): a schema.org FAQPage (the JSON-LD that FAQ
// plugins and themes publish for Google), questions marked up as such (<details>, an
// accordion, a heading or a bold line that ends with "?"), and, on a FAQ page, plain
// text: a paragraph that ends with "?" and the paragraphs under it, up to the next one,
// with "ש:" and "ת:" taken off.

export type PolicyPage = { kind: string; title: string; url: string; text: string };
export type Faq = { question: string; site_answer: string | null; source_url: string };

const STANDARD: Record<string, string[]> = {
  shopify: ['/policies/shipping-policy', '/policies/refund-policy', '/policies/terms-of-service', '/pages/faq', '/pages/contact', '/pages/shipping', '/pages/returns', '/pages/about', '/pages/about-us', '/pages/שאלות-נפוצות', '/pages/שאלות-ותשובות'],
  // WooCommerce creates /refund_returns/ on install; the rest are the slugs Israeli WordPress themes ship with.
  woocommerce: ['/refund_returns/', '/shipping/', '/faq/', '/contact/', '/about/', '/שאלות-נפוצות/', '/שאלות-ותשובות/'],
  wix: ['/faq', '/שאלות-נפוצות'], // the sitemap names the rest
  cashcow: ['/page/שאלות_נפוצות', '/page/שאלות_ותשובות'], // the sitemap names the rest, under /page/
};

/** The standard policy addresses on a platform. */
export const standardPaths = (platform: string | null | undefined): string[] => STANDARD[String(platform || '')] ?? STANDARD.shopify;

const KINDS: [string, RegExp][] = [
  ['shipping', /משלוח|אספק|איסוף עצמי|shipping|delivery/i],
  ['returns', /החזר|החלפ|ביטול עסקה|refund|return|exchange/i],
  ['payment', /תשלום|תשלומים|payment/i],
  ['faq', /שאלות|faq|questions/i],
  ['contact', /צור[\s-]*קשר|צרו[\s-]*קשר|יצירת קשר|שירות לקוחות|contact|customer-service/i],
  ['about', /אודות|עלינו|הסיפור שלנו|about/i],
  ['terms', /תקנון|תנאי|terms|policy|מדיניות|regulations|takanon/i],
];

export function kindOf(title: string, url: string): string {
  const s = `${title} ${decodeURIComponent(url).replace(/_/g, ' ')}`; // Cashcow's slugs join words with "_": /page/צרו_קשר
  if (/privacy|פרטיות|cookie|עוגיות|accessibility|נגישות/i.test(s)) return 'skip';
  for (const [k, re] of KINDS) if (re.test(s)) return k;
  return 'other';
}

/** The page's own text: the policy body or the main column, without the header, the footer and the menus. */
export function mainText(html: string): { title: string; text: string } {
  const $ = cheerio.load(html);
  const title = ($('h1').first().text() || $('meta[property="og:title"]').attr('content') || $('title').text()).replace(/\s+/g, ' ').trim().split(/\s[|–-]\s/)[0];
  $('script, style, noscript, template, svg, header, footer, nav, form, [role="navigation"], .header, .footer, #shopify-section-header, #shopify-section-footer, #SITE_HEADER, #SITE_FOOTER, .skip-link, .screen-reader-text, .announcement-bar, .cart-drawer, [id*="cookie"], [class*="cookie"]').remove();
  const main = $('.shopify-policy__body, main .rte, #MainContent .rte, main, #MainContent, [role="main"], article').first();
  const root = main.length ? main : $('body');
  root.find('br').replaceWith('\n');
  root.find('p, li, h1, h2, h3, h4, h5, tr, summary, dt, dd, div').each((_, el) => {
    $(el).append('\n');
  });
  const text = root.text().replace(/[ \t ]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
  return { title, text: text.slice(0, 20_000) };
}

/** The questions and answers of a schema.org FAQPage on a page (JSON-LD, in an array or an @graph alike). */
export function faqJsonLd(html: string, url: string): Faq[] {
  const out: Faq[] = [];
  const walk = (o: any) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) return o.forEach(walk);
    const types = [o['@type']].flat().map(String);
    if (types.includes('Question') && o.name) {
      const a = [o.acceptedAnswer, o.suggestedAnswer].flat().find((x: any) => x?.text);
      out.push({ question: htmlText(String(o.name), 300).replace(/\s+/g, ' '), site_answer: a ? htmlText(String(a.text), 1200).replace(/\s+/g, ' ') || null : null, source_url: url });
      return;
    }
    if (o.mainEntity) walk(o.mainEntity);
    if (Array.isArray(o['@graph'])) o['@graph'].forEach(walk);
  };
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      walk(JSON.parse(m[1].trim()));
    } catch {
      /* a broken block: the others still count */
    }
  }
  return out;
}

const QUESTION_MARK = /[?؟]\s*$/;
const Q_PREFIX = /^\s*(?:(?:\d{1,2}|[א-י])[.)]\s*|ש(?:אלה)?\s*[:.]\s*|Q\s*[:.]\s*)/;
const A_PREFIX = /^\s*(?:ת(?:שובה)?\s*[:.]\s*|A\s*[:.]\s*)/;

/**
 * Questions on a page, each with the text under it: the FAQPage JSON-LD, <details>, headings, accordions and bold
 * lines that end with a question mark, and, when `faqPage` (the page is the store's FAQ) or when the page has three
 * or more of them, plain paragraphs that end with one and the paragraphs that follow.
 */
export function readFaqs(html: string, url: string, { faqPage = false }: { faqPage?: boolean } = {}): Faq[] {
  const $ = cheerio.load(html);
  $('script, style, header, footer, nav').remove();
  const out: Faq[] = [];
  const seen = new Set<string>();
  const add = (q: string, a: string | null) => {
    const question = q.replace(Q_PREFIX, '').replace(/\s+/g, ' ').trim();
    if (question.length < 8 || question.length > 160 || hebrewRatio(question) < 0.4 || seen.has(question)) return;
    seen.add(question);
    out.push({ question, site_answer: a ? a.replace(A_PREFIX, '').replace(/\s+/g, ' ').trim().slice(0, 1200) || null : null, source_url: url });
  };
  for (const f of faqJsonLd(html, url)) add(f.question, f.site_answer);
  $('details').each((_, el) => add($(el).find('summary').first().text(), $(el).clone().children('summary').remove().end().text()));
  $('h2, h3, h4, strong, b, button, [class*="question"], [class*="accordion"] > *:first-child').each((_, el) => {
    const t = $(el).text();
    if (!QUESTION_MARK.test(t.trim())) return;
    // A bold question that opens its own paragraph ("<p><b>Q?</b> A</p>") has its answer beside it, not after it.
    const parent = $(el).parent();
    const beside = parent.is('p, li, div') && parent.children().length <= 3 ? parent.text().replace(t, '').trim() : '';
    const next = beside.length >= 2 ? beside : $(el).nextAll('p, div, .rte, [class*="answer"]').first().text() || $(el).parent().next().text();
    add(t, next || null);
  });
  const plain = plainPairs(mainText(html).text, { split: faqPage });
  if (faqPage || plain.length >= 3) for (const p of plain) add(p.q, p.a);
  return out.slice(0, 40);
}

/**
 * Question and answer pairs in a page's text, one block a line (mainText): a line that ends with "?" is a question
 * and the lines under it, up to the next question, its answer. With `split`, a line that opens with a question and
 * goes on ("Q? A") is a pair too. A question with no answer under it is not a pair.
 */
export function plainPairs(text: string, { split = false }: { split?: boolean } = {}): { q: string; a: string }[] {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const isQ = (l: string) => QUESTION_MARK.test(l) && l.replace(Q_PREFIX, '').length >= 8 && l.length <= 170;
  const pairs: { q: string; a: string }[] = [];
  let cur: { q: string; a: string[] } | null = null;
  const close = () => {
    if (cur?.a.length) pairs.push({ q: cur.q, a: cur.a.join(' ').slice(0, 1200) });
    cur = null;
  };
  for (const l of lines) {
    if (isQ(l)) {
      close();
      cur = { q: l, a: [] };
      continue;
    }
    const at = split ? l.search(/[?؟]\s/) : -1;
    if (at >= 8 && at <= 160 && !A_PREFIX.test(l)) {
      close();
      pairs.push({ q: l.slice(0, at + 1), a: l.slice(at + 1).trim() });
      continue;
    }
    if (cur && cur.a.join(' ').length < 1200) cur.a.push(l);
  }
  close();
  return pairs;
}

/** Text in chunks of about `size` characters on paragraph boundaries, for embedding. */
export function chunk(text: string, size = 700): string[] {
  const paras = text.split(/\n+/).map((p) => p.trim()).filter(Boolean);
  const out: string[] = [];
  let cur = '';
  for (const p of paras) {
    if (cur && cur.length + p.length + 1 > size) {
      out.push(cur);
      cur = '';
    }
    if (p.length > size * 1.5) {
      for (let i = 0; i < p.length; i += size) out.push(p.slice(i, i + size));
      continue;
    }
    cur = cur ? `${cur}\n${p}` : p;
  }
  if (cur) out.push(cur);
  return out.filter((c) => c.length >= 25);
}

/** The policy pages from `links` and the platform's `standard` paths, under `base` (the store's origin, or a Wix site's path). */
export async function readPolicies(fetcher: Fetcher, base: string, links: { url: string; text: string }[], { max = 10, standard = STANDARD.shopify }: { max?: number; standard?: string[] } = {}): Promise<{ pages: PolicyPage[]; faqs: Faq[]; errors: string[] }> {
  const urls = new Map<string, string>();
  const host = (h: string) => h.replace(/^www\./, '');
  for (const l of links) {
    try {
      const u = new URL(l.url);
      const key = u.toString().split('#')[0];
      // The first link to a page names it: the home page's words come before a sitemap's empty text.
      if (host(u.hostname) === host(new URL(base).hostname) && !urls.has(key) && kindOf(l.text, u.pathname) !== 'skip' && kindOf(l.text, u.pathname) !== 'other') urls.set(key, l.text);
    } catch {
      /* a broken link */
    }
  }
  const guessed = new Set<string>();
  for (const p of standard) {
    const key = new URL(`${base}${p}`).toString(); // encoded as a link to it would be, so a Hebrew slug is not read twice
    if (!urls.has(key)) {
      urls.set(key, '');
      guessed.add(key);
    }
  }
  const pages: PolicyPage[] = [];
  const faqs: Faq[] = [];
  const errors: string[] = [];
  const seenText = new Set<string>();
  for (const [url, linkText] of [...urls].slice(0, max + standard.length)) {
    if (pages.length >= max) break;
    try {
      const r = await fetcher(url, { accept: 'text/html' });
      if (!/html/i.test(r.contentType) && !r.text.trimStart().startsWith('<')) continue;
      const { title, text } = mainText(r.text);
      const landed = new URL(r.url).pathname;
      // A guessed address that redirects somewhere that does not say what it is (Cashcow sends a missing page to the
      // home page with a 200) is not the page; /pages/shipping landing on /policies/shipping-policy is.
      if (guessed.has(url) && landed !== new URL(url).pathname && kindOf('', landed) === 'other') continue;
      const kind = kindOf(`${linkText} ${title}`, landed);
      if (kind === 'skip' || text.length < 80) continue;
      // /pages/shipping redirecting to the same page as the policy; the length too, since Wix pages can open with the same block.
      const key = `${text.length}:${text.slice(0, 300)}`;
      if (seenText.has(key)) continue;
      seenText.add(key);
      pages.push({ kind, title: title || linkText || kind, url: r.url, text });
      if (kind === 'faq' || /[?؟]/.test(text) || /"FAQPage"/.test(r.text)) faqs.push(...readFaqs(r.text, r.url, { faqPage: kind === 'faq' }));
    } catch (e: any) {
      if (e?.status !== 404) errors.push(`${new URL(url).pathname}: ${e.code || e.message}`);
    }
  }
  return { pages, faqs: faqs.slice(0, 40), errors };
}
