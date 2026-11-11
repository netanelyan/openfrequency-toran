import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conversationFor, runTurn } from '../src/agent/loop.ts';
import { ALERT_SHARE, capFor, forgetMonthSpend, LIST_ILS, liftOf, monthlyIlsOf, setLift, shareOf, STOP_SHARE, USD_ILS, usdIls, workspaceSpend } from '../src/agent/spend.ts';
import { checkingLine } from '../src/agent/guard.ts';
import { scriptedClient, type Script } from '../src/agent/llm/scripted.ts';
import type { Block, TurnReq } from '../src/agent/llm/types.ts';
import { entitlementClient } from '../src/billing/entitlement.ts';
import { seedDemo } from '../src/demoSeed.ts';
import { J } from '../src/db/index.ts';
import { usage } from '../src/db/log.ts';
import { monthOf } from '../src/plans.ts';
import { customerHealth } from '../src/ops/health.ts';
import type { App } from '../src/app.ts';
import { customer, testApp } from './helpers.ts';
import { serve } from './serve.ts';

// What a customer's store may cost us (agent/spend.ts; the owner, 2026-11-11: "make sure there is a cap where if ai
// costs of an account reach 30% of the payment of the customer, we get alerted. them on 50% it stops."): the month's
// usage of the workspace's stores against what it pays, an alert at 30%, a stop at 50% with no model call and a calm
// line to the owner, the operator's lift for the rest of the month, and TORAN_MONTHLY_CAP_USD over the stores no
// customer pays for only.

const WS = 7;
// 590 ₪ a month at 3.17 ₪ to the dollar: 30% is $55.84, 50% is $93.06.
const AT_30 = 56;
const AT_50 = 94;

function counting(text = 'כן, יש לנו ספלים.') {
  const calls: TurnReq[] = [];
  const script: Script = (req) => {
    calls.push(req);
    return [{ type: 'text', text } as Block];
  };
  return { calls, script };
}

