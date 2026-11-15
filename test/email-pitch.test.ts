import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { App } from '../src/app.ts';
import { discover } from '../src/leads/discover.ts';
import { ingestStore } from '../src/ingest/pack.ts';
import { buildPitch } from '../src/pitch/build.ts';
import { setOffer } from '../src/offer.ts';
import { simEmail } from '../src/channels/email.ts';
import { handleInbound } from '../src/channels/route.ts';
import { accountFor } from '../src/channels/store.ts';
import { setNow } from '../src/core/clock.ts';
import * as mail from '../src/ops/emailPitch.ts';
import { sendNow } from '../src/ops/actions.ts';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/core/paths.ts';
import { testApp } from './helpers.ts';

// Pitches by email (the owner, 2026-11-15: "19 messages, 0 replies. redo that part. from start until the end"): a lead
// with no WhatsApp, or only a landline, gets one email from our company store's address asking whether it wants what we
// built; "כן" gets the link, "הסר" stops it, and a WhatsApp pitch Meta could not deliver goes by email instead. Mail is
// the simulator and Meta is not asked: nothing leaves this machine. Stores and addresses are fictional.

const DOMAIN = 'in.toran.test';
const LEAD = 'nurit@kli-cheres.example';
const OURS = `support@${DOMAIN}`;
/** A Tuesday, 12:00 in Israel: never quiet. */
const NOON = Date.parse('2026-11-10T10:00:00.000Z');
/** Shabbat, 12:00 in Israel. */
const SHABBAT = Date.parse('2026-11-14T10:00:00.000Z');
let seq = 0;

/** Our company store, and the fictional store as a lead with its page public, an address, and no WhatsApp. */
async function mailApp(env: Record<string, string> = {}) {
  const app = await testApp();
  Object.assign(app.env, { TORAN_CHANNELS: 'whatsapp,email', TORAN_SIGNUP_OPEN: '1', DEMO_WA_NUMBER: '972500000999', TORAN_OWNER_WHATSAPP: '972500000999', PUBLIC_BASE_URL: 'https://toran.example', TORAN_SUPPORT_STORE: 'openfrequency.example', TORAN_ALERT_CMD: 'off' }, env);
  app.mail = simEmail({ domain: DOMAIN });
  const logs: string[] = [];
  app.log = (m: string) => void logs.push(m);
  await setOffer(app.db, { monthly: 199, vat: 'excluded', setup: 0, city: 'אשדוד' });
  const company = (await app.db.one<{ id: number }>("INSERT INTO stores (domain, url, name, platform, status, source, slug) VALUES ('openfrequency.example', 'https://openfrequency.example/', 'OpenFrequency', 'company', 'company', 'manual', 'support') RETURNING id"))!.id;
  await discover(app.db, (async function* () { yield { url: 'https://kli-cheres.example/', source: 'seed', detail: {} }; })(), { fetcher: app.fetcher, limit: 1 });
  const storeId = (await app.db.one<{ id: number }>("SELECT id FROM stores WHERE domain = 'kli-cheres.example'"))!.id;
  await ingestStore(app, storeId);
  await buildPitch(app, storeId);
  await app.db.query('UPDATE stores SET contact_email = $2, contact_whatsapp = NULL WHERE id = $1', [storeId, LEAD.toUpperCase()]);
  assert.ok((await app.db.one<any>('SELECT approved_at FROM stores WHERE id = $1', [storeId])).approved_at, 'the page is public');
  setNow(NOON);
  return { app, storeId, company, logs, outbox: app.mail.outbox! };
}

/** Another lead, the fictional store's twin under another domain, with the same page settings. */
async function another(app: App, from: number, domain: string, email: string) {
  const id = (await app.db.one<{ id: number }>(
    `INSERT INTO stores (domain, url, name, platform, source, slug, status, qualified, score, brand, contact_email, approved_at, page_built_at)
     SELECT $2, 'https://' || $2 || '/', name || ' 2', platform, source, replace($2, '.', '-'), status, qualified, score, brand, $3, approved_at, page_built_at FROM stores WHERE id = $1 RETURNING id`,
    [from, domain, email || null],
  ))!.id;
  await app.db.query('INSERT INTO products (store_id, ext_id, handle, title, url, currency, price_min, price_max, available, variants, body_text, search_text, scraped_at) SELECT $2, ext_id, handle, title, url, currency, price_min, price_max, available, variants, body_text, search_text, scraped_at FROM products WHERE store_id = $1', [from, id]);
  await app.db.query('INSERT INTO pitches (store_id, sample_chat) SELECT $2, sample_chat FROM pitches WHERE store_id = $1', [from, id]);
  return id;
}

