import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simEmail } from '../src/channels/email.ts';
import { drain } from '../src/jobs/worker.ts';
import { forgetProviders, mxDeps, providerOf, readConfirm } from '../src/web/pages/mailSetup.ts';
import { customer } from './helpers.ts';
import { serve } from './serve.ts';

// The email card as a guided flow (pages/mailSetup.ts; the owner, 2026-11-09: "i dont understand anything, and i am
// the owner. make everything easy for the user"): which mail the store uses, found from its address's domain or MX;
// the steps for that provider with the address to copy; Gmail's confirmation shown on the card itself; then connected,
// with the switch "תורן עונה במייל" (pages/channelOff.ts), which holds the next mail for the owner.

const DOMAIN = 'in.toran.test';
const WS = 21;
const realMx = mxDeps.resolveMx;
const stubMx = (hosts: string[] | Error) => {
  forgetProviders();
  mxDeps.resolveMx = async () => {
    if (hosts instanceof Error) throw hosts;
    return hosts.map((exchange, i) => ({ exchange, priority: i + 1 }));
  };
};

test('providerOf: a free address by its domain, a business domain by its MX hosts, and an unknown when DNS fails', async () => {
  try {
    stubMx(new Error('no DNS here'));
    assert.equal(await providerOf('shop@gmail.com'), 'gmail', 'no lookup for a free address');
    assert.equal(await providerOf('shop@hotmail.co.il'), 'outlook');
    assert.equal(await providerOf('shop@outlook.com'), 'outlook');
    assert.equal(await providerOf('shop@nurit-pottery.example'), null, 'a failed lookup asks the owner');
    stubMx(['mx.google.com.']);
    assert.equal(await providerOf('shop@nurit-pottery.example'), 'gmail', 'Google Workspace');
    stubMx(['alt1.aspmx.l.google.com', 'aspmx.l.google.com']);
    assert.equal(await providerOf('a@b-pottery.example'), 'gmail', 'Workspace from before 2023');
    stubMx(['nurit-pottery-example.mail.protection.outlook.com']);
    assert.equal(await providerOf('shop@c-pottery.example'), 'outlook', 'Microsoft 365');
    stubMx(['mx10.mailhost.example']);
    assert.equal(await providerOf('shop@d-pottery.example'), 'other');
    assert.equal(await providerOf('not an address'), null);
  } finally {
    mxDeps.resolveMx = realMx;
    forgetProviders();
  }
});

test('readConfirm: the code from the subject, the vf- link on Google\'s own hosts only', () => {
  const text = 'shop@gmail.com has requested to automatically forward mail to your email address.\nConfirmation code: 99427480\nTo allow it, click:\nhttps://mail-settings.google.com/mail/vf-%5BANGjdJ8x%5D-abc123\nTo cancel: https://mail-settings.google.com/mail/uf-%5BANGjdJ8x%5D-abc123';
  assert.deepEqual(readConfirm('(#99427480) Gmail Forwarding Confirmation - Receive Mail from shop@gmail.com', text), { code: '99427480', link: 'https://mail-settings.google.com/mail/vf-%5BANGjdJ8x%5D-abc123' });
  assert.equal(readConfirm('', 'https://mail.google.com/mail/vf-cbc1a04c94-x-y').link, 'https://mail.google.com/mail/vf-cbc1a04c94-x-y');
  assert.equal(readConfirm('', 'click https://mail-settings.google.com.evil.example/mail/vf-1 now').link, null, 'another host is never a link');
  assert.equal(readConfirm('', 'http://mail-settings.google.com/mail/vf-1').link, null, 'https only');
  assert.equal(readConfirm('', 'only https://mail-settings.google.com/mail/uf-1').link, null, 'the cancel link is never shown');
  assert.equal(readConfirm('', 'קוד אישור: 12345678').code, '12345678');
});

async function owner() {
  const s = await serve();
  s.app.env.TORAN_CHANNELS = 'whatsapp,email';
  s.app.mail = simEmail({ domain: DOMAIN });
  const id = s.seeded.storeId;
  await s.app.db.query('UPDATE stores SET workspace_id = $2, contact_email = NULL WHERE id = $1', [id, WS]);
  s.as(s.accounts.session(customer(WS)).cookie);
  return { s, id };
}

const flash = (r: Response) => decodeURIComponent(String(r.headers.get('set-cookie')));

