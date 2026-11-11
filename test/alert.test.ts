import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import * as alert from '../src/ops/alert.ts';
import { publicRoutes } from '../src/web/public.ts';
import { accountsClient } from '../src/web/accounts.ts';
import { deliveryStatus } from '../src/channels/waStore.ts';
import { ROOT } from '../src/core/paths.ts';
import type { App } from '../src/app.ts';
import { INTERNAL_TOKEN, META_DEMO, testApp } from './helpers.ts';
import { serve } from './serve.ts';

// The operator's alerts on the owner's own WhatsApp (the owner, 2026-11-03: "alerts can be sent to my own whatsapp"):
// with TORAN_ALERT_WA set, an alert is one approved template message (operator_alert) from our number on Meta's Cloud
// API, beside the log and the alert command; Teder hands its alerts to Toran at POST /internal/ops/alert. Meta is a
// stand-in here: nothing leaves this machine. The owner's real number is only in the server's private .env (check:public
// refuses a real number in this public repository), so the tests use the fictional 050-000-0493, spelled several ways.

const NUMBER = '972500000493';
const WRONG = 'wrong-token-wrong-token-wrong-token-00';
const EXAMPLE = JSON.parse(readFileSync(path.join(ROOT, 'test', 'fixtures', 'ops-alert.json'), 'utf8'));
const TEDER_ALERT = EXAMPLE.routes[0].request.body;

type Call = { path: string; auth: string | null; body: any };

/**
 * Meta's send for our demo number, with our token. `refuse` answers every message as Meta answers a template it does not
 * have (not approved yet, or never created): HTTP 400, error code 132001 (Meta's error-code page; the code reads the
 * status and the message, not these exact words).
 */
function fakeMeta() {
  const calls: Call[] = [];
  const state = { refuse: false };
  const f = (async (input: any, init: any = {}) => {
    const p = new URL(String(input)).pathname.replace(/^\/v\d+\.\d+\//, '');
    const auth = (init.headers as any)?.authorization || null;
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ path: p, auth, body });
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
    if (auth !== `Bearer ${META_DEMO.META_SYSTEM_TOKEN}` || p !== `${META_DEMO.META_DEMO_PHONE_ID}/messages` || init.method !== 'POST') return json({ error: { message: 'refused', code: 1 } }, 400);
    if (state.refuse) return json({ error: { message: '(#132001) Template name does not exist in the translation', type: 'OAuthException', code: 132001, error_data: { messaging_product: 'whatsapp', details: 'template name (operator_alert) does not exist in he' } } }, 400);
    return json({ messaging_product: 'whatsapp', contacts: [{ input: body?.to, wa_id: body?.to }], messages: [{ id: `wamid.alert-${calls.length}` }] });
  }) as typeof fetch;
  return { f, calls, state };
}

/** The command an alert runs, as a fake: each run's arguments. */
function fakeCommand() {
  const runs: string[][] = [];
  const run = ((cmd: string, args: string[], _opts: unknown, cb: (e: Error | null) => void) => {
    runs.push([cmd, ...args]);
    cb(null);
  }) as any;
  return { runs, run };
}

async function alertApp(env: Record<string, string> = {}) {
  const app = await testApp();
  const meta = fakeMeta();
  const logs: string[] = [];
  app.graph = meta.f;
  app.log = (m: string) => logs.push(m);
  Object.assign(app.env, META_DEMO, { TORAN_ALERT_CMD: '/usr/local/bin/of-alert-test' }, env);
  return { app, meta, logs };
}

/** The alert's template message, as the Cloud API takes it. */
const templateTo = (to: string, title: string, body: string) => ({
  messaging_product: 'whatsapp',
  recipient_type: 'individual',
  to,
  type: 'template',
  template: { name: 'operator_alert', language: { code: 'he' }, components: [{ type: 'body', parameters: [{ type: 'text', text: title }, { type: 'text', text: body }] }] },
});

