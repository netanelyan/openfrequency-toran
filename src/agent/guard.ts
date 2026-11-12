import { hebrewRatio, heWord, normalize, termGroups } from '../core/hebrew.ts';
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
// the list after it with it (tiyul-plus's colon continuation). The reply says the
// hand-off once (handOverOnce): the model's sentence that only repeats it goes, and a
// second line says only what it is not sure of.
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
// policy, a plan, an order); promiseWords: the promise concepts (PROMISE_CONCEPTS) the store's passages back; hosts: the
// sites a link may point to (the tools' links and the store's own address, ownLinks).
export type ProductBlock = { terms: Set<string>; numbers: Set<string> };
export type Allow = { hosts: Set<string>; numbers: Set<string>; toolNumbers: Set<string>; policyNumbers: Set<string>; products: ProductBlock[]; otherNumbers: Set<string>; customerNumbers: Set<string>; stockKnown: boolean; promiseWords: Set<string>; relativeTimes: boolean; claims?: ClaimEvidence };

const CURRENCY = new RegExp(`₪|ש"ח|ש״ח|${heWord('שקלים', 'שקל', 'אירו', 'דולרים', 'דולר')}|\\bILS\\b|\\bNIS\\b|\\$|€|\\bshekels?\\b`, 'i');
const MONEY_WORD = new RegExp(`${heWord('מחירים', 'מחיר', 'עולים', 'עולה', 'עלות', 'לשלם', 'משלמים', 'תשלום', 'בתוספת')}|\\b(price|prices|costs?|pay)\\b`, 'i');
const PERCENT = /\d\s*%|%\s*\d|אחוז/;
export const STOCK = new RegExp(`${heWord('במלאי', 'מלאי', 'אזלו', 'אזל', 'נגמרו', 'נגמר', 'זמינים', 'זמינה', 'זמין')}|\\b(in stock|out of stock|sold out|available)\\b`, 'i');
// An offer to look ("כתבו לי מה ואבדוק מה יש במלאי", "I'll check if it's in stock") says nothing about the stock: the
// stock word inside it is not a claim, and the rest of the sentence is still checked (the owner, 2026-11-11, on such an
// offer cut from a reply to "היי": "why is it red?").
const CHECKS_STOCK = /(?:^|[\s,(])[ושכ]?(?:אבדוק|לבדוק|נבדוק|בודקת|בודקים|בודק|אברר|לברר|נברר)\s+(?:\S+\s+){0,4}?\S*(?:מלאי|זמינ[א-ת]*)|\bcheck(?:ing)?\b(?:\s+\S+){0,4}?\s+(?:in stock|stock|available|availability)/gi;
// Saying it is not sure about the stock ("על המלאי אני לא בטוח", the honest line itself) is no claim about it either: the
// model's own honest line was cut and replaced by the same line, with its last sentence left twice.
const UNSURE_STOCK = /על\s+(?:\S+\s+){0,3}?\S*(?:מלאי|זמינ[א-ת]*)\s+(?:אני\s+)?לא\s+(?:בטוח|בטוחה|יודע|יודעת)|\bnot sure about\b(?:\s+\S+){0,3}?\s+(?:stock|availability)/gi;
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

// A link in a reply (PRA-AI-002): an address with a scheme, or a bare domain ending in a top-level domain people use.
// Its host must be one the tools gave in this conversation, or the store's own: a link only the model or the customer
// wrote is cut and handed off, so a steered reply cannot send a customer to a look-alike payment page.
const LINK = /\bhttps?:\/\/[^\s<>"'()]+|(?<![@\w.-])(?:www\.)?(?:[a-z0-9-]+\.)+(?:co\.il|org\.il|net\.il|ac\.il|gov\.il|com|net|org|il|io|ly|me|co|shop|store|info|biz|app|link|site|online|to|gl)\b(?:\/[^\s<>"'()]*)?/gi;
/** The hosts of every link in a text, lowercased, without www. */
export function hostsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of String(text || '').matchAll(LINK)) {
    const raw = m[0].replace(/[.,;:!?]+$/, '');
    try {
      out.push(new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase().replace(/^www\./, ''));
    } catch {
      /* not an address after all */
    }
  }
  return out;
}
/** A link's host is allowed when it is one of the allowed hosts or under one (shop.example under example). */
const linkAllowed = (host: string, hosts: Set<string>) => [...hosts].some((h) => host === h || host.endsWith(`.${h}`));

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
export function buildAllow({ toolTexts, customerTexts, factTexts = [], ownLinks = [] }: { toolTexts: string[]; customerTexts: string[]; factTexts?: string[]; ownLinks?: string[] }): Allow {
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
      if (/\((?:במבצע, )?במקום |\(חלק מהאפשרויות במבצע\)/.test(p.text)) promiseWords.add('sale');
    }
    for (const n of numbersIn(stripMeta(rest))) otherNumbers.add(n);
  }
  for (const t of customerTexts) for (const n of numbersIn(t)) customerNumbers.add(n);
  const numbers = new Set([...toolNumbers, ...customerNumbers]);
  const tools = toolTexts.join('\n');
  const stockKnown = /במלאי|אזל מהמלאי/.test(tools);
  const hosts = new Set([...toolTexts, ...factTexts, ...ownLinks].flatMap(hostsIn));
  return { hosts, numbers, toolNumbers, policyNumbers, products, otherNumbers, customerNumbers, stockKnown, promiseWords, relativeTimes: RELATIVE.test(tools), claims: claimEvidence({ toolTexts: [...toolTexts, ...factTexts], customerTexts }) };
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

