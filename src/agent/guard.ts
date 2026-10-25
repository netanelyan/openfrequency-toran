import { heWord } from '../core/hebrew.ts';

// The reply guard: a deterministic filter on every reply, after the model and before
// the customer. Ported from tiyul-plus's priceGuard.ts, whose rule it keeps: when the
// model ignores a rule, don't phrase the rule harder; move it to where it is not a
// choice.
//
// THE ALLOWLIST. A number may appear next to a price, a stock level, a delivery time,
// a percentage or an offer only if it came from a tool result in this conversation or
// from the customer's own words. (tiyul-plus allowed only the user's numbers: right for
// an app that holds no prices, wrong for a store, whose prices are in its tool results.)
// Numbers compare by value, so the catalogue's "99.00" allows "99", and "100" for a
// 99.90 product is an invented price, cut.
//
// THE CATEGORIES, checked sentence by sentence:
//   price      a number with ₪/ש"ח/$ or a price word, not from a tool
//   stock      "only 3 left", "in stock", "sold out" with no stock data in any tool result
//   delivery   a delivery time or shipping cost not from a tool
//   promise    offering a discount, coupon, refund, credit or free shipping: always cut
//              unless the store's policy (a tool result) says it, and never with a
//              number the tools did not give
//   superlative "the cheapest", "the best price": always cut, nothing backs them
// A cut sentence is replaced by one honest line, once per category per reply (later
// cuts in the same category are dropped), and a cut in price/stock/delivery/promise
// sets needsHandoff: unknown means escalate. A sentence ending in ":" that is cut takes
// the list after it with it (tiyul-plus's colon continuation).
//
// Also from the voice rules: no em or en dashes reach the customer.

export type Redaction = { rule: string; sentence: string };
export type GuardResult = { text: string; redactions: Redaction[]; needsHandoff: boolean; handoffReason: string | null };
export type Allow = { numbers: Set<string>; stockKnown: boolean; promiseWords: Set<string>; relativeTimes: boolean };

const CURRENCY = new RegExp(`₪|ש"ח|ש״ח|${heWord('שקלים', 'שקל', 'אירו', 'דולרים', 'דולר')}|\\bILS\\b|\\bNIS\\b|\\$|€|\\bshekels?\\b`, 'i');
const MONEY_WORD = new RegExp(`${heWord('מחירים', 'מחיר', 'עולים', 'עולה', 'עלות', 'לשלם', 'משלמים', 'תשלום', 'בתוספת')}|\\b(price|prices|costs?|pay)\\b`, 'i');
const PERCENT = /\d\s*%|%\s*\d|אחוז/;
const STOCK = new RegExp(`${heWord('במלאי', 'מלאי', 'אזלו', 'אזל', 'נגמרו', 'נגמר', 'זמינים', 'זמינה', 'זמין')}|\\b(in stock|out of stock|sold out|available)\\b`, 'i');
const LEFT_N = /(?:נשאר(?:ו|ה)?|נותר(?:ו|ה)?|רק)\s+\d+|\d+\s+(?:יחידות|פריטים|זוגות)\s+(?:אחרונ)|only\s+\d+\s+left/i;
const DELIVERY = new RegExp(`${heWord('משלוחים', 'משלוח', 'אספקה', 'יגיעו', 'יגיע', 'תגיע', 'מגיעים', 'מגיעה', 'מגיע', 'שליח', 'איסוף')}|\\b(shipping|delivery|deliver|arrive|arrives)\\b`, 'i');
const TIME = /\d+\s*(?:-\s*\d+\s*)?(?:ימים|ימי\s*עסקים|יום|שעות|שעה|business\s*days|days|hours)|מחר|השבוע|tomorrow/i;
const RELATIVE = /מחר|השבוע|עוד היום|tomorrow|this week|today/i;
const PROMISE = new RegExp(`${heWord('הנחות', 'הנחה', 'קופונים', 'קופון', 'זיכוי', 'החזר כספי', 'מבצע', 'חינם', 'מתנה')}|\\b(discount|coupon|refund|voucher|free shipping|for free|gift)\\b`, 'i');
const OFFER = new RegExp(`${heWord('אתן', 'נותן', 'נותנת', 'אוכל לתת', 'אסדר', 'תקבלו', 'תקבלי', 'תקבל', 'מגיע לך', 'מגיע לכם', 'אעשה לך', 'אכין לך', 'נעשה לך')}|\\b(i can give|i'll give|i will give|you'll get|you will get|i can offer|we can offer)\\b`, 'i');
const SUPERLATIVE = new RegExp(`${heWord('הכי זול', 'הכי זולה', 'הזול ביותר', 'הזולה ביותר', 'המחיר הכי טוב', 'המחיר הטוב ביותר', 'הכי משתלם', 'הכי משתלמת')}|\\b(cheapest|best price|lowest price)\\b`, 'i');

