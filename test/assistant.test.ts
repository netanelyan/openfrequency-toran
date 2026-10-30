import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discover } from '../src/leads/discover.ts';
import { ingestStore } from '../src/ingest/pack.ts';
import { buildPitch } from '../src/pitch/build.ts';
import { handleInbound } from '../src/channels/route.ts';
import { simEmail } from '../src/channels/email.ts';
import { storeAddress } from '../src/channels/config.ts';
import { ask, unsourced } from '../src/assistant/index.ts';
import { overview, waiting, who } from '../src/assistant/data.ts';
import { scriptedClient, type Script } from '../src/agent/llm/scripted.ts';
import type { Block, TurnReq } from '../src/agent/llm/types.ts';
import { testApp } from './helpers.ts';

// The owner's assistant: it answers the owner from Toran's own records, and does a thing only when the owner's next
// message is "כן". The model here is a script, so each test drives it down one path.

const DOMAIN = 'in.toran.test';
const CUSTOMER = 'dana@example.test';
let seq = 0;

const toolUse = (name: string, input: Record<string, unknown>): Block[] => [{ type: 'tool_use', id: `t${seq++}`, name, input }];
const say = (text: string): Block[] => [{ type: 'text', text }];
const lastResult = (req: TurnReq) => {
  const last = req.messages[req.messages.length - 1];
  return Array.isArray(last.content) ? String((last.content.find((b: any) => b.type === 'tool_result') as any)?.content || '') : '';
};

/** The fictional store with its email connected, a scripted model, and one customer question handed to the owner. */
async function setup(script?: Script) {
  const app = await testApp();
  app.env.TORAN_CHANNELS = 'whatsapp,email';
  app.mail = simEmail({ domain: DOMAIN });
  await discover(app.db, (async function* () { yield { url: 'https://kli-cheres.example/', source: 'seed', detail: {} }; })(), { fetcher: app.fetcher, limit: 1 });
  const storeId = (await app.db.one<{ id: number }>("SELECT id FROM stores WHERE domain = 'kli-cheres.example'"))!.id;
  await ingestStore(app, storeId);
  await buildPitch(app, storeId);
  const store = (await app.db.one<{ id: number; slug: string }>('SELECT id, slug FROM stores WHERE id = $1', [storeId]))!;
  const address = storeAddress(store, DOMAIN);
  await app.db.query("INSERT INTO channel_accounts (store_id, channel, kind, external_id, name) VALUES ($1, 'email', 'sim', $2, 'כלי חרס של נורית')", [storeId, address]);
  // A question the site doesn't answer: Toran keeps it for the owner (a file with no words is handed over).
  const mail = simEmail({ domain: DOMAIN }).parse({ raw: JSON.stringify({ from: `Dana <${CUSTOMER}>`, to: [address], subject: 'איסוף', text: '', attachments: [{ filename: 'map.jpg', content_type: 'image/jpeg', size: 1000 }], message_id: `<m${seq++}@example.test>` }), form: {}, headers: {}, url: '' })![0];
  await handleInbound(app, mail);
  const conv = (await app.db.one<{ id: number }>('SELECT id FROM conversations WHERE peer = $1', [CUSTOMER]))!.id;
  // The customer's question in words, beside the file: what an answer the owner keeps is the answer to.
  await app.db.query("INSERT INTO messages (conversation_id, role, text) VALUES ($1, 'customer', 'אפשר לאסוף מהסטודיו?')", [conv]);
  // The test's script from here on: building the pitch page above used the model too.
  if (script) app.llm = scriptedClient(script);
  return { app, storeId, conv };
}

test('what the assistant reads: a customer named by a part of their address, the overview, the questions waiting', async () => {
  const { app, storeId, conv } = await setup();
  try {
    assert.equal(who('whatsapp', '972500000123'), 'לקוח בוואטסאפ (…0123)');
    assert.equal(who('email', 'dana@example.test'), 'לקוח במייל (da…@example.test)');
    const w = (await waiting(app.db, storeId)) as string;
    assert.match(w, /Questions waiting for the owner: 1\./);
    assert.match(w, new RegExp(`\\[conversation ${conv}\\] לקוח במייל`));
    assert.doesNotMatch(w, /dana@example\.test/, 'never the whole address');
    const o = await overview(app.db, storeId, 1);
    assert.match(o, /Customer conversations in the last 24 hours: 1\./);
    assert.match(o, /Questions waiting for the owner now: 1\./);
  } finally {
    await app.db.close();
  }
});

