import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as outreach from '../src/ops/outreach.ts';
import { leadTurn, pitchFor } from '../src/ops/leadReply.ts';
import { leadOne } from '../src/ops/leadsAdmin.ts';
import { handleInbound } from '../src/channels/route.ts';
import { syncCompany, type CompanyExport } from '../src/company.ts';
import { LEAD_OPENING_NOTE, leadLine, openingOf } from '../src/agent/intro.ts';
import { filesContext, NO_WORDS_HE } from '../src/channels/store.ts';
import { STATE_SQL, WAITING_SQL } from '../src/web/inbox.ts';
import { setNow } from '../src/core/clock.ts';
import type { Script } from '../src/agent/llm/scripted.ts';
import type { TurnReq } from '../src/agent/llm/types.ts';
import { INTERNAL_TOKEN, META_DEMO, testApp } from './helpers.ts';

// A store we wrote to first answers us (the owner, 2026-11-12: "How does our toran answer after a lead answers? Make
// sure the behavior is defined. Make sure it sells itself"; src/ops/leadReply.ts). Our support answers it as a store we
// wrote to: the turn knows our message and what we built, its first line is the Toran we built for it, the lead is
// marked answered once and the operator told, and the reminder no longer goes. The model is a script that records what
// it was asked; Meta and Teder are stand-ins. Nothing leaves this machine, and no key is used. Numbers are fictional.

const PHONE = '972500000555';
const OTHER = '972500000556';
const THIRD = '972500000557';
const OUR_NUMBER = '972500000900';
const WABA = '999888777666555';
/** A Tuesday, 12:00 in Israel: never quiet. */
const NOON = Date.parse('2026-11-10T10:00:00.000Z');
const PAGE = 'https://toran.openfrequency.co.il/s/nurit-x1';
const TEDER_PAGE = 'https://teder.openfrequency.co.il/s/nurit-x1-a1b2';

// Our own support, in the shape of openfrequency-web's export, with made-up words and the plans' real shape.
const ours = (): CompanyExport => ({
  domain: 'openfrequency.example',
  url: 'https://openfrequency.example/',
  name: 'OpenFrequency',
  status: 'מה תורן עושה היום:\n- עונה בוואטסאפ, באינסטגרם, במסנג׳ר ובמייל.\n- קורא חנות על Shopify, על WooCommerce או על Wix.',
  tone: 'אנחנו עסק קטן מישראל.',
  contact: { whatsapp: OUR_NUMBER, email: 'hello@openfrequency.example' },
  plans: [
    { key: 'toran-store', product: 'toran', title: 'תורן, חבילת חנות', monthly: 590, text: '590 ₪ לחודש, לא כולל מע״מ, עד 300 שיחות בחודש. בחודש הראשון יש גם 990 ₪ דמי הקמה, פעם אחת.', url: 'https://openfrequency.example/toran#price' },
    { key: 'teder-small', product: 'teder', title: 'תדר, חבילה קטנה', monthly: 490, text: '490 ₪ לחודש, לא כולל מע״מ, 15 מצגות ו-4 החלפות בחודש. בחודש הראשון יש גם 990 ₪ דמי הקמה, פעם אחת.', url: 'https://openfrequency.example/teder#price' },
  ],
  faq: [],
  pages: [{ kind: 'about', title: 'מי אנחנו', url: 'https://openfrequency.example/', text: 'אנחנו OpenFrequency, עסק קטן מישראל. אנחנו בונים כלים בעברית לעסקים קטנים ולחנויות אונליין.' }],
  generatedAt: '2026-11-12T10:00:00.000Z',
});

type Call = { method: string; path: string; body: any };

/** Meta for our number: its rating and the templates' (all good), and every send kept. */
function fakeMeta() {
  const calls: Call[] = [];
  const f = (async (input: any, init: any = {}) => {
    const u = new URL(String(input));
    const p = u.pathname.replace(/^\/v\d+\.\d+\//, '');
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method: init.method || 'GET', path: p, body });
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
    if ((init.headers as any)?.authorization !== `Bearer ${META_DEMO.META_SYSTEM_TOKEN}`) return json({ error: { message: 'refused', code: 190 } }, 401);
    if (init.method === 'GET' && p === META_DEMO.META_DEMO_PHONE_ID) return json({ quality_rating: 'GREEN', id: p });
    if (init.method === 'GET' && p === `${WABA}/message_templates`) return json({ data: [{ name: u.searchParams.get('name'), status: 'APPROVED', quality_score: { score: 'GREEN' } }] });
    if (init.method === 'POST' && p === `${META_DEMO.META_DEMO_PHONE_ID}/messages`) return json({ messaging_product: 'whatsapp', messages: [{ id: `wamid.out-${calls.length}` }] });
    return json({ error: { message: 'unexpected', code: 1 } }, 400);
  }) as typeof fetch;
  return { f, calls };
}

