import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discover } from '../src/leads/discover.ts';
import { ingestStore } from '../src/ingest/pack.ts';
import { conversationFor, DEMO_FOOTER, runTurn } from '../src/agent/loop.ts';
import { loadProducts, rank, runTool, TOOLS } from '../src/agent/tools.ts';
import { SHARED_PROMPT, storeBlock } from '../src/agent/prompt.ts';
import type { Script } from '../src/agent/llm/scripted.ts';
import type { TurnReq } from '../src/agent/llm/types.ts';
import { testApp } from './helpers.ts';

async function storeApp(script?: Script) {
  const app = await testApp({ script });
  await discover(app.db, (async function* () { yield { url: 'https://kli-cheres.example/', source: 'seed', detail: {} }; })(), { fetcher: app.fetcher, limit: 1 });
  const id = (await app.db.one<{ id: number }>("SELECT id FROM stores WHERE domain = 'kli-cheres.example'"))!.id;
  await ingestStore(app, id);
  return { app, id, ctx: { db: app.db, storeId: id, origin: 'https://kli-cheres.example', currency: 'ILS', env: app.env } };
}

const lastToolResult = (req: TurnReq) => {
  const m = req.messages[req.messages.length - 1];
  return typeof m.content === 'string' ? null : (m.content.find((b) => b.type === 'tool_result') as { content: string } | undefined)?.content ?? null;
};

test('the shared prompt holds no store, and the tool list has no field for a price, a discount or a promise', () => {
  assert.ok(!SHARED_PROMPT.includes('כלי חרס'));
  for (const t of TOOLS) {
    const props = Object.keys((t.input_schema as any).properties || {});
    assert.ok(!props.some((p) => /price$|discount|amount|refund|promise/.test(p)) || (t.name === 'search_products' && props.includes('max_price')), `${t.name}: ${props}`);
  }
});

test('product search finds Hebrew words under their prefixes, and shows the rows\' prices and stock', async () => {
  const { app, ctx, id } = await storeApp();
  const ranked = rank(await loadProducts(app.db, id), 'יש לכם ספלים לאספרסו?');
  assert.equal(ranked[0].p.title, 'ספל אספרסו מט');
  const r = await runTool(ctx, 'search_products', { query: 'אגרטל' });
  assert.match(r.content, /אגרטל גבוה: 210 ₪, אזל מהמלאי/);
  assert.match(r.content, /אגרטל כדור קטן: 95 ₪, במלאי/);
  const none = await runTool(ctx, 'search_products', { query: 'מכונת כביסה' });
  assert.match(none.content, /No products match/);
  const sale = await runTool(ctx, 'search_products', { query: 'צלחת הגשה' });
  assert.match(sale.content, /149 ₪ \(במבצע, במקום 189 ₪\)/);
  await app.db.close();
});

test('get_policy without embeddings finds the shipping passage by its words, and says so when the store wrote nothing', async () => {
  const { app, ctx } = await storeApp();
  const r = await runTool(ctx, 'get_policy', { topic: 'כמה עולה משלוח?' });
  assert.match(r.content, /35 ₪/);
  const none = await runTool(ctx, 'get_policy', { topic: 'האם יש חניה ליד הסטודיו?' });
  assert.match(none.content, /has not written anything/);
  await app.db.close();
});

test('the store block computes the catalogue facts and carries the tone sample in the store\'s words', async () => {
  const { app, id } = await storeApp();
  const s = await app.db.one<any>('SELECT * FROM stores WHERE id = $1', [id]);
  const block = await storeBlock(app.db, s);
  assert.match(block, /14 products, 13 of them in stock/);
  assert.match(block, /shipping: "מדיניות משלוחים"/);
  assert.match(block, /עובר דרך הידיים שלי|קרמיקה שאני מעצבת/);
  await app.db.close();
});

