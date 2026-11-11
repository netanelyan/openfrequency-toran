import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discover } from '../src/leads/discover.ts';
import { ingestStore } from '../src/ingest/pack.ts';
import { conversationFor, runTurn } from '../src/agent/loop.ts';
import { buildAllow, cantAnswerLine, checkingLine, guardReply } from '../src/agent/guard.ts';
import { DEMO_NOTE } from '../src/agent/prompt.ts';
import type { Script } from '../src/agent/llm/scripted.ts';
import type { TurnReq } from '../src/agent/llm/types.ts';
import { testApp } from './helpers.ts';

// Toran's own lines say what is true (the audit of 2026-11-12): in a demo on our number nothing is passed on, so it says
// what would happen with a real customer, never that someone will reply there (P1-22); when the model gives nothing at
// all, Toran says it cannot answer now, not that it is unsure about a plain "היי" (P2-29); and nothing left after a quiet
// cut is a greeting back, not "במה אפשר לעזור?".

const REAL = 'אצל לקוח אמיתי השאלה הייתה עוברת עכשיו אליכם, ואתם עונים לו.';
const LIVE = 'אז העברתי את השאלה לנציג מהחנות. הוא יחזור אליך כאן.';

async function storeApp(script: Script) {
  const app = await testApp({ script });
  await discover(app.db, (async function* () { yield { url: 'https://kli-cheres.example/', source: 'seed', detail: {} }; })(), { fetcher: app.fetcher, limit: 1 });
  const id = (await app.db.one<{ id: number }>("SELECT id FROM stores WHERE domain = 'kli-cheres.example'"))!.id;
  await ingestStore(app, id);
  return { app, id };
}

const lastBlocks = (req: TurnReq) => {
  const m = req.messages[req.messages.length - 1];
  return typeof m.content === 'string' ? [{ type: 'text', text: m.content } as any] : m.content;
};

test('in a demo the guard\'s honest lines say what a real customer would get; on the store\'s own channels they stay', () => {
  const noStock = buildAllow({ toolTexts: [], customerTexts: ['יש לכם ספל ירוק?'] });
  const asked = 'יש לכם ספל ירוק?';
  assert.equal(guardReply('כן, יש במלאי.', noStock, { asked }).text, `על המלאי אני לא בטוח, ${LIVE}`);
  assert.equal(guardReply('כן, יש במלאי.', noStock, { asked, demo: true }).text, `על המלאי אני לא בטוח. ${REAL}`);
  assert.equal(checkingLine(false, false, true), `על זה אני לא בטוח. ${REAL}`);
  assert.equal(checkingLine(false), `על זה אני לא בטוח, ${LIVE}`, 'the live line as before');
  assert.equal(checkingLine(false, true, true), checkingLine(false, true), 'our support is never a demo');

  // The model's own habit, the live line, in a demo: the promise of a reply goes, and the demo's line takes its place.
  assert.equal(guardReply(`על זה אני לא בטוח, ${LIVE}`, noStock, { asked, demo: true }).text, `על זה אני לא בטוח. ${REAL}`);
  assert.equal(guardReply('אני הבוט של החנות. העברתי את השיחה לנציג, והוא יחזור אליך כאן.', noStock, { asked: 'אני מדבר עם בן אדם?', demo: true }).text, `אני הבוט של החנות. ${REAL}`);
  assert.equal(guardReply("I'm not sure about that, so I've passed your question to someone from the store. They'll reply here.", noStock, { asked: 'do you ship abroad?', demo: true }).text, "I'm not sure about that. With a real customer, this question would now go to you, and you'd answer it.");
  const plain = 'יש בכחול. רוצים קישור?';
  assert.equal(guardReply(plain, noStock, { asked, demo: true }).text, plain, 'an answer with nothing passed on stays as it is');
});

test('"על המלאי אני לא בטוח" is no claim about the stock: the model\'s own honest line is not cut and doubled', () => {
  const noStock = buildAllow({ toolTexts: [], customerTexts: ['יש במלאי?'] });
  const line = `על המלאי אני לא בטוח, ${LIVE}`;
  const g = guardReply(line, noStock, { asked: 'יש במלאי?' });
  assert.equal(g.redactions.length, 0);
  assert.equal(g.text, line, 'once, not "הוא יחזור אליך כאן. הוא יחזור אליך כאן."');
  assert.equal(guardReply('על המלאי אני לא בטוח, אבל יש במלאי.', noStock, { asked: 'יש במלאי?' }).redactions[0]?.rule, 'stock', 'a claim after it is still cut');
});

