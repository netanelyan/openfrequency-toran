import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as outreach from '../src/ops/outreach.ts';
import { pitchOf, sendNow, OpsError } from '../src/ops/actions.ts';
import { queue } from '../src/ops/queue.ts';
import { handleInbound } from '../src/wa/router.ts';
import { setNow } from '../src/core/clock.ts';
import { ROOT } from '../src/core/paths.ts';
import { INTERNAL_TOKEN, META_DEMO, testApp } from './helpers.ts';
import { serve } from './serve.ts';

// Pitches to leads on WhatsApp from our number (the owner, 2026-11-08: "if i press the send button to a demo
// suggestion, i want it to go to whatsapp, so toran should send it" ... "build that"), as Meta's approved Marketing
// templates, under ops/outreach.ts's guardrails: the way out on the message, a daily cap, no nights or Shabbat, and
// Meta's quality read before each send. Meta is a stand-in: nothing leaves this machine. Numbers are fictional.

const PHONE = '972500000555';
const OTHER = '972500000556';
const WABA = '999888777666555';
/** A Tuesday, 12:00 in Israel: never quiet. */
const NOON = Date.parse('2026-11-10T10:00:00.000Z');

type Call = { method: string; path: string; query: Record<string, string>; body: any };

/** Meta for our number: the number's rating, the templates' status and score, and the sends. */
function fakeMeta() {
  const calls: Call[] = [];
  const state = { rating: 'GREEN', status: 'APPROVED', score: 'GREEN', sendError: null as null | { code: number; message: string } };
  const f = (async (input: any, init: any = {}) => {
    const u = new URL(String(input));
    const p = u.pathname.replace(/^\/v\d+\.\d+\//, '');
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method: init.method || 'GET', path: p, query: Object.fromEntries(u.searchParams), body });
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
    if ((init.headers as any)?.authorization !== `Bearer ${META_DEMO.META_SYSTEM_TOKEN}`) return json({ error: { message: 'refused', code: 190 } }, 401);
    if (init.method === 'GET' && p === META_DEMO.META_DEMO_PHONE_ID) return json({ quality_rating: state.rating, id: p });
    if (init.method === 'GET' && p === `${WABA}/message_templates`) return json({ data: [{ name: u.searchParams.get('name'), status: state.status, quality_score: { score: state.score } }] });
    if (init.method === 'POST' && p === `${META_DEMO.META_DEMO_PHONE_ID}/messages`) {
      if (body?.type === 'template' && state.sendError) return json({ error: { ...state.sendError, type: 'OAuthException' } }, 400);
      return json({ messaging_product: 'whatsapp', messages: [{ id: `wamid.out-${calls.length}` }] });
    }
    return json({ error: { message: 'unexpected', code: 1 } }, 400);
  }) as typeof fetch;
  const sends = () => calls.filter((c) => c.method === 'POST' && c.body?.type === 'template');
  return { f, calls, state, sends };
}

async function pitchApp(env: Record<string, string> = {}) {
  const app = await testApp();
  const meta = fakeMeta();
  const logs: string[] = [];
  app.graph = meta.f;
  app.log = (m: string) => logs.push(m);
  Object.assign(app.env, META_DEMO, { META_WABA_ID: WABA, DEMO_WA_NUMBER: '972500000900', TORAN_SIGNUP_OPEN: '1' }, env);
  outreach.forgetQuality();
  setNow(NOON);
  return { app, meta, logs };
}

const pitch = (o: Partial<outreach.Pitch> = {}): outreach.Pitch => ({ product: 'toran', stage: 'first', phone: PHONE, name: 'כלי חרס של נורית', url: 'https://toran.openfrequency.co.il/s/nurit-x1', ref: 'toran:1', by: 'Demo', ...o });

