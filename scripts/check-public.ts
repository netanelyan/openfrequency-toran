#!/usr/bin/env node
// npm run check:public
//
// The repository is public. This fails if anything committed (or staged for the next
// commit) looks private. Ported from Teder's check-public.js, with Toran's own risks:
//
//   - any file under private/, however it got there
//   - a .env file other than .env.example, or a key-shaped string anywhere (Anthropic,
//     Twilio, Brave, Meta, GitHub, AWS, Google, PEM), or a known key name given a value
//   - a database file
//   - media outside docs/screenshots/ and src/web/static/
//   - a phone number that is not one of the fictional ones (an Israeli mobile, local or
//     international form): a real customer's or a real store's number is the worst leak
//     this product can have
//   - the name or domain of any real store the engine has touched: the engine writes
//     each one to private/known-stores.txt, and private/public-denylist.txt adds words
//
// It reads file contents from the git index, so the pre-commit hook checks what would
// actually be committed, not what happens to be on disk.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT as REPO, home } from '../src/core/paths.ts';

const ROOT = process.env.CHECK_PUBLIC_ROOT || REPO;
const git = (...args: string[]) => execFileSync('git', args, { cwd: ROOT, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });

let files: string[];
try {
  files = git('ls-files', '--cached', '-z').toString('utf8').split('\0').filter(Boolean);
} catch {
  console.error('check:public: not a git repository');
  process.exit(1);
}

function indexContents(list: string[]): Map<string, Buffer> {
  const map = new Map<string, Buffer>();
  if (!list.length) return map;
  const out = execFileSync('git', ['cat-file', '--batch'], { cwd: ROOT, input: list.map((f) => `:${f}`).join('\n') + '\n', maxBuffer: 512 * 1024 * 1024 });
  let at = 0;
  for (const f of list) {
    const nl = out.indexOf(10, at);
    const header = out.subarray(at, nl).toString('utf8');
    const m = /^\S+ (\S+) (\d+)$/.exec(header);
    if (!m) {
      at = nl + 1;
      continue;
    }
    const size = Number(m[2]);
    map.set(f, out.subarray(nl + 1, nl + 1 + size));
    at = nl + 1 + size + 1;
  }
  return map;
}

const contents = indexContents(files);
const problems: string[] = [];
const fail = (file: string, why: string) => problems.push(`${file}: ${why}`);
const lineOf = (text: string, index: number) => text.slice(0, index).split('\n').length;

const MEDIA = /\.(jpe?g|png|webp|gif|mp4|mov|webm|heic)$/i;
const MEDIA_OK = [/^docs\/screenshots\//, /^src\/web\/static\//, /^assets\/brand\/png\//];
const KEY_NAMES = ['ANTHROPIC_API_KEY', 'ANTHROPIC_WORKSPACE_ID', 'BRAVE_API_KEY', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'SESSION_SECRET', 'TORAN_ADMIN_PASSWORD', 'DATABASE_URL'];
const KEY_SHAPES: [RegExp, string][] = [
  [/sk-ant-[A-Za-z0-9_-]{20,}/, 'an Anthropic key'],
  [/\bAC[0-9a-f]{32}\b/, 'a Twilio account SID'],
  [/\bSK[0-9a-f]{32}\b/, 'a Twilio API key'],
  [/\bBSA[A-Za-z0-9_-]{20,}\b/, 'a Brave Search key'],
  [/\bEAA[A-Za-z0-9]{60,}\b/, 'a Meta access token'],
  [/\bsk-[A-Za-z0-9]{32,}\b/, 'an API key'],
  [/\bghp_[A-Za-z0-9]{30,}\b/, 'a GitHub token'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS key'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, 'a Google API key'],
  [/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/, 'a private key'],
  [/postgres(?:ql)?:\/\/[^\s:'"]+:[^\s@'"]{6,}@(?!localhost|127\.0\.0\.1|db[:/])/, 'a database URL with a password'],
  // [ \t] and not \s: an empty KEY= must not run on into the next line's name.
  [new RegExp(`^[ \\t]*(?:export[ \\t]+)?(?:${KEY_NAMES.join('|')})[ \\t]*=[ \\t]*['"]?[^\\s'"#]{6,}`, 'm'), 'a key assigned a value'],
];

// Phone numbers. The fictional ones the tests and docs use are 972500000xxx / 050-000-0xxx
// (all zeros in the middle); anything else shaped like an Israeli mobile is refused.
const PHONE = /(?<![\d])(?:\+?972[-\s]?5\d[-\s]?\d{3}[-\s]?\d{4}|05\d[-\s]?\d{3}[-\s]?\d{4})(?![\d])/g;
const fictional = (s: string) => {
  const d = s.replace(/[^\d]/g, '');
  const intl = d.startsWith('0') ? `972${d.slice(1)}` : d;
  return /^9725\d0000/.test(intl);
};

// ---- what the private folder says is real
const real: string[] = [];
const h = home();
for (const f of ['known-stores.txt', 'public-denylist.txt']) {
  const file = path.join(h, f);
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.replace(/#.*$/, '').trim();
    if (t.length >= 4) real.push(t);
  }
}
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const L = '[\\p{L}\\p{N}_]';
const matchers = real.map((term) => ({ term, re: new RegExp(`(?<!${L})${esc(term)}(?!${L})`, 'iu') }));

for (const f of files) {
  const base = path.posix.basename(f);
  if (f.startsWith('private/') || f === 'private') fail(f, 'the private folder must never be tracked');
  if (/^\.env($|\.)/.test(base) && base !== '.env.example') fail(f, 'an .env file');
  if (/\.(db|sqlite|sqlite3)(-wal|-shm|-journal)?$/i.test(base) || /(^|\/)pglite\//.test(f)) fail(f, 'a database file');
  if (MEDIA.test(f) && !MEDIA_OK.some((re) => re.test(f))) fail(f, 'media outside docs/screenshots/ and src/web/static/');
  const buf = contents.get(f);
  if (!buf) continue;
  if (buf.subarray(0, 16).toString('latin1') === 'SQLite format 3\0') fail(f, 'an SQLite database');
  if (buf.includes(0)) continue;
  const text = buf.toString('utf8');
  if (f === 'scripts/check-public.ts') continue; // the patterns themselves
  for (const [re, what] of KEY_SHAPES) {
    const m = re.exec(text);
    if (!m) continue;
    if (base === '.env.example' && what === 'a key assigned a value') fail(f, `.env.example must list keys with empty values (${m[0].split('=')[0].trim()})`);
    else fail(f, `${what} (line ${lineOf(text, m.index)})`);
  }
  for (const m of text.matchAll(PHONE)) {
    if (!fictional(m[0])) fail(f, `a phone number that is not a fictional one (line ${lineOf(text, m.index ?? 0)})`);
  }
  for (const r of matchers) {
    const m = r.re.exec(text);
    if (m) fail(f, `names a real store (line ${lineOf(text, m.index)})`);
  }
}

if (problems.length) {
  console.error(`check:public FAILED: ${problems.length} problem(s) in tracked files\n  - ${problems.join('\n  - ')}`);
  console.error('\nNothing private belongs in this repository. Move it to private/ (or the database).');
  process.exit(1);
}
console.log(`check:public ok: ${files.length} tracked files, ${real.length} private names checked${existsSync(h) ? '' : ' (no private folder here, so only the generic checks ran)'}`);
