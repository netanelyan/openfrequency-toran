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

test('the six templates ask, keep Meta\'s rules, read as the store reads them, and docs/whatsapp-templates.md is written from them', () => {
  const now = Object.values(outreach.OUTREACH_TEMPLATES);
  assert.deepEqual(now.map((t) => t.name), ['toran_pitch_3', 'toran_pitch_reminder_3', 'teder_pitch_3', 'teder_pitch_reminder_3', 'openfrequency_pitch_3', 'openfrequency_pitch_reminder_3']);
  assert.deepEqual(now.map((t) => t.previous?.name), ['toran_pitch_2', 'toran_pitch_reminder_2', 'teder_pitch_2', 'teder_pitch_reminder_2', 'openfrequency_pitch_2', 'openfrequency_pitch_reminder_2'], 'each replaces the one Meta approved before');
  assert.deepEqual(now.map((t) => t.previous?.previous?.name), ['toran_pitch', 'toran_pitch_reminder', 'teder_pitch', 'teder_pitch_reminder', 'openfrequency_pitch', 'openfrequency_pitch_reminder'], 'and that one the first');
  const all = now.flatMap((t) => [t, t.previous!, t.previous!.previous!]);
  for (const t of all) {
    assert.equal(t.category, 'MARKETING');
    assert.doesNotMatch(t.body, /^\s*\{\{|\}\}\s*$/, `${t.name}: no variable at the body's start or end (Meta refuses one)`);
    const vars = 1 + (t.links || 0);
    assert.deepEqual(t.body.match(/\{\{\d+\}\}/g), Array.from({ length: vars }, (_, i) => `{{${i + 1}}}`), `${t.name}: the store, then its pages' addresses`);
    assert.equal(t.example.length, vars, `${t.name}: a sample for every variable`);
    assert.ok(t.body.length <= 1024, `${t.name}: within Meta's 1024 characters`);
    assert.ok(outreach.buttonsOf(t).every((b) => b.length <= 25), `${t.name}: buttons of 25 characters at most`);
    assert.ok(t.body.includes(`"${t.stop}"`), `${t.name}: says how to stop`);
    assert.ok(t.body.includes('OpenFrequency') || t.stage === 'reminder', `${t.name}: the first one says who writes`);
    assert.doesNotMatch(t.body, /—|–/, `${t.name}: no dashes`);
    const s = outreach.submission(t);
    if (t.yes) {
      // The words that ask (2026-11-15): no link, two quick replies, the yes and then the way out.
      assert.equal(t.url, undefined, `${t.name}: no link in the first touch`);
      assert.deepEqual(s.components[1].buttons, [{ type: 'QUICK_REPLY', text: t.yes }, { type: 'QUICK_REPLY', text: outreach.NO_BUTTON }]);
      assert.match(t.body, /\?\n\n/, `${t.name}: a question, then the way out`);
      continue;
    }
    // The words before: the URL buttons first, the quick reply after them (two groups); the message with both demos has
    // two URL buttons, Toran's then Teder's (Meta allows two).
    if (t.links) assert.ok(t.example.slice(1).every((u, i) => u.startsWith(i ? t.url2!.base : t.url!.base)), `${t.name}: its pages are its buttons' pages`);
    assert.match(t.url!.base, /^https:\/\/(toran|teder)\.openfrequency\.co\.il\/s\/$/, `${t.name}: the page's address, its slug appended`);
    assert.deepEqual(s.components[1].buttons!.map((b: any) => b.type), t.url2 ? ['URL', 'URL', 'QUICK_REPLY'] : ['URL', 'QUICK_REPLY']);
  }
  assert.equal(outreach.outreachFilled(outreach.OUTREACH_TEMPLATES.toran_first), 'היי, כאן OpenFrequency. בנינו לכלי חרס של נורית את תורן, עוזר שעונה ללקוחות שלכם בוואטסאפ לפי המוצרים, המחירים והמלאי שבאתר שלכם, ומעביר אליכם רק את מה שהוא לא יודע.\n\nהוא כבר מכיר את החנות. רוצים לנסות אותו כאן בצ׳אט, כמו לקוח?\n\nלא רלוונטי? לוחצים "לא, תודה" ולא נכתוב שוב.');
  assert.match(outreach.outreachFilled(outreach.OUTREACH_TEMPLATES.both_first), /^היי, כאן OpenFrequency\. הכנו לכלי חרס של נורית שני דברים לנסות: את תורן, [^]*ומצגת לדוגמה של תדר[^]*לשלוח לכם אותם לכאן\?/);
  assert.deepEqual(outreach.buttonsOf(outreach.OUTREACH_TEMPLATES.toran_first), ['כן, בואו ננסה', 'לא, תודה']);
  assert.deepEqual(outreach.buttonsOf(outreach.OUTREACH_TEMPLATES.teder_first), ['כן, תשלחו', 'לא, תודה']);
  assert.equal(outreach.templateNamed('toran_pitch')?.name, 'toran_pitch', 'a pitch of any version is known by its name');
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

test('a pitch goes once as the template that asks: the store with its "ל", the yes and the way out as its two quick replies', async () => {
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
        name: 'toran_pitch_3',
        language: { code: 'he' },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: 'בשביל הדס עיצובים' }] },
          { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: 'OUTREACH_YES' }] },
          { type: 'button', sub_type: 'quick_reply', index: '1', parameters: [{ type: 'payload', payload: 'OUTREACH_STOP' }] },
        ],
      },
    });
    assert.ok(meta.calls.some((c) => c.method === 'GET' && c.path === META_DEMO.META_DEMO_PHONE_ID && c.query.fields === 'quality_rating'), "the number's rating read first");
    assert.ok(meta.calls.some((c) => c.path === `${WABA}/message_templates` && c.query.name === 'toran_pitch_3'), "and the template's");
    // The page it is about is kept with it: a yes sends it (channels/demo.ts pitchAccepted).
    assert.equal((await app.db.one<any>("SELECT data->>'url' AS url FROM events WHERE kind = 'outreach_wa'"))!.url, 'https://toran.openfrequency.co.il/s/nurit-x1');
    // Twice: once.
    assert.equal((await outreach.sendPitch(app, pitch())).why, 'already');
    // The reminder is its own template, once too; the other product's pitch to the same number is its own.
    assert.equal((await outreach.sendPitch(app, pitch({ stage: 'reminder' }))).sent, true);
    assert.equal(meta.sends().at(-1)!.body.template.name, 'toran_pitch_reminder_3');
    assert.equal((await outreach.sendPitch(app, pitch({ product: 'teder', url: 'https://teder.openfrequency.co.il/s/nurit-a1b2c3' }))).sent, true);
    assert.equal(meta.sends().at(-1)!.body.template.name, 'teder_pitch_3');
    // A page without /s/<slug>, a number that is not one, a landline or 073 (Meta delivered none, 2026-11-13 to 15):
    // nothing at Meta.
    const n = meta.sends().length;
    assert.equal((await outreach.sendPitch(app, pitch({ phone: OTHER, url: 'https://toran.openfrequency.co.il/' }))).why, 'bad_page');
    assert.equal((await outreach.sendPitch(app, pitch({ phone: '0501234' }))).why, 'bad_phone');
    for (const landline of ['97235045043', '972733383888', '97236375525']) assert.equal((await outreach.sendPitch(app, pitch({ phone: landline }))).why, 'not_mobile', landline);
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
    const c = (await app.db.one<{ id: number }>("INSERT INTO conversations (store_id, channel, peer, started_at) VALUES ($1, 'whatsapp', $2, now() + interval '1 minute') RETURNING id", [store, PHONE]))!.id;
    await app.db.query("INSERT INTO messages (conversation_id, role, text, at) VALUES ($1, 'customer', 'DEMO-X1', now() + interval '1 minute')", [c]);
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
    assert.equal(meta.sends().at(-1)!.body.template.name, 'toran_pitch_3');
    assert.equal((await app.db.one<any>("SELECT data->>'url' AS url FROM events WHERE kind = 'outreach_wa' ORDER BY id DESC LIMIT 1"))!.url, 'http://localhost:4710/s/alpha-x1', 'its page kept, for the yes');
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

