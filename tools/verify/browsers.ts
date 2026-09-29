/**
 * One command for every browser-based check: builds the game, serves it under the hosting platform's strict CSP,
 * runs the E2E scenarios, the online matches (Chromium vs WebKit, clean and hostile links), the cross-engine determinism
 * proof and the audio checks. Servers that already answer (your own `npm run dev`) are reused and left running; the ones it
 * starts are stopped at the end.
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
  { name: 'E2E menus: title, help, quick battle, pause, quit (1280x720)', script: 'e2e.ts', args: ['menus', '1280', '720', URL] },
  { name: 'E2E real keyboard and mouse (1280x720)', script: 'e2e.ts', args: ['play', '1280', '720', URL] },
  { name: 'E2E gamepad (1280x720)', script: 'e2e.ts', args: ['pad', '1280', '720', URL] },
  { name: 'E2E bot pilots become colossi and tear each other apart (960x540)', script: 'e2e.ts', args: ['bosses', '960', '540', URL] },
  { name: 'E2E a whole elimination match, results, rematch (640x360)', script: 'e2e.ts', args: ['match', '640', '360', URL] },
  { name: 'E2E layout 1920x1080', script: 'e2e.ts', args: ['layout', '1920', '1080', URL] },
  { name: 'E2E layout 560x480', script: 'e2e.ts', args: ['layout', '560', '480', URL] },
  { name: 'E2E layout 420x800 (portrait)', script: 'e2e.ts', args: ['layout', '420', '800', URL] },
  { name: 'cross-engine determinism (V8, SpiderMonkey, JavaScriptCore)', script: 'cross-engine.ts', args: [] },
  { name: 'online, Chromium vs WebKit, clean link', script: 'e2e-online.ts', args: ['0', '0', '0', '15', 'webkit'] },
  { name: 'online, Chromium vs WebKit, 80ms +-60 / 15% loss', script: 'e2e-online.ts', args: ['80', '60', '0.15', '25', 'webkit'] },
  { name: 'audio engine', script: 'audio.ts', args: [] },
];

async function isUp(port: number, path: string): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}${path}`);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(port: number, path: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await isUp(port, path)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`nothing listening on ${port}`);
}

/** Uses a server that is already answering (a developer's own dev server stays up); otherwise starts one and stops it at the end. */
async function ensureServer(port: number, path: string, start: () => ChildProcess): Promise<void> {
  if (await isUp(port, path)) return;
  servers.push(start());
  await waitFor(port, path);
}

let failed = 0;
try {
  const build = spawnSync('npm', ['run', 'build', '-w', '@bossform/game'], { cwd: root, encoding: 'utf8' });
  if (build.status !== 0) throw new Error(`build failed\n${build.stdout}\n${build.stderr}`);
  await ensureServer(STATIC_PORT, '/r/local-test/index.html', () => spawn(process.execPath, [verify('serve.ts'), String(STATIC_PORT), 'hopinto'], { stdio: 'ignore' }));
  await ensureServer(DEV_PORT, '/viewer.html', () => spawn(path.join(root, 'node_modules/.bin/vite'), ['--port', String(DEV_PORT), '--strictPort'], { cwd: path.join(root, 'game'), stdio: 'ignore' }));

  for (const step of STEPS) {
    const started = Date.now();
    const result = spawnSync(process.execPath, [verify(step.script), ...step.args], { cwd: root, encoding: 'utf8' });
    const lines = result.stdout.trim().split('\n');
    console.log(`${result.status === 0 ? 'ok  ' : 'FAIL'} ${step.name.padEnd(62)} ${lines[lines.length - 1]}  (${((Date.now() - started) / 1000).toFixed(0)}s)`);
    for (const line of lines.filter((l) => l.startsWith('FAIL'))) console.log(`       ${line}`);
    if (result.status !== 0) failed++;
  }
} finally {
  for (const server of servers) if (server.pid !== undefined && server.exitCode === null) process.kill(server.pid);
}
process.exit(failed > 0 ? 1 : 0);