test('the six templates keep Meta\'s rules, read as the store reads them, and docs/whatsapp-templates.md is written from them', () => {
  const now = Object.values(outreach.OUTREACH_TEMPLATES);
  assert.deepEqual(now.map((t) => t.name), ['toran_pitch_2', 'toran_pitch_reminder_2', 'teder_pitch_2', 'teder_pitch_reminder_2', 'openfrequency_pitch_2', 'openfrequency_pitch_reminder_2']);
  assert.deepEqual(now.map((t) => t.previous?.name), ['toran_pitch', 'toran_pitch_reminder', 'teder_pitch', 'teder_pitch_reminder', 'openfrequency_pitch', 'openfrequency_pitch_reminder'], 'each replaces the one Meta approved before');
  for (const t of [...now, ...now.map((x) => x.previous!)]) {
    assert.equal(t.category, 'MARKETING');
    assert.doesNotMatch(t.body, /^\s*\{\{|\}\}\s*$/, `${t.name}: no variable at the body's start or end (Meta refuses one)`);
    const vars = 1 + (t.links || 0);
    assert.deepEqual(t.body.match(/\{\{\d+\}\}/g), Array.from({ length: vars }, (_, i) => `{{${i + 1}}}`), `${t.name}: the store, then its pages' addresses`);
    assert.equal(t.example.length, vars, `${t.name}: a sample for every variable`);
    assert.ok(t.body.length <= 1024, `${t.name}: within Meta's 1024 characters`);
    // The pages are written out in the new words, in case the buttons do not show (the owner, 2026-11-12).
    if (t.links) assert.ok(t.example.slice(1).every((u, i) => u.startsWith(i ? t.url2!.base : t.url.base)), `${t.name}: its pages are its buttons' pages`);
    assert.match(t.url.base, /^https:\/\/(toran|teder)\.openfrequency\.co\.il\/s\/$/, `${t.name}: the page's address, its slug appended`);
    assert.ok(t.url.text.length <= 25 && t.stop.length <= 25, `${t.name}: buttons of 25 characters at most`);
    assert.ok(t.body.includes(`"${outreach.STOP_BUTTON}"`), `${t.name}: says how to stop`);
    assert.ok(t.body.includes('OpenFrequency') || t.stage === 'reminder', `${t.name}: the first one says who writes`);
    const s = outreach.submission(t);
    // The URL buttons first, the quick reply after them (two groups); the message with both demos has two URL buttons,
    // Toran's then Teder's (Meta allows two).
    assert.deepEqual(s.components[1].buttons!.map((b: any) => b.type), t.url2 ? ['URL', 'URL', 'QUICK_REPLY'] : ['URL', 'QUICK_REPLY']);
    if (t.url2) assert.deepEqual([t.url.base, t.url2.base, t.url2.text.length <= 25], ['https://toran.openfrequency.co.il/s/', 'https://teder.openfrequency.co.il/s/', true]);
  }
  assert.match(outreach.outreachFilled(outreach.OUTREACH_TEMPLATES.toran_first), /^היי, כאן OpenFrequency\. בנינו לכלי חרס של נורית תורן, שעונה ללקוחות שלכם בוואטסאפ, באינסטגרם, במסנג׳ר, במייל ובצ׳אט באתר, בכל שעה\.[^]*אפשר לכתוב לו עכשיו מהטלפון, כמו לקוח: https:\/\/toran\.openfrequency\.co\.il\/s\/nurit-ceramics\n/);
  assert.match(outreach.outreachFilled(outreach.OUTREACH_TEMPLATES.both_first), /תורן עונה ללקוחות שלכם[^]*https:\/\/toran\.openfrequency\.co\.il\/s\/nurit-ceramics\n\nתדר כותב ומעצב[^]*קהל שמכיר אתכם[^]*https:\/\/teder\.openfrequency\.co\.il\/s\/nurit-ceramics-a1b2c3\n/);
  const doc = readFileSync(path.join(ROOT, 'docs', 'whatsapp-templates.md'), 'utf8');
  assert.ok(doc.includes(outreach.outreachTemplateDoc()), 'docs/whatsapp-templates.md has the pitches as the code writes them (node scripts/templates-doc.ts)');
});

test('while Toran is not on sale (TORAN_SIGNUP_OPEN), no pitch about it goes out: Toran\'s and the combined one are refused, Teder\'s alone goes', async () => {
  const { app, meta } = await pitchApp({ TORAN_SIGNUP_OPEN: '' });
  try {
    const out = await outreach.sendPitch(app, pitch());
    assert.deepEqual(out, { sent: false, why: 'not_on_sale', said: outreach.SAID_HE.not_on_sale });
    assert.equal(meta.sends().length, 0, 'nothing sent');
    assert.equal((await app.db.query("SELECT 1 FROM events WHERE kind = 'outreach_wa'")).length, 0, 'nothing marked');
    const teder = await outreach.sendPitch(app, pitch({ product: 'teder', url: 'https://teder.openfrequency.co.il/s/nurit-a1b2c3' }));
    assert.equal(teder.sent, true, "Teder's pitch is Teder's to send");
  } finally {
    await app.db.close();
  }
});