test('the owner asks, the assistant proposes an answer, and only "כן" sends it, keeps it as the answer, and pauses Toran there', async () => {
  let convId = 0;
  const script: Script = (req, call) => {
    if (call === 0) return toolUse('waiting_questions', {});
    if (call === 1) {
      convId = Number(/\[conversation (\d+)\]/.exec(lastResult(req))?.[1]);
      return toolUse('propose_action', { kind: 'answer_customer', conversation_id: convId, text: 'כן, אפשר לאסוף מהסטודיו בתיאום מראש.', remember: true });
    }
    if (call === 2) return say('אשלח ללקוח במייל: "כן, אפשר לאסוף מהסטודיו בתיאום מראש." כתבו כן כדי שאשלח.');
    return say('אין עוד שאלות שמחכות לכם.');
  };
  const { app, storeId, conv } = await setup(script);
  try {
    const first = await ask(app, { storeId, text: 'יש שאלות שמחכות לי? תענה ללקוח שאפשר לאסוף מהסטודיו בתיאום מראש', via: 'dashboard', author: 'נורית' });
    assert.match(first, /כתבו כן/);
    assert.equal(convId, conv);
    assert.equal(app.mail!.outbox!.length, 0, 'nothing is sent before "כן"');
    const pending = await app.db.one<any>("SELECT * FROM assistant_actions WHERE store_id = $1 AND status = 'pending'", [storeId]);
    assert.equal(pending.kind, 'answer_customer');
    assert.match(pending.summary, /^לשלוח ללקוח במייל \(da…@example\.test\)/);

    const yes = await ask(app, { storeId, text: 'כן', via: 'dashboard', author: 'נורית' });
    assert.match(yes, /^נשלח\./);
    assert.match(yes, /שמרתי את התשובה/);
    assert.equal(app.mail!.outbox!.at(-1)!.text, 'כן, אפשר לאסוף מהסטודיו בתיאום מראש.');
    assert.equal((await app.db.one<any>('SELECT status FROM assistant_actions WHERE id = $1', [pending.id])).status, 'done');
    assert.ok((await app.db.one<any>('SELECT agent_paused_until FROM conversations WHERE id = $1', [conv])).agent_paused_until, 'Toran steps back in that conversation');
    assert.equal((await app.db.one<any>("SELECT answer FROM faqs WHERE store_id = $1 AND answer IS NOT NULL ORDER BY id DESC LIMIT 1", [storeId])).answer, 'כן, אפשר לאסוף מהסטודיו בתיאום מראש.');
    assert.match((await waiting(app.db, storeId)) as string, /No questions are waiting/, 'answered: no longer waiting');

    // A second "כן" has nothing to approve: the model answers, nothing is sent again.
    await ask(app, { storeId, text: 'כן', via: 'dashboard', author: 'נורית' });
    assert.equal(app.mail!.outbox!.length, 1);
    const kept = await app.db.query<any>('SELECT role FROM assistant_messages WHERE store_id = $1 ORDER BY id', [storeId]);
    assert.deepEqual(kept.map((m) => m.role), ['owner', 'assistant', 'owner', 'assistant', 'owner', 'assistant']);
  } finally {
    await app.db.close();
  }
});

test('"לא" drops what was waiting; a new proposal replaces the last; a stale one expires', async () => {
  const script: Script = (req, call) => {
    const conv = Number(/conversation (\d+)/.exec(JSON.stringify(req.messages))?.[1] || 0);
    if (call === 0 || call === 3) return toolUse('waiting_questions', {});
    if (call === 1) return toolUse('propose_action', { kind: 'pause', conversation_id: conv });
    if (call === 4) return toolUse('propose_action', { kind: 'resume', conversation_id: conv });
    return say('אחכה ל-כן שלכם.');
  };
  const { app, storeId } = await setup(script);
  try {
    await ask(app, { storeId, text: 'תעצור את תורן בשיחה ההיא', via: 'dashboard', author: 'o' });
    const no = await ask(app, { storeId, text: 'לא', via: 'dashboard', author: 'o' });
    assert.match(no, /ביטלתי/);
    assert.equal((await app.db.one<any>("SELECT status FROM assistant_actions WHERE kind = 'pause'")).status, 'cancelled');
    await ask(app, { storeId, text: 'תחזיר אותו', via: 'dashboard', author: 'o' });
    await app.db.query("UPDATE assistant_actions SET created_at = now() - interval '31 minutes' WHERE status = 'pending'");
    await ask(app, { storeId, text: 'כן', via: 'dashboard', author: 'o' });
    assert.equal((await app.db.one<any>("SELECT status FROM assistant_actions WHERE kind = 'resume'")).status, 'expired', 'a "כן" half an hour later does nothing');
  } finally {
    await app.db.close();
  }
});