test('a demo turn: the tools and the SERVER CONTEXT say nobody will reply there, and the reply says what a real customer would get', async () => {
  const seen: string[] = [];
  const script: Script = (req) => {
    const blocks = lastBlocks(req);
    const result = blocks.find((b: any) => b.type === 'tool_result');
    if (result) {
      seen.push(String(result.content));
      return [{ type: 'text', text: `על זה אני לא בטוח, ${LIVE}` }];
    }
    seen.push(blocks.map((b: any) => b.text || '').join('\n'));
    return [{ type: 'tool_use', id: `h${seen.length}`, name: 'handoff', input: { reason: 'unknown', summary: 'שאלה על איסוף' } } as any];
  };
  const { app, id } = await storeApp(script);
  try {
    const demo = await runTurn(app, { storeId: id, conversationId: await conversationFor(app.db, id, 'whatsapp', '972500000571'), text: 'אפשר לאסוף מהסטודיו?' });
    assert.ok(seen[0].includes(DEMO_NOTE), 'the demo note rides in the SERVER CONTEXT');
    assert.match(DEMO_NOTE, /Never say that someone will get back to them here/);
    assert.match(seen[1], /nobody will reply in this conversation/);
    assert.doesNotMatch(seen[1], /someone from the store will get back/);
    assert.equal(demo.handoff?.reason, 'unknown', 'still recorded as a handoff');
    assert.match(demo.reply, new RegExp(`על זה אני לא בטוח\\. ${REAL}`));
    assert.doesNotMatch(demo.reply, /יחזור אליך כאן/);

    seen.length = 0;
    const live = await runTurn(app, { storeId: id, conversationId: await conversationFor(app.db, id, 'whatsapp', '972500000572'), text: 'אפשר לאסוף מהסטודיו?', channel: 'whatsapp', footer: false });
    assert.match(seen[1], /someone from the store will get back to them here/);
    assert.match(live.reply, new RegExp(`על זה אני לא בטוח, ${LIVE.replace(/\./g, '\\.')}$`));
  } finally {
    await app.db.close();
  }
});

test('the model gives nothing: Toran says it cannot answer now, on a "היי" too, in the store\'s plural, and in a demo what a real customer would get', async () => {
  const { app, id } = await storeApp(() => []);
  try {
    const live = await runTurn(app, { storeId: id, conversationId: await conversationFor(app.db, id, 'whatsapp', '972500000573'), text: 'היי', channel: 'whatsapp', footer: false });
    assert.match(live.reply, /\n\nכרגע אני לא מצליח לענות, אז העברתי את ההודעה לנציג מהחנות\. הוא יחזור אליך כאן\.$/);
    assert.doesNotMatch(live.reply, /לא בטוח/);
    assert.ok(live.handoff, 'and the owner gets it');

    const demo = await runTurn(app, { storeId: id, conversationId: await conversationFor(app.db, id, 'whatsapp', '972500000574'), text: 'היי' });
    assert.match(demo.reply, /\n\nכרגע אני לא מצליח לענות\. אצל לקוח אמיתי ההודעה הייתה עוברת עכשיו אליכם, ואתם עונים לו\.\n\n_דמו של תורן_$/);

    await app.db.query(`UPDATE stores SET config = config || '{"voiceChoice": {"preset": "warm"}}'::jsonb, updated_at = now() WHERE id = $1`, [id]);
    const plural = await runTurn(app, { storeId: id, conversationId: await conversationFor(app.db, id, 'whatsapp', '972500000575'), text: 'היי', channel: 'whatsapp', footer: false });
    assert.match(plural.reply, /הוא יחזור אליכם כאן\.$/);
    assert.equal(cantAnswerLine(true, true), "I can't answer right now, so I've passed your message to someone from our team. They'll reply here.");
  } finally {
    await app.db.close();
  }
});

test('nothing left after a quiet cut, and nothing asked: a greeting back', () => {
  const noStock = buildAllow({ toolTexts: [], customerTexts: ['היי!'] });
  assert.equal(guardReply('יש לנו הכול במלאי.', noStock, { asked: 'היי!' }).text, 'היי, מה מחפשים?');
  assert.equal(guardReply('יש לנו הכול במלאי.', noStock, { asked: 'היי!', company: true }).text, 'היי, על מה רוצים לשאול?');
  assert.equal(guardReply('We have everything in stock.', buildAllow({ toolTexts: [], customerTexts: ['hi'] }), { asked: 'hi' }).text, 'Hi, what are you looking for?');
});
