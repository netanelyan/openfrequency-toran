import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import * as remind from '../src/billing/remind.ts';
import { parseWebhook } from '../src/channels/meta.ts';
import { deliveryStatus } from '../src/channels/waStore.ts';
import { handleInbound } from '../src/wa/router.ts';
import { publicRoutes } from '../src/web/public.ts';
import { accountsClient } from '../src/web/accounts.ts';
import { ROOT } from '../src/core/paths.ts';
import type { App } from '../src/app.ts';
import type { Out } from '../src/web/server.ts';
import { INTERNAL_TOKEN, META_DEMO, testApp } from './helpers.ts';
import { serve } from './serve.ts';

// The payment reminders on WhatsApp (the owner, 2026-11-03: "add a reminder to pay for the new month, whatsapp, email
// and dashboard. A user has 72 hours to pay for a new month once their subscription has ended"): accounts' daily run
// hands each one over at POST /internal/pay/remind (its docs/contracts/pay-remind.json, test/fixtures/contracts here),
// and Toran sends the approved template payment_reminder from our number, once, under the phone's limits; its button
// comes back to the pay flow with the workspace's code. Meta and accounts are stand-ins: nothing leaves this machine.
// The numbers are fictional (050-000-0xxx).

const CONTRACT = JSON.parse(readFileSync(path.join(ROOT, 'test', 'fixtures', 'contracts', 'pay-remind.json'), 'utf8'));
const EXAMPLE = CONTRACT.routes[0].request.body;
const PHONE = EXAMPLE.phone as string;
const OTHER = '972500000431';
const WRONG = 'wrong-token-wrong-token-wrong-token-00';

type Call = { path: string; auth: string | null; body: any };

/** Meta's send for our demo number: takes each message, or refuses it as a template it does not have, or is down. */
function fakeMeta() {
  const calls: Call[] = [];
  const state = { refuse: false, down: false };
  const f = (async (input: any, init: any = {}) => {
    const p = new URL(String(input)).pathname.replace(/^\/v\d+\.\d+\//, '');
    const auth = (init.headers as any)?.authorization || null;
    const body = init.body ? JSON.parse(String(init.body)) : null;
    if (state.down) throw new Error('fetch failed');
    calls.push({ path: p, auth, body });
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
    if (auth !== `Bearer ${META_DEMO.META_SYSTEM_TOKEN}` || !p.endsWith('/messages') || init.method !== 'POST') return json({ error: { message: 'refused', code: 1 } }, 400);
    if (state.refuse) return json({ error: { message: '(#132001) Template name does not exist in the translation', type: 'OAuthException', code: 132001, error_data: { messaging_product: 'whatsapp', details: `template name (payment_reminder) does not exist in he for ${body?.to}` } } }, 400);
    return json({ messaging_product: 'whatsapp', contacts: [{ input: body?.to, wa_id: body?.to }], messages: [{ id: `wamid.remind-${calls.length}` }] });
  }) as typeof fetch;
  return { f, calls, state };
}

async function remindApp(env: Record<string, string> = {}) {
  const app = await testApp();
  const meta = fakeMeta();
  const logs: string[] = [];
  app.graph = meta.f;
  app.log = (m: string) => logs.push(m);
  Object.assign(app.env, META_DEMO, env);
  return { app, meta, logs };
}

/** The template message the Cloud API takes for one reminder: the body's four values and the button's payload. */
const templateTo = (to: string, vars: string[], payload: string) => ({
  messaging_product: 'whatsapp',
  recipient_type: 'individual',
  to,
  type: 'template',
  template: {
    name: 'payment_reminder',
    language: { code: 'he' },
    components: [
      { type: 'body', parameters: vars.map((text) => ({ type: 'text', text })) },
      { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload }] },
    ],
  },
});

