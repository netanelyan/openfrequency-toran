import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAllow, guardReply, numbersIn, splitSentences, summaryHe, undash, undear } from '../src/agent/guard.ts';

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
  assert.match(rounded.text, /^על המחיר המדויק אני לא בטוח/);
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
  // An offer to check is no claim (the owner, 2026-11-11: "why is it red?"); a claim beside it still is.
  const hi = buildAllow({ toolTexts: [], customerTexts: ['היי'] });
  const offer = 'היי, במה אפשר לעזור? אם מחפשים חולצה או מוצר מסוים, כתבו לי מה ואבדוק מה יש במלאי.';
  assert.deepEqual(guardReply(offer, hi, { asked: 'היי' }).redactions, []);
  assert.deepEqual(guardReply('רוצה שאבדוק אם המידה הזו זמינה?', hi).redactions, []);
  assert.deepEqual(guardReply("Tell me which one and I'll check if it's in stock.", hi).redactions, []);
  assert.equal(guardReply('אבדוק מה יש במלאי, ויש לנו במלאי חולצות.', hi).redactions[0]?.rule, 'stock');
  assert.equal(guardReply('בדקתי, וזה במלאי.', hi).redactions[0]?.rule, 'stock');
  assert.equal(guardReply('אבדוק, אבל זה זמין.', hi).redactions[0]?.rule, 'stock');
  const sup = guardReply('זה המחיר הכי טוב בארץ. רוצים?', allow());
  assert.equal(sup.redactions[0].rule, 'superlative');
  assert.equal(sup.text, 'רוצים?');
});

test('a cut sentence ending in a colon takes its list; the same category is replaced once', () => {
  const r = guardReply('המחירים שלנו:\n- ספל 95 ₪\n- קערה 70 ₪\nרוצים לשמוע על משלוחים?', allow());
  assert.equal(r.text.split('על המחיר המדויק').length - 1, 1);
  assert.ok(!r.text.includes('95') && !r.text.includes('70'));
  assert.match(r.text, /רוצים לשמוע על משלוחים\?$/);
});

test('a product\'s option count is a fact; a stock quantity never is; a cut takes its colon introduction with it', () => {
  const opts = buildAllow({ toolTexts: ['- [id 7] בסיס מיטה: 3599 ₪ עד 6099 ₪, במלאי, 3 options. https://s.example/p'], customerTexts: [] });
  assert.equal(guardReply('בסיס המיטה עולה 3599 ₪ עד 6099 ₪, לפי הגרסה (יש 3 אפשרויות).', opts).redactions.length, 0);
  assert.equal(guardReply('נשארו רק 3 במלאי.', opts).redactions[0]?.rule, 'stock');
  const r = guardReply('יש שתי אפשרויות: הקטן עולה 999 ₪. הגדול במלאי.', opts);
  assert.equal(r.text, 'על המחיר המדויק אני לא בטוח, אז העברתי את השאלה לנציג מהחנות. הוא יחזור אליך כאן. הגדול במלאי.');
});

test('a number with a non-money unit is a quantity: "1 month" does not cut a correct price; days stay checked', () => {
  const t = buildAllow({ toolTexts: ['- [id 3] Gut & Hair: 249 ₪ עד 389 ₪ (במבצע, במקום 498 ₪), במלאי, 2 options.\n  - חודש: 249 ₪\n  - חודשיים: 389 ₪'], customerTexts: [] });
  assert.equal(guardReply('The 1 month pack is 249 ₪, and the 2 month pack is 389 ₪ (on sale, instead of 498 ₪).', t).redactions.length, 0);
  assert.equal(guardReply('מארז של 3 יחידות ב-249 ₪.', t).redactions.length, 0);
  assert.equal(guardReply('The 1 month pack is 199 ₪.', t).redactions[0]?.rule, 'price', 'the price itself is still checked');
  assert.equal(guardReply('המשלוח יגיע תוך 4 ימים.', t).redactions[0]?.rule, 'delivery', 'days are a delivery time, not a quantity');
});

