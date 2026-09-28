/**
 * Browser E2E for the whole game (real Chromium, real input events, the real low-res WebGL pipeline).
 *   node tools/verify/e2e.ts <scenario> [width] [height] [baseUrl]
 * Scenarios: basic | frames | boss | layout | coop | replay
 * Screenshots go to tools/verify/shots/e2e-<scenario>/ . The console must stay free of errors/warnings.
 * Needs a running server for the game (dev: `npm run dev -w @bossform/game` on :4427, or the preview build).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import { check, finish, info, section } from './lib.ts';

const [scenario = 'basic', w = '1280', h = '720', base = 'http://127.0.0.1:4427/'] = process.argv.slice(2);
const WIDTH = Number(w);
const HEIGHT = Number(h);
const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), `shots/e2e-${scenario}-${WIDTH}x${HEIGHT}`);
fs.mkdirSync(outDir, { recursive: true });

export interface Diagnostics {
  screen: string;
  kind: string | null;
  tick: number;
  status: string | null;
  phase: number | null;
  stage: number | null;
  hash: string | null;
  players: Array<{ hp: number; lives: number; gauge: number; boss: number; score: number; kills: number; x: number; y: number; aim: number; frame: number }>;
  stats: { stalledUpdates: number; packetsIn: number; rttMs: number } | null;
}

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
const problems: string[] = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));

const diag = (): Promise<Diagnostics> => page.evaluate(() => (window as unknown as { __bossform: { diagnostics(): unknown } }).__bossform.diagnostics() as never);
const shot = async (name: string) => { await page.screenshot({ path: path.join(outDir, `${name}.png`) }); };
const tap = async (key: string, ms = 60) => { await page.keyboard.down(key); await page.waitForTimeout(ms); await page.keyboard.up(key); };
const until = async (predicate: (d: Diagnostics) => boolean, timeoutMs: number, stepMs = 100): Promise<boolean> => {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (predicate(await diag())) return true;
    await page.waitForTimeout(stepMs);
  }
  return false;
};
/** Test hook: the live world of the current run (solo/local runs only; injecting state online would desync). */
const setGauge = (seat: number, value: number) =>
  page.evaluate(({ seat: s, value: v }) => {
    const world = (window as unknown as { __bossform: { debugWorld(): { m: { plGauge: Int32Array } } } }).__bossform.debugWorld();
    world.m.plGauge[s] = v;
  }, { seat, value });

/** Title -> START -> pick the frame at `index` -> in the play screen with the stage intro over. */
async function startSolo(frameIndex: number): Promise<void> {
  await tap('Enter');
  await page.waitForTimeout(400);
  for (let i = 0; i < frameIndex; i++) await tap('ArrowRight');
  await page.waitForTimeout(150);
  await tap('Enter');
  await until((d) => d.screen === 'play', 5000);
  await until((d) => d.phase === 1, 8000);
}

async function returnToTitle(): Promise<void> {
  await tap('Escape');
  await page.waitForTimeout(300);
  for (let i = 0; i < 3; i++) await tap('ArrowDown');
  await tap('Enter');
  await until((d) => d.screen === 'title', 5000);
  await page.waitForTimeout(400);
}

async function boot(): Promise<void> {
  await page.goto(base);
  await page.waitForFunction(() => (window as unknown as { __bossformStarted?: boolean }).__bossformStarted === true, null, { timeout: 90000 });
  await page.locator('#game').click({ position: { x: 4, y: 4 } });
  await page.waitForTimeout(600);
}