/** Every alert and every WhatsApp try, an hour and a minute older: the hour they wait out has passed. */
const anHourLater = (app: App) => app.db.query("UPDATE events SET at = at - interval '61 minutes' WHERE kind IN ('operator_alert', 'operator_alert_wa')");

const chars = (s: string) => [...s].length;

test('the template is defined in code as it was submitted to Meta, and docs/whatsapp-templates.md is written from it', () => {
  assert.deepEqual(alert.OPERATOR_ALERT, {
    name: 'operator_alert',
    category: 'UTILITY',
    language: 'he',
    body: 'עדכון על החשבון שלכם ב-OpenFrequency:\n{{1}}\n{{2}}\nאת הפרטים המלאים אפשר לראות בלוח הבקרה של החשבון.',
    example: ['תדר: השירות הופעל מחדש אחרי תקלה', 'הבדיקה של 08:00 לא הצליחה להתחבר לשירות הפרסום.'],
  });
  const doc = readFileSync(path.join(ROOT, 'docs', 'whatsapp-templates.md'), 'utf8');
  assert.equal(typeof alert.alertTemplateDoc, 'function');
  assert.ok(doc.includes(alert.alertTemplateDoc()), 'docs/whatsapp-templates.md has the operator_alert section as the code writes it (node scripts/templates-doc.ts)');
  assert.ok(doc.includes(['```', alert.OPERATOR_ALERT.body, '```'].join('\n')), 'the body to paste, exactly, line by line');
});

test('TORAN_ALERT_WA in any spelling is the number in international digits; empty or not a number is no WhatsApp', () => {
  for (const spelled of ['050-000-0493', '0500000493', '+972 50-000-0493', '972500000493', '00972500000493', '(050) 000 0493', ' 050 000 0493 ']) {
    assert.equal(alert.alertNumber?.({ TORAN_ALERT_WA: spelled }), NUMBER, spelled);
  }
  for (const none of [undefined, '', '   ', 'off', '123']) assert.equal(alert.alertNumber?.({ TORAN_ALERT_WA: none }), null, String(none));
});

test('an alert with TORAN_ALERT_WA set: one template message to the owner from our number, its title and body one line each, clipped to fit', async () => {
  const { app, meta, logs } = await alertApp({ TORAN_ALERT_WA: '050-000-0493' });
  const cmd = fakeCommand();
  try {
    const title = 'הודעות של לקוחות\nמחכות\tבתור      עכשיו';
    const body = `שורה ראשונה\r\nשורה שנייה\t\tוטאב${' '.repeat(8)}${'x'.repeat(3000)}`;
    assert.equal(await alert.alertOperator(app, 'queue_old', title, body, { everyMinutes: 30, run: cmd.run }), true);
    assert.equal(meta.calls.length, 1, 'one message');
    const [c] = meta.calls;
    assert.equal(c.path, `${META_DEMO.META_DEMO_PHONE_ID}/messages`, 'from our number on the Cloud API');
    assert.equal(c.auth, `Bearer ${META_DEMO.META_SYSTEM_TOKEN}`);
    const [t, b] = c.body.template.components[0].parameters.map((x: any) => x.text);
    assert.deepEqual(c.body, templateTo(NUMBER, t, b), 'the template, in Hebrew, to the number in international digits');
    assert.equal(t, 'תורן: הודעות של לקוחות מחכות בתור עכשיו', 'the title on one line, the product first');
    assert.ok(b.startsWith('שורה ראשונה שורה שנייה וטאב xxx'), b.slice(0, 40));
    for (const v of [t, b]) {
      assert.doesNotMatch(v, /[\n\r\t]/, 'no newline, no tab');
      assert.doesNotMatch(v, / {2}/, 'never two spaces in a row (Meta refuses more than four)');
      assert.ok(chars(v) <= 1024, 'at most 1024 characters');
    }
    assert.ok(b.endsWith('…'), 'the body is clipped, and says so');
    const filled = alert.OPERATOR_ALERT.body.replace('{{1}}', t).replace('{{2}}', b);
    assert.equal(chars(filled), 1024, 'the whole message, the template\'s own text and both values, is clipped to 1024 exactly');
    assert.deepEqual(cmd.runs, [['/usr/local/bin/of-alert-test', `תורן: ${title.replace(/\s+/g, ' ')}`, body.replace(/\s+/g, ' ').slice(0, 999) + '…']], 'the command still runs, as before');
    assert.ok(logs.some((l) => l.startsWith('[alert] הודעות של לקוחות')), 'and the log line');
    assert.ok(logs.some((l) => /\[alert\] WhatsApp to …0493: sent/.test(l)), logs.join('\n'));
    assert.ok(!logs.join('\n').includes(META_DEMO.META_SYSTEM_TOKEN) && !logs.join('\n').includes(NUMBER), 'the log names neither the token nor the whole number');
    const wa = await app.db.query<any>("SELECT data FROM events WHERE kind = 'operator_alert_wa'");
    assert.deepEqual(wa.map((r) => [r.data.key, r.data.ok]), [['queue_old', true]], 'the try is kept, for the next one');
  } finally {
    await app.db.close();
  }
});

