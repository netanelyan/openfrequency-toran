// A line about a store in its own words, for Teder's leads page (GET /internal/stores `about`, src/ops/stores.ts):
// the home page's meta description (or its og:description, which readHome takes when there is no description),
// else its <title>, both as detection kept them in stores.signals (signals.ts readHome, store.ts saveLead). Nothing is
// fetched and nothing is written here: only what Toran already read.
//
// The text is cleaned (HTML entities decoded, tags and invisible characters dropped, whitespace collapsed, an em or en
// dash a plain hyphen) and cut to ABOUT_MAX characters at a word. It is null when nothing says more than the card
// already does: empty, only the store's name or domain, a word like "Home" or "דף הבית", the platform's name or its
// default text ("Powered by Shopify", "Just another WordPress site"), or letters that are mostly neither Hebrew nor
// Latin.
//
// A title, or a description built like one ("<name> | <slogan>"), is split on its separators and the parts that are
// the name or a filler word are left out: "כלי חרס של נורית | קרמיקה בעבודת יד" is "קרמיקה בעבודת יד" under the card's
// heading, which already names the store. A sentence with no such separator is kept whole.

export const ABOUT_MAX = 160;

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', laquo: '«', raquo: '»',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', sbquo: '‚', bdquo: '„', middot: '·', bull: '•', copy: '©', reg: '®', trade: '™',
  shy: '', zwnj: '', zwj: '', lrm: '', rlm: '', thinsp: ' ', ensp: ' ', emsp: ' ', times: '×', deg: '°', euro: '€', pound: '£', cent: '¢',
};

/** Entities decoded, twice at most (a theme that escaped an escaped text: "&amp;quot;"). */
export function decodeEntities(s: string): string {
  let out = s;
  for (let i = 0; i < 2 && /&(?:#\d+|#x[0-9a-f]+|[a-z]+);/i.test(out); i++) {
    out = out.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '';
      }
      const v = NAMED[e.toLowerCase()];
      return v === undefined ? m : v;
    });
  }
  return out;
}