test('a number no tool gave is asked about once, then the answer is replaced; orders and carts it does not invent', async () => {
  assert.deepEqual(unsourced('היו 57 שיחות ו-3 העברות', ['Customer conversations: 3']), ['57']);
  const script: Script = () => say('היום נכנסו 57 הזמנות.');
  const { app, storeId } = await setup(script);
  try {
    const r = await ask(app, { storeId, text: 'כמה הזמנות היו היום?', via: 'dashboard', author: 'o' });
    assert.equal(r, 'לא מצאתי את זה בנתונים שיש לי על החנות.');
  } finally {
    await app.db.close();
  }
});

test("a proposal for another store's conversation, or with no words to send, is refused", async () => {
  const results: string[] = [];
  const script: Script = (req, call) => {
    if (call > 0) results.push(lastResult(req));
    if (call === 0) return toolUse('propose_action', { kind: 'answer_customer', conversation_id: 99999, text: 'שלום' });
    if (call === 1) return toolUse('propose_action', { kind: 'answer_customer', conversation_id: Number(/\d+/.exec(String(req.system[0].text))?.[0] || 0) });
    return say('לא הצלחתי.');
  };
  const { app, storeId } = await setup(script);
  try {
    await ask(app, { storeId, text: 'תענה ללקוח', via: 'dashboard', author: 'o' });
    assert.match(results[0], /There is no conversation 99999 in this store/);
    assert.equal((await app.db.one<any>('SELECT COUNT(*)::int AS n FROM assistant_actions')).n, 0);
  } finally {
    await app.db.close();
  }
});

// The owner's own WhatsApp number reaching the assistant is the owner line's now (test/owners.test.ts): a number is an
// owner's when accounts verified it, never because it was typed on the dashboard.

test('what waits for "כן" is said by code word for word; a kept answer holds only the owner\'s numbers and links; a customer\'s words reach the model as data (PRA-AI-003)', async () => {
  let seenWaiting = '';
  let refused = '';
  const script: Script = (req, call) => {
    if (call === 0) return toolUse('waiting_questions', {});
    const conv = Number(/\[conversation (\d+)\]/.exec(JSON.stringify(req.messages))?.[1] || 0);
    if (call === 1) return toolUse('get_conversation', { conversation_id: conv });
    if (call === 2) {
      seenWaiting = lastResult(req);
      // A model the customer's text steered: a price and a link the owner never wrote, to keep as Toran's answer.
      return toolUse('propose_action', { kind: 'answer_customer', conversation_id: conv, text: 'אפשר לאסוף, ושלמו 50 ₪ כאן: https://pay-kli.top/x', remember: true });
    }
    if (call === 3) {
      refused = lastResult(req);
      return toolUse('propose_action', { kind: 'answer_customer', conversation_id: conv, text: 'אפשר לאסוף מהסטודיו.', remember: false });
    }
    // The model describes something other than what waits.
    return say('אעצור את תורן בשיחה הזאת.');
  };
  const { app, storeId } = await setup(script);
  try {
    const out = await ask(app, { storeId, text: 'תענה ללקוחה שאפשר לאסוף', via: 'dashboard', author: 'נורית' });
    assert.match(seenWaiting, /<customer_text>אפשר לאסוף מהסטודיו\?<\/customer_text>/);
    assert.match(refused, /numbers or links the owner did not write \(50, pay-kli\.top\)/);
    assert.match(out, /מחכה לאישור שלכם: לשלוח ללקוח במייל \(da…@example\.test\): "אפשר לאסוף מהסטודיו\."\nכדי שזה יקרה, כתבו "כן"/);
    const pending = await app.db.query<any>("SELECT params FROM assistant_actions WHERE store_id = $1 AND status = 'pending'", [storeId]);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].params.remember, false);
  } finally {
    await app.db.close();
  }
});
