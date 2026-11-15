import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { App } from '../src/app.ts';
import { discover } from '../src/leads/discover.ts';
import { setOffer } from '../src/offer.ts';
import { simEmail } from '../src/channels/email.ts';
import { handleInbound } from '../src/channels/route.ts';
import { setNow } from '../src/core/clock.ts';
import { drain } from '../src/jobs/worker.ts';
import * as outreach from '../src/ops/outreach.ts';
import * as ask from '../src/ops/ask.ts';
import { autopilotRoutes } from '../src/ops/autopilot.ts';
import { mailDeliver, mailPitchText } from '../src/ops/emailPitch.ts';
import { META_DEMO, testApp } from './helpers.ts';

// The lead autopilot (the owner, 2026-11-15: "i want the lead dashboard to be automatic ... sends it itself, sells the
// products himself", "20 leads a day, 10 at morning 10 at afternoon"), and the question it asks first: whether we may
// send the store an offer, as the law allows a business to be asked once. A yes builds the store's demo and sends it
// into the same chat. Meta, the mail provider and the store's site are stand-ins; numbers and names are fictional.

const PHONE = '972500000555';
const WABA = '999888777666555';
const TOKEN = 'autopilot-test-token-0000000000000000000';
/** A Tuesday, 10:00 in Israel: the morning batch, never quiet. */
const MORNING = Date.parse('2026-11-10T08:00:00.000Z');
const DOMAIN = 'in.toran.test';