test("Toran's opening to its waitlist: once a number, as toran_launch with the website's Toran page on its button, and only once Toran is on sale", async () => {
  const { app, meta } = await pitchApp();
  try {
    const launch = { product: 'toran' as const, stage: 'launch' as const, phone: PHONE, name: 'כלי חרס של נורית', url: '', ref: 'waitlist:1', by: 'Demo' };
    const out = await outreach.sendPitch(app, launch);
    assert.equal(out.sent, true);
    const [send] = meta.sends();
    assert.equal(send.body.template.name, 'toran_launch');
    assert.deepEqual(send.body.template.components.find((c: any) => c.sub_type === 'url').parameters, [{ type: 'text', text: 'toran' }], "the website's /toran");
    assert.equal((await outreach.sendPitch(app, launch)).why, 'already', 'once a number');
    assert.equal((await outreach.sendPitch(app, { ...launch, product: 'teder' as const })).why, 'bad_page', "the opening is Toran's alone");
    assert.deepEqual(outreach.readPitch(JSON.stringify({ ...launch, url: undefined })), { ...launch, url: '' });
    assert.equal(outreach.readPitch(JSON.stringify({ ...launch, url: 'https://toran.openfrequency.co.il/s/x' })), null, 'no page on the opening');
    assert.match(outreach.outreachTemplateDoc(), /### toran_launch/);
  } finally {
    await app.db.close();
  }
});

test('the sign-up switch is said once a start: quiet when Toran, accounts and the site agree, loud and alerted when they do not', async () => {
  const { checkSignupSwitch } = await import('../src/ops/signupSwitch.ts');
  const { app } = await pitchApp({ TORAN_SIGNUP_OPEN: '', OF_INTERNAL_TOKEN: '' });
  try {
    const logs: string[] = [];
    app.log = (l: string) => void logs.push(l);
    const r = await checkSignupSwitch(app, { site: async () => ({ open: false }) });
    assert.equal(r.agree, false, "accounts could not be asked: that is not agreement");
    assert.match(r.line, /!!! Toran's sign-up switch disagrees: Toran \(TORAN_SIGNUP_OPEN\) closed, accounts \(OF_SIGNUP_PRODUCTS\) couldn't check \(not_configured\), the website \(site\.config\.json signup\) closed/);
  } finally {
    await app.db.close();
  }
});

test('a pitch goes once as the template: the store with its "ל", the page\'s slug on the URL button, the way out as the second button', async () => {
  const { app, meta } = await pitchApp();
  try {
    const out = await outreach.sendPitch(app, pitch({ name: 'הדס עיצובים' }));
    assert.deepEqual(out, { sent: true, why: null, said: outreach.SAID_HE.sent });
    const [send] = meta.sends();
    assert.equal(send.path, `${META_DEMO.META_DEMO_PHONE_ID}/messages`);
    assert.deepEqual(send.body, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: PHONE,
      type: 'template',
      template: {
        name: 'toran_pitch_2',
        language: { code: 'he' },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: 'בשביל הדס עיצובים' }, { type: 'text', text: 'https://toran.openfrequency.co.il/s/nurit-x1' }] },
          { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: 'nurit-x1' }] },
          { type: 'button', sub_type: 'quick_reply', index: '1', parameters: [{ type: 'payload', payload: 'OUTREACH_STOP' }] },
        ],
      },
    });
    assert.ok(meta.calls.some((c) => c.method === 'GET' && c.path === META_DEMO.META_DEMO_PHONE_ID && c.query.fields === 'quality_rating'), "the number's rating read first");
    assert.ok(meta.calls.some((c) => c.path === `${WABA}/message_templates` && c.query.name === 'toran_pitch_2'), "and the template's");
    // Twice: once.
    assert.equal((await outreach.sendPitch(app, pitch())).why, 'already');
    // The reminder is its own template, once too; the other product's pitch to the same number is its own.
    assert.equal((await outreach.sendPitch(app, pitch({ stage: 'reminder' }))).sent, true);
    assert.equal(meta.sends().at(-1)!.body.template.name, 'toran_pitch_reminder_2');
    assert.equal((await outreach.sendPitch(app, pitch({ product: 'teder', url: 'https://teder.openfrequency.co.il/s/nurit-a1b2c3' }))).sent, true);
    assert.equal(meta.sends().at(-1)!.body.template.name, 'teder_pitch_2');
    // A page without /s/<slug>, a number that is not one: nothing at Meta.
    const n = meta.sends().length;
    assert.equal((await outreach.sendPitch(app, pitch({ phone: OTHER, url: 'https://toran.openfrequency.co.il/' }))).why, 'bad_page');
    assert.equal((await outreach.sendPitch(app, pitch({ phone: '0501234' }))).why, 'bad_phone');
    assert.equal(meta.sends().length, n);
  } finally {
    setNow(null);
    await app.db.close();
  }
});