/** An email to our company store's address, as Resend's webhook would give it once fetched. */
const answer = (app: App, text: string, o: Partial<{ from: string; subject: string }> = {}) =>
  handleInbound(app, app.mail!.parse({ raw: JSON.stringify({ from: `Nurit <${o.from || LEAD}>`, to: [OURS], subject: o.subject ?? 'Re: עוזר וואטסאפ לכלי חרס של נורית', text, message_id: `<a${seq++}@kli-cheres.example>` }), form: {}, headers: {}, url: '' })![0]);

const pitch = (storeId: number, o: Partial<mail.MailPitch> = {}): mail.MailPitch => ({ storeId, product: 'toran', stage: 'first', by: 'Demo', why: 'no_whatsapp', ...o });
const mails = (app: App) => app.db.query<{ id: number; store_id: number; data: any }>("SELECT id, store_id, data FROM events WHERE kind = 'outreach_mail' ORDER BY id");

test('the first email goes once, from our company store, asking whether they want it; a second press is refused', async () => {
  const { app, storeId, company, outbox, logs } = await mailApp();
  try {
    const out = await mail.emailPitch(app, pitch(storeId));
    assert.deepEqual(out, { sent: true, why: null, said: `נשלח במייל ל־${LEAD}.` });
    assert.equal(outbox.length, 1);
    const m = outbox[0] as any;
    assert.equal(m.to, LEAD, 'to the address, lower-cased');
    assert.equal(m.from, `"OpenFrequency" <${OURS}>`, 'from our company store, named OpenFrequency');
    assert.equal(m.replyTo, OURS, 'the answer comes back to us');
    assert.equal(m.subject, 'עוזר וואטסאפ לכלי חרס של נורית');
    assert.equal(m.headers['List-Unsubscribe'], `<mailto:${OURS}?subject=${encodeURIComponent('הסר')}>`);
    assert.equal(m.headers['Auto-Submitted'], undefined, 'a person may answer it');
    assert.equal(m.text, 'שלום,\n\nכאן OpenFrequency. בנינו לכלי חרס של נורית את תורן, עוזר שעונה ללקוחות שלכם בוואטסאפ, באינסטגרם ובצ׳אט באתר לפי המוצרים, המחירים והמלאי שבאתר שלכם. מה שהוא לא יודע עובר אליכם.\n\nהוא כבר מכיר את החנות. רוצים לנסות אותו? אפשר לענות "כן" למייל הזה ונשלח לכם קישור.\n\nלא רלוונטי? עונים "הסר" ולא נכתוב שוב.\n\nOpenFrequency\nopenfrequency.co.il');
    assert.doesNotMatch(m.text, /https?:\/\//, 'the first one asks; the link goes after "כן"');
    // Our company store had no email address: it got one, so the answer routes to it.
    const account = await accountFor(app, 'email', OURS);
    assert.equal(account?.store_id, company);
    const [e] = await mails(app);
    assert.equal(e.store_id, storeId);
    assert.deepEqual(
      { product: e.data.product, stage: e.data.stage, email: e.data.email, ref: e.data.ref, by: e.data.by, why: e.data.why, day: e.data.day, state: e.data.state, subject: e.data.subject },
      { product: 'toran', stage: 'first', email: LEAD, ref: `store:${storeId}`, by: 'Demo', why: 'no_whatsapp', day: '2026-11-10', state: 'sent', subject: m.subject },
    );
    assert.match(e.data.toran_url, /^https:\/\/toran\.example\/s\//);
    // Kept in our inbox, in a thread of its own.
    const kept = (await app.db.one<any>("SELECT c.peer, c.store_id, c.meta, m.role, m.auto, m.text FROM conversations c JOIN messages m ON m.conversation_id = c.id WHERE c.id = $1", [e.data.kept]))!;
    assert.deepEqual([kept.peer, kept.store_id, kept.role, kept.auto, kept.meta.bare, kept.text], [LEAD, company, 'owner', 'outreach', m.subject, m.text]);
    // Again, and the same product inside both, at the same stage: once.
    assert.equal((await mail.emailPitch(app, pitch(storeId))).why, 'already');
    assert.equal((await mail.emailPitch(app, pitch(storeId, { product: 'both', tederUrl: 'https://teder.example/s/nurit-a1' }))).why, 'already');
    assert.equal(outbox.length, 1);
    // The reminder is its own, in the first one's thread, the last one.
    const r = await mail.emailPitch(app, pitch(storeId, { stage: 'reminder' }));
    assert.equal(r.sent, true);
    assert.equal((outbox[1] as any).subject, 'Re: עוזר וואטסאפ לכלי חרס של נורית');
    assert.equal(outbox[1].text, 'שלום שוב,\n\nתורן שבנינו לכלי חרס של נורית עדיין מחכה. אם תענו "כן" נשלח לכם קישור.\n\nזו ההודעה האחרונה שלנו בנושא. לא רלוונטי? עונים "הסר".\n\nOpenFrequency\nopenfrequency.co.il');
    assert.equal((await app.db.query('SELECT 1 FROM messages WHERE conversation_id = $1', [e.data.kept])).length, 2, 'the reminder in the same thread');
    assert.ok(logs.some((l) => l.includes('n…@kli-cheres.example')) && !logs.some((l) => l.includes(LEAD)), 'an address in the log is its first letter and its domain');
    // A store with no address, or one on our own domain: nothing.
    await app.db.query('UPDATE stores SET contact_email = NULL WHERE id = $1', [storeId]);
    assert.equal((await mail.emailPitch(app, pitch(storeId, { product: 'teder', tederUrl: 'https://teder.example/s/x' }))).why, 'no_email');
    await app.db.query('UPDATE stores SET contact_email = $2 WHERE id = $1', [storeId, `x@${DOMAIN}`]);
    assert.equal((await mail.emailPitch(app, pitch(storeId, { product: 'teder', tederUrl: 'https://teder.example/s/x' }))).why, 'bad_email');
  } finally {
    setNow(null);
    await app.db.close();
  }
});

test('the words: Teder\'s and both\'s first emails, and the subjects with the store\'s "ל"', () => {
  assert.equal(mail.mailPitchText('teder', 'first', 'הדס עיצובים'), 'שלום,\n\nכאן OpenFrequency. הכנו בשביל הדס עיצובים מצגת לטיקטוק ולאינסטגרם על נושא מהתחום שלכם, בעיצוב של החנות. תדר מכין מצגות כאלה כמה פעמים בשבוע, וכל אחת עולה רק אחרי שאישרתם אותה.\n\nרוצים לראות אותה? אפשר לענות "כן" למייל הזה ונשלח לכם קישור.\n\nלא רלוונטי? עונים "הסר" ולא נכתוב שוב.\n\nOpenFrequency\nopenfrequency.co.il');
  assert.match(mail.mailPitchText('both', 'first', 'Nike'), /^שלום,\n\nכאן OpenFrequency\. הכנו ל־Nike שני דברים לנסות: את תורן, [^]*נשלח לכם קישורים\.\n\nלא רלוונטי\?/);
  assert.match(mail.mailPitchText('both', 'reminder', 'Nike'), /^שלום שוב,\n\nתורן והמצגת שהכנו ל־Nike עדיין מחכים\. אם תענו "כן" נשלח לכם קישורים\./);
  assert.equal(mail.mailPitchSubject('teder', 'Nike'), 'מצגת לטיקטוק ל־Nike');
  assert.equal(mail.mailPitchSubject('both', 'כלי חרס'), 'עוזר וואטסאפ ומצגת לטיקטוק לכלי חרס');
  for (const p of ['toran', 'teder', 'both'] as const) for (const s of ['first', 'reminder'] as const) assert.doesNotMatch(mail.mailPitchText(p, s, 'x'), /[–—!]/, 'no dashes, no exclamation marks');
  // How an answer is read: the whole message, a greeting and a name around it, or the subject alone.
  for (const t of ['הסר', 'הסירו אותי', 'לא, תודה', 'לא מעוניינת', 'לא רלוונטי.', 'unsubscribe', 'STOP', 'no', 'היי,\nלא תודה\nדני']) assert.equal(mail.mailWord(t), 'stop', t);
  for (const t of ['כן', 'כן תשלחו', 'בטח!', 'אשמח לראות', 'yes please', 'OK', 'סבבה', 'יאללה', 'שלום\n\nכן, בבקשה\nנורית']) assert.equal(mail.mailWord(t), 'yes', t);
  for (const t of ['כן, אבל כמה זה עולה?', 'לא הבנתי מה זה', 'מה המחיר?', 'כן\nואיך זה עובד עם שופיפיי?', 'לא כן']) assert.equal(mail.mailWord(t), null, t);
  assert.equal(mail.mailWord('', 'הסר'), 'stop', "List-Unsubscribe's mail: the subject alone");
  assert.equal(mail.mailWord('> כן\n> quoted', 'Re: x'), null, 'the quote is not their answer');
});

test('"הסר" to the email stops it: the address kept, said once, its leads lost in both products, no email or WhatsApp pitch again', async () => {
  const { app, storeId, outbox } = await mailApp();
  try {
    await app.db.query("UPDATE stores SET contact_whatsapp = '97230000555' WHERE id = $1", [storeId]);
    await app.db.query("INSERT INTO teder_leads (id, domain, status) VALUES ('d-1', 'kli-cheres.example', 'approved')");
    assert.equal((await mail.emailPitch(app, pitch(storeId, { why: 'no_mobile' }))).sent, true);
    const r = await answer(app, 'הסר\n\nבתאריך יום ג׳, 10 בנוב׳ 2026, 12:00, OpenFrequency כתב/ה:\n> שלום,');
    assert.deepEqual([r.action, r.reply], ['outreach_stop', mail.MAIL_STOPPED_SAID]);
    const back = outbox.at(-1) as any;
    assert.deepEqual([back.to, back.text, back.subject], [LEAD, 'הסרנו אתכם, ולא נשלח לכם יותר מיילים כאלה. סליחה על ההפרעה.', 'Re: עוזר וואטסאפ לכלי חרס של נורית']);
    assert.ok(await app.db.one('SELECT 1 FROM outreach_mail_stops WHERE email = $1', [LEAD]));
    assert.deepEqual({ ...(await app.db.one('SELECT lost_reason FROM stores WHERE id = $1', [storeId])) }, { lost_reason: 'opted_out' });
    assert.deepEqual({ ...(await app.db.one("SELECT lost_reason FROM teder_leads WHERE id = 'd-1'")) }, { lost_reason: 'opted_out' });
    assert.ok(await app.db.one("SELECT 1 FROM outreach_stops WHERE phone = '97230000555'"), 'its WhatsApp too: they asked us to stop writing');
    // In our inbox, their word and our line, in the pitch's thread.
    const kept = (await mails(app))[0].data.kept;
    assert.deepEqual((await app.db.query<any>('SELECT role, text FROM messages WHERE conversation_id = $1 ORDER BY id', [kept])).map((m) => m.role), ['owner', 'customer', 'agent']);
    // Said again: nothing back.
    const n = outbox.length;
    assert.equal((await answer(app, 'הסר')).action, 'outreach_stop_again');
    assert.equal(outbox.length, n);
    // Nothing more, even once the lead is opened again by hand.
    await app.db.query('UPDATE stores SET lost_at = NULL, lost_reason = NULL WHERE id = $1', [storeId]);
    assert.equal((await mail.emailPitch(app, pitch(storeId, { stage: 'reminder' }))).why, 'stopped');
    const kept2 = JSON.stringify(await app.db.query("SELECT data FROM events WHERE kind = 'outreach_mail_stop'"));
    assert.ok(!kept2.includes(LEAD), 'the event keeps the masked address');
    // Someone we never emailed: "הסר" is our support's (auto/consent.ts), not ours.
    assert.notEqual((await answer(app, 'הסר', { from: 'dana@example.test' })).action, 'outreach_stop');
  } finally {
    setNow(null);
    await app.db.close();
  }
});

test('"כן" sends the links, marks the lead answered and tells the operator once; anything else goes to our support', async () => {
  const { app, storeId, outbox } = await mailApp();
  try {
    await app.db.query("INSERT INTO teder_leads (id, domain, status, page_url) VALUES ('d-2', 'kli-cheres.example', 'approved', 'https://teder.example/s/nurit-a1b2')");
    assert.equal((await mail.emailPitch(app, pitch(storeId, { product: 'both' }))).sent, true);
    assert.equal((outbox[0] as any).subject, 'עוזר וואטסאפ ומצגת לטיקטוק לכלי חרס של נורית');
    const r = await answer(app, 'היי,\nכן, תשלחו\nנורית', { subject: 'Re: עוזר וואטסאפ ומצגת לטיקטוק לכלי חרס של נורית' });
    assert.equal(r.action, 'answered');
    const toran = (await mails(app))[0].data.toran_url;
    assert.equal(outbox.at(-1)!.text, `מעולה. זה תורן של כלי חרס של נורית: ${toran}\nבעמוד יש כפתור שפותח איתו שיחה בוואטסאפ. כותבים לו כמו לקוח, למשל שאלה על מוצר או על משלוח, ורואים איך הוא עונה.\n\nוזו המצגת שתדר הכין לכלי חרס של נורית: https://teder.example/s/nurit-a1b2\n\nאם משהו לא מדויק, או שרוצים לראות איך תדר עובד אצלכם כל שבוע, אפשר לענות כאן.`);
    const e = (await mails(app))[0];
    assert.ok(e.data.yes && e.data.answered === 'yes', 'the event says yes');
    assert.ok((await app.db.one<any>('SELECT replied_at FROM stores WHERE id = $1', [storeId])).replied_at, 'the lead answered');
    assert.ok((await app.db.one<any>("SELECT replied_at FROM teder_leads WHERE id = 'd-2'")).replied_at, "and Teder's");
    const alerts = await app.db.query<any>("SELECT data FROM events WHERE kind = 'operator_alert' AND data->>'key' = $1", [`lead_mail_yes:${e.id}`]);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].data.title, 'כלי חרס של נורית ביקשו את הקישור במייל');
    // "כן" again: the links again, the operator not again.
    await answer(app, 'כן');
    assert.match(outbox.at(-1)!.text, /^מעולה\./);
    assert.equal((await app.db.query("SELECT 1 FROM events WHERE kind = 'operator_alert' AND data->>'key' LIKE 'lead_mail_yes:%'")).length, 1);
    // A question: ours to mark and tell once, our support's to answer (mailPitchReply leaves it, route.ts goes on).
    const q = app.mail!.parse({ raw: JSON.stringify({ from: `Nurit <${LEAD}>`, to: [OURS], subject: 'Re: עוזר וואטסאפ ומצגת לטיקטוק לכלי חרס של נורית', text: 'כמה זה עולה בחודש?', message_id: '<q1@kli-cheres.example>' }), form: {}, headers: {}, url: '' })![0];
    assert.equal(await mail.mailPitchReply(app, app.mail!, q, (await accountFor(app, 'email', OURS))!), null);
    assert.ok((await mails(app))[0].data.replied, 'marked answered');
    const told = await app.db.query<any>("SELECT data FROM events WHERE kind = 'operator_alert' AND data->>'key' = $1", [`lead_mail_reply:${e.id}`]);
    assert.deepEqual(told.map((t) => t.data.title), ['כלי חרס של נורית ענו למייל שלנו']);
    assert.equal(await mail.mailPitchReply(app, app.mail!, { ...q, id: '<q2@kli-cheres.example>' }, (await accountFor(app, 'email', OURS))!), null);
    assert.equal((await app.db.query("SELECT 1 FROM events WHERE kind = 'operator_alert' AND data->>'key' LIKE 'lead_mail_reply:%'")).length, 1, 'once');
    // Our support is told it is a store we emailed, and what we sent (without it, a store that answered was asked what
    // it was talking about, 2026-11-15).
    const turn = await mail.mailLeadTurn(app, q, (await accountFor(app, 'email', OURS))!);
    assert.match(turn!.context, /LEAD \(the app's record, not the person's words\): they write from the store "כלי חרס של נורית"/);
    assert.ok(turn!.context.includes('אפשר לענות "כן" למייל הזה'), 'our email, as they got it');
    // Through the router our support answers it, in the pitch's thread, with the pitch in view.
    const before = outbox.length;
    const asked = await answer(app, 'כמה זה עולה?', { subject: 'Re: עוזר וואטסאפ ומצגת לטיקטוק לכלי חרס של נורית' });
    assert.equal(asked.action, 'answered');
    assert.equal(outbox.length, before + 1);
    assert.doesNotMatch(outbox.at(-1)!.text, /^מעולה\./, "our support's answer, not the links");
    assert.ok(await app.db.one("SELECT 1 FROM messages WHERE conversation_id = $1 AND role = 'customer' AND text = 'כמה זה עולה?'", [e.data.kept]), "in the pitch's thread");
    // An out-of-office is no answer.
    const away = app.mail!.parse({ raw: JSON.stringify({ from: LEAD, to: [OURS], subject: 'Out of office', text: 'כן', headers: { 'Auto-Submitted': 'auto-replied' }, message_id: '<o1@kli-cheres.example>' }), form: {}, headers: {}, url: '' })![0];
    assert.equal(await mail.mailPitchReply(app, app.mail!, away, (await accountFor(app, 'email', OURS))!), null);
    // A reminder after they answered: refused.
    assert.equal((await mail.emailPitch(app, pitch(storeId, { product: 'both', stage: 'reminder', tederUrl: 'https://teder.example/s/nurit-a1b2' }))).why, 'replied');
  } finally {
    setNow(null);
    await app.db.close();
  }
});

