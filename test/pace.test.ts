import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asksRemoval, asksToStop } from '../src/core/stopWords.ts';
import { machinePaced, markedBot, nothingToAnswer } from '../src/channels/pace.ts';

// What reads as "stop", as a bot, and as nothing to answer (core/stopWords.ts, channels/pace.ts), from the trace of
// 2026-11-17: a store's own AI bot and ours wrote to each other 17 times in four minutes, and "מהר הסר" was answered as
// a question. The bot's lines here are made up, in the shape it wrote in.

test('"remove me" in the words people use, and the questions that only sound like it', () => {
  for (const t of ['הסר', 'מהר הסר', 'הסר בבקשה', 'הסר!!!', 'הסירו אותי', 'תסירו אותי מהרשימה בבקשה', 'אני רוצה להסיר את עצמי מהרשימה', 'תורידו אותי מהרשימה', 'תוציאו אותי מהתפוצה', 'תמחקו את המספר שלי', 'אל תכתבו לי יותר', 'לא לשלוח יותר הודעות', 'תפסיקו לשלוח לי הודעות', 'STOP', 'stop please', 'please remove me', 'I want to unsubscribe', 'ותסירו אותי']) {
    assert.equal(asksRemoval(t), true, t);
    assert.equal(asksToStop(t), true, t);
  }
  for (const t of ['רוצה להסיר את המוצר מההזמנה', 'תוריד את המחיר', 'איך מסירים מוצר מהעגלה?', 'תשלחו', 'כן, תשלחו', 'לא', 'לא, תודה', 'אפשר לשלוח לי את הקישור שוב?', 'מספיק לי אחד', 'הסרה של מוצר', 'Ghh', '']) {
    assert.equal(asksRemoval(t), false, t);
  }
});

test('"enough" stops us only where we wrote first: never a store\'s own opt-out', () => {
  for (const t of ['חאלס', 'די', 'די כבר', 'נו די', 'מספיק', 'תפסיקו', 'עזבו אותי', 'ספאם', 'זה ספאם', "ח'לאס", 'enough']) {
    assert.equal(asksToStop(t), true, t);
    assert.equal(asksRemoval(t), false, `${t}: a store's customer may say it of anything`);
  }
  assert.equal(asksToStop('די, הבנתי, איך מתחילים?'), false, 'a question after it is a question');
});

test('a bot by its pace and its words; a person who writes fast, or long and slowly, is a person', () => {
  const bot = 'נעים להכיר! אפשר לבדוק איתי כל דבר - לשאול על *זמני משלוח*, על *מוצרי עץ* או על הזמנה קיימת. במה אוכל לעזור?';
  assert.equal(machinePaced(bot.length, 8_000), true, '100 characters in 8 seconds');
  assert.equal(machinePaced(bot.length, 60_000), false, 'a minute is a person');
  assert.equal(machinePaced(22, 3_000), false, 'a short line can be quick');
  assert.equal(machinePaced(bot.length, 400), false, 'written before ours reached them');
  assert.equal(machinePaced(bot.length, null), false, 'nothing of ours before it');
  assert.equal(markedBot(bot), true, 'its bold');
  for (const t of ['אני כאן כדי לתת שירות ללקוחות החנות', 'אני זמינה כאן לעזור לכל לקוח', 'התפקיד שלי הוא לעזור ללקוחות', 'אני מיועדת לספק שירות לקוחות', 'הטכנולוגיה שלי מופעלת על ידי חברה חיצונית', 'אני העוזרת הדיגיטלית של החנות', "Hi, I'm an AI assistant", 'שירות הלקוחות שלנו פעיל בין השעות 9 ל-17, ונחזור אליכם בהקדם']) {
    assert.equal(markedBot(t), true, t);
  }
  for (const t of ['רגע, כמה זה עולה?', 'זה בוט?', 'אתם בוט או בן אדם?', 'היי, כאן דנה מהחנות', 'לא הבנתי מה אתם מציעים']) {
    assert.equal(markedBot(t), false, t);
  }
});

test('what asks nothing: a sign, a thanks, laughter, a few letters of nothing; a question or a word always asks', () => {
  for (const t of ['👍', '🙏🏻', 'תודה', 'תודה רבה!', 'קיבלתי', 'אוקיי', 'Ghh', 'חחחח', 'ok']) assert.equal(nothingToAnswer(t), true, t);
  for (const t of ['?', 'כמה?', 'כן', 'לא', 'hi', 'מעולה, איך מתחילים?', 'מה זה?', '123', '']) assert.equal(nothingToAnswer(t), false, t);
});
