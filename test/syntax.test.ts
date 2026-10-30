import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Every TypeScript and JavaScript file of the repository parses, the entry scripts included. The suite imports the
// modules it tests, but never scripts/web.ts, which only the service runs, and the deploy runs the tests, not tsc. On
// 2026-10-30 a quote inside a string of accounts' scripts/web.js stopped that service from starting, sign-in down for
// three minutes, with every one of its tests passing; this is the same test as accounts' test/syntax.test.js. A .ts
// file is parsed the way Node reads it, by stripping its types (node --check does not strip them); a .js file of the
// dashboard's static folder is read by node --check. Neither runs the file.

const root = fileURLToPath(new URL('..', import.meta.url));
const files = execFileSync('git', ['ls-files', '*.ts', '*.js', '*.mjs', '*.cjs'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);

test('every TypeScript and JavaScript file parses, the entry scripts no test imports included', () => {
  assert.ok(files.includes('scripts/web.ts'), 'the service entry is among the files checked');
  const bad: string[] = [];
  for (const f of files) {
    try {
      if (f.endsWith('.ts')) stripTypeScriptTypes(readFileSync(path.join(root, f), 'utf8'));
      else execFileSync(process.execPath, ['--check', f], { cwd: root, stdio: 'pipe' });
    } catch (e) {
      const err = e as { stderr?: Buffer; message?: string };
      bad.push(`${f}: ${String(err.stderr || err.message).split('\n').find((l) => /Error|Expected/.test(l)) || 'does not parse'}`);
    }
  }
  assert.deepEqual(bad, [], bad.join('\n'));
});
