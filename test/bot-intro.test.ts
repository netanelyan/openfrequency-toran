import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discover } from '../src/leads/discover.ts';
import { ingestStore } from '../src/ingest/pack.ts';
import { conversationFor, runTurn } from '../src/agent/loop.ts';
import { ownerReply } from '../src/channels/owner.ts';
import { checkingLine } from '../src/agent/guard.ts';
import { botLine, botName, cleanBotName, OPENING_NOTE, personLine } from '../src/agent/intro.ts';
import { DISCLOSURE } from '../src/owners/notify.ts';
import { SHARED_PROMPT, COMPANY_PROMPT } from '../src/agent/prompt.ts';
import type { Script } from '../src/agent/llm/scripted.ts';
import type { TurnReq } from '../src/agent/llm/types.ts';
import { customer, testApp } from './helpers.ts';
import { serve } from './serve.ts';

// Who is talking (src/agent/intro.ts): the bot says it is a bot when a conversation starts, a person who answers from the
// inbox is announced, and the bot says it again when it is back. The owner names the bot on "מה תורן יודע".

const PHONE = '972500000555';
const STORE = 'כלי חרס של נורית';

async function storeApp(script?: Script) {
  const app = await testApp({ script });
  await discover(app.db, (async function* () { yield { url: 'https://kli-cheres.example/', source: 'seed', detail: {} }; })(), { fetcher: app.fetcher, limit: 1 });
  const id = (await app.db.one<{ id: number }>("SELECT id FROM stores WHERE domain = 'kli-cheres.example'"))!.id;
  await ingestStore(app, id);
  await app.db.query("UPDATE stores SET brand_override = '{\"name\": \"כלי חרס של נורית\"}'::jsonb WHERE id = $1", [id]);
  return { app, id };
}

const contextOf = (req: TurnReq) => {
  const m = req.messages[req.messages.length - 1];
  return typeof m.content === 'string' ? m.content : m.content.map((b: any) => b.text || '').join('\n');
};

test('a name is letters, digits and spaces, at most 30 characters; our own support is תורן', () => {
  assert.equal(cleanBotName('  נועה  '), 'נועה');
  assert.equal(cleanBotName('Noa 2'), 'Noa 2');
  assert.equal(cleanBotName("ג'ני"), "ג'ני");
  for (const bad of ['', 'https://x.co', 'a@b.co', '!!!', '123', 'א'.repeat(31)]) assert.equal(cleanBotName(bad), null, bad);
  assert.equal(botName({ platform: 'company', agent_name: null }), 'תורן');
  assert.equal(botName({ platform: 'shopify', agent_name: null }), null);
  assert.equal(botName({ platform: 'shopify', agent_name: 'נועה' }), 'נועה');
  assert.equal(botLine('first', 'תורן', 'OpenFrequency'), DISCLOSURE, 'the owner line says the same words');
});

test('the bot opens a conversation with its line once, the model is told not to introduce itself, and a name is used', async () => {
  const asked: string[] = [];
  const { app, id } = await storeApp(async (req) => {
    asked.push(contextOf(req));
    return [{ type: 'text', text: 'יש בכחול. רוצים קישור?' }];
  });
  const conv = await conversationFor(app.db, id, 'whatsapp', PHONE);
  const first = await runTurn(app, { storeId: id, conversationId: conv, text: 'יש בכחול?', channel: 'whatsapp', footer: false });
  assert.equal(first.reply, `כאן הבוט של ${STORE}.\n\nיש בכחול. רוצים קישור?`);
  assert.ok(asked[0].includes(OPENING_NOTE));
  const second = await runTurn(app, { storeId: id, conversationId: conv, text: 'ובאדום?', channel: 'whatsapp', footer: false });
  assert.equal(second.reply, 'יש בכחול. רוצים קישור?', 'said once');
  assert.ok(!asked.at(-1)!.includes(OPENING_NOTE));

  await app.db.query("UPDATE stores SET agent_name = 'נועה' WHERE id = $1", [id]);
  const other = await conversationFor(app.db, id, 'whatsapp', '972500000556');
  const named = await runTurn(app, { storeId: id, conversationId: other, text: 'hi, do you ship abroad?', channel: 'whatsapp', footer: false });
  assert.match(named.reply, new RegExp(`^This is נועה, ${STORE}'s bot\\.\\n\\n`), 'in the customer\'s language');

  // The sample chat (no one on the other end) has no line.
  const sample = await runTurn(app, { storeId: id, conversationId: await conversationFor(app.db, id, 'cli', null), text: 'יש בכחול?' });
  assert.ok(!sample.reply.includes('הבוט של'));
  await app.db.close();
});

