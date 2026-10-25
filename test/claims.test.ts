import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAllow, guardReply } from '../src/agent/guard.ts';
import { claimLlmOn, claimPassages, verifyClaim } from '../src/agent/claims.ts';
import type { Llm, TurnReq } from '../src/agent/llm/types.ts';
import { emptyUsage } from '../src/agent/llm/types.ts';

// The claim check (claims.ts): facts with no number in them, held to the tool results. The fictional store's own
// policy pages (examples/store) as get_policy returns them, a search and a product.

const policy = `From the store's shipping page (מדיניות משלוחים, https://kli-cheres.example/policies/shipping-policy):
משלוח עד הבית בכל הארץ עולה 35 ₪. בהזמנה מעל 300 ₪ המשלוח חינם.
ההזמנה מגיעה תוך 3 עד 5 ימי עסקים. כלים שמסומנים "בהכנה" יוצאים תוך 14 ימי עסקים.
אפשר גם לאסוף מהסטודיו בקיבוץ, בלי תשלום, אחרי שמתאמים איתי.
כרגע אין משלוחים לחו"ל.

From the store's returns page (החזרות והחלפות, https://kli-cheres.example/policies/refund-policy):
אפשר להחזיר או להחליף כלי תוך 14 יום מיום קבלתו, כשהוא שלם ולא בשימוש. דמי המשלוח חזרה על חשבון הלקוח.
הגיע כלי שבור? שולחים לי תמונה בוואטסאפ תוך 48 שעות, ואני שולחת חדש או מחזירה את הכסף.

From the store's FAQ: "אפשר לשלם בביט?"
אפשר לשלם בכרטיס אשראי, בביט ובפייפאל. עד 3 תשלומים בלי ריבית בהזמנה מעל 400 ₪.
Rule: answer only with what these passages say, in your own short words. A number, a time or a condition that is not written here, you do not know. If these passages are near the question but do not answer it (the customer asked about installation and they are about shipping), say the store has not written about it, tell the customer you are checking with the store, and call handoff with reason "unknown" in this same answer.`;
const search = `3 matching products:
- [id 12] ספל חול 350 מ"ל: 89 ₪, במלאי, 3 options. https://s.example/products/sandy-mug
- [id 13] אגרטל גבוה: 210 ₪, אזל מהמלאי. https://s.example/products/tall-vase
- [id 14] צלחת הגשה אובלית: 149 ₪ (במבצע, במקום 189 ₪), במלאי. https://s.example/products/oval-platter
Rule: quote only prices and stock shown above, exactly. For sizes or colours call get_product.`;
const product = `[id 21] חולצת פשתן
Price: 189 ₪. במלאי.
Options:
  - S / לבן: 189 ₪, במלאי [variant 1]
  - M / לבן: 189 ₪, אזל מהמלאי [variant 2]
  - L / לבן: 189 ₪, במלאי [variant 3]
Link: https://s.example/products/linen-shirt
Description (the store's own words): חולצה מ-100% פשתן, לכביסה במכונה. מתאים למדיח ולמיקרוגל.
Rule: quote prices, sizes and stock only as written above. Anything the description does not say (materials, care, fit, delivery) you do not know.`;

const allow = (customerTexts: string[] = ['יש משלוח לאילת?']) => buildAllow({ toolTexts: [policy, search, product], customerTexts });
const cut = (reply: string, a = allow()) => guardReply(reply, a).redactions.find((r) => r.rule === 'claim');
const passes = (reply: string, a = allow()) => assert.equal(guardReply(reply, a).redactions.length, 0, reply);
const cuts = (reply: string, kind: string, a = allow()) => assert.equal(cut(reply, a)?.claim, kind, reply);

test('chit-chat, greetings, questions back and "I am checking" are not claims', () => {
  for (const r of [
    'היי! איך אפשר לעזור?',
    'שלום, מה שלומך?',
    'תודה רבה, יום טוב!',
    'שבת שלום!',
    'חג שמח!',
    'רוצים שאבדוק אם יש משלוח לאילת?',
    'את זה אני בודק עם החנות, ואחזור אליך כאן.',
    'העברתי את הבקשה לחנות, ויחזרו אליך כאן.',
    'את מדיניות ההחזרות לא מצאתי, אז העברתי לחנות.',
    'שולחים לי את המידה ואני בודק.',
    'אשמח לעזור עם המשלוח.',
    'הספל עולה 89 ₪. רוצים שאשלח קישור?',
    'Hi! How can I help?',
    'Happy to help with your order.',
    'Feel free to ask anything.',
    "I'm checking with the store about shipping to Eilat.",
    'Let me check if returns are free and get back to you.',
    'Do you want me to check the return policy?',
    "I don't know if it's dishwasher safe, I passed the question on.",
  ]) passes(r);
});