try {
  await boot();
  const first = await diag();
  check('game boots to the title screen with a live attract demo', first.screen === 'title' && first.kind === 'demo' && first.tick > 0, JSON.stringify({ screen: first.screen, kind: first.kind, tick: first.tick }));
  await page.waitForTimeout(1500);
  await shot('01-title');

  if (scenario === 'basic') {
    section('title -> select -> play');
    await tap('Enter');
    await page.waitForTimeout(700);
    check('START opens frame select', (await diag()).screen === 'select');
    await shot('02-select-vanguard');
    await tap('ArrowRight');
    await page.waitForTimeout(500);
    await shot('03-select-gale');
    await tap('ArrowRight');
    await page.waitForTimeout(500);
    await shot('04-select-juggernaut');
    await tap('ArrowLeft');
    await tap('ArrowLeft');
    await page.waitForTimeout(200);
    await tap('Enter');
    await until((d) => d.screen === 'play', 5000);
    check('choosing a frame starts the run', (await diag()).screen === 'play');
    await page.waitForTimeout(3200);
    await shot('05-play-intro');

    section('twin-stick: move and aim independently');
    const before = (await diag()).players[0];
    await page.mouse.move(WIDTH * 0.72, HEIGHT * 0.25);
    await page.keyboard.down('KeyD');
    await page.mouse.down();
    await page.waitForTimeout(900);
    const mid = (await diag()).players[0];
    await shot('06-move-right-aim-up-right');
    await page.keyboard.up('KeyD');
    await page.keyboard.down('KeyA');
    await page.mouse.move(WIDTH * 0.3, HEIGHT * 0.3);
    await page.waitForTimeout(900);
    const after = (await diag()).players[0];
    await shot('07-move-left-aim-up-left');
    await page.keyboard.up('KeyA');
    await page.mouse.up();
    check('WASD moved the robot right then left', mid.x > before.x + 20 && after.x < mid.x - 20, `x ${before.x.toFixed(0)} -> ${mid.x.toFixed(0)} -> ${after.x.toFixed(0)}`);
    check('aim follows the mouse independently of movement', Math.abs(mid.aim - after.aim) > 3000, `aim ${mid.aim} -> ${after.aim}`);

    section('combat runs');
    await page.mouse.down();
    for (let i = 0; i < 30; i++) {
      await page.mouse.move(WIDTH * (0.36 + 0.28 * ((i % 10) / 9)), HEIGHT * 0.35);
      await page.waitForTimeout(200);
      if (i === 24) await shot('08-combat');
    }
    await page.mouse.up();
    const fight = await diag();
    check('enemies are being destroyed and score accrues', fight.players[0].kills > 0 && fight.players[0].score > 0, `kills ${fight.players[0].kills}, score ${fight.players[0].score}`);

    section('pause / resume / mute');
    await tap('Escape');
    await page.waitForTimeout(500);
    const paused = await diag();
    await shot('09-paused');
    await page.waitForTimeout(600);
    const stillPaused = await diag();
    check('Esc pauses: the simulation stops advancing', paused.screen === 'pause' && stillPaused.tick === paused.tick, `tick ${paused.tick} -> ${stillPaused.tick}`);
    await tap('Escape');
    await page.waitForTimeout(600);
    check('Esc again resumes', (await diag()).tick > paused.tick);
  }

  if (scenario === 'boss') {
    const names = ['VANGUARD', 'GALE', 'JUGGERNAUT'];
    for (let frame = 0; frame < 3; frame++) {
      section(`boss mode: ${names[frame]}`);
      await startSolo(frame);
      await page.mouse.move(WIDTH * 0.5, HEIGHT * 0.3);
      await page.mouse.down();
      await page.waitForTimeout(2500);
      await setGauge(0, 1000);
      await page.waitForTimeout(250);
      const ready = (await diag()).players[0];
      await shot(`${frame}-1-ready`);
      await tap('Space');
      await page.waitForTimeout(350);
      const start = (await diag()).players[0];
      await shot(`${frame}-2-transforming`);
      await page.waitForTimeout(650);
      await shot(`${frame}-3-transformed`);
      const active = (await diag()).players[0];
      await page.keyboard.down('KeyD');
      await page.mouse.click(WIDTH * 0.5, HEIGHT * 0.3, { button: 'right' });
      await page.waitForTimeout(1500);
      await shot(`${frame}-4-boss-mode-firing`);
      await page.keyboard.up('KeyD');
      await page.waitForTimeout(1000);
      await shot(`${frame}-5-boss-mode-later`);
      const later = (await diag()).players[0];
      check(`${names[frame]}: gauge full is reported before transforming`, ready.gauge >= 1000 && ready.boss === 0, `gauge ${ready.gauge}`);
      check(`${names[frame]}: BOSS button starts the transformation`, start.boss > 0, `boss ticks ${start.boss}`);
      check(`${names[frame]}: boss mode is active with the gauge draining`, active.boss > 0 && later.boss < active.boss + 300 && later.gauge < 1000, `remaining ${active.boss} -> ${later.boss}`);
      await page.mouse.up();
      await returnToTitle();
    }
  }
} finally {
  await browser.close();
}

section('browser console');
check('no console errors or warnings', problems.length === 0, problems.slice(0, 3).join(' | '));
for (const p of problems.slice(0, 10)) info(p);
finish(`e2e:${scenario}`);
