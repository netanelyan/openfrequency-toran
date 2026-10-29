import { heWord, termGroups } from '../core/hebrew.ts';
import { claimEvidence, claimViolation, type ClaimEvidence } from './claims.ts';

// The reply guard: a deterministic filter on every reply, after the model and before
// the customer. Ported from tiyul-plus's priceGuard.ts, whose rule it keeps: when the
// model ignores a rule, don't phrase the rule harder; move it to where it is not a
// choice.
//
// THE ALLOWLIST. A price, a percentage, an offer's number and a delivery time come from
// a tool result in this conversation, never from the customer's words: a customer who
// writes "99 ₪" or "50%" first, then steers the model into repeating it, must not get
// the reply past the guard (the audit's PRA-AI-001: "כן, המעיל עולה 99 ₪." passed when
// the customer had written 99). The customer's numbers still pass where they are not
// money: a quantity, a size, an order number, and a budget they set ("עד 150 ₪").
// Numbers compare by value, so the catalogue's "99.00" allows "99", and "100" for a
// 99.90 product is an invented price, cut. A price is also held to its product: a
// sentence that names a product the tools listed ("המעיל עולה 99 ₪") passes only with a
// number from that product's own lines (or from a passage that is no product's, such as
// the shipping page), so the hat's 99 ₪ does not price the coat.
//
// THE CATEGORIES, checked sentence by sentence:
//   price      a number with ₪/ש"ח/$ or a price word, not from a tool, or not its product's
//   stock      "only 3 left", "in stock", "sold out" with no stock data in any tool result
//   delivery   a delivery time or shipping cost not from a tool
//   promise    any discount, coupon, credit, refund, sale, free or gift word: cut unless
//              the store's own passages (get_policy) use the same word (a product's sale
//              price backs "sale", a product's name backs its own words: "סט מתנה"), never
//              with a number the tools did not give, and a percentage beside it only as the
//              passages give it. A list of offer verbs is not the test: "יש לך 50% הנחה"
//              offers without one. A question with no number promises nothing.
//   superlative "the cheapest", "the best price": always cut, nothing backs them
// A cut sentence is replaced by one honest line, once per category per reply (later
// cuts in the same category are dropped), and a cut in price/stock/delivery/promise
// sets needsHandoff: unknown means escalate. A sentence ending in ":" that is cut takes
// the list after it with it (tiyul-plus's colon continuation).
//
// THE CLAIMS (claims.ts): a sentence that passes all of the above may still state a fact
// with no number in it ("returns are free", "we ship to Eilat", "it's cotton"). Its key
// terms must be in the tool results too, or it is cut as "claim", and hands off.
//
// Also from the voice rules: no em or en dashes reach the customer.

// claim: what kind of fact a "claim" cut was (claims.ts); borderline: the tools mention it, not in a way code confirms.
export type Redaction = { rule: string; sentence: string; claim?: string; borderline?: boolean };
export type GuardResult = { text: string; redactions: Redaction[]; needsHandoff: boolean; handoffReason: string | null };
// numbers: every number a tool or the customer gave; toolNumbers: the tools' alone (what money, a percentage, an offer
// and a delivery time may use); policyNumbers: the store's own passages' (a percentage beside a discount); products: each
// product a tool listed, its name's words and its numbers; otherNumbers: the tools' numbers that are no product's (a
// policy, a plan, an order); promiseWords: the promise concepts (PROMISE_CONCEPTS) the store's passages back.
export type ProductBlock = { terms: Set<string>; numbers: Set<string> };
export type Allow = { numbers: Set<string>; toolNumbers: Set<string>; policyNumbers: Set<string>; products: ProductBlock[]; otherNumbers: Set<string>; customerNumbers: Set<string>; stockKnown: boolean; promiseWords: Set<string>; relativeTimes: boolean; claims?: ClaimEvidence };

