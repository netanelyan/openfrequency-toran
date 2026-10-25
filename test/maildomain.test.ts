import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleInbound } from '../src/channels/route.ts';
import { resendEmail, simEmail } from '../src/channels/email.ts';
import { checkDomain, domainsToCheck, dropDomain, mailDomainOf, ownAddress, parseOwnAddress, startDomain } from '../src/channels/mailDomain.ts';
import { ownerReply } from '../src/channels/owner.ts';
import { drain, schedule } from '../src/jobs/worker.ts';
import { storeAddress } from '../src/channels/config.ts';
import { DOMAIN, mail, mailStore } from './mail-fixtures.ts';
import { serve } from './serve.ts';

const sim = (app: any) => app.mail.domains as ReturnType<typeof import('../src/channels/mailDomain.ts').simDomains>;

test('the owner\'s address is checked: an address on a real domain, an optional subdomain label, never our own domain', () => {
  const ours = [DOMAIN, 'openfrequency.co.il'];
  assert.deepEqual(parseOwnAddress(' Support@TheirStore.co.il ', '', ours), { ok: true, local: 'support', domain: 'theirstore.co.il', receiving: null });
  assert.deepEqual(parseOwnAddress('support@theirstore.co.il', 'help', ours), { ok: true, local: 'support', domain: 'theirstore.co.il', receiving: 'help.theirstore.co.il' });
  assert.deepEqual(parseOwnAddress('support@theirstore.co.il', 'help.theirstore.co.il', ours), { ok: true, local: 'support', domain: 'theirstore.co.il', receiving: 'help.theirstore.co.il' });
  for (const bad of ['theirstore.co.il', 'support@', '@theirstore.co.il', 'a b@theirstore.co.il', 'support@localhost', 'support@1.2.3.4']) assert.equal(parseOwnAddress(bad, '', ours).ok, false, bad);
  assert.equal(parseOwnAddress('x@openfrequency.co.il', '', ours).ok, false, 'our own domain');
  assert.equal(parseOwnAddress(`x@shop.${DOMAIN}`, '', ours).ok, false, 'under our receiving domain');
  assert.equal(parseOwnAddress('support@theirstore.co.il', 'he lp', ours).ok, false);
  assert.equal(parseOwnAddress('support@theirstore.co.il', '-help', ours).ok, false);
});

