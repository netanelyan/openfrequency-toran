import * as cheerio from 'cheerio';
import type { Fetcher } from '../core/http.ts';
import { hebrewRatio } from '../core/hebrew.ts';

// A store's policy and help pages: shipping, returns, payment, contact, about, FAQ,
// terms. Read as the store wrote them; the agent quotes them through get_policy and
// nowhere else.
//
// Where they are: Shopify's standard policy URLs (/policies/shipping-policy, ...), the
// usual help pages (/pages/faq, /pages/contact, ...), and every link on the home page
// whose text or address says shipping, returns, payment, terms, FAQ or contact.

export type PolicyPage = { kind: string; title: string; url: string; text: string };
export type Faq = { question: string; site_answer: string | null; source_url: string };

const STANDARD = ['/policies/shipping-policy', '/policies/refund-policy', '/policies/terms-of-service', '/pages/faq', '/pages/contact', '/pages/shipping', '/pages/returns', '/pages/about', '/pages/about-us'];

const KINDS: [string, RegExp][] = [
  ['shipping', /משלוח|אספק|איסוף עצמי|shipping|delivery/i],
  ['returns', /החזר|החלפ|ביטול עסקה|refund|return|exchange/i],
  ['payment', /תשלום|תשלומים|payment/i],
  ['faq', /שאלות|faq|questions/i],
  ['contact', /צור[\s-]*קשר|יצירת קשר|contact/i],
  ['about', /אודות|עלינו|הסיפור שלנו|about/i],
  ['terms', /תקנון|תנאי|terms|policy|מדיניות/i],
];

export function kindOf(title: string, url: string): string {
  const s = `${title} ${decodeURIComponent(url)}`;
  if (/privacy|פרטיות|cookie|עוגיות|accessibility|נגישות/i.test(s)) return 'skip';
  for (const [k, re] of KINDS) if (re.test(s)) return k;
  return 'other';
}

/** The page's own text: the policy body or the main column, without the header, the footer and the menus. */
export function mainText(html: string): { title: string; text: string } {
  const $ = cheerio.load(html);
  const title = ($('h1').first().text() || $('title').text()).replace(/\s+/g, ' ').trim().split(/\s[|–-]\s/)[0];
  $('script, style, noscript, template, svg, header, footer, nav, form, [role="navigation"], .header, .footer, #shopify-section-header, #shopify-section-footer, .announcement-bar, .cart-drawer, [id*="cookie"], [class*="cookie"]').remove();
  const main = $('.shopify-policy__body, main .rte, #MainContent .rte, main, #MainContent, [role="main"], article').first();
  const root = main.length ? main : $('body');
  root.find('br').replaceWith('\n');
  root.find('p, li, h1, h2, h3, h4, h5, tr, summary, dt, dd, div').each((_, el) => {
    $(el).append('\n');
  });
  const text = root.text().replace(/[ \t ]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
  return { title, text: text.slice(0, 20_000) };
}

/** Questions on a page: headings, accordion summaries and lines that end with a question mark, each with the text under it. */
export function readFaqs(html: string, url: string): Faq[] {
  const $ = cheerio.load(html);
  $('script, style, header, footer, nav').remove();
  const out: Faq[] = [];
  const seen = new Set<string>();
  const add = (q: string, a: string | null) => {
    const question = q.replace(/\s+/g, ' ').trim();
    if (question.length < 8 || question.length > 160 || hebrewRatio(question) < 0.4 || seen.has(question)) return;
    seen.add(question);
    out.push({ question, site_answer: a ? a.replace(/\s+/g, ' ').trim().slice(0, 1200) || null : null, source_url: url });
  };
  $('details').each((_, el) => add($(el).find('summary').first().text(), $(el).clone().children('summary').remove().end().text()));
  $('h2, h3, h4, strong, b, button, [class*="question"], [class*="accordion"] > *:first-child').each((_, el) => {
    const t = $(el).text();
    if (!/\?\s*$/.test(t.trim())) return;
    const next = $(el).nextAll('p, div, .rte, [class*="answer"]').first().text() || $(el).parent().next().text();
    add(t, next || null);
  });
  return out.slice(0, 40);
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

export async function readPolicies(fetcher: Fetcher, origin: string, links: { url: string; text: string }[], { max = 10 }: { max?: number } = {}): Promise<{ pages: PolicyPage[]; faqs: Faq[]; errors: string[] }> {
  const urls = new Map<string, string>();
  for (const l of links) {
    try {
      const u = new URL(l.url);
      if (u.origin === origin && kindOf(l.text, u.pathname) !== 'skip' && kindOf(l.text, u.pathname) !== 'other') urls.set(u.toString().split('#')[0], l.text);
    } catch {
      /* a broken link */
    }
  }
  for (const p of STANDARD) if (!urls.has(`${origin}${p}`)) urls.set(`${origin}${p}`, '');
  const pages: PolicyPage[] = [];
  const faqs: Faq[] = [];
  const errors: string[] = [];
  const seenText = new Set<string>();
  for (const [url, linkText] of [...urls].slice(0, max + STANDARD.length)) {
    if (pages.length >= max) break;
    try {
      const r = await fetcher(url, { accept: 'text/html' });
      if (!/html/i.test(r.contentType) && !r.text.trimStart().startsWith('<')) continue;
      const { title, text } = mainText(r.text);
      const kind = kindOf(`${linkText} ${title}`, new URL(r.url).pathname);
      if (kind === 'skip' || text.length < 80) continue;
      const key = text.slice(0, 300);
      if (seenText.has(key)) continue; // /pages/shipping redirecting to the same page as the policy
      seenText.add(key);
      pages.push({ kind, title: title || linkText || kind, url: r.url, text });
      if (kind === 'faq' || /\?/.test(text)) faqs.push(...readFaqs(r.text, r.url));
    } catch (e: any) {
      if (e?.status !== 404) errors.push(`${new URL(url).pathname}: ${e.code || e.message}`);
    }
  }
  return { pages, faqs: faqs.slice(0, 40), errors };
}