const tries = async (app: App) => (await app.db.query<any>("SELECT data FROM events WHERE kind = 'pay_reminder_wa' ORDER BY id")).map((r) => r.data);
const older = (app: App, minutes: number) => app.db.query(`UPDATE events SET at = at - interval '${minutes} minutes' WHERE kind IN ('pay_reminder_wa', 'operator_alert', 'operator_alert_wa')`);
const noFullNumber = (logs: string[]) => {
  const all = logs.join('\n');
  for (const n of [PHONE, OTHER, META_DEMO.META_DEMO_PHONE_ID]) assert.ok(!all.includes(n), `the log names ${n} in full:\n${all}`);
};

test('the template is defined in code as it is to be submitted to Meta, and docs/whatsapp-templates.md is written from it', () => {
  assert.deepEqual(remind.PAYMENT_REMINDER, {
    name: 'payment_reminder',
    category: 'UTILITY',
    language: 'he',
    body: 'המנוי ל{{1}} בחשבון של {{2}} ב-OpenFrequency שולם עד {{3}}. התשלום על החודש הבא צריך להגיע אלינו עד סוף {{4}}. אם הוא לא יגיע עד אז, השירות ייעצר עד שנקבל אותו.\n\nכדי לשלם, לוחצים על הכפתור ונשלח לכם כאן את הסכום ואת פרטי ההעברה. כבר שילמתם? אפשר להתעלם מההודעה הזו.',
    button: 'לתשלום',
    example: ['תדר', 'מאפיית השכונה', '21.11.2026', 'יום שלישי, 24.11.2026'],
  });
  const t = remind.PAYMENT_REMINDER;
  // Meta's rules for a body: its variables in order, each once, never first or last, at most 1,024 characters filled.
  assert.deepEqual([...t.body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => m[1]), ['1', '2', '3', '4']);
  assert.ok(!/^\{\{/.test(t.body) && !/\}\}[.\s]*$/.test(t.body), 'the body neither starts nor ends with a variable');
  assert.ok([...remind.reminderFilled(t.example)].length < 1024);
  assert.ok([...t.button].length <= 25, "a quick reply's text is 25 characters at most");
  // The voice (hebrew-voice): no dash of any length as a break, no exclamation mark.
  for (const s of [t.body, t.button, ...t.example]) assert.doesNotMatch(s, /[—–!]/);
  // Its examples are what the code writes for the contract's dates.
  assert.deepEqual(remind.reminderParams({ products: ['teder'], business: 'מאפיית השכונה', paidUntil: '2026-11-21', graceUntil: '2026-11-24' }), t.example);
  const doc = readFileSync(path.join(ROOT, 'docs', 'whatsapp-templates.md'), 'utf8');
  assert.ok(doc.includes(remind.reminderTemplateDoc()), 'docs/whatsapp-templates.md has the payment_reminder section as the code writes it (node scripts/templates-doc.ts)');
  assert.ok(doc.includes(['```', t.body, '```'].join('\n')), 'the body to paste, exactly');
  assert.ok(doc.includes('| Buttons | one quick reply: לתשלום |'));
  assert.ok(doc.includes('| Variables (sample) | {{1}} = תדר; {{2}} = מאפיית השכונה; {{3}} = 21.11.2026; {{4}} = יום שלישי, 24.11.2026 |'));
});