/** accounts' last answer for a workspace, kept fresh, so nothing is asked. */
async function keepPaid(app: App, ws: number, extra: Record<string, unknown> = {}) {
  await app.db.query('INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [`entitlement:${ws}`, J({ allowed: true, access: 'paid', paidThrough: null, cancelAt: null, graceUntil: null, checkedAt: new Date().toISOString(), ...extra })]);
}

/** The fictional store as a customer's: in workspace 7, which pays 590 ₪ a month. */
async function customerStore() {
  const m = counting();
  const app = await testApp();
  app.llm = scriptedClient(m.script);
  const { storeId } = await seedDemo(app, { conversation: false });
  await app.db.query('UPDATE stores SET workspace_id = $2 WHERE id = $1', [storeId, WS]);
  await keepPaid(app, WS, { monthlyIls: 590 });
  m.calls.splice(0);
  return { app, storeId, m };
}

const another = async (app: App, domain: string, ws: number | null) =>
  (await app.db.one<{ id: number }>("INSERT INTO stores (domain, url, name, source, platform, workspace_id) VALUES ($1, $2, 'אחרת', 'manual', 'shopify', $3) RETURNING id", [domain, `https://${domain}/`, ws]))!.id;

const alertsOf = async (app: App, like: string) => (await app.db.query<{ key: string; title: string }>("SELECT data->>'key' AS key, data->>'title' AS title FROM events WHERE kind = 'operator_alert' AND data->>'key' LIKE $1 ORDER BY id", [like]));

test("a workspace's month: every store of it, a claude-cli call at its API price, never another workspace's, a lead's, ours or last month's", async () => {
  const { app, storeId } = await customerStore();
  try {
    const sibling = await another(app, 'sibling.example', WS);
    const otherWs = await another(app, 'other-ws.example', 8);
    const lead = await another(app, 'lead.example', null);
    await usage(app.db, { storeId, kind: 'llm', backend: 'api', usd: 10, apiUsd: 10, tag: 'agent' });
    await usage(app.db, { storeId: sibling, kind: 'llm', backend: 'claude-cli', usd: 0, apiUsd: 5, tag: 'agent' });
    await usage(app.db, { storeId: otherWs, kind: 'llm', backend: 'api', usd: 100, apiUsd: 100, tag: 'agent' });
    await usage(app.db, { storeId: lead, kind: 'llm', backend: 'api', usd: 50, apiUsd: 50, tag: 'agent' });
    await usage(app.db, { kind: 'bsp', backend: 'meta_line', usd: 20, apiUsd: 20, tag: 'wa_alert' });
    await app.db.query("INSERT INTO usage (store_id, at, kind, backend, usd, api_usd, tag) VALUES ($1, date_trunc('month', now() AT TIME ZONE 'Asia/Jerusalem') AT TIME ZONE 'Asia/Jerusalem' - interval '2 days', 'llm', 'api', 200, 200, 'agent')", [storeId]);
    assert.equal(await workspaceSpend(app.db, WS), 15);
    const s = await shareOf(app, WS);
    assert.equal(s.base, 590);
    assert.equal(Math.round(s.ils * 100) / 100, 47.55, 'at 3.17 ₪ to the dollar');
    assert.equal(usdIls({}), USD_ILS);
    assert.equal(usdIls({ USD_ILS: '3.5' }), 3.5);
    assert.equal(usdIls({ USD_ILS: 'nonsense' }), USD_ILS);
    assert.equal(Math.round((await shareOf({ db: app.db, env: { USD_ILS: '3.5' } }, WS)).ils * 100) / 100, 52.5);
    assert.deepEqual([ALERT_SHARE, STOP_SHARE], [0.3, 0.5]);
  } finally {
    await app.db.close();
  }
});

test('what the workspace pays: accounts\' monthlyIls, kept with its answer; without one, the plan\'s list price', async () => {
  const app = await testApp();
  try {
    let body: Record<string, unknown> = { workspace: WS, product: 'toran', enabled: true, access: 'paid', allowed: true, paidThrough: null, cancelAt: null, graceUntil: null, plan: { name: 'big', conversations: 1500 }, monthlyIls: 990 };
    let t = Date.parse('2026-11-12T10:00:00Z');
    const client = entitlementClient({ db: app.db, env: { OF_INTERNAL_TOKEN: 'x'.repeat(40) }, clock: () => t, fetchImpl: async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }) });
    assert.equal((await client.check(WS)).allowed, true);
    assert.equal(await monthlyIlsOf(app.db, WS), 990, "the workspace's own price");
    for (const [bad, plan, want] of [[undefined, { name: 'big', conversations: 1500 }, LIST_ILS.big], ['990', null, LIST_ILS.store], [0, null, LIST_ILS.store], [-5, { name: 'store', conversations: 300 }, LIST_ILS.store]] as const) {
      body = { ...body, plan, monthlyIls: bad };
      t += 10 * 60_000;
      assert.equal((await client.check(WS)).allowed, true, 'an answer without a price is still an answer');
      assert.equal(await monthlyIlsOf(app.db, WS), want, `monthlyIls ${String(bad)}, plan ${plan?.name ?? 'none'}`);
    }
    assert.equal(await monthlyIlsOf(app.db, 99, { plan: 'big' }), 1190, 'nothing kept: the store\'s own plan');
    assert.deepEqual(LIST_ILS, { store: 590, big: 1190 });
  } finally {
    await app.db.close();
  }
});

test('at 30% of what the customer pays the operator hears once that month, and the store goes on answering', async () => {
  const { app, storeId, m } = await customerStore();
  const logs: string[] = [];
  app.log = (l) => logs.push(l);
  try {
    await usage(app.db, { storeId, kind: 'llm', backend: 'api', usd: AT_30, apiUsd: AT_30, tag: 'agent' });
    const conv = await conversationFor(app.db, storeId, 'whatsapp', '972500000401');
    const first = await runTurn(app, { storeId, conversationId: conv, text: 'יש ספלים?', channel: 'whatsapp', footer: false });
    assert.equal(m.calls.length, 1, 'answered');
    assert.equal(first.handoff, null);
    await runTurn(app, { storeId, conversationId: conv, text: 'ועוד ספל?', channel: 'whatsapp', footer: false });
    assert.equal(m.calls.length, 2);
    const said = await alertsOf(app, 'cost%');
    assert.deepEqual(said.map((a) => a.key), [`cost30:ws:${WS}:${monthOf()}`], 'once');
    assert.match(said[0].title, /^המודל בחשבון 7 \(.+\) עלה החודש 30% ממה שהלקוח משלם$/);
    // The body, in the log as on the phone: the month, the cost in shekels and dollars, the share of what is paid before VAT.
    const line = logs.find((l) => l.startsWith('[alert] המודל בחשבון 7'))!;
    assert.match(line, / המודל עלה עד עכשיו 177\.52 ₪ \(\$56\.00\), שהם 30% מ-590 ₪ שהלקוח משלם על החודש לפני מע״מ\. ב-50% תורן יעצור את המודל/);
    assert.ok(line.includes(`ב${new Intl.DateTimeFormat('he-IL', { timeZone: 'Asia/Jerusalem', month: 'long', year: 'numeric' }).format(new Date())} `), line);
  } finally {
    await app.db.close();
  }
});