/**
 * A price is its product's: a sentence that names products the tools listed takes its money from their lines, or from no
 * product's. `label` is the name a line put before a colon ("Grow - חודש: 99 ₪"), which the sentences split from its
 * price: the line names the product, so its price is held to it (the owner, 2026-11-12, on a demo where a hat's 99 ₪
 * priced Grow that way: "something with the grow is not it").
 */
function ofItsProduct(plain: string, money: string[], allow: Allow, label = ''): boolean {
  if (!money.length || !allow.products.length) return true;
  const said = termsOf(label ? `${label} ${plain}` : plain);
  const named = allow.products.filter((p) => [...p.terms].some((t) => said.has(t)));
  if (!named.length) return true;
  return money.every((n) => named.some((p) => p.numbers.has(n)) || allow.otherNumbers.has(n));
}

/** The rule a sentence breaks, or null. `label`: what the same line said before a colon, when the sentence follows one. */
export function violation(sentence: string, allow: Allow, label = ''): string | null {
  const s = sentence;
  if (hostsIn(s).some((h) => !linkAllowed(h, allow.hosts))) return 'link';
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
    if (!ofItsProduct(plain, money, allow, label)) return 'price';
  }
  // No tool ever gives a quantity in stock, only in or out: "only 3 left" is invented, whatever number it uses.
  if (LEFT_N.test(s)) return 'stock';
  if (STOCK.test(s.replace(CHECKS_STOCK, ' ').replace(UNSURE_STOCK, ' ')) && !allow.stockKnown) return 'stock';
  if (DELIVERY.test(s) && TIME.test(s)) {
    if (bad.length || captured(TIME_OF, plain).some((n) => !allow.toolNumbers.has(n))) return 'delivery';
    if (RELATIVE.test(s) && !allow.relativeTimes) return 'delivery';
  }
  return null;
}

