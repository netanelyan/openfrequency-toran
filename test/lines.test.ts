import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seal } from '../src/core/secrets.ts';
import { signBody } from '../src/channels/meta.ts';
import { handleInbound } from '../src/channels/route.ts';
import { ownerReply } from '../src/channels/owner.ts';
import { lineOf, phoneFor } from '../src/channels/lines.ts';
import { drain } from '../src/jobs/worker.ts';
import { J } from '../src/db/index.ts';
import { handleTederEvent, handleTederReady } from '../src/owners/events.ts';
import { DISCLOSURE } from '../src/owners/notify.ts';
import { syncCompany } from '../src/company.ts';
import type { Block, TurnReq } from '../src/agent/llm/types.ts';
import type { Script } from '../src/agent/llm/scripted.ts';
import { fakeOwnerAccounts, fakeTeder } from './owner-fakes.ts';
import { testApp } from './helpers.ts';
import { serve } from './serve.ts';

// Our own demo number and owner line on Meta's Cloud API (channels/lines.ts), instead of Twilio: Meta's messages for
// them reach demoNumber() and ownerLine() as Twilio's do, never a store's own account, and every answer, image and
// template goes out through the Cloud API from the number it belongs to. Meta's Graph API is a stand-in.

const APP_SECRET = 'test-app-secret-not-a-real-one';
const DEMO_ID = '111222333444555';
const OWNER_ID = '555444333222111';
const DEMO_NUMBER = '972500000999'; // serve.ts's DEMO_WA_NUMBER
const LINE = '972500000888';
const OURS = 'test-token-of-our-own-business';
const CUSTOMER = '972500000321';
const OWNER = '972500000123';
const OTHER = '972500000124';
const WS = 7;
let seq = 0;

type Call = { path: string; auth: string | null; body: any };

