// What an owner's reply about their Teder posts asks for, read in code: "אשר את 1 ו-3, את 2 תעשה קצר יותר" is
// approve 1, approve 3, and send 2 back to be written again, shorter. The numbers are the list the owner last saw
// (owner_lists), 1 being the first post shown.
//
// The reader is strict on purpose. It answers only when it understood every part of the message; anything it is
// unsure of (a question, a "don't", two verbs it cannot tell apart, an edit without the line or the new words) is
// 'unclear', and the message goes to the model instead, whose actions are checked against the same numbers
// (mentioned() below). A message this reader gets wrong would approve a post the owner did not mean, so it would
// rather not answer.

export type Reason = 'topic' | 'shorter' | 'tone' | 'photo' | 'other';
export type Intent =
  | { kind: 'approve'; n: number }
  | { kind: 'reject'; n: number; reason: Reason; note: string }
  | { kind: 'edit'; n: number; slide: number; line: number; text: string }
  | { kind: 'bundle'; n: number }
  | { kind: 'show' }
  | { kind: 'status' };
export type Reading = { ok: true; intents: Intent[] } | { ok: false; why: 'none' | 'unclear' | 'out_of_range'; detail?: number };

const HE = '\\u0590-\\u05FF';
const word = (alts: string[], prefixes = 'וה') => new RegExp(`(?<![${HE}\\w])[${prefixes}]{0,2}(?:${alts.join('|')})(?![${HE}\\w])`, 'u');
const wordG = (alts: string[], prefixes = 'וה') => new RegExp(word(alts, prefixes).source, 'gu');