// The honest lines say what a person would: I'm not sure, and a person from the store will answer here. Never why the
// bot does not know (what the site says or not, what was written, a list): the owner, 2026-11-01, on "על פורמט שאין
// בתדר לא כתבנו כלום": "makes it feel bizarre. maybe אני לא יודע / אני לא בטוח / ... אני מעביר אותך לנציג".
const passed = (who: string) => `אז העברתי את השאלה ${who}. הוא יחזור אליך כאן.`;
const passedEn = (who: string) => `so I've passed your question to ${who}. They'll reply here.`;
const honest = (who: string, whoEn: string, promise: string, promiseEn: string) => ({
  he: {
    price: `על המחיר המדויק אני לא בטוח, ${passed(who)}`,
    stock: `על המלאי אני לא בטוח, ${passed(who)}`,
    delivery: `על זמני המשלוח אני לא בטוח, ${passed(who)}`,
    promise,
    superlative: '',
    claim: `על זה אני לא בטוח, ${passed(who)}`,
    link: `על הקישור אני לא בטוח, ${passed(who)}`,
  } as Record<string, string>,
  en: {
    price: `I'm not sure about the exact price, ${passedEn(whoEn)}`,
    stock: `I'm not sure about stock, ${passedEn(whoEn)}`,
    delivery: `I'm not sure about delivery times, ${passedEn(whoEn)}`,
    promise: promiseEn,
    superlative: '',
    claim: `I'm not sure about that, ${passedEn(whoEn)}`,
    link: `I'm not sure about that link, ${passedEn(whoEn)}`,
  } as Record<string, string>,
});
const STORE_LINES = honest('לנציג מהחנות', 'someone from the store', 'הנחה או החזר מאשר רק נציג מהחנות, אז העברתי לו את הבקשה. הוא יחזור אליך כאן.', "Discounts and refunds are approved only by someone from the store, so I've passed your request to them. They'll reply here.");
const HANDOFF_REASON: Record<string, string> = { price: 'unknown', stock: 'unknown', delivery: 'unknown', promise: 'discount', claim: 'unknown', link: 'unknown' };
// A company store (our own support, src/company.ts) is not a store: the person who answers is one of ours.
const COMPANY_LINES = honest('לנציג שלנו', 'someone from our team', 'הנחה או הסדר מיוחד מאשר רק נציג שלנו, אז העברתי לו את הבקשה. הוא יחזור אליך כאן.', "Discounts and special terms are approved only by someone from our team, so I've passed your request to them. They'll reply here.");
// A demo on our number (loop.ts isDemoTurn) passes nothing on: the store's owner, or someone they sent, is trying
// Toran, and nobody will answer them there (the audit of 2026-11-12, P1-22: the demo said "העברתי את השאלה לנציג
// מהחנות. הוא יחזור אליך כאן."). Its lines say what would happen with a real customer instead.
const REAL = 'אצל לקוח אמיתי השאלה הייתה עוברת עכשיו אליכם, ואתם עונים לו.';
const REAL_EN = "With a real customer, this question would now go to you, and you'd answer it.";
const DEMO_LINES = {
  he: {
    price: `על המחיר המדויק אני לא בטוח. ${REAL}`,
    stock: `על המלאי אני לא בטוח. ${REAL}`,
    delivery: `על זמני המשלוח אני לא בטוח. ${REAL}`,
    promise: 'הנחה או החזר מאשרים רק בחנות. אצל לקוח אמיתי הבקשה הייתה עוברת עכשיו אליכם, ואתם עונים לו.',
    superlative: '',
    claim: `על זה אני לא בטוח. ${REAL}`,
    link: `על הקישור אני לא בטוח. ${REAL}`,
  } as Record<string, string>,
  en: {
    price: `I'm not sure about the exact price. ${REAL_EN}`,
    stock: `I'm not sure about stock. ${REAL_EN}`,
    delivery: `I'm not sure about delivery times. ${REAL_EN}`,
    promise: "Discounts and refunds are approved only by the store. With a real customer, this request would now go to you, and you'd answer it.",
    superlative: '',
    claim: `I'm not sure about that. ${REAL_EN}`,
    link: `I'm not sure about that link. ${REAL_EN}`,
  } as Record<string, string>,
};
const linesFor = (company: boolean, demo: boolean) => (company ? COMPANY_LINES : demo ? DEMO_LINES : STORE_LINES);
/** The honest line when nothing is left to say, for a store, for a company, or in a demo. */
export const checkingLine = (english: boolean, company = false, demo = false) => linesFor(company, demo)[english ? 'en' : 'he'].claim;

// When the model gives nothing at all (it failed, ran out of time or rounds, or no call was made: unpaid, past a cap),
// there was no question to be unsure about: a plain "היי" got "על זה אני לא בטוח" (the audit of 2026-11-12, P2-29).
const CANT: Record<'store' | 'company' | 'demo', { he: string; en: string }> = {
  store: { he: 'כרגע אני לא מצליח לענות, אז העברתי את ההודעה לנציג מהחנות. הוא יחזור אליך כאן.', en: "I can't answer right now, so I've passed your message to someone from the store. They'll reply here." },
  company: { he: 'כרגע אני לא מצליח לענות, אז העברתי את ההודעה לנציג שלנו. הוא יחזור אליך כאן.', en: "I can't answer right now, so I've passed your message to someone from our team. They'll reply here." },
  demo: { he: 'כרגע אני לא מצליח לענות. אצל לקוח אמיתי ההודעה הייתה עוברת עכשיו אליכם, ואתם עונים לו.', en: "I can't answer right now. With a real customer, this message would now go to you, and you'd answer it." },
};
/** The line when the model gave no answer at all (loop.ts), for a store, for a company, or in a demo. */
export const cantAnswerLine = (english: boolean, company = false, demo = false) => CANT[company ? 'company' : demo ? 'demo' : 'store'][english ? 'en' : 'he'];

