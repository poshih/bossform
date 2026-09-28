/**
 * One command for every browser-based check: builds the game, serves it under the hosting platform's strict CSP,
 * runs the E2E scenarios, the online co-op matches (Chromium vs WebKit, clean and hostile links), the cross-engine
 * determinism proof and the audio checks, then tears the servers down again.
 *   node tools/verify/browsers.ts
 * Needs Playwright's chromium, firefox and webkit (npx playwright install chromium firefox webkit).
 */
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const verify = (script: string) => path.join(root, 'tools/verify', script);
const STATIC_PORT = 4429;
const DEV_PORT = 4427;
const URL = `http://127.0.0.1:${STATIC_PORT}/r/local-test/index.html`;
const servers: ChildProcess[] = [];

interface Step {
  name: string;
  script: string;
  args: string[];
}

const STEPS: Step[] = [
  { name: 'E2E basic flow (1280x720)', script: 'e2e.ts', args: ['basic', '1280', '720', URL] },
  { name: 'E2E boss mode, all frames', script: 'e2e.ts', args: ['boss', '1280', '720', URL] },
  { name: 'E2E every boss fight: warning, phases, HP bar', script: 'e2e.ts', args: ['bosses', '1280', '720', URL] },
  { name: 'E2E local co-op with a gamepad', script: 'e2e.ts', args: ['coop', '1280', '720', URL] },
  { name: 'E2E layout 1920x1080', script: 'e2e.ts', args: ['layout', '1920', '1080', URL] },
  { name: 'E2E layout 560x480', script: 'e2e.ts', args: ['layout', '560', '480', URL] },
  { name: 'cross-engine determinism (V8, SpiderMonkey, JavaScriptCore)', script: 'cross-engine.ts', args: [] },
  { name: 'online co-op, Chromium vs WebKit, clean link', script: 'e2e-online.ts', args: ['0', '0', '0', '15', 'webkit'] },
  { name: 'online co-op, Chromium vs WebKit, 80ms +-60 / 15% loss', script: 'e2e-online.ts', args: ['80', '60', '0.15', '25', 'webkit'] },
  { name: 'audio engine', script: 'audio.ts', args: [] },
];

async function waitFor(port: number, path: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`http://127.0.0.1:${port}${path}`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`nothing listening on ${port}`);
}

let failed = 0;
try {
  const build = spawnSync('npm', ['run', 'build', '-w', '@bossform/game'], { cwd: root, encoding: 'utf8' });
  if (build.status !== 0) throw new Error(`build failed\n${build.stdout}\n${build.stderr}`);
  servers.push(spawn(process.execPath, [verify('serve.ts'), String(STATIC_PORT), 'hopinto'], { stdio: 'ignore' }));
  servers.push(spawn(path.join(root, 'node_modules/.bin/vite'), ['--port', String(DEV_PORT), '--strictPort'], { cwd: path.join(root, 'game'), stdio: 'ignore' }));
  await waitFor(STATIC_PORT, '/r/local-test/index.html');
  await waitFor(DEV_PORT, '/viewer.html');

  for (const step of STEPS) {
    const started = Date.now();
    const result = spawnSync(process.execPath, [verify(step.script), ...step.args], { cwd: root, encoding: 'utf8' });
    const lines = result.stdout.trim().split('\n');
    console.log(`${result.status === 0 ? 'ok  ' : 'FAIL'} ${step.name.padEnd(62)} ${lines[lines.length - 1]}  (${((Date.now() - started) / 1000).toFixed(0)}s)`);
    for (const line of lines.filter((l) => l.startsWith('FAIL'))) console.log(`       ${line}`);
    if (result.status !== 0) failed++;
  }
} finally {
  for (const server of servers) if (server.pid) process.kill(server.pid);
}
process.exit(failed > 0 ? 1 : 0);