test('the guardrails: the daily cap for both products together, no night or Shabbat, and Meta\'s quality, each holding everything back', async () => {
  const { app, meta, logs } = await pitchApp({ TORAN_OUTREACH_DAILY: '2' });
  try {
    assert.equal(outreach.dailyCap({}), 10, 'ten a day unless set');
    assert.equal((await outreach.sendPitch(app, pitch({ phone: '972500000601' }))).sent, true);
    assert.equal((await outreach.sendPitch(app, pitch({ phone: '972500000602', product: 'teder', url: 'https://teder.openfrequency.co.il/s/a-b' }))).sent, true);
    assert.equal((await outreach.sendPitch(app, pitch({ phone: '972500000603' }))).why, 'cap', 'the third today: held');
    setNow(NOON + 24 * 3_600_000);
    assert.equal((await outreach.sendPitch(app, pitch({ phone: '972500000603' }))).sent, true, 'the next day it goes');
    // Shabbat, 12:00 in Israel: held, nothing at Meta.
    setNow(Date.parse('2026-11-14T10:00:00.000Z'));
    const n = meta.sends().length;
    assert.equal((await outreach.sendPitch(app, pitch({ phone: '972500000604' }))).why, 'quiet');
    // At night.
    setNow(Date.parse('2026-11-11T21:30:00.000Z'));
    assert.equal((await outreach.sendPitch(app, pitch({ phone: '972500000604' }))).why, 'quiet');
    assert.equal(meta.sends().length, n);
  } finally {
    setNow(null);
    await app.db.close();
  }
  // Meta's rating: yellow on the number, or the template paused, or not approved: nothing goes, and the operator hears once.
  for (const [what, set] of [['the number yellow', (m: any) => (m.state.rating = 'YELLOW')], ['the template paused', (m: any) => (m.state.status = 'PAUSED')], ['the template red', (m: any) => (m.state.score = 'RED')]] as const) {
    const { app: a, meta: m, logs: l } = await pitchApp();
    try {
      set(m);
      assert.deepEqual(await outreach.sendPitch(a, pitch()), { sent: false, why: 'quality', said: outreach.SAID_HE.quality }, what);
      assert.equal(m.sends().length, 0, `${what}: nothing sent`);
      assert.ok(await a.db.one("SELECT 1 FROM events WHERE kind = 'operator_alert' AND data->>'key' = 'outreach_quality'"), `${what}: the operator told`);
      assert.ok(l.some((x) => x.startsWith('[outreach] !!! pitches stopped')), l.join('\n'));
      // Green again: still held for the ten minutes Meta's word is kept, then it goes.
      m.state.rating = 'GREEN';
      m.state.status = 'APPROVED';
      m.state.score = 'GREEN';
      assert.equal((await outreach.sendPitch(a, pitch())).why, 'quality');
      setNow(NOON + outreach.QUALITY_TTL_MS + 1000);
      assert.equal((await outreach.sendPitch(a, pitch())).sent, true);
    } finally {
      setNow(null);
      await a.db.close();
    }
  }
  // Meta pausing the template on the send itself (its code 132015): held from then on.
  const { app: b, meta: mb } = await pitchApp();
  try {
    mb.state.sendError = { code: 132015, message: '(#132015) Template is paused' };
    assert.equal((await outreach.sendPitch(b, pitch())).why, 'quality');
    mb.state.sendError = null;
    assert.equal((await outreach.sendPitch(b, pitch({ phone: OTHER }))).why, 'quality', 'the next one held too');
    // Not approved yet (132001): said as failed, with the way to fix it in the log.
    outreach.forgetQuality();
    mb.state.sendError = { code: 132001, message: '(#132001) Template name does not exist in the translation' };
    assert.equal((await outreach.sendPitch(b, pitch({ phone: OTHER }))).why, 'failed');
  } finally {
    setNow(null);
    await b.db.close();
  }
  void logs;
});