const CURRENCY = new RegExp(`₪|ש"ח|ש״ח|${heWord('שקלים', 'שקל', 'אירו', 'דולרים', 'דולר')}|\\bILS\\b|\\bNIS\\b|\\$|€|\\bshekels?\\b`, 'i');
const MONEY_WORD = new RegExp(`${heWord('מחירים', 'מחיר', 'עולים', 'עולה', 'עלות', 'לשלם', 'משלמים', 'תשלום', 'בתוספת')}|\\b(price|prices|costs?|pay)\\b`, 'i');
const PERCENT = /\d\s*%|%\s*\d|אחוז/;
export const STOCK = new RegExp(`${heWord('במלאי', 'מלאי', 'אזלו', 'אזל', 'נגמרו', 'נגמר', 'זמינים', 'זמינה', 'זמין')}|\\b(in stock|out of stock|sold out|available)\\b`, 'i');
const LEFT_N = /(?:נשאר(?:ו|ה)?|נותר(?:ו|ה)?|רק)\s+\d+|\d+\s+(?:יחידות|פריטים|זוגות)\s+(?:אחרונ)|only\s+\d+\s+left/i;
const DELIVERY = new RegExp(`${heWord('משלוחים', 'משלוח', 'אספקה', 'יגיעו', 'יגיע', 'תגיע', 'מגיעים', 'מגיעה', 'מגיע', 'שליח', 'איסוף')}|\\b(shipping|delivery|deliver|arrive|arrives)\\b`, 'i');
const TIME = /\d+\s*(?:-\s*\d+\s*)?(?:ימים|ימי\s*עסקים|יום|שעות|שעה|business\s*days|days|hours)|מחר|השבוע|tomorrow/i;
const RELATIVE = /מחר|השבוע|עוד היום|tomorrow|this week|today/i;
// Each promise a reply can make, by concept, Hebrew and English: a reply's concept must be one the store's passages use.
export const PROMISE_CONCEPTS: Record<string, RegExp> = {
  discount: new RegExp(`${heWord('הנחות', 'הנחה')}|\\bdiscounts?\\b`, 'i'),
  coupon: new RegExp(`${heWord('קופונים', 'קופון', 'שוברים', 'שובר')}|\\b(coupons?|vouchers?|promo codes?)\\b`, 'i'),
  credit: new RegExp(`${heWord('זיכויים', 'זיכוי')}|\\bstore credit\\b`, 'i'),
  refund: new RegExp(`${heWord('החזרים כספיים', 'החזר כספי')}|\\brefunds?\\b`, 'i'),
  sale: new RegExp(`${heWord('מבצעים', 'מבצע')}|\\bon sale\\b`, 'i'),
  free: new RegExp(`${heWord('חינם')}|\\b(free shipping|for free|free of charge)\\b`, 'i'),
  gift: new RegExp(`${heWord('מתנות', 'מתנה')}|\\bgifts?\\b`, 'i'),
};
/** The promise concepts a text uses. */
export const promiseConcepts = (text: string) => Object.keys(PROMISE_CONCEPTS).filter((k) => PROMISE_CONCEPTS[k].test(text));

// A number a currency or a percent sign is attached to, or that follows a price word: the sentence's money.
const AMOUNT = String.raw`(\d+(?:[.,]\d+)*)`;
const UNIT_AFTER = String.raw`\s*(?:₪|ש"ח|ש״ח|שקלים|שקל|אירו|דולרים|דולר|ILS\b|NIS\b|\$|€|shekels?\b|%|אחוזים|אחוז)`;
const MONEY_AFTER = new RegExp(AMOUNT + UNIT_AFTER, 'gi');
const MONEY_BEFORE = new RegExp(String.raw`(?:₪|\$|€|ILS|NIS)\s*` + AMOUNT, 'gi');
const PRICE_THEN = new RegExp(String.raw`(?:עולה|עולים|עלותו|עלותה|עלות|מחירו|מחירה|המחיר|מחיר|לשלם|costs?|priced at|price is|price:)\s*:?\s*(?:רק\s+|only\s+)?` + AMOUNT, 'gi');
const PERCENT_OF = new RegExp(AMOUNT + String.raw`\s*(?:%|אחוזים|אחוז)`, 'gi');
// A budget the customer set ("עד 150 ₪", "under $50"): their number, echoed, is not a price the reply makes up.
const BUDGET = new RegExp(String.raw`(?:עד|מתחת ל-?|פחות מ-?|תקציב(?: של)?|up to|under|below|less than|budget(?: of)?)\s*(?:₪|\$|€)?\s*` + AMOUNT, 'gi');
const TIME_OF = /(\d+)\s*(?:-\s*(\d+)\s*)?(?:ימים|ימי\s*עסקים|יום|שעות|שעה|business\s*days|days|hours)/gi;