test("the values are accounts' facts, written as accounts writes them: both products, a month's end, and the older terms' 14 days", () => {
  const p = (over: Record<string, unknown>) => remind.reminderParams({ products: ['teder'], business: 'Noa Shop', paidUntil: '2026-11-21', graceUntil: '2026-11-24', ...over } as any);
  assert.deepEqual(p({}), ['תדר', 'Noa Shop', '21.11.2026', 'יום שלישי, 24.11.2026']);
  assert.deepEqual(p({ products: ['teder', 'toran'] }), ['תדר ותורן', 'Noa Shop', '21.11.2026', 'יום שלישי, 24.11.2026']);
  assert.deepEqual(p({ products: ['toran'], paidUntil: '2026-11-30', graceUntil: '2026-12-03' }), ['תורן', 'Noa Shop', '30.11.2026', 'יום חמישי, 3.12.2026']);
  // A workspace still on the older terms: accounts says the grace ends on 6.12, and that is the day written; Toran counts
  // no day of its own.
  assert.deepEqual(p({ graceUntil: '2026-12-06' }).slice(2), ['21.11.2026', 'יום ראשון, 6.12.2026']);
  // The week the clocks go forward: accounts' 4th day.
  assert.equal(p({ paidUntil: '2027-03-24', graceUntil: '2027-03-28' })[3], 'יום ראשון, 28.3.2027');
  // The business on one line, never empty, as Meta takes a value.
  assert.equal(p({ business: 'Noa\n\tShop      Tel Aviv' })[1], 'Noa Shop Tel Aviv');
  assert.equal(remind.reminderFilled(p({})), 'המנוי לתדר בחשבון של Noa Shop ב-OpenFrequency שולם עד 21.11.2026. התשלום על החודש הבא צריך להגיע אלינו עד סוף יום שלישי, 24.11.2026. אם הוא לא יגיע עד אז, השירות ייעצר עד שנקבל אותו.\n\nכדי לשלם, לוחצים על הכפתור ונשלח לכם כאן את הסכום ואת פרטי ההעברה. כבר שילמתם? אפשר להתעלם מההודעה הזו.');
});

test("the contract's example: one template message from our number, its values and the code as the button's payload; the same again is not sent", async () => {
  const { app, meta, logs } = await remindApp();
  try {
    const r = remind.readReminder(JSON.stringify(EXAMPLE));
    assert.ok(r, 'the example is a reminder');
    assert.deepEqual(await remind.sendReminder(app, r), { sent: true, why: null });
    assert.equal(meta.calls.length, 1, 'one message');
    assert.equal(meta.calls[0].path, `${META_DEMO.META_DEMO_PHONE_ID}/messages`, 'from our number on the Cloud API');
    assert.deepEqual(meta.calls[0].body, templateTo(PHONE, ['תדר', 'Noa Shop', '21.11.2026', 'יום שלישי, 24.11.2026'], 'PAY-AB2CD3'));
    assert.deepEqual(await tries(app), [{ key: '7:due:2026-11-21', workspace: 7, kind: 'due', phone: PHONE, state: 'sent', id: 'wamid.remind-1' }]);
    assert.ok(logs.includes('[remind] WhatsApp to …0123 (workspace 7, due): sent'), logs.join('\n'));
    const spent = await app.db.one<any>("SELECT COUNT(*)::int AS n FROM usage WHERE tag = 'wa_pay_reminder'");
    assert.equal(spent.n, 1, 'a usage row, as every message of ours');

    // A retry (accounts' run again, or its answer lost): the same workspace, kind, paid period and phone is not sent.
    assert.deepEqual(await remind.sendReminder(app, r), { sent: false, why: 'already' });
    assert.equal(meta.calls.length, 1, 'still one message');
    assert.ok(logs.includes('[remind] WhatsApp to …0123 (workspace 7, due): not sent (it went before); nothing to do'));
    // Two at the same moment: one goes.
    const both = await Promise.all([remind.sendReminder(app, { ...r, kind: 'last' }), remind.sendReminder(app, { ...r, kind: 'last' })]);
    assert.deepEqual(both.map((o) => o.sent).sort(), [false, true]);
    assert.equal(meta.calls.length, 2);
    // Another phone of the same workspace has its own.
    assert.deepEqual(await remind.sendReminder(app, { ...r, phone: OTHER }), { sent: true, why: null });
    noFullNumber(logs);
  } finally {
    await app.db.close();
  }
});