/** The text as a reader sees it: entities decoded, tags and invisible characters out, whitespace collapsed. */
export function cleanText(v: unknown): string {
  if (typeof v !== 'string') return '';
  return decodeEntities(v.replace(/<[^>]{0,500}>/g, ' '))
    .replace(/<[a-z/!][^>]{0,500}>/gi, ' ')
    .replace(/[\u0000-\u001f\u007f­​-‏‪-‮⁠-⁩﻿]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** For comparing: lower case, letters and digits only. */
const key = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

// A part that says nothing about the store by itself.
const FILLER = new RegExp(
  '^(?:' +
    [
      'home', 'home ?page', 'main', 'index', 'welcome', 'shop', 'store', 'online ?store', 'online ?shop', 'web ?shop', 'e-?shop', 'official site', 'official website', 'website', 'my site', 'my store', 'my shop', 'my website', 'my wordpress blog', 'my blog', 'untitled', 'default store view', 'coming soon', 'under construction', 'site', 'products', 'catalog', 'all products',
      'דף הבית', 'עמוד הבית', 'עמוד ראשי', 'ראשי', 'בית', 'חנות', 'החנות', 'חנות אונליין', 'חנות און ליין', 'חנות אינטרנטית', 'חנות וירטואלית', 'האתר הרשמי', 'אתר רשמי', 'האתר שלי', 'החנות שלי', 'ברוכים הבאים', 'ברוכות הבאות', 'בקרוב', 'האתר בבנייה', 'האתר בבניה', 'בבנייה', 'מוצרים', 'כל המוצרים', 'קטלוג',
      'shopify', 'wix', 'wix\\.com', 'wordpress', 'woocommerce', 'konimbo', 'קונימבו', 'cashcow', 'קאשקאו', 'magento', 'bigcommerce', 'squarespace', 'webflow', 'weebly', 'jimdo', 'שופיפיי', 'וויקס', 'ויקס', 'וורדפרס',
    ].join('|') +
    ')$',
  'i',
);
// The platform's words, not the store's.
const PLATFORM_TEXT = [
  /^(?:powered|created|built|made|designed|developed|hosted)\s+(?:by|with|on|using)\b/i,
  /^(?:נבנה|נוצר|מופעל|עוצב|פותח)\s+(?:ב|על ידי|ע"י|באמצעות|עם)/,
  /^(?:אתר|האתר)\s+(?:זה\s+)?(?:נבנה|נוצר)\s+(?:ב|על ידי|ע"י|באמצעות)/,
  /just another wordpress site/i,
  /lorem ipsum/i,
  /\b(?:wix|shopify|wordpress|squarespace|webflow|weebly|jimdo)\.com\b/i,
  /^(?:this is|welcome to) (?:my|our|the) (?:new )?(?:site|store|shop|website|blog)\b/i,
  /^(?:create|build|make) (?:a|your) (?:free )?(?:website|store|online store)\b/i,
];
const WELCOME = /^(?:ברוכים הבאים|ברוכות הבאות|ברוכים הבאות|welcome)\s*(?:to\s+|אל\s+|ל[-־]?)?/i;
const SEPARATOR = /\s+[|–—\-·•:»]\s+|\s*[|•·»]\s*/;

/** Mostly Hebrew or Latin letters (and some letters at all). */
function readable(s: string): boolean {
  const letters = (s.match(/\p{L}/gu) || []).length;
  if (letters < 3) return false;
  const ours = (s.match(/[א-ת]|[A-Za-zÀ-ɏ]/g) || []).length;
  return ours / letters >= 0.8;
}

/** At most `max` characters, cut at a word, with an ellipsis when it was cut. */
export function cutAtWord(s: string, max = ABOUT_MAX): string {
  if (s.length <= max) return s;
  const head = s.slice(0, max);
  const space = head.lastIndexOf(' ');
  const cut = space >= max * 0.6 ? head.slice(0, space) : head;
  return `${cut.replace(/[\s,;:|·•\-–—(]+$/, '')}…`;
}

/**
 * The store's line about itself, or null. names: what the store is called (the owner's edit, the brand's, the
 * site's); domain: its domain, which a title often repeats.
 */
export function storeAbout({ description, title, names = [], domain = null }: { description?: unknown; title?: unknown; names?: (string | null | undefined)[]; domain?: string | null }): string | null {
  const own = new Set<string>();
  const spelled: string[] = [];
  for (const n of names) {
    const c = cleanText(n);
    if (c && key(c)) {
      own.add(key(c));
      spelled.push(c.toLowerCase());
    }
  }
  if (domain) {
    const d = domain.toLowerCase().replace(/^www\./, '');
    for (const x of [d, d.split('.')[0]]) {
      own.add(key(x));
      spelled.push(x);
    }
  }
  const isName = (p: string) => own.has(key(p));
  const bare = (p: string) => p.replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, '');
  const isFiller = (p: string) => FILLER.test(bare(p));
  const filler = (p: string): boolean => {
    if (!key(p) || isName(p) || isFiller(p) || PLATFORM_TEXT.some((re) => re.test(p))) return true;
    // "ברוכים הבאים לכלי חרס של נורית", "Welcome to Kettles": a welcome and the name, and nothing else.
    const rest = bare(p.trim().replace(WELCOME, ''));
    if (rest !== bare(p)) return !rest || isName(rest) || isName(rest.replace(/^ל/, '')) || isFiller(rest);
    // "Kettles Store", "חנות Kettles": the name and a filler word.
    for (const n of spelled) {
      if (n.length < 3) continue;
      const at = p.toLowerCase().indexOf(n);
      if (at < 0) continue;
      const left = bare(`${p.slice(0, at)} ${p.slice(at + n.length)}`.replace(/\s+/g, ' '));
      if (!left || isFiller(left)) return true;
    }
    return false;
  };
  for (const raw of [description, title]) {
    const text = cleanText(raw);
    if (!text || PLATFORM_TEXT.some((re) => re.test(text))) continue;
    const parts = text.split(SEPARATOR).map((p) => p.trim()).filter(Boolean);
    const kept = parts.filter((p) => !filler(p));
    if (!kept.length) continue;
    const line = kept.length === parts.length ? text : kept.join(', ');
    if (!readable(line) || isName(line)) continue;
    // A dash between words is a plain hyphen on Teder's page, which has no em or en dashes.
    return cutAtWord(line.replace(/\s*[–—]\s*/g, ' - '));
  }
  return null;
}