test('TORAN_ALERT_WA not set: nothing is sent to WhatsApp, and the alert is the log and the command as before', async () => {
  for (const env of [{}, { TORAN_ALERT_WA: '' }, { TORAN_ALERT_WA: 'not-a-number' }] as Record<string, string>[]) {
    const { app, meta, logs } = await alertApp(env);
    const cmd = fakeCommand();
    try {
      assert.equal(await alert.alertOperator(app, 'queue_old', 'הודעות מחכות בתור', 'שלוש הודעות', { run: cmd.run }), true);
      assert.equal(meta.calls.length, 0, `nothing at Meta: ${JSON.stringify(env)}`);
      assert.equal(cmd.runs.length, 1);
      assert.ok(logs.some((l) => l.startsWith('[alert] הודעות מחכות בתור: שלוש הודעות')));
      if (env.TORAN_ALERT_WA === 'not-a-number') assert.ok(logs.some((l) => /TORAN_ALERT_WA is not a phone number/.test(l)), 'a setting that is not a number says so');
    } finally {
      await app.db.close();
    }
  }
});

test('Meta refuses (the template is not approved yet): a log line, no throw, no second try within the hour, and the command still runs', async () => {
  const { app, meta, logs } = await alertApp({ TORAN_ALERT_WA: '0500000493' });
  const cmd = fakeCommand();
  meta.state.refuse = true;
  try {
    assert.equal(await alert.alertOperator(app, 'lost:41', 'הודעה שתורן לא הצליח לטפל בה', 'עבודה 41 נכשלה', { run: cmd.run }), true, 'said, whatever Meta answered');
    assert.equal(meta.calls.length, 1, 'tried once');
    assert.equal(cmd.runs.length, 1, 'the command ran');
    const refused = logs.find((l) => l.startsWith('[alert] !!! WhatsApp to …0493 FAILED: '));
    assert.ok(refused && /132001/.test(refused) && /operator_alert/.test(refused) && /60 minutes/.test(refused), refused);

    // The same key inside its window: not said again, anywhere.
    assert.equal(await alert.alertOperator(app, 'lost:41', 'הודעה שתורן לא הצליח לטפל בה', 'עבודה 41 נכשלה', { run: cmd.run }), false);
    // Another key inside the hour: the log and the command, and no try at Meta, which would refuse it the same way.
    assert.equal(await alert.alertOperator(app, 'lost:42', 'הודעה שתורן לא הצליח לטפל בה', 'עבודה 42 נכשלה', { run: cmd.run }), true);
    assert.equal(meta.calls.length, 1, 'no second try within the hour');
    assert.equal(cmd.runs.length, 2);
    assert.ok(logs.some((l) => /^\[alert\] !!! WhatsApp to …0493 NOT SENT: Meta refused one at /.test(l)), `said loudly, each time: ${logs.join('\n')}`);

    // An hour on, and the template approved: the next alert goes.
    await anHourLater(app);
    meta.state.refuse = false;
    assert.equal(await alert.alertOperator(app, 'lost:43', 'הודעה שתורן לא הצליח לטפל בה', 'עבודה 43 נכשלה', { run: cmd.run }), true);
    assert.equal(meta.calls.length, 2);
    assert.equal(meta.calls[1].body.to, NUMBER);
  } finally {
    await app.db.close();
  }
});