test('at 50% no model call: the customer gets the honest line, the owner a handoff with no cost in it, the operator one alert; the workspace\'s other store too, another workspace answers', async () => {
  const { app, storeId, m } = await customerStore();
  const logs: string[] = [];
  app.log = (l) => logs.push(l);
  try {
    const sibling = await another(app, 'sibling.example', WS);
    const otherWs = await another(app, 'other-ws.example', 8);
    await keepPaid(app, 8);
    await usage(app.db, { storeId, kind: 'llm', backend: 'api', usd: AT_50, apiUsd: AT_50, tag: 'agent' });
    const conv = await conversationFor(app.db, storeId, 'whatsapp', '972500000402');
    const out = await runTurn(app, { storeId, conversationId: conv, text: 'יש לכם קערה גדולה?', channel: 'whatsapp', footer: false });
    assert.equal(m.calls.length, 0, 'no model call');
    assert.ok(out.reply.includes(checkingLine(false)), out.reply);
    assert.equal(out.handoff?.summary, 'תורן העביר אליכם את השאלה הזו כדי שתענו עליה בעצמכם. הלקוח כתב: "יש לכם קערה גדולה?"');
    assert.doesNotMatch(`${out.reply} ${out.handoff?.summary}`, /₪|\$|%|תקרה|תקרת|עלות|הוצאה/, 'never a cost, a cap or a share');
    assert.ok(await app.db.one("SELECT 1 FROM events WHERE kind = 'handoff' AND store_id = $1", [storeId]));
    const said = await alertsOf(app, 'cost%');
    assert.deepEqual(said.map((a) => a.key), [`cost50:ws:${WS}:${monthOf()}`], 'past 50% at once: the stop alone is said');
    assert.match(said[0].title, /עצר את המודל/);
    assert.ok(logs.some((l) => /the workspace's 50% line \$93\.06 reached \(\$94\.00\)/.test(l)), logs.join('\n'));
    // The same workspace's other store stops with it; a second message is not said again.
    const conv2 = await conversationFor(app.db, sibling, 'whatsapp', '972500000403');
    await runTurn(app, { storeId: sibling, conversationId: conv2, text: 'שלום', channel: 'whatsapp', footer: false });
    assert.equal(m.calls.length, 0);
    assert.equal((await alertsOf(app, 'cost%')).length, 1, 'once');
    // Another workspace's store answers.
    const conv3 = await conversationFor(app.db, otherWs, 'whatsapp', '972500000404');
    await runTurn(app, { storeId: otherWs, conversationId: conv3, text: 'שלום', channel: 'whatsapp', footer: false });
    assert.equal(m.calls.length, 1);
    // The store's voice and its photos' looks ask the same question (capFor): past 50%, no call either.
    assert.equal((await capFor(app, { id: storeId, config: {} }))?.by, 'share');
    // The operator's health row puts the month's spend against that line: half of 590 ₪, in dollars.
    assert.equal((await customerHealth(app)).find((r) => r.storeId === storeId)?.capUsd, 93.06);
  } finally {
    await app.db.close();
  }
});

test("the operator's own capUsd still stops a customer's store when it comes first, with the same calm line", async () => {
  const { app, storeId, m } = await customerStore();
  app.llm = scriptedClient(m.script, { as: 'api', usd: 0.01 });
  try {
    await app.db.query("UPDATE stores SET config = config || '{\"capUsd\": 20}'::jsonb WHERE id = $1", [storeId]);
    await usage(app.db, { storeId, kind: 'llm', backend: 'api', usd: 21, apiUsd: 21, tag: 'agent' });
    const conv = await conversationFor(app.db, storeId, 'whatsapp', '972500000405');
    const out = await runTurn(app, { storeId, conversationId: conv, text: 'יש ספלים?', channel: 'whatsapp', footer: false });
    assert.equal(m.calls.length, 0, '$21 of a $20 cap, 11% of what it pays: stopped by the cap');
    assert.match(String(out.handoff?.summary), /^תורן העביר אליכם את השאלה הזו/);
    assert.ok(await app.db.one("SELECT 1 FROM events WHERE kind = 'operator_alert' AND data->>'key' LIKE 'cap:store:%'"));
  } finally {
    await app.db.close();
  }
});

test('the operator lifts the stop on the store\'s page for the rest of the month, audited, and can put it back; a customer cannot', async () => {
  const s = await serve();
  const id = s.seeded.storeId;
  let calls = 0;
  const inner = s.app.llm;
  s.app.llm = { backend: inner.backend, turn: (req) => (calls++, inner.turn(req)) };
  try {
    await s.app.db.query('UPDATE stores SET workspace_id = $2 WHERE id = $1', [id, WS]);
    s.accounts.price(WS, 590);
    await usage(s.app.db, { storeId: id, kind: 'llm', backend: 'api', usd: AT_50, apiUsd: AT_50, tag: 'agent' });
    const conv = await conversationFor(s.app.db, id, 'whatsapp', '972500000406');
    await runTurn(s.app, { storeId: id, conversationId: conv, text: 'יש ספלים?', channel: 'whatsapp', footer: false });
    assert.equal(calls, 0, 'stopped');

    // A customer of the workspace cannot lift it.
    s.as(s.accounts.session(customer(WS)).cookie);
    const ctoken = await s.csrf(`/lead/${id}/knowledge`);
    assert.equal((await s.post(`/lead/${id}/cost-lift`, { _csrf: ctoken, on: '1' })).status, 403);
    assert.equal(await liftOf(s.app.db, WS), null);

    s.login();
    const page = await (await s.get(`/lead/${id}`)).text();
    assert.match(page, /תורן עצר את המודל בחנויות של החשבון עד סוף החודש/);
    assert.match(page, /\(\$94\.00\) בחנויות של החשבון, 50% מ-590 ₪ שהלקוח משלם על החודש לפני מע״מ/);
    const token = /name="_csrf" value="([^"]+)"/.exec(page)![1];
    const lift = await s.post(`/lead/${id}/cost-lift`, { _csrf: token, on: '1' });
    assert.equal(lift.status, 303);
    assert.equal((await liftOf(s.app.db, WS))?.month, monthOf());
    const row = await s.app.db.one<any>("SELECT actor, store_id, detail FROM audit WHERE action = 'cost_lift'");
    assert.equal(row.store_id, id);
    assert.equal(row.detail.workspace, WS);
    assert.equal(row.detail.month, monthOf());
    assert.equal(row.detail.monthlyIls, 590);
    assert.equal(row.detail.usd, 94);
    assert.match(await (await s.get(`/lead/${id}`)).text(), /המודל עונה שוב בחנויות של החשבון עד סוף החודש/);
    await runTurn(s.app, { storeId: id, conversationId: conv, text: 'ועוד שאלה', channel: 'whatsapp', footer: false });
    assert.ok(calls > 0, 'lifted: answered again');

    // Put back: stopped again, and audited.
    const before = calls;
    const token2 = /name="_csrf" value="([^"]+)"/.exec(await (await s.get(`/lead/${id}`)).text())![1];
    assert.equal((await s.post(`/lead/${id}/cost-lift`, { _csrf: token2, on: '0' })).status, 303);
    assert.equal(await liftOf(s.app.db, WS), null);
    assert.ok(await s.app.db.one("SELECT 1 FROM audit WHERE action = 'cost_stop' AND store_id = $1", [id]));
    await runTurn(s.app, { storeId: id, conversationId: conv, text: 'ושוב', channel: 'whatsapp', footer: false });
    assert.equal(calls, before, 'stopped again');
  } finally {
    await s.close();
  }
});

