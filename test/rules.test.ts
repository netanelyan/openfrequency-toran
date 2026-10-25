import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/core/paths.ts';

// The rules that are read in the code, not trusted to memory.

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|js)$/.test(f) ? [p] : [];
  });
}
const src = [...files(path.join(ROOT, 'src')), ...files(path.join(ROOT, 'scripts'))];
const rel = (p: string) => path.relative(ROOT, p).replace(/\\/g, '/');

test('every setting the code reads is listed in .env.example', () => {
  const listed = new Set([...readFileSync(path.join(ROOT, '.env.example'), 'utf8').matchAll(/^([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]));
  const ignore = new Set(['HOME', 'LOCALAPPDATA', 'PATH', 'PLAYWRIGHT_BROWSERS_PATH', 'CHECK_PUBLIC_ROOT', 'TORAN_NEW_PASSWORD']);
  const read = new Set(src.flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/env\.([A-Z][A-Z0-9_]+)/g)].map((m) => m[1])));
  const missing = [...read].filter((k) => !listed.has(k) && !ignore.has(k));
  assert.deepEqual(missing, []);
});

// The channel adapters: the only files that talk to a messaging or mail provider.
const ADAPTERS = ['src/channels/whatsapp.ts', 'src/channels/email.ts', 'src/channels/meta.ts', 'src/channels/social.ts'];

// The store's automatic messages (a cart, a payment, a shipment, a review) are the one place a store's customer gets a
// message they did not just ask for, on the store's own number or email, with every rule in code before the send.
const AUTO = 'src/auto/send.ts';

test('nothing sends outreach: messages and mail go out only from send.ts, in answer to an inbound message, or from the store\'s automatic messages; no SMS', () => {
  for (const f of src) {
    const text = readFileSync(f, 'utf8');
    const r = rel(f);
    if (/\b(wa|mail|adapter)\.send\(/.test(text)) assert.ok(r === 'src/channels/send.ts' || r === AUTO, `${r} sends messages`);
    // A provider's API host, or a BSP's: only an adapter file names one. (Meta's own ids, such as a business account's
    // waba_id, appear wherever a connected number is kept; the calls are all in meta.ts, and Messenger's and
    // Instagram's in social.ts.)
    if (/api\.twilio\.com|graph\.facebook\.com|graph\.instagram\.com|api\.resend\.com|360dialog/i.test(text) && !ADAPTERS.includes(r)) assert.fail(`${r} talks to a messaging API`);
    assert.ok(!/nodemailer|smtp|sendgrid|mailgun|\bses\b.*send/i.test(text) || r === 'test/rules.test.ts', `${r} sends mail`);
  }
  // The only send is in reply(), which always answers an inbound message, after the channel's rules allow it.
  const send = readFileSync(path.join(ROOT, 'src/channels/send.ts'), 'utf8');
  assert.equal((send.match(/\.send\(/g) || []).length, 1);
  assert.match(send, /adapter\.send\(to\.from, part, to, sendCtx\)/);
  assert.ok(send.indexOf('sendPlan(') < send.indexOf('adapter.send('), 'the window is checked before the send');
  // The automatic messages: the kind is on, it is not quiet, the customer allows it, before either send.
  const auto = readFileSync(path.join(ROOT, AUTO), 'utf8');
  const sends = [auto.indexOf('cloudSend('), auto.indexOf('mail!.send(')];
  for (const rule of ['isOn(st)', 'customerQuiet(', "consentOf(app.db, ev.store_id, 'whatsapp'", "consentOf(app.db, ev.store_id, 'email'"]) assert.ok(auto.indexOf(rule) > 0 && auto.indexOf(rule) < Math.max(...sends), `${rule} is checked before the send`);
  assert.ok(auto.indexOf('approvedFor(') < sends[0], 'a WhatsApp template is approved before it is sent');
});

test('no file in the repository names a real store (the pre-commit check, run as a test)', async () => {
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts/check-public.ts')], { cwd: ROOT, encoding: 'utf8' });
  assert.match(out, /check:public ok/);
});