test('free: passes with its subject and its condition as the store wrote them; returns are not shipping', () => {
  passes('בהזמנה מעל 300 ₪ המשלוח חינם.');
  passes('המשלוח עולה 35 ₪, ומעל 300 ₪ הוא חינם.');
  passes('Shipping is free on orders over 300 ₪.');
  passes('אפשר גם לאסוף מהסטודיו בקיבוץ, בלי תשלום, אחרי שמתאמים איתי.');
  passes('Pickup from the studio is free.');
  passes('האיסוף העצמי לא עולה כלום.');
  passes('כן, אפשר לאסוף מהסטודיו. זה בחינם.', allow());
  passes('בהזמנה מעל 300 ₪? אז המשלוח חינם.');
  // "Returns are free": the store wrote free shipping over 300 and free pickup, nothing free about returns.
  const r = guardReply('ההחזרה חינם. רוצים את הקישור?', allow());
  assert.equal(r.redactions[0].rule, 'claim');
  assert.equal(r.redactions[0].claim, 'free');
  assert.equal(r.redactions[0].borderline, true, 'the tools do say "free", of something else');
  assert.ok(r.needsHandoff);
  assert.equal(r.handoffReason, 'unknown');
  assert.equal(r.text, 'את זה אני בודק עם החנות, ואחזור אליך כאן. רוצים את הקישור?');
  cuts('Returns are free.', 'free');
  cuts('The exchange is at no extra cost.', 'free');
  // The condition dropped: free only over 300 ₪.
  cuts('המשלוח חינם.', 'free');
  cuts('In that case shipping is free.', 'free');
  // Free of the other clause's subject.
  const clauses = buildAllow({ toolTexts: ['From the store\'s FAQ: "מה עם החזרות?"\nהחזרות תוך 14 יום, והמשלוח חינם.'], customerTexts: [] });
  passes('המשלוח חינם.', clauses);
  cuts('ההחזרה חינם.', 'free', clauses);
  // Free with no subject the tools ever call free.
  cuts('The 1 month pack is free.', 'free');
  cuts('זה בחינם.', 'free');
});

test('not free: backed by a cost the store wrote for the same thing', () => {
  passes('דמי המשלוח חזרה על חשבון הלקוח.');
  passes('ההחזרה לא בחינם, דמי המשלוח חזרה על הלקוח.');
  passes("Shipping isn't free under 300 ₪, it's 35 ₪.");
  const noCost = buildAllow({ toolTexts: ['From the store\'s FAQ: "יש אריזת מתנה?"\nכן, כל הזמנה נארזת כמתנה לפי בקשה.'], customerTexts: [] });
  cuts('אריזת מתנה לא בחינם.', 'free', noCost);
});

test('shipping areas: a place the policy names, with the same polarity; "all of Israel" is not Eilat', () => {
  passes('שולחים לכל הארץ.');
  passes('No problem, we ship nationwide.');
  passes('אין בעיה, שולחים לכל הארץ.');
  passes('כרגע אין משלוחים לחו"ל.');
  passes('לא, אין משלוחים לחו"ל כרגע.');
  passes("We don't ship abroad.");
  passes('אפשר לאסוף מהסטודיו בקיבוץ.');
  cuts('שולחים גם לאילת.', 'area', allow());
  cuts('We ship to Eilat.', 'area');
  cuts('Sorry, we don\'t ship to Eilat.', 'area');
  cuts('שולחים לכל הארץ חוץ מאילת.', 'area');
  cuts('We ship everywhere in Israel except Eilat.', 'area');
  const abroad = cut('שולחים לחו"ל, זה לוקח קצת יותר.');
  assert.equal(abroad?.claim, 'area');
  assert.equal(abroad?.borderline, true, 'the store does write about abroad: that it does not ship there');
  cuts('We ship worldwide.', 'area');
  // A place without shipping is not a shipping claim.
  passes('החנות נמצאת בירושלים.');
});