export function normalize(s: string): string {
  return String(s || '')
    .replace(/[֑-ׇ]/g, (c) => (c === '־' ? '-' : ''))
    .replace(/[״„“”]/g, '"')
    .replace(/[׳‘’`]/g, "'")
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---- numbers: digits, ranges, ordinal and cardinal words, "all", "the rest", "all but"

const ORDINAL: [RegExp, number | 'last'][] = [
  [/ראשונ(?:ה|ים|ות)?|ראשון/, 1], [/שני(?:י)?ה|שני/, 2], [/שלישי(?:ת)?/, 3], [/רביעי(?:ת)?/, 4], [/חמישי(?:ת)?/, 5],
  [/שישי(?:ת)?/, 6], [/שביעי(?:ת)?/, 7], [/שמיני(?:ת)?/, 8], [/תשיעי(?:ת)?/, 9], [/עשירי(?:ת)?/, 10], [/אחרונ(?:ה)?|אחרון/, 'last'],
];
const CARDINAL: [string, number][] = [['אחת', 1], ['שתיים', 2], ['שתים', 2], ['שלוש', 3], ['ארבע', 4], ['חמש', 5], ['שש', 6], ['שבע', 7], ['שמונה', 8], ['תשע', 9], ['עשר', 10]];
const ALL = word(['כולן', 'כולם', 'הכל', 'הכול', 'כל המצגות', 'כל הפוסטים', 'כל אחת', 'כל אחד', 'שתיהן', 'שתיהם', 'שניהם', 'שלושתן', 'שלושתם', 'ארבעתן', 'ארבעתם'], 'ואת');
const REST = word(['שאר', 'השאר', 'האחרות', 'האחרים', 'הנותרות', 'הנותרים', 'היתר'], 'ואת');
const EXCEPT = /(?:חוץ מ|מלבד|למעט)\s*-?\s*/u;

type Targets = { nums: number[]; all: boolean; rest: boolean; except: number[] };

function numbersIn(s: string, size: number): number[] {
  const out: number[] = [];
  let t = s;
  for (const m of t.matchAll(/(?<!\d)(\d{1,2})\s*(?:-|עד)\s*(\d{1,2})(?!\d)/gu)) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a < b && b - a < 20) for (let i = a; i <= b; i++) out.push(i);
  }
  t = t.replace(/(?<!\d)(\d{1,2})\s*(?:-|עד)\s*(\d{1,2})(?!\d)/gu, (all, a, b) => (Number(a) < Number(b) ? ' ' : all));
  for (const m of t.matchAll(/(?<!\d)(\d{1,2})(?!\d)/gu)) out.push(Number(m[1]));
  for (const [re, n] of ORDINAL) {
    // "ביום שני", "ביום שישי" are days, not posts.
    if (new RegExp(`(?<!יום\\s)(?<![${HE}])[ובלה]{0,3}(?:${re.source})(?![${HE}])`, 'u').test(s)) out.push(n === 'last' ? size : n);
  }
  for (const [w, n] of CARDINAL) {
    // "כל אחת" is everyone; "אף אחת" is a "don't", read as unclear further up.
    if (w === 'אחת' && /(?:כל|אף)\s+אחת/u.test(s)) continue;
    if (word([w], 'ובלה').test(s)) out.push(n);
  }
  return out;
}

function targetsIn(clause: string, size: number): Targets {
  const ex = EXCEPT.exec(clause);
  const head = ex ? clause.slice(0, ex.index) : clause;
  const tail = ex ? clause.slice(ex.index + ex[0].length) : '';
  return { nums: [...new Set(numbersIn(head, size))], all: ALL.test(head), rest: REST.test(head), except: [...new Set(numbersIn(tail, size))] };
}

/** The post numbers a message names, for checking the model's actions: every number, or all of them for "all". */
export function mentioned(text: string, size: number): Set<number> {
  const s = normalize(text);
  const t = targetsIn(s, size);
  const all = Array.from({ length: size }, (_, i) => i + 1);
  if (size === 1) return new Set([1]);
  if (t.all || t.rest) return new Set(all.filter((n) => !t.except.includes(n)));
  return new Set([...t.nums, ...t.except].filter((n) => n >= 1 && n <= size));
}

// ---- what a clause asks for

const REASONS: [Reason, RegExp][] = [
  ['shorter', word(['קצר יותר', 'קצרה יותר', 'יותר קצר', 'יותר קצרה', 'תקצר', 'תקצרי', 'תקצרו', 'לקצר', 'קצר', 'קצרה', 'ארוך מדי', 'ארוכה מדי', 'ארוך', 'ארוכה', 'פחות טקסט', 'פחות מילים'], 'וה')],
  ['tone', word(['טון', 'רשמי', 'רשמית', 'קליל', 'קלילה', 'מצחיק', 'מצחיקה', 'סגנון', 'בגובה העיניים', 'יבש', 'יבשה', 'שיווקי', 'שיווקית', 'מתלהב', 'מתלהבת'], 'והב')],
  ['photo', word(['תמונה', 'תמונות', 'צילום', 'צילומים'], 'והב')],
  ['topic', word(['נושא', 'לא רלוונטי', 'לא רלוונטית', 'לא קשור', 'לא קשורה'], 'והב')],
  ['other', word(['תכתוב מחדש', 'תכתבי מחדש', 'לכתוב מחדש', 'מחדש', 'תשפר', 'תשפרי', 'לשפר', 'תנסה שוב', 'גרסה אחרת', 'תעשה אחרת', 'תשנה', 'תשני', 'תחליף', 'תחליפי', 'תתקן', 'תתקני'], 'ו')],
];
const REJECT = word(['דחה', 'תדחה', 'תדחי', 'דחי', 'דחו', 'תדחו', 'דוחה', 'דוחים', 'לדחות', 'תוותר על', 'וותר על', 'לוותר על', 'תמחק', 'תמחקי', 'מחק', 'תזרוק', 'זרוק', 'תוריד', 'להוריד', 'לא טוב', 'לא טובה', 'לא טובות', 'לא טובים', 'לא מתאים', 'לא מתאימה', 'לא מתאימות', 'לא אהבתי', 'גרוע', 'גרועה', 'לא'], 'ו');
const APPROVE = word(['אשר', 'תאשר', 'תאשרי', 'תאשרו', 'אשרי', 'אשרו', 'מאשר', 'מאשרת', 'מאשרים', 'מאשרות', 'לאשר', 'אישור', 'מאושר', 'מאושרת', 'מאושרים', 'מאושרות', 'תפרסם', 'תפרסמי', 'פרסם', 'לפרסם', 'טוב', 'טובה', 'טובים', 'טובות', 'מעולה', 'מעולות', 'מעולים', 'מצוין', 'מצוינת', 'מצוינות', 'מושלם', 'מושלמת', 'סבבה', 'אחלה', 'יופי', 'כן'], 'ו');
const BUNDLE = word(['שלח', 'תשלח', 'שלחי', 'תשלחי', 'מוכן לפרסום', 'מוכנה לפרסום', 'את התמונות', 'את הכיתוב', 'הכיתוב', 'כיתוב'], 'ו');
const FILLER = /^(?:תודה(?: רבה)?|בבקשה|היי|הי|אהלן|יאללה|אוקיי|אוקי|ok|טוב אז|אז|וגם|גם|ו)$/iu;
const NEGATION = /(?<![֐-׿])(?:אל|אף|אסור)\s/u;
const QUESTION = /\?|^(?:למה|איך|כמה|מתי|איפה|האם|מי|מה)(?![֐-׿])/u;
const SHOW = /^(?:הצג|תציג|תציגי|להציג|תראה לי|תראי לי|מה מחכה(?: לי)?(?: לאישור)?|מה ממתין(?: לאישור)?|מה יש לאישור|תשלח שוב(?: את המצגות| את הרשימה)?)[.!?\s]*$/u;
const STATUS = /^(?:מה )?ה?סטטוס(?: בטדר| של טדר)?[.!?\s]*$/u;

type Act = 'approve' | 'reject' | 'bundle' | 'skip';
type Clause = { text: string; act: Act | null; unclear: boolean; reason: Reason | null; t: Targets; note: string; bare: boolean };

const ORD_SRC = ORDINAL.map(([r]) => r.source).join('|');
const TARGET = new RegExp(`(?:ו?את\\s+)?(?:ה?(?:מצגת|פוסט)\\s+)?(?:מספר\\s+|מס'\\s*)?(?:-?(?<!\\d)\\d{1,2}(?!\\d)|(?<![${HE}])[ובלה]{0,3}(?:${ORD_SRC})(?![${HE}]))`, 'gu');
const LEFTOVER = wordG(['את', 'גם', 'בבקשה', 'תודה', 'אז', 'ו', 'עד', 'חוץ מ', 'מלבד', 'למעט', 'כולן', 'כולם', 'הכל', 'הכול', 'שתיהן', 'שתיהם', 'שניהם', 'שלושתן', 'שלושתם', 'השאר', 'שאר', 'האחרות', 'האחרים', 'היתר'], 'ו');
const ACK = /^(?:טוב|טובה|סבבה|יופי|אחלה|כן|אוקיי|אוקי|מעולה|מצוין|מושלם)$/u;
const NOT_YET = /(?:עוד|עדיין|בינתיים)\s+לא(?![֐-׿])|(?<![֐-׿])תשאיר|תחכה|אחר כך|נחשוב/u;

/** Split at punctuation, "אבל", and a "ו" that starts a new number or verb ("ו-3", "ואת 2", "ותדחה"). */
function clauses(s: string): string[] {
  const out: string[] = [];
  for (const part of s.split(/[,;\n.]+|\s+אבל\s+/u)) {
    let cur: string[] = [];
    for (const tok of part.trim().split(/\s+/u).filter(Boolean)) {
      const rest = tok.startsWith('ו') ? tok.slice(1).replace(/^-/, '') : '';
      const starts = rest && (/^\d/.test(rest) || rest === 'את' || rest === 'גם' || REJECT.test(rest) || APPROVE.test(rest) || REASONS.some(([, re]) => re.test(rest)));
      if (starts && cur.length) {
        out.push(cur.join(' '));
        cur = [rest];
      } else cur.push(tok);
    }
    if (cur.length) out.push(cur.join(' '));
  }
  return out.map((c) => c.trim()).filter(Boolean);
}

/** The owner's words about a post, without the post's number: the note Teder gets on a rejection. */
function noteOf(text: string): string {
  return text.replace(TARGET, ' ').replace(/(?:^|\s)גם(?=\s|$)/gu, ' ').replace(/^[\s\-:,]+|[\s\-:,.]+$/gu, '').replace(/\s+/g, ' ').trim();
}

function readClause(text: string, size: number): Clause {
  const t = targetsIn(text, size);
  const note0 = noteOf(text);
  const bare = !note0.replace(LEFTOVER, ' ').trim();
  if (NOT_YET.test(text)) return { text, act: 'skip', unclear: false, reason: null, t, note: '', bare };
  const reason = (REASONS.find(([, re]) => re.test(text)) || [null])[0];
  // "לא" inside a reason ("לא רלוונטי") is the reason, not a second verb.
  const masked = REASONS.reduce((s, [, re]) => s.replace(new RegExp(re.source, 'gu'), ' '), text);
  const rejects = REJECT.test(masked);
  const approves = APPROVE.test(masked.replace(new RegExp(REJECT.source, 'gu'), ' '));
  const bundles = BUNDLE.test(masked);
  const kinds = [reason || rejects ? 'reject' : null, approves && !reason ? 'approve' : null, bundles ? 'bundle' : null].filter(Boolean) as Act[];
  if (kinds.length > 1) return { text, act: null, unclear: true, reason, t, note: '', bare };
  const act = kinds[0] || null;
  const note = act === 'reject' && !(REJECT.test(note0) && !note0.includes(' ')) ? note0 : '';
  return { text, act, unclear: false, reason, t, note, bare };
}

function readEdit(s: string, size: number): Reading {
  const quoted = [...s.matchAll(/"([^"]{1,300})"/gu)].map((m) => m[1].trim());
  const colon = s.lastIndexOf(':');
  const text = quoted.length ? quoted[quoted.length - 1] : colon >= 0 ? s.slice(colon + 1).trim() : '';
  const outside = quoted.length ? s.replace(/"[^"]*"/gu, ' ') : colon >= 0 ? s.slice(0, colon) : s;
  const ord = (w: string) => {
    for (const [re, n] of ORDINAL) if (new RegExp(`^(?:${re.source})$`, 'u').test(w)) return n === 'last' ? null : n;
    return null;
  };
  const post = /(?:מצגת|פוסט)\s*(?:מספר\s*)?-?\s*(\d{1,2})/u.exec(outside) || /^ב-?(\d{1,2})(?!\d)/u.exec(outside);
  const slideM = /שקופית\s*(?:מספר\s*)?-?\s*(\d{1,2})/u.exec(outside) || /שקופית\s+ה?([֐-׿]+)/u.exec(outside);
  const lineM = /שורה\s*(?:מספר\s*)?-?\s*(\d{1,2})/u.exec(outside) || /שורה\s+ה?([֐-׿]+)/u.exec(outside);
  const n = post ? Number(post[1]) : size === 1 ? 1 : null;
  const slide = slideM ? (/^\d+$/.test(slideM[1]) ? Number(slideM[1]) : ord(slideM[1])) : null;
  const line = lineM ? (/^\d+$/.test(lineM[1]) ? Number(lineM[1]) : ord(lineM[1])) : /(?<![֐-׿])ה?כותרת/u.test(outside) ? 1 : null;
  if (!n || !slide || !line || !text) return { ok: false, why: 'unclear' };
  // Anything else asked in the same message (an approval, a rejection) is more than this reader takes on.
  const rest = outside.replace(/(?:מצגת|פוסט|שקופית|שורה)\s*(?:מספר\s*)?-?\s*[֐-׿\d]+/gu, ' ').replace(/^ב-?\d{1,2}/u, ' ');
  if (APPROVE.test(rest) || REJECT.test(rest) || REASONS.slice(0, 4).some(([, re]) => re.test(rest))) return { ok: false, why: 'unclear' };
  if (n < 1 || n > size) return { ok: false, why: 'out_of_range', detail: n };
  return { ok: true, intents: [{ kind: 'edit', n, slide, line, text }] };
}

/** An owner's message, read against the list they last saw (`size` posts). */
export function readReply(raw: string, size: number): Reading {
  const s = normalize(raw);
  if (!s) return { ok: false, why: 'none' };
  if (STATUS.test(s)) return { ok: true, intents: [{ kind: 'status' }] };
  if (SHOW.test(s)) return { ok: true, intents: [{ kind: 'show' }] };
  if (!size) return { ok: false, why: 'none' };
  if (QUESTION.test(s) || NEGATION.test(s)) return { ok: false, why: 'unclear' };
  if (/שקופית/u.test(s)) return readEdit(s, size);

  const parts = clauses(s).map((c) => readClause(c, size));
  if (parts.some((p) => p.unclear)) return { ok: false, why: 'unclear' };
  const all = Array.from({ length: size }, (_, i) => i + 1);
  const named = new Set(parts.flatMap((p) => p.t.nums));
  const has = (p: Clause) => Boolean(p.t.nums.length || p.t.all || p.t.rest);
  // A clause that is only numbers ("ו-3", "1 ו-") takes the verb before it, or else the one right after it
  // ("1 ו-2 טובות" splits into "1" and "2 טובות"). A clause with other words and no verb is not understood.
  const acts = parts.map((p) => p.act);
  for (let i = 0; i < parts.length; i++) {
    if (acts[i] || !has(parts[i])) continue;
    if (!parts[i].bare) return { ok: false, why: 'unclear' };
    acts[i] = acts[i - 1] || (parts[i + 1]?.act ?? null);
  }
  const out = new Map<number, Intent>();
  const skipped = new Set<number>();
  let prev: { act: Act; reason: Reason | null; ns: number[] } | null = null;

  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const act = acts[i];
    if (!act && !has(p)) {
      if (FILLER.test(p.text) || ACK.test(p.text)) continue;
      return { ok: false, why: 'unclear' };
    }
    if (!act) return { ok: false, why: 'unclear' };
    let ns: number[];
    if (p.t.all) ns = all.filter((n) => !p.t.except.includes(n));
    else if (p.t.rest) ns = all.filter((n) => !named.has(n) && !p.t.except.includes(n));
    else if (p.t.nums.length) ns = p.t.nums;
    // "תקצר" after "השנייה ארוכה מדי": more about the same post.
    else if (prev && prev.act === 'reject' && act === 'reject') ns = prev.ns;
    // A lone "סבבה" or "כן" acknowledges; only a verb ("אשר", "שלח") acts on a list of one without its number.
    else if (ACK.test(p.text)) continue;
    else if (size === 1) ns = [1];
    else return { ok: false, why: 'unclear' };
    const bad = ns.find((n) => n < 1 || n > size);
    if (bad !== undefined) return { ok: false, why: 'out_of_range', detail: bad };
    for (const n of ns) {
      const had = out.get(n);
      if (act === 'skip') {
        if (had) return { ok: false, why: 'unclear' };
        skipped.add(n);
        continue;
      }
      if (skipped.has(n) || (had && had.kind !== act)) return { ok: false, why: 'unclear' };
      if (act === 'approve') out.set(n, { kind: 'approve', n });
      else if (act === 'bundle') out.set(n, { kind: 'bundle', n });
      else {
        const before = had?.kind === 'reject' ? had : null;
        const reason = before && before.reason !== 'other' ? before.reason : p.reason || (p.act ? null : prev?.reason) || 'other';
        out.set(n, { kind: 'reject', n, reason, note: [before?.note, p.note].filter(Boolean).join(', ') });
      }
    }
    prev = { act, reason: p.reason, ns };
  }
  if (!out.size) return { ok: false, why: 'none' };
  return { ok: true, intents: [...out.values()].sort((a, b) => (a as any).n - (b as any).n) };
}
