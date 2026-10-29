import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readExport, syncCompany, type CompanyExport } from '../src/company.ts';
import { conversationFor, runTurn } from '../src/agent/loop.ts';
import { COMPANY_TOOLS, runTool } from '../src/agent/tools.ts';
import { COMPANY_PROMPT } from '../src/agent/prompt.ts';
import { buildAllow, guardReply } from '../src/agent/guard.ts';
import { funnels } from '../src/ops/funnel.ts';
import type { Script } from '../src/agent/llm/scripted.ts';
import type { TurnReq } from '../src/agent/llm/types.ts';
import { handleInbound } from '../src/channels/route.ts';
import { testApp } from './helpers.ts';

// A made-up company in the shape of openfrequency-web's `npm run support` export.
const sample = (): CompanyExport => ({
  domain: 'shirut-li.example',
  url: 'https://shirut-li.example/',
  name: 'שירות לי',
  status: 'מה עובד היום:\n- עונה במייל.\n\nמה עוד לא עובד:\n- עונה בטלגרם.',
  tone: 'אנחנו עסק קטן מחיפה, ועונים כמו שמדברים.',
  contact: { whatsapp: '972500000199', email: 'hello@shirut-li.example' },
  plans: [
    { key: 'small', product: 'shirut', title: 'שירות, חבילה קטנה', monthly: 250, text: '250 ₪ לחודש, לא כולל מע״מ, עד 100 שיחות בחודש. בחודש הראשון יש גם 400 ₪ דמי הקמה, פעם אחת.', url: 'https://shirut-li.example/#price' },
    { key: 'large', product: 'shirut', title: 'שירות, חבילה גדולה', monthly: 1250, text: '1,250 ₪ לחודש, לא כולל מע״מ, עד 1,000 שיחות בחודש. בחודש הראשון יש גם 400 ₪ דמי הקמה, פעם אחת.', url: 'https://shirut-li.example/#price' },
  ],
  faq: [
    { q: 'באילו ערוצים אתם עונים?', a: 'בכל הערוצים.', today: 'היום במייל. טלגרם עוד לא פתוח.', url: 'https://shirut-li.example/faq' },
    { q: 'אפשר לבטל?', a: 'כן, כותבים לנו ומפסיקים בסוף החודש.', today: null, url: 'https://shirut-li.example/faq' },
  ],
  pages: [
    { kind: 'about', title: 'מה עובד היום', url: 'https://shirut-li.example/status', text: 'מה עובד היום:\n- עונה במייל.' },
    { kind: 'terms', title: 'תנאי שימוש', url: 'https://shirut-li.example/terms', text: 'תנאי שימוש\nאין התחייבות. משלמים חודש בחודש, ואת השיחות שומרים 30 יום אחרי שמפסיקים.' },
  ],
  generatedAt: '2026-10-25T10:00:00.000Z',
});

const firstUserText = (req: TurnReq) => {
  const m = req.messages[0];
  return typeof m.content === 'string' ? m.content : m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n\n');
};
const lastToolResult = (req: TurnReq) => {
  const m = req.messages[req.messages.length - 1];
  return typeof m.content === 'string' ? null : (m.content.find((b) => b.type === 'tool_result') as { content: string } | undefined)?.content ?? null;
};

test('a company export is checked whole before anything is written', () => {
  assert.doesNotThrow(() => readExport(sample()));
  assert.throws(() => readExport({ ...sample(), plans: [] }), /plans/);
  assert.throws(() => readExport({ ...sample(), status: ' ' }), /status/);
  assert.throws(() => readExport({ ...sample(), domain: 'not a domain' }), /domain/);
});