test('the customer\'s question is not evidence: "do you ship to Eilat?" does not let the reply say yes', () => {
  const a = buildAllow({ toolTexts: [policy], customerTexts: ['יש משלוח לאילת?', 'אתם שולחים לאילת'] });
  cuts('כן, שולחים לאילת.', 'area', a);
  const told = buildAllow({ toolTexts: [policy], customerTexts: ['אני גר באילת'] });
  cuts('כן, שולחים לאילת.', 'area', told);
});

test('delivery methods and promises with no number: express, a weekday, to the door', () => {
  passes('המשלוח מגיע עד הבית.');
  cuts('שולחים באקספרס.', 'delivery');
  cuts('ההזמנה תגיע עד שישי.', 'delivery');
  cuts('It will arrive before the holiday.', 'delivery');
  cuts('המשלוח נשלח לנקודת איסוף קרובה.', 'delivery');
  const lockers = buildAllow({ toolTexts: ['From the store\'s shipping page (Shipping, https://x.example/s):\nWe ship with a courier to your door or to a parcel locker. Express delivery in the Tel Aviv area.'], customerTexts: [] });
  passes('אפשר לקבל את המשלוח ללוקר.', lockers);
  passes('יש משלוח אקספרס באזור תל אביב.', lockers);
  passes('שולחים עד הבית עם שליח.', lockers);
});

test('returns and exchanges: possible or not as the policy says, and only on the conditions it wrote', () => {
  passes('אפשר להחזיר או להחליף תוך 14 יום, אם הכלי לא בשימוש.');
  passes("You can return it within 14 days if it's unused.");
  passes('אפשר להחזיר כל כלי.');
  passes('הגיע כלי שבור? שולחים לי תמונה, ואני שולחת חדש.');
  const no = cut('אי אפשר להחזיר כלים.');
  assert.equal(no?.claim, 'return');
  assert.equal(no?.borderline, true, 'the policy allows returns: the opposite');
  cuts('Returns are not accepted.', 'return');
  cuts('Returns need the original packaging.', 'return');
  cuts('החזרה רק עם קבלה.', 'return');
  cuts('החלפה אפשרית רק עם תווית.', 'return');
  cuts('מוצרי מבצע לא ניתנים להחזרה.', 'return');
  cuts('You get store credit for a return.', 'return');
  const none = buildAllow({ toolTexts: [search], customerTexts: [] });
  cuts('אפשר להחזיר תוך 14 יום.', 'return', none);
  // A list in the policy: its conditions are under the heading about returns.
  const list = buildAllow({ toolTexts: ['From the store\'s returns page (החזרות, https://x.example/r):\nתנאים להחזרה:\n- המוצר באריזה המקורית\n- עם התווית\nמוצרי מבצע לא ניתנים להחזרה.'], customerTexts: [] });
  passes('אפשר להחזיר באריזה המקורית ועם התווית.', list);
  passes('Sale items cannot be returned.', list);
  cuts('גם מוצרי מבצע אפשר להחזיר.', 'return', list);
});

test('warranty and guarantees: only the store\'s', () => {
  cuts('יש אחריות לשנה על כל הכלים.', 'warranty');
  cuts('אין אחריות על הכלים.', 'warranty');
  cuts("We guarantee you'll love it.", 'warranty');
  const w = buildAllow({ toolTexts: ['From the store\'s FAQ: "יש אחריות?"\nכל המוצרים באחריות יצרן לשנה.'], customerTexts: [] });
  passes('יש אחריות יצרן לשנה.', w);
  passes('The products come with a one year manufacturer warranty.', w);
  cuts('האחריות לכל החיים.', 'warranty', w);
});

test('payment methods: the store\'s list, Hebrew or English, and the customer\'s own word for how they paid', () => {
  passes('אפשר לשלם בביט או באשראי.');
  passes('You can pay with Bit or PayPal.');
  passes('אפשר לשלם בתשלומים.');
  passes('This is a bit late, sorry.');
  cuts('אפשר לשלם במזומן לשליח.', 'payment');
  cuts('We accept Apple Pay.', 'payment');
  cuts('אפשר לשלם בפייבוקס.', 'payment');
  cuts('אפשר לשלם בביט, לא במזומן.', 'payment', allow());
  // The customer said they paid with PayBox: a statement, not a question.
  const paid = allow(['היי, שילמתי בפייבוקס ועדיין לא קיבלתי אישור']);
  passes('אני רואה ששילמת בפייבוקס.', paid);
  passes('התשלום בפייבוקס עובר דרך החנות.', paid);
  const asked = allow(['אפשר לשלם בפייבוקס?']);
  cuts('כן, אפשר לשלם בפייבוקס.', 'payment', asked);
});

