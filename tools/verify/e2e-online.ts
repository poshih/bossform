/**
 * Online E2E: a Chromium tab and a second browser (WebKit by default) join a room on the dev relay through the real
 * lobby UI, the host adds bots and starts, and the match runs over the relay with the requested link quality. Passing means
 * both machines stayed in lockstep (the engine compares state checksums every second and would report a desync), the
 * host's bots (a machine owning several seats) played, a graceful leave did not disturb the other machine, and neither
 * console showed an error.
 *   node tools/verify/e2e-online.ts <latencyMs> <jitterMs> <loss 0..1> <seconds> <webkit|chromium>
 * Needs `npm run build -w @bossform/game` first. Starts (and stops) its own relay (:4431) and static server (:4430).
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import type { Page } from 'playwright';
import { check, finish, info, section } from './lib.ts';

const [latency = '0', jitter = '0', loss = '0', seconds = '15', second = 'webkit'] = process.argv.slice(2);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RELAY_PORT = 4431;
const STATIC_PORT = 4430;
const URL_BASE = `http://127.0.0.1:${STATIC_PORT}/r/local-test/index.html`;
const RELAY_URL = `ws://127.0.0.1:${RELAY_PORT}/`;
const ROOM = `e2e-${Date.now()}`;
const TICK_RATE = 60;
const targetTicks = Number(seconds) * TICK_RATE;

const children: ChildProcess[] = [];
const spawnChild = (script: string, args: string[], env: Record<string, string> = {}): ChildProcess => {
  const child = spawn(process.execPath, [path.join(root, script), ...args], { env: { ...process.env, ...env }, stdio: 'ignore' });
  children.push(child);
  return child;
};

async function waitForPort(port: number): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`http://127.0.0.1:${port}/`);
      return;
    } catch (error) {
      if (error instanceof TypeError && String(error.cause).includes('ECONNREFUSED')) await new Promise((r) => setTimeout(r, 100));
      else return;
    }
  }
  throw new Error(`nothing listening on ${port}`);
}

interface Snapshot {
  screen: string;
  running: boolean;
  online?: boolean;
  status?: string;
  tick?: number;
  seats?: Array<{ name: string; active: boolean; alive: boolean }>;
  stats?: { stalledUpdates: number; packetsIn: number; packetsOut: number; rttMs: number };
}

const snapshot = (page: Page): Promise<Snapshot> => page.evaluate(() => (window as unknown as { __bossform: { debug(): unknown } }).__bossform.debug() as never);
async function until(page: Page, predicate: (s: Snapshot) => boolean, timeoutMs: number): Promise<Snapshot | null> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const s = await snapshot(page);
    if (predicate(s)) return s;
    await page.waitForTimeout(150);
  }
  return null;
}

spawnChild('tools/relay/server.ts', [String(RELAY_PORT)], { RELAY_LATENCY_MS: latency, RELAY_JITTER_MS: jitter, RELAY_LOSS: loss });
spawnChild('tools/verify/serve.ts', [String(STATIC_PORT), 'open']);
await waitForPort(RELAY_PORT);
await waitForPort(STATIC_PORT);

const launchArgs = { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] };
const browsers = [await chromium.launch(launchArgs), await (second === 'chromium' ? chromium : webkit).launch(second === 'chromium' ? launchArgs : {})];
const problems: string[] = [];
const pages: Page[] = [];
for (const [index, browser] of browsers.entries()) {
  const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
  const label = index === 0 ? 'host (chromium)' : `guest (${second})`;
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`${label}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`${label}: ${e.message}`));
  pages.push(page);
}
const [host, guest] = pages;

try {
  section(`lobby (${latency} ms +-${jitter}, ${Number(loss) * 100}% loss)`);
  for (const [index, page] of pages.entries()) {
    await page.goto(`${URL_BASE}?relay=${encodeURIComponent(RELAY_URL)}&name=${index === 0 ? 'ALPHA' : 'BRAVO'}`);
    await page.waitForFunction('window.__bossformStarted === true', null, { timeout: 60000 });
    await page.locator('[data-title-action="online"]').click();
    await page.locator('[data-room-input]').fill(ROOM);
    await page.locator('[data-lobby-join]').click();
    await page.waitForTimeout(600);
  }
  await host.waitForSelector('[data-lobby-content]', { timeout: 10000 });
  await host.waitForFunction(() => document.body.innerText.includes('BRAVO'), null, { timeout: 15000 });
  check('both players are listed in the room on the host', true);
  await host.locator('[data-lobby-add-bot]').click();
  await host.waitForTimeout(300);
  await host.locator('[data-lobby-add-bot]').click();
  await host.waitForTimeout(300);
  await guest.waitForFunction(() => document.body.innerText.match(/BOT|ALPHA/) !== null, null, { timeout: 10000 });
  await host.locator('[data-lobby-start]').click();

  section('the match, over the relay');
  const [hostGame, guestGame] = await Promise.all(pages.map((p) => until(p, (s) => s.screen === 'play' && s.online === true && (s.tick ?? 0) > 60, 60000)));
  check('the host and the guest both enter the online match', hostGame !== null && guestGame !== null);
  const hostReady = await until(host, (s) => (s.tick ?? 0) >= targetTicks, 240000);
  const guestReady = await until(guest, (s) => (s.tick ?? 0) >= targetTicks, 60000);
  const [h, g] = await Promise.all([snapshot(host), snapshot(guest)]);
  check(`both machines simulate ${targetTicks} ticks`, hostReady !== null && guestReady !== null, `host ${h.tick}, guest ${g.tick}`);
  check('both machines are still in lockstep (no desync, no abort)', h.status === 'running' && g.status === 'running', `${h.status} / ${g.status}`);
  check('four pilots: two humans and the host\'s two bots', h.seats?.length === 4 && g.seats?.length === 4);
  info(`host: ${h.stats?.stalledUpdates} stalled updates, rtt ${Math.round(h.stats?.rttMs ?? 0)} ms, ${h.stats?.packetsOut} packets out; guest: ${g.stats?.stalledUpdates} stalls, rtt ${Math.round(g.stats?.rttMs ?? 0)} ms`);

  section('a graceful leave');
  await guest.keyboard.press('Escape');
  await guest.locator('[data-pause-action="quit"]').click();
  const before = (await snapshot(host)).tick ?? 0;
  await host.waitForTimeout(3000);
  const after = await snapshot(host);
  check('the host plays on after the guest leaves, and the guest\'s ship is out of the match', after.status === 'running' && (after.tick ?? 0) > before + 30 && after.seats?.[1].active === false, `tick ${before} -> ${after.tick}, status ${after.status}`);
} finally {
  check('no console errors on either machine', problems.length === 0, problems.slice(0, 3).join(' | '));
  for (const browser of browsers) await browser.close();
  for (const child of children) if (child.pid) process.kill(child.pid);
}
finish(`e2e-online ${latency}ms ${loss}`);
