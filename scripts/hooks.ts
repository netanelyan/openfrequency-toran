// npm's `prepare`: point git at the tracked hooks, so the public check runs before every commit.
import { execFileSync } from 'node:child_process';
import { ROOT } from '../src/core/paths.ts';

try {
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: ROOT, stdio: 'ignore' });
  console.log('git hooks: .githooks (check:public before every commit)');
} catch {
  console.log('git hooks: not a git checkout, skipped');
}
