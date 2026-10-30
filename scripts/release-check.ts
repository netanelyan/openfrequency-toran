// npm run release-check: what a build must pass before it reaches the server (deploy/deploy.sh runs it in the new
// release folder, and CI on every push: .github/workflows/test.yml).
//
//   - the whole suite, on PGlite, or on Postgres with TORAN_TEST_DATABASE_URL (test/helpers.ts)
//   - nothing failed, nothing cancelled, and nothing SKIPPED: a test that skips itself (a missing browser, a missing
//     server) is a check that did not run, and the release is refused for it. A test marked todo is a known defect
//     with its test written and is reported, not refused
//   - then check:public (--tests-only leaves it out: a release folder on the server is an export with no git index)
//
// Exit 0 only when all of it passed.
import { spawn, spawnSync } from 'node:child_process';
import { ROOT } from '../src/core/paths.ts';

export type TapSummary = { tests: number; pass: number; fail: number; cancelled: number; skipped: number; todo: number };

/** The totals node's TAP reporter ends with ("# pass 412"), or null when the run never got that far. */
export function tapSummary(text: string): TapSummary | null {
  const n = (k: string) => {
    const m = new RegExp(`^# ${k} (\\d+)\\s*$`, 'm').exec(text);
    return m ? Number(m[1]) : null;
  };
  const tests = n('tests');
  if (tests == null) return null;
  return { tests, pass: n('pass') ?? 0, fail: n('fail') ?? 0, cancelled: n('cancelled') ?? 0, skipped: n('skipped') ?? 0, todo: n('todo') ?? 0 };
}

/** Why the release is refused, or an empty list. */
export function refusals(s: TapSummary | null, exitCode: number | null): string[] {
  if (!s) return ['the test run ended before its summary'];
  const out: string[] = [];
  if (s.fail) out.push(`${s.fail} failed`);
  if (s.cancelled) out.push(`${s.cancelled} cancelled`);
  if (s.skipped) out.push(`${s.skipped} skipped (a check that did not run)`);
  if (!s.tests) out.push('no tests ran');
  if (exitCode !== 0 && !out.length) out.push(`the test runner exited ${exitCode}`);
  return out;
}

if (import.meta.main) {
  const mode = String(process.env.TORAN_TEST_DATABASE_URL || '').trim() ? 'Postgres' : 'PGlite';
  const child = spawn(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=tap', 'test/*.test.ts'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  child.stdout.on('data', (d: Buffer) => {
    out += d.toString('utf8');
    process.stdout.write(d);
  });
  const code: number | null = await new Promise((resolve) => child.on('close', resolve));
  const s = tapSummary(out);
  const why = refusals(s, code);
  if (why.length) {
    console.error(`\nrelease-check (${mode}): REFUSED: ${why.join(', ')}`);
    process.exit(1);
  }
  const pub = process.argv.includes('--tests-only') ? { status: 0 } : spawnSync(process.execPath, ['scripts/check-public.ts'], { cwd: ROOT, stdio: 'inherit' });
  if (pub.status !== 0) {
    console.error(`\nrelease-check (${mode}): REFUSED: check:public failed`);
    process.exit(1);
  }
  console.log(`\nrelease-check (${mode}): ${s!.pass} passed${s!.todo ? `, ${s!.todo} todo` : ''}, nothing skipped${process.argv.includes('--tests-only') ? '' : ', check:public clean'}`);
}
