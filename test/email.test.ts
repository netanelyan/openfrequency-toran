import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discover } from '../src/leads/discover.ts';
import { ingestStore } from '../src/ingest/pack.ts';
import { buildPitch } from '../src/pitch/build.ts';
import { handleInbound } from '../src/channels/route.ts';
import { automated, htmlToText, outgoing, parseAddress, resendEmail, simEmail, stripQuoted, svixOk, svixSign } from '../src/channels/email.ts';
import { enabledChannels, publicChannels, setChannelState, storeAddress } from '../src/channels/config.ts';
import { ownerReply, replyState, resumeAgent } from '../src/channels/owner.ts';
import { drain } from '../src/jobs/worker.ts';

import { testApp, customer } from './helpers.ts';
import { serve } from './serve.ts';

const DOMAIN = 'in.toran.test';
const CUSTOMER = 'dana@example.test';
let seq = 0;

/** The fictional store, with its email connected, and the email channel's code on. */
async function mailStore() {
  const app = await testApp();
  app.env.TORAN_CHANNELS = 'whatsapp,email';
  app.mail = simEmail({ domain: DOMAIN });
  await discover(app.db, (async function* () { yield { url: 'https://kli-cheres.example/', source: 'seed', detail: {} }; })(), { fetcher: app.fetcher, limit: 1 });
  const s = (await app.db.one<{ id: number }>("SELECT id FROM stores WHERE domain = 'kli-cheres.example'"))!;
  await ingestStore(app, s.id);
  await buildPitch(app, s.id);
  const store = (await app.db.one<{ id: number; slug: string }>('SELECT id, slug FROM stores WHERE id = $1', [s.id]))!;
  const address = storeAddress(store, DOMAIN);
  await app.db.query("INSERT INTO channel_accounts (store_id, channel, kind, external_id, name) VALUES ($1, 'email', 'sim', $2, 'כלי חרס של נורית')", [store.id, address]);
  return { app, storeId: store.id, address };
}

const mail = (to: string, o: Partial<{ from: string; subject: string; text: string; headers: Record<string, string>; attachments: unknown[]; message_id: string }> = {}) =>
  simEmail({ domain: DOMAIN }).parse({ raw: JSON.stringify({ from: `Dana <${CUSTOMER}>`, to: [to], subject: 'שאלה על קערה', text: 'יש לכם קערה?', message_id: `<m${seq++}@example.test>`, ...o }), form: {}, headers: {}, url: '' })![0];

test('Svix signatures: a good one passes; a forged, altered or stale one does not', () => {
  const secret = `whsec_${Buffer.from('a-test-secret-of-some-length').toString('base64')}`;
  const ts = String(Math.floor(Date.now() / 1000));
  const body = '{"type":"email.received"}';
  const sig = `v1,${svixSign(secret, 'msg_1', ts, body)}`;
  const h = { 'svix-id': 'msg_1', 'svix-timestamp': ts, 'svix-signature': `v1,old ${sig}` };
  assert.equal(svixOk(secret, h, body), true);
  assert.equal(svixOk(secret, { ...h, 'svix-signature': 'v1,forged' }, body), false);
  assert.equal(svixOk(secret, h, `${body} `), false);
  assert.equal(svixOk(secret, h, body, Date.now() + 10 * 60_000), false, 'older than five minutes: a replay');
  assert.equal(svixOk('', h, body), false);
});