/** Meta for our number: every check green, every template approved, every send taken and kept. */
function fakeMeta() {
  const sends: any[] = [];
  const f = (async (input: any, init: any = {}) => {
    const u = new URL(String(input));
    const p = u.pathname.replace(/^\/v\d+\.\d+\//, '');
    const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
    if (init.method === 'POST' && p.endsWith('/messages')) {
      sends.push(JSON.parse(String(init.body)));
      return json({ messaging_product: 'whatsapp', messages: [{ id: `wamid.out-${sends.length}` }] });
    }
    if (p.endsWith('/message_templates')) return json({ data: [{ name: u.searchParams.get('name'), status: 'APPROVED', quality_score: { score: 'GREEN' } }] });
    return json({ quality_rating: 'GREEN', id: p });
  }) as typeof fetch;
  return { f, sends, templates: () => sends.filter((s) => s.type === 'template') };
}

/** Our company store, and the fictional store as a qualified lead never written to, on WhatsApp. */
async function apApp(env: Record<string, string> = {}) {
  const app = await testApp();
  const meta = fakeMeta();
  app.graph = meta.f;
  app.mail = simEmail({ domain: DOMAIN });
  const logs: string[] = [];
  app.log = (m: string) => void logs.push(m);
  Object.assign(app.env, META_DEMO, {
    META_WABA_ID: WABA, DEMO_WA_NUMBER: '972500000900', TORAN_OWNER_WHATSAPP: '972500000901', TORAN_SIGNUP_OPEN: '1', PUBLIC_BASE_URL: 'https://toran.example',
    TORAN_SUPPORT_STORE: 'openfrequency.example', TORAN_ALERT_CMD: 'off', TORAN_CHANNELS: 'whatsapp,email', TORAN_AUTOPILOT: '1', TORAN_AUTOPILOT_TOKEN: TOKEN,
  }, env);
  outreach.forgetQuality();
  await setOffer(app.db, { monthly: 199, vat: 'excluded', setup: 0, city: 'אשדוד' });
  await app.db.query("INSERT INTO stores (domain, url, name, platform, status, source, slug) VALUES ('openfrequency.example', 'https://openfrequency.example/', 'OpenFrequency', 'company', 'company', 'manual', 'support')");
  await discover(app.db, (async function* () { yield { url: 'https://kli-cheres.example/', source: 'seed', detail: {} }; })(), { fetcher: app.fetcher, limit: 1 });
  const id = (await app.db.one<{ id: number }>("SELECT id FROM stores WHERE domain = 'kli-cheres.example'"))!.id;
  await app.db.query("UPDATE stores SET qualified = true, score = 80, status = 'new', contact_whatsapp = $2, contact_email = NULL WHERE id = $1", [id, PHONE]);
  setNow(MORNING);
  return { app, meta, id, logs };
}

/** One of the autopilot's routes, called as the server calls it: from the internet, with or without its key. */
async function call(app: App, method: 'GET' | 'POST', path: string, body?: unknown, token: string | null = TOKEN) {
  const url = new URL(`https://toran.example${path}`);
  const route = autopilotRoutes(app).find(([m, re]) => m === method && re.test(url.pathname));
  assert.ok(route, `${method} ${path} is a route`);
  const req: any = { headers: token ? { authorization: `Bearer ${token}` } : {}, socket: { remoteAddress: '203.0.113.9' } };
  const out = await route![2]({ req, url, path: url.pathname, form: {}, ip: '203.0.113.9', secure: true, raw: body == null ? '' : JSON.stringify(body) }, route![1].exec(url.pathname)!);
  return { status: out.status ?? 200, json: out.json as any };
}

test('the question asks only whether we may send an offer, says who writes and how to stop, and names no product', () => {
  const t = outreach.OUTREACH_ASK;
  assert.equal(t.name, 'openfrequency_ask');
  assert.doesNotMatch(t.body, /תורן|תדר|מצגת|עוזר|בנינו|הכנו/, 'nothing about what we would send');
  assert.ok(t.body.includes(outreach.SENDER_LINE) && /נתנאל יאנצבסקי, רחוב חדרה, אשדוד/.test(outreach.SENDER_LINE), 'the name and the address, as the law asks');
  assert.ok(t.body.includes(`"${outreach.NO_BUTTON}"`), 'the way out');
  assert.match(outreach.outreachFilled(t), /אפשר לשלוח לכם הצעה לכלי חרס של נורית\?/);
  assert.deepEqual(outreach.submission(t).components[1].buttons, [{ type: 'QUICK_REPLY', text: 'כן, שלחו' }, { type: 'QUICK_REPLY', text: 'לא, תודה' }]);
  assert.doesNotMatch(t.body, /^\s*\{\{|\}\}\s*$/);
  const mail = mailPitchText('both', 'ask', 'כלי חרס של נורית');
  assert.doesNotMatch(mail, /תורן|תדר|מצגת|עוזר|בנינו|הכנו/);
  assert.match(mail, /אפשר לשלוח לכם הצעה לכלי חרס של נורית\? אם כן, עונים "כן" למייל הזה\./);
  assert.ok(mail.includes(outreach.SENDER_LINE));
});

test("the autopilot's door: its own key only, the day as it reads it, and no writes while it is off", async () => {
  const { app, id } = await apApp({ TORAN_AUTOPILOT: '' });
  try {
    assert.equal((await call(app, 'GET', '/autopilot/state', undefined, null)).status, 401);
    assert.equal((await call(app, 'GET', '/autopilot/state', undefined, 'not-the-key-not-the-key-not-the-key-000')).status, 401);
    const st = await call(app, 'GET', '/autopilot/state');
    assert.equal(st.status, 200);
    assert.equal(st.json.on, false);
    assert.equal(st.json.pool.askable, 1);
    assert.deepEqual(st.json.limits, { day: 20, batch: 10 });
    const c = (await call(app, 'GET', '/autopilot/candidates')).json.candidates;
    assert.deepEqual([c[0].id, c[0].reach, c[0].toranCan, c[0].chosen], [id, 'whatsapp', true, null]);
    assert.ok(c[0].about !== undefined && c[0].facts, 'each in the words the leads page shows it');
    assert.equal((await call(app, 'POST', '/autopilot/decide', { id, product: 'toran' })).status, 409, 'off: no writes');
    delete app.env.TORAN_AUTOPILOT_TOKEN;
    assert.equal((await call(app, 'GET', '/autopilot/state')).status, 503, 'no key set: closed');
  } finally {
    setNow(null);
    await app.db.close();
  }
});

test('the autopilot chooses, asks once on WhatsApp, and keeps to its batch; a store set aside is never asked', async () => {
  const { app, meta, id } = await apApp({ TORAN_AUTOPILOT_BATCH: '1' });
  try {
    assert.equal((await call(app, 'POST', '/autopilot/ask', { id })).json.why, 'no_product', 'a product first');
    assert.deepEqual((await call(app, 'POST', '/autopilot/decide', { id, product: 'toran', reason: 'קרמיקה, וואטסאפ באתר' })).json, { ok: true, message: 'chose toran' });
    const asked = await call(app, 'POST', '/autopilot/ask', { id });
    assert.equal(asked.json.sent, true, JSON.stringify(asked.json));
    const [send] = meta.templates();
    assert.equal(send.template.name, 'openfrequency_ask');
    assert.deepEqual(send.template.components, [
      { type: 'body', parameters: [{ type: 'text', text: 'לכלי חרס של נורית' }] },
      { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: 'OUTREACH_YES' }] },
      { type: 'button', sub_type: 'quick_reply', index: '1', parameters: [{ type: 'payload', payload: 'OUTREACH_STOP' }] },
    ]);
    const e = (await app.db.one<any>("SELECT data FROM events WHERE kind = 'outreach_wa'"))!.data;
    assert.deepEqual([e.stage, e.product, e.by], ['ask', 'toran', 'autopilot'], 'the chosen product kept with the question');
    assert.ok((await app.db.one<any>('SELECT sent_at FROM stores WHERE id = $1', [id])).sent_at, 'off the list');
    assert.equal((await call(app, 'POST', '/autopilot/ask', { id })).json.why, 'not_candidate', 'once');
    // Another store, in the same morning batch of one: held.
    const other = (await app.db.one<{ id: number }>("INSERT INTO stores (domain, url, name, platform, source, slug, status, qualified, score, contact_whatsapp, demo_for) VALUES ('pofi.example', 'https://pofi.example/', 'פופי', 'shopify', 'seed', 'pofi-x1', 'new', true, 70, '972500000556', 'teder') RETURNING id"))!.id;
    assert.equal((await call(app, 'POST', '/autopilot/ask', { id: other })).json.why, 'batch_cap');
    // The afternoon's batch is its own.
    setNow(MORNING + 6 * 3_600_000);
    assert.equal((await call(app, 'POST', '/autopilot/ask', { id: other })).json.sent, true);
    // Set aside: off the candidates, with the reason in its notes.
    const third = (await app.db.one<{ id: number }>("INSERT INTO stores (domain, url, name, platform, source, slug, status, qualified, score, contact_whatsapp) VALUES ('fake-brand.example', 'https://fake-brand.example/', 'Fake', 'shopify', 'seed', 'fake-x1', 'new', true, 90, '972500000557') RETURNING id"))!.id;
    assert.equal((await call(app, 'POST', '/autopilot/decide', { id: third, product: 'none', reason: 'חנות של מותג מזויף' })).json.ok, true);
    assert.match((await app.db.one<any>('SELECT status, notes FROM stores WHERE id = $1', [third])).notes, /מותג מזויף/);
    assert.equal((await call(app, 'GET', '/autopilot/candidates')).json.candidates.length, 0);
    // Its notes, kept for the owner.
    assert.deepEqual((await call(app, 'POST', '/autopilot/note', { text: 'בוקר: נשאלו 1, נדחתה 1.' })).json, { ok: true });
    assert.equal((await call(app, 'GET', '/autopilot/notes')).json.notes[0].text, 'בוקר: נשאלו 1, נדחתה 1.');
  } finally {
    setNow(null);
    await app.db.close();
  }
});