test('the quiet hours hold an email and record nothing; the day\'s cap holds the rest', async () => {
  const { app, storeId, outbox } = await mailApp({ TORAN_OUTREACH_MAIL_DAILY: '1' });
  try {
    assert.equal(mail.mailDailyCap({}), 20, 'twenty a day unless set');
    assert.equal(mail.mailDailyCap({ TORAN_OUTREACH_MAIL_DAILY: '0' }), 0);
    setNow(SHABBAT);
    assert.deepEqual(await mail.emailPitch(app, pitch(storeId)), { sent: false, why: 'quiet', said: mail.MAIL_SAID_HE.quiet });
    setNow(Date.parse('2026-11-11T21:30:00.000Z'));
    assert.equal((await mail.emailPitch(app, pitch(storeId))).why, 'quiet', 'at night');
    assert.equal((await mails(app)).length, 0, 'nothing recorded');
    assert.equal(outbox.length, 0);
    setNow(NOON);
    assert.equal((await mail.emailPitch(app, pitch(storeId))).sent, true, 'after it, it goes');
    const other = await another(app, storeId, 'kli-cheres-2.example', 'shop@kli-cheres-2.example');
    assert.equal((await mail.emailPitch(app, pitch(other))).why, 'cap', 'the second today: held');
    setNow(NOON + 24 * 3_600_000);
    assert.equal((await mail.emailPitch(app, pitch(other))).sent, true, 'the next day it goes');
    // Toran not on sale: an email about Toran is refused, Teder's alone is not.
    app.env.TORAN_SIGNUP_OPEN = '';
    assert.equal((await mail.emailPitch(app, pitch(other, { stage: 'reminder' }))).why, 'not_on_sale');
  } finally {
    setNow(null);
    await app.db.close();
  }
});