test('a phone gets at most 3 in 7 days; Meta refusing is a loud line, no throw, nothing for an hour, the operator told; Meta down too', async () => {
  const { app, meta, logs } = await remindApp();
  const base = remind.readReminder(JSON.stringify(EXAMPLE))!;
  try {
    for (const kind of ['soon1', 'due', 'last'] as const) assert.equal((await remind.sendReminder(app, { ...base, kind })).sent, true, kind);
    // A fourth in the week (a second product falling due two days later): held, the log says why.
    assert.deepEqual(await remind.sendReminder(app, { ...base, kind: 'soon1', paidUntil: '2026-11-23', graceUntil: '2026-11-26', products: ['toran'] }), { sent: false, why: 'held' });
    assert.equal(meta.calls.length, 3);
    assert.ok(logs.some((l) => l === "[remind] WhatsApp to …0123 (workspace 7, soon1): not sent (3 payment reminders went to this number in the last 7 days); accounts' email is not affected"), logs.join('\n'));
    // Another number is not held by it; a week on, this one may have the next month's.
    assert.equal((await remind.sendReminder(app, { ...base, phone: OTHER })).sent, true);
    await older(app, 7 * 24 * 60 + 1);
    assert.equal((await remind.sendReminder(app, { ...base, kind: 'soon1', paidUntil: '2026-12-21', graceUntil: '2026-12-24' })).sent, true);
    assert.equal(meta.calls.length, 5);

    // Meta refuses (payment_reminder not approved yet): a loud line naming the template, failed, and no throw.
    meta.state.refuse = true;
    logs.length = 0;
    assert.deepEqual(await remind.sendReminder(app, { ...base, kind: 'due', paidUntil: '2026-12-21', graceUntil: '2026-12-24' }), { sent: false, why: 'failed' });
    const loud = logs.find((l) => l.startsWith('[remind] !!! WhatsApp to …0123 (workspace 7, due) FAILED: '));
    assert.ok(loud && /132001/.test(loud) && /payment_reminder is not approved in WhatsApp Manager/.test(loud) && /60 minutes/.test(loud), logs.join('\n'));
    const alert = await app.db.one<any>("SELECT data FROM events WHERE kind = 'operator_alert'");
    assert.equal(alert?.data.key, 'pay_remind_failed', 'the operator hears of it');
    // For the hour after, nothing is tried, for any number: each is a loud line, held.
    meta.state.refuse = false;
    assert.deepEqual(await remind.sendReminder(app, { ...base, phone: '972500000432' }), { sent: false, why: 'held' });
    assert.equal(meta.calls.length, 6, 'no try at Meta within the hour');
    assert.ok(logs.some((l) => /^\[remind\] !!! WhatsApp to …0432 \(workspace 7, due\) NOT SENT: Meta refused one at \d\d:\d\d UTC/.test(l)), logs.join('\n'));
    // The refused one was not sent, so it is not 'already': after the hour it goes.
    await older(app, 61);
    assert.equal((await remind.sendReminder(app, { ...base, kind: 'due', paidUntil: '2026-12-21', graceUntil: '2026-12-24' })).sent, true);

    // Meta not answering at all, or none of our numbers on Meta: failed, a loud line, never a throw.
    await older(app, 61);
    meta.state.down = true;
    assert.deepEqual(await remind.sendReminder(app, { ...base, phone: '972500000433' }), { sent: false, why: 'failed' });
    assert.ok(logs.some((l) => /^\[remind\] !!! WhatsApp to …0433 \(workspace 7, due\) FAILED: .*fetch failed/.test(l)), logs.join('\n'));
    meta.state.down = false;
    await older(app, 61);
    delete app.env.META_DEMO_PHONE_ID;
    assert.deepEqual(await remind.sendReminder(app, { ...base, phone: '972500000434' }), { sent: false, why: 'failed' });
    assert.ok(logs.some((l) => /^\[remind\] !!! WhatsApp to …0434 \(workspace 7, due\) FAILED: .*none of our numbers is on Meta/.test(l)), logs.join('\n'));
    noFullNumber(logs);
    assert.ok(!logs.join('\n').includes('PAY-AB2CD3'), 'the code is in no log line');
  } finally {
    await app.db.close();
  }
});

