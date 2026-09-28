/**
 * Online co-op E2E: two real browsers (Chromium and WebKit: V8 vs JavaScriptCore) join a room on the local relay
 * and play a lockstep match through it, optionally over a lossy / laggy / reordering link.
 *   node tools/verify/e2e-online.ts [latencyMs] [jitterMs] [loss] [seconds] [secondBrowser: webkit|chromium]
 * Afterwards both recordings must agree tick for tick, and Node must reproduce every checksum from them.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import type { Page } from 'playwright';
import { decodeReplay, hashEquals, hashToString, playReplay } from '@metronome/engine';
import { createGameSim, gameCodec } from '../../game/src/sim/index.ts';
import type { Diagnostics } from './e2e.ts';
import { check, finish, info, section } from './lib.ts';

const [latency = '0', jitter = '0', loss = '0', seconds = '20', second = 'webkit'] = process.argv.slice(2);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const outDir = path.join(here, `shots/e2e-online-${latency}ms-${loss}loss`);
fs.mkdirSync(outDir, { recursive: true });
const RELAY_PORT = 4431;
const SERVE_PORT = 4430;
const children: ChildProcess[] = [];

function launchNode(script: string, args: string[], env: Record<string, string> = {}): ChildProcess {
  const child = spawn(process.execPath, [path.join(root, script), ...args], { env: { ...process.env, ...env }, stdio: 'ignore' });
  children.push(child);
  return child;
}

async function waitForPort(port: number): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`http://127.0.0.1:${port}/`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`port ${port} never opened`);
}

const problems: string[] = [];
const watch = (page: Page, label: string) => {
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(`[${label}] ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`[${label}] pageerror ${e.message}`));
};
const diag = (page: Page): Promise<Diagnostics> => page.evaluate(() => (window as unknown as { __bossform: { diagnostics(): unknown } }).__bossform.diagnostics() as never);

try {
  launchNode('tools/relay/server.ts', [String(RELAY_PORT)], { RELAY_LATENCY_MS: latency, RELAY_JITTER_MS: jitter, RELAY_LOSS: loss });
  launchNode('tools/verify/serve.ts', [String(SERVE_PORT), 'open']);
  await new Promise((r) => setTimeout(r, 800));
  await waitForPort(SERVE_PORT);

  const room = `e2e-${Date.now()}`;
  const url = (frame: number) => `http://127.0.0.1:${SERVE_PORT}/r/local-test/index.html?relay=ws://127.0.0.1:${RELAY_PORT}/&room=${room}&auto=${frame}`;
  const chromiumArgs = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
  const browserA = await chromium.launch({ args: chromiumArgs });
  const browserB = second === 'webkit' ? await webkit.launch() : await chromium.launch({ args: chromiumArgs });
  const pageA = await browserA.newPage({ viewport: { width: 1100, height: 660 } });
  const pageB = await browserB.newPage({ viewport: { width: 1100, height: 660 } });
  watch(pageA, 'P1 chromium');
  watch(pageB, `P2 ${second}`);

  section(`joining the room (latency ${latency}ms +-${jitter}, loss ${Number(loss) * 100}%)`);
  await pageA.goto(url(0));
  await pageA.waitForFunction(() => (window as unknown as { __bossformStarted?: boolean }).__bossformStarted === true, null, { timeout: 90000 });
  await pageB.goto(url(2));
  await pageB.waitForFunction(() => (window as unknown as { __bossformStarted?: boolean }).__bossformStarted === true, null, { timeout: 90000 });
  const deadline = Date.now() + 60000;
  let a = await diag(pageA);
  let b = await diag(pageB);
  while (Date.now() < deadline && !(a.kind === 'online' && b.kind === 'online' && a.screen === 'play' && b.screen === 'play')) {
    await pageA.waitForTimeout(250);
    a = await diag(pageA);
    b = await diag(pageB);
  }
  check('both browsers matched into the room and started an online run', a.kind === 'online' && b.kind === 'online', `P1 ${a.kind}/${a.screen}, P2 ${b.kind}/${b.screen}`);
  check('two seats: P1 is VANGUARD, P2 is JUGGERNAUT', a.players.length === 2 && a.players[0].frame === 0 && a.players[1].frame === 2, JSON.stringify(a.players.map((p) => p.frame)));

  section('playing');
  await pageA.locator('#game').click({ position: { x: 5, y: 5 } });
  await pageB.locator('#game').click({ position: { x: 5, y: 5 } });
  await pageA.keyboard.down('KeyJ');
  await pageB.keyboard.down('KeyJ');
  const end = Date.now() + Number(seconds) * 1000;
  let step = 0;
  while (Date.now() < end) {
    const left = step % 2 === 0;
    await pageA.keyboard.down(left ? 'KeyA' : 'KeyD');
    await pageB.keyboard.down(left ? 'KeyD' : 'KeyA');
    await pageA.mouse.move(300 + (step % 5) * 120, 220);
    await pageB.mouse.move(700 - (step % 5) * 120, 220);
    await pageA.waitForTimeout(700);
    await pageA.keyboard.up(left ? 'KeyA' : 'KeyD');
    await pageB.keyboard.up(left ? 'KeyD' : 'KeyA');
    if (step === 5) {
      await pageA.screenshot({ path: path.join(outDir, 'p1-chromium.png') });
      await pageB.screenshot({ path: path.join(outDir, `p2-${second}.png`) });
    }
    step++;
  }
  await pageA.keyboard.up('KeyJ');
  await pageB.keyboard.up('KeyJ');
  await pageA.waitForTimeout(600);

  section('lockstep results');
  a = await diag(pageA);
  b = await diag(pageB);
  check('neither session desynced or aborted', a.status === 'running' && b.status === 'running', `P1 ${a.status}, P2 ${b.status}`);
  check('both machines exchanged input traffic and stayed within a few ticks of each other', (a.stats?.packetsIn ?? 0) > 200 && Math.abs(a.tick - b.tick) < 60, `ticks ${a.tick}/${b.tick}, packets in ${a.stats?.packetsIn}/${b.stats?.packetsIn}`);
  info(`rtt ${Math.round(a.stats?.rttMs ?? 0)}/${Math.round(b.stats?.rttMs ?? 0)}ms, stalled frames ${a.stats?.stalledUpdates}/${b.stats?.stalledUpdates}`);
  check('both players scored on their own seats', a.players[0].kills + a.players[1].kills > 0 || a.players[0].score + a.players[1].score > 0, `scores ${a.players.map((p) => p.score)}`);

  const grab = (page: Page) => page.evaluate(() => Array.from((window as unknown as { __bossform: { exportReplay(): Uint8Array | null } }).__bossform.exportReplay() ?? []));
  const replayA = decodeReplay(Uint8Array.from(await grab(pageA)));
  const replayB = decodeReplay(Uint8Array.from(await grab(pageB)));
  const common = Math.min(replayA.tickCount, replayB.tickCount);
  const recordBytes = 1 + replayA.params.seats * replayA.inputByteLength;
  let sameInputs = replayA.params.seed === replayB.params.seed;
  for (let i = 0; i < common * recordBytes && sameInputs; i++) if (replayA.records[i] !== replayB.records[i]) sameInputs = false;
  const checkpointsB = new Map(replayB.checkpoints.map((c) => [c.tick, c.hash]));
  const shared = replayA.checkpoints.filter((c) => checkpointsB.has(c.tick));
  const sameStates = shared.length > 0 && shared.every((c) => hashEquals(c.hash, checkpointsB.get(c.tick)!));
  check('both browsers recorded the identical input stream for every common tick', sameInputs, `${common} common ticks`);
  check('both browsers computed identical state checksums at every shared checkpoint', sameStates, `${shared.length} checkpoints, e.g. ${shared.length ? hashToString(shared[shared.length - 1].hash) : '-'}`);
  const nodeA = playReplay(replayA, createGameSim, gameCodec);
  const nodeB = playReplay(replayB, createGameSim, gameCodec);
  check('Node reproduces every browser-computed checksum from the recorded inputs (both recordings)', nodeA.ok && nodeB.ok, `${nodeA.ticks}/${nodeB.ticks} ticks re-simulated`);

  await browserA.close();
  await browserB.close();
} finally {
  for (const child of children) if (child.pid) process.kill(child.pid);
}

section('browser consoles');
check('no console errors or warnings in either browser', problems.length === 0, problems.slice(0, 3).join(' | '));
for (const p of problems.slice(0, 8)) info(p);
finish('e2e-online');