test('a person answering from the inbox is announced once, and the bot says it is back', async () => {
  const { app, id } = await storeApp(async () => [{ type: 'text', text: 'יש בכחול.' }]);
  const conv = await conversationFor(app.db, id, 'whatsapp', PHONE);
  await runTurn(app, { storeId: id, conversationId: conv, text: 'יש בכחול?', channel: 'whatsapp', footer: false });
  assert.ok((await ownerReply(app, conv, 'כאן נורית, יש גם בירוק', 'owner')).ok);
  assert.equal(app.wa.outbox!.at(-1)!.text, `${personLine(STORE)}\n\nכאן נורית, יש גם בירוק`);
  assert.ok((await ownerReply(app, conv, 'עוד משהו?', 'owner')).ok);
  assert.equal(app.wa.outbox!.at(-1)!.text, 'עוד משהו?', 'once per take-over');
  const kept = await app.db.query<{ text: string }>("SELECT text FROM messages WHERE conversation_id = $1 AND role = 'owner' ORDER BY id", [conv]);
  assert.equal(kept[0].text, `${personLine(STORE)}\n\nכאן נורית, יש גם בירוק`, 'the inbox shows what the customer got');

  await app.db.query('UPDATE conversations SET agent_paused_until = NULL WHERE id = $1', [conv]);
  const back = await runTurn(app, { storeId: id, conversationId: conv, text: 'ובאדום?', channel: 'whatsapp', footer: false });
  assert.equal(back.reply, `כאן שוב הבוט של ${STORE}.\n\nיש בכחול.`);
  await app.db.close();
});

test('the honest line says the bot is not sure and a person will answer, never why', () => {
  const store = checkingLine(false);
  const ours = checkingLine(false, true);
  assert.equal(store, 'על זה אני לא בטוח, אז העברתי את השאלה לנציג מהחנות. הוא יחזור אליך כאן.');
  assert.equal(ours, 'על זה אני לא בטוח, אז העברתי את השאלה לנציג שלנו. הוא יחזור אליך כאן.');
  for (const t of [store, ours, SHARED_PROMPT, COMPANY_PROMPT]) assert.ok(!/לא כתבנו|לא ברשימה|אני בודק עם|אני בודק את זה/.test(t), t.slice(0, 60));
  assert.match(SHARED_PROMPT, /Never say why you do not know/);
  assert.match(COMPANY_PROMPT, /Never say why you do not know/);
});

test('the owner names the bot on "מה תורן יודע", and a bad name is refused', async () => {
  const s = await serve();
  try {
    const a = s.seeded.storeId;
    await s.app.db.query('UPDATE stores SET workspace_id = 1 WHERE id = $1', [a]);
    s.as(s.accounts.session(customer(1)).cookie);
    const page = await (await s.get(`/lead/${a}/knowledge`)).text();
    assert.match(page, /השם של הבוט/);
    assert.match(page, /name="agent_name"/);
    const ok = await s.post(`/lead/${a}/bot-name`, { _csrf: await s.csrf(`/lead/${a}/knowledge`), agent_name: 'נועה' });
    assert.equal(ok.status, 303);
    assert.equal((await s.app.db.one<{ agent_name: string }>('SELECT agent_name FROM stores WHERE id = $1', [a]))!.agent_name, 'נועה');
    assert.match(await (await s.get(`/lead/${a}/knowledge`)).text(), /כאן נועה, הבוט של/);
    await s.post(`/lead/${a}/bot-name`, { _csrf: await s.csrf(`/lead/${a}/knowledge`), agent_name: 'https://evil.example' });
    assert.equal((await s.app.db.one<{ agent_name: string }>('SELECT agent_name FROM stores WHERE id = $1', [a]))!.agent_name, 'נועה');
    assert.equal((await s.post(`/lead/${a}/bot-name`, { _csrf: await s.csrf(`/lead/${a}/knowledge`), agent_name: '' })).status, 303);
    assert.equal((await s.app.db.one<{ agent_name: string | null }>('SELECT agent_name FROM stores WHERE id = $1', [a]))!.agent_name, null);
  } finally {
    await s.close();
  }
});