test('materials and product facts: from the tools\' rows and descriptions, not from what such products usually are', () => {
  passes('החולצה מפשתן.');
  passes('The shirt is 100% linen.');
  passes('הספל מתאים למדיח ולמיקרוגל.');
  passes('Yes, it is dishwasher safe.');
  cuts('The shirt is 100% cotton.', 'product');
  cuts('החולצה לא מכותנה.', 'product');
  cuts('הוא כשר.', 'product');
  cuts('כל הכלים בעבודת יד.', 'product');
  cuts('הסבון טבעוני.', 'product');
  cuts('It is gluten-free.', 'product');
  // "No products match" says the store does not carry it: the reply may say so.
  const none = buildAllow({ toolTexts: ['No products match "חולצת כותנה". What this store does carry, by type: ספלים, צלחות.\nRule: do not suggest or describe a product that is not in a result.'], customerTexts: [] });
  passes('אין לנו חולצות מכותנה.', none);
  cuts('יש לנו חולצות מכותנה.', 'product', none);
  const soap = buildAllow({ toolTexts: ['[id 3] סבון שמן זית\nPrice: 39 ₪. במלאי.\nLink: https://x.example/p\nDescription (the store\'s own words): סבון טבעוני ללא פרבנים, משמן זית כבישה קרה.'], customerTexts: [] });
  passes('הסבון טבעוני וללא פרבנים.', soap);
  passes('The soap is vegan and paraben-free.', soap);
  passes('הוא עשוי משמן זית.', soap);
  cuts('הוא ללא גלוטן.', 'product', soap);
});

test('sizes: a letter or a number the product\'s options list', () => {
  passes('יש לחולצה מידות S, M ו-L.');
  passes('We have it in L.');
  passes('A 1.5 L bottle is 89 ₪.');
  cuts('יש גם XL.', 'size');
  cuts('יש במידה 42.', 'size');
  cuts('It comes in size XS too.', 'size');
});

test('stock: said of the product the tools say the opposite of', () => {
  passes('כן, הספל במלאי.');
  passes('הספל עולה 89 ₪, ויש אותו במלאי.');
  passes('האגרטל הגבוה אזל מהמלאי כרגע.');
  passes('חולצת הפשתן במידה L במלאי.');
  const vase = cut('האגרטל הגבוה במלאי.');
  assert.equal(vase?.claim, 'stock');
  assert.equal(vase?.borderline, true);
  cuts('חולצת הפשתן במידה M במלאי.', 'stock');
  cuts('The serving platter is sold out.', 'stock', buildAllow({ toolTexts: ['- [id 14] Oval serving platter: 149 ₪, במלאי. https://s.example/p'], customerTexts: [] }));
});

test('a bare "yes" or "no" makes the claims of the customer\'s question', () => {
  const asked = (q: string) => allow([q]);
  cuts('כן, יש.', 'area', asked('יש משלוח לאילת?'));
  cuts('כן, שולחים.', 'area', asked('שולחים לאילת?'));
  passes('לא, כרגע אין.', asked('שולחים לחו"ל?'));
  passes('No, we don\'t.', asked('Do you ship abroad?'));
  cuts('Yes, we do.', 'area', asked('Do you ship abroad?'));
  passes('כן, אפשר.', asked('אפשר לשלם בביט?'));
  cuts('כן, אפשר.', 'payment', asked('אפשר לשלם בפייבוקס?'));
  cuts('כן.', 'free', asked('המשלוח חינם?'));
  passes('כן, יש במלאי.', asked('יש את ספל החול?'));
  cuts('כן, יש במלאי.', 'stock', asked('האגרטל הגבוה במלאי?'));
  passes('לא, הוא אזל.', asked('האגרטל הגבוה במלאי?'));
  cuts('כן, יש.', 'size', asked('יש את חולצת הפשתן במידה XL?'));
  passes('כן, יש.', asked('יש את חולצת הפשתן במידה L?'));
  // A "yes" to a question with no claim in it, or a "yes" followed by the facts, is not checked against the question.
  passes('כן, בשמחה.', asked('אפשר לשאול משהו?'));
  passes('כן! הספל עולה 89 ₪.', asked('יש ספל?'));
});