// The model's own habit, from the live lines it is shown, in a demo: "העברתי את השאלה לנציג מהחנות. הוא יחזור אליך כאן."
// A sentence saying someone will reply here goes, a clause saying it was passed on comes off, and the demo's line says
// what would happen with a real customer instead (DEMO_LINES).
const REPLY_HERE = /(?:יחזור|יחזרו|תחזור|נחזור|יענה|יענו)\s+(?:אליך|אלייך|אליכם|לך|לכם)\s+כאן|\b(?:reply|get back to you|answer you)\s+here\b/i;
const PASSED_ON = /,?\s*(?:אז\s+|ולכן\s+)?העברתי\s+(?:את\s+|לו\s+|לה\s+)?[^.?!\n]*|,?\s*(?:so\s+)?I(?:'ve| have)? passed\b[^.?!\n]*/i;
function demoTruth(text: string, english: boolean): string {
  let told = false;
  const out: string[] = [];
  for (const sentence of splitSentences(text)) {
    if (REPLY_HERE.test(sentence)) {
      told = true;
      continue;
    }
    if (PASSED_ON.test(sentence)) {
      told = true;
      const rest = sentence.replace(PASSED_ON, '');
      if (rest.replace(/[\s.!?,]/g, '')) out.push(rest);
      continue;
    }
    out.push(sentence);
  }
  if (!told) return text;
  const real = english ? REAL_EN : REAL;
  const kept = out.join('').replace(/[ \t]{2,}/g, ' ').trim();
  return kept.includes(real) ? kept : `${kept ? `${kept} ` : ''}${real}`;
}

// An offer to send a link, in a reply that already has one: "רוצים שאבדוק איזה צבעים יש, או שאשלח קישור?" above the
// product's own link (the owner, 2026-11-12, on a demo: "asks if they want a url but sends it in the same message. it
// should not ask"). The offer comes off its question ("או שאשלח קישור"), or the question goes when it was only that.
// Hebrew letters are not \w, so no \b beside them.
const LINK_WORD = String.raw`(?:ה)?(?:קישור|לינק)`;
const LINK_OFFER = new RegExp(
  String.raw`(?:ש?אשלח|לשלוח|נשלח)\s+(?:(?:לך|לכם|לכן)\s+)?(?:את\s+)?${LINK_WORD}|(?:רוצים|רוצה|תרצו|תרצה)\s+(?:את\s+)?${LINK_WORD}|\bsend\s+(?:you\s+)?(?:the|a)\s+link\b|\b(?:want|like)\s+(?:the|a)\s+link\b`,
  'i',
);
const OR_LINK_OFFER = new RegExp(String.raw`(?:,\s*|\s+)(?:או|or)\s+[^?]*?(?:קישור|לינק|\blink\b)[^?]*`, 'i');
const HAS_LINK = /https?:\/\//i;
function noLinkOffer(out: string[]) {
  if (!HAS_LINK.test(out.join(''))) return;
  for (let i = out.length - 1; i >= 0; i--) {
    const s = out[i];
    if (!/\?\s*$/.test(s)) continue;
    // The question is what comes after the sentence's own link, when it has one ("https://... רוצים שאשלח קישור?").
    const links = [...s.matchAll(/https?:\/\/\S+/gi)];
    const at = links.length ? links[links.length - 1].index! + links[links.length - 1][0].length : 0;
    const head = s.slice(0, at);
    const ask = s.slice(at);
    if (!LINK_OFFER.test(ask)) continue;
    const kept = ask.replace(OR_LINK_OFFER, '');
    if (kept !== ask && !LINK_OFFER.test(kept) && kept.replace(/[\s?.!,]/g, '')) out[i] = head + kept;
    else if (head.trim()) out[i] = head + (s.endsWith('\n') ? '\n' : '');
    else out.splice(i, 1);
  }
}

/** Nothing left after a quiet cut, and nothing asked: a greeting back ("במה אפשר לעזור?" read as a call centre, P2-29). */
const greeting = (english: boolean, company: boolean) => (english ? (company ? 'Hi, what would you like to ask?' : 'Hi, what are you looking for?') : company ? 'היי, על מה רוצים לשאול?' : 'היי, מה מחפשים?');

/** A reply that already asks how to reach the customer (a phone, an email): the site chat's line below is not added. */
export const ASKS_REACH = /טלפון|מייל|נייד|phone|e-?mail/i;
/**
 * On the site chat, after a handoff (loop.ts): a visitor may close the page before anyone answers, so they are asked how
 * the store can reach them. In the store's address, as the honest lines are (styleReply).
 */
export const reachLine = (english: boolean, plural = false) => (english ? 'You can leave a phone number or an email here, so they can reach you even if this page is closed.' : `אפשר להשאיר כאן טלפון או מייל, כדי שיחזרו ${plural ? 'אליכם' : 'אליך'} גם אם הדף ייסגר.`);

// Whether the customer's own message asked about what a cut sentence was about. Only then does the cut get its honest
// line and the conversation go to the store: a sentence the model added unasked is dropped quietly (the owner,
// 2026-11-09, on a "מה נשמע" answered with "על המלאי אני לא בטוח, אז העברתי את השאלה לנציג": "i did not ask anything
// about that, only asked whats up. fix!").
const SMALL_TALK = /^[\s,.!?]*(?:(?:היי|הי|הייי|שלום|אהלן|הלו|בוקר טוב|ערב טוב|צהריים טובים|לילה טוב|מה נשמע|מה שלומך|מה שלומכם|מה קורה|מה המצב|מה העניינים|תודה רבה|תודה|סבבה|אוקיי|אוקי|יופי|מעולה|hi|hello|hey|thanks|thank you|ok|okay)[\s,.!?]*)+$/i;
const ASKS: Record<string, RegExp> = {
  price: new RegExp(`${CURRENCY.source}|${MONEY_WORD.source}|כמה זה|how much`, 'i'),
  stock: new RegExp(`${STOCK.source}|(?:^|[\\s,])יש(?:\\s+(?:לכם|לך|לכן|עוד|את|במידה|בצבע|בגודל))?(?=[\\s?,.!]|$)|\\b(have|got)\\b`, 'i'),
  delivery: new RegExp(`${DELIVERY.source}|${TIME.source}|מתי|when`, 'i'),
  promise: /הנחה|הנחות|קופון|קוד הנחה|מבצע|החזר|זיכוי|להחזיר|discount|coupon|refund|sale/i,
  link: /קישור|לינק|link|url|כתובת|אתר/i,
};
/** Whether `asked` (the customer's message) asked about a cut sentence's subject; with no message known, it did. */
// What the guard cut, in the owner's words, for the line the owner reads when Toran hands a conversation over (the
// owner, 2026-11-09, on "תורן העביר את זה אליכם: the guard cut stock: מה נשמע": "whats the english part? user wont get
// it"). The rule names stay in the stored record; the owner only ever sees this.
const CUT_HE: Record<string, string> = { price: 'המחיר', stock: 'המלאי', delivery: 'זמן המשלוח', promise: 'הנחה או החזר', link: 'הקישור' };

/** The handoff line for a reply the guard cut: what Toran was not sure of, and what the customer wrote. */
export function cutSummary(rules: string[], asked: string): string {
  const what = [...new Set(rules.filter((r) => r !== 'continuation').map((r) => CUT_HE[r] || 'הפרטים'))];
  return `תורן לא מצא במידע של החנות תשובה בטוחה על ${what.join(' ועל ') || 'הפרטים'}. הלקוח כתב: "${asked}"`;
}

/** What the customer wrote, after a handoff line's reason. */
const wrote = (t: string) => (t.trim() ? ` הלקוח כתב: "${t.trim()}"` : '');

/**
 * The handoff line when a customer's store is past what its model may cost this month, or past the operator's own cap
 * for it (agent/spend.ts): the owner reads that Toran passed the question on, never a cost, a cap or a share (the
 * owner, 2026-11-11, on the 50% stop).
 */
export const passedOnSummary = (asked: string) => `תורן העביר אליכם את השאלה הזו כדי שתענו עליה בעצמכם.${wrote(asked)}`;

// The app's own handoff lines (agent/loop.ts), in Hebrew, and the English ones kept before they were Hebrew, shown in
// Hebrew wherever the owner or the operator reads them (the owner, 2026-11-09, on "the guard cut stock" still showing:
// "still has the guard cut sock text"). Each is the reason, then what the customer wrote.
const OLD: [RegExp, (m: RegExpExecArray) => string][] = [
  [/^the guard cut ([a-z, ]+): ([\s\S]*)$/, (m) => cutSummary(m[1].split(/,\s*/), m[2])],
  [/^Toran is not paid for in this store's workspace: ([\s\S]*)$/, (m) => `תורן לא ענה, כי החשבון של החנות לא שולם.${wrote(m[1])}`],
  [/^the (?:store's|monthly) spend cap \(\$[\d.]+\) is reached: ([\s\S]*)$/, (m) => `תורן לא ענה, כי הגיע לתקרת ההוצאה.${wrote(m[1])}`],
  [/^no answer within \d+ seconds: ([\s\S]*)$/, (m) => `תורן לא הספיק לענות בזמן.${wrote(m[1])}`],
  [/^the model declined to answer$/, () => 'תורן לא ענה על ההודעה הזו.'],
  [/^the agent failed: [\s\S]*$/, () => 'משהו אצלנו לא עבד, ותורן לא ענה.'],
  [/^no answer after \d+ rounds: ([\s\S]*)$/, (m) => `תורן לא מצא תשובה.${wrote(m[1])}`],
];

/** A handoff line as the owner reads it: in Hebrew, whatever it was kept as. */
export function summaryHe(summary: string): string {
  for (const [re, he] of OLD) {
    const m = re.exec(summary || '');
    if (m) return he(m);
  }
  return summary;
}

/** Why Toran handed a conversation over, in Hebrew (the handoff tool's reasons, and the app's own). */
export const REASON_HE: Record<string, string> = {
  unknown: 'לא מצא תשובה', refund: 'החזר', discount: 'הנחה', complaint: 'תלונה', order: 'הזמנה', human_requested: 'ביקשו נציג',
  other: 'אחר', demo: 'דמו', join: 'הצטרפות', account: 'חשבון', billing: 'תשלום', cancel: 'ביטול', limit: 'עומס', price: 'מחיר',
  stock: 'מלאי', delivery: 'משלוח', promise: 'הבטחה', claim: 'עובדה', link: 'קישור', superlative: 'הגזמה',
};

export function askedAbout(rule: string, asked: string | undefined): boolean {
  if (asked == null) return true;
  const text = asked.trim();
  if (!text || SMALL_TALK.test(text)) return false;
  return rule in ASKS ? ASKS[rule].test(text) : true;
}

// ---- the hand-off said once (docs/models.md, q11: "...הוא יחזור אליך כאן. הוא יחזור אליכם כאן.")
//
// An honest line above is what it is not sure of, then its tail: the question was passed on, and who answers here. When
// a line with its tail is put in, a sentence of the model's that says only that goes, before the cut or after it; one
// that says more stays, and then no line says the tail again. A later line in the same reply says only what it is not
// sure of ("גם על זמני המשלוח אני לא בטוח."). A line with no tail is left as it is.
const TAIL = /,\s(?:אז העברתי|so I've passed)[\s\S]*$/;
// "יחזור למלאי" (back in stock) is no one answering the customer.
const SAYS_PASSED = /(?<![א-ת])[וש]?(?:העברתי|העברנו|אעביר|נעביר|מעביר|מעבירה|הועבר|הועברה)(?![א-ת])|\b(?:passed|forwarded|handed)\b|\bpass(?:ing)? (?:it|this|that|your)\b/i;
const SAYS_ANSWERED = /(?<![א-ת])[וש]?(?:יחזור|תחזור|יחזרו|נחזור|אחזור|יענה|תענה|יענו|ישיב|תשיב|ישיבו|יצור|ייצור|יצרו|ייצרו)\s+(?:אליך|אלייך|אליכם|אליכן|לך|לכם|לכן|כאן|פה|בהקדם|בקרוב|קשר)(?![א-ת])|\b(?:get|getting|be|come) back to you\b|(?:\bwill|'ll)\s+(?:reply|answer|respond|get in touch|be in touch|follow up|contact you)\b/i;
// An offer ("רוצים שאעביר לנציג?") says nothing was passed on yet.
const handsOver = (t: string) => (SAYS_PASSED.test(t) || SAYS_ANSWERED.test(t)) && !/\?\s*$/.test(t);
// The words such a sentence is made of: a sentence of nothing else says only what the line's tail says.
const HANDOFF_WORDS = new Set(
  normalize(
    `הוא היא הם הן נציג נציגה נציגים מישהו מישהי החנות חנות הצוות צוות שלנו יחזור תחזור יחזרו נחזור אחזור יענה תענה יענו ישיב תשיב ישיבו יצור ייצור יצרו ייצרו קשר
    אליך אלייך אליכם אליכן לך לכם לכן כאן פה בהקדם בקרוב בהמשך בינתיים העברתי העברנו אעביר נעביר מעביר מעבירה הועבר הועברה את השאלה הבקשה השיחה הפנייה הפניה ההודעה זה זאת לו לה להם אז גם עם תשובה כבר עכשיו ישירות
    i ive we weve they theyll he she hell shell someone somebody person a the from store team our us will get back to you here soon shortly reply answer respond contact be in touch passed forwarded handed pass your question request message it this that on and so with an just now as possible them have has follow up directly`,
  ).split(' '),
);
const handoffWord = (w: string) => HANDOFF_WORDS.has(w) || (/^[והלמבש]{1,2}[א-ת]/.test(w) && (HANDOFF_WORDS.has(w.slice(1)) || HANDOFF_WORDS.has(w.slice(2))));
const onlyHandsOver = (t: string) => normalize(t).split(' ').filter(Boolean).every(handoffWord);

/**
 * A reply is English by most of its letters: an English reply may carry a Hebrew word (the tools' rules have the model
 * write "someone from the store (נציג)", a product keeps its Hebrew name), and its honest line is still English.
 */
const englishReply = (text: string) => /[a-z]/i.test(text) && hebrewRatio(text) < 0.5;

/** The reply's pieces (out) with the hand-off said once; placed: the honest lines put in, by their place in out. */
function handOverOnce(out: string[], placed: Map<number, string>, english: boolean, redactions: Redaction[]): void {
  if (![...placed.keys()].some((i) => TAIL.test(out[i].trim()))) return;
  const handing = out.flatMap((t, i) => (!placed.has(i) && handsOver(t) ? [i] : []));
  const own = handing.some((i) => !onlyHandsOver(out[i]));
  let told = own;
  let unsure = false;
  for (const [i, rule] of placed) {
    const line = out[i].trim();
    if (!TAIL.test(line)) continue;
    const core = line.replace(TAIL, '');
    if (told) out[i] = out[i].replace(line, unsure && rule !== 'promise' ? (english ? `${core} either.` : `גם ${core}.`) : `${core}.`);
    told = true;
    unsure ||= rule !== 'promise';
  }
  if (own) return;
  for (const i of handing) redactions.push({ rule: 'continuation', sentence: out[i].trim() });
  for (const i of [...handing].reverse()) out.splice(i, 1);
}

const EMOJI = /(?:\p{Extended_Pictographic}|\p{Regional_Indicator})(?:️|‍\p{Extended_Pictographic})*/gu;

/**
 * The reply as the store's voice allows it (agent/voice.ts): emoji out when they are off, "!!" or "?!" as one mark, and
 * the honest lines in the plural when the store talks to its customers in the plural ("יחזור אליכם").
 */
export function styleReply(text: string, { emoji = true, plural = false }: { emoji?: boolean; plural?: boolean } = {}): string {
  let t = String(text || '');
  if (!emoji) t = t.replace(EMOJI, '').replace(/[ \t]+([,.?!])/g, '$1').replace(/[ \t]{2,}/g, ' ').replace(/^[ \t]+|[ \t]+$/gm, '');
  t = t.replace(/([!?])\1+/g, '$1').replace(/!\?|\?!/g, '?');
  if (plural) t = t.replace(/יחזור אליך כאן/g, 'יחזור אליכם כאן');
  return t.trim();
}

/** The voice rules' punctuation: no em or en dashes as breaks. */
// A dash between two numbers is a range ("1–3 ימי עסקים"), kept as a plain hyphen; anywhere else it is a sentence
// break the voice guide does not allow, and becomes a comma.
// The model now and then puts a broken character inside a word ("נגר�ם", in a demo's answer on 2026-11-12, though the
// store's page has the word whole): it is one character too many, and it goes.
export const undash = (t: string) => t.replace(/�/g, '').replace(/(\d)\s*[—–]\s*(\d)/g, '$1-$2').replace(/\s*[—–]\s*/g, ', ').replace(/,\s*,/g, ',');

// verified: sentences the claim check's second opinion (claims.ts, TORAN_GUARD_LLM) found backed; the lexical rules
// still apply to them.
// asked: the customer's message this turn; a cut about something it did not ask about gets no honest line and no handoff.
// voice: the store's emoji switch and address (agent/voice.ts), applied to the whole reply, the honest lines included.
// demo: a turn on our demo number or a pitch page (loop.ts isDemoTurn), where nothing is passed on (DEMO_LINES).
export function guardReply(text: string, allow: Allow, { company = false, demo = false, verified, asked, voice }: { company?: boolean; demo?: boolean; verified?: Set<string>; asked?: string; voice?: { emoji: boolean; plural: boolean } } = {}): GuardResult {
  const english = englishReply(text);
  const lines = linesFor(company, demo)[english ? 'en' : 'he'];
  const out: string[] = [];
  const redactions: Redaction[] = [];
  const done = new Set<string>();
  const placed = new Map<number, string>(); // the honest lines put in: their place in out, and their rule
  let dropContinuation = false;
  let handoffReason: string | null = null;
  let prev = '';
  let last = ''; // the sentence just before, as written: a label when it ends in a colon on this sentence's line
  for (const sentence of splitSentences(text)) {
    const trimmed = sentence.trim();
    const before = prev;
    const label = /:[ \t]*$/.test(last) && !/^[ \t]*\n/.test(sentence) ? last.trim() : '';
    last = sentence;
    if (trimmed) prev = trimmed;
    if (dropContinuation) {
      if (/^([-•*]|\d+[.)])\s/.test(trimmed) || !trimmed) {
        redactions.push({ rule: 'continuation', sentence: trimmed });
        continue;
      }
      dropContinuation = false;
    }
    const lexical = trimmed ? violation(trimmed, allow, label) : null;
    const claim = !lexical && trimmed && allow.claims && !verified?.has(trimmed) ? claimViolation(trimmed, allow.claims, before) : null;
    const rule = lexical || (claim ? 'claim' : null);
    if (!rule) {
      out.push(sentence);
      continue;
    }
    redactions.push(claim ? { rule, sentence: trimmed, claim: claim.kind, borderline: claim.borderline } : { rule, sentence: trimmed });
    const wasAsked = askedAbout(rule, asked);
    if (HANDOFF_REASON[rule] && wasAsked) handoffReason ??= HANDOFF_REASON[rule];
    if (trimmed.endsWith(':')) dropContinuation = true;
    // An introduction ending in a colon ("there are two options:") introduced what was just cut: it goes too.
    if (out.length && out[out.length - 1].trim().endsWith(':')) redactions.push({ rule: 'continuation', sentence: out.pop()!.trim() });
    // Not asked about: the sentence just goes, with nothing said in its place.
    if (!wasAsked) continue;
    if (done.has(rule)) continue;
    done.add(rule);
    const lead = /^\s*/.exec(sentence)?.[0] || '';
    if (lines[rule]) placed.set(out.length, rule);
    if (lines[rule]) out.push(`${lead}${lines[rule]}${sentence.endsWith('\n') ? '\n' : ' '}`);
  }
  handOverOnce(out, placed, english, redactions);
  noLinkOffer(out);
  let result = undash(out.join('').replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim());
  // Nothing left: the honest line when the customer asked something, a greeting back when they did not.
  if (!result) result = handoffReason || askedAbout('claim', asked) ? checkingLine(english, company, demo) : greeting(english, company);
  if (demo && !company) result = demoTruth(result, english);
  if (voice) result = styleReply(result, voice) || result;
  return { text: result, redactions, needsHandoff: Boolean(handoffReason), handoffReason };
}