test('Resend\'s domains API: create with sending only or receiving only, verify, read, delete (a 404 is already gone)', async () => {
  const calls: { method: string; url: string; body: any }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ method: init?.method || 'GET', url, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.endsWith('/domains') && init?.method === 'POST' && calls.at(-1)!.body.name === 'theirstore.co.il') return new Response(JSON.stringify({ id: 'd-1', name: 'theirstore.co.il', status: 'not_started', records: [{ record: 'DKIM', name: 'resend._domainkey', type: 'TXT', value: 'p=abc', ttl: 'Auto', status: 'not_started' }, { record: 'SPF', name: 'send', type: 'MX', value: 'feedback.example', priority: 10, status: 'not_started' }] }));
    if (url.endsWith('/domains/d-1/verify')) return new Response(JSON.stringify({ object: 'domain', id: 'd-1' }));
    if (url.endsWith('/domains/d-1') && init?.method === 'DELETE') return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
    if (url.endsWith('/domains/d-1')) return new Response(JSON.stringify({ id: 'd-1', name: 'theirstore.co.il', status: 'verified', records: [] }));
    return new Response(JSON.stringify({ message: 'nope' }), { status: 422 });
  }) as typeof fetch;
  const d = resendEmail({ apiKey: 're_test', webhookSecret: 'whsec_x', domain: DOMAIN, fetchImpl }).domains;
  const made = await d.create('theirstore.co.il', { sending: true, receiving: false });
  assert.deepEqual(made.records.map((r) => [r.type, r.name, r.priority]), [['TXT', 'resend._domainkey', null], ['MX', 'send', 10]]);
  assert.deepEqual(calls[0].body, { name: 'theirstore.co.il', capabilities: { sending: 'enabled', receiving: 'disabled' } });
  await d.verify('d-1');
  assert.equal((await d.get('d-1')).status, 'verified');
  await d.remove('d-1');
  await assert.rejects(d.create('other.co.il', { sending: false, receiving: true }), /Resend refused POST \/domains \(422\): nope/);
  assert.deepEqual(calls.at(-1)!.body.capabilities, { sending: 'disabled', receiving: 'enabled' });
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url.replace('https://api.resend.com', '')}`), ['POST /domains', 'POST /domains/d-1/verify', 'GET /domains/d-1', 'DELETE /domains/d-1', 'POST /domains']);
});

test('the store\'s own address: unverified, replies stay on our domain; verified, they go out from it; removed, back again', async () => {
  const { app, storeId, address } = await mailStore();
  const d = await startDomain(app, storeId, 'support@kli-cheres.example', '', 'owner@example.test');
  assert.deepEqual([d.domain, d.local, d.status, d.receiving], ['kli-cheres.example', 'support', 'not_started', null]);
  assert.deepEqual(d.records.map((r) => `${r.type} ${r.name}`), ['TXT resend._domainkey', 'MX send', 'TXT send']);
  assert.deepEqual(sim(app).calls, ['create kli-cheres.example']);
  assert.equal(await ownAddress(app, storeId), null);

  await handleInbound(app, mail(address));
  const out = app.mail!.outbox!;
  assert.match(String(out.at(-1)!.from), new RegExp(`<${address}>$`), 'not verified yet: from our domain');
  assert.equal(out.at(-1)!.replyTo, address);

  assert.equal((await checkDomain(app, storeId))!.status, 'pending', 'asked to verify, Resend is still checking');
  sim(app).verifyNow('kli-cheres.example');
  const v = (await checkDomain(app, storeId))!;
  assert.equal(v.status, 'verified');
  assert.ok(v.verified_at);
  assert.equal((await app.db.one<any>("SELECT COUNT(*)::int AS n FROM events WHERE kind = 'mail_domain_verified'")).n, 1);
  assert.deepEqual(await ownAddress(app, storeId), { from: 'support@kli-cheres.example', replyTo: 'support@kli-cheres.example' });

  await handleInbound(app, mail(address, { subject: 'עוד שאלה', text: 'יש קערה כחולה?' }));
  assert.match(String(out.at(-1)!.from), /<support@kli-cheres\.example>$/);
  assert.equal(out.at(-1)!.replyTo, 'support@kli-cheres.example');
  const conv = (await app.db.one<{ id: number }>("SELECT id FROM conversations WHERE meta->>'subject' = 'עוד שאלה'"))!.id;
  assert.equal((await ownerReply(app, conv, 'כן, יש. נורית', 'owner')).ok, true);
  assert.match(String(out.at(-1)!.from), /<support@kli-cheres\.example>$/, 'the owner\'s answer too');

  // Mail from the store's own address is the store writing to itself: kept, never answered.
  const n = out.length;
  assert.equal((await handleInbound(app, mail(address, { from: 'Nurit <support@kli-cheres.example>', subject: 'בדיקה' }))).action, 'automated');
  assert.equal(out.length, n);

  await dropDomain(app, storeId, 'owner');
  assert.equal(await mailDomainOf(app, storeId), null);
  assert.ok(sim(app).calls.includes('remove sim-domain-1'));
  await handleInbound(app, mail(address, { subject: 'אחרי', text: 'שאלה אחרונה' }));
  assert.match(String(out.at(-1)!.from), new RegExp(`<${address}>$`));
  await app.db.close();
});

test('a receiving subdomain: its mail reaches the store only once Resend verified it; Reply-To moves to it', async () => {
  const { app, storeId } = await mailStore();
  const d = await startDomain(app, storeId, 'support@kli-cheres.example', 'help', 'owner');
  assert.equal(d.receiving, 'help.kli-cheres.example');
  assert.deepEqual(d.receiving_records.map((r) => `${r.record} ${r.type}`), ['Receiving MX']);
  assert.deepEqual(sim(app).calls, ['create kli-cheres.example', 'create help.kli-cheres.example receiving']);
  assert.equal((await handleInbound(app, mail('support@help.kli-cheres.example'))).action, 'unknown_account', 'not verified: not routed');

  sim(app).verifyNow('kli-cheres.example');
  sim(app).verifyNow('help.kli-cheres.example');
  await checkDomain(app, storeId);
  const r = await handleInbound(app, mail('support@help.kli-cheres.example', { subject: 'ישר' }));
  assert.deepEqual([r.action, r.storeId], ['answered', storeId]);
  const sent = app.mail!.outbox!.at(-1)!;
  assert.match(String(sent.from), /<support@kli-cheres\.example>$/);
  assert.equal(sent.replyTo, 'support@help.kli-cheres.example');
  // Another store cannot take either name.
  const other = (await app.db.one<{ id: number }>("INSERT INTO stores (domain, url, name, source) VALUES ('other.example', 'https://other.example/', 'אחרת', 'manual') RETURNING id"))!.id;
  await assert.rejects(startDomain(app, other, 'x@help.kli-cheres.example', '', 'x'), /כבר מחובר לחנות אחרת/);
  await assert.rejects(startDomain(app, other, 'x@kli-cheres.example', '', 'x'), /כבר מחובר לחנות אחרת/);
  await app.db.close();
});

test('the worker reads a waiting domain again every ten minutes, for three days, and stops once it is verified', async () => {
  const { app, storeId } = await mailStore();
  await startDomain(app, storeId, 'support@kli-cheres.example', '', 'owner');
  assert.deepEqual(await domainsToCheck(app), [storeId]);
  sim(app).verifyNow('kli-cheres.example');
  await schedule(app);
  await drain(app, { kinds: ['mail_domain_check'] });
  assert.equal((await mailDomainOf(app, storeId))!.status, 'verified');
  assert.ok(!sim(app).calls.some((c) => c.startsWith('verify')), 'the worker only reads; "לבדוק עכשיו" asks Resend to verify');
  assert.deepEqual(await domainsToCheck(app), []);
  await app.db.query("UPDATE mail_domains SET status = 'pending', checked_at = NULL, created_at = now() - interval '4 days'");
  assert.deepEqual(await domainsToCheck(app), [], 'past three days Resend has stopped trying too');
  await app.db.close();
});

test('the own domain over HTTP: the form after email is connected, the records to add, "לבדוק עכשיו", and removing it', async () => {
  const s = await serve();
  try {
    s.app.env.TORAN_CHANNELS = 'whatsapp,email';
    s.app.mail = simEmail({ domain: DOMAIN });
    s.login();
    const id = s.seeded.storeId;
    assert.ok(!/כתובת על הדומיין של החנות/.test(await (await s.get(`/lead/${id}`)).text()), 'email not connected: no domain form');
    await s.post(`/lead/${id}/channels/email`, { _csrf: await s.csrf(), on: '1' });
    const page = await (await s.get(`/lead/${id}`)).text();
    assert.match(page, /כתובת על הדומיין של החנות/);
    assert.match(page, /action="\/lead\/\d+\/mail-domain"/);

    const bad = await s.post(`/lead/${id}/mail-domain`, { _csrf: await s.csrf(), on: '1', address: `x@${DOMAIN}` }, { referer: `${s.base}/lead/${id}` });
    assert.match(decodeURIComponent(String(bad.headers.get('set-cookie'))), /הדומיין שלנו/);
    assert.equal((await s.post(`/lead/${id}/mail-domain`, { _csrf: await s.csrf(), on: '1', address: 'support@kli-cheres.example', receiving: 'help' })).status, 303);
    const waiting = await (await s.get(`/lead/${id}`)).text();
    assert.match(waiting, /resend\._domainkey\.kli-cheres\.example/);
    assert.match(waiting, /help\.kli-cheres\.example/);
    assert.match(waiting, /לבדוק עכשיו/);
    const shared = storeAddress(await s.app.db.one<any>('SELECT id, slug FROM stores WHERE id = $1', [id]), DOMAIN);
    assert.match(waiting, new RegExp(`עד אז הוא עונה מ־<bdi class="ltr">${shared.replace(/\./g, '\\.')}`));

    sim(s.app).verifyNow('kli-cheres.example');
    const checked = await s.post(`/lead/${id}/mail-domain/check`, { _csrf: await s.csrf() });
    assert.match(decodeURIComponent(String(checked.headers.get('set-cookie'))), /הדומיין מאומת/);
    assert.match(await (await s.get(`/lead/${id}`)).text(), /תורן עונה מ־<bdi class="ltr">support@kli-cheres\.example/);

    assert.equal((await s.post(`/lead/${id}/mail-domain`, { _csrf: await s.csrf(), on: '0' })).status, 303);
    assert.equal(await mailDomainOf(s.app, id), null);
  } finally {
    await s.close();
  }
});
