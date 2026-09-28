/** Runs every headless eval script in order and summarises. (Browser checks: `npm run verify:browsers`.) */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = ['boundary.ts', 'engine-numerics.ts', 'engine-lockstep.ts', 'engine-hostile.ts', 'engine-standalone.ts', 'game-eval.ts'];

let failed = 0;
for (const script of SCRIPTS) {
  const started = Date.now();
  const result = spawnSync(process.execPath, [path.join(dir, script)], { encoding: 'utf8' });
  const lines = result.stdout.trim().split('\n');
  const summary = lines[lines.length - 1];
  const failures = lines.filter((l) => l.startsWith('FAIL'));
  console.log(`${result.status === 0 ? 'ok  ' : 'FAIL'} ${script.padEnd(22)} ${summary}  (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  for (const f of failures) console.log(`       ${f}`);
  if (result.status !== 0) {
    failed++;
    if (result.stderr) console.log(result.stderr.trim());
  }
}
process.exit(failed > 0 ? 1 : 0);