test('one message with both demos: it asks once for both, both pages kept for the yes; counted once a day and as both products\' pitch at its stage', async () => {
  const { app, meta } = await pitchApp({ TORAN_OUTREACH_DAILY: '2' });
  const TEDER = 'https://teder.openfrequency.co.il/s/nurit-a1b2c3';
  try {
    // both needs Teder's page too.
    assert.equal((await outreach.sendPitch(app, pitch({ product: 'both' }))).why, 'bad_page');
    const out = await outreach.sendPitch(app, pitch({ product: 'both', url2: TEDER }));
    assert.equal(out.sent, true);
    const [send] = meta.sends();
    assert.equal(send.body.template.name, 'openfrequency_pitch_3');
    assert.deepEqual(send.body.template.components[0].parameters.map((x: any) => x.text), ['לכלי חרס של נורית']);
    assert.deepEqual(send.body.template.components.slice(1), [
      { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: 'OUTREACH_YES' }] },
      { type: 'button', sub_type: 'quick_reply', index: '1', parameters: [{ type: 'payload', payload: 'OUTREACH_STOP' }] },
    ]);
    assert.deepEqual({ ...(await app.db.one<any>("SELECT data->>'url' AS url, data->>'url2' AS url2 FROM events WHERE kind = 'outreach_wa'")) }, { url: 'https://toran.openfrequency.co.il/s/nurit-x1', url2: TEDER });
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

// New words go to Meta for review; until Meta approves them, the words it approved before go, so no pitch waits for
// the review: the words of 2026-11-12, with the page written out and on its button (the owner then: "urls have to be
// present, in case buttons dont show"), and the way out after it.
test('while Meta reviews the new words, the ones it approved before go, with their page and its button; once approved, the new ones', async () => {
  const { app, meta } = await pitchApp();
  try {
    meta.state.status = 'PENDING';
    // Asked by name: the new one is under review, the one before approved.
    const f = meta.f;
    app.graph = (async (input: any, init: any = {}) => {
      const u = new URL(String(input));
      if (u.pathname.endsWith('/message_templates') && !/_3$/.test(u.searchParams.get('name') || '')) {
        return new Response(JSON.stringify({ data: [{ name: u.searchParams.get('name'), status: 'APPROVED', quality_score: { score: 'GREEN' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return f(input, init);
    }) as typeof fetch;
    assert.equal((await outreach.sendPitch(app, pitch())).sent, true);
    const first = meta.sends().at(-1)!.body.template;
    assert.equal(first.name, 'toran_pitch_2');
    assert.deepEqual(first.components, [
      { type: 'body', parameters: [{ type: 'text', text: 'לכלי חרס של נורית' }, { type: 'text', text: 'https://toran.openfrequency.co.il/s/nurit-x1' }] },
      { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: 'nurit-x1' }] },
      { type: 'button', sub_type: 'quick_reply', index: '1', parameters: [{ type: 'payload', payload: 'OUTREACH_STOP' }] },
    ], 'the words before, as Meta approved them');
    // Approved now, after the ten minutes Meta's word is kept: the new words, the store alone.
    meta.state.status = 'APPROVED';
    setNow(NOON + 11 * 60_000);
    assert.equal((await outreach.sendPitch(app, pitch({ product: 'teder', url: 'https://teder.openfrequency.co.il/s/nurit-a1b2c3' }))).sent, true);
    const next = meta.sends().at(-1)!.body.template;
    assert.equal(next.name, 'teder_pitch_3');
    assert.deepEqual(next.components[0].parameters.map((x: any) => x.text), ['לכלי חרס של נורית']);
    // No account id to ask Meta with: the words before.
    delete app.env.META_WABA_ID;
    outreach.forgetQuality();
    assert.equal((await outreach.liveTemplate(app, outreach.OUTREACH_TEMPLATES.both_first)).name, 'openfrequency_pitch_2');
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
    assert.match(m.text, /^היי, כאן OpenFrequency\. בנינו לכלי חרס של נורית את תורן, [^]*רוצים לנסות אותו כאן בצ׳אט, כמו לקוח\?[^]*\n\n\[כן, בואו ננסה\] \[לא, תודה\]$/, 'its words, and its buttons');
    assert.equal(m.delivery.length, 1, "Meta's id, for the delivery report");
    // Their answer comes into the same conversation (channels/demo.ts: a phone with no demo is our support's).
    const { openConversation } = await import('../src/channels/conversations.ts');
    const again = await openConversation(app.db, { storeId: ours, channel: 'whatsapp', peer: PHONE, accountId: (await app.db.one<any>("SELECT id FROM channel_accounts WHERE status = 'line'"))!.id });
    assert.deepEqual([again.id, again.created], [c.id, false]);

    // One sent before this, as the event of the time kept it (no conversation): brought in once, in the words of then.
    const lead = (await app.db.one<{ id: number }>("INSERT INTO stores (domain, url, name, platform, source, slug) VALUES ('pofi.example', 'https://pofi.example/', 'פופי', 'shopify', 'seed', 'pofi-c1') RETURNING id"))!.id;
    await app.db.query("INSERT INTO events (store_id, kind, data) VALUES (NULL, 'outreach_wa', $1::jsonb)", [JSON.stringify({ product: 'toran', stage: 'first', phone: OTHER, ref: `toran:${lead}`, by: 'נתנאל', template: 'toran_pitch', state: 'sent', id: 'wamid.before' })]);
    assert.deepEqual(await outreach.keepSentPitches(app), { kept: 1, seen: 1, noStore: 0, noTemplate: 0, noSupport: 0 });
    assert.deepEqual(await outreach.keepSentPitches(app), { kept: 0, seen: 0, noStore: 0, noTemplate: 0, noSupport: 0 }, 'once');
    const before = (await app.db.one<any>('SELECT m.text, m.author, c.meta FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.peer = $1', [OTHER]))!;
    assert.match(before.text, /^היי, כאן OpenFrequency\. בנינו לפופי תורן, שעונה ללקוחות שלכם בוואטסאפ על מחירים ומלאי[^]*\[לנסות את תורן\] \[הסירו אותי\]$/);
    assert.deepEqual([before.author, before.meta.name], ['נתנאל', 'פופי']);

    // Meta took one and could not deliver it: a line under it says so, in the operator's words, once.
    const sentId = (await app.db.one<any>("SELECT data->>'id' AS id FROM events WHERE kind = 'outreach_wa' AND data->>'phone' = $1", [PHONE]))!.id;
    assert.equal(await outreach.pitchNotDelivered(app, { id: sentId, error: '131049: This message was not delivered to maintain healthy ecosystem engagement.' }), true);
    const line = (await app.db.one<any>("SELECT role, text FROM messages WHERE conversation_id = $1 AND role = 'system'", [c.id]))!;
    assert.match(line.text, /^ההודעה הזו לא הגיעה לנמען\. Meta עצרה אותה כדי לא להציף את הנמען בהודעות שיווקיות/);
    assert.equal(outreach.notDeliveredHe('131026: Message undeliverable'), 'ההודעה הזו לא הגיעה לנמען. המספר לא יכול לקבל אותה: אולי אין בו וואטסאפ, או שהאפליקציה בו ישנה.');
    assert.match(outreach.notDeliveredHe('132000: something else'), /^ההודעה הזו לא הגיעה לנמען\. Meta לא מסרה אותה \(132000: something else\)\.$/);
    await outreach.keepSentPitches(app);
    assert.equal((await app.db.query("SELECT 1 FROM messages WHERE conversation_id = $1 AND role = 'system'", [c.id])).length, 1, 'once');

    // From a number of its own (META_OUTREACH_PHONE_ID) the answers come there: nothing kept here.
    app.env.META_OUTREACH_PHONE_ID = app.env.META_DEMO_PHONE_ID;
    assert.equal((await outreach.sendPitch(app, pitch({ phone: '972500000558' }))).sent, true);
    assert.equal(await app.db.one("SELECT 1 FROM conversations WHERE peer = '972500000558'"), null);
  } finally {
    setNow(null);
    await app.db.close();
  }
});

// The pitch kept in our support's conversation (keepPitch) opened that conversation at once, and a "לא מעוניין" to it
// read as an answer in a conversation already going (the trace of 2026-11-12): what counts is that they wrote to us.
test('a "לא מעוניין" to a pitch kept in our inbox is the way out; once they wrote to us, a bare "לא" is an answer', async () => {
  const { app } = await pitchApp();
  let n = 0;
  const write = (from: string, text: string) => handleInbound(app, { channel: 'whatsapp', from, text, id: `wamid.in-${n++}`, at: NOON, account: META_DEMO.META_DEMO_PHONE_ID, to: '972500000900' });
  try {
    await app.db.query("INSERT INTO stores (domain, url, name, platform, source, slug, status) VALUES ('openfrequency.example', 'https://openfrequency.example/', 'OpenFrequency', 'company', 'manual', 'of-c1', 'company')");
    app.env.TORAN_SUPPORT_STORE = 'openfrequency.example';
    assert.equal((await outreach.sendPitch(app, pitch())).sent, true);
    assert.ok(await app.db.one('SELECT 1 FROM conversations WHERE peer = $1', [PHONE]), 'the pitch is in our inbox');
    assert.equal((await write(PHONE, 'לא מעוניין')).action, 'outreach_stop');
    // Another, who wrote to us first: their "לא" answers what we said.
    assert.equal((await outreach.sendPitch(app, pitch({ phone: OTHER }))).sent, true);
    await write(OTHER, 'מה זה בדיוק?');
    assert.notEqual((await write(OTHER, 'לא')).action, 'outreach_stop');
    assert.equal(await outreach.stoppedNumber(app, OTHER), false);
  } finally {
    setNow(null);
    await app.db.close();
  }
});

// ---- the pitch that asks (2026-11-15)

// The owner, 2026-11-15: "19 messages, 0 replies. redo that part. from start until the end ... i want it working and i
// want costumers". The pitch asks, and a yes brings the demo into the chat at once: Toran's starts answering there, a
// slideshow comes as its first slide. Numbers are fictional; Meta and the slide's server are stand-ins.

/** Our company store (our support on our number) and a lead with Toran's page built, its WhatsApp PHONE. */
async function yesSetup(app: any): Promise<number> {
  await app.db.query("INSERT INTO stores (domain, url, name, platform, source, slug, status) VALUES ('openfrequency.example', 'https://openfrequency.example/', 'OpenFrequency', 'company', 'manual', 'of-c1', 'company')");
  app.env.TORAN_SUPPORT_STORE = 'openfrequency.example';
  return (await app.db.one("INSERT INTO stores (domain, url, name, platform, source, slug, demo_code, contact_whatsapp, approved_at, page_built_at, status) VALUES ('nurit.example', 'https://nurit.example/', 'כלי חרס של נורית', 'shopify', 'seed', 'nurit-x1', 'DEMO-NUR1', $1, now(), now(), 'page_ready') RETURNING id", [PHONE]))!.id as number;
}

test("a yes pressed on Toran's pitch starts the store's own Toran right in the chat, once; the operator hears what went", async () => {
  const { app, meta } = await pitchApp();
  let n = 0;
  const write = (text: string, payload?: string) => handleInbound(app, { channel: 'whatsapp', from: PHONE, text, id: `wamid.in-${n++}`, at: NOON, account: META_DEMO.META_DEMO_PHONE_ID, to: '972500000900', ...(payload ? { payload } : {}) });
  try {
    const id = await yesSetup(app);
    assert.equal((await outreach.sendPitch(app, pitch({ ref: `store:${id}` }))).sent, true);
    const r = await write(outreach.TRY_BUTTON, outreach.YES_PAYLOAD);
    assert.equal(r.action, 'pitch_yes');
    assert.match(String(r.reply), /^מעכשיו עונה לכם כאן תורן של כלי חרס של נורית, כמו שהוא יענה ללקוחות שלכם\./);
    assert.match(meta.calls.at(-1)!.body.text.body, /^מעכשיו עונה לכם כאן תורן של/, 'sent in the chat');
    assert.deepEqual({ ...(await app.db.one<any>('SELECT store_id FROM wa_users WHERE phone = $1', [PHONE])) }, { store_id: id }, "the phone is bound to the store's demo");
    const s = (await app.db.one<any>('SELECT status, demo_started_at, replied_at FROM stores WHERE id = $1', [id]))!;
    assert.ok(s.demo_started_at && s.replied_at && s.status === 'demo_started', 'the lead tried the demo and answered');
    assert.ok((await app.db.one<any>("SELECT data->>'yes' AS yes FROM events WHERE kind = 'outreach_wa'"))!.yes, 'the yes kept on the pitch');
    const alert = (await app.db.one<any>("SELECT data FROM events WHERE kind = 'operator_alert' AND data->>'key' LIKE 'lead_reply:%'"))!.data;
    assert.match(JSON.stringify(alert), /אמרו כן/);
    // Once: their next message is the demo's to answer, not another yes.
    assert.notEqual((await write('כן')).action, 'pitch_yes');
  } finally {
    setNow(null);
    await app.db.close();
  }
});

test('a yes on Teder\'s pitch sends its first slide with the link; a written yes counts only before they wrote; "לא, תודה" pressed always stops', async () => {
  const { app, meta } = await pitchApp();
  let n = 0;
  const write = (from: string, text: string, payload?: string) => handleInbound(app, { channel: 'whatsapp', from, text, id: `wamid.in-${n++}`, at: NOON, account: META_DEMO.META_DEMO_PHONE_ID, to: '972500000900', ...(payload ? { payload } : {}) });
  const TEDER = 'https://teder.openfrequency.co.il/s/nurit-a1b2c3';
  try {
    const id = await yesSetup(app);
    // The slide's server: TikTok's first slide is there.
    app.api = (async (input: any, init: any = {}) => new Response(null, { status: String(input) === `${TEDER}/tiktok-0.jpg` && init.method === 'HEAD' ? 200 : 404, headers: { 'content-type': 'image/jpeg' } })) as typeof fetch;
    assert.equal((await outreach.sendPitch(app, pitch({ product: 'teder', url: TEDER, ref: `store:${id}` }))).sent, true);
    // Written, not pressed, before they wrote anything: a yes.
    assert.equal((await write(PHONE, 'כן תשלחו')).action, 'pitch_yes');
    const img = meta.calls.filter((c) => c.body?.type === 'image').at(-1)!;
    assert.equal(img.body.image.link, `${TEDER}/tiktok-0.jpg`);
    assert.ok(img.body.image.caption.startsWith(`זו המצגת שתדר הכין לכלי חרס של נורית, והשקף הראשון שלה כאן. כל השקפים: ${TEDER}`), img.body.image.caption);
    assert.equal(await app.db.one('SELECT 1 FROM wa_users WHERE phone = $1', [PHONE]), null, 'Teder alone binds no demo');

    // Another lead, who wrote to us first: their "כן" answers what we said, but the button pressed is still the way out.
    assert.equal((await outreach.sendPitch(app, pitch({ phone: OTHER, product: 'teder', url: TEDER }))).sent, true);
    await write(OTHER, 'מה זה בדיוק?');
    assert.notEqual((await write(OTHER, 'כן')).action, 'pitch_yes');
    assert.equal((await write(OTHER, outreach.NO_BUTTON, outreach.STOP_PAYLOAD)).action, 'outreach_stop');
    assert.ok(await outreach.stoppedNumber(app, OTHER));
  } finally {
    setNow(null);
    await app.db.close();
  }
});

test("a quick reply's payload comes with the message; our number's deliveries and reads are queued and kept on its pitch, other numbers' are not", async () => {
  const { parseWebhook } = await import('../src/channels/meta.ts');
  const { takeWhatsapp } = await import('../src/channels/waHook.ts');
  const { app } = await pitchApp();
  try {
    const hook = (value: any, phoneId = META_DEMO.META_DEMO_PHONE_ID) => ({ object: 'whatsapp_business_account', entry: [{ id: WABA, changes: [{ field: 'messages', value: { metadata: { phone_number_id: phoneId, display_phone_number: '972500000900' }, ...value } }] }] });
    const pressed = parseWebhook(hook({ contacts: [{ wa_id: PHONE, profile: { name: 'נורית' } }], messages: [{ from: PHONE, id: 'wamid.press', type: 'button', timestamp: '1', button: { text: 'לא, תודה', payload: 'OUTREACH_STOP' } }] }));
    assert.deepEqual([pressed.messages[0].text, pressed.messages[0].payload], ['לא, תודה', 'OUTREACH_STOP']);

    assert.equal((await outreach.sendPitch(app, pitch())).sent, true);
    const wamid = (await app.db.one<any>("SELECT data->>'id' AS id FROM events WHERE kind = 'outreach_wa'"))!.id;
    await takeWhatsapp(app, parseWebhook(hook({ statuses: [{ id: wamid, status: 'delivered', recipient_id: PHONE }, { id: wamid, status: 'read', recipient_id: PHONE }, { id: 'wamid.x', status: 'sent', recipient_id: PHONE }] })));
    await takeWhatsapp(app, parseWebhook(hook({ statuses: [{ id: 'wamid.store', status: 'delivered', recipient_id: OTHER }] }, '777666555444333')));
    const queued = await app.db.query<any>("SELECT payload FROM jobs WHERE kind = 'wa_status' ORDER BY id");
    assert.deepEqual(queued.map((j) => j.payload.status), ['delivered', 'read'], "our number's delivery and read; no 'sent', nothing of another number");
    assert.equal(await outreach.pitchStatus(app, { id: wamid, status: 'delivered', account: META_DEMO.META_DEMO_PHONE_ID }), true);
    assert.equal(await outreach.pitchStatus(app, { id: wamid, status: 'delivered', account: META_DEMO.META_DEMO_PHONE_ID }), false, 'kept once');
    assert.equal(await outreach.pitchStatus(app, { id: wamid, status: 'read', account: META_DEMO.META_DEMO_PHONE_ID }), true);
    const d = (await app.db.one<any>("SELECT data FROM events WHERE kind = 'outreach_wa'"))!.data;
    assert.ok(d.delivered && d.read && d.delivered <= d.read);
    assert.equal(await outreach.pitchStatus(app, { id: wamid, status: 'read', account: '777666555444333' }), false, "another number's word is not ours");
  } finally {
    setNow(null);
    await app.db.close();
  }
});

test("the one reminder goes by itself once it is due and nobody answered, as the operator's button sends it; never twice, never after a demo", async () => {
  const { remindDue, AUTO_BY } = await import('../src/ops/remind.ts');
  const { app, meta, logs } = await pitchApp();
  try {
    const add = async (domain: string, phone: string, tried: boolean) =>
      (await app.db.one<{ id: number }>(
        `INSERT INTO stores (domain, url, name, platform, source, slug, contact_whatsapp, approved_at, page_built_at, sent_at, followup_due_at, status, demo_started_at)
         VALUES ($1, $2, $3, 'shopify', 'seed', $4, $5, now() - interval '5 days', now() - interval '5 days', now() - interval '5 days', '2026-11-09T10:00:00Z', 'sent', ${tried ? 'now()' : 'NULL'}) RETURNING id`,
        [domain, `https://${domain}/`, domain.split('.')[0], `${domain.split('.')[0]}-x1`, phone],
      ))!.id;
    const a = await add('alpha.example', PHONE, false);
    const b = await add('beta.example', OTHER, true);
    const firstOf = (id: number, phone: string) =>
      app.db.query("INSERT INTO events (store_id, kind, data, at) VALUES (NULL, 'outreach_wa', $1::jsonb, now() - interval '5 days')", [JSON.stringify({ product: 'toran', stage: 'first', phone, ref: `toran:${id}`, by: 'נתנאל', template: 'toran_pitch_2', state: 'sent', id: `wamid.first-${id}`, url: `http://localhost:4710/s/x-${id}` })]);
    await firstOf(a, PHONE);
    await firstOf(b, OTHER);
    // Shabbat: nothing.
    setNow(Date.parse('2026-11-14T10:00:00.000Z'));
    assert.equal(await remindDue(app), 0);
    setNow(NOON);
    assert.equal(await remindDue(app), 1, `the one that tried the demo since gets none (${logs.join(' | ')})`);
    const sent = meta.sends().at(-1)!.body;
    assert.deepEqual([sent.to, sent.template.name], [PHONE, 'toran_pitch_reminder_3']);
    assert.ok((await app.db.one<any>('SELECT followup_sent_at FROM stores WHERE id = $1', [a]))!.followup_sent_at, "marked reminded, as the operator's button marks it");
    assert.ok(await app.db.one("SELECT 1 FROM events WHERE kind = 'outreach_wa' AND data->>'stage' = 'reminder' AND data->>'by' = $1", [AUTO_BY]), "said as the schedule's");
    assert.equal((await app.db.one<any>("SELECT data->>'remind' AS r FROM events WHERE kind = 'outreach_wa' AND data->>'phone' = $1 AND data->>'stage' = 'first'", [OTHER]))!.r, 'tried');
    // Again: nothing more.
    const n = meta.sends().length;
    assert.equal(await remindDue(app), 0);
    assert.equal(meta.sends().length, n);
    // TORAN_OUTREACH_AUTO=0 stops it.
    app.env.TORAN_OUTREACH_AUTO = '0';
    assert.equal(await remindDue(app), 0);
  } finally {
    setNow(null);
    await app.db.close();
  }
});

test("a business's automatic greeting to the pitch is not their answer: nobody is told, the reminder still goes; what they write themselves is", async () => {
  const { app } = await pitchApp();
  let n = 0;
  const write = (text: string) => handleInbound(app, { channel: 'whatsapp', from: PHONE, text, id: `wamid.in-${n++}`, at: NOON, account: META_DEMO.META_DEMO_PHONE_ID, to: '972500000900' });
  try {
    await yesSetup(app);
    assert.equal((await outreach.sendPitch(app, pitch())).sent, true);
    // The words of one of the first pitches' "answers", under a minute after it (2026-11-13).
    await write('היי, שרות הלקוחות שלנו פעיל בין השעות 09:00-15:00 בימים א׳-ה׳. ניתן להשאיר הודעה ומספר הזמנה ונחזור אלייך בהקדם (עד 3 ימי עסקים לכל היותר)');
    const d = (await app.db.one<any>("SELECT data FROM events WHERE kind = 'outreach_wa'"))!.data;
    assert.ok(d.auto_answer && !d.replied, 'kept as automatic, not as their answer');
    assert.equal(await app.db.one("SELECT 1 FROM events WHERE kind = 'operator_alert' AND data->>'key' LIKE 'lead_reply:%'"), null, 'nobody told');
    assert.equal(await outreach.wroteSinceFirst(app, PHONE), false);
    assert.equal((await outreach.sendPitch(app, pitch({ stage: 'reminder' }))).sent, true, 'the reminder goes');
    // A person who answers fast, in their own words: an answer.
    const { automaticAnswer } = await import('../src/ops/leadReply.ts');
    assert.equal(automaticAnswer('מי אתם בכלל?', 20_000), false);
    assert.equal(automaticAnswer('ספרו לנו במה אפשר לעזור', 10 * 60_000), false, 'and those words later are a person');
    assert.equal(automaticAnswer('ראינו שהשארת לנו פנייה בהדרא. ספרו לנו במה אפשר לעזור', 30_000), true);
  } finally {
    setNow(null);
    await app.db.close();
  }
});
