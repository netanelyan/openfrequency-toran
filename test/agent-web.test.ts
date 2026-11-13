import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discover } from '../src/leads/discover.ts';
import { ingestStore } from '../src/ingest/pack.ts';
import { conversationFor, runTurn } from '../src/agent/loop.ts';
import { ownerReply } from '../src/channels/owner.ts';
import { SHARED_PROMPT } from '../src/agent/prompt.ts';
import type { Script } from '../src/agent/llm/scripted.ts';
import type { TurnReq } from '../src/agent/llm/types.ts';
import { testApp } from './helpers.ts';

// The chat on the store's own site (channels/web.ts) is a channel of its own to the model, never WhatsApp (the audit of
// 2026-11-12, P1-9): plain text, no photos, and a visitor who may close the page, so a handoff there asks how to reach
// them. Its header already says a bot answers, so the bot's first line is left out there (P2-8).

const VISITOR = 'Abcdefghijklmnopqrstuv';
const STORE = 'כלי חרס של נורית';

async function storeApp(script: Script) {
  const app = await testApp({ script });
  await discover(app.db, (async function* () { yield { url: 'https://kli-cheres.example/', source: 'seed', detail: {} }; })(), { fetcher: app.fetcher, limit: 1 });
  const id = (await app.db.one<{ id: number }>("SELECT id FROM stores WHERE domain = 'kli-cheres.example'"))!.id;
  await ingestStore(app, id);
  await app.db.query("UPDATE stores SET brand_override = '{\"name\": \"כלי חרס של נורית\"}'::jsonb WHERE id = $1", [id]);
  return { app, id };
}

/** What the app told the model this turn: the SERVER CONTEXT block before the customer's words. */
const contextOf = (req: TurnReq) => {
  const m = req.messages[req.messages.length - 1];
  return typeof m.content === 'string' ? m.content : m.content.map((b: any) => b.text || '').join('\n');
};
const handedOff = (req: TurnReq) => {
  const m = req.messages[req.messages.length - 1];
  return Array.isArray(m.content) && m.content.some((b: any) => b.type === 'tool_result');
};

