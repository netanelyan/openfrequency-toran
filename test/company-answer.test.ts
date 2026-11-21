import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readExport, syncCompany, type CompanyExport } from '../src/company.ts';
import { botLine, botName } from '../src/agent/intro.ts';
import { COMPANY_JOIN_PROMPT, COMPANY_PROMPT, systemFor } from '../src/agent/prompt.ts';
import { COMPANY_JOIN_TOOLS, COMPANY_TOOLS, runTool } from '../src/agent/tools.ts';
import { scriptedClient, type Script } from '../src/agent/llm/scripted.ts';
import type { TurnReq } from '../src/agent/llm/types.ts';
import { publicRoutes } from '../src/web/public.ts';
import { accountsClient } from '../src/web/accounts.ts';
import { ownerReply, replyState } from '../src/channels/owner.ts';
import { optOutReply } from '../src/auto/consent.ts';
import { waitingDigest } from '../src/owners/waiting.ts';
import { elsewhereHe } from '../src/web/pages/home.ts';
import { INTERNAL_TOKEN, testApp } from './helpers.ts';
import { serve } from './serve.ts';

// A company store answered elsewhere (src/channels/external.ts, docs/company.md): על הקו's WhatsApp conversations live
// in its own service, which asks Toran for each answer at POST /internal/company/answer and sends it from its own
// number. Toran keeps the conversation in the company store's inbox, answers on the company's normal path, and sends
// nothing anywhere itself. The model is a script that records what it was asked; Meta is a stand-in that refuses and
// counts every call. Nothing leaves this machine. Every number and name here is made up.

const DOMAIN = 'alhakav.example';
const PHONE = '972500000000';
const OTHER = '972500000001';
const THIRD = '972500000002';
const WRONG = 'wrong-token-wrong-token-wrong-token-00';
const MINUTE = 60_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

// על הקו, in the shape of a company export, with made-up words.
const alhakav = (): CompanyExport => ({
  domain: DOMAIN,
  url: `https://${DOMAIN}/`,
  name: 'על הקו',
  status: 'מה עובד היום:\n- כשמפספסים שיחה, מי שהתקשר מקבל הודעה בוואטסאפ מהמספר של העוזר, והעוזר שואל מה קרה ואיפה.\n- בעל העסק מקבל סיכום בוואטסאפ.\n\nמה עוד לא עובד:\n- תשלום בכרטיס אשראי.',
  tone: 'אנחנו עסק קטן, ומדברים פשוט.',
  contact: { whatsapp: '972500000901', email: null },
  plans: [{ key: 'monthly', product: 'alhakav', title: 'על הקו, מנוי חודשי', monthly: 149, text: '149 ₪ לחודש לפני מע״מ (175.82 ₪ כולל מע״מ), ומשלמים חודש מראש בהעברה בנקאית.', url: `https://${DOMAIN}/#price` }],
  faq: [{ q: 'למי זה מתאים?', a: 'לאינסטלטורים, לחשמלאים, לטכנאי מזגנים ולמנעולנים.', today: null, url: `https://${DOMAIN}/` }],
  pages: [{ kind: 'about', title: 'איך זה עובד', url: `https://${DOMAIN}/`, text: 'כשמפספסים שיחה, מי שהתקשר מקבל הודעה בוואטסאפ מהמספר של העוזר שלכם. העוזר שואל מה קרה ואיפה, ואתם מקבלים סיכום.' }],
  start: { kind: 'join', text: 'מצטרפים כאן בוואטסאפ: שולחים לנו את השם של העסק, ומקבלים את הסכום ואת פרטי ההעברה.' },
  generatedAt: '2026-11-21T08:00:00.000Z',
});