test('a turn: search, then a reply quoting the row; the footer is on; everything is recorded', async () => {
  const script: Script = (req) => {
    const res = lastToolResult(req);
    if (!res) return [{ type: 'tool_use', id: 't1', name: 'search_products', input: { query: 'ספל חול' } }];
    return [{ type: 'text', text: 'ספל החול עולה 89 ₪ ויש אותו במלאי. רוצים קישור?' }];
  };
  const { app, id } = await storeApp(script);
  const conv = await conversationFor(app.db, id, 'cli', null);
  const o = await runTurn(app, { storeId: id, conversationId: conv, text: 'כמה עולה ספל החול?' });
  assert.equal(o.redactions.length, 0);
  assert.equal(o.handoff, null);
  assert.ok(o.reply.endsWith(DEMO_FOOTER));
  assert.equal(o.rounds, 2);
  const rows = await app.db.query<any>('SELECT role, tools FROM messages WHERE conversation_id = $1 ORDER BY id', [conv]);
  assert.deepEqual(rows.map((r) => r.role), ['customer', 'agent']);
  assert.equal(rows[1].tools[0].name, 'search_products');
  const u = await app.db.query('SELECT * FROM usage WHERE store_id = $1', [id]);
  assert.equal(u.length, 2, 'every model call is recorded against the store');
  await app.db.close();
});

test('an invented price never reaches the customer: the guard cuts it, hands off, and the miss is counted', async () => {
  const script: Script = (req) => (lastToolResult(req) ? [{ type: 'text', text: 'הקנקן עולה 150 ₪ בלבד, מחיר הכי טוב שיש.' }] : [{ type: 'tool_use', id: 't1', name: 'search_products', input: { query: 'קנקן' } }]);
  const { app, id } = await storeApp(script);
  const conv = await conversationFor(app.db, id, 'cli', null);
  const o = await runTurn(app, { storeId: id, conversationId: conv, text: 'כמה עולה הקנקן?' });
  assert.ok(!o.reply.includes('150'));
  assert.ok(o.redactions.length >= 1);
  assert.equal(o.handoff?.reason, 'unknown');
  assert.equal(o.miss, true);
  const c = await app.db.one<any>('SELECT handoffs, misses FROM conversations WHERE id = $1', [conv]);
  assert.deepEqual([c.handoffs, c.misses], [1, 1]);
  await app.db.close();
});

test('a price read in an earlier turn may be quoted later; a refund request goes to handoff through the tool', async () => {
  let turn = 0;
  const script: Script = (req) => {
    const res = lastToolResult(req);
    if (turn === 0) {
      if (!res) return [{ type: 'tool_use', id: 'a', name: 'search_products', input: { query: 'קנקן' } }];
      turn = 1;
      return [{ type: 'text', text: 'יש קנקן מים ב-185 ₪.' }];
    }
    if (turn === 1) {
      turn = 2;
      return [{ type: 'text', text: 'כן, הקנקן ב-185 ₪.' }];
    }
    if (!res) return [{ type: 'tool_use', id: 'h', name: 'handoff', input: { reason: 'refund', summary: 'wants a refund' } }];
    return [{ type: 'text', text: 'העברתי את הבקשה לחנות, ויחזרו אליך כאן.' }];
  };
  const { app, id } = await storeApp(script);
  const conv = await conversationFor(app.db, id, 'cli', null);
  await runTurn(app, { storeId: id, conversationId: conv, text: 'יש קנקן?' });
  const second = await runTurn(app, { storeId: id, conversationId: conv, text: 'כמה הוא עלה?' });
  assert.equal(second.redactions.length, 0, 'the number from the first turn\'s tool result is still allowed');
  const third = await runTurn(app, { storeId: id, conversationId: conv, text: 'אני רוצה החזר כספי' });
  assert.equal(third.handoff?.reason, 'refund');
  await app.db.close();
});

test('a model that fails or loops still answers the customer honestly, and hands off', async () => {
  const loops: Script = () => [{ type: 'tool_use', id: 'x', name: 'search_products', input: { query: 'ספל' } }];
  const { app, id } = await storeApp(loops);
  const conv = await conversationFor(app.db, id, 'cli', null);
  const o = await runTurn(app, { storeId: id, conversationId: conv, text: 'ספל?' });
  assert.equal(o.rounds, 6);
  assert.match(o.reply, /בודק/);
  assert.equal(o.handoff?.reason, 'unknown');
  await app.db.close();
});
