import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAllow, guardReply, numbersIn, splitSentences } from '../src/agent/guard.ts';

const tool = `2 matching products:
- [id 12] ספל חול 350 מ"ל: 89 ₪, במלאי, 3 options. https://s.example/products/sandy-mug
- [id 14] צלחת הגשה אובלית: 149 ₪ (במבצע, במקום 189 ₪), במלאי. https://s.example/products/oval-platter`;
const policy = 'From the store\'s shipping page: משלוח עד הבית עולה 35 ₪. בהזמנה מעל 300 ₪ המשלוח חינם. זמן אספקה: 3 עד 5 ימי עסקים.';
const allow = (extra: string[] = []) => buildAllow({ toolTexts: [tool, policy, ...extra], customerTexts: ['כמה עולה הספל?'] });

test('numbers compare by value, and digits in links are not numbers', () => {
  assert.deepEqual(numbersIn('1,290.00 ₪ ו-99.90'), ['1290', '99.9']);
  assert.deepEqual(numbersIn('https://s.example/products/123 ב-89'), ['89']);
});

test('sentences split on . ! ? : and lines, never inside 9:00 or 19.90', () => {
  assert.deepEqual(splitSentences('המחיר 19.90 ₪. פתוח עד 9:00 בערב! רוצים?').map((s) => s.trim()), ['המחיר 19.90 ₪.', 'פתוח עד 9:00 בערב!', 'רוצים?']);
});

test('a price from the tool passes; a rounded or invented price is cut and hands off', () => {
  const ok = guardReply('הספל עולה 89 ₪, ויש אותו במלאי.', allow());
  assert.equal(ok.redactions.length, 0);
  assert.equal(ok.needsHandoff, false);
  const rounded = guardReply('הספל עולה בערך 90 ₪. רוצים קישור?', allow());
  assert.equal(rounded.redactions[0].rule, 'price');
  assert.ok(rounded.needsHandoff);
  assert.match(rounded.text, /^את המחיר המדויק אני בודק/);
  assert.match(rounded.text, /רוצים קישור\?$/);
  assert.equal(guardReply('הקערה עולה 120 שקלים', allow()).redactions[0]?.rule, 'price');
});

test('the policy\'s own numbers pass; a delivery time or cost it did not give is cut', () => {
  assert.equal(guardReply('המשלוח עולה 35 ₪, ומעל 300 ₪ הוא חינם. מגיע תוך 3 עד 5 ימי עסקים.', allow()).redactions.length, 0);
  const late = guardReply('המשלוח יגיע תוך 2 ימי עסקים.', allow());
  assert.equal(late.redactions[0].rule, 'delivery');
  assert.equal(guardReply('זה יגיע אליכם מחר.', allow()).redactions[0]?.rule, 'delivery');
});

test('offering a discount, a coupon or a refund is cut, unless the policy says it and no number is made up', () => {
  const offer = guardReply('אני יכול לתת לך 10% הנחה על ההזמנה.', allow());
  assert.equal(offer.redactions[0].rule, 'promise');
  assert.equal(offer.handoffReason, 'discount');
  assert.equal(guardReply('תקבלו קופון למשלוח הבא.', allow()).redactions[0]?.rule, 'promise');
  // Quoting the store's free-shipping threshold is not an offer.
  assert.equal(guardReply('בהזמנה מעל 300 ₪ המשלוח חינם.', allow()).redactions.length, 0);
});

test('stock words need stock data from a tool; superlatives never pass', () => {
  const noStock = buildAllow({ toolTexts: [policy], customerTexts: [] });
  assert.equal(guardReply('כן, זה במלאי.', noStock).redactions[0]?.rule, 'stock');
  assert.equal(guardReply('כן, זה במלאי.', allow()).redactions.length, 0);
  assert.equal(guardReply('נשארו רק 2 יחידות אחרונות.', allow()).redactions[0]?.rule, 'stock');
  const sup = guardReply('זה המחיר הכי טוב בארץ. רוצים?', allow());
  assert.equal(sup.redactions[0].rule, 'superlative');
  assert.equal(sup.text, 'רוצים?');
});

test('a cut sentence ending in a colon takes its list; the same category is replaced once', () => {
  const r = guardReply('המחירים שלנו:\n- ספל 95 ₪\n- קערה 70 ₪\nרוצים לשמוע על משלוחים?', allow());
  assert.equal(r.text.split('את המחיר המדויק').length - 1, 1);
  assert.ok(!r.text.includes('95') && !r.text.includes('70'));
  assert.match(r.text, /רוצים לשמוע על משלוחים\?$/);
});

test('a product\'s option count is a fact; a stock quantity never is; a cut takes its colon introduction with it', () => {
  const opts = buildAllow({ toolTexts: ['- [id 7] בסיס מיטה: 3599 ₪ עד 6099 ₪, במלאי, 3 options. https://s.example/p'], customerTexts: [] });
  assert.equal(guardReply('בסיס המיטה עולה 3599 ₪ עד 6099 ₪, לפי הגרסה (יש 3 אפשרויות).', opts).redactions.length, 0);
  assert.equal(guardReply('נשארו רק 3 במלאי.', opts).redactions[0]?.rule, 'stock');
  const r = guardReply('יש שתי אפשרויות: הקטן עולה 999 ₪. הגדול במלאי.', opts);
  assert.equal(r.text, 'את המחיר המדויק אני בודק מול החנות ומעדכן כאן. הגדול במלאי.');
});

test('English replies get English replacement lines; the customer\'s own numbers are allowed; no dashes reach the customer', () => {
  const en = guardReply('The mug is 95 shekels.', allow());
  assert.match(en.text, /^I'm checking the exact price/);
  const own = buildAllow({ toolTexts: [tool], customerTexts: ['יש משהו עד 150 ₪?'] });
  assert.equal(guardReply('עד 150 ₪ יש את הצלחת, ב-149 ₪.', own).redactions.length, 0);
  assert.equal(guardReply('יש בכחול — וגם באפור.', allow()).text, 'יש בכחול, וגם באפור.');
});