/** Teder for one store: its lead at a stage, and each move kept. */
async function fakeTeder(stage: string) {
  const moved: any[] = [];
  const set = (s: string) => {
    stage = s;
  };
  const lead = () => ({ id: 7, stage, sentAt: '2026-11-10T10:00:00.000Z', reminderSentAt: null, reminderDue: false, whatsapp: PHONE, demo: null, leadUrl: 'https://accounts.example/admin' });
  const srv = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const p = new URL(req.url || '/', 'http://teder').pathname;
    const out = (b: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(b));
    };
    if (p === '/internal/leads/state') return out({ ok: true, lead: lead() });
    if (p === '/internal/leads/stage') {
      moved.push(JSON.parse(raw));
      stage = 'replied';
      return out({ ok: true, message: 'סומן שענו', lead: lead() });
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return { moved, set, base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, close: () => new Promise((r) => srv.close(r)) };
}

const lastText = (req: TurnReq) => {
  const m = req.messages[req.messages.length - 1];
  return typeof m.content === 'string' ? m.content : m.content.map((b: any) => b.text || '').join('\n');
};
const lastToolResult = (req: TurnReq) => {
  const m = req.messages[req.messages.length - 1];
  return typeof m.content === 'string' ? null : (m.content.find((b) => b.type === 'tool_result') as { content: string } | undefined)?.content ?? null;
};

/**
 * Our support with a model that goes on from the LEAD block: their store's Toran, at its link; a price from get_plans.
 * `asked` keeps the text of each request's last message (the SERVER CONTEXT with the person's words).
 */
async function supportApp(env: Record<string, string> = {}) {
  const asked: string[] = [];
  const script: Script = (req) => {
    const res = lastToolResult(req);
    if (res) return [{ type: 'text', text: 'חבילת חנות עולה 590 ₪ לחודש, לא כולל מע״מ, עד 300 שיחות בחודש.' }];
    const said = lastText(req);
    asked.push(said);
    if (/כמה זה עולה/.test(said)) return [{ type: 'tool_use', id: 'p1', name: 'get_plans', input: {} }];
    const url = /Their store's own Toran[^:]*: (\S+)/.exec(said)?.[1];
    return [{ type: 'text', text: url ? `תורן כבר קרא את המוצרים והמדיניות מהאתר שלכם, ואפשר לכתוב לו עכשיו כמו לקוח: ${url}` : 'אפשר לשאול אותי על תורן ועל תדר.' }];
  };
  const app = await testApp({ script });
  const meta = fakeMeta();
  app.graph = meta.f;
  app.log = () => {};
  Object.assign(app.env, META_DEMO, { META_WABA_ID: WABA, DEMO_WA_NUMBER: OUR_NUMBER, TORAN_SIGNUP_OPEN: '1', TORAN_SUPPORT_STORE: 'openfrequency.example', TORAN_ALERT_CMD: 'off' }, env);
  outreach.forgetQuality();
  setNow(NOON);
  const support = (await syncCompany(app, ours())).storeId;
  let n = 0;
  const write = (from: string, text: string, more: Record<string, unknown> = {}) => handleInbound(app, { channel: 'whatsapp', from, text, id: `wamid.in-${n++}`, at: NOON, account: META_DEMO.META_DEMO_PHONE_ID, to: OUR_NUMBER, ...more });
  const lead = async (domain: string, phone: string, slug: string, name: string) =>
    (await app.db.one<{ id: number }>(
      "INSERT INTO stores (domain, url, name, platform, source, slug, score, qualified, contact_whatsapp, approved_at, page_built_at, sent_at, followup_due_at, status) VALUES ($1, $2, $3, 'shopify', 'seed', $4, 60, true, $5, now(), now(), '2026-11-05T10:00:00Z', '2026-11-09T10:00:00Z', 'sent') RETURNING id",
      [domain, `https://${domain}/`, name, slug, phone],
    ))!.id;
  const alerts = async () => (await app.db.query<{ key: string; title: string }>("SELECT data->>'key' AS key, data->>'title' AS title FROM events WHERE kind = 'operator_alert' AND data->>'key' LIKE 'lead_reply:%' ORDER BY id")).map((r) => ({ ...r }));
  return { app, meta, asked, support, write, lead, alerts };
}