const NUM = /\d+(?:[.,]\d+)*/g;

/** Every number in a text, by value ("1,290.00" -> "1290", "99.90" -> "99.9"); digits inside URLs are not numbers. */
export function numbersIn(text: string): string[] {
  const t = String(text || '').replace(/https?:\/\/\S+/g, ' ');
  const out: string[] = [];
  for (const m of t.matchAll(NUM)) {
    const raw = m[0];
    const v = Number(/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(raw) ? raw.replace(/,/g, '') : raw.replace(/,/g, '.'));
    if (Number.isFinite(v)) out.push(String(v));
  }
  return out;
}

/**
 * The tools' own bookkeeping (how many results came back, ids) is not a fact a customer may be told: its numbers
 * are not allowed. A product's number of options is a fact ("in 3 sizes"), and stays.
 */
const stripMeta = (t: string) =>
  t
    .replace(/\[(?:id|variant) \d+\]/g, ' ')
    .replace(/\b\d+ matching products?\b|\(the \d+ closest\)|\b\d+ answered questions\b/g, ' ');

export function buildAllow({ toolTexts, customerTexts }: { toolTexts: string[]; customerTexts: string[] }): Allow {
  const numbers = new Set<string>();
  for (const t of [...toolTexts.map(stripMeta), ...customerTexts]) for (const n of numbersIn(t)) numbers.add(n);
  const tools = toolTexts.join('\n');
  const stockKnown = /במלאי|אזל מהמלאי/.test(tools);
  const promiseWords = new Set<string>();
  for (const w of ['הנחה', 'קופון', 'זיכוי', 'החזר', 'מבצע', 'חינם', 'מתנה', 'refund', 'discount', 'free']) if (tools.includes(w)) promiseWords.add(w);
  return { numbers, stockKnown, promiseWords, relativeTimes: RELATIVE.test(tools) };
}

/** Sentence ends: . ! ? : or a line break, followed by space or the end, outside parentheses, so "9:00" and "19.90" stay whole. */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  let depth = 0;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    cur += ch;
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    const next = s[i + 1];
    const end = ch === '\n' || (depth === 0 && /[.!?:]/.test(ch) && (next === undefined || /\s/.test(next)));
    if (end) {
      out.push(cur);
      cur = '';
    }
  }
  if (cur) out.push(cur);
  return out;
}