/** Meta's send for our two numbers, with our token only. */
function fakeGraph() {
  const calls: Call[] = [];
  const f = (async (input: any, init: any = {}) => {
    const u = new URL(String(input));
    const path = u.pathname.replace(/^\/v\d+\.\d+\//, '');
    const auth = (init.headers as any)?.authorization || null;
    calls.push({ path, auth, body: init.body ? JSON.parse(String(init.body)) : null });
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
    if (auth !== `Bearer ${OURS}`) return json({ error: { message: 'bad token', code: 190 } }, 401);
    if ((path === `${DEMO_ID}/messages` || path === `${OWNER_ID}/messages`) && init.method === 'POST') return json({ messaging_product: 'whatsapp', messages: [{ id: `wamid.out-${seq++}` }] });
    return json({ error: { message: `no route ${path}`, code: 1 } }, 404);
  }) as typeof fetch;
  return { f, calls, from: (id: string) => calls.filter((c) => c.path === `${id}/messages`) };
}

const META = { META_APP_ID: '1234567890', META_APP_SECRET: APP_SECRET, META_WA_CONFIG_ID: '555', META_WEBHOOK_VERIFY_TOKEN: 'verify-me', TORAN_SECRETS_KEY: 'k'.repeat(40) };

test('which of our numbers a Meta id is, and which number a message goes out from', () => {
  const env = { META_DEMO_PHONE_ID: DEMO_ID, META_OWNER_PHONE_ID: OWNER_ID, DEMO_WA_NUMBER: DEMO_NUMBER, TORAN_ASSISTANT_WA: LINE };
  assert.equal(lineOf(env, DEMO_ID), 'demo');
  assert.equal(lineOf(env, OWNER_ID), 'owner');
  assert.equal(lineOf(env, '100200300400500'), null, 'a store\'s number is not ours');
  assert.equal(lineOf({ ...env, META_OWNER_PHONE_ID: DEMO_ID }, DEMO_ID), 'demo', 'one number set as both is the demo number, as on Twilio');
  assert.equal(lineOf({}, DEMO_ID), null, 'nothing set: both stay on Twilio');
  assert.equal(phoneFor(env, { account: OWNER_ID }), OWNER_ID, 'a reply goes out from the number it answers');
  assert.equal(phoneFor(env, { number: LINE }), OWNER_ID, 'a message Toran starts, from the number it names');
  assert.equal(phoneFor(env, { account: LINE }), OWNER_ID, 'a reply from the inbox, by the line\'s number');
  assert.equal(phoneFor(env, {}), DEMO_ID, 'anything else, from the demo number');
});

test('the demo number on Meta: a code binds and Toran answers through the Cloud API from the demo number, never as the store whose page connected it; Twilio\'s path is unchanged without the setting', async () => {
  const s = await serve();
  const g = fakeGraph();
  try {
    Object.assign(s.app.env, META, { META_DEMO_PHONE_ID: DEMO_ID });
    s.app.graph = g.f;
    const seeded = s.app.wa.outbox!.length; // the seeded demo chat's own
    const a = s.seeded.storeId;
    // Our number connected on a store's WhatsApp page (our company store's, in production): its token is used, but a
    // message to it is still the demo number's.
    const other = (await s.app.db.one<{ id: number }>("SELECT id FROM stores WHERE id <> $1 ORDER BY id LIMIT 1", [a]))!.id;
    await s.app.db.query("INSERT INTO channel_accounts (store_id, channel, kind, external_id, secret, status, meta) VALUES ($1, 'whatsapp', 'meta', $2, $3, 'active', $4::jsonb)", [other, DEMO_ID, seal(s.app.env, OURS), J({ display_phone_number: DEMO_NUMBER })]);
    const hook = (body: unknown) => {
      const raw = JSON.stringify(body);
      return fetch(`${s.base}/meta/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': signBody(APP_SECRET, raw) }, body: raw });
    };
    const change = (field: string, value: Record<string, unknown>) => ({ object: 'whatsapp_business_account', entry: [{ id: '900800700600500', changes: [{ field, value: { messaging_product: 'whatsapp', metadata: { phone_number_id: DEMO_ID, display_phone_number: DEMO_NUMBER }, ...value } }] }] });
    const write = (text: string, from = CUSTOMER) => hook(change('messages', { contacts: [{ wa_id: from, profile: { name: 'דנה' } }], messages: [{ from, id: `wamid.in-${seq++}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }] }));

    assert.equal((await write(`היי, אני רוצה לנסות את תורן של החנות ${s.seeded.code}`)).status, 200);
    await drain(s.app);
    assert.equal((await s.app.db.one<any>('SELECT store_id FROM wa_users WHERE phone = $1', [CUSTOMER]))?.store_id, a, 'the code bound the phone to its store');
    let sent = g.from(DEMO_ID);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].auth, `Bearer ${OURS}`, 'with the token our number was connected with');
    assert.equal(sent[0].body.to, CUSTOMER);
    assert.match(sent[0].body.text.body, /^היי, כאן /);
    assert.equal(s.app.wa.outbox!.length, seeded, 'nothing through Twilio or the simulator');
    assert.ok(!(await s.app.db.one("SELECT 1 FROM conversations c JOIN channel_accounts x ON x.id = c.account_id WHERE x.external_id = $1", [DEMO_ID])), 'not answered as the store that connected the number');

    await write('יש לכם ספלים בכחול?');
    await drain(s.app);
    sent = g.from(DEMO_ID);
    assert.equal(sent.length, 2, 'the demo answers on the same number');

    // A phone with no demo: the demo number's own line, from Meta too.
    await write('שלום', '972500000322');
    await drain(s.app);
    assert.match(g.from(DEMO_ID).at(-1)!.body.text.body, /זה מספר הדמו של תורן/);

    // The operator answers the demo conversation from the inbox: from the demo number, through Meta.
    const conv = (await s.app.db.one<any>("SELECT id FROM conversations WHERE store_id = $1 AND peer = $2 AND channel = 'whatsapp'", [a, CUSTOMER])).id;
    assert.ok((await ownerReply(s.app, conv, 'כאן נורית, יש בכחול', 'operator')).ok);
    assert.equal(g.from(DEMO_ID).at(-1)!.body.text.body, 'כאן נורית, יש בכחול');

    // The operator writing from our phone (coexistence) is not a store's owner answering.
    await hook(change('smb_message_echoes', { message_echoes: [{ from: DEMO_NUMBER, to: CUSTOMER, id: `wamid.echo-${seq++}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'מהטלפון' } }] }));
    await drain(s.app);
    assert.ok(!(await s.app.db.one("SELECT 1 FROM messages WHERE author = 'מהטלפון'")));

    // Without META_DEMO_PHONE_ID the demo number is Twilio's (here the simulator), as before.
    delete s.app.env.META_DEMO_PHONE_ID;
    const r = await handleInbound(s.app, { channel: 'whatsapp', from: '972500000323', text: s.seeded.code, id: `sim-${seq++}`, at: Date.now(), to: DEMO_NUMBER });
    assert.equal(r.action, 'bound');
    assert.equal(s.app.wa.outbox!.filter((m) => m.to === '972500000323').length, 1);
  } finally {
    await s.close();
  }
});

const say = (text: string): Block[] => [{ type: 'text', text }];
const toolUse = (name: string, input: Record<string, unknown>): Block[] => [{ type: 'tool_use', id: `t${seq++}`, name, input }];
const lastResult = (req: TurnReq) => {
  const last = req.messages[req.messages.length - 1];
  return Array.isArray(last.content) ? String((last.content.find((b: any) => b.type === 'tool_result') as any)?.content || '') : '';
};

test('the owner line on Meta: linking, the assistant, Teder\'s news (images inside the 24 hours, the approved template by its name outside them) and our support all go out from the owner line through the Cloud API', async () => {
  const script: Script = (req) => (lastResult(req) ? say('תורן עולה 250 ₪ לחודש, לא כולל מע״מ.') : toolUse('get_plans', {}));
  const app = await testApp({ script });
  const accounts = await fakeOwnerAccounts();
  const teder = await fakeTeder();
  const g = fakeGraph();
  try {
    Object.assign(app.env, accounts.env, teder.env, META, { TORAN_ASSISTANT_WA: LINE, META_OWNER_PHONE_ID: OWNER_ID, META_DEMO_PHONE_ID: DEMO_ID, DEMO_WA_NUMBER: DEMO_NUMBER, META_SYSTEM_TOKEN: OURS, META_TEMPLATES: 'teder_posts_ready' });
    app.graph = g.f;
    // As parseWebhook gives it: Meta names the number by its id, and says the number it was written to.
    const write = (text: string, from = OWNER) => handleInbound(app, { channel: 'whatsapp', from, text, id: `m${seq++}`, at: Date.now(), account: OWNER_ID, to: LINE });
    const toOwner = () => g.from(OWNER_ID).filter((c) => c.body.to === OWNER);

    const r = await write('מה קורה?', OTHER);
    assert.equal(r.action, 'owner_line');
    assert.match(g.from(OWNER_ID).at(-1)!.body.text.body, /המספר הזה לא מחובר לחשבון/);
    assert.equal(g.from(OWNER_ID).at(-1)!.auth, `Bearer ${OURS}`, 'with our own business\'s token');
    accounts.code('LINK-ABCDEF', { workspace: WS, products: ['teder'], optIn: true });
    await write('LINK-ABCDEF', OTHER);
    assert.ok(g.from(OWNER_ID).at(-1)!.body.text.body.startsWith(DISCLOSURE));
    assert.equal(g.from(DEMO_ID).length, 0, 'nothing from the demo number');
    assert.equal(app.wa.outbox!.length, 0, 'nothing through Twilio or the simulator');

    // Teder's news to an owner who never wrote: the approved template, by its name, in Hebrew, from the owner line.
    accounts.link({ phone: OWNER, workspace: WS });
    for (const [id, hook] of [[11, 'איך לשמור על הגב בריצה'], [12, 'מה לאכול לפני מרתון'], [13, '5 טעויות בבחירת נעלי ריצה']] as const) {
      teder.add({ id, workspace: WS, hook });
      const ev = `evt_${seq++}`;
      await app.db.query('INSERT INTO teder_events (id, type, workspace_id, data) VALUES ($1, $2, $3, $4::jsonb)', [ev, 'post.ready', WS, J({ post: { id: String(id), coverLine: hook, image: `https://teder.test/m/${id}/instagram/1?e=1&s=x` }, redoOf: null })]);
      await handleTederEvent(app, ev);
    }
    await handleTederReady(app, WS);
    const t = toOwner();
    assert.equal(t.length, 1);
    assert.deepEqual(t[0].body.template, { name: 'teder_posts_ready', language: { code: 'he' }, components: [{ type: 'body', parameters: [{ type: 'text', text: '3 מצגות' }] }] });

    // The owner answers the template: inside the window the covers go as images, from the owner line.
    await write('הצג');
    const shown = toOwner().slice(1);
    assert.equal(shown.filter((c) => c.body.type === 'image').length, 3);
    assert.ok(shown.find((c) => c.body.type === 'image')!.body.image.link.startsWith('https://teder.test/m/'));

    // A template Meta has not approved (not in META_TEMPLATES) is not sent.
    await app.db.query("UPDATE owner_numbers SET last_inbound_at = now() - interval '25 hours'");
    app.env.META_TEMPLATES = '';
    const n = toOwner().length;
    teder.add({ id: 14, workspace: WS, hook: 'עוד אחת' });
    const ev = `evt_${seq++}`;
    await app.db.query('INSERT INTO teder_events (id, type, workspace_id, data) VALUES ($1, $2, $3, $4::jsonb)', [ev, 'post.ready', WS, J({ post: { id: '14', coverLine: 'עוד אחת', image: 'https://teder.test/m/14/instagram/1?e=1&s=x' }, redoOf: null })]);
    await handleTederEvent(app, ev);
    await handleTederReady(app, WS);
    assert.equal(toOwner().length, n);
    assert.equal((await app.db.one<any>('SELECT status, reason FROM owner_notifications ORDER BY id DESC LIMIT 1')).reason, 'no_template');

    // Our support on the owner line, and the operator's reply from the inbox: from the owner line, through Meta.
    const { storeId } = await syncCompany(app, {
      domain: 'shirut-li.example', url: 'https://shirut-li.example/', name: 'שירות לי', status: 'מה עובד היום:\n- עונה במייל.', tone: '', contact: {},
      plans: [{ key: 'one', product: 'shirut', title: 'שירות', monthly: 250, text: '250 ₪ לחודש, לא כולל מע״מ.', url: 'https://shirut-li.example/#price' }],
      faq: [], pages: [{ kind: 'about', title: 'מי אנחנו', url: 'https://shirut-li.example/', text: 'עסק קטן מחיפה.' }],
    });
    app.env.TORAN_SUPPORT_STORE = 'shirut-li.example';
    const stranger = '972500000125';
    const sup = await write('כמה זה עולה?', stranger);
    assert.equal(sup.storeId, storeId);
    assert.equal(g.from(OWNER_ID).at(-1)!.body.text.body, 'תורן עולה 250 ₪ לחודש, לא כולל מע״מ.');
    const conv = await app.db.one<any>('SELECT c.id, a.kind, a.status FROM conversations c JOIN channel_accounts a ON a.id = c.account_id WHERE c.store_id = $1 AND c.peer = $2', [storeId, stranger]);
    assert.deepEqual([conv.kind, conv.status], ['meta_line', 'line']);
    assert.ok((await ownerReply(app, conv.id, 'אני כאן, מה הכתובת של החנות?', 'operator')).ok);
    const last = g.calls.at(-1)!;
    assert.deepEqual([last.path, last.body.to, last.body.text.body], [`${OWNER_ID}/messages`, stranger, 'אני כאן, מה הכתובת של החנות?']);
    assert.equal(app.wa.outbox!.length, 0);
  } finally {
    await accounts.close();
    await teder.close();
    await app.db.close();
  }
});