test('a store we wrote to answers: the turn knows our message and its Toran, its first line is that Toran, the lead is marked once, the operator told, and no reminder goes', async () => {
  const { app, asked, support, write, lead, alerts } = await supportApp();
  try {
    const id = await lead('nurit.example', PHONE, 'nurit-x1', 'כלי חרס של נורית');
    assert.equal((await leadOne(app, id))!.lead.toran.reminderDue, true, 'before they answer, the reminder is due');
    assert.equal((await outreach.sendPitch(app, { product: 'toran', stage: 'first', phone: PHONE, name: 'כלי חרס של נורית', url: PAGE, ref: `store:${id}`, by: 'Demo' })).sent, true);
    // The event keeps the store's name and the page it was sent, whatever the template's words carried.
    const sent = (await app.db.one<any>("SELECT id, data FROM events WHERE kind = 'outreach_wa' AND data->>'phone' = $1", [PHONE]))!;
    assert.deepEqual([sent.data.name, sent.data.url, sent.data.url2], ['כלי חרס של נורית', PAGE, null]);

    const r = await write(PHONE, 'כן, מעניין');
    assert.equal(r.action, 'answered');
    assert.equal(r.storeId, support, 'our support answers');
    const line = 'כאן תורן, הבוט של OpenFrequency. זה אותו תורן שבנינו לכלי חרס של נורית, ועכשיו אני עונה לכם כמו שאענה ללקוחות שלכם.';
    assert.equal(r.reply, `${line}\n\nתורן כבר קרא את המוצרים והמדיניות מהאתר שלכם, ואפשר לכתוב לו עכשיו כמו לקוח: ${PAGE}`, 'the Toran we built for them, then the answer with its link kept');
    // What the model was told: the LEAD block, with our message as they got it and the link, and not to say the line.
    assert.match(asked[0], /LEAD \(the app's record, not the person's words\): they write from the store "כלי חרס של נורית" \(nurit\.example\), which we wrote to first/);
    assert.match(asked[0], /Our message to them, as they got it:\n"""\nהיי, כאן OpenFrequency\. בנינו לכלי חרס של נורית תורן/);
    assert.ok(asked[0].includes(`Their store's own Toran, built from their website, which they can write to now as their customers would: ${PAGE} (they have not written to it yet).`));
    assert.ok(asked[0].includes('Where they start, with the price and the sign-up: https://openfrequency.co.il/toran'));
    assert.ok(asked[0].includes(LEAD_OPENING_NOTE));
    const answer = (await app.db.one<any>("SELECT m.guard, c.id AS conv FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.peer = $1 AND m.role = 'agent' ORDER BY m.id DESC LIMIT 1", [PHONE]))!;
    assert.deepEqual(answer.guard, [], 'nothing cut: the LEAD block backs its link');

    // Marked once: the lead answered, its next step tomorrow, the pitch's event, the operator told with the link.
    const s = (await app.db.one<any>('SELECT replied_at, next_step_at FROM stores WHERE id = $1', [id]))!;
    assert.ok(s.replied_at && s.next_step_at);
    assert.equal((await app.db.one<any>('SELECT data FROM events WHERE id = $1', [sent.id]))!.data.replied, Number(answer.conv));
    assert.equal((await app.db.query("SELECT 1 FROM events WHERE kind = 'outreach_reply' AND store_id = $1", [id])).length, 1);
    assert.deepEqual(await alerts(), [{ key: `lead_reply:${sent.id}`, title: 'כלי חרס של נורית ענו להודעה שלנו' }]);

    // Their next message: no new mark, no new alert, no line again; the price from the plans.
    const again = await write(PHONE, 'כמה זה עולה?');
    assert.equal(again.reply, 'חבילת חנות עולה 590 ₪ לחודש, לא כולל מע״מ, עד 300 שיחות בחודש.');
    assert.equal((await alerts()).length, 1, 'told once');
    assert.equal((await app.db.query("SELECT 1 FROM events WHERE kind = 'outreach_reply'")).length, 1);

    // The reminder: refused, said so; on /admin/leads they are talking, and no reminder is due or waiting.
    assert.deepEqual(await outreach.sendPitch(app, { product: 'toran', stage: 'reminder', phone: PHONE, name: 'כלי חרס של נורית', url: PAGE, ref: `store:${id}`, by: 'Demo' }), { sent: false, why: 'replied', said: outreach.SAID_HE.replied });
    const one = (await leadOne(app, id))!.lead;
    assert.deepEqual([one.where, one.toran.reminderDue, one.send.stage ?? null], ['talking', false, null]);

    // In the inbox: Toran answered it alone, our own pitch is not an answer of ours.
    assert.equal((await app.db.one<any>(`SELECT ${STATE_SQL} AS state FROM conversations c WHERE c.id = $1`, [answer.conv]))!.state, 'alone');
  } finally {
    setNow(null);
    await app.db.close();
  }
});

test('the bot opens after our kept pitch as after nothing, and after a person who answered as "again"', async () => {
  const { app, support } = await supportApp();
  try {
    const conv = (await app.db.one<{ id: number }>("INSERT INTO conversations (store_id, channel, peer) VALUES ($1, 'whatsapp', $2) RETURNING id", [support, PHONE]))!.id;
    await app.db.query("INSERT INTO messages (conversation_id, role, text, author, auto) VALUES ($1, 'owner', 'היי, כאן OpenFrequency.', 'Demo', 'outreach')", [conv]);
    assert.equal(await openingOf(app.db, conv), 'first', 'our pitch is not a person answering');
    await app.db.query("INSERT INTO messages (conversation_id, role, text, author) VALUES ($1, 'owner', 'אני כאן, איך אפשר לעזור?', 'נתנאל')", [conv]);
    assert.equal(await openingOf(app.db, conv), 'again');
    // The lines: Toran's, with the store's "ל"; Teder's alone; in English for English.
    assert.equal(leadLine({ product: 'both', name: 'הדס' }, 'תורן', 'OpenFrequency'), 'כאן תורן, הבוט של OpenFrequency. זה אותו תורן שבנינו בשביל הדס, ועכשיו אני עונה לכם כמו שאענה ללקוחות שלכם.');
    assert.equal(leadLine({ product: 'teder', name: 'פופי' }, 'תורן', 'OpenFrequency'), 'כאן תורן, הבוט של OpenFrequency. את המצגת הכין תדר, ואני עונה כאן על השאלות.');
    assert.match(leadLine({ product: 'toran', name: 'Nike' }, 'תורן', 'OpenFrequency', true), /^This is תורן, OpenFrequency's bot\. It's the same Toran we built for Nike/);
  } finally {
    setNow(null);
    await app.db.close();
  }
});

test('a number we never wrote to gets no LEAD block; a pitch eight days old is read in a new conversation, its pages found through its ref', async () => {
  const { app, asked, write } = await supportApp();
  try {
    const plain = await write(OTHER, 'מה זה תורן?');
    assert.equal(plain.reply, 'כאן תורן, הבוט של OpenFrequency.\n\nאפשר לשאול אותי על תורן ועל תדר.');
    assert.doesNotMatch(asked[0], /LEAD/);

    // A pitch sent before the event kept its pages (no name, no url), eight days ago: past a conversation's week.
    const pofi = (await app.db.one<{ id: number }>("INSERT INTO stores (domain, url, name, platform, source, slug, contact_whatsapp, page_built_at) VALUES ('pofi.example', 'https://pofi.example/', 'פופי', 'shopify', 'seed', 'pofi-c1', $1, now()) RETURNING id", [THIRD]))!.id;
    await app.db.query("INSERT INTO events (store_id, kind, data, at) VALUES (NULL, 'outreach_wa', $1::jsonb, now() - interval '8 days')", [JSON.stringify({ product: 'toran', stage: 'first', phone: THIRD, ref: `toran:${pofi}`, by: 'נתנאל', template: 'toran_pitch', state: 'sent', id: 'wamid.before' })]);
    const p = (await pitchFor(app, THIRD))!;
    assert.deepEqual([p.storeId, p.name, p.toranUrl, p.tried, p.replied], [pofi, 'פופי', 'http://localhost:4710/s/pofi-c1', false, false]);
    assert.match(p.text!, /^היי, כאן OpenFrequency\. בנינו לפופי תורן, שעונה ללקוחות שלכם בוואטסאפ על מחירים ומלאי/, 'the words of then');
    const line = (await app.db.one<{ id: number }>("SELECT id FROM channel_accounts WHERE status = 'line'"))!.id;
    const old = (await app.db.one<{ id: number }>("INSERT INTO conversations (store_id, channel, peer, account_id, started_at, last_at) VALUES ((SELECT store_id FROM channel_accounts WHERE id = $1), 'whatsapp', $2, $1, now() - interval '8 days', now() - interval '8 days') RETURNING id", [line, THIRD]))!.id;
    await app.db.query("INSERT INTO messages (conversation_id, role, text, author, auto, at) VALUES ($1, 'owner', 'היי, כאן OpenFrequency.', 'נתנאל', 'outreach', now() - interval '8 days')", [old]);
    const r = await write(THIRD, 'קיבלתי הודעה מכם, מה זה?');
    assert.notEqual((await app.db.one<{ id: number }>("SELECT c.id FROM conversations c WHERE c.peer = $1 ORDER BY c.id DESC LIMIT 1", [THIRD]))!.id, old, 'a new conversation');
    assert.match(r.reply!, /^כאן תורן, הבוט של OpenFrequency\. זה אותו תורן שבנינו לפופי,/);
    assert.ok(r.reply!.endsWith('http://localhost:4710/s/pofi-c1'), 'its own page, found through the ref');
    assert.match(asked.at(-1)!, /they write from the store "פופי" \(pofi\.example\)/);

    // One that asked us to stop is not answered as a lead.
    await app.db.query("INSERT INTO outreach_stops (phone, product, said) VALUES ($1, 'toran', 'הסר')", [THIRD]);
    assert.equal(await pitchFor(app, THIRD), null);
  } finally {
    setNow(null);
    await app.db.close();
  }
});

test("both demos: Teder's slideshow in the LEAD block, both product pages to start from, and Teder's own lead moved to answered only from where a pitch leaves it", async () => {
  const teder = await fakeTeder('sent');
  const { app, asked, write, lead } = await supportApp({ TEDER_SITE_INTERNAL: '', OF_INTERNAL_TOKEN: INTERNAL_TOKEN });
  app.env.TEDER_SITE_INTERNAL = teder.base;
  try {
    const id = await lead('nurit.example', PHONE, 'nurit-x1', 'כלי חרס של נורית');
    await app.db.query("INSERT INTO teder_leads (id, domain, status, whatsapp) VALUES ('d-1', 'nurit.example', 'approved', $1)", [PHONE]);
    assert.equal((await outreach.sendPitch(app, { product: 'both', stage: 'first', phone: PHONE, name: 'כלי חרס של נורית', url: PAGE, url2: TEDER_PAGE, ref: `store:${id}`, by: 'Demo' })).sent, true);
    const t = leadTurn((await pitchFor(app, PHONE))!);
    assert.deepEqual(t.lead, { product: 'both', name: 'כלי חרס של נורית' });
    assert.ok(t.context.includes(`The sample slideshow Teder made from their website: ${TEDER_PAGE}`));
    assert.ok(t.context.includes('Where they start, with the price and the sign-up: https://openfrequency.co.il/toran (Toran), https://openfrequency.co.il/teder (Teder)'));
    await write(PHONE, 'נראה טוב');
    assert.match(asked[0], /we offered them Toran, built on their store, and a sample Teder slideshow made from it/);
    assert.deepEqual(teder.moved.map((m) => [m.toran, m.domain, m.stage]), [[String(id), 'nurit.example', 'replied']]);
    assert.ok((await app.db.one<any>("SELECT replied_at FROM teder_leads WHERE id = 'd-1'"))!.replied_at, "our mirror of Teder's demo too");
    // Their next message: the pitch is marked, nothing moves again.
    await write(PHONE, 'עוד שאלה');
    assert.equal(teder.moved.length, 1);
    // Joined on Teder (or not relevant there) is never moved back to answered, even when a pitch is marked anew.
    teder.set('joined');
    await app.db.query("UPDATE events SET data = data - 'replied' WHERE kind = 'outreach_wa'");
    await write(PHONE, 'ועוד אחת');
    assert.equal(teder.moved.length, 1, 'joined stays joined');
  } finally {
    setNow(null);
    await teder.close();
    await app.db.close();
  }
});

test('our support answers a voice note in code and keeps it for us; a photo there is never looked for in a catalogue', async () => {
  const { app, asked, write, lead, alerts } = await supportApp();
  try {
    const id = await lead('nurit.example', PHONE, 'nurit-x1', 'כלי חרס של נורית');
    assert.equal((await outreach.sendPitch(app, { product: 'toran', stage: 'first', phone: PHONE, name: 'כלי חרס של נורית', url: PAGE, ref: `store:${id}`, by: 'Demo' })).sent, true);
    const voice = await write(PHONE, '', { attachments: [{ name: 'audio', type: 'audio/ogg; codecs=opus', size: 0 }] });
    assert.equal(voice.action, 'no_text');
    assert.equal(voice.reply, `כאן תורן, הבוט של OpenFrequency. זה אותו תורן שבנינו לכלי חרס של נורית, ועכשיו אני עונה לכם כמו שאענה ללקוחות שלכם.\n\n${NO_WORDS_HE.voice}`);
    assert.equal(asked.length, 0, 'no model call');
    const c = (await app.db.one<any>(`SELECT c.id, ${WAITING_SQL} AS waiting FROM conversations c WHERE c.peer = $1`, [PHONE]))!;
    assert.equal(c.waiting, true, 'it waits for us');
    assert.equal((await alerts()).length, 1, 'their answer is told too');
    // Writing after it: the bot does not say its line again.
    const next = await write(PHONE, 'כן, מעניין');
    assert.doesNotMatch(next.reply!, /^כאן תורן/);

    // Someone we never wrote to: the plain line, then the same words; a file that is not a recording, its own.
    const other = await write(OTHER, '', { attachments: [{ name: 'contract.pdf', type: 'application/pdf', size: 10 }] });
    assert.equal(other.reply, `כאן תורן, הבוט של OpenFrequency.\n\n${NO_WORDS_HE.other}`);

    // A photo on our support is a screenshot or a question, never a product to search for.
    const photo = [{ id: 1, name: 'screen.png', type: 'image/png', size: 10 }];
    assert.doesNotMatch(filesContext(photo, [1], { company: true })!, /search_products|view_product_images/);
    assert.match(filesContext(photo, [1], { company: true })!, /someone from our team will look at it, and call handoff/);
    assert.match(filesContext(photo, [1])!, /search_products/, "a store's own channels still look for the product");
  } finally {
    setNow(null);
    await app.db.close();
  }
});

test('a demo that ends back into our support goes on as a store we wrote to, and knows they tried their Toran', async () => {
  const { app, asked, write, lead } = await supportApp();
  try {
    const id = await lead('nurit.example', PHONE, 'nurit-x1', 'כלי חרס של נורית');
    await app.db.query("UPDATE stores SET demo_code = 'DEMO-K7MQ' WHERE id = $1", [id]);
    assert.equal((await outreach.sendPitch(app, { product: 'toran', stage: 'first', phone: PHONE, name: 'כלי חרס של נורית', url: PAGE, ref: `store:${id}`, by: 'Demo' })).sent, true);
    // They press the page's button: the demo of their store, which is not our support answering.
    assert.equal((await write(PHONE, 'DEMO-K7MQ')).action, 'bound');
    assert.equal((await app.db.query("SELECT 1 FROM events WHERE kind = 'outreach_reply'")).length, 0, 'trying the demo is not answering us');
    // A week on, the demo is closed and their question is our support's: still a store we wrote to, that tried its Toran.
    await app.db.query("UPDATE wa_users SET expires_at = now() - interval '1 minute' WHERE phone = $1", [PHONE]);
    const r = await write(PHONE, 'איך מצטרפים?');
    assert.equal(r.action, 'demo_ended');
    assert.match(asked.at(-1)!, /LEAD \(the app's record/);
    assert.ok(asked.at(-1)!.includes(`${PAGE} (they have written to it already)`));
    assert.equal((await app.db.query("SELECT 1 FROM events WHERE kind = 'outreach_reply'")).length, 1, 'their first message to us marks the lead');
  } finally {
    setNow(null);
    await app.db.close();
  }
});
