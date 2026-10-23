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

// The channel adapters: the only files that talk to a messaging provider.
const ADAPTERS = ['src/channels/whatsapp.ts'];

test('nothing sends outreach: messages go out only from send.ts, in answer to an inbound message; no mail, no SMS', () => {
  for (const f of src) {
    const text = readFileSync(f, 'utf8');
    const r = rel(f);
    if (/\b(wa|adapter)\.send\(/.test(text)) assert.equal(r, 'src/channels/send.ts', `${r} sends messages`);
    if (/api\.twilio\.com|graph\.facebook\.com|waba|360dialog/i.test(text) && !ADAPTERS.includes(r)) assert.fail(`${r} talks to a messaging API`);
    assert.ok(!/nodemailer|smtp|sendgrid|mailgun|\bses\b.*send/i.test(text) || r === 'test/rules.test.ts', `${r} sends mail`);
  }
  // The only send is in reply(), which always answers the inbound being handled, after the channel's rules allow it.
  const send = readFileSync(path.join(ROOT, 'src/channels/send.ts'), 'utf8');
  assert.equal((send.match(/\.send\(/g) || []).length, 1);
  assert.match(send, /adapter\.send\(to\.from, part, to\)/);
  assert.ok(send.indexOf('sendPlan(') < send.indexOf('adapter.send('), 'the window is checked before the send');
});

test('no file in the repository names a real store (the pre-commit check, run as a test)', async () => {
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts/check-public.ts')], { cwd: ROOT, encoding: 'utf8' });
  assert.match(out, /check:public ok/);
});