test('Meta not answering at all, or none of our numbers on Meta: a log line, never a throw', async () => {
  const { app, meta, logs } = await alertApp({ TORAN_ALERT_WA: NUMBER });
  try {
    app.graph = (async () => {
      throw new Error('fetch failed');
    }) as typeof fetch;
    assert.equal(await alert.alertOperator(app, 'k:down', 'כותרת', 'גוף', { run: fakeCommand().run }), true);
    assert.ok(logs.some((l) => /^\[alert\] !!! WhatsApp to …0493 FAILED: .*fetch failed/.test(l)), logs.join('\n'));
    await anHourLater(app);
    app.graph = meta.f;
    delete app.env.META_DEMO_PHONE_ID;
    assert.equal(await alert.alertOperator(app, 'k:nonumber', 'כותרת', 'גוף', { run: fakeCommand().run }), true);
    assert.ok(logs.some((l) => /^\[alert\] !!! WhatsApp to …0493 FAILED: .*none of our numbers is on Meta/.test(l)), logs.join('\n'));
    assert.equal(meta.calls.length, 0);
  } finally {
    await app.db.close();
  }
});

test("a message Meta took and then could not deliver (its webhook's failed status) is said loudly, and holds the phone for the hour", async () => {
  const { app, meta, logs } = await alertApp({ TORAN_ALERT_WA: NUMBER });
  try {
    assert.equal(await alert.alertOperator(app, 'cap:global:2026-11', 'תורן הגיע לתקרת ההוצאה', 'הוצאה החודש: $10', { run: fakeCommand().run }), true);
    assert.equal(meta.calls.length, 1);
    const status = { account: META_DEMO.META_DEMO_PHONE_ID, id: 'wamid.alert-1', status: 'failed', to: NUMBER, error: '131049: This message was not delivered to maintain healthy ecosystem engagement.' };
    await deliveryStatus(app, status);
    assert.ok(logs.some((l) => l.startsWith('[alert] !!! WhatsApp FAILED: Meta took the alert cap:global:2026-11 and then could not deliver it (131049: ')), logs.join('\n'));
    // Kept with Meta's code, read from the front of its error.
    assert.equal((await app.db.one<{ code: string }>("SELECT data->>'code' AS code FROM events WHERE kind = 'operator_alert_wa' AND data->>'ok' = 'false'"))?.code, '131049');
    assert.equal(await alert.alertOperator(app, 'queue_old', 'הודעות מחכות', 'שלוש', { run: fakeCommand().run }), true);
    assert.equal(meta.calls.length, 1, 'not tried in the hour after');
    assert.ok(logs.some((l) => /^\[alert\] !!! WhatsApp to …0493 NOT SENT: Meta refused one at /.test(l)));
    // A failure of any other message of ours is not an alert's, and is kept as before.
    logs.length = 0;
    await deliveryStatus(app, { ...status, id: 'wamid.someone-else' });
    assert.ok(!logs.some((l) => l.includes('!!!')));
    assert.ok(await app.db.one("SELECT 1 FROM events WHERE kind = 'wa_failed' AND data->>'id' = 'wamid.someone-else'"));
  } finally {
    await app.db.close();
  }
});