// A number attached to a unit that is not money is a quantity, not a price: "1 month", "a 2-pack", "350 ml", "size 40".
// The eval caught "the 1 month pack is 249 ₪" cut whole, because the tool had said "חודש" and the model wrote "1 month".
// Days and hours are not here: a delivery time stays checked.
const QUANTITY = /\d+(?:[.,]\d+)?\s*-?\s*(?:months?|weeks?|packs?|pairs?|pcs|pieces|units|items|ml|cm|mm|kg|g|gr|l|liters?|inch(?:es)?|חודש(?:ים)?|חודשי|שבוע(?:ות)?|זוג(?:ות)?|יחידות|פריטים|מארז|ס"מ|ס״מ|מ"מ|מ"ל|מ״ל|ליטר|גרם|ק"ג|ק״ג|אינץ'?)(?![\p{L}])|(?:size|מידה)\s*\d+/giu;

const unknownNumbers = (sentence: string, allow: Allow) => numbersIn(sentence.replace(QUANTITY, ' ')).filter((n) => !allow.numbers.has(n));

/** The rule a sentence breaks, or null. */
export function violation(sentence: string, allow: Allow): string | null {
  const s = sentence;
  if (SUPERLATIVE.test(s)) return 'superlative';
  const bad = unknownNumbers(s, allow);
  const promise = PROMISE.test(s);
  if (promise) {
    if (OFFER.test(s) && ![...allow.promiseWords].some((w) => s.includes(w))) return 'promise';
    if (bad.length && (PERCENT.test(s) || CURRENCY.test(s) || /\d/.test(s))) return 'promise';
  }
  if (bad.length && PERCENT.test(s)) return 'promise';
  if (bad.length && (CURRENCY.test(s) || MONEY_WORD.test(s))) return 'price';
  // No tool ever gives a quantity in stock, only in or out: "only 3 left" is invented, whatever number it uses.
  if (LEFT_N.test(s)) return 'stock';
  if (STOCK.test(s) && !allow.stockKnown) return 'stock';
  if (DELIVERY.test(s) && TIME.test(s)) {
    if (bad.length) return 'delivery';
    if (RELATIVE.test(s) && !allow.relativeTimes) return 'delivery';
  }
  return null;
}

const REPLACE: Record<string, string> = {
  price: 'את המחיר המדויק אני בודק עם החנות, ואחזור אליך כאן.',
  stock: 'מה יש במלאי אני בודק עם החנות, ואחזור אליך כאן.',
  delivery: 'כמה זמן לוקח המשלוח אני בודק עם החנות, ואחזור אליך כאן.',
  promise: 'הנחה או החזר מאשרים רק בחנות. העברתי להם את הבקשה, ויחזרו אליך כאן.',
  superlative: '',
};
const REPLACE_EN: Record<string, string> = {
  price: "I'm checking the exact price with the store and will update you here.",
  stock: "I'm checking stock with the store and will update you here.",
  delivery: "I'm checking delivery times with the store and will update you here.",
  promise: 'Discounts, refunds and exceptions are approved by the store itself. I passed your request on, and they will get back to you here.',
  superlative: '',
};
const HANDOFF_REASON: Record<string, string> = { price: 'unknown', stock: 'unknown', delivery: 'unknown', promise: 'discount' };
// A company store (our own support, src/company.ts) is not a store: the honest line says someone from us answers.
const REPLACE_COMPANY: Record<string, string> = {
  price: 'את המחיר המדויק אני בודק, ומישהו מאיתנו יחזור אליך כאן.',
  stock: 'את זה אני בודק, ומישהו מאיתנו יחזור אליך כאן.',
  delivery: 'את הזמנים אני בודק, ומישהו מאיתנו יחזור אליך כאן.',
  promise: 'הנחה או הסדר מיוחד מאשרים רק אצלנו. העברתי את הבקשה, ויחזרו אליך כאן.',
  superlative: '',
};
const REPLACE_COMPANY_EN: Record<string, string> = {
  price: "I'm checking the exact price, and someone from our team will get back to you here.",
  stock: "I'm checking this, and someone from our team will get back to you here.",
  delivery: "I'm checking the timing, and someone from our team will get back to you here.",
  promise: 'Discounts and exceptions are approved by our team. I passed your request on, and they will get back to you here.',
  superlative: '',
};
/** The honest line when nothing is left to say, for a store or for a company. */
export const checkingLine = (english: boolean, company = false) =>
  company ? (english ? "I'm checking this, and someone from our team will get back to you here." : 'את זה אני בודק, ומישהו מאיתנו יחזור אליך כאן.')
    : english ? "I'm checking this with the store and will update you here." : 'את זה אני בודק עם החנות, ואחזור אליך כאן.';

/** The voice rules' punctuation: no em or en dashes as breaks. */
// A dash between two numbers is a range ("1–3 ימי עסקים"), kept as a plain hyphen; anywhere else it is a sentence
// break the voice guide does not allow, and becomes a comma.
export const undash = (t: string) => t.replace(/(\d)\s*[—–]\s*(\d)/g, '$1-$2').replace(/\s*[—–]\s*/g, ', ').replace(/,\s*,/g, ',');

export function guardReply(text: string, allow: Allow, { company = false }: { company?: boolean } = {}): GuardResult {
  const english = !/[א-ת]/.test(text) && /[a-z]/i.test(text);
  const lines = company ? (english ? REPLACE_COMPANY_EN : REPLACE_COMPANY) : english ? REPLACE_EN : REPLACE;
  const out: string[] = [];
  const redactions: Redaction[] = [];
  const done = new Set<string>();
  let dropContinuation = false;
  let handoffReason: string | null = null;
  for (const sentence of splitSentences(text)) {
    const trimmed = sentence.trim();
    if (dropContinuation) {
      if (/^([-•*]|\d+[.)])\s/.test(trimmed) || !trimmed) {
        redactions.push({ rule: 'continuation', sentence: trimmed });
        continue;
      }
      dropContinuation = false;
    }
    const rule = trimmed ? violation(trimmed, allow) : null;
    if (!rule) {
      out.push(sentence);
      continue;
    }
    redactions.push({ rule, sentence: trimmed });
    if (HANDOFF_REASON[rule]) handoffReason ??= HANDOFF_REASON[rule];
    if (trimmed.endsWith(':')) dropContinuation = true;
    // An introduction ending in a colon ("there are two options:") introduced what was just cut: it goes too.
    if (out.length && out[out.length - 1].trim().endsWith(':')) redactions.push({ rule: 'continuation', sentence: out.pop()!.trim() });
    if (done.has(rule)) continue;
    done.add(rule);
    const lead = /^\s*/.exec(sentence)?.[0] || '';
    if (lines[rule]) out.push(`${lead}${lines[rule]}${sentence.endsWith('\n') ? '\n' : ' '}`);
  }
  let result = undash(out.join('').replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim());
  if (!result) result = checkingLine(english, company);
  return { text: result, redactions, needsHandoff: Boolean(handoffReason), handoffReason };
}