test('syncing a company store: plans, today\'s answers, pages; a re-sync keeps the owner\'s answers and drops what the site dropped', async () => {
  const app = await testApp();
  try {
    const first = await syncCompany(app, sample());
    assert.equal(first.created, true);
    assert.equal(first.slug, 'support');
    const s = await app.db.one<any>('SELECT * FROM stores WHERE id = $1', [first.storeId]);
    assert.equal(s.platform, 'company');
    assert.equal(s.status, 'company');
    assert.equal(s.qualified, false);
    assert.equal(s.workspace_id, null);
    assert.match(s.config.company.status, /עוד לא עובד/);

    const plans = await app.db.query<any>('SELECT title, price_min::float AS p, available FROM products WHERE store_id = $1 AND gone_at IS NULL ORDER BY price_min', [first.storeId]);
    assert.deepEqual(plans.map((p) => [p.title, p.p, p.available]), [['שירות, חבילה קטנה', 250, true], ['שירות, חבילה גדולה', 1250, true]]);
    const channels = await app.db.one<any>("SELECT site_answer FROM faqs WHERE store_id = $1 AND question = 'באילו ערוצים אתם עונים?'", [first.storeId]);
    assert.equal(channels.site_answer, 'היום במייל. טלגרם עוד לא פתוח.', 'today\'s answer is what the agent reads, not the site\'s');
    assert.equal((await app.db.query('SELECT 1 FROM policies WHERE store_id = $1', [first.storeId])).length, 2);
    assert.ok((await app.db.query('SELECT 1 FROM chunks WHERE store_id = $1', [first.storeId])).length >= 2);

    // The owner answers one question in the dashboard; the site drops it and the other one, and a plan.
    await app.db.query("UPDATE faqs SET answer = 'מבטלים בהודעה אחת אלינו.' WHERE store_id = $1 AND question = 'אפשר לבטל?'", [first.storeId]);
    const next = sample();
    next.faq = [{ q: 'כמה זמן לוקח דמו?', a: 'יום.', today: null, url: 'https://shirut-li.example/faq' }];
    next.plans = next.plans.slice(0, 1);
    const again = await syncCompany(app, next);
    assert.equal(again.created, false);
    assert.equal(again.storeId, first.storeId);
    assert.equal(again.faqsRemoved, 1);
    const qs = (await app.db.query<any>('SELECT question, answer FROM faqs WHERE store_id = $1 ORDER BY id', [first.storeId])).map((f) => f.question);
    assert.deepEqual(qs, ['אפשר לבטל?', 'כמה זמן לוקח דמו?'], 'the owner\'s answer stays; the dropped question without one goes');
    assert.equal((await app.db.query('SELECT 1 FROM products WHERE store_id = $1 AND gone_at IS NULL', [first.storeId])).length, 1);
  } finally {
    await app.db.close();
  }
});

test('a company store is not a lead: the funnel does not count it, and a shop already on that domain is never turned into one', async () => {
  const app = await testApp();
  try {
    await syncCompany(app, sample());
    const f = await funnels(app, null);
    assert.equal(f.toran.find((s) => s.key === 'found')!.all, 0);
    await app.db.query("INSERT INTO stores (domain, url, platform, source) VALUES ('a-shop.example', 'https://a-shop.example/', 'shopify', 'seed')");
    await assert.rejects(syncCompany(app, { ...sample(), domain: 'a-shop.example', url: 'https://a-shop.example/' }), /already a store here/);
  } finally {
    await app.db.close();
  }
});