test('"הסירו אותי", or a "לא" to the pitch, removes the number for both products: kept, said once, its leads lost, and no pitch again', async () => {
  const { app, meta } = await pitchApp();
  let n = 0;
  const write = (from: string, text: string) => handleInbound(app, { channel: 'whatsapp', from, text, id: `wamid.in-${n++}`, at: NOON, account: META_DEMO.META_DEMO_PHONE_ID, to: '972500000900' });
  try {
    const id = (await app.db.one<{ id: number }>("INSERT INTO stores (domain, url, name, platform, source, slug, contact_whatsapp, approved_at, page_built_at, sent_at) VALUES ('nurit.example', 'https://nurit.example/', 'nurit', 'shopify', 'seed', 'nurit-x1', $1, now(), now(), now()) RETURNING id", [PHONE]))!.id;
    await app.db.query("INSERT INTO teder_leads (id, domain, status, whatsapp) VALUES ('d-1', 'nurit.example', 'approved', $1)", [PHONE]);
    assert.equal((await outreach.sendPitch(app, pitch())).sent, true);
    // Someone we never pitched: "לא" is theirs, not ours.
    assert.notEqual((await write(OTHER, 'לא')).action, 'outreach_stop');
    const r = await write(PHONE, 'הסירו אותי');
    assert.deepEqual([r.action, r.reply], ['outreach_stop', outreach.STOPPED_SAID]);
    assert.equal(meta.calls.at(-1)!.body.text.body, outreach.STOPPED_SAID, 'one line back, in the chat (inside the 24 hours their message opened)');
    assert.ok(await outreach.stoppedNumber(app, PHONE));
    assert.deepEqual({ ...(await app.db.one('SELECT lost_reason FROM stores WHERE id = $1', [id])) }, { lost_reason: 'opted_out' }, 'the Toran lead lost');
    assert.deepEqual({ ...(await app.db.one("SELECT lost_reason FROM teder_leads WHERE id = 'd-1'")) }, { lost_reason: 'opted_out' }, 'and the Teder one');
    // Said again: nothing more back.
    const before = meta.calls.length;
    assert.equal((await write(PHONE, 'הסירו אותי')).action, 'outreach_stop_again');
    assert.equal(meta.calls.length, before);
    // No pitch of either product again.
    assert.equal((await outreach.sendPitch(app, pitch({ stage: 'reminder' }))).why, 'stopped');
    assert.equal((await outreach.sendPitch(app, pitch({ product: 'teder', url: 'https://teder.openfrequency.co.il/s/a-b' }))).why, 'stopped');
    const kept = JSON.stringify(await app.db.query("SELECT data FROM events WHERE kind = 'outreach_stop'"));
    assert.ok(!kept.includes(PHONE), 'the event keeps the last four digits');
  } finally {
    setNow(null);
    await app.db.close();
  }
});

test('a bare "לא" after they started talking to us is not the way out; "הסר" always is', async () => {
  const { app } = await pitchApp();
  let n = 0;
  const write = (text: string) => handleInbound(app, { channel: 'whatsapp', from: PHONE, text, id: `wamid.in-${n++}`, at: NOON, account: META_DEMO.META_DEMO_PHONE_ID, to: '972500000900' });
  try {
    assert.equal((await outreach.sendPitch(app, pitch())).sent, true);
    const store = (await app.db.one<{ id: number }>("INSERT INTO stores (domain, url, name, platform, source, slug) VALUES ('x.example', 'https://x.example/', 'x', 'shopify', 'seed', 'x-1') RETURNING id"))!.id;
    await app.db.query("INSERT INTO conversations (store_id, channel, peer, started_at) VALUES ($1, 'whatsapp', $2, now() + interval '1 minute')", [store, PHONE]);
    assert.notEqual((await write('לא')).action, 'outreach_stop', 'an answer in the conversation');
    assert.equal((await write('הסר')).action, 'outreach_stop');
  } finally {
    setNow(null);
    await app.db.close();
  }
});