test("a reminder Meta took and then could not deliver: a loud line, kept as undelivered, holding nobody else", async () => {
  const { app, meta, logs } = await remindApp();
  try {
    assert.equal((await remind.sendReminder(app, remind.readReminder(JSON.stringify(EXAMPLE))!)).sent, true);
    await deliveryStatus(app, { account: META_DEMO.META_DEMO_PHONE_ID, id: 'wamid.remind-1', status: 'failed', to: PHONE, error: '131026: Message undeliverable.' });
    assert.ok(logs.some((l) => l === "[remind] !!! WhatsApp to …0123 (workspace 7, due) FAILED: Meta took the payment reminder and then could not deliver it (131026: Message undeliverable.); accounts' email is not affected"), logs.join('\n'));
    assert.equal((await tries(app))[0].state, 'undelivered');
    assert.equal((await remind.sendReminder(app, { ...remind.readReminder(JSON.stringify(EXAMPLE))!, phone: OTHER })).sent, true, 'another number still goes');
    assert.equal(meta.calls.length, 2);
  } finally {
    await app.db.close();
  }
});

test('with its own owner line on Meta, the reminder goes from the owner line, where accounts\' "לתשלום בוואטסאפ" leads', async () => {
  const { app, meta } = await remindApp({ META_OWNER_PHONE_ID: '666777888999000', TORAN_ASSISTANT_WA: '972500000901', DEMO_WA_NUMBER: '972500000900' });
  try {
    assert.equal((await remind.sendReminder(app, remind.readReminder(JSON.stringify(EXAMPLE))!)).sent, true);
    assert.equal(meta.calls[0].path, '666777888999000/messages');
  } finally {
    await app.db.close();
  }
});

// ---- the button, pressed

test('the button comes back with the code unseen, and the pay flow answers it with the amount and the details, as for accounts\' own button', async () => {
  // Meta's webhook for a quick reply pressed on a template: type "button", its text and the payload it was sent with.
  const hook = (button: Record<string, string>) => ({
    object: 'whatsapp_business_account',
    entry: [{ id: '100000000000001', changes: [{ field: 'messages', value: { metadata: { phone_number_id: META_DEMO.META_DEMO_PHONE_ID, display_phone_number: '972500000900' }, contacts: [{ wa_id: PHONE, profile: { name: 'נועה' } }], messages: [{ from: PHONE, id: 'wamid.pressed-1', timestamp: '1795000000', type: 'button', button, context: { from: '972500000900', id: 'wamid.remind-1' } }] } }] }],
  });
  const [m] = parseWebhook(hook({ text: 'לתשלום', payload: 'PAY-AB2CD3' })).messages;
  assert.equal(m.text, 'לתשלום PAY-AB2CD3', 'the payment code rides after the button\'s text');
  assert.equal(parseWebhook(hook({ text: 'הצג', payload: 'הצג' })).messages[0].text, 'הצג', 'any other payload is left out, as before');
  assert.equal(parseWebhook(hook({ text: 'לתשלום', payload: 'PAY-AB2CD3; DROP' })).messages[0].text, 'לתשלום', 'only a payment code, whole');

  // Accounts' GET /internal/pay for that code (its docs/contracts/pay.json), and Meta for our number.
  const asked: string[] = [];
  const accounts = http.createServer((req, res) => {
    asked.push(`${req.method} ${req.url}`);
    res.writeHead(req.headers.authorization === `Bearer ${INTERNAL_TOKEN}` ? 200 : 401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 'PAY-AB2CD3', expiresAt: '2027-01-08T10:00:00.000Z', workspace: { id: 7, name: 'Noa Shop' }, items: [{ product: 'teder', productName: 'תדר', plan: 'full', monthly: 790, setup: 0, net: 790, total: 932.2, firstMonth: false }], net: 790, vat: 142.2, total: 932.2, vatIncluded: false, summary: ['תדר, החבילה המלאה: 790 ₪ לחודש, לא כולל מע״מ.'], payHow: 'העברה בנקאית לחשבון 12-345-678901', paidThrough: null }));
  });
  await new Promise<void>((r) => accounts.listen(0, '127.0.0.1', r));
  const { app, meta } = await remindApp({ OF_INTERNAL_TOKEN: INTERNAL_TOKEN, OF_ACCOUNTS_INTERNAL: `http://127.0.0.1:${(accounts.address() as AddressInfo).port}`, DEMO_WA_NUMBER: '972500000900' });
  try {
    const r = await handleInbound(app, { ...m, at: Date.now() });
    assert.equal(r.action, 'pay');
    assert.deepEqual(asked, ['GET /internal/pay?code=PAY-AB2CD3']);
    assert.match(r.reply!, /^כאן תורן, הבוט של OpenFrequency\.\n\nלתשלום על המנוי של Noa Shop: 932\.20 ₪, כולל מע״מ\.\nתדר, החבילה המלאה: 790 ₪ לחודש, לא כולל מע״מ\.\n\nפרטי ההעברה:\nהעברה בנקאית לחשבון 12-345-678901\n\nאחרי ההעברה שולחים לי כאן צילום מסך של האישור\./);
    assert.ok(!r.reply!.includes('PAY-'), 'the answer shows no code');
    assert.equal(meta.calls.length, 1, 'one answer, inside the 24 hours the press opened');
    assert.equal(meta.calls[0].body.to, PHONE);
    const wait = await app.db.one<any>('SELECT code, workspace_id FROM pay_waits WHERE phone = $1', [PHONE]);
    assert.deepEqual({ ...wait }, { code: 'PAY-AB2CD3', workspace_id: 7 }, 'the transfer\'s picture is waited for, as after accounts\' button');
  } finally {
    await app.db.close();
    await new Promise<void>((r) => accounts.close(() => r()));
  }
});