test('a site chat turn is told it is the chat on the store\'s website, and the system prompt does not call every channel WhatsApp', async () => {
  const seen: TurnReq[] = [];
  const { app, id } = await storeApp((req) => (seen.push(req), [{ type: 'text', text: 'יש בכחול. רוצים קישור?' }]));
  try {
    const conv = await conversationFor(app.db, id, 'web', VISITOR);
    await runTurn(app, { storeId: id, conversationId: conv, text: 'יש בכחול?', channel: 'web', footer: false });
    const ctx = contextOf(seen[0]);
    assert.match(ctx, /Channel: the chat on the store's own website\./);
    assert.match(ctx, /never ask for one/, 'no photos or files on the site chat');
    assert.match(ctx, /ask in the same reply for a phone number or an email/);
    assert.doesNotMatch(ctx, /WhatsApp/, 'nothing in the turn says WhatsApp');
    const system = seen[0].system.map((p) => p.text).join('\n');
    assert.doesNotMatch(system, /You are the WhatsApp assistant|on WhatsApp:/);
    assert.match(SHARED_PROMPT, /on the channel the SERVER CONTEXT names/);

    // The store's own WhatsApp still says so.
    const wa = await conversationFor(app.db, id, 'whatsapp', '972500000561');
    await runTurn(app, { storeId: id, conversationId: wa, text: 'יש בכחול?', channel: 'whatsapp', footer: false });
    assert.match(contextOf(seen.at(-1)!), /Channel: the store's WhatsApp\./);
  } finally {
    await app.db.close();
  }
});

test("on the site chat the bot's first line is left out (the header says it), and the line after a person answered stays", async () => {
  const { app, id } = await storeApp(async () => [{ type: 'text', text: 'יש בכחול.' }]);
  try {
    const conv = await conversationFor(app.db, id, 'web', VISITOR);
    const first = await runTurn(app, { storeId: id, conversationId: conv, text: 'יש בכחול?', channel: 'web', footer: false });
    assert.equal(first.reply, 'יש בכחול.');
    assert.ok((await app.db.one<{ introduced_at: string | null }>('SELECT introduced_at FROM conversations WHERE id = $1', [conv]))!.introduced_at, 'counted as said: the header said it');
    const second = await runTurn(app, { storeId: id, conversationId: conv, text: 'ובאדום?', channel: 'web', footer: false });
    assert.equal(second.reply, 'יש בכחול.');

    assert.ok((await ownerReply(app, conv, 'כאן נורית, יש גם בירוק', 'owner')).ok);
    await app.db.query('UPDATE conversations SET agent_paused_until = NULL WHERE id = $1', [conv]);
    const back = await runTurn(app, { storeId: id, conversationId: conv, text: 'ובצהוב?', channel: 'web', footer: false });
    assert.equal(back.reply, `זה שוב הבוט של ${STORE}.\n\nיש בכחול.`, 'after a person, the visitor is told the bot is back');

    // Every other channel keeps the first line.
    const wa = await conversationFor(app.db, id, 'whatsapp', '972500000562');
    const onWa = await runTurn(app, { storeId: id, conversationId: wa, text: 'יש בכחול?', channel: 'whatsapp', footer: false });
    assert.equal(onWa.reply, `היי, אני הבוט של ${STORE}.\n\nיש בכחול.`);
  } finally {
    await app.db.close();
  }
});

test('a handoff on the site chat asks how to reach the visitor, unless the reply asks already or they gave a phone or an email', async () => {
  const handoff: Script = (req) => (handedOff(req) ? [{ type: 'text', text: 'על זה אני לא בטוח, אז העברתי את השאלה לנציג מהחנות. הוא יחזור אליך כאן.' }] : [{ type: 'tool_use', id: `h${Date.now()}`, name: 'handoff', input: { reason: 'unknown', summary: 'שאלה על איסוף' } } as any]);
  const { app, id } = await storeApp(handoff);
  try {
    const conv = await conversationFor(app.db, id, 'web', VISITOR);
    const o = await runTurn(app, { storeId: id, conversationId: conv, text: 'אפשר לאסוף מהסטודיו?', channel: 'web', footer: false });
    assert.equal(o.handoff?.reason, 'unknown');
    assert.equal(o.reply, 'על זה אני לא בטוח, אז העברתי את השאלה לנציג מהחנות. הוא יחזור אליך כאן. אפשר להשאיר כאן טלפון או מייל, כדי שיחזרו אליך גם אם הדף ייסגר.');

    // A phone given in the conversation: nothing more to ask.
    const other = await conversationFor(app.db, id, 'web', 'Zbcdefghijklmnopqrstuv');
    const given = await runTurn(app, { storeId: id, conversationId: other, text: 'אפשר לאסוף מהסטודיו? הטלפון שלי 050-000-0563', channel: 'web', footer: false });
    assert.doesNotMatch(given.reply, /אפשר להשאיר כאן טלפון/);

    // On the store's WhatsApp the number is already the way back.
    const wa = await conversationFor(app.db, id, 'whatsapp', '972500000564');
    const onWa = await runTurn(app, { storeId: id, conversationId: wa, text: 'אפשר לאסוף מהסטודיו?', channel: 'whatsapp', footer: false });
    assert.doesNotMatch(onWa.reply, /אפשר להשאיר כאן טלפון/);
  } finally {
    await app.db.close();
  }

  // The model asked for it itself: said once.
  const asks: Script = (req) => (handedOff(req) ? [{ type: 'text', text: 'העברתי את השאלה לנציג מהחנות. אפשר להשאיר כאן טלפון, והוא יחזור אליך.' }] : [{ type: 'tool_use', id: `h${Date.now()}`, name: 'handoff', input: { reason: 'unknown', summary: 'x' } } as any]);
  const two = await storeApp(asks);
  try {
    const conv = await conversationFor(two.app.db, two.id, 'web', VISITOR);
    const o = await runTurn(two.app, { storeId: two.id, conversationId: conv, text: 'אפשר לאסוף מהסטודיו?', channel: 'web', footer: false });
    assert.equal(o.reply, 'העברתי את השאלה לנציג מהחנות. אפשר להשאיר כאן טלפון, והוא יחזור אליך.');
  } finally {
    await two.app.db.close();
  }
});
