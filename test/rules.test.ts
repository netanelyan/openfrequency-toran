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
/** The only callers of a WhatsApp provider's push() (channels/whatsapp.ts, THE RULE). */
const PUSHERS = ['src/channels/send.ts', 'src/owners/notify.ts', 'src/ops/alert.ts', 'src/billing/remind.ts'];

test('nothing sends outreach but the pitches to leads: messages and mail go out only from send.ts, in answer to an inbound message, from the store\'s automatic messages, or as the approved pitch templates under ops/outreach.ts\'s limits; no SMS', () => {
  for (const f of src) {
    const text = readFileSync(f, 'utf8');
    const r = rel(f);
    if (/\b(wa|mail|adapter)\.send\(/.test(text)) assert.ok(r === 'src/channels/send.ts' || r === AUTO, `${r} sends messages`);
    // A provider's API host, or a BSP's: only an adapter file names one. (Meta's own ids, such as a business account's
    // waba_id, appear wherever a connected number is kept; the calls are all in meta.ts, and Messenger's and
    // Instagram's in social.ts.)
    if (/api\.twilio\.com|graph\.facebook\.com|graph\.instagram\.com|api\.resend\.com|360dialog/i.test(text) && !ADAPTERS.includes(r)) assert.fail(`${r} talks to a messaging API`);
    assert.ok(!/nodemailer|smtp|sendgrid|mailgun|\bses\b.*send/i.test(text) || r === 'test/rules.test.ts', `${r} sends mail`);
    // push(), a WhatsApp message Toran starts: an image in an answer, the owner line's, the operator's own alerts, and
    // the payment reminders accounts hands over.
    if (/(?:\bwa|metaLinesAdapter\([^)]*\)|Wa\([^)]*\))\.push\(/.test(text)) assert.ok(PUSHERS.includes(r), `${r} starts WhatsApp messages`);
  }
  // The operator's alert is always the one approved template, to the number the operator set.
  const alert = readFileSync(path.join(ROOT, 'src/ops/alert.ts'), 'utf8');
  assert.match(alert, /\.push\(to, \{ template: \{ name: OPERATOR_ALERT\.name, sid: OPERATOR_ALERT\.name, vars: alertParams\(title, body\) \}, from: null \}\)/);
  assert.match(alert, /const to = alertNumber\(app\.env\);\n\s+if \(!to\)/);
  // A payment reminder is always the one approved template, to the number accounts handed over, its button the code.
  const remind = readFileSync(path.join(ROOT, 'src/billing/remind.ts'), 'utf8');
  assert.equal((remind.match(/\.push\(/g) || []).length, 1);
  assert.match(remind, /\.push\(r\.phone, \{ template: \{ name: PAYMENT_REMINDER\.name, sid: PAYMENT_REMINDER\.name, vars: reminderParams\(r\), payload: r\.code \}, from: lineNumber\(app\.env, 'owner'\) \}\)/);
  assert.ok(remind.indexOf('await heldBack(app, r.phone)') > 0 && remind.indexOf('await heldBack(app, r.phone)') < remind.indexOf('.push('), 'the limits are read before the send');
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
  // The pitches to leads (the owner, 2026-11-08: "toran should send it"): one send, always the approved template, after
  // every limit: the number that asked to stop, once a stage, the quiet hours, the day's cap, and Meta's quality.
  const pitch = readFileSync(path.join(ROOT, 'src/ops/outreach.ts'), 'utf8');
  assert.equal((pitch.match(/cloudSend\(/g) || []).length, 1);
  assert.match(pitch, /cloudSend\(app\.env, app\.graph, phoneId, token, phone, \{ template: \{ name: t\.name, sid: t\.name, vars: \[le\(name\)\], url: slug, payload: 'OUTREACH_STOP', payloadIndex: 1 \} \}\)/);
  const at = pitch.indexOf('cloudSend(app.env');
  for (const rule of ['stoppedNumber(app, phone)', "SELECT 1 FROM events WHERE ${same}", 'customerQuiet(now())', 'dailyCap(app.env)', 'qualityOk(app, phoneId, token, t)']) assert.ok(pitch.indexOf(rule) > 0 && pitch.indexOf(rule) < at, `${rule} is checked before the pitch is sent`);
});

test('no file in the repository names a real store (the pre-commit check, run as a test)', async () => {
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts/check-public.ts')], { cwd: ROOT, encoding: 'utf8' });
  assert.match(out, /check:public ok/);
});

test("check:public in a worktree reads the main checkout's private folder, so a commit made there is checked too", async () => {
  // 2026-11-03: in .claude/worktrees/<name>, which has no private/ of its own, the check read no private name at all
  // (Teder's let a real handle into its public repository that way).
  const { execFileSync, spawnSync } = await import('node:child_process');
  const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const os = await import('node:os');
  const main = mkdtempSync(path.join(os.tmpdir(), 'toran-public-main-'));
  const tree = path.join(main, '.claude', 'worktrees', 'w');
  const { TORAN_HOME, ...rest } = process.env;
  const run = (env: Record<string, string> = {}) => {
    execFileSync('git', ['add', '-f', '.'], { cwd: tree });
    return spawnSync(process.execPath, [path.join(ROOT, 'scripts/check-public.ts')], { env: { ...rest, CHECK_PUBLIC_ROOT: tree, ...env }, encoding: 'utf8' });
  };
  try {
    const git = (...a: string[]) => execFileSync('git', a, { cwd: main, stdio: 'pipe' });
    git('init', '-q');
    writeFileSync(path.join(main, '.gitignore'), 'private/\n.claude/\n');
    writeFileSync(path.join(main, 'a.ts'), 'export const a = 1;\n');
    git('add', '.');
    git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'first');
    git('worktree', 'add', '-q', tree, '-b', 'w');
    mkdirSync(path.join(tree, 'docs'), { recursive: true });
    writeFileSync(path.join(tree, 'docs', 'a.md'), 'a reply for zzsecretstore today\n');
    // With no private folder beside either, only the generic checks run, as before.
    const bare = run();
    assert.equal(bare.status, 0, bare.stderr);
    assert.match(bare.stdout, /0 private names checked/);
    // The main checkout's private folder names the store: the worktree's commit is refused.
    mkdirSync(path.join(main, 'private'), { recursive: true });
    writeFileSync(path.join(main, 'private', 'public-denylist.txt'), 'zzsecretstore\n');
    const out = run();
    assert.equal(out.status, 1, 'the name is refused in the worktree');
    // A private/ of the worktree's own (running Toran there makes one, holding none of the lists) changes nothing.
    mkdirSync(path.join(tree, 'private', 'models'), { recursive: true });
    assert.equal(run().status, 1, 'still refused with an empty private/ in the worktree');
    // TORAN_HOME still decides when it is set.
    const empty = mkdtempSync(path.join(os.tmpdir(), 'toran-private-'));
    try {
      assert.equal(run({ TORAN_HOME: empty }).status, 0);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  } finally {
    rmSync(main, { recursive: true, force: true });
  }
});