test('the operator\'s "send now" on a lead sends the pitch and marks it as "שלחתי" does; nothing is marked when it is held', async () => {
  const { app, meta } = await pitchApp({ TORAN_OUTREACH_DAILY: '1' });
  try {
    const add = async (domain: string, phone: string | null) =>
      String((await app.db.one<{ id: number }>("INSERT INTO stores (domain, url, name, platform, source, slug, score, qualified, contact_whatsapp, approved_at, page_built_at) VALUES ($1, $2, $3, 'shopify', 'seed', $4, 60, true, $5, now(), now()) RETURNING id", [domain, `https://${domain}/`, domain.split('.')[0], `${domain.split('.')[0]}-x1`, phone]))!.id);
    const a = await add('alpha.example', PHONE);
    const b = await add('beta.example', OTHER);
    const c = await add('gamma.example', null);
    const items = (await queue(app)).items;
    assert.equal(items.find((i) => i.id === a)!.direct, true, 'a lead with its own WhatsApp: the card can send now');
    assert.equal(items.find((i) => i.id === c)?.direct ?? false, false, 'one with none cannot');
    assert.deepEqual(await pitchOf(app, 'toran', a), { stage: 'first', phone: PHONE, name: 'alpha', url: 'http://localhost:4710/s/alpha-x1' });
    const said = await sendNow(app, 'toran', a, 'Demo');
    assert.match(said, /^נשלח בוואטסאפ מהמספר שלנו, וסומן שנשלח\./);
    const row = await app.db.one<any>('SELECT sent_at, followup_due_at FROM stores WHERE id = $1', [Number(a)]);
    assert.ok(row.sent_at && row.followup_due_at, 'marked sent, its one reminder due');
    assert.equal(meta.sends().at(-1)!.body.template.components[1].parameters[0].text, 'alpha-x1');
    // The day's cap: held, and nothing marked.
    await assert.rejects(sendNow(app, 'toran', b, 'Demo'), (e: any) => e instanceof OpsError && e.message === outreach.SAID_HE.cap);
    assert.equal((await app.db.one<any>('SELECT sent_at FROM stores WHERE id = $1', [Number(b)])).sent_at, null);
    // Its reminder before it is due: refused.
    await assert.rejects(sendNow(app, 'toran', a, 'Demo'), /עוד לא הזמן לתזכורת/);
  } finally {
    setNow(null);
    await app.db.close();
  }
});