test('the same key twice within its window is one message; a short window still reaches the phone once an hour; at most ten an hour', async () => {
  const { app, meta } = await alertApp({ TORAN_ALERT_WA: NUMBER });
  const cmd = fakeCommand();
  const say = (key: string, everyMinutes = 60) => alert.alertOperator(app, key, 'כותרת', 'גוף', { everyMinutes, run: cmd.run });
  try {
    assert.equal(await say('queue_old', 30), true);
    assert.equal(await say('queue_old', 30), false, 'inside its 30 minutes: not said');
    assert.equal(meta.calls.length, 1);
    // 31 minutes on, the key is due again for the log and the command, but its WhatsApp message went 31 minutes ago.
    await app.db.query("UPDATE events SET at = at - interval '31 minutes'");
    assert.equal(await say('queue_old', 30), true);
    assert.equal(meta.calls.length, 1, 'the phone hears of one key at most once an hour');
    assert.equal(cmd.runs.length, 2);
    await anHourLater(app);
    assert.equal(await say('queue_old', 30), true);
    assert.equal(meta.calls.length, 2, 'and again after the hour');

    // Ten different problems in an hour reach the phone; the eleventh is the log and the command only.
    for (let i = 0; i < 9; i++) await say(`burst:${i}`);
    assert.equal(meta.calls.length, 11, 'ten in this hour (one of them queue_old)');
    assert.equal(await say('burst:9'), true);
    assert.equal(meta.calls.length, 11, 'the eleventh in the hour is not sent');
    assert.equal(cmd.runs.length, 13, 'every one of them in the log and the command');
  } finally {
    await app.db.close();
  }
});

// ---- Teder's alerts: POST /internal/ops/alert