test('TORAN_MONTHLY_CAP_USD counts and stops only the stores no customer pays for: a customer\'s store answers past it, and its spend never fills it', async () => {
  const { app, storeId, m } = await customerStore();
  app.llm = scriptedClient(m.script, { as: 'api', usd: 0 });
  app.env.TORAN_MONTHLY_CAP_USD = '1';
  try {
    const lead = await another(app, 'lead.example', null);
    // A customer's $5 is not ours: the lead still answers.
    await usage(app.db, { storeId, kind: 'llm', backend: 'api', usd: 5, apiUsd: 5, tag: 'agent' });
    forgetMonthSpend();
    const leadConv = await conversationFor(app.db, lead, 'whatsapp', '972500000407');
    await runTurn(app, { storeId: lead, conversationId: leadConv, text: 'שלום', extId: 'g-1' });
    assert.equal(m.calls.length, 1, "the customer's spend does not fill our cap");
    // Ours past the cap (our number's messages, a lead's calls): the lead stops, the customer's store answers.
    await usage(app.db, { kind: 'bsp', backend: 'meta_line', usd: 0.6, apiUsd: 0.6, tag: 'wa_alert' });
    await usage(app.db, { storeId: lead, kind: 'llm', backend: 'api', usd: 0.5, apiUsd: 0.5, tag: 'agent' });
    forgetMonthSpend();
    const stopped = await runTurn(app, { storeId: lead, conversationId: leadConv, text: 'ועוד', extId: 'g-2' });
    assert.equal(m.calls.length, 1, 'the lead: no model call');
    assert.match(String(stopped.handoff?.summary), /תקרת ההוצאה/);
    const conv = await conversationFor(app.db, storeId, 'whatsapp', '972500000408');
    await runTurn(app, { storeId, conversationId: conv, text: 'יש ספלים?', channel: 'whatsapp', footer: false });
    assert.equal(m.calls.length, 2, "the customer's store answers past our cap");
    assert.ok(await app.db.one("SELECT 1 FROM events WHERE kind = 'operator_alert' AND data->>'key' LIKE 'cap:global:%'"));
  } finally {
    forgetMonthSpend();
    await app.db.close();
  }
});