const textOf = (m: TurnReq['messages'][number]) => (typeof m.content === 'string' ? m.content : m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n\n'));
const lastToolResult = (req: TurnReq) => {
  const m = req.messages[req.messages.length - 1];
  return typeof m.content === 'string' ? null : (m.content.find((b) => b.type === 'tool_result') as { content: string } | undefined)?.content ?? null;
};
/** The person's newest words in a request: the last text block of the last message that has no tool result. */
const asked = (req: TurnReq) => {
  const m = [...req.messages].reverse().find((x) => x.role === 'user' && !(typeof x.content !== 'string' && x.content.some((b) => b.type === 'tool_result')));
  if (!m) return '';
  return typeof m.content === 'string' ? m.content : ((m.content.filter((b) => b.type === 'text').pop() as { text: string } | undefined)?.text ?? '');
};

type S = Awaited<ReturnType<typeof serve>>;

/** The site with על הקו synced, the model a script, and Meta a stand-in that refuses and counts every call. */
async function served(script: Script) {
  const s = await serve();
  const seen: TurnReq[] = [];
  s.app.llm = scriptedClient((req, n) => {
    seen.push(req);
    return script(req, n);
  });
  const graph: string[] = [];
  s.app.graph = (async (input: any) => {
    graph.push(String(input));
    return new Response(JSON.stringify({ error: { message: 'refused', code: 1 } }), { status: 400, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const { storeId } = await syncCompany(s.app, alhakav(), { slug: 'alhakav' });
  // The demo store's own sample chat, seeded by serve(), is what the outbox holds before anything here.
  const outbox = s.app.wa.outbox?.length ?? 0;
  return { s, seen, graph, storeId, outbox };
}

const ask = (s: S, body: unknown, { token = INTERNAL_TOKEN as string | null, method = 'POST', headers = {} as Record<string, string>, raw = undefined as string | undefined } = {}) =>
  fetch(`${s.base}/internal/company/answer`, {
    method,
    redirect: 'manual',
    headers: { ...(token == null ? {} : { authorization: `Bearer ${token}` }), 'content-type': 'application/json', ...headers },
    ...(method === 'GET' ? {} : { body: raw ?? JSON.stringify(body) }),
  }).then(async (r) => ({ status: r.status, json: (await r.json().catch(() => null)) as any }));

const message = (id: string, text: string, at = ago(0)) => ({ id, text, at });
const request = (over: Record<string, unknown> = {}) => ({ domain: DOMAIN, phone: PHONE, name: 'אבי', messages: [message('wamid.T1', 'כמה זה עולה?')], operator: [], context: null, ...over });

/** Nothing went out to any channel: nothing new in the simulated WhatsApp's outbox, and Meta was never called. */
async function nothingSent({ s, graph, outbox }: { s: S; graph: string[]; outbox: number }) {
  assert.equal(s.app.wa.outbox?.length ?? 0, outbox, 'nothing new in the WhatsApp outbox');
  assert.deepEqual(graph, [], 'Meta was never called');
  assert.equal((await s.app.db.query("SELECT 1 FROM jobs WHERE kind = 'owner_waiting'")).length, 0, 'no digest for the owner');
  assert.equal((await s.app.db.query("SELECT 1 FROM events WHERE kind IN ('operator_alert', 'operator_alert_wa')")).length, 0, 'no operator alert');
}

const plansScript: Script = (req) => (lastToolResult(req) ? [{ type: 'text', text: 'זה 149 ₪ לחודש לפני מע״מ, ומשלמים חודש מראש בהעברה בנקאית.' }] : [{ type: 'tool_use', id: 'p1', name: 'get_plans', input: {} }]);

// ---- the export's start

test('a company export may say how to start, a demo or joining in the chat, kept in the store\'s config; a malformed one stops the export', async () => {
  assert.doesNotThrow(() => readExport(alhakav()));
  assert.doesNotThrow(() => readExport({ ...alhakav(), start: undefined }), 'left out: the demo, as before');
  assert.doesNotThrow(() => readExport({ ...alhakav(), start: null }));
  assert.doesNotThrow(() => readExport({ ...alhakav(), start: { kind: 'demo', text: 'מבקשים דמו באתר.' } }));
  const bad: unknown[] = [{ kind: 'trial', text: 'x' }, { kind: 'join' }, { kind: 'join', text: '   ' }, { kind: 'join', text: 5 }, { kind: 'join', text: 'מ'.repeat(601) }, 'join', ['join'], { text: 'מצטרפים כאן.' }, 7];
  for (const start of bad) assert.throws(() => readExport({ ...alhakav(), start: start as any }), /not a company export: start/, JSON.stringify(start));

  const app = await testApp();
  try {
    const { storeId } = await syncCompany(app, alhakav(), { slug: 'alhakav' });
    const s = await app.db.one<any>('SELECT config FROM stores WHERE id = $1', [storeId]);
    assert.deepEqual(s.config.company.start, { kind: 'join', text: alhakav().start!.text });
    assert.match(s.config.company.status, /עוד לא עובד/);
    const { start: _gone, ...without } = alhakav();
    await syncCompany(app, without as CompanyExport, { slug: 'alhakav' });
    assert.equal((await app.db.one<any>('SELECT config FROM stores WHERE id = $1', [storeId])).config.company.start, null, 'a sync without it takes it away');
  } finally {
    await app.db.close();
  }
});

test('a company export may name its bot: each sync sets it, one left out keeps the name the store has, "" clears it, and a name a customer cannot be told stops the export', async () => {
  assert.doesNotThrow(() => readExport({ ...alhakav(), botName: 'המוקדן' }));
  assert.doesNotThrow(() => readExport({ ...alhakav(), botName: '' }));
  for (const botName of ['https://x.co', '!!!', 'מ'.repeat(31), 5, ['המוקדן']]) assert.throws(() => readExport({ ...alhakav(), botName: botName as any }), /not a company export: botName/, JSON.stringify(botName));
  const app = await testApp();
  try {
    const { storeId } = await syncCompany(app, { ...alhakav(), botName: 'המוקדן' }, { slug: 'alhakav' });
    const name = async () => (await app.db.one<any>('SELECT agent_name FROM stores WHERE id = $1', [storeId])).agent_name;
    assert.equal(await name(), 'המוקדן');
    await syncCompany(app, alhakav(), { slug: 'alhakav' });
    assert.equal(await name(), 'המוקדן', 'left out: the store keeps it');
    await syncCompany(app, { ...alhakav(), botName: '' }, { slug: 'alhakav' });
    assert.equal(await name(), null, '"" clears it');
    // With no name, a company whose people join in the chat opens as its own bot, never as ours.
    const s = await app.db.one<any>('SELECT platform, agent_name, config FROM stores WHERE id = $1', [storeId]);
    assert.equal(botName(s), null);
    assert.equal(botLine('first', botName(s), 'על הקו'), 'היי, אני הבוט של על הקו.');
    assert.equal(botName({ platform: 'company', agent_name: null, config: { company: { start: null } } }), 'תורן', 'our own support is still תורן');
  } finally {
    await app.db.close();
  }
});

test('a company whose people join in the chat gets its own prompt and tools, with nothing of OpenFrequency\'s; one that says nothing or a demo keeps ours', async () => {
  const app = await testApp();
  try {
    const { storeId } = await syncCompany(app, alhakav(), { slug: 'alhakav' });
    const row = () => app.db.one<any>('SELECT id, platform, name, domain, brand, brand_override, config, contact_email, contact_phone, contact_whatsapp FROM stores WHERE id = $1', [storeId]);
    const parts = await systemFor(app.db, (await row())!);
    assert.equal(parts[0].text, COMPANY_JOIN_PROMPT);
    assert.match(parts[1].text, /How to start, in the company's own words[^\n]*\n"""מצטרפים כאן בוואטסאפ: שולחים לנו את השם של העסק/);
    // None of OpenFrequency's own: its demo form, the store we wrote to and its LEAD block, Toran, Teder or a store's site.
    for (const re of [/Toran|Teder|תורן|תדר|OpenFrequency|openfrequency/i, /\bLEAD\b/, /demo|דמו/i, /\bstores?\b/i, /\/s\//]) assert.doesNotMatch(COMPANY_JOIN_PROMPT, re, String(re));
    assert.match(COMPANY_JOIN_PROMPT, /call handoff with reason "join" and the name in business, and tell them in one short sentence that the amount and the transfer details come in the next message/);
    assert.match(COMPANY_JOIN_PROMPT, /Never ask for card details, never say when the service will be set up/);
    assert.doesNotMatch(COMPANY_JOIN_PROMPT.slice(COMPANY_JOIN_PROMPT.indexOf('Examples of the length')), /[—–!]/, 'no long dash and no exclamation mark in the examples');
    assert.deepEqual(COMPANY_JOIN_TOOLS.map((t) => t.name), COMPANY_TOOLS.map((t) => t.name));
    for (const tools of [COMPANY_TOOLS, COMPANY_JOIN_TOOLS]) assert.ok((tools.find((t) => t.name === 'handoff')!.input_schema as any).properties.business, 'the handoff takes the business\'s name');
    for (const t of COMPANY_JOIN_TOOLS) assert.doesNotMatch(t.description, /demo|website|store/i, t.name);

    // A demo, said or left out: OpenFrequency's prompt, and its block as it was.
    for (const start of [{ kind: 'demo', text: 'מבקשים דמו באתר שלנו.' }, null]) {
      await app.db.query("UPDATE stores SET config = jsonb_set(config, '{company,start}', $2::jsonb) WHERE id = $1", [storeId, JSON.stringify(start)]);
      const again = await systemFor(app.db, (await row())!);
      assert.equal(again[0].text, COMPANY_PROMPT);
      assert.doesNotMatch(again[1].text, /How to start/);
    }
  } finally {
    await app.db.close();
  }
});

test('a join needs the business\'s name: without it the tool hands nothing off, with it the handoff carries it and says the transfer details come next', async () => {
  const app = await testApp();
  try {
    const { storeId } = await syncCompany(app, alhakav(), { slug: 'alhakav' });
    const ctx = { db: app.db, storeId, origin: `https://${DOMAIN}`, currency: 'ILS', company: true, joins: true };
    const none = await runTool(ctx, 'handoff', { reason: 'join', summary: 'רוצה להצטרף' });
    assert.equal(none.ok, false);
    assert.equal(none.handoff, undefined);
    assert.match(none.content, /ask the person for it in one short question/);
    const named = await runTool(ctx, 'handoff', { reason: 'join', summary: 'רוצה להצטרף', business: '  אבי   אינסטלציה ' });
    assert.deepEqual(named.handoff, { reason: 'join', summary: 'רוצה להצטרף', business: 'אבי אינסטלציה' });
    assert.match(named.content, /the amount and the transfer details come in the next message\. Never ask for card details/);
    const stop = await runTool(ctx, 'handoff', { reason: 'stop', summary: 'ביקשו שנפסיק' });
    assert.match(stop.content, /the company writes to them no more\.\nRule: write one short sentence that we will not write to them again/);
    // OpenFrequency's support keeps its own line, and keeps a name it was given.
    const ours = await runTool({ ...ctx, joins: false }, 'handoff', { reason: 'join', summary: 'רוצה להתחיל', business: 'חנות' });
    assert.match(ours.content, /someone from us will get back to them here/);
    assert.deepEqual(ours.handoff, { reason: 'join', summary: 'רוצה להתחיל', business: 'חנות' });
  } finally {
    await app.db.close();
  }
});

// ---- the route

test('the route refuses without the token, from another machine, through Caddy, by GET, a body that is not a request, and a domain that is no company store here', async () => {
  const t = await served(plansScript);
  const { s, seen } = t;
  try {
    const ok = request();
    const cases: [string, Promise<{ status: number; json: any }>, number, string][] = [
      ['no token', ask(s, ok, { token: null }), 401, 'bad_token'],
      ['a wrong token', ask(s, ok, { token: WRONG }), 401, 'bad_token'],
      ['through Caddy', ask(s, ok, { headers: { 'x-forwarded-for': '203.0.113.9' } }), 403, 'forbidden'],
      ['GET', ask(s, null, { method: 'GET' }), 405, 'method_not_allowed'],
      ['GET without the token', ask(s, null, { method: 'GET', token: null }), 401, 'bad_token'],
      ['nothing', ask(s, {}), 400, 'bad_request'],
      ['not JSON', ask(s, null, { raw: 'domain=x' }), 400, 'bad_request'],
      ['a list', ask(s, [ok]), 400, 'bad_request'],
      ['no domain', ask(s, { ...ok, domain: undefined }), 400, 'bad_request'],
      ['a domain that is not one', ask(s, { ...ok, domain: 'not a domain' }), 400, 'bad_request'],
      ['a phone with a plus', ask(s, { ...ok, phone: `+${PHONE}` }), 400, 'bad_request'],
      ['a phone as a number', ask(s, { ...ok, phone: Number(PHONE) }), 400, 'bad_request'],
      ['no messages', ask(s, { ...ok, messages: [] }), 400, 'bad_request'],
      ['messages not a list', ask(s, { ...ok, messages: message('a', 'היי') }), 400, 'bad_request'],
      ['a message with no id', ask(s, { ...ok, messages: [{ text: 'היי', at: ago(0) }] }), 400, 'bad_request'],
      ['a message id with a space', ask(s, { ...ok, messages: [message('a b', 'היי')] }), 400, 'bad_request'],
      ['the same id twice', ask(s, { ...ok, messages: [message('a', 'היי'), message('a', 'שוב')] }), 400, 'bad_request'],
      ['a message with no words', ask(s, { ...ok, messages: [message('a', '   ')] }), 400, 'bad_request'],
      ['a message with no time', ask(s, { ...ok, messages: [{ id: 'a', text: 'היי' }] }), 400, 'bad_request'],
      ['a time that is not one', ask(s, { ...ok, messages: [message('a', 'היי', 'yesterday')] }), 400, 'bad_request'],
      ['too many messages', ask(s, { ...ok, messages: Array.from({ length: 21 }, (_, i) => message(`m${i}`, 'היי')) }), 400, 'bad_request'],
      ['an answer with no words', ask(s, { ...ok, operator: [{ text: '', at: ago(0) }] }), 400, 'bad_request'],
      ['operator not a list', ask(s, { ...ok, operator: 'כן' }), 400, 'bad_request'],
      ['a name as a number', ask(s, { ...ok, name: 5 }), 400, 'bad_request'],
      ['context too long', ask(s, { ...ok, context: 'x'.repeat(2001) }), 400, 'bad_request'],
      ['too large', ask(s, null, { raw: JSON.stringify({ ...ok, pad: 'p'.repeat(70_000) }) }), 400, 'bad_request'],
      ['no such store', ask(s, { ...ok, domain: 'nobody.example' }), 404, 'no_store'],
      // A shop's domain is a store here, but not a company store.
      ['a store that is not a company', ask(s, { ...ok, domain: 'kli-cheres.example' }), 404, 'no_store'],
    ];
    for (const [label, call, status, error] of cases) assert.deepEqual(await call, { status, json: { error } }, label);
    const was = s.app.env.OF_INTERNAL_TOKEN;
    delete s.app.env.OF_INTERNAL_TOKEN;
    assert.deepEqual(await ask(s, ok), { status: 503, json: { error: 'not_configured' } }, 'OF_INTERNAL_TOKEN unset here');
    s.app.env.OF_INTERNAL_TOKEN = was;
    // A socket that is not this machine's (the route's own check: Toran listens on 127.0.0.1 behind Caddy).
    const route = publicRoutes(s.app, accountsClient({ env: s.app.env })).find(([m, re]) => m === 'POST' && re.test('/internal/company/answer'));
    assert.ok(route, 'POST /internal/company/answer is a route');
    const out = await route[2]({ req: { headers: { authorization: `Bearer ${INTERNAL_TOKEN}` }, socket: { remoteAddress: '203.0.113.9' } }, raw: JSON.stringify(ok) } as any, [] as any);
    assert.deepEqual([out.status, out.json], [403, { error: 'forbidden' }]);
    assert.equal(seen.length, 0, 'no model call');
    assert.equal((await s.app.db.query("SELECT 1 FROM conversations c JOIN stores st ON st.id = c.store_id WHERE st.domain = $1", [DOMAIN])).length, 0, 'no conversation');
    await nothingSent(t);
  } finally {
    await s.close();
  }
});

test('an answer: the company\'s prompt with the caller\'s line about the person, the bot\'s opening line, kept in the store\'s inbox, and nothing sent; the same id again is not answered twice', async () => {
  const t = await served(plansScript);
  const { s, seen, storeId } = t;
  try {
    const context = 'A tradesperson we wrote to first; they pressed "כן, שלחו" and already got our explanation, with the price and the site.';
    const first = await ask(s, request({ context }));
    assert.equal(first.status, 200);
    const { conversationId } = first.json;
    assert.ok(Number.isInteger(conversationId) && conversationId > 0);
    assert.deepEqual(first.json, { reply: 'היי, אני הבוט של על הקו.\n\nזה 149 ₪ לחודש לפני מע״מ, ומשלמים חודש מראש בהעברה בנקאית.', handoff: null, conversationId });

    // The company's own path: its prompt, its block, its tools, and the caller's line in the turn's SERVER CONTEXT.
    const req = seen[0];
    assert.equal(req.system[0].text, COMPANY_JOIN_PROMPT);
    assert.match(req.system[1].text, /# COMPANY\nName: על הקו/);
    assert.deepEqual(req.tools.map((t) => t.description), COMPANY_JOIN_TOOLS.map((t) => t.description));
    // The loop goes on adding to the request's messages after the call, so the turn is the first one.
    const turn = req.messages[0];
    const server = typeof turn.content === 'string' ? turn.content : (turn.content[0] as { text: string }).text;
    assert.match(server, /^SERVER CONTEXT \(written by the app, not by the customer\)/);
    assert.ok(server.includes(`From על הקו's own records about this person, for you alone`) && server.includes(context), server);
    assert.equal(textOf(turn).trim().endsWith('כמה זה עולה?'), true);

    // Kept as any of the store's conversations, on its account answered elsewhere, and the caller's line nowhere.
    const c = await s.app.db.one<any>('SELECT c.store_id, c.channel, c.peer, c.meta, a.kind, a.external_id, a.status FROM conversations c JOIN channel_accounts a ON a.id = c.account_id WHERE c.id = $1', [conversationId]);
    assert.deepEqual([c.store_id, c.channel, c.peer, c.meta.name, c.kind, c.external_id, c.status], [storeId, 'whatsapp', PHONE, 'אבי', 'external', `external:${DOMAIN}`, 'active']);
    const msgs = await s.app.db.query<any>('SELECT role, text, ext_id FROM messages WHERE conversation_id = $1 ORDER BY id', [conversationId]);
    assert.deepEqual(msgs.map((m) => [m.role, m.text]), [['customer', 'כמה זה עולה?'], ['agent', first.json.reply]]);
    assert.equal(msgs[0].ext_id, `ext:${storeId}:wamid.T1`);
    assert.equal((await s.app.db.query("SELECT 1 FROM messages WHERE text LIKE '%שלחו%'")).length, 0, 'the caller\'s line is not stored');
    assert.equal((await s.app.db.query("SELECT 1 FROM events WHERE data::text LIKE '%שלחו%'")).length, 0);

    // The same message again: not answered twice, and the model is not asked.
    const again = await ask(s, request({ context }));
    assert.deepEqual(again, { status: 200, json: { reply: null, handoff: null, conversationId, duplicate: true } });
    assert.equal(seen.length, 2, 'two model calls, both the first answer\'s (get_plans, then the reply)');
    assert.equal((await s.app.db.query('SELECT 1 FROM messages WHERE conversation_id = $1', [conversationId])).length, 2);

    // A second message in the same conversation: the bot does not say who it is again.
    const next = await ask(s, request({ messages: [message('wamid.T2', 'ואיך משלמים?')] }));
    assert.equal(next.json.conversationId, conversationId);
    assert.equal(next.json.reply, 'זה 149 ₪ לחודש לפני מע״מ, ומשלמים חודש מראש בהעברה בנקאית.');
    await nothingSent(t);
  } finally {
    await s.close();
  }
});

test('the inbox shows a conversation answered elsewhere with where it is answered, and sends nothing from it', async () => {
  const t = await served(plansScript);
  const { s } = t;
  try {
    const at = ago(14 * 60 * MINUTE);
    const { json } = await ask(s, request({ messages: [message('wamid.I1', 'היי', ago(15 * 60 * MINUTE)), message('wamid.I2', 'כמה זה עולה?')], operator: [{ text: 'היי אבי, עוד רגע עונים לך.', at }] }));
    const id = json.conversationId;
    const st = await replyState(s.app, id);
    assert.equal(st.canReply, false);
    assert.equal(st.reason, 'elsewhere');
    assert.deepEqual(await ownerReply(s.app, id, 'תשובה מהתיבה', 'operator'), { ok: false, reason: 'elsewhere' });
    s.login();
    const html = await (await s.get(`/chat/${id}`)).text();
    assert.ok(html.includes(elsewhereHe('על הקו')), 'where it is answered, in place of the reply box');
    assert.doesNotMatch(html, new RegExp(`action="/chat/${id}/reply"`), 'no reply box');
    assert.ok(html.includes('נשלח מהמערכת של על הקו'), 'the person\'s answer there, said where it was sent from');
    assert.ok(html.includes('הצוות של על הקו'));
    await nothingSent(t);
  } finally {
    await s.close();
  }
});

test('what a person of the company answered there is kept as a person\'s answer: inside 12 hours Toran stays quiet, after them it says it is the bot again', async () => {
  const t = await served(plansScript);
  const { s, seen } = t;
  try {
    // A person answered 20 minutes ago, and the person writes again: theirs to answer.
    const answered = { text: 'היי אבי, מה שלומך?', at: ago(20 * MINUTE) };
    const fresh = await ask(s, request({ messages: [message('wamid.O1', 'שלום, ראיתי את ההודעה שלכם', ago(30 * MINUTE)), message('wamid.O2', 'כמה זה עולה?')], operator: [answered] }));
    assert.deepEqual(fresh.json, { reply: null, handoff: null, conversationId: fresh.json.conversationId });
    assert.equal(seen.length, 0, 'no model call while a person has the conversation');
    const conv = fresh.json.conversationId;
    const msgs = await s.app.db.query<any>('SELECT role, text, author FROM messages WHERE conversation_id = $1 AND role IN ($2, $3) ORDER BY id', [conv, 'customer', 'owner']);
    assert.deepEqual(msgs.map((m) => [m.role, m.text]), [['customer', 'שלום, ראיתי את ההודעה שלכם'], ['owner', 'היי אבי, מה שלומך?'], ['customer', 'כמה זה עולה?']], 'in the order they were written');
    assert.equal(msgs[1].author, 'הצוות של על הקו');
    const paused = await s.app.db.one<any>('SELECT agent_paused_until FROM conversations WHERE id = $1', [conv]);
    assert.ok(Math.abs(new Date(paused.agent_paused_until).getTime() - (Date.now() - 20 * MINUTE + 12 * 60 * MINUTE)) < MINUTE, 'paused 12 hours from their answer');

    // The same answer again (a call made again, with a new message): kept once, and still theirs.
    const repeat = await ask(s, request({ messages: [message('wamid.O3', 'ועוד שאלה')], operator: [answered] }));
    assert.deepEqual([repeat.json.reply, repeat.json.conversationId], [null, conv]);
    assert.equal((await s.app.db.query("SELECT 1 FROM messages WHERE conversation_id = $1 AND role = 'owner'", [conv])).length, 1);

    // Their answer came last: nothing left for Toran to answer.
    const last = await ask(s, request({ phone: OTHER, messages: [message('wamid.L1', 'יש לכם מנעולנים?', ago(10 * MINUTE))], operator: [{ text: 'כן, יש. מה העסק שלך?', at: ago(MINUTE) }] }));
    assert.equal(last.json.reply, null);
    assert.equal(seen.length, 0);

    // A person answered 13 hours ago: Toran answers, reads their answer as ours, and says it is the bot again.
    const old = await ask(s, request({ phone: THIRD, messages: [message('wamid.B1', 'היי', ago(14 * 60 * MINUTE)), message('wamid.B2', 'כמה זה עולה?')], operator: [{ text: 'היי, אני נתנאל מעל הקו. שאלו כאן מה שרוצים.', at: ago(13 * 60 * MINUTE) }] }));
    assert.equal(old.status, 200);
    assert.equal(old.json.reply, 'זה שוב הבוט של על הקו.\n\nזה 149 ₪ לחודש לפני מע״מ, ומשלמים חודש מראש בהעברה בנקאית.');
    const history = seen[0].messages.map((m) => [m.role, textOf(m)]);
    assert.ok(history.some(([role, text]) => role === 'assistant' && text.includes('אני נתנאל מעל הקו')), 'their answer is the company\'s side of the chat');
    await nothingSent(t);
  } finally {
    await s.close();
  }
});

test('a join: the bot asks for the business\'s name, then the handoff carries it, and Toran tells nobody itself', async () => {
  const script: Script = (req) => {
    if (lastToolResult(req)) return [{ type: 'text', text: 'רשמתי. בהודעה הבאה יגיעו הסכום ופרטי ההעברה.' }];
    if (/אבי אינסטלציה/.test(asked(req))) return [{ type: 'tool_use', id: 'h1', name: 'handoff', input: { reason: 'join', summary: 'רוצה להצטרף', business: 'אבי אינסטלציה' } }];
    return [{ type: 'text', text: 'מה השם של העסק, כמו שמי שמתקשר אליכם יראה אותו?' }];
  };
  const t = await served(script);
  const { s, seen, storeId } = t;
  try {
    const first = await ask(s, request({ messages: [message('wamid.J1', 'רוצה להצטרף')] }));
    assert.deepEqual([first.json.reply, first.json.handoff], ['היי, אני הבוט של על הקו.\n\nמה השם של העסק, כמו שמי שמתקשר אליכם יראה אותו?', null]);
    const joined = await ask(s, request({ messages: [message('wamid.J2', 'אבי אינסטלציה')] }));
    assert.deepEqual(joined.json, { reply: 'רשמתי. בהודעה הבאה יגיעו הסכום ופרטי ההעברה.', handoff: { reason: 'join', summary: 'רוצה להצטרף', business: 'אבי אינסטלציה' }, conversationId: first.json.conversationId });
    assert.match(lastToolResult(seen[seen.length - 1])!, /the amount and the transfer details come in the next message/);
    // The handoff is kept for the inbox as any handoff, and the conversation waits there; nobody is told by Toran.
    const kept = await s.app.db.one<any>("SELECT handoff FROM messages WHERE conversation_id = $1 AND role = 'agent' ORDER BY id DESC LIMIT 1", [first.json.conversationId]);
    assert.deepEqual(kept.handoff, { reason: 'join', summary: 'רוצה להצטרף', business: 'אבי אינסטלציה' });
    assert.deepEqual(await waitingDigest(s.app, storeId), { sent: 0, conversations: 0, why: 'nothing new waits' }, 'the digest leaves it to the company');
    await nothingSent(t);
  } finally {
    await s.close();
  }
});

test('Toran\'s own rules: a stop word is answered in one line and comes back as a stop; another bot gets nothing, and comes back as one; past the support\'s hour, a person answers', async () => {
  const script: Script = (req) => (lastToolResult(req) ? [{ type: 'text', text: '' }] : [{ type: 'tool_use', id: 'b1', name: 'handoff', input: { reason: 'bot', summary: 'עונה בוט' } }]);
  const t = await served(script);
  const { s, seen } = t;
  try {
    const stop = await ask(s, request({ messages: [message('wamid.S1', 'הסר')] }));
    assert.deepEqual(stop.json, { reply: optOutReply('על הקו'), handoff: { reason: 'stop', summary: 'ביקשו שלא נכתוב להם יותר.', business: null }, conversationId: stop.json.conversationId });
    assert.equal(seen.length, 0, 'no model call for a stop word');

    const bot = await ask(s, request({ phone: OTHER, messages: [message('wamid.S2', 'שלום, אני העוזר הדיגיטלי של העסק. איך אפשר לעזור?')] }));
    assert.equal(bot.json.reply, null);
    assert.equal(bot.json.handoff?.reason, 'bot');
    const meta = await s.app.db.one<any>('SELECT meta FROM conversations WHERE id = $1', [bot.json.conversationId]);
    assert.ok(meta.meta.bot, 'the conversation is marked as a bot\'s');

    // Six answers in this conversation in the last hour (LEAD_REPLIES_PER_HOUR): the next message waits for a person.
    const calls = seen.length;
    for (let i = 0; i < 6; i++) await s.app.db.query("INSERT INTO messages (conversation_id, role, text) VALUES ($1, 'agent', 'תשובה')", [stop.json.conversationId]);
    const busy = await ask(s, request({ messages: [message('wamid.S3', 'ועוד שאלה על המחיר')] }));
    assert.deepEqual(busy.json, { reply: null, handoff: { reason: 'other', summary: 'תורן ענה כאן הרבה בזמן קצר, אז את ההודעה הזו הוא משאיר לכם.', business: null }, conversationId: stop.json.conversationId });
    assert.equal(seen.length, calls, 'no model call past the hour');
    await nothingSent(t);
  } finally {
    await s.close();
  }
});