type S = Awaited<ReturnType<typeof serve>>;
const post = (s: S, body: unknown, { token = INTERNAL_TOKEN as string | null, method = 'POST', headers = {} as Record<string, string>, raw = undefined as string | undefined } = {}) =>
  fetch(`${s.base}/internal/ops/alert`, {
    method,
    redirect: 'manual',
    headers: { ...(token == null ? {} : { authorization: `Bearer ${token}` }), 'content-type': 'application/json', ...headers },
    ...(method === 'GET' ? {} : { body: raw ?? JSON.stringify(body) }),
  }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

async function served() {
  const s = await serve();
  const meta = fakeMeta();
  const logs: string[] = [];
  s.app.graph = meta.f;
  s.app.log = (m: string) => logs.push(m);
  // A command that would fail if it ran: Teder runs its own, so Toran must not run one for Teder's alert.
  Object.assign(s.app.env, META_DEMO, { TORAN_ALERT_WA: '050-000-0493', TORAN_ALERT_CMD: process.execPath });
  return { s, meta, logs };
}

test("Teder's alert, the shared example: taken, and sent on as one template, its title as Teder wrote it; the same again inside its window is not", async () => {
  const { s, meta, logs } = await served();
  try {
    const first = await post(s, TEDER_ALERT);
    assert.deepEqual(first, { status: 200, json: { ok: true, due: true } });
    assert.equal(meta.calls.length, 1);
    assert.deepEqual(meta.calls[0].body, templateTo(NUMBER, TEDER_ALERT.title, TEDER_ALERT.body));
    const kept = await s.app.db.one<any>("SELECT data FROM events WHERE kind = 'operator_alert'");
    assert.equal(kept?.data.key, `teder:${TEDER_ALERT.key}`, "Teder's keys apart from Toran's");
    assert.ok(logs.some((l) => l === `[alert] ${TEDER_ALERT.title}: ${TEDER_ALERT.body}`), logs.join('\n'));
    assert.ok(!logs.some((l) => /failed/.test(l)), "no command run for Teder's alert: Teder runs its own");

    const again = await post(s, TEDER_ALERT);
    assert.deepEqual(again, { status: 200, json: { ok: true, due: false } });
    assert.equal(meta.calls.length, 1, 'the same key inside its everyMinutes: nothing sent');

    // The example's answers, case by case, from the real route.
    const was = s.app.env.OF_INTERNAL_TOKEN;
    delete s.app.env.OF_INTERNAL_TOKEN;
    const unset = await post(s, TEDER_ALERT);
    s.app.env.OF_INTERNAL_TOKEN = was;
    const got = [first, again, unset, await post(s, TEDER_ALERT, { headers: { 'x-forwarded-for': '203.0.113.9' } }), await post(s, TEDER_ALERT, { token: null }), await post(s, null, { method: 'GET' }), await post(s, {})];
    assert.deepEqual(got, EXAMPLE.routes[0].answers.map((a: any) => ({ status: a.status, json: a.body })), 'every case of test/fixtures/ops-alert.json');
  } finally {
    await s.close();
  }
});

test('the route refuses without the token, from another machine, through Caddy, by GET, and a body that is not an alert; none of them says anything', async () => {
  const { s, meta } = await served();
  try {
    const ok = { key: 'nothing-drafted:demo', title: 'Teder: x', body: 'y', everyMinutes: 60 };
    const cases: [string, Promise<{ status: number; json: any }>, number, string][] = [
      ['no token', post(s, ok, { token: null }), 401, 'bad_token'],
      ['a wrong token', post(s, ok, { token: WRONG }), 401, 'bad_token'],
      ['through Caddy', post(s, ok, { headers: { 'x-forwarded-for': '203.0.113.9' } }), 403, 'forbidden'],
      ['GET', post(s, null, { method: 'GET' }), 405, 'method_not_allowed'],
      ['GET without the token', post(s, null, { method: 'GET', token: null }), 401, 'bad_token'],
      ['GET through Caddy', post(s, null, { method: 'GET', headers: { 'x-forwarded-for': '203.0.113.9' } }), 403, 'forbidden'],
      ['nothing', post(s, {}), 400, 'bad_alert'],
      ['no title', post(s, { key: 'a' }), 400, 'bad_alert'],
      ['an empty title', post(s, { key: 'a', title: '   ' }), 400, 'bad_alert'],
      ['a title too long', post(s, { key: 'a', title: 'x'.repeat(501) }), 400, 'bad_alert'],
      ['no key', post(s, { title: 'x' }), 400, 'bad_alert'],
      ['a key with a space', post(s, { key: 'a b', title: 'x' }), 400, 'bad_alert'],
      ['a key too long', post(s, { key: 'k'.repeat(121), title: 'x' }), 400, 'bad_alert'],
      ['a key as a number', post(s, { key: 5, title: 'x' }), 400, 'bad_alert'],
      ['a body as a number', post(s, { key: 'a', title: 'x', body: 5 }), 400, 'bad_alert'],
      ['a body too long', post(s, { key: 'a', title: 'x', body: 'y'.repeat(4001) }), 400, 'bad_alert'],
      ['everyMinutes zero', post(s, { ...ok, everyMinutes: 0 }), 400, 'bad_alert'],
      ['everyMinutes a fraction', post(s, { ...ok, everyMinutes: 1.5 }), 400, 'bad_alert'],
      ['everyMinutes a string', post(s, { ...ok, everyMinutes: '60' }), 400, 'bad_alert'],
      ['everyMinutes past 30 days', post(s, { ...ok, everyMinutes: 43_201 }), 400, 'bad_alert'],
      ['not JSON', post(s, null, { raw: 'key=a&title=x' }), 400, 'bad_alert'],
      ['a list', post(s, [ok]), 400, 'bad_alert'],
      ['too large', post(s, null, { raw: JSON.stringify({ ...ok, pad: 'p'.repeat(9000) }) }), 400, 'bad_alert'],
    ];
    for (const [label, call, status, error] of cases) assert.deepEqual(await call, { status, json: { error } }, label);
    const was = s.app.env.OF_INTERNAL_TOKEN;
    delete s.app.env.OF_INTERNAL_TOKEN;
    assert.deepEqual(await post(s, ok), { status: 503, json: { error: 'not_configured' } }, 'OF_INTERNAL_TOKEN unset here');
    s.app.env.OF_INTERNAL_TOKEN = was;

    // A socket that is not this machine's (the route's own check: Toran listens on 127.0.0.1 behind Caddy).
    const route = publicRoutes(s.app, accountsClient({ env: s.app.env })).find(([m, re]) => m === 'POST' && re.test('/internal/ops/alert'));
    assert.ok(route, 'POST /internal/ops/alert is a route');
    for (const remoteAddress of ['203.0.113.9', '::ffff:10.0.0.4']) {
      const out = await route[2]({ req: { headers: { authorization: `Bearer ${INTERNAL_TOKEN}` }, socket: { remoteAddress } }, raw: JSON.stringify(ok) } as any, [] as any);
      assert.deepEqual([out.status, out.json], [403, { error: 'forbidden' }], remoteAddress);
    }
    assert.equal(meta.calls.length, 0, 'nothing sent');
    assert.equal((await s.app.db.query("SELECT 1 FROM events WHERE kind = 'operator_alert'")).length, 0, 'nothing said');

    // And a well-formed one with no body and no window is taken: Toran's own hour.
    assert.deepEqual(await post(s, { key: 'batch-deadline', title: 'Teder: a batch ran past its deadline' }), { status: 200, json: { ok: true, due: true } });
    assert.equal(meta.calls[0].body.template.components[0].parameters[1].text, '-', 'an empty body is a dash, as Meta takes no empty value');
  } finally {
    await s.close();
  }
});

// ---- the example both sides read

/**
 * Teder's copy of test/fixtures/ops-alert.json, when its checkout is beside this one: walking up from this repo's root,
 * the first openfrequency-teder found; its worktree of this checkout's own name when this is a worktree and it has one
 * (one change in flight on both sides), else its main checkout.
 */
function tederExample(): string | null {
  const ours = path.basename(path.dirname(ROOT)) === 'worktrees' && path.basename(path.dirname(path.dirname(ROOT))) === '.claude' ? path.basename(ROOT) : null;
  let dir = ROOT;
  for (let i = 0; i < 6; i++) {
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
    const teder = path.join(dir, 'openfrequency-teder');
    if (!existsSync(teder)) continue;
    const paired = ours ? path.join(teder, '.claude', 'worktrees', ours, 'test', 'fixtures', 'ops-alert.json') : null;
    if (paired && existsSync(paired)) return paired;
    const main = path.join(teder, 'test', 'fixtures', 'ops-alert.json');
    return existsSync(main) ? main : null;
  }
  return null;
}

test("the example is Teder's own: test/fixtures/ops-alert.json is byte-identical to Teder's when that checkout is beside this one", (t) => {
  const theirs = tederExample();
  if (!theirs) {
    t.diagnostic('no openfrequency-teder checkout with test/fixtures/ops-alert.json beside this one: not compared (as in CI)');
    return;
  }
  assert.ok(readFileSync(path.join(ROOT, 'test', 'fixtures', 'ops-alert.json')).equals(readFileSync(theirs)), `test/fixtures/ops-alert.json differs from ${theirs}: copy it again`);
  t.diagnostic(`byte-identical to ${theirs}`);
  assert.ok(readdirSync(path.join(ROOT, 'test', 'fixtures', 'contracts')).every((f) => f !== 'ops-alert.json'), "not among accounts' contracts");
});

test('a title that already says "תורן:" is not given it twice, on the phone or in the command (the audit of 2026-11-12, P2-28)', async () => {
  const { app, meta } = await alertApp({ TORAN_ALERT_WA: '050-000-0493' });
  const cmd = fakeCommand();
  try {
    assert.equal(await alert.alertOperator(app, 'waiting:7', 'תורן: לקוח מחכה בכלי חרס של נורית', 'בשבועיים הראשונים שלה.', { run: cmd.run }), true);
    const [t] = meta.calls[0].body.template.components[0].parameters.map((x: any) => x.text);
    assert.equal(t, 'תורן: לקוח מחכה בכלי חרס של נורית');
    assert.equal(cmd.runs[0][1], 'תורן: לקוח מחכה בכלי חרס של נורית');
    assert.equal(alert.withName('הודעות מחכות בתור'), 'תורן: הודעות מחכות בתור', 'the others as before');
  } finally {
    await app.db.close();
  }
});
