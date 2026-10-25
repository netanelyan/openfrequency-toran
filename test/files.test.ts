import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { handleInbound } from '../src/channels/route.ts';
import { resendEmail, simEmail } from '../src/channels/email.ts';
import { checkUpload, cleanName, MAX_BYTES, sniff } from '../src/channels/files.ts';
import { filesContext } from '../src/channels/store.ts';
import { parseSocial } from '../src/channels/social.ts';
import { ownerReply } from '../src/channels/owner.ts';
import { parseMultipart } from '../src/web/multipart.ts';
import { filesDir } from '../src/core/paths.ts';
import { drain } from '../src/jobs/worker.ts';
import type { TurnReq } from '../src/agent/llm/types.ts';
import { defaultScript } from '../src/agent/llm/scripted.ts';
import { customer } from './helpers.ts';
import { DOMAIN, mail, mailStore, PDF, PNG } from './mail-fixtures.ts';
import { serve } from './serve.ts';

const b64 = (b: Buffer) => b.toString('base64');

test('a file is told by its bytes: images and PDFs, never by its name; names are cleaned; uploads are checked', () => {
  assert.equal(sniff(PNG), 'image/png');
  assert.equal(sniff(PDF), 'application/pdf');
  assert.equal(sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])), 'image/jpeg');
  assert.equal(sniff(Buffer.from('GIF89a......')), 'image/gif');
  assert.equal(sniff(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp');
  assert.equal(sniff(Buffer.from('MZ\x90\0 an exe')), null);
  assert.equal(sniff(Buffer.from('<svg onload=alert(1)>')), null, 'an SVG can carry a script: not shown');
  assert.equal(cleanName('../../etc/passwd'), '.. .. etc passwd');
  assert.equal(cleanName('a\u0000b"c.pdf'), 'a b c.pdf');
  assert.equal(cleanName(''), 'file');
  assert.deepEqual(checkUpload('x.png', PNG), { ok: true, file: { name: 'x.png', type: 'image/png', bytes: PNG } });
  assert.equal((checkUpload('invoice.png', PDF) as any).file.type, 'application/pdf', 'the bytes decide, not the name');
  assert.match((checkUpload('x.exe', Buffer.from('MZ')) as any).he, /רק תמונה/);
  assert.match((checkUpload('big.pdf', Buffer.concat([PDF, Buffer.alloc(MAX_BYTES)])) as any).he, /גדול מדי/);
  assert.match((checkUpload('empty.pdf', Buffer.alloc(0)) as any).he, /ריק/);
});