test('Gmail: the address typed once, the steps with the address to copy, Gmail\'s confirmation on the card, then connected', async () => {
  const { s, id } = await owner();
  try {
    // Step 1: nothing known about the store's mail, so it is asked, once. No DNS, DMARC or MX on the card.
    let page = await (await s.get('/settings')).text();
    assert.match(page, /<section class="panel" id="email">[^]*שלב 1 מתוך 3[^]*מה המייל של החנות\?[^]*name="from"/);
    assert.doesNotMatch(page, /POP\/IMAP|רשומות DNS|רשומת MX|תת דומיין|כתבו לנו בוואטסאפ, ואנחנו מכבים/);
    const token = await s.csrf('/settings');
    const typed = await s.post(`/lead/${id}/mail/setup`, { _csrf: token, do: 'from', from: 'Nurit.Shop@gmail.com' });
    assert.equal(typed.headers.get('location'), '/settings#email');
    assert.match(flash(typed), /Gmail/);
    const account = (await s.app.db.one<any>("SELECT id, external_id, status, meta FROM channel_accounts WHERE store_id = $1 AND channel = 'email'", [id]))!;
    assert.equal(account.status, 'active', 'choosing connects the channel');
    assert.deepEqual([account.meta.provider, account.meta.from], ['gmail', 'nurit.shop@gmail.com']);

    // Step 2: Gmail's steps, the address in its own box with a copy button, Gmail's settings one press away.
    page = await (await s.get('/settings')).text();
    assert.match(page, /שלב 2 מתוך 3/);
    assert.ok(page.includes(`<div class="copybox mt12"><code class="ltr" id="fwd-${id}">${account.external_id}</code><button class="btn primary" type="button" data-copy="#fwd-${id}"`), 'the address in a box, with a big copy button');
    assert.match(page, /href="https:\/\/mail\.google\.com\/mail\/u\/0\/#settings\/fwdandpop"/);
    assert.match(page, /הוספת כתובת להעברה/);
    assert.match(page, new RegExp(`data-wait-mail="/lead/${id}/mail/state\\.json" data-v="forward"`));
    assert.deepEqual(await (await s.get(`/lead/${id}/mail/state.json`)).json(), { v: 'forward' });
    // What is connected to Toran says the same: half way, not connected (the owner's Settings, 2026-11-11).
    const row = (html: string) => /<li class="conn conn-\w+"><span class="conn-ic chn-email"[^]*?<\/li>/.exec(html)![0];
    assert.match(row(page), /conn-half[^]*החיבור באמצע[^]*chip sig">באמצע</);
    assert.doesNotMatch(row(page), /מחובר/);

    // Gmail's confirmation arrives at the address: held, never answered, and shown on the card.
    const link = 'https://mail-settings.google.com/mail/vf-%5BANGjdJ8x%5D-abc123';
    const sent = await fetch(`${s.base}/mail/sim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: 'Gmail Team <forwarding-noreply@google.com>', to: [account.external_id], subject: '(#99427480) Gmail Forwarding Confirmation - Receive Mail from nurit.shop@gmail.com', text: `nurit.shop@gmail.com has requested to automatically forward mail to your email address.\nConfirmation code: 99427480\n${link}\nTo cancel: https://mail-settings.google.com/mail/uf-x`, message_id: '<confirm-1@google.test>' }) });
    assert.equal(sent.status, 200);
    await drain(s.app, { kinds: ['mail_inbound'] });
    assert.equal(s.app.mail!.outbox!.length, 0, 'Toran never answers Gmail');
    assert.deepEqual(await (await s.get(`/lead/${id}/mail/state.json`)).json(), { v: 'confirm' });
    page = await (await s.get('/settings')).text();
    assert.match(page, /שלב 3 מתוך 3[^]*מייל האישור מ-Gmail הגיע/);
    assert.ok(page.includes(`<a class="btn primary big" href="${link}" target="_blank" rel="noopener noreferrer">`), 'the link as the main button');
    assert.match(page, /ללחוץ כאן לאישור/);
    assert.match(page, /<code class="ltr big" id="code-\d+">99427480<\/code>/);
    assert.match(page, /העברת עותק של הודעות נכנסות אל[^]*שמירת השינויים/);

    // "סיימתי": connected, with the switch, and the own address folded under "עוד אפשרויות".
    const done = await s.post(`/lead/${id}/mail/setup`, { _csrf: token, do: 'done' });
    assert.match(flash(done), /המייל מחובר/);
    page = await (await s.get('/settings')).text();
    assert.match(page, /<section class="panel" id="email"><header><h2>המייל<\/h2><span class="end chip ok">[^]*מחובר<\/span>/);
    assert.match(page, /מייל שמגיע ל-<bdi class="ltr">nurit\.shop@gmail\.com<\/bdi> עובר לתורן/);
    assert.match(page, /role="switch" aria-checked="true"[^]*תורן עונה במייל/);
    assert.match(page, /<details class="more mt16"><summary>עוד אפשרויות<\/summary>[^]*לענות מכתובת של החנות \(בשביל מי שמנהל לכם את האתר\)/);
    assert.deepEqual(await (await s.get(`/lead/${id}/mail/state.json`)).json(), { v: 'done' });
    assert.match(row(page), /conn-on[^]*מחובר, <bdi>nurit\.shop@gmail\.com<\/bdi>\. תורן עונה בו\./);

    // Starting again forgets the provider and "done", and keeps the address.
    await s.post(`/lead/${id}/mail/setup`, { _csrf: token, do: 'change' });
    assert.match(await (await s.get('/settings')).text(), /באיזה מייל החנות משתמשת\?/);
  } finally {
    await s.close();
  }
});

test('the store\'s address from its site: the provider pre-chosen by MX, Outlook\'s steps for a business domain, and "זה לא המייל של החנות"', async () => {
  const { s, id } = await owner();
  try {
    stubMx(['nurit-pottery-example.mail.protection.outlook.com']);
    await s.app.db.query("UPDATE stores SET contact_email = 'shop@nurit-pottery.example' WHERE id = $1", [id]);
    let page = await (await s.get('/settings')).text();
    assert.match(page, /באיזה מייל החנות משתמשת\?[^]*shop@nurit-pottery\.example/);
    assert.match(page, /<button class="choice picked" type="submit" name="provider" value="outlook"><b>Outlook או Hotmail<\/b><small>נראה לנו שזה<\/small>/);
    assert.match(page, /<button class="choice" type="submit" name="provider" value="gmail">/);
    const token = await s.csrf('/settings');
    await s.post(`/lead/${id}/mail/setup`, { _csrf: token, do: 'pick', provider: 'outlook' });
    page = await (await s.get('/settings')).text();
    assert.match(page, /href="https:\/\/outlook\.office\.com\/mail\/options\/mail\/forwarding"/, 'a business domain opens Microsoft 365');
    assert.match(page, /הפוך העברה לזמינה/);
    // The person who runs the mail gets the technical words, the owner does not.
    const wa = /href="(https:\/\/wa\.me\/\?text=[^"]+)"/.exec(page)?.[1] || '';
    assert.match(decodeURIComponent(wa.replace(/&amp;/g, '&')), /Automatic forwarding rules/);
    assert.match(page, /value="done"[^]*סיימתי/);

    // The site's address is not the store's mail: asked again, typed this time.
    await s.post(`/lead/${id}/mail/setup`, { _csrf: token, do: 'forget' });
    assert.match(await (await s.get('/settings')).text(), /מה המייל של החנות\?/);
  } finally {
    mxDeps.resolveMx = realMx;
    forgetProviders();
    await s.close();
  }
});