test('POST /internal/outreach/send, as the contract says (test/fixtures/outreach-send.json, the same file in Teder)', async () => {
  const contract = JSON.parse(readFileSync(path.join(ROOT, 'test', 'fixtures', 'outreach-send.json'), 'utf8'));
  const route = contract.routes[0];
  const s = await serve();
  const meta = fakeMeta();
  s.app.graph = meta.f;
  Object.assign(s.app.env, META_DEMO, { META_WABA_ID: WABA, OF_INTERNAL_TOKEN: INTERNAL_TOKEN, TORAN_SIGNUP_OPEN: '1' });
  outreach.forgetQuality();
  setNow(NOON);
  const post = (body: unknown, token: string | null = INTERNAL_TOKEN, method = 'POST') =>
    fetch(`${s.base}${route.path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) }).then(async (r) => ({ status: r.status, json: await r.json() }));
  const shape = (o: any) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v === null ? 'null' : typeof v]));
  const caseOf = (re: RegExp) => route.answers.find((a: any) => re.test(a.case));
  try {
    const ok = await post(route.request.body);
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json, caseOf(/^Meta took it/).body);
    const again = await post(route.request.body);
    assert.deepEqual(shape(again.json), shape(caseOf(/^held/).body));
    assert.equal(again.json.why, 'already');
    assert.deepEqual(await post(route.request.body, null), { status: 401, json: caseOf(/no token/).body });
    assert.deepEqual(await post(route.request.body, 'wrong-token-wrong-token-wrong-token-00'), { status: 401, json: caseOf(/no token/).body });
    assert.deepEqual(await post(null, INTERNAL_TOKEN, 'GET'), { status: 405, json: caseOf(/a GET/).body });
    for (const bad of [{ ...route.request.body, product: 'x' }, { ...route.request.body, url: 'https://teder.openfrequency.co.il/' }, { ...route.request.body, phone: '123' }, { ...route.request.body, stage: 'third' }]) {
      assert.deepEqual(await post(bad), { status: 400, json: caseOf(/not a pitch/).body });
    }
    delete s.app.env.OF_INTERNAL_TOKEN;
    assert.deepEqual(await post(route.request.body), { status: 503, json: caseOf(/not set/).body });
  } finally {
    setNow(null);
    await s.close();
  }
});

test('one message with both demos: two URL buttons (Toran, then Teder), the way out third; counted once a day and as both products\' pitch at its stage', async () => {
  const { app, meta } = await pitchApp({ TORAN_OUTREACH_DAILY: '2' });
  const TEDER = 'https://teder.openfrequency.co.il/s/nurit-a1b2c3';
  try {
    // both needs Teder's page too.
    assert.equal((await outreach.sendPitch(app, pitch({ product: 'both' }))).why, 'bad_page');
    const out = await outreach.sendPitch(app, pitch({ product: 'both', url2: TEDER }));
    assert.equal(out.sent, true);
    const [send] = meta.sends();
    assert.equal(send.body.template.name, 'openfrequency_pitch_2');
    assert.deepEqual(send.body.template.components[0].parameters.map((x: any) => x.text), ['לכלי חרס של נורית', 'https://toran.openfrequency.co.il/s/nurit-x1', TEDER], 'both pages written out in the words too');
    assert.deepEqual(send.body.template.components.slice(1), [
      { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: 'nurit-x1' }] },
      { type: 'button', sub_type: 'url', index: '1', parameters: [{ type: 'text', text: 'nurit-a1b2c3' }] },
      { type: 'button', sub_type: 'quick_reply', index: '2', parameters: [{ type: 'payload', payload: 'OUTREACH_STOP' }] },
    ]);
    // It was both products' first message: neither goes alone at that stage, nor both again.
    for (const product of ['toran', 'teder', 'both'] as const) assert.equal((await outreach.sendPitch(app, pitch({ product, ...(product === 'both' ? { url2: TEDER } : {}) }))).why, 'already', product);
    // Counted once in the day's cap of 2: one more (another number) goes, the third is held.
    assert.equal((await outreach.sendPitch(app, pitch({ phone: OTHER }))).sent, true);
    assert.equal((await outreach.sendPitch(app, pitch({ phone: '972500000557' }))).why, 'cap');
  } finally {
    setNow(null);
    await app.db.close();
  }
});

test('one product\'s first message alone, then the message with both is refused at that stage; the reminder with both goes after either', async () => {
  const { app } = await pitchApp();
  const TEDER = 'https://teder.openfrequency.co.il/s/nurit-a1b2c3';
  try {
    assert.equal((await outreach.sendPitch(app, pitch())).sent, true);
    assert.equal((await outreach.sendPitch(app, pitch({ product: 'both', url2: TEDER }))).why, 'already');
    assert.equal((await outreach.sendPitch(app, pitch({ product: 'both', stage: 'reminder', url2: TEDER }))).sent, true);
    assert.equal((await outreach.sendPitch(app, pitch({ stage: 'reminder' }))).why, 'already', 'Toran\'s reminder went with both');
  } finally {
    setNow(null);
    await app.db.close();
  }
});

test('readPitch: both takes Teder\'s page as url2, a single product takes none', () => {
  const base = { stage: 'first', phone: PHONE, name: 'כלי חרס', url: 'https://toran.openfrequency.co.il/s/a', ref: 'store:1' };
  assert.equal(outreach.readPitch(JSON.stringify({ ...base, product: 'both' })), null, 'both without url2');
  assert.equal(outreach.readPitch(JSON.stringify({ ...base, product: 'toran', url2: 'https://teder.openfrequency.co.il/s/b' })), null, 'url2 on one product');
  assert.equal(outreach.readPitch(JSON.stringify({ ...base, product: 'both', url2: 'https://teder.openfrequency.co.il/s/b' }))?.url2, 'https://teder.openfrequency.co.il/s/b');
});

// The owner, 2026-11-12: "urls have to be present, in case buttons dont show". New words go to Meta for review; until
// Meta approves them, the words it approved before go, so no pitch waits for the review.
test('while Meta reviews the new words, the ones it approved before go, with only the store in them; once approved, the new ones', async () => {
  const { app, meta } = await pitchApp();
  try {
    meta.state.status = 'PENDING';
    // Asked by name: the new one is under review, the one before approved.
    const f = meta.f;
    app.graph = (async (input: any, init: any = {}) => {
      const u = new URL(String(input));
      if (u.pathname.endsWith('/message_templates') && !/_2$/.test(u.searchParams.get('name') || '')) {
        return new Response(JSON.stringify({ data: [{ name: u.searchParams.get('name'), status: 'APPROVED', quality_score: { score: 'GREEN' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return f(input, init);
    }) as typeof fetch;
    assert.equal((await outreach.sendPitch(app, pitch())).sent, true);
    const first = meta.sends().at(-1)!.body.template;
    assert.equal(first.name, 'toran_pitch');
    assert.deepEqual(first.components[0].parameters, [{ type: 'text', text: 'לכלי חרס של נורית' }], 'the words before carry the store alone');
    // Approved now, after the ten minutes Meta's word is kept: the new words, with the page written out.
    meta.state.status = 'APPROVED';
    setNow(NOON + 11 * 60_000);
    assert.equal((await outreach.sendPitch(app, pitch({ product: 'teder', url: 'https://teder.openfrequency.co.il/s/nurit-a1b2c3' }))).sent, true);
    const next = meta.sends().at(-1)!.body.template;
    assert.equal(next.name, 'teder_pitch_2');
    assert.deepEqual(next.components[0].parameters.map((x: any) => x.text), ['לכלי חרס של נורית', 'https://teder.openfrequency.co.il/s/nurit-a1b2c3']);
    // No account id to ask Meta with: the words before.
    delete app.env.META_WABA_ID;
    outreach.forgetQuality();
    assert.equal((await outreach.liveTemplate(app, outreach.OUTREACH_TEMPLATES.both_first)).name, 'openfrequency_pitch');
  } finally {
    setNow(null);
    await app.db.close();
  }
});

// The owner, 2026-11-12: "i also sent a lead message and cant see it in the inbox". A pitch from our number is kept in
// our support's conversation with that number, where the answer comes in; those sent before were brought in once.
test('a pitch from our number is in our own inbox, in the conversation its answer comes into; the ones sent before are brought in once', async () => {
  const { app } = await pitchApp();
  try {
    const ours = (await app.db.one<{ id: number }>("INSERT INTO stores (domain, url, name, platform, source, slug, status) VALUES ('openfrequency.example', 'https://openfrequency.example/', 'OpenFrequency', 'company', 'manual', 'of-c1', 'company') RETURNING id"))!.id;
    app.env.TORAN_SUPPORT_STORE = 'openfrequency.example';
    assert.equal((await outreach.sendPitch(app, pitch())).sent, true);
    const c = (await app.db.one<any>("SELECT c.id, c.store_id, c.peer, c.meta, a.status AS line FROM conversations c JOIN channel_accounts a ON a.id = c.account_id WHERE c.peer = $1", [PHONE]))!;
    assert.deepEqual([c.store_id, c.line, c.meta.name], [ours, 'line', 'כלי חרס של נורית'], "our support's conversation with them, under the store's name");
    const m = (await app.db.one<any>('SELECT role, author, auto, text, delivery FROM messages WHERE conversation_id = $1', [c.id]))!;
    assert.deepEqual([m.role, m.author, m.auto], ['owner', 'Demo', 'outreach'], "the operator's message, said as a pitch");
    assert.match(m.text, /^היי, כאן OpenFrequency\. בנינו לכלי חרס של נורית תורן, [^]*https:\/\/toran\.openfrequency\.co\.il\/s\/nurit-x1[^]*\n\n\[לנסות את תורן\] \[הסירו אותי\]$/, 'its words with the page, and its buttons');
    assert.equal(m.delivery.length, 1, "Meta's id, for the delivery report");
    // Their answer comes into the same conversation (channels/demo.ts: a phone with no demo is our support's).
    const { openConversation } = await import('../src/channels/conversations.ts');
    const again = await openConversation(app.db, { storeId: ours, channel: 'whatsapp', peer: PHONE, accountId: (await app.db.one<any>("SELECT id FROM channel_accounts WHERE status = 'line'"))!.id });
    assert.deepEqual([again.id, again.created], [c.id, false]);

    // One sent before this, as the event of the time kept it (no conversation): brought in once, in the words of then.
    const lead = (await app.db.one<{ id: number }>("INSERT INTO stores (domain, url, name, platform, source, slug) VALUES ('pofi.example', 'https://pofi.example/', 'פופי', 'shopify', 'seed', 'pofi-c1') RETURNING id"))!.id;
    await app.db.query("INSERT INTO events (store_id, kind, data) VALUES (NULL, 'outreach_wa', $1::jsonb)", [JSON.stringify({ product: 'toran', stage: 'first', phone: OTHER, ref: `toran:${lead}`, by: 'נתנאל', template: 'toran_pitch', state: 'sent', id: 'wamid.before' })]);
    assert.equal(await outreach.keepSentPitches(app), 1);
    assert.equal(await outreach.keepSentPitches(app), 0, 'once');
    const before = (await app.db.one<any>('SELECT m.text, m.author, c.meta FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.peer = $1', [OTHER]))!;
    assert.match(before.text, /^היי, כאן OpenFrequency\. בנינו לפופי תורן, שעונה ללקוחות שלכם בוואטסאפ על מחירים ומלאי[^]*\[לנסות את תורן\] \[הסירו אותי\]$/);
    assert.deepEqual([before.author, before.meta.name], ['נתנאל', 'פופי']);

    // From a number of its own (META_OUTREACH_PHONE_ID) the answers come there: nothing kept here.
    app.env.META_OUTREACH_PHONE_ID = app.env.META_DEMO_PHONE_ID;
    assert.equal((await outreach.sendPitch(app, pitch({ phone: '972500000558' }))).sent, true);
    assert.equal(await app.db.one("SELECT 1 FROM conversations WHERE peer = '972500000558'"), null);
  } finally {
    setNow(null);
    await app.db.close();
  }
});