test("the operator's ring counts what our cap counts: a customer's spend is not in it", async () => {
  const s = await serve();
  try {
    s.app.env.TORAN_MONTHLY_CAP_USD = '20';
    await s.app.db.query('UPDATE stores SET workspace_id = $2 WHERE id = $1', [s.seeded.storeId, WS]);
    await usage(s.app.db, { storeId: s.seeded.storeId, kind: 'llm', backend: 'api', usd: 9, apiUsd: 9, tag: 'agent' });
    await usage(s.app.db, { kind: 'llm', backend: 'claude-cli', usd: 0, apiUsd: 1.5, tag: 'pay_check' });
    s.login();
    const html = await (await s.get('/leads')).text();
    assert.match(html, /title="טוקנים החודש בלי החנויות של הלקוחות: 150 מתוך 2,000"/);
  } finally {
    await s.close();
  }
});

test('the month rolls over: last month\'s cost does not count, and a lift holds only for the month it was given', async () => {
  const { app, storeId, m } = await customerStore();
  try {
    await app.db.query("INSERT INTO usage (store_id, at, kind, backend, usd, api_usd, tag) VALUES ($1, date_trunc('month', now() AT TIME ZONE 'Asia/Jerusalem') AT TIME ZONE 'Asia/Jerusalem' - interval '2 days', 'llm', 'api', $2, $2, 'agent')", [storeId, AT_50 * 3]);
    const conv = await conversationFor(app.db, storeId, 'whatsapp', '972500000409');
    await runTurn(app, { storeId, conversationId: conv, text: 'יש ספלים?', channel: 'whatsapp', footer: false });
    assert.equal(m.calls.length, 1, "last month's $282 is not this month's");
    // This month's spend, read from next month, is nothing; next month's alerts are keys of their own.
    await usage(app.db, { storeId, kind: 'llm', backend: 'api', usd: AT_50, apiUsd: AT_50, tag: 'agent' });
    const nextMonth = Date.now() + 32 * 86_400_000;
    assert.equal(await workspaceSpend(app.db, WS), AT_50);
    assert.equal(await workspaceSpend(app.db, WS, nextMonth), 0);
    await setLift(app, WS, true, { actor: 'operator', storeId });
    assert.equal((await liftOf(app.db, WS))?.by, 'operator');
    assert.equal(await liftOf(app.db, WS, nextMonth), null, "this month's lift is gone next month");
    assert.notEqual(monthOf(nextMonth), monthOf());
  } finally {
    await app.db.close();
  }
});