test("a yes to the question: thanks at once, the store's Toran built, then sent into the chat and answering there", async () => {
  const { app, meta, id } = await apApp();
  let n = 0;
  const write = (text: string, payload?: string) => handleInbound(app, { channel: 'whatsapp', from: PHONE, text, id: `wamid.in-${n++}`, at: MORNING, account: META_DEMO.META_DEMO_PHONE_ID, to: '972500000900', ...(payload ? { payload } : {}) });
  try {
    await call(app, 'POST', '/autopilot/decide', { id, product: 'toran' });
    assert.equal((await call(app, 'POST', '/autopilot/ask', { id })).json.sent, true);
    const r = await write(outreach.ASK_YES, outreach.YES_PAYLOAD);
    assert.deepEqual([r.action, r.reply], ['pitch_yes', ask.ASK_THANKS]);
    assert.equal(meta.sends.at(-1).text.body, ask.ASK_THANKS, 'thanks in the chat at once');
    const pending = (await app.db.one<any>("SELECT data FROM events WHERE kind = 'outreach_wa'"))!.data;
    assert.equal(pending.deliver, 'pending');
    assert.ok(await app.db.one("SELECT 1 FROM jobs WHERE kind = 'ingest' AND (payload->>'storeId')::int = $1", [id]), 'its Toran is being built');
    assert.equal(await ask.askDeliverDue(app, { mailDeliver }), 0, 'nothing goes while it is built');
    await drain(app);
    assert.equal(await ask.askDeliverDue(app, { mailDeliver }), 1);
    const texts = meta.sends.filter((s) => s.type === 'text').map((s) => s.text.body);
    assert.ok(texts.some((t) => /^הכנו לכם את תורן, [^]*https:\/\/toran\.example\/s\//.test(t)), 'what it is, with its page');
    assert.ok(texts.some((t) => /^מעכשיו עונה לכם כאן תורן של /.test(t)), 'and Toran itself, answering there');
    assert.ok(await app.db.one('SELECT 1 FROM wa_users WHERE phone = $1 AND store_id = $2', [PHONE, id]), 'their next message is the demo\'s');
    const done = (await app.db.one<any>("SELECT data FROM events WHERE kind = 'outreach_wa'"))!.data;
    assert.equal(done.deliver, 'sent');
    assert.equal(await ask.askDeliverDue(app, { mailDeliver }), 0, 'once');
    assert.ok(await app.db.one("SELECT 1 FROM events WHERE kind = 'operator_alert' AND data->>'title' LIKE '%אמרו כן%'"), 'the operator told');
  } finally {
    setNow(null);
    await app.db.close();
  }
});

test('by email: the question, a "כן" in the thread, and the links once the demo is up; nothing up for hours: sorry, and the operator told', async () => {
  const { app, id } = await apApp();
  try {
    await app.db.query("UPDATE stores SET contact_whatsapp = NULL, contact_email = 'nurit@kli-cheres.example' WHERE id = $1", [id]);
    await call(app, 'POST', '/autopilot/decide', { id, product: 'toran' });
    const asked = await call(app, 'POST', '/autopilot/ask', { id });
    assert.equal(asked.json.sent, true, JSON.stringify(asked.json));
    const first = app.mail!.outbox!.at(-1)! as any;
    assert.equal(first.subject, 'שאלה קצרה לכלי חרס של נורית');
    assert.doesNotMatch(first.text, /תורן|תדר/);
    const yes = app.mail!.parse({ raw: JSON.stringify({ from: 'Nurit <nurit@kli-cheres.example>', to: [`support@${DOMAIN}`], subject: `Re: ${first.subject}`, text: 'כן\n\nבתאריך יום ג׳ מאת OpenFrequency <support@in.toran.test>:\n> שלום', message_id: '<y1@kli-cheres.example>' }), form: {}, headers: {}, url: '' })![0];
    const r = await handleInbound(app, yes);
    assert.equal(r.reply, ask.ASK_THANKS);
    await drain(app);
    assert.equal(await ask.askDeliverDue(app, { mailDeliver }), 1);
    assert.match(app.mail!.outbox!.at(-1)!.text, /^מעולה\. זה תורן של כלי חרס של נורית: https:\/\/toran\.example\/s\//);

    // Another store that said yes and whose demo never came up: after ASK_WAIT_MS, sorry and the operator told.
    const other = (await app.db.one<{ id: number }>("INSERT INTO stores (domain, url, name, platform, source, slug, status, qualified, score, contact_whatsapp, demo_for) VALUES ('pofi.example', 'https://pofi.example/', 'פופי', 'magento', 'seed', 'pofi-x1', 'new', true, 70, '972500000556', 'toran') RETURNING id"))!.id;
    await app.db.query("INSERT INTO events (store_id, kind, data) VALUES (NULL, 'outreach_wa', $1::jsonb)", [JSON.stringify({ product: 'toran', stage: 'ask', phone: '972500000556', ref: `store:${other}`, name: 'פופי', state: 'sent', yes: new Date(MORNING).toISOString(), yes_at: new Date(MORNING).toISOString(), deliver: 'pending' })]);
    assert.equal(await ask.askDeliverDue(app, { mailDeliver }), 0, 'still waiting');
    setNow(MORNING + ask.ASK_WAIT_MS + 60_000);
    await ask.askDeliverDue(app, { mailDeliver });
    const failed = (await app.db.one<any>("SELECT data FROM events WHERE kind = 'outreach_wa' AND data->>'ref' = $1", [`store:${other}`]))!.data;
    assert.equal(failed.deliver, 'failed');
    assert.ok(await app.db.one("SELECT 1 FROM events WHERE kind = 'operator_alert' AND data->>'key' LIKE 'ask_failed:%'"));
  } finally {
    setNow(null);
    await app.db.close();
  }
});