test('automated mail is recognised: auto-replies, lists, bounces, no-reply senders, our own domain; a person is not', () => {
  const person = { from: 'Dana <dana@example.test>' };
  assert.equal(automated({}, person.from, DOMAIN), null);
  assert.equal(automated({ 'auto-submitted': 'no' }, person.from, DOMAIN), null);
  assert.equal(automated({ 'auto-submitted': 'auto-replied' }, person.from, DOMAIN), 'auto-submitted');
  assert.equal(automated({ precedence: 'bulk' }, person.from, DOMAIN), 'precedence bulk');
  assert.equal(automated({ 'list-unsubscribe': '<mailto:x>' }, person.from, DOMAIN), 'mailing list');
  assert.equal(automated({ 'x-autoreply': 'yes' }, person.from, DOMAIN), 'auto-reply');
  assert.equal(automated({ 'return-path': '<>' }, person.from, DOMAIN), 'bounce');
  assert.equal(automated({ 'content-type': 'multipart/report; report-type=delivery-status' }, person.from, DOMAIN), 'delivery report');
  for (const a of ['MAILER-DAEMON@x.test', 'noreply@shop.test', 'no-reply@shop.test', 'forwarding-noreply@google.com', 'notifications@x.test']) assert.equal(automated({}, a, DOMAIN), 'no-reply address', a);
  assert.equal(automated({}, `someone@${DOMAIN}`, DOMAIN), 'our own domain');
  assert.equal(automated({}, 'replyguy@x.test', DOMAIN), null, 'a name with "reply" in it is a person');
});

test('the new part of an email: quotes, the Gmail and Outlook history and the signature are cut', () => {
  assert.equal(stripQuoted('יש לכם קערה?\n\nOn Mon, 1 Jan 2026 at 10:00, Shop <a@b> wrote:\n> old'), 'יש לכם קערה?');
  assert.equal(stripQuoted('כן, בכחול\n\nבתאריך יום ב׳, 1 בינו׳ 2026, 10:00, החנות כתב/ה:\n> קודם'), 'כן, בכחול');
  assert.equal(stripQuoted('תודה\n-----Original Message-----\nFrom: x'), 'תודה');
  assert.equal(stripQuoted('מה המחיר?\n-- \nדנה\n050-0000000'), 'מה המחיר?');
  assert.equal(stripQuoted('> quoted only\nשורה חדשה'), 'שורה חדשה');
  assert.equal(htmlToText('<div dir="rtl"><p>שלום</p><p>יש <b>קערה</b>?<br>תודה</p><blockquote>old</blockquote></div>'), 'שלום\nיש קערה?\nתודה');
  assert.deepEqual(parseAddress('"Dana K" <Dana@Example.test>'), { name: 'Dana K', address: 'dana@example.test' });
});

test('a reply is threaded on what it answers, from the store\'s address with its name; only the agent\'s says Auto-Submitted', () => {
  const inbound = { from: CUSTOMER, text: '', id: '<b@x>', account: `nurit@${DOMAIN}`, subject: 'שאלה', thread: { messageId: '<b@x>', inReplyTo: '<a@x>', references: ['<a@x>'] } };
  const m = outgoing(CUSTOMER, 'תשובה', inbound, { who: 'agent', storeName: 'כלי חרס של נורית' });
  assert.equal(m.from, `"כלי חרס של נורית" <nurit@${DOMAIN}>`);
  assert.equal(m.reply_to, `nurit@${DOMAIN}`);
  assert.equal(m.subject, 'Re: שאלה');
  assert.deepEqual(m.headers, { 'In-Reply-To': '<b@x>', References: '<a@x> <b@x>', 'Auto-Submitted': 'auto-replied' });
  assert.equal(outgoing(CUSTOMER, 'x', { ...inbound, subject: 'Re: שאלה' }, { who: 'owner' }).subject, 'Re: שאלה');
  assert.equal(outgoing(CUSTOMER, 'x', inbound, { who: 'owner' }).headers['Auto-Submitted'], undefined);
  assert.match(m.html, /dir="rtl"/);
});