test('the agent is told a file came, its name and kind, and that only the owner can see it', () => {
  assert.equal(filesContext([]), undefined);
  const line = filesContext([{ name: 'crack.jpg', type: 'image/jpeg', size: 1 }, { name: 'order.pdf', type: 'application/pdf', size: 1 }, { name: 'x.zip', type: 'application/zip', size: 1, skipped: 'type' }])!;
  assert.match(line, /attached 3 file\(s\): crack\.jpg \(an image\), order\.pdf \(a PDF\), x\.zip \(a file\)/);
  assert.match(line, /You cannot open them; the store's owner sees them in the inbox/);
  assert.match(line, /call handoff/);
});

test('a multipart body: its fields, and its file with the name and bytes as they came', () => {
  const B = 'XyZ';
  const body = Buffer.concat([
    Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="_csrf"\r\n\r\ntok\r\n--${B}\r\nContent-Disposition: form-data; name="text"\r\n\r\nשלום\r\nשורה\r\n--${B}\r\nContent-Disposition: form-data; name="file"; filename="קבלה.png"\r\nContent-Type: image/png\r\n\r\n`),
    PNG,
    Buffer.from(`\r\n--${B}\r\nContent-Disposition: form-data; name="empty"; filename=""\r\nContent-Type: application/octet-stream\r\n\r\n\r\n--${B}--\r\n`),
  ]);
  const { fields, files } = parseMultipart(body, B);
  assert.deepEqual(fields, { _csrf: 'tok', text: 'שלום\r\nשורה' });
  assert.equal(files.length, 1, 'an empty file input is no file');
  assert.deepEqual([files[0].field, files[0].name, files[0].type], ['file', 'קבלה.png', 'image/png']);
  assert.ok(files[0].bytes.equals(PNG));
});

test('Resend\'s attachments are fetched by their download link, refused past the limit; Meta\'s by their CDN link', async () => {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    if (url.endsWith('/emails/receiving/em_1/attachments/at_1')) return new Response(JSON.stringify({ object: 'attachment', id: 'at_1', filename: 'p.png', size: PNG.length, content_type: 'image/png', download_url: 'https://inbound-cdn.resend.test/at_1?sig=x' }));
    if (url.endsWith('/emails/receiving/em_1/attachments/at_2')) return new Response(JSON.stringify({ id: 'at_2', size: MAX_BYTES + 1, download_url: 'https://inbound-cdn.resend.test/at_2' }));
    if (url.startsWith('https://inbound-cdn.resend.test/at_1')) return new Response(PNG);
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  const a = resendEmail({ apiKey: 're_test', webhookSecret: 'whsec_x', domain: DOMAIN, fetchImpl });
  const inbound = { from: 'dana@example.test', text: '', id: '<x@y>' };
  assert.ok((await a.fetchFile!(inbound, { name: 'p.png', type: 'image/png', size: 0, ref: 'em_1/at_1' }, MAX_BYTES))!.equals(PNG));
  await assert.rejects(a.fetchFile!(inbound, { name: 'big', type: 'image/png', size: 0, ref: 'em_1/at_2' }, MAX_BYTES), /too big/);
  assert.equal(await a.fetchFile!(inbound, { name: 'x', type: '', size: 0 }, MAX_BYTES), null);
  assert.deepEqual(calls, ['https://api.resend.com/emails/receiving/em_1/attachments/at_1', 'https://inbound-cdn.resend.test/at_1?sig=x', 'https://api.resend.com/emails/receiving/em_1/attachments/at_2']);
  const dm = parseSocial({ object: 'page', entry: [{ id: 'PAGE1', messaging: [{ sender: { id: 'PSID1' }, recipient: { id: 'PAGE1' }, timestamp: 1, message: { mid: 'm1', attachments: [{ type: 'image', payload: { url: 'https://cdn.meta.test/p.jpg' } }, { type: 'file', payload: { url: 'http://insecure.test/x' } }] } }] }] });
  assert.deepEqual(dm.messages[0].attachments, [{ name: 'image', type: 'image', size: 0, ref: 'https://cdn.meta.test/p.jpg' }, { name: 'file', type: 'file', size: 0 }]);
});

test('a customer\'s files are kept (by their bytes) or listed with why; the agent is told; the owner\'s reply carries one', async () => {
  const seen: TurnReq[] = [];
  const { app, address } = await mailStore({ script: (req, n) => (seen.push(req), defaultScript(req, n)) });
  const asked = mail(address, {
    text: 'יש לכם קערה כזו?',
    attachments: [
      { filename: 'photo.png', content_type: 'image/png', content: b64(PNG) },
      { filename: 'order.pdf', content_type: 'application/pdf', content: b64(PDF) },
      { filename: 'not-a-pdf.pdf', content_type: 'application/pdf', content: b64(Buffer.from('MZ evil')) },
      { filename: 'huge.mov', content_type: 'video/quicktime', size: MAX_BYTES + 1 },
      { filename: 'logo.png', content_type: 'image/png', content_disposition: 'inline', content: b64(PNG) },
    ],
  });
  const r = await handleInbound(app, asked);
  assert.equal(r.action, 'answered');
  const files = await app.db.query<any>('SELECT name, type, size, sha256, skipped, direction FROM files ORDER BY id');
  assert.deepEqual(files.map((f) => [f.name, f.type, f.skipped, Boolean(f.sha256)]), [['photo.png', 'image/png', null, true], ['order.pdf', 'application/pdf', null, true], ['not-a-pdf.pdf', 'application/pdf', 'type', false], ['huge.mov', 'video/quicktime', 'too_big', false]], 'an inline image (a signature logo) is no attachment');
  assert.ok(existsSync(path.join(filesDir(app.env), files[0].sha256.slice(0, 2), files[0].sha256)));
  const msg = await app.db.one<any>('SELECT attachments FROM messages WHERE ext_id = $1', [asked.id]);
  assert.deepEqual(msg.attachments.map((a: any) => [a.name, Boolean(a.id), a.skipped || null]), [['photo.png', true, null], ['order.pdf', true, null], ['not-a-pdf.pdf', true, 'type'], ['huge.mov', true, 'too_big']]);
  assert.ok(!JSON.stringify(msg.attachments).includes(b64(PNG)), 'the bytes are not in the message row');
  const context = seen.map((q) => JSON.stringify(q.messages)).find((t) => t.includes('photo.png')) || '';
  assert.match(context, /attached 4 file\(s\): photo\.png \(an image\), order\.pdf \(a PDF\), not-a-pdf\.pdf \(a PDF\), huge\.mov \(a file\)/);

  const conv = (await app.db.one<{ id: number }>("SELECT id FROM conversations WHERE channel = 'email'"))!.id;
  const d = await ownerReply(app, conv, 'הנה החשבונית', 'owner', [{ name: 'invoice.pdf', type: 'application/pdf', bytes: PDF }]);
  assert.equal(d.ok, true);
  const sent = app.mail!.outbox!.at(-1)!;
  assert.deepEqual(sent.attachments, [{ filename: 'invoice.pdf', content: b64(PDF), content_type: 'application/pdf' }]);
  const owner = await app.db.one<any>("SELECT attachments FROM messages WHERE role = 'owner'");
  assert.deepEqual(owner.attachments.map((a: any) => [a.name, a.type]), [['invoice.pdf', 'application/pdf']]);
  assert.equal((await app.db.one<any>("SELECT COUNT(*)::int AS n FROM files WHERE direction = 'out'")).n, 1);
  // A file with no words still goes to the owner.
  assert.equal((await handleInbound(app, mail(address, { subject: 'תמונה', text: '', attachments: [{ filename: 'crack.png', content_type: 'image/png', content: b64(PNG) }] }))).action, 'no_text');
  // On WhatsApp the owner sends text only.
  const code = (await app.db.one<{ demo_code: string }>('SELECT demo_code FROM stores LIMIT 1'))!.demo_code;
  await handleInbound(app, { from: '972500000777', text: `${code} שלום`, id: 'w-files' });
  const waConv = (await app.db.one<{ id: number }>("SELECT id FROM conversations WHERE channel = 'whatsapp'"))!.id;
  assert.deepEqual(await ownerReply(app, waConv, 'x', 'owner', [{ name: 'a.png', type: 'image/png', bytes: PNG }]), { ok: false, reason: 'no_files' });
  await app.db.close();
});

test('files in the inbox over HTTP: shown in the conversation, served only inside its workspace, attached to a reply', async () => {
  const s = await serve();
  try {
    s.app.env.TORAN_CHANNELS = 'whatsapp,email';
    s.app.mail = simEmail({ domain: DOMAIN });
    const { cookie } = s.login();
    const id = s.seeded.storeId;
    await s.post(`/lead/${id}/channels/email`, { _csrf: await s.csrf(), on: '1' });
    const address = (await s.app.db.one<any>("SELECT external_id FROM channel_accounts WHERE store_id = $1 AND channel = 'email'", [id])).external_id;
    await fetch(`${s.base}/mail/sim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: 'Dana <dana@example.test>', to: [address], subject: 'שבר', text: 'הקערה הגיעה שבורה', message_id: '<files-1@example.test>', attachments: [{ filename: 'crack.png', content_type: 'image/png', content: b64(PNG) }, { filename: 'order.pdf', content_type: 'application/pdf', content: b64(PDF) }] }) });
    await drain(s.app, { kinds: ['mail_inbound'] });
    const conv = (await s.app.db.one<any>("SELECT id FROM conversations WHERE channel = 'email'")).id;
    const [img, pdf] = await s.app.db.query<any>('SELECT id FROM files ORDER BY id');
    const page = await (await s.get(`/chat/${conv}`)).text();
    assert.match(page, new RegExp(`<img src="/chat/${conv}/file/${img.id}" alt="crack.png"`));
    assert.match(page, new RegExp(`href="/chat/${conv}/file/${pdf.id}" download`));
    assert.match(page, /enctype="multipart\/form-data"/);
    assert.match(page, /name="file"/);

    const got = await s.get(`/chat/${conv}/file/${img.id}`);
    assert.equal(got.status, 200);
    assert.equal(got.headers.get('content-type'), 'image/png');
    assert.match(String(got.headers.get('content-security-policy')), /sandbox/);
    assert.match(String(got.headers.get('content-disposition')), /^inline/);
    assert.ok(Buffer.from(await got.arrayBuffer()).equals(PNG));
    assert.match(String((await s.get(`/chat/${conv}/file/${pdf.id}`)).headers.get('content-disposition')), /^attachment; filename\*=UTF-8''order\.pdf/);
    assert.equal((await s.get(`/chat/${conv}/file/999`)).status, 404);
    // Another conversation's file is not this one's.
    const other = (await s.app.db.one<any>("SELECT id FROM conversations WHERE id <> $1 LIMIT 1", [conv])).id;
    assert.equal((await s.get(`/chat/${other}/file/${img.id}`)).status, 404);

    // The owner attaches a PDF to the reply.
    const csrf = await s.csrf(`/chat/${conv}`);
    const post = async (file: Buffer, name: string, text = 'מצרפת את החשבונית') => {
      const f = new FormData();
      f.set('_csrf', csrf);
      f.set('text', text);
      f.set('file', new Blob([new Uint8Array(file)]), name);
      return fetch(`${s.base}/chat/${conv}/reply`, { method: 'POST', headers: { cookie, origin: s.base, referer: `${s.base}/chat/${conv}` }, body: f, redirect: 'manual' });
    };
    assert.equal((await post(PDF, 'חשבונית.pdf')).status, 303);
    const sent = s.app.mail.outbox!.at(-1)!;
    assert.equal(sent.text, 'מצרפת את החשבונית');
    assert.deepEqual((sent.attachments as any[]).map((a) => [a.filename, a.content_type]), [['חשבונית.pdf', 'application/pdf']]);
    assert.match(await (await s.get(`/chat/${conv}`)).text(), /חשבונית\.pdf/);
    const n = s.app.mail.outbox!.length;
    const wrong = await post(Buffer.from('MZ not a pdf'), 'x.pdf');
    assert.match(decodeURIComponent(String(wrong.headers.get('set-cookie'))), /רק תמונה/);
    assert.equal((await post(PNG, 'only-a-file.png', '')).status, 303, 'a file with no words goes out too');
    assert.equal(s.app.mail.outbox!.length, n + 1);
    // A file anywhere else is refused before it is read.
    const f = new FormData();
    f.set('_csrf', csrf);
    f.set('file', new Blob([new Uint8Array(PNG)]), 'x.png');
    assert.equal((await fetch(`${s.base}/settings/channels`, { method: 'POST', headers: { cookie, origin: s.base }, body: f, redirect: 'manual' })).status, 415);

    // Another workspace: neither the conversation nor its files exist for them.
    s.as(s.accounts.session(customer(9)).cookie);
    assert.equal((await s.get(`/chat/${conv}/file/${img.id}`)).status, 404);
  } finally {
    await s.close();
  }
});