const captured = (re: RegExp, text: string) => [...text.matchAll(re)].flatMap((m) => m.slice(1).filter(Boolean).flatMap((x) => numbersIn(x)));
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
export const stripMeta = (t: string) =>
  t
    .replace(/\[(?:id|variant) \d+\]/g, ' ')
    .replace(/\b\d+ matching products?\b|\(the \d+ closest\)|\b\d+ answered questions\b/g, ' ');

/** A word's forms worth matching a product by: three letters or more, not a number. */
const termsOf = (text: string) => new Set(termGroups(text).flat().filter((t) => t.length >= 3 && !/^\d/.test(t)));

// The store's own passages: get_policy's ("From the store's shipping page ...") and a company's plans (get_plans).
const POLICY_TEXT = /^From the (?:store|company)'s |\nRule: quote prices, VAT, setup fees/;
const PRODUCT_HEAD = /^(?:- )?\[id \d+\]\s*(.+)$/;
const PRODUCT_TAIL = /^(?:\s+\S|Price:|Options:|Link:|Description)/;

/** A tool result's products (a search's lines, get_product's whole answer) and the lines that are no product's. */
function productsOf(text: string): { products: { title: string; text: string }[]; rest: string } {
  const products: { title: string; text: string }[] = [];
  const rest: string[] = [];
  let cur: { title: string; text: string } | null = null;
  for (const line of String(text || '').split('\n')) {
    const head = PRODUCT_HEAD.exec(line.trim());
    if (head) {
      // A search line is "title: price, stock"; get_product's first line is the title alone.
      cur = { title: head[1].split(/:\s/)[0], text: line };
      products.push(cur);
    } else if (cur && PRODUCT_TAIL.test(line) && !/^Rule:/.test(line)) cur.text += `\n${line}`;
    else {
      cur = null;
      rest.push(line);
    }
  }
  return { products, rest: rest.join('\n') };
}

