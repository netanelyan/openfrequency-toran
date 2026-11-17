import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as outreach from '../src/ops/outreach.ts';
import { leadTurn, pitchFor, type LeadPitch } from '../src/ops/leadReply.ts';
import { leadOne } from '../src/ops/leadsAdmin.ts';
import { handleInbound } from '../src/channels/route.ts';
import { syncCompany, type CompanyExport } from '../src/company.ts';
import { LEAD_OPENING_NOTE, leadLine, openingOf } from '../src/agent/intro.ts';
import { BOT_NOTE, filesContext, LEAD_REPLIES_PER_HOUR, NO_WORDS_HE } from '../src/channels/store.ts';
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
async function supportApp(env: Record<string, string> = {}, custom?: Script) {
  const asked: string[] = [];
  const script: Script = custom || ((req) => {
    const res = lastToolResult(req);
    if (res) return [{ type: 'text', text: 'חבילת חנות עולה 590 ₪ לחודש, לא כולל מע״מ, עד 300 שיחות בחודש.' }];
    const said = lastText(req);
    asked.push(said);
    if (/כמה זה עולה/.test(said)) return [{ type: 'tool_use', id: 'p1', name: 'get_plans', input: {} }];
    const url = /Their store's own Toran[^:]*: (\S+)/.exec(said)?.[1];
    return [{ type: 'text', text: url ? `תורן כבר קרא את המוצרים והמדיניות מהאתר שלכם, ואפשר לכתוב לו עכשיו כמו לקוח: ${url}` : 'אפשר לשאול אותי על תורן ועל תדר.' }];
  });
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
    const line = 'היי, אני תורן, הבוט שבנינו לכלי חרס של נורית. ככה אענה גם ללקוחות שלכם.';
    assert.equal(r.reply, `${line}\n\nתורן כבר קרא את המוצרים והמדיניות מהאתר שלכם, ואפשר לכתוב לו עכשיו כמו לקוח: ${PAGE}`, 'the Toran we built for them, then the answer with its link kept');
    // What the model was told: the LEAD block, with our message as they got it and the link, and not to say the line.
    assert.match(asked[0], /LEAD \(the app's record, not the person's words\): they write from the store "כלי חרס של נורית" \(nurit\.example\), which we wrote to first/);
    assert.match(asked[0], /Our message to them, as they got it:\n"""\nהיי, כאן OpenFrequency\. בנינו לכלי חרס של נורית את תורן[^]*רוצים לנסות אותו כאן בצ׳אט/);
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
    assert.equal(leadLine({ product: 'both', name: 'הדס' }, 'תורן', 'OpenFrequency'), 'היי, אני תורן, הבוט שבנינו בשביל הדס. ככה אענה גם ללקוחות שלכם.');
    assert.equal(leadLine({ product: 'teder', name: 'פופי' }, 'תורן', 'OpenFrequency'), 'היי, אני תורן, הבוט של OpenFrequency. אפשר לשאול אותי על המצגת שתדר הכין לכם.');
    assert.match(leadLine({ product: 'toran', name: 'Nike' }, 'תורן', 'OpenFrequency', true), /^Hi, I'm תורן, the bot we built for Nike\. This is how I'll answer your customers too\.$/);
  } finally {
    setNow(null);
    await app.db.close();
  }
});

test('a number we never wrote to gets no LEAD block; a pitch eight days old is read in a new conversation, its pages found through its ref', async () => {
  const { app, asked, write } = await supportApp();
  try {
    const plain = await write(OTHER, 'מה זה תורן?');
    assert.equal(plain.reply, 'היי, אני תורן, הבוט של OpenFrequency.\n\nאפשר לשאול אותי על תורן ועל תדר.');
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
    assert.match(r.reply!, /^היי, אני תורן, הבוט שבנינו לפופי\. ככה אענה גם ללקוחות שלכם\./);
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
    assert.equal(voice.reply, `היי, אני תורן, הבוט שבנינו לכלי חרס של נורית. ככה אענה גם ללקוחות שלכם.\n\n${NO_WORDS_HE.voice}`);
    assert.equal(asked.length, 0, 'no model call');
    const c = (await app.db.one<any>(`SELECT c.id, ${WAITING_SQL} AS waiting FROM conversations c WHERE c.peer = $1`, [PHONE]))!;
    assert.equal(c.waiting, true, 'it waits for us');
    assert.equal((await alerts()).length, 1, 'their answer is told too');
    // Writing after it: the bot does not say its line again.
    const next = await write(PHONE, 'כן, מעניין');
    assert.doesNotMatch(next.reply!, /^כאן תורן/);

    // Someone we never wrote to: the plain line, then the same words; a file that is not a recording, its own.
    const other = await write(OTHER, '', { attachments: [{ name: 'contract.pdf', type: 'application/pdf', size: 10 }] });
    assert.equal(other.reply, `היי, אני תורן, הבוט של OpenFrequency.\n\n${NO_WORDS_HE.other}`);

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

// ---- a salesperson, not a spam messenger (the owner, 2026-11-17, on a store whose own AI bot and ours wrote to each
// other 17 times in four minutes, until a person there wrote "חאלס" and "מהר הסר": "make the bot smart, not a spam
// messanger"). Every store, text and number here is made up.

/** A store we only asked whether we may send an offer (stage ask): nothing is built for it. */
const askedStore = async (app: Awaited<ReturnType<typeof supportApp>>['app'], phone: string) =>
  (await app.db.one<{ id: number }>("INSERT INTO stores (domain, url, name, platform, source, slug, score, qualified, contact_whatsapp, status) VALUES ('dana-toys.example', 'https://dana-toys.example/', 'צעצועי עץ של דנה', 'shopify', 'seed', 'dana-x1', 60, true, $1, 'sent') RETURNING id", [phone]))!.id;
/** What went to one number: each message we sent it. */
const sentTo = (meta: ReturnType<typeof fakeMeta>, phone: string) => meta.calls.filter((c) => c.method === 'POST' && c.body?.to === phone);
/** Their store's own bot, in the shape it wrote in: long, fast, with WhatsApp's bold. */
const BOT_1 = 'נעים להכיר! אפשר לבדוק איתי כל דבר - לשאול על *זמני משלוח*, על *מוצרי עץ* או על הזמנה קיימת. במה אוכל לעזור?';
const BOT_2 = 'תודה! אני כאן כדי לתת שירות ללקוחות *צעצועי עץ של דנה* ולעזור בכל שאלה על המוצרים וההזמנות.';
const BOT_3 = 'הבנתי. התפקיד שלי הוא לעזור ללקוחות החנות עם המשחקים, ההזמנות והמשלוחים שלנו. במה אוכל לסייע כעת?';

test("their store's own bot answers our question: one answer of ours, then nothing to it; a person there is answered, and \"חאלס\" stops us for good", async () => {
  const { app, meta, asked, write } = await supportApp();
  try {
    const id = await askedStore(app, PHONE);
    assert.equal((await outreach.sendPitch(app, { product: 'toran', stage: 'ask', phone: PHONE, name: 'צעצועי עץ של דנה', url: '', ref: `store:${id}`, by: 'autopilot' })).sent, true);
    const conv = (await app.db.one<{ id: number }>('SELECT id FROM conversations WHERE peer = $1', [PHONE]))!.id;

    // Their bot's greeting is short: answered once, as our company's bot, with nothing claimed as built.
    const hi = await write(PHONE, 'היי, כאן דנה מהחנות');
    assert.equal(hi.action, 'answered');
    assert.match(hi.reply!, /^היי, אני תורן, הבוט של OpenFrequency\.\n\n/, 'not "the bot we built for them": nothing is built');
    assert.match(asked[0], /they have not said yes\. Nothing is built for them yet and nothing was sent: never say we built or sent anything/);
    assert.doesNotMatch(asked[0], /Their store's own Toran/);

    // Its next message, 8 seconds after ours, long and in bold: a bot. Kept, nothing sent, one note for us.
    const one = await write(PHONE, BOT_1, { at: Date.now() + 8_000 });
    assert.equal(one.action, 'bot');
    // A slower one of it, in its own words about itself: still the bot. No second note.
    assert.equal((await write(PHONE, BOT_2, { at: Date.now() + 16_000 })).action, 'bot');
    const notes = await app.db.query<{ text: string; reason: string }>("SELECT text, handoff->>'reason' AS reason FROM messages WHERE conversation_id = $1 AND handoff IS NOT NULL", [conv]);
    assert.deepEqual(notes.map((n) => ({ ...n })), [{ text: BOT_NOTE, reason: 'bot' }]);
    assert.ok((await app.db.one<any>('SELECT meta FROM conversations WHERE id = $1', [conv]))!.meta.bot);
    assert.equal(asked.length, 1, 'no model call for a bot');
    // Their bot's messages are not their answer: the lead was marked once, by the greeting, and never again.
    assert.equal((await app.db.query("SELECT 1 FROM events WHERE kind = 'outreach_reply'")).length, 1);

    // A person there, two minutes on: answered as before, and their bot's answer to it is not.
    const person = await write(PHONE, 'רגע, כמה זה עולה?', { at: Date.now() + 120_000 });
    assert.equal(person.action, 'answered');
    assert.equal((await write(PHONE, BOT_3, { at: Date.now() + 7_000 })).action, 'bot');

    // "חאלס": removed, said once, and kept where the inbox shows it; "מהר הסר" after it gets nothing.
    const enough = await write(PHONE, 'חאלס');
    assert.deepEqual([enough.action, enough.reply], ['outreach_stop', outreach.STOPPED_SAID]);
    assert.ok(await app.db.one('SELECT 1 FROM outreach_stops WHERE phone = $1', [PHONE]));
    assert.deepEqual({ ...(await app.db.one<any>('SELECT lost_reason FROM stores WHERE id = $1', [id])) }, { lost_reason: 'opted_out' });
    assert.equal((await write(PHONE, 'מהר הסר')).action, 'outreach_stop_again');
    const tail = await app.db.query<{ role: string; text: string }>("SELECT role, text FROM messages WHERE conversation_id = $1 AND role IN ('customer', 'agent') ORDER BY id DESC LIMIT 3", [conv]);
    assert.deepEqual(tail.map((m) => [m.role, m.text]), [['customer', 'מהר הסר'], ['agent', outreach.STOPPED_SAID], ['customer', 'חאלס']]);
    // Anything else in the day after it waits for us, and nothing goes.
    assert.equal((await write(PHONE, BOT_2, { at: Date.now() + 9_000 })).action, 'held');

    // In all: our question, one answer to their bot, one to the person, and the line that removed them.
    assert.equal(sentTo(meta, PHONE).length, 4);
  } finally {
    setNow(null);
    await app.db.close();
  }
});

test('a thanks or a thumbs-up after our answer gets no answer, and a store we wrote to gets at most six answers an hour', async () => {
  const { app, meta, write, lead } = await supportApp();
  try {
    const id = await lead('nurit.example', PHONE, 'nurit-x1', 'כלי חרס של נורית');
    assert.equal((await outreach.sendPitch(app, { product: 'toran', stage: 'first', phone: PHONE, name: 'כלי חרס של נורית', url: PAGE, ref: `store:${id}`, by: 'Demo' })).sent, true);
    assert.equal((await write(PHONE, 'כן, מעניין')).action, 'answered');
    for (const t of ['👍', 'תודה!', 'Ghh', 'חחחח']) assert.equal((await write(PHONE, t)).action, 'quiet', t);
    assert.equal(sentTo(meta, PHONE).length, 2, 'the pitch and one answer');
    for (let i = 2; i <= LEAD_REPLIES_PER_HOUR; i++) assert.equal((await write(PHONE, `שאלה מספר ${i}`)).action, 'answered');
    const past = await write(PHONE, 'ועוד שאלה');
    assert.equal(past.action, 'limit');
    assert.equal(sentTo(meta, PHONE).length, 1 + LEAD_REPLIES_PER_HOUR);
    assert.ok(await app.db.one("SELECT 1 FROM messages WHERE handoff->>'reason' = 'limit' AND text LIKE 'תורן ענה כאן 6 פעמים%'"), 'a person goes on, and is told');
  } finally {
    setNow(null);
    await app.db.close();
  }
});

test('the model that sees a bot says so and nothing goes to it; asked to stop in other words, it stops us all the same', async () => {
  const script: Script = (req) => {
    if (lastToolResult(req)) return [{ type: 'text', text: 'בסדר, לא נכתוב לכם שוב. סליחה על ההפרעה.' }];
    // The turn's last message holds the earlier ones of theirs too: the newest words are read first.
    const t = lastText(req);
    if (/עזבו אותנו בשקט/.test(t)) return [{ type: 'tool_use', id: 'h2', name: 'handoff', input: { reason: 'stop', summary: 'ביקשו שנפסיק לכתוב להם' } }];
    if (/העוזרת הדיגיטלית/.test(t)) return [{ type: 'tool_use', id: 'h1', name: 'handoff', input: { reason: 'bot', summary: 'עונה כאן הבוט של החנות' } }];
    return [{ type: 'text', text: 'אפשר לשאול אותי על תורן ועל תדר.' }];
  };
  const { app, meta, write } = await supportApp({}, script);
  try {
    const id = await askedStore(app, PHONE);
    assert.equal((await outreach.sendPitch(app, { product: 'toran', stage: 'ask', phone: PHONE, name: 'צעצועי עץ של דנה', url: '', ref: `store:${id}`, by: 'autopilot' })).sent, true);
    const conv = (await app.db.one<{ id: number }>('SELECT id FROM conversations WHERE peer = $1', [PHONE]))!.id;
    const r = await write(PHONE, 'שלום! כאן העוזרת הדיגיטלית של החנות, אשמח לדעת מה שמך');
    assert.equal(r.action, 'bot');
    assert.equal(sentTo(meta, PHONE).length, 1, 'only our question went');
    const kept = (await app.db.one<any>("SELECT role, text FROM messages WHERE conversation_id = $1 AND handoff->>'reason' = 'bot'", [conv]))!;
    assert.deepEqual([kept.role, kept.text], ['system', BOT_NOTE], 'its answer kept as our note, never as sent');
    assert.ok((await app.db.one<any>('SELECT meta FROM conversations WHERE id = $1', [conv]))!.meta.bot);
    assert.equal((await app.db.query("SELECT 1 FROM events WHERE kind = 'outreach_reply'")).length, 0, 'a bot is not their answer');

    // A person there, in words the way out does not read: the model hears it, and it is a stop.
    const stop = await write(PHONE, 'תעשו לי טובה, עזבו אותנו בשקט עם ההצעות שלכם');
    assert.deepEqual([stop.action, stop.reply], ['answered', outreach.STOPPED_SAID]);
    assert.ok(await app.db.one('SELECT 1 FROM outreach_stops WHERE phone = $1', [PHONE]));
    assert.equal(sentTo(meta, PHONE).at(-1)!.body.text.body, outreach.STOPPED_SAID);
  } finally {
    setNow(null);
    await app.db.close();
  }
});

test("the question's LEAD block says what its yes brought so far, and the bot's own line comes only with what was sent", () => {
  const base: LeadPitch = { eventId: 1, phone: PHONE, product: 'toran', stage: 'ask', at: '2026-11-17T07:32:19.000Z', name: 'צעצועי עץ של דנה', domain: 'dana-toys.example', storeId: 1, tederId: null, toranUrl: null, tederUrl: null, text: null, tried: false, replied: true, yes: false, deliver: null };
  const before = leadTurn(base);
  assert.match(before.context, /they have not said yes\. Nothing is built for them yet/, 'an answer of theirs is not a yes');
  assert.equal(before.lead, null);
  const building = leadTurn({ ...base, yes: true, deliver: 'pending' });
  assert.match(building.context, /they said yes, and we are building Toran, built on their store now\. We told them it comes into this chat within about an hour; nothing of it was sent yet/);
  assert.equal(building.lead, null);
  assert.match(leadTurn({ ...base, yes: true, deliver: 'failed' }).context, /we could not build Toran, built on their store this time/);
  const sent = leadTurn({ ...base, yes: true, deliver: 'sent', toranUrl: PAGE });
  assert.match(sent.context, /they said yes, and we built them Toran, built on their store and sent it into this chat/);
  assert.deepEqual(sent.lead, { product: 'toran', name: 'צעצועי עץ של דנה' });
  // A pitch with its link, whose page was taken down since: no line about what we built.
  assert.equal(leadTurn({ ...base, stage: 'first', toranUrl: null }).lead, null);
});