test('a WhatsApp pitch Meta could not deliver goes by email instead, once; a lead with a landline goes by email from "send now"', async () => {
  const { app, storeId, outbox } = await mailApp();
  try {
    // Meta took it and then said 131026: the email in its place, once.
    await app.db.query("INSERT INTO events (store_id, kind, data) VALUES (NULL, 'outreach_wa', $1::jsonb)", [JSON.stringify({ product: 'toran', stage: 'first', phone: '972500000777', ref: `store:${storeId}`, by: 'Demo', state: 'undelivered', error: '131026: Message undeliverable', url: 'https://toran.example/s/x' })]);
    setNow(SHABBAT);
    assert.equal(await mail.emailFallbackDue(app), 0, 'not on Shabbat');
    setNow(NOON);
    assert.equal(await mail.emailFallbackDue(app), 1);
    assert.equal(outbox.length, 1);
    assert.equal((await mails(app))[0].data.why, 'undelivered');
    assert.equal(await mail.emailFallbackDue(app), 0, 'once');
    assert.equal((await app.db.one<any>("SELECT data->>'mailed' AS m FROM events WHERE kind = 'outreach_wa'")).m, 'sent');
    // One delivered (still "sent") is left alone, and so is a lead with no address.
    const other = await another(app, storeId, 'kli-cheres-2.example', '');
    await app.db.query("INSERT INTO events (store_id, kind, data) VALUES (NULL, 'outreach_wa', $1::jsonb), (NULL, 'outreach_wa', $2::jsonb)", [JSON.stringify({ product: 'toran', stage: 'reminder', ref: `store:${storeId}`, state: 'sent' }), JSON.stringify({ product: 'toran', stage: 'first', ref: `store:${other}`, state: 'undelivered' })]);
    assert.equal(await mail.emailFallbackDue(app), 0);
    assert.equal(outbox.length, 1);

    // "send now" on a lead whose site gives only a landline, with an address: by email, marked sent as WhatsApp marks it.
    const land = await another(app, storeId, 'kli-cheres-3.example', 'hello@kli-cheres-3.example');
    await app.db.query("UPDATE stores SET contact_whatsapp = '97230000555' WHERE id = $1", [land]);
    assert.equal(await mail.mailInsteadOf(app, '97230000555', 'hello@kli-cheres-3.example'), 'no_mobile');
    assert.equal(await mail.mailInsteadOf(app, '972500000778', 'hello@kli-cheres-3.example'), null, 'a mobile: WhatsApp');
    assert.equal(await mail.mailInsteadOf(app, null, 'hello@kli-cheres-3.example'), 'no_whatsapp');
    assert.equal(await mail.mailInsteadOf(app, '97230000555', null), null, 'no address: WhatsApp, as before');
    const said = await sendNow(app, 'toran', String(land), 'Demo');
    assert.equal(said, 'נשלח במייל ל־hello@kli-cheres-3.example.');
    assert.equal(outbox.at(-1)!.to, 'hello@kli-cheres-3.example');
    const row = (await app.db.one<any>('SELECT sent_at, followup_due_at, status FROM stores WHERE id = $1', [land]))!;
    assert.ok(row.sent_at && row.followup_due_at, 'marked sent, its one reminder due');
    assert.equal((await app.db.query("SELECT 1 FROM events WHERE kind = 'outreach_wa' AND data->>'ref' = $1", [`toran:${land}`])).length, 0, 'nothing went to WhatsApp');
    assert.ok(await app.db.one("SELECT 1 FROM audit WHERE action = 'ops_direct' AND detail->>'via' = 'email'"));
  } finally {
    setNow(null);
    await app.db.close();
  }
});

// Read in the code, as test/rules.test.ts reads the WhatsApp pitch: the one send, after every limit.
test('the email pitch has one send, and every limit is read before it', () => {
  const code = readFileSync(path.join(ROOT, 'src', 'ops', 'emailPitch.ts'), 'utf8');
  assert.equal((code.match(/\.send\(/g) || []).length, 1);
  const at = code.indexOf('app.mail!.send(');
  for (const rule of ['outreach_mail_stops WHERE email', 'outreach_stops WHERE phone', 'mail_suppressed WHERE address', 'SELECT 1 FROM events WHERE ${SAME}', "data->>'state' = 'sent' LIMIT 1", 'isPublic(', 'mailDailyCap(app.env)', 'ourMailbox(app)', 'customerQuiet(now())', 'WHERE NOT EXISTS (SELECT 1 FROM events WHERE ${SAME})']) {
    assert.ok(code.indexOf(rule) > 0 && code.indexOf(rule) < at, `${rule} is read before the email is sent`);
  }
});