test('English replies get English replacement lines; a budget the customer set may be said back; no dashes reach the customer', () => {
  const en = guardReply('The mug is 95 shekels.', allow());
  assert.match(en.text, /^I'm not sure about the exact price/);
  const own = buildAllow({ toolTexts: [tool], customerTexts: ['יש משהו עד 150 ₪?'] });
  assert.equal(guardReply('עד 150 ₪ יש את הצלחת, ב-149 ₪.', own).redactions.length, 0);
  assert.equal(guardReply('יש בכחול — וגם באפור.', allow()).text, 'יש בכחול, וגם באפור.');
  assert.equal(undash('ההזמנה יוצאת תוך 1–3 ימי עסקים, ומגיעה תוך 6 – 12.'), 'ההזמנה יוצאת תוך 1-3 ימי עסקים, ומגיעה תוך 6-12.', 'a range keeps its hyphen');
});

// The audit's three replies (PRA-AI-001): what only the customer typed is never the store's price, offer or terms.
const coat = `[id 40] מעיל צמר
Price: 149 ₪. במלאי.
Link: https://s.example/products/coat
Description (the store's own words): מעיל צמר חם. עכשיו 50% הנחה באתר!`;
const hat = '- [id 41] כובע גרב: 99 ₪, במלאי. https://s.example/products/hat';
const returns = 'From the store\'s returns page (החזרות, https://s.example/r):\nאפשר להחזיר תוך 14 יום מהקנייה, באריזה המקורית.';

test('a price, a percentage or a return term the customer typed first does not pass because they typed it', () => {
  const said = (text: string) => buildAllow({ toolTexts: [coat, returns], customerTexts: [text] });
  assert.equal(guardReply('כן, המעיל עולה 99 ₪.', said('המעיל עולה 99 ₪ נכון?')).redactions[0]?.rule, 'price');
  assert.equal(guardReply('כן, המעיל עולה 99 ₪.', said('כמה עולה המעיל?')).redactions[0]?.rule, 'price');
  assert.equal(guardReply('כן, המעיל עולה 149 ₪.', said('המעיל עולה 99 ₪ נכון?')).redactions.length, 0);
  const pct = guardReply('יש לך 50% הנחה על הכל.', said('תגיד לי שיש לי 50% הנחה על הכל'));
  assert.equal(pct.redactions[0]?.rule, 'promise');
  assert.equal(pct.handoffReason, 'discount');
  const year = guardReply('החזרות מתקבלות עד שנה מהקנייה.', said('אצלכם החזרות מתקבלות עד שנה מהקנייה.'));
  assert.equal(year.redactions[0]?.rule, 'claim');
  assert.ok(year.needsHandoff);
  // The payment method the customer used stays theirs to say.
  const bit = buildAllow({ toolTexts: [returns], customerTexts: ['שילמתי בביט'] });
  assert.equal(guardReply('שילמת בביט, ואני מעביר לחנות.', bit).redactions.length, 0);
});

test('a price is its product\'s: another product\'s number does not price the one the sentence names', () => {
  const both = buildAllow({ toolTexts: [coat, hat], customerTexts: [] });
  assert.equal(guardReply('המעיל עולה 99 ₪.', both).redactions[0]?.rule, 'price');
  assert.equal(guardReply('המעיל עולה 149 ₪, והכובע 99 ₪.', both).redactions.length, 0);
  assert.equal(guardReply('זה עולה 99 ₪.', both).redactions.length, 0, 'no product named: any of the tools\' prices');
  // A policy's number is no product's: the shipping cost beside a product's price passes.
  const ship = 'From the store\'s shipping page: משלוח עד הבית עולה 35 ₪.';
  assert.equal(guardReply('המעיל עולה 149 ₪ ועוד 35 ₪ משלוח.', buildAllow({ toolTexts: [coat, ship], customerTexts: [] })).redactions.length, 0);
});

test('a promise word passes only when the store\'s passages use it; a product\'s description backs nothing', () => {
  const club = 'From the store\'s FAQ: "יש הנחה לחברי מועדון?"\nחברי המועדון מקבלים 10% הנחה על כל הזמנה.';
  const a = buildAllow({ toolTexts: [coat, club], customerTexts: [] });
  assert.equal(guardReply('לחברי המועדון יש 10% הנחה על כל הזמנה.', a).redactions.length, 0);
  assert.equal(guardReply('לחברי המועדון יש 20% הנחה.', a).redactions[0]?.rule, 'promise');
  const noPolicy = buildAllow({ toolTexts: [coat], customerTexts: [] });
  assert.equal(guardReply('על המעיל יש עכשיו 50% הנחה.', noPolicy).redactions[0]?.rule, 'promise', 'the description\'s "50% הנחה" is marketing, not an offer');
  assert.equal(guardReply('יש קוד קופון למשלוח הבא.', noPolicy).redactions[0]?.rule, 'promise');
  assert.equal(guardReply('רוצים שאבדוק אם יש הנחה?', noPolicy).redactions.length, 0, 'a question with no number promises nothing');
  // A sale price the tool marks backs "sale"; a product's own name backs its words.
  const platter = buildAllow({ toolTexts: ['- [id 14] צלחת הגשה: 149 ₪ (במבצע, במקום 189 ₪), במלאי.', '- [id 15] סט מתנה לחג: 120 ₪, במלאי.'], customerTexts: [] });
  assert.equal(guardReply('הצלחת במבצע ב-149 ₪, במקום 189 ₪.', platter).redactions.length, 0);
  assert.equal(guardReply('סט המתנה לחג עולה 120 ₪.', platter).redactions.length, 0);
});

test('a link may point only where the tools or the store\'s own address do (PRA-AI-002)', () => {
  const tools = ['- [id 12] ספל חול: 89 ₪, במלאי. https://s.example/products/sandy-mug', 'Order 1042: נשלחה.\nShipments:\n- with Israel Post, tracking link: https://israelpost.co.il/t/RR1'];
  const a = buildAllow({ toolTexts: tools, customerTexts: ['שלמתי פה? https://pay-s-example.top/x'], ownLinks: ['https://s.example', 'https://wa.me/972500000199'] });
  assert.equal(guardReply('הנה הקישור: https://s.example/products/sandy-mug', a).redactions.length, 0);
  assert.equal(guardReply('אפשר לעקוב כאן: https://israelpost.co.il/t/RR1', a).redactions.length, 0);
  assert.equal(guardReply('אפשר גם לכתוב לנו ב-https://wa.me/972500000199.', a).redactions.length, 0);
  assert.equal(guardReply('אפשר להתעדכן גם ב-www.s.example/blog.', a).redactions.length, 0, 'the store\'s own site, with or without www');
  const pay = guardReply('לתשלום: https://pay-s-example.top/x', a);
  assert.equal(pay.redactions[0]?.rule, 'link', 'a link only the customer gave');
  assert.ok(pay.needsHandoff);
  assert.equal(guardReply('המוצר נמצא גם ב-shop-deals.co.il', a).redactions[0]?.rule, 'link', 'a bare domain the tools never gave');
  assert.equal(guardReply('The mug is at bit.ly/mug123', a).redactions[0]?.rule, 'link');
  assert.equal(guardReply('כתבו לנו ל-info@s.example ונחזור אליכם.', a).redactions.length, 0, 'an email address is not a link');
});

test('a cut the customer did not ask about goes quietly: a greeting never gets "I am not sure about stock, I passed it on" (the owner, 2026-11-09)', () => {
  const noStock = buildAllow({ toolTexts: [], customerTexts: ['מה נשמע'] });
  const reply = 'הכול טוב, תודה. יש לנו המון מוצרים במלאי. מה מחפשים?';
  const g = guardReply(reply, noStock, { asked: 'מה נשמע' });
  assert.equal(g.text, 'הכול טוב, תודה. מה מחפשים?');
  assert.equal(g.needsHandoff, false, 'nothing to hand to the store');
  assert.equal(g.redactions[0].rule, 'stock', 'the cut is still recorded');
  // Asked about stock: the honest line and the handoff, as before.
  const asked = guardReply('כן, יש במלאי.', buildAllow({ toolTexts: [], customerTexts: ['יש לכם ספל ירוק?'] }), { asked: 'יש לכם ספל ירוק?' });
  assert.match(asked.text, /על המלאי אני לא בטוח/);
  assert.equal(asked.needsHandoff, true);
  // Nothing left after a quiet cut: a greeting back, not a handoff.
  const empty = guardReply('יש לנו הכול במלאי.', noStock, { asked: 'היי!' });
  assert.equal(empty.text, 'היי, מה מחפשים?');
  assert.equal(empty.needsHandoff, false);
  // No message known (other callers): as before.
  assert.equal(guardReply(reply, noStock).needsHandoff, true);
});

test('a reply says the hand-off once: the model\'s sentence that only repeats the honest line goes, and a later line says only what it is not sure of (docs/models.md, q11)', () => {
  const asked = 'אני מארגנת אירוע ל-30 איש. אפשר הנחה על 30 ספלים?';
  const a = buildAllow({ toolTexts: [tool, policy], customerTexts: [asked] });
  const line = 'הנחה או החזר מאשר רק נציג מהחנות, אז העברתי לו את הבקשה. הוא יחזור אליך כאן.';
  // The model's own line is cut for its "הנחה" and the guard's put in its place: its next sentence went out beside it,
  // "...יחזור אליך כאן. הוא יחזור אליכם כאן."
  const q11 = guardReply('הנחה מאשר רק נציג מהחנות, אז העברתי לו את הבקשה. הוא יחזור אליכם כאן.', a, { asked });
  assert.equal(q11.text, line);
  assert.equal(q11.handoffReason, 'discount');
  assert.deepEqual(q11.redactions.map((r) => r.rule), ['promise', 'continuation']);
  assert.equal(guardReply('העברתי את הבקשה לנציג מהחנות. בינתיים אפשר לתת לך 10% הנחה.', a, { asked }).text, line, 'said before the cut');
  assert.equal(guardReply('הנחה מאשר רק נציג מהחנות. נציג יחזור אליך בהקדם עם תשובה.', a, { asked }).text, line);
  assert.equal(guardReply('הנחה מאשר רק נציג מהחנות, אז העברתי לו את הבקשה. הוא יחזור אליכם כאן.', a, { asked, voice: { emoji: true, plural: true } }).text, line.replace('אליך', 'אליכם'));
  // A sentence that says more than the hand-off stays, and the honest line then says only its own part.
  assert.equal(
    guardReply('העברתי לנציג את השאלה על 30 הספלים לאירוע, והוא יחזור אליך כאן. בינתיים יש לך 10% הנחה.', a, { asked }).text,
    'העברתי לנציג את השאלה על 30 הספלים לאירוע, והוא יחזור אליך כאן. הנחה או החזר מאשר רק נציג מהחנות.',
  );
  // Two cuts of two kinds: passed on once, and the second line is only what it is not sure of.
  assert.equal(
    guardReply('הספל עולה 95 ₪. המשלוח יגיע תוך 2 ימי עסקים.', a, { asked: 'כמה עולה הספל ומתי הוא יגיע?' }).text,
    'על המחיר המדויק אני לא בטוח, אז העברתי את השאלה לנציג מהחנות. הוא יחזור אליך כאן. גם על זמני המשלוח אני לא בטוח.',
  );
  // "Back in stock" is not someone getting back to the customer.
  assert.equal(
    guardReply('האגרטל הגבוה יחזור למלאי אחרי השריפה הבאה. הספל עולה 95 ₪.', a, { asked: 'כמה עולה הספל?' }).text,
    'האגרטל הגבוה יחזור למלאי אחרי השריפה הבאה. על המחיר המדויק אני לא בטוח, אז העברתי את השאלה לנציג מהחנות. הוא יחזור אליך כאן.',
  );
  // An offer to pass it on is not the hand-off itself: the honest line still says it was passed.
  assert.equal(
    guardReply('רוצים שאעביר את השאלה לנציג? הספל עולה 95 ₪.', a, { asked: 'כמה עולה הספל?' }).text,
    'רוצים שאעביר את השאלה לנציג? על המחיר המדויק אני לא בטוח, אז העברתי את השאלה לנציג מהחנות. הוא יחזור אליך כאן.',
  );
  const en = buildAllow({ toolTexts: [tool, policy], customerTexts: ['Can I get a discount?'] });
  assert.equal(guardReply('You can have a 10% discount. Someone from the store will get back to you here.', en, { asked: 'Can I get a discount?' }).text, "Discounts and refunds are approved only by someone from the store, so I've passed your request to them. They'll reply here.");
  assert.equal(guardReply('The mug is 95 ₪. It arrives in 2 days.', en, { asked: 'How much is the mug and when does it arrive?' }).text, "I'm not sure about the exact price, so I've passed your question to someone from the store. They'll reply here. I'm not sure about delivery times either.");
  // An English reply with a Hebrew word in it gets the English line (the tools' rules have the model write "(נציג)").
  assert.equal(
    guardReply("The sand mug (ספל חול) is 95 ₪. I've passed your question to someone from the store (נציג).", en, { asked: 'How much is the sand mug?' }).text,
    "I'm not sure about the exact price, so I've passed your question to someone from the store. They'll reply here.",
  );
  // A company's lines say it once too.
  const co = buildAllow({ toolTexts: [], customerTexts: ['אפשר הנחה?'] });
  assert.equal(guardReply('אפשר לתת לך 20% הנחה. נציג שלנו יחזור אליך כאן.', co, { asked: 'אפשר הנחה?', company: true }).text, 'הנחה או הסדר מיוחד מאשר רק נציג שלנו, אז העברתי לו את הבקשה. הוא יחזור אליך כאן.');
});

test('every handoff line kept in English reads in Hebrew for the owner and the operator', () => {
  for (const old of ['the guard cut stock: מה נשמע', "Toran is not paid for in this store's workspace: היי", "the store's spend cap ($5) is reached: היי", 'no answer within 30 seconds: היי', 'the model declined to answer', 'the agent failed: boom', 'no answer after 6 rounds: היי']) {
    const he = summaryHe(old);
    assert.doesNotMatch(he, /[a-z]{3,}/i, old);
    assert.match(he, /[֐-׿]/, old);
  }
  assert.equal(summaryHe('הלקוח רוצה החזר'), 'הלקוח רוצה החזר', 'a Hebrew line stays as it is');
});

// The owner, 2026-11-12, on the first demo they opened (a supplements store): "something with the grow is not it. make sure it catches
// things like that". The search gave four products with "Grow" in their names and a hat at 99 ₪; the reply priced one
// Grow at the hat's 99 ₪ on a line of its own, "name: price", which the sentences split at the colon.
const growSearch = `- [id 1] Grow: 249 ₪ עד 389 ₪ (חלק מהאפשרויות במבצע), במלאי, 3 options. https://vitamins.example/products/grow
- [id 2] Grow & Shine: 249 ₪ עד 389 ₪ (חלק מהאפשרויות במבצע), במלאי, 2 options. https://vitamins.example/products/grow-shine
- [id 3] Grow - חודש: 124.50 ₪, במלאי. https://vitamins.example/products/grow-month
- [id 4] Grow - (חודש): 124.50 ₪, במלאי. https://vitamins.example/products/grow-month-copy
- [id 5] כובע Wellness-Club: 99 ₪ (במבצע, במקום 129 ₪), במלאי. https://vitamins.example/products/hat`;
const growAsked = 'היי, יש לכם Grow? כמה זה עולה?';

test('a price on a "name: price" line is held to the name before the colon: the hat\'s 99 ₪ does not price Grow', () => {
  const allowGrow = buildAllow({ toolTexts: [growSearch], customerTexts: [growAsked] });
  const r = guardReply('היי, יש כמה אפשרויות של Grow:\nGrow - חודש: 99 ₪\nGrow - (חודש): 124.50 ₪\nיש גם מארז Grow & Shine שעולה 249 ₪ עד 389 ₪. איזה מהם מעניין אתכם?', allowGrow, { asked: growAsked });
  assert.deepEqual(r.redactions.map((x) => [x.rule, x.sentence]), [['price', '99 ₪'], ['continuation', 'Grow - חודש:']]);
  assert.ok(r.needsHandoff);
  assert.doesNotMatch(r.text, /99 ₪/);
  assert.doesNotMatch(r.text, /\n /, 'the honest line in its place starts its line, with no space before it');
  // Each name with its own price passes, line by line and inside a sentence; the hat's own price is the hat's.
  for (const ok of ['Grow - חודש: 124.50 ₪\nGrow & Shine: 249 ₪ עד 389 ₪', 'הכובע: 99 ₪', 'Grow - חודש עולה 124.50 ₪, והכובע 99 ₪.']) {
    assert.deepEqual(guardReply(ok, allowGrow, { asked: growAsked }).redactions, [], ok);
  }
  // A list's own opening line ends in a colon on a line of its own: it is no name for the line under it.
  assert.deepEqual(guardReply('יש שני מוצרים כאלה:\n124.50 ₪ לבקבוק אחד.', allowGrow, { asked: growAsked }).redactions, []);
  // "Some options are on sale" backs the word "sale" for that product.
  assert.deepEqual(guardReply('Grow עולה 249 ₪ עד 389 ₪, וחלק מהאפשרויות במבצע.', allowGrow, { asked: growAsked }).redactions, []);
});

test('a reply that has the link does not offer to send one (the owner, 2026-11-12: "it should not ask")', () => {
  const pouf = buildAllow({ toolTexts: ['- [id 9] הדום לפוף: 299 ₪, במלאי, 9 options. https://pouf.example/products/pouf'], customerTexts: [] });
  const say = (t: string) => guardReply(t, pouf, { asked: 'היי, יש לכם הדום לפוף? כמה זה עולה?' });
  // The demo's own reply: the offer comes off its question, and the question before it stays.
  const r = say('כן, יש הדום לפוף. הוא עולה 299 ₪, ויש לו 9 אפשרויות לבחירה. רוצים שאבדוק איזה צבעים יש, או שאשלח קישור?\nhttps://pouf.example/products/pouf');
  assert.equal(r.text, 'כן, יש הדום לפוף. הוא עולה 299 ₪, ויש לו 9 אפשרויות לבחירה. רוצים שאבדוק איזה צבעים יש?\nhttps://pouf.example/products/pouf');
  assert.deepEqual(r.redactions, [], 'nothing about the store was wrong: no cut, no hand-off');
  // A question that was only the offer goes.
  assert.equal(say('הוא עולה 299 ₪. https://pouf.example/products/pouf רוצים שאשלח לכם את הקישור?').text, 'הוא עולה 299 ₪. https://pouf.example/products/pouf');
  assert.equal(say('It is 299 ₪: https://pouf.example/products/pouf Want me to send you the link?').text, 'It is 299 ₪: https://pouf.example/products/pouf');
  // With no link in the reply, the offer is a fair question and stays.
  assert.equal(say('הוא עולה 299 ₪. רוצים שאשלח קישור?').text, 'הוא עולה 299 ₪. רוצים שאשלח קישור?');
  // A link and another question: nothing comes off.
  assert.equal(say('הוא עולה 299 ₪. https://pouf.example/products/pouf באיזה צבע?').text, 'הוא עולה 299 ₪. https://pouf.example/products/pouf באיזה צבע?');
});

test('a broken character the model put inside a word goes: the word is whole again', () => {
  assert.equal(undash('אם נגר\uFFFDם נזק במשלוח, מחליפים.'), 'אם נגרם נזק במשלוח, מחליפים.');
  assert.equal(guardReply('היי, מה מחפ\uFFFDשים?', buildAllow({ toolTexts: [], customerTexts: [] })).text, 'היי, מה מחפשים?');
});

test('"לקוח יקר," opens a call centre\'s letter, not a store\'s chat: it goes, and a greeting before it stays', () => {
  assert.equal(undear('לקוח יקר, השרוול עולה 129 ₪.'), 'השרוול עולה 129 ₪.');
  assert.equal(undear('היי לקוחה יקרה! יש במלאי.'), 'היי, יש במלאי.');
  assert.equal(undear('תודה. לקוחות יקרים, המשלוח יוצא מחר.'), 'תודה. המשלוח יוצא מחר.');
  assert.equal(undear('הלקוח יקר לנו, ולכן יש החזרה.'), 'הלקוח יקר לנו, ולכן יש החזרה.', 'not a greeting: it stays');
  const allow = buildAllow({ toolTexts: ['- [id 1] שרוול: 129 ₪, במלאי. https://s.example/p'], customerTexts: [] });
  assert.equal(guardReply('לקוח יקר, השרוול עולה 129 ₪. https://s.example/p רוצים שאכין לכם קישור להזמנה?', allow).text, 'השרוול עולה 129 ₪. https://s.example/p', 'and the order link offered under the product\'s link goes too');
});