test('a company turn: its own prompt and tools, what works today in the prompt, never a demo, and the plans quoted from the rows', async () => {
  const seen: TurnReq[] = [];
  const script: Script = (req) => {
    seen.push(req);
    const res = lastToolResult(req);
    if (!res) return [{ type: 'tool_use', id: 'p1', name: 'get_plans', input: {} }];
    return [{ type: 'text', text: 'החבילה הקטנה עולה 250 ₪ לחודש, לא כולל מע״מ, והגדולה 1,250 ₪. טלגרם עוד לא זמין.' }];
  };
  const app = await testApp({ script });
  try {
    const { storeId } = await syncCompany(app, sample());
    const conv = await conversationFor(app.db, storeId, 'cli', null);
    const o = await runTurn(app, { storeId, conversationId: conv, text: 'כמה זה עולה?', footer: false });
    const req = seen[0];
    assert.equal(req.system[0].text, COMPANY_PROMPT);
    assert.match(req.system[1].text, /# COMPANY/);
    assert.match(req.system[1].text, /עונה בטלגרם/, 'what does not work yet is in the prompt');
    assert.deepEqual(req.tools.map((t) => t.name), COMPANY_TOOLS.map((t) => t.name));
    assert.doesNotMatch(firstUserText(req), /demo/i);
    assert.equal(o.redactions.length, 0, `nothing cut: ${JSON.stringify(o.redactions)}`);
    assert.match(o.reply, /1,250 ₪/);

    const ctx = { db: app.db, storeId, origin: 'https://shirut-li.example', currency: 'ILS', company: true };
    const plans = await runTool(ctx, 'get_plans', {});
    assert.match(plans.content, /שירות, חבילה קטנה: 250 ₪ לחודש, לא כולל מע״מ/);
    assert.doesNotMatch(plans.content, /במלאי/);
    const faq = await runTool(ctx, 'get_policy', { topic: 'באילו ערוצים אתם עונים?' });
    assert.match(faq.content, /From the company's FAQ/);
    assert.match(faq.content, /טלגרם עוד לא פתוח/);
    const none = await runTool(ctx, 'get_policy', { topic: 'יש לכם משרד בתל אביב?' });
    assert.match(none.content, /The company has not written anything/);
    assert.match(none.content, /someone from us/);
    const handed = await runTool(ctx, 'handoff', { reason: 'cancel', summary: 'רוצה לבטל' });
    assert.match(handed.content, /someone from us/);
  } finally {
    await app.db.close();
  }
});

test('with TORAN_SUPPORT_STORE, our demo number (also our public number) answers a phone with no demo as support; a demo code still binds', async () => {
  const script: Script = (req) => (lastToolResult(req) ? [{ type: 'text', text: 'החבילה הקטנה עולה 250 ₪ לחודש, לא כולל מע״מ.' }] : [{ type: 'tool_use', id: 'p1', name: 'get_plans', input: {} }]);
  const app = await testApp({ script });
  try {
    const { storeId } = await syncCompany(app, sample());
    const shop = (await app.db.one<{ id: number }>("INSERT INTO stores (domain, url, name, platform, source, slug, demo_code, page_built_at, ingested_at) VALUES ('a-shop.example', 'https://a-shop.example/', 'חנות', 'shopify', 'seed', 'a-shop-x1', 'DEMO-K7MQ', now(), now()) RETURNING id"))!.id;
    Object.assign(app.env, { TORAN_SUPPORT_STORE: 'shirut-li.example', DEMO_WA_NUMBER: '972500000777' });
    const r = await handleInbound(app, { channel: 'whatsapp', from: '972500000303', text: 'כמה זה עולה?', id: 'd1', at: Date.now() });
    assert.equal(r.storeId, storeId);
    assert.equal(r.reply, 'החבילה הקטנה עולה 250 ₪ לחודש, לא כולל מע״מ.');
    const a = await app.db.one<any>("SELECT a.status, a.external_id FROM conversations c JOIN channel_accounts a ON a.id = c.account_id WHERE c.peer = '972500000303'");
    assert.deepEqual([a.status, a.external_id], ['line', '972500000777']);
    const bound = await handleInbound(app, { channel: 'whatsapp', from: '972500000404', text: 'DEMO-K7MQ', id: 'd2', at: Date.now() });
    assert.equal(bound.action, 'bound');
    assert.equal(bound.storeId, shop);
  } finally {
    await app.db.close();
  }
});

test('the guard speaks for the company: an invented price is cut with our own line, and "not available yet" is not a stock claim', () => {
  const allow = buildAllow({ toolTexts: ['- שירות, חבילה קטנה: 250 ₪ לחודש'], customerTexts: [] });
  allow.stockKnown = true;
  const g = guardReply('החבילה עולה 199 ₪ לחודש. טלגרם עוד לא זמין.', allow, { company: true });
  assert.equal(g.redactions.length, 1);
  assert.match(g.text, /ומישהו מאיתנו יחזור אליך כאן/);
  assert.doesNotMatch(g.text, /החנות/);
  assert.match(g.text, /טלגרם עוד לא זמין/);
});