// factTexts: what the app itself holds true and gave the model outside a tool (a company store's "works today" list):
// evidence for a claim, never a source of numbers.
export function buildAllow({ toolTexts, customerTexts, factTexts = [] }: { toolTexts: string[]; customerTexts: string[]; factTexts?: string[] }): Allow {
  const toolNumbers = new Set<string>();
  const policyNumbers = new Set<string>();
  const otherNumbers = new Set<string>();
  const customerNumbers = new Set<string>();
  const products: ProductBlock[] = [];
  const promiseWords = new Set<string>();
  for (const t of toolTexts) {
    const own = stripMeta(t);
    for (const n of numbersIn(own)) toolNumbers.add(n);
    if (POLICY_TEXT.test(t)) {
      for (const n of numbersIn(own)) policyNumbers.add(n);
      for (const c of promiseConcepts(t)) promiseWords.add(c);
    }
    const { products: ps, rest } = productsOf(t);
    for (const p of ps) {
      products.push({ terms: termsOf(p.title), numbers: new Set(numbersIn(stripMeta(p.text))) });
      // A product's own name backs its words ("סט מתנה"); a sale price the tool marks backs "sale". Its description
      // backs nothing: "50% הנחה" in a product's text is the store's marketing, not an offer to this customer.
      for (const c of promiseConcepts(p.title)) promiseWords.add(c);
      if (/\((?:במבצע, )?במקום /.test(p.text)) promiseWords.add('sale');
    }
    for (const n of numbersIn(stripMeta(rest))) otherNumbers.add(n);
  }
  for (const t of customerTexts) for (const n of numbersIn(t)) customerNumbers.add(n);
  const numbers = new Set([...toolNumbers, ...customerNumbers]);
  const tools = toolTexts.join('\n');
  const stockKnown = /במלאי|אזל מהמלאי/.test(tools);
  return { numbers, toolNumbers, policyNumbers, products, otherNumbers, customerNumbers, stockKnown, promiseWords, relativeTimes: RELATIVE.test(tools), claims: claimEvidence({ toolTexts: [...toolTexts, ...factTexts], customerTexts }) };
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

/**
 * The sentence's money (numbers a currency or percent sign is attached to, or that follow a price word), less a budget
 * the customer set, which they may hear back.
 */
function moneyOf(plain: string, allow: Allow): string[] {
  const budget = new Set(captured(BUDGET, plain).filter((n) => allow.customerNumbers.has(n) && !allow.toolNumbers.has(n)));
  return [...new Set([...captured(MONEY_AFTER, plain), ...captured(MONEY_BEFORE, plain), ...captured(PRICE_THEN, plain)])].filter((n) => !budget.has(n));
}

/** A price is its product's: a sentence that names products the tools listed takes its money from their lines, or from no product's. */
function ofItsProduct(plain: string, money: string[], allow: Allow): boolean {
  if (!money.length || !allow.products.length) return true;
  const said = termsOf(plain);
  const named = allow.products.filter((p) => [...p.terms].some((t) => said.has(t)));
  if (!named.length) return true;
  return money.every((n) => named.some((p) => p.numbers.has(n)) || allow.otherNumbers.has(n));
}

/** The rule a sentence breaks, or null. */
export function violation(sentence: string, allow: Allow): string | null {
  const s = sentence;
  if (SUPERLATIVE.test(s)) return 'superlative';
  const plain = s.replace(QUANTITY, ' ');
  // No source at all, neither a tool nor the customer: a number with no business in a checked sentence.
  const bad = numbersIn(plain).filter((n) => !allow.numbers.has(n));
  const money = moneyOf(plain, allow);
  const notTools = money.filter((n) => !allow.toolNumbers.has(n));
  const percents = captured(PERCENT_OF, plain);
  const concepts = promiseConcepts(s);
  if (concepts.length && !(/\?\s*$/.test(s) && !/\d/.test(s))) {
    if (concepts.some((c) => !allow.promiseWords.has(c))) return 'promise';
    if (bad.length || notTools.length) return 'promise';
    if (percents.some((n) => !allow.policyNumbers.has(n))) return 'promise';
  }
  if (PERCENT.test(s) && (bad.length || percents.some((n) => !allow.toolNumbers.has(n)))) return 'promise';
  if (CURRENCY.test(s) || MONEY_WORD.test(s)) {
    if (bad.length || notTools.length) return 'price';
    if (!ofItsProduct(plain, money, allow)) return 'price';
  }
  // No tool ever gives a quantity in stock, only in or out: "only 3 left" is invented, whatever number it uses.
  if (LEFT_N.test(s)) return 'stock';
  if (STOCK.test(s) && !allow.stockKnown) return 'stock';
  if (DELIVERY.test(s) && TIME.test(s)) {
    if (bad.length || captured(TIME_OF, plain).some((n) => !allow.toolNumbers.has(n))) return 'delivery';
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
  claim: 'את זה אני בודק עם החנות, ואחזור אליך כאן.',
};
const REPLACE_EN: Record<string, string> = {
  price: "I'm checking the exact price with the store and will update you here.",
  stock: "I'm checking stock with the store and will update you here.",
  delivery: "I'm checking delivery times with the store and will update you here.",
  promise: 'Discounts, refunds and exceptions are approved by the store itself. I passed your request on, and they will get back to you here.',
  superlative: '',
  claim: "I'm checking this with the store and will update you here.",
};
const HANDOFF_REASON: Record<string, string> = { price: 'unknown', stock: 'unknown', delivery: 'unknown', promise: 'discount', claim: 'unknown' };
// A company store (our own support, src/company.ts) is not a store: the honest line says someone from us answers.
const REPLACE_COMPANY: Record<string, string> = {
  price: 'את המחיר המדויק אני בודק, ומישהו מאיתנו יחזור אליך כאן.',
  stock: 'את זה אני בודק, ומישהו מאיתנו יחזור אליך כאן.',
  delivery: 'את הזמנים אני בודק, ומישהו מאיתנו יחזור אליך כאן.',
  promise: 'הנחה או הסדר מיוחד מאשרים רק אצלנו. העברתי את הבקשה, ויחזרו אליך כאן.',
  superlative: '',
  claim: 'את זה אני בודק, ומישהו מאיתנו יחזור אליך כאן.',
};
const REPLACE_COMPANY_EN: Record<string, string> = {
  price: "I'm checking the exact price, and someone from our team will get back to you here.",
  stock: "I'm checking this, and someone from our team will get back to you here.",
  delivery: "I'm checking the timing, and someone from our team will get back to you here.",
  promise: 'Discounts and exceptions are approved by our team. I passed your request on, and they will get back to you here.',
  superlative: '',
  claim: "I'm checking this, and someone from our team will get back to you here.",
};
/** The honest line when nothing is left to say, for a store or for a company. */
export const checkingLine = (english: boolean, company = false) =>
  company ? (english ? "I'm checking this, and someone from our team will get back to you here." : 'את זה אני בודק, ומישהו מאיתנו יחזור אליך כאן.')
    : english ? "I'm checking this with the store and will update you here." : 'את זה אני בודק עם החנות, ואחזור אליך כאן.';

/** The voice rules' punctuation: no em or en dashes as breaks. */
// A dash between two numbers is a range ("1–3 ימי עסקים"), kept as a plain hyphen; anywhere else it is a sentence
// break the voice guide does not allow, and becomes a comma.
export const undash = (t: string) => t.replace(/(\d)\s*[—–]\s*(\d)/g, '$1-$2').replace(/\s*[—–]\s*/g, ', ').replace(/,\s*,/g, ',');

// verified: sentences the claim check's second opinion (claims.ts, TORAN_GUARD_LLM) found backed; the lexical rules
// still apply to them.
export function guardReply(text: string, allow: Allow, { company = false, verified }: { company?: boolean; verified?: Set<string> } = {}): GuardResult {
  const english = !/[א-ת]/.test(text) && /[a-z]/i.test(text);
  const lines = company ? (english ? REPLACE_COMPANY_EN : REPLACE_COMPANY) : english ? REPLACE_EN : REPLACE;
  const out: string[] = [];
  const redactions: Redaction[] = [];
  const done = new Set<string>();
  let dropContinuation = false;
  let handoffReason: string | null = null;
  let prev = '';
  for (const sentence of splitSentences(text)) {
    const trimmed = sentence.trim();
    const before = prev;
    if (trimmed) prev = trimmed;
    if (dropContinuation) {
      if (/^([-•*]|\d+[.)])\s/.test(trimmed) || !trimmed) {
        redactions.push({ rule: 'continuation', sentence: trimmed });
        continue;
      }
      dropContinuation = false;
    }
    const lexical = trimmed ? violation(trimmed, allow) : null;
    const claim = !lexical && trimmed && allow.claims && !verified?.has(trimmed) ? claimViolation(trimmed, allow.claims, before) : null;
    const rule = lexical || (claim ? 'claim' : null);
    if (!rule) {
      out.push(sentence);
      continue;
    }
    redactions.push(claim ? { rule, sentence: trimmed, claim: claim.kind, borderline: claim.borderline } : { rule, sentence: trimmed });
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