test('Resend: the webhook is checked and gives a stub, the worker fetches the body; bounces and complaints become reports', async () => {
  const secret = `whsec_${Buffer.from('resend-secret-0123456789').toString('base64')}`;
  const calls: string[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method || 'GET'} ${url}`);
    if (url.endsWith('/emails/receiving/em_1')) return new Response(JSON.stringify({ id: 'em_1', from: 'Dana <dana@example.test>', to: [`nurit@${DOMAIN}`], subject: 'Re: שאלה', text: 'ובכחול?\n\nOn Mon wrote:\n> x', html: null, message_id: '<c@x>', headers: { 'In-Reply-To': '<b@x>', References: '<a@x> <b@x>' }, attachments: [{ filename: 'photo.jpg', content_type: 'image/jpeg', content_disposition: 'attachment', size: 2048 }] }));
    if (url.endsWith('/emails')) return new Response(JSON.stringify({ id: 'sent_1' }));
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  const a = resendEmail({ apiKey: 're_test', webhookSecret: secret, domain: DOMAIN, fetchImpl });
  const signed = (body: string, id = 'msg_1') => {
    const ts = String(Math.floor(Date.now() / 1000));
    return { raw: body, form: {}, url: '', headers: { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': `v1,${svixSign(secret, id, ts, body)}` } };
  };
  const ev = JSON.stringify({ type: 'email.received', data: { email_id: 'em_1', from: 'dana@example.test', to: [`nurit@${DOMAIN}`], subject: 'Re: שאלה', message_id: '<c@x>' } });
  assert.equal(a.parse({ ...signed(ev), headers: { ...signed(ev).headers, 'svix-signature': 'v1,nope' } }), null);
  const [stub] = a.parse(signed(ev))!;
  assert.deepEqual([stub.id, stub.pending, stub.account, stub.text], ['<c@x>', 'em_1', `nurit@${DOMAIN}`, '']);
  const full = await a.complete!(stub);
  assert.equal(full.text, 'ובכחול?');
  assert.deepEqual(full.thread, { messageId: '<c@x>', inReplyTo: '<b@x>', references: ['<a@x>', '<b@x>'] });
  assert.deepEqual(full.attachments, [{ name: 'photo.jpg', type: 'image/jpeg', size: 2048 }]);
  assert.equal((await a.send(CUSTOMER, 'כן', full, { who: 'agent', storeName: 'x' })).id, 'sent_1');
  assert.deepEqual(calls, ['GET https://api.resend.com/emails/receiving/em_1', 'POST https://api.resend.com/emails']);
  const bounce = a.parse(signed(JSON.stringify({ type: 'email.bounced', data: { to: ['gone@example.test'] } }), 'msg_2'))!;
  assert.deepEqual(bounce.map((b) => [b.from, b.report]), [['gone@example.test', 'bounced']]);
  assert.deepEqual(a.parse(signed(JSON.stringify({ type: 'email.delivered', data: {} }), 'msg_3')), []);
});

test('an email to a connected store is answered by email, threaded, with no demo footer; the thread stays one conversation', async () => {
  const { app, storeId, address } = await mailStore();
  const first = mail(address);
  const r1 = await handleInbound(app, first);
  assert.deepEqual([r1.action, r1.storeId], ['answered', storeId]);
  const out = app.mail!.outbox!;
  assert.equal(out.length, 1);
  assert.equal(out[0].to, CUSTOMER);
  assert.match(String(out[0].from), new RegExp(`<${address}>$`));
  assert.equal(out[0].subject, 'Re: שאלה על קערה');
  assert.deepEqual(out[0].headers, { 'In-Reply-To': first.id, References: first.id, 'Auto-Submitted': 'auto-replied' });
  assert.match(out[0].text, /קערת/);
  assert.ok(!/דמו של תורן/.test(out[0].text), 'a store\'s own channel has no demo footer');

  const conv = await app.db.one<any>('SELECT id, channel, peer, account_id, meta FROM conversations WHERE peer = $1', [CUSTOMER]);
  assert.deepEqual([conv.channel, conv.peer, conv.meta.subject], ['email', CUSTOMER, 'שאלה על קערה']);
  assert.ok(conv.account_id);
  assert.deepEqual((await app.db.query<any>('SELECT role, channel FROM messages WHERE conversation_id = $1 ORDER BY id', [conv.id])).map((m) => [m.role, m.channel]), [['customer', 'email'], ['agent', 'email']]);

  // A reply in the thread (its References name the first email) is the same conversation, even with a new subject.
  await handleInbound(app, mail(address, { subject: 'Re: משהו אחר', text: 'ובכחול?', headers: { 'In-Reply-To': '<resend-generated@x>', References: `${first.id} <resend-generated@x>` } }));
  // The same subject with no headers is the same conversation too; a new subject is a new one.
  await handleInbound(app, mail(address, { subject: 'RE: שאלה על קערה', text: 'ומה עם משלוח?' }));
  await handleInbound(app, mail(address, { subject: 'החזרה', text: 'איך מחזירים?' }));
  assert.deepEqual((await app.db.query<any>('SELECT COUNT(*)::int AS n FROM conversations WHERE peer = $1 GROUP BY id ORDER BY id', [CUSTOMER])).length, 2);
  assert.equal((await app.db.one<any>("SELECT COUNT(*)::int AS n FROM messages WHERE conversation_id = $1 AND role = 'customer'", [conv.id])).n, 3);
  assert.equal(out.length, 4);
  assert.equal((await handleInbound(app, { ...first })).action, 'duplicate');
  await app.db.close();
});

test('never answered: automated mail, mail to an address no store connected, a file with no words (handed to the owner)', async () => {
  const { app, storeId, address } = await mailStore();
  const auto = await handleInbound(app, mail(address, { from: 'forwarding-noreply@google.com', subject: '(#123) Gmail Forwarding Confirmation', text: 'click https://mail.google.com/x' }));
  assert.equal(auto.action, 'automated');
  assert.equal((await app.db.one<any>("SELECT automated FROM messages WHERE role = 'customer' ORDER BY id DESC LIMIT 1")).automated, 'no-reply address');
  assert.equal((await handleInbound(app, mail(address, { headers: { 'Auto-Submitted': 'auto-replied' } }))).action, 'automated');
  assert.equal((await handleInbound(app, mail(`nobody@${DOMAIN}`))).action, 'unknown_account');
  await app.db.query("UPDATE channel_accounts SET status = 'off' WHERE store_id = $1", [storeId]);
  assert.equal((await handleInbound(app, mail(address))).action, 'unknown_account', 'a disconnected address is not answered');
  await app.db.query("UPDATE channel_accounts SET status = 'active' WHERE store_id = $1", [storeId]);
  const files = await handleInbound(app, mail(address, { subject: 'תמונה', text: '', attachments: [{ filename: 'crack.jpg', content_type: 'image/jpeg', size: 90_000 }] }));
  assert.equal(files.action, 'no_text');
  const c = await app.db.one<any>("SELECT c.handoffs, (SELECT attachments FROM messages WHERE conversation_id = c.id AND role = 'customer' LIMIT 1) AS att FROM conversations c WHERE c.meta->>'subject' = 'תמונה'");
  assert.equal(c.handoffs, 1);
  assert.deepEqual(c.att, [{ id: 1, name: 'crack.jpg', type: 'image/jpeg', size: 90_000, skipped: 'unavailable' }], 'listed: the simulator sent no bytes');
  assert.equal(app.mail!.outbox!.length, 0, 'none of these got an answer');
  await app.db.close();
});

test('the owner answers by email: it goes out threaded and without Auto-Submitted, the agent holds off, and comes back on "להחזיר לתורן"', async () => {
  const { app, address } = await mailStore();
  await handleInbound(app, mail(address, { text: 'אפשר לשלם בביט?' }));
  const conv = (await app.db.one<{ id: number }>('SELECT id FROM conversations WHERE peer = $1', [CUSTOMER]))!.id;
  assert.deepEqual(await replyState(app, conv), { canReply: true, reason: null, windowEnds: null, pausedUntil: null, files: true });
  const d = await ownerReply(app, conv, 'כן, אפשר. נורית', 'owner@example.test');
  assert.equal(d.ok, true);
  const sent = app.mail!.outbox!.at(-1)!;
  assert.equal(sent.text, 'כן, אפשר. נורית');
  assert.equal((sent.headers as any)['Auto-Submitted'], undefined);
  assert.equal(sent.subject, 'Re: שאלה על קערה');
  const owner = await app.db.one<any>("SELECT author, channel FROM messages WHERE conversation_id = $1 AND role = 'owner'", [conv]);
  assert.deepEqual([owner.author, owner.channel], ['owner@example.test', 'email']);
  assert.ok((await replyState(app, conv)).pausedUntil! > Date.now() + 11 * 3_600_000);

  const n = app.mail!.outbox!.length;
  assert.equal((await handleInbound(app, mail(address, { text: 'תודה! ומה עם משלוח?' }))).action, 'held');
  assert.equal(app.mail!.outbox!.length, n, 'held: the agent did not answer while the owner has the conversation');
  await resumeAgent(app, conv, 'owner@example.test');
  assert.equal((await handleInbound(app, mail(address, { text: 'כמה עולה משלוח?' }))).action, 'answered');
  assert.equal(app.mail!.outbox!.length, n + 1);
  await app.db.close();
});

test('a bounce or a spam complaint stops all mail to that address', async () => {
  const { app, address } = await mailStore();
  await handleInbound(app, mail(address));
  const conv = (await app.db.one<{ id: number }>('SELECT id FROM conversations WHERE peer = $1', [CUSTOMER]))!.id;
  assert.equal((await handleInbound(app, { channel: 'email', from: CUSTOMER, text: '', id: 'evt-1', report: 'bounced' })).action, 'suppressed');
  assert.deepEqual(await ownerReply(app, conv, 'שלום', 'owner'), { ok: false, reason: 'suppressed' });
  assert.equal((await replyState(app, conv)).reason, 'suppressed');
  const n = app.mail!.outbox!.length;
  await handleInbound(app, mail(address, { text: 'שוב אני' }));
  assert.equal(app.mail!.outbox!.length, n);
  assert.equal((await app.db.one<any>("SELECT COUNT(*)::int AS n FROM events WHERE kind = 'mail_blocked'")).n, 2);
  await app.db.close();
});

test('the owner on WhatsApp: a reply inside the 24 hours goes out and pauses the demo agent; past them, nothing is sent', async () => {
  const { app, storeId } = await mailStore();
  const code = (await app.db.one<{ demo_code: string }>('SELECT demo_code FROM stores WHERE id = $1', [storeId]))!.demo_code;
  const phone = '972500000777';
  await handleInbound(app, { from: phone, text: `${code} יש קערה?`, id: 'w1' });
  const conv = (await app.db.one<{ id: number }>('SELECT id FROM conversations WHERE peer = $1', [phone]))!.id;
  const st = await replyState(app, conv);
  assert.equal(st.canReply, true);
  assert.ok(st.windowEnds! > Date.now() + 23 * 3_600_000);
  assert.equal((await ownerReply(app, conv, 'היי, כאן נורית', 'owner')).ok, true);
  assert.equal(app.wa.outbox!.at(-1)!.text, 'היי, כאן נורית');
  const n = app.wa.outbox!.length;
  assert.equal((await handleInbound(app, { from: phone, text: 'תודה', id: 'w2' })).action, 'held');
  assert.equal(app.wa.outbox!.length, n);

  await app.db.query("UPDATE messages SET at = now() - interval '25 hours' WHERE conversation_id = $1 AND role = 'customer'", [conv]);
  assert.deepEqual(await ownerReply(app, conv, 'עוד משהו', 'owner'), { ok: false, reason: 'window_closed' });
  assert.equal(app.wa.outbox!.length, n);
  assert.equal((await app.db.one<any>("SELECT COUNT(*)::int AS n FROM messages WHERE conversation_id = $1 AND role = 'owner'", [conv])).n, 1, 'a reply that did not go out is not recorded as sent');
  await app.db.close();
});

test('channel config: the code flag, the states the website reads, and no "live" for a channel whose code is off', async () => {
  const app = await testApp();
  assert.deepEqual([...enabledChannels({})], ['whatsapp']);
  assert.deepEqual([...enabledChannels({ TORAN_CHANNELS: 'email, sms,instagram' })], ['whatsapp', 'email', 'instagram']);
  assert.deepEqual(await publicChannels(app.db), { channels: { whatsapp: 'demo', email: 'off', messenger: 'off', instagram: 'off' }, live: [], demo: ['whatsapp'], soon: ['email', 'messenger', 'instagram'] });
  await assert.rejects(setChannelState(app.db, {}, 'email', 'live'), /code for email is off/);
  await setChannelState(app.db, { TORAN_CHANNELS: 'email' }, 'email', 'live');
  assert.deepEqual((await publicChannels(app.db)).live, ['email']);
  await app.db.close();
});

test('the inbox over HTTP: connect the store\'s email, mail arrives through the webhook, both channels listed, the owner replies; another workspace cannot', async () => {
  const s = await serve();
  try {
    assert.equal((await fetch(`${s.base}/mail/sim`, { method: 'POST', body: '{}' })).status, 404, 'email\'s code is off: no webhook');
    const pub = await (await fetch(`${s.base}/channels.json`)).json();
    assert.equal(pub.channels.email, 'off');
    s.app.env.TORAN_CHANNELS = 'whatsapp,email';
    s.app.mail = simEmail({ domain: DOMAIN });
    s.login();
    const id = s.seeded.storeId;
    assert.match(await (await s.get(`/lead/${id}`)).text(), /לחבר מייל/);
    assert.equal((await s.post(`/lead/${id}/channels/email`, { _csrf: await s.csrf(), on: '1' })).status, 303);
    const address = (await s.app.db.one<any>("SELECT external_id FROM channel_accounts WHERE store_id = $1 AND status = 'active'", [id])).external_id;
    assert.match(await (await s.get(`/lead/${id}`)).text(), new RegExp(address.replace('.', '\\.')));

    const r = await fetch(`${s.base}/mail/sim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: `Dana <${CUSTOMER}>`, to: [address], subject: 'שאלה על קערה', text: 'יש לכם קערה?', message_id: '<http-1@example.test>' }) });
    assert.equal(r.status, 200);
    await drain(s.app, { kinds: ['mail_inbound'] });
    assert.equal(s.app.mail.outbox!.length, 1);
    const conv = (await s.app.db.one<any>("SELECT id FROM conversations WHERE channel = 'email'")).id;

    const list = await (await s.get('/chats')).text();
    assert.match(list, /<span class="chip">מייל<\/span>/);
    assert.match(list, /<span class="chip">וואטסאפ<\/span>/);
    assert.match(await (await s.get('/chats?channel=email')).text(), new RegExp(`/chat/${conv}"`));
    const page = await (await s.get(`/chat/${conv}`)).text();
    assert.match(page, /לענות ללקוח/);
    assert.match(page, /לשלוח במייל/);
    assert.equal((await s.post(`/chat/${conv}/reply`, { _csrf: await s.csrf(`/chat/${conv}`), text: 'כן, יש. נורית' })).status, 303);
    assert.equal(s.app.mail.outbox!.at(-1)!.text, 'כן, יש. נורית');
    assert.match(await (await s.get(`/chat/${conv}`)).text(), /להחזיר לתורן/);

    // A customer of another workspace: the conversation and its reply route do not exist for them.
    const other = s.accounts.session(customer(9));
    s.as(other.cookie);
    assert.equal((await s.get(`/chat/${conv}`)).status, 404);
    assert.equal((await s.post(`/chat/${conv}/reply`, { _csrf: await s.csrf(), text: 'x' })).status, 404);
    assert.equal(s.app.mail.outbox!.length, 2);

    s.login();
    assert.equal((await s.post('/settings/channels', { _csrf: await s.csrf('/settings'), whatsapp: 'demo', email: 'live' })).status, 303);
    assert.equal((await (await fetch(`${s.base}/channels.json`)).json()).channels.email, 'live');
  } finally {
    await s.close();
  }
});

