// Hebrew text helpers: detection, normalisation for search, and word boundaries for
// matchers.
//
// heWord() is ported from tiyul-plus (src/lib/hebrewMatch.ts), where every rule in it
// came from a live false positive in the reply guard: `\b` only knows ASCII, and every
// short Hebrew token is also a substring of some unrelated word (euro in "Europe",
// shekel in "weight", cost in "degrees", sold-out in "Basel"). The boundary is: no
// Hebrew letter after the token, and before it at most two prefix letters (b, h, v, k,
// l, sh) with no Hebrew letter in front of them. `m` ("from") is deliberately not a
// prefix: it made "weight" read as "from-shekel".

export const HE_LETTER = 'א-ת';
const HE_PREFIX = '[בהוכלש]';

/** Alternatives wrapped in Hebrew-aware boundaries, as regex source. Order them longest first. */
export function heWord(...alts: string[]): string {
  return `(?<![${HE_LETTER}])${HE_PREFIX}{0,2}(?:${alts.join('|')})(?![${HE_LETTER}])`;
}

const HE_RE = /[א-ת]/g;
const LETTER_RE = /\p{L}/gu;

/** Hebrew letters as a share of all letters (0..1). Niqqud and punctuation do not count. */
export function hebrewRatio(text: string): number {
  const s = String(text || '');
  const letters = (s.match(LETTER_RE) || []).length;
  if (!letters) return 0;
  return (s.match(HE_RE) || []).length / letters;
}

export const hasHebrew = (text: string) => /[א-ת]/.test(String(text || ''));

const FINALS: Record<string, string> = { 'ך': 'כ', 'ם': 'מ', 'ן': 'נ', 'ף': 'פ', 'ץ': 'צ' };

/**
 * Text for matching, not for display: lower case, no niqqud or cantillation, final
 * letters folded to their regular forms, geresh and quote marks dropped (so מע"מ and
 * מעמ meet), punctuation to spaces, whitespace collapsed.
 */
export function normalize(text: string): string {
  return String(text || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[֑-ׇ]/g, '')
    .replace(/[ךםןףץ]/g, (c) => FINALS[c])
    .replace(/["'״׳`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * The words of a query for product search: normalised, with common Hebrew prefixes
 * (ה, ו, ב, ל, מ, ש, כ) also tried off the front of words long enough to carry one.
 */
export function searchTerms(text: string): string[] {
  const words = normalize(text).split(' ').filter((w) => w.length >= 2);
  const out = new Set<string>();
  for (const w of words) {
    if (STOP.has(w)) continue;
    out.add(w);
    if (/^[א-ת]/.test(w) && w.length >= 4 && /^[הובלמשכ]/.test(w)) out.add(w.slice(1));
    if (/^[א-ת]/.test(w) && w.length >= 5 && /^(וה|שה|בה|לה|מה|וב|ול|וש)/.test(w)) out.add(w.slice(2));
  }
  return [...out];
}

/**
 * The query's words, each with its prefix-stripped forms as one group: a match on any
 * form counts the word once ("הסטודיו" and "סטודיו" are one word, not two).
 */
export function termGroups(text: string): string[][] {
  const groups: string[][] = [];
  for (const w of normalize(text).split(' ').filter((x) => x.length >= 2)) {
    if (STOP.has(w)) continue;
    const g = new Set([w]);
    if (/^[א-ת]/.test(w) && w.length >= 4 && /^[הובלמשכ]/.test(w)) g.add(w.slice(1));
    if (/^[א-ת]/.test(w) && w.length >= 5 && /^(וה|שה|בה|לה|מה|וב|ול|וש)/.test(w)) g.add(w.slice(2));
    if (!groups.some((x) => x[0] === w)) groups.push([...g]);
  }
  return groups;
}

// Words that carry no product meaning in a customer's question.
const STOP = new Set(
  normalize(
    'יש לכם את של עם על זה זו זאת אני רוצה רציתי מחפש מחפשת כמה עולה עולים מחיר האם אפשר בבקשה תודה היי שלום מה איך גם או אבל כי לי לו לה הם הן אתם אתן יש אין כן לא עוד משהו איזה איזו אילו מי איפה מתי למה כל רק כבר עכשיו the a an of for and or is are do you have any with in on to',
  ).split(' '),
);

/** One line for a log: no control characters (a newline in a value forges a second log entry), capped. Ported from tiyul-plus logSafe.ts. */
export function cleanLine(value: unknown, max = 300): string {
  const text = typeof value === 'string' ? value : String(value ?? '');
  const flat = Array.from(text)
    .map((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f ? ' ' : ch;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Tokens in a string, approximately (Hebrew is about 2.2 characters a token, Latin 3.6). From Teder. */
export function estimateTokens(text: string): number {
  const s = String(text || '');
  const he = (s.match(/[֐-׿]/g) || []).length;
  return Math.ceil(he / 2.2 + (s.length - he) / 3.6);
}
