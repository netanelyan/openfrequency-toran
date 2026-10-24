import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mentioned, readReply, type Intent } from '../src/owners/intents.ts';

// The owner's replies about their posts, read in code (src/owners/intents.ts): twenty-odd messages the way owners
// write them on WhatsApp, against the list they last saw. A message the reader is not sure of must come back
// 'unclear' (the model takes it, under the same number check), never as a guess.

const A = (n: number): Intent => ({ kind: 'approve', n });
const R = (n: number, reason: string, note = ''): Intent => ({ kind: 'reject', n, reason, note }) as Intent;

const CASES: [string, number, Intent[] | 'unclear' | 'none' | ['out_of_range', number]][] = [
  ['אשר את 1 ו-3, את 2 תעשה קצר יותר', 3, [A(1), R(2, 'shorter', 'תעשה קצר יותר'), A(3)]],
  ['מאשרת את כולן', 3, [A(1), A(2), A(3)]],
  ['את 2 לא, השאר מעולות', 3, [A(1), R(2, 'other'), A(3)]],
  ['1 ו-2 טובות. 3 לא מתאימה לנו בכלל', 3, [A(1), A(2), R(3, 'other', 'לא מתאימה לנו בכלל')]],
  ['תאשר את הראשונה', 3, [A(1)]],
  ['השנייה ארוכה מדי, תקצר', 3, [R(2, 'shorter', 'ארוכה מדי, תקצר')]],
  ['אשר הכל חוץ מ-3', 3, [A(1), A(2)]],
  ['את 3 תחליף את התמונה', 3, [R(3, 'photo', 'תחליף את התמונה')]],
  ['1 סבבה', 3, [A(1)]],
  ['דחה את 2 ואת 3', 3, [R(2, 'other'), R(3, 'other')]],
  ['את 1 כן ואת 2 לא', 3, [A(1), R(2, 'other')]],
  ['2 יותר קליל, פחות רשמי', 3, [R(2, 'tone', 'יותר קליל, פחות רשמי')]],
  ['אשר את 1 ותדחה את 2', 3, [A(1), R(2, 'other')]],
  ['תודה, אשר את שתיהן', 2, [A(1), A(2)]],
  ['אשר את 1, את 2 עוד לא', 3, [A(1)]],
  ['3 לא רלוונטי לחנות שלנו', 3, [R(3, 'topic', 'לא רלוונטי לחנות שלנו')]],
  ['מאשר', 1, [A(1)]],
  ['במצגת 1, שקופית 2, שורה 1: "3 טעויות שכולם עושים"', 3, [{ kind: 'edit', n: 1, slide: 2, line: 1, text: '3 טעויות שכולם עושים' }]],
  ['ב-2 בשקופית השלישית תשנה את הכותרת ל: מבצע סוף עונה', 3, [{ kind: 'edit', n: 2, slide: 3, line: 1, text: 'מבצע סוף עונה' }]],
  ['שלח את 2 מוכן לפרסום', 3, [{ kind: 'bundle', n: 2 }]],
  ['שלח', 1, [{ kind: 'bundle', n: 1 }]],
  ['הצג', 3, [{ kind: 'show' }]],
  ['סטטוס', 0, [{ kind: 'status' }]],
  ['אשר את 4', 3, ['out_of_range', 4]],
  // Not the reader's to answer: questions, a "don't", something it cannot place, a thought not finished.
  ['למה השלישית יצאה כל כך ארוכה?', 3, 'unclear'],
  ['אל תאשר את 2', 3, 'unclear'],
  ['כמה מצגות אישרתי השבוע', 3, 'unclear'],
  ['את 2 אני עוד חושב עליה', 3, 'unclear'],
  ['אשר', 3, 'unclear'],
  ['ב-3 תעשה טון יותר מצחיק ותחליף את התמונה של השקופית הראשונה', 3, 'unclear'],
  ['סבבה', 3, 'none'],
  ['מה קרה היום בחנות', 0, 'none'],
];

test('owner replies about posts, read in code', () => {
  for (const [text, size, want] of CASES) {
    const got = readReply(text, size);
    if (want === 'unclear' || want === 'none') {
      assert.equal(got.ok ? 'ok' : got.why, want, `"${text}" → ${JSON.stringify(got)}`);
    } else if (!Array.isArray(want[0]) && typeof want[0] === 'string') {
      assert.deepEqual(got, { ok: false, why: want[0], detail: want[1] }, `"${text}"`);
    } else {
      assert.deepEqual(got, { ok: true, intents: want }, `"${text}"`);
    }
  }
  assert.ok(CASES.length >= 20);
});

test('the numbers a message names, which the model may act on and no others', () => {
  assert.deepEqual([...mentioned('אשר את 1 ו-3', 3)].sort(), [1, 3]);
  assert.deepEqual([...mentioned('את כולן חוץ מהשנייה', 3)].sort(), [1, 3]);
  assert.deepEqual([...mentioned('תעשה אותה קצרה יותר', 1)], [1], 'a list of one: "it" is the one');
  assert.deepEqual([...mentioned('תעשה אותה קצרה יותר', 3)], [], 'a list of three: "it" names none');
  assert.deepEqual([...mentioned('את 7', 3)], [], 'not on the list');
});