test('English evidence backs a Hebrew reply, and a Hebrew policy an English one', () => {
  const en = buildAllow({ toolTexts: ['From the store\'s shipping page (Shipping, https://x.example/s):\nFree shipping on all orders. We ship to Eilat with a courier. Payment by credit card or PayPal.'], customerTexts: [] });
  passes('המשלוח חינם.', en);
  passes('שולחים גם לאילת.', en);
  passes('אפשר לשלם באשראי או בפייפאל.', en);
  cuts('אפשר לשלם בביט.', 'payment', en);
  passes('Payment by credit card, Bit or PayPal.');
  passes("There's no shipping abroad at the moment.");
});

test('a company store: its "works today" list backs a claim as a tool result would', () => {
  const status = 'עובד היום: וואטסאפ של החנות, מייל. עוד לא: טלגרם. אפשר לשלם בכרטיס אשראי בלבד.';
  const a = buildAllow({ toolTexts: [], customerTexts: [], factTexts: [status] });
  assert.equal(guardReply('אפשר לשלם בכרטיס אשראי.', a, { company: true }).redactions.length, 0);
  const r = guardReply('אפשר לשלם בביט.', a, { company: true });
  assert.equal(r.redactions[0]?.rule, 'claim');
  assert.equal(r.text, 'את זה אני בודק, ומישהו מאיתנו יחזור אליך כאן.');
  // Not numbers: a fact text never allows a price.
  assert.equal(guardReply('זה עולה 99 ₪.', buildAllow({ toolTexts: [], customerTexts: [], factTexts: ['99 ₪'] }), { company: true }).redactions[0]?.rule, 'price');
});

test('an English reply gets the English line; a cut is replaced once, and a lexical cut comes first', () => {
  const en = guardReply('Returns are free. We also ship to Eilat. Anything else?', allow());
  assert.equal(en.text, "I'm checking this with the store and will update you here. Anything else?");
  assert.deepEqual(en.redactions.map((r) => r.claim), ['free', 'area']);
  const price = guardReply('ההחזרה חינם ועולה 20 ₪.', allow());
  assert.equal(price.redactions[0].rule, 'promise', 'free with a number the tools did not give is a lexical cut');
});

test('the second opinion is off by default; on, it reads the passages and only "SUPPORTED" restores a sentence', async () => {
  assert.equal(claimLlmOn({}), false);
  assert.equal(claimLlmOn({ TORAN_GUARD_LLM: '' }), false);
  assert.equal(claimLlmOn({ TORAN_GUARD_LLM: 'on' }), true);
  const a = allow();
  const passages = claimPassages('ההחזרה חינם.', a.claims!);
  assert.ok(passages.some((p) => p.includes('החזרות והחלפות') && p.includes('אפשר להחזיר')), 'the returns passage, under its header');
  assert.ok(!passages.some((p) => /^Rule:/.test(p)), 'no tool instructions');
  const seen: TurnReq[] = [];
  const fake = (answer: string): Llm => ({ backend: 'scripted', async turn(req) { seen.push(req); return { content: [{ type: 'text', text: answer }], stopReason: 'end_turn', usage: emptyUsage(), model: 'scripted', backend: 'scripted', usd: 0, apiUsd: 0 }; } });
  assert.equal((await verifyClaim(fake('SUPPORTED'), 'm', 'ההחזרה חינם.', passages)).supported, true);
  assert.equal((await verifyClaim(fake('UNSUPPORTED'), 'm', 'ההחזרה חינם.', passages)).supported, false);
  assert.equal((await verifyClaim(fake('I think it is supported'), 'm', 'ההחזרה חינם.', passages)).supported, false);
  assert.equal((await verifyClaim(fake('SUPPORTED'), 'm', 'x', [])).supported, false, 'no passages, no call');
  assert.equal(seen.length, 3);
  assert.deepEqual(seen[0].tools, []);
  assert.match(String(seen[0].messages[0].content), /ההחזרה חינם/);
  const kept = guardReply('ההחזרה חינם.', a, { verified: new Set(['ההחזרה חינם.']) });
  assert.equal(kept.redactions.length, 0);
  assert.equal(guardReply('ההחזרה חינם ב-20 ₪.', a, { verified: new Set(['ההחזרה חינם ב-20 ₪.']) }).redactions[0]?.rule, 'promise', 'the lexical rules still apply');
});