test('"תורן עונה במייל" off: the next mail waits for the owner, audited; on again, Toran answers; a team member cannot switch it', async () => {
  const { s, id } = await owner();
  try {
    const token = await s.csrf('/settings');
    await s.post(`/lead/${id}/mail/setup`, { _csrf: token, do: 'from', from: 'shop@gmail.com' });
    await s.post(`/lead/${id}/mail/setup`, { _csrf: token, do: 'done' });
    const address = (await s.app.db.one<any>("SELECT external_id FROM channel_accounts WHERE store_id = $1 AND channel = 'email'", [id])).external_id;
    let r = await s.post(`/lead/${id}/channel-off`, { _csrf: token, channel: 'email', on: '0' });
    assert.equal(r.headers.get('location'), '/settings#email');
    assert.deepEqual((await s.app.db.one<any>('SELECT agent_off FROM stores WHERE id = $1', [id])).agent_off, ['email']);
    assert.equal((await s.app.db.one<any>("SELECT COUNT(*)::int AS n FROM audit WHERE action = 'channel_off' AND store_id = $1", [id])).n, 1);
    let page = await (await s.get('/settings')).text();
    assert.match(page, /role="switch" aria-checked="false"[^]*תורן עונה במייל[^]*כרגע לא/);
    assert.match(page, /<li class="conn conn-paused">[^]*?<b>מייל<\/b>[^]*?<span class="chip warn">תורן לא עונה כאן<\/span>/);

    const mail = (n: number) => fetch(`${s.base}/mail/sim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: 'Dana <dana@example.test>', to: [address], subject: `שאלה ${n}`, text: 'יש לכם קערה?', message_id: `<q-${n}@example.test>` }) });
    await mail(1);
    await drain(s.app, { kinds: ['mail_inbound'] });
    assert.equal(s.app.mail!.outbox!.length, 0, 'switched off: no answer');
    const note = await s.app.db.one<any>("SELECT text FROM messages WHERE role = 'system' AND handoff->>'reason' = 'channel_off'");
    assert.match(note.text, /כיביתם את תורן בערוץ הזה/);

    r = await s.post(`/lead/${id}/channel-off`, { _csrf: token, channel: 'email', on: '1' });
    assert.match(flash(r), /תורן עונה שוב במייל/);
    await mail(2);
    await drain(s.app, { kinds: ['mail_inbound'] });
    assert.equal(s.app.mail!.outbox!.length, 1, 'on again: answered');

    // A team member sees the switch, without the button.
    s.as(s.accounts.session({ ...customer(WS), role: 'client_member' }).cookie);
    page = await (await s.get('/settings')).text();
    assert.match(page, /<div class="swbtn" role="switch" aria-checked="true" aria-disabled="true">/);
    const refused = await s.post(`/lead/${id}/channel-off`, { _csrf: await s.csrf('/settings'), channel: 'email', on: '0' });
    assert.ok([303, 403].includes(refused.status));
    assert.deepEqual((await s.app.db.one<any>('SELECT agent_off FROM stores WHERE id = $1', [id])).agent_off, []);
  } finally {
    await s.close();
  }
});