// ---- "הפסק"

test('"הפסק" after a reminder stops them for that number, whoever it is, on our number and on the owner line; "התחל" starts them again; a "הפסק" from anyone else goes on as before', async () => {
  // Accounts' consent route: the paid-from number is linked to nobody there (404 not_linked); every call kept.
  const consent: any[] = [];
  const accounts = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    if (req.url === '/internal/owner-phone/consent') consent.push(JSON.parse(raw));
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_linked' }));
  });
  await new Promise<void>((r) => accounts.listen(0, '127.0.0.1', r));
  const OWNER_LINE = '666777888999000';
  const { app, meta, logs } = await remindApp({ OF_INTERNAL_TOKEN: INTERNAL_TOKEN, OF_ACCOUNTS_INTERNAL: `http://127.0.0.1:${(accounts.address() as AddressInfo).port}`, DEMO_WA_NUMBER: '972500000900', META_OWNER_PHONE_ID: OWNER_LINE, TORAN_ASSISTANT_WA: '972500000901' });
  let n = 0;
  const write = (from: string, text: string, line: 'demo' | 'owner' = 'demo') =>
    handleInbound(app, { channel: 'whatsapp', from, text, id: `wamid.in-${n++}`, at: Date.now(), account: line === 'demo' ? META_DEMO.META_DEMO_PHONE_ID : OWNER_LINE, to: line === 'demo' ? '972500000900' : '972500000901' });
  const base = remind.readReminder(JSON.stringify(EXAMPLE))!;
  try {
    assert.equal((await remind.sendReminder(app, { ...base, kind: 'soon1' })).sent, true);
    const r = await write(PHONE, 'הפסק');
    assert.deepEqual([r.action, r.reply], ['pay_remind_stop', remind.STOP_SAID.stopped]);
    assert.equal(meta.calls.at(-1)!.body.text.body, remind.STOP_SAID.stopped, 'one line back, in the chat');
    assert.ok(await app.db.one('SELECT 1 FROM pay_remind_stops WHERE phone = $1', [PHONE]), 'kept here');
    assert.deepEqual(consent, [{ phone: PHONE, optIn: false, source: 'whatsapp' }], 'accounts told');
    // From now: stopped, whatever accounts sends, and nothing at Meta.
    const calls = meta.calls.length;
    assert.deepEqual(await remind.sendReminder(app, base), { sent: false, why: 'stopped' });
    assert.deepEqual(await remind.sendReminder(app, { ...base, kind: 'last', workspace: 8 }), { sent: false, why: 'stopped' }, 'for any workspace');
    assert.equal(meta.calls.length, calls);
    assert.ok(logs.some((l) => /^\[remind\] WhatsApp to …0123 \(workspace 7, due\): not sent \(the number wrote "הפסק" on \d{4}-\d\d-\d\d\); accounts' email is not affected$/.test(l)), logs.join('\n'));
    // "התחל" on the owner line: they start again, said back, and accounts told.
    const back = await write(PHONE, 'התחל', 'owner');
    assert.deepEqual([back.action, back.reply], ['pay_remind_start', remind.STOP_SAID.started]);
    assert.equal(meta.calls.at(-1)!.path, `${OWNER_LINE}/messages`, 'answered from the line it came to');
    assert.equal(await app.db.one('SELECT 1 FROM pay_remind_stops WHERE phone = $1', [PHONE]), null);
    assert.deepEqual(consent.at(-1), { phone: PHONE, optIn: true, source: 'whatsapp' });
    assert.equal((await remind.sendReminder(app, base)).sent, true);
    // "הפסק" on the owner line works the same, and "תפסיקו" and "STOP" are the same word.
    assert.equal((await write(PHONE, 'STOP', 'owner')).action, 'pay_remind_stop');
    assert.equal((await write(PHONE, ' תפסיקו. ')).action, 'pay_remind_stop', 'said again: still stopped');
    assert.equal((await remind.sendReminder(app, { ...base, kind: 'last' })).why, 'stopped');
    // Someone who never got a reminder: their "הפסק" and "התחל" are not ours, and go on where they went before.
    for (const word of ['הפסק', 'התחל']) assert.notEqual((await write(OTHER, word)).action, word === 'הפסק' ? 'pay_remind_stop' : 'pay_remind_start');
    assert.equal(await app.db.one('SELECT 1 FROM pay_remind_stops WHERE phone = $1', [OTHER]), null);
    // A sentence with the word in it is not the word.
    assert.notEqual((await write(PHONE, 'אל תפסיק לשלוח')).action, 'pay_remind_start');
    noFullNumber(logs);
    const kept = JSON.stringify(await app.db.query("SELECT data FROM events WHERE kind IN ('pay_reminder_stop', 'pay_reminder_start')"));
    assert.ok(!kept.includes(PHONE), 'the events keep the last four digits');
  } finally {
    await app.db.close();
    await new Promise<void>((r) => accounts.close(() => r()));
  }
});

// ---- POST /internal/pay/remind

type S = Awaited<ReturnType<typeof serve>>;
const post = (s: S, body: unknown, { token = INTERNAL_TOKEN as string | null, method = 'POST', headers = {} as Record<string, string>, raw = undefined as string | undefined } = {}) =>
  fetch(`${s.base}/internal/pay/remind`, {
    method,
    redirect: 'manual',
    headers: { ...(token == null ? {} : { authorization: `Bearer ${token}` }), 'content-type': 'application/json', ...headers },
    ...(method === 'GET' ? {} : { body: raw ?? JSON.stringify(body) }),
  }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

test('the route takes the contract\'s example and answers as the contract says; it refuses everything else, and none of those sends', async () => {
  const s = await serve();
  const meta = fakeMeta();
  s.app.graph = meta.f;
  s.app.log = () => {};
  Object.assign(s.app.env, META_DEMO);
  try {
    assert.deepEqual(await post(s, EXAMPLE), { status: 200, json: { ok: true, sent: true, why: null } });
    assert.deepEqual(await post(s, EXAMPLE), { status: 200, json: { ok: true, sent: false, why: 'already' } });
    assert.equal(meta.calls.length, 1);
    const bad = (over: Record<string, unknown>) => ({ ...EXAMPLE, ...over });
    const cases: [string, Promise<{ status: number; json: any }>, number, string][] = [
      ['no token', post(s, EXAMPLE, { token: null }), 401, 'bad_token'],
      ['a wrong token', post(s, EXAMPLE, { token: WRONG }), 401, 'bad_token'],
      ['through Caddy', post(s, EXAMPLE, { headers: { 'x-forwarded-for': '203.0.113.9' } }), 403, 'forbidden'],
      ['GET', post(s, null, { method: 'GET' }), 405, 'method_not_allowed'],
      ['GET without the token', post(s, null, { method: 'GET', token: null }), 401, 'bad_token'],
      ['nothing', post(s, {}), 400, 'bad_reminder'],
      ['not JSON', post(s, null, { raw: 'phone=972500000123' }), 400, 'bad_reminder'],
      ['a list', post(s, [EXAMPLE]), 400, 'bad_reminder'],
      ['too large', post(s, null, { raw: JSON.stringify({ ...EXAMPLE, pad: 'p'.repeat(5000) }) }), 400, 'bad_reminder'],
      ['the workspace a string', post(s, bad({ workspace: '7' })), 400, 'bad_reminder'],
      ['the workspace zero', post(s, bad({ workspace: 0 })), 400, 'bad_reminder'],
      ['a local phone', post(s, bad({ phone: '0500000123' })), 400, 'bad_reminder'],
      ['a phone with a plus', post(s, bad({ phone: '+972500000123' })), 400, 'bad_reminder'],
      ['soon7, never on WhatsApp', post(s, bad({ kind: 'soon7' })), 400, 'bad_reminder'],
      ['stopped, never on WhatsApp', post(s, bad({ kind: 'stopped' })), 400, 'bad_reminder'],
      ['no business', post(s, bad({ business: '  ' })), 400, 'bad_reminder'],
      ['no product', post(s, bad({ products: [] })), 400, 'bad_reminder'],
      ['an unknown product', post(s, bad({ products: ['other'] })), 400, 'bad_reminder'],
      ['a product twice', post(s, bad({ products: ['teder', 'teder'] })), 400, 'bad_reminder'],
      ['a date that is no day', post(s, bad({ paidUntil: '2026-11-31' })), 400, 'bad_reminder'],
      ['a date in another form', post(s, bad({ graceUntil: '24.11.2026' })), 400, 'bad_reminder'],
      ['the grace before the paid day', post(s, bad({ graceUntil: '2026-11-21' })), 400, 'bad_reminder'],
      ['no code', post(s, bad({ code: undefined })), 400, 'bad_reminder'],
      ['a code of another kind', post(s, bad({ code: 'LINK-AB2CD3' })), 400, 'bad_reminder'],
      ['a code with a letter accounts never uses', post(s, bad({ code: 'PAY-AB2CD0' })), 400, 'bad_reminder'],
    ];
    for (const [label, call, status, error] of cases) assert.deepEqual(await call, { status, json: { error } }, label);
    const was = s.app.env.OF_INTERNAL_TOKEN;
    delete s.app.env.OF_INTERNAL_TOKEN;
    assert.deepEqual(await post(s, EXAMPLE), { status: 503, json: { error: 'not_configured' } }, 'OF_INTERNAL_TOKEN unset here');
    s.app.env.OF_INTERNAL_TOKEN = was;
    // A socket that is not this machine's.
    const route = publicRoutes(s.app, accountsClient({ env: s.app.env })).find(([m, re]) => m === 'POST' && re.test('/internal/pay/remind'));
    assert.ok(route, 'POST /internal/pay/remind is a route');
    for (const remoteAddress of ['203.0.113.9', '::ffff:10.0.0.4']) {
      const out: Out = await route[2]({ req: { headers: { authorization: `Bearer ${INTERNAL_TOKEN}` }, socket: { remoteAddress } }, raw: JSON.stringify(bad({ phone: OTHER })) } as any, [] as any);
      assert.deepEqual([out.status, out.json], [403, { error: 'forbidden' }], remoteAddress);
    }
    assert.equal(meta.calls.length, 1, 'nothing sent by any of them');

    // A workspace deleted in accounts takes its reminders, with their numbers, along.
    const del = await fetch(`${s.base}/internal/workspaces/7/delete`, { method: 'POST', headers: { authorization: `Bearer ${INTERNAL_TOKEN}`, 'content-type': 'application/json' }, body: '{}' }).then((r) => r.json());
    assert.equal(del.deleted.payReminders, 1);
    assert.equal((await tries(s.app)).length, 0);
  } finally {
    await s.close();
  }
});
