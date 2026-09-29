/**
 * Browser E2E for the whole game: real Chromium, real keyboard / mouse / gamepad events, the real WebGL pipeline.
 *   node tools/verify/e2e.ts <scenario> [width] [height] [baseUrl]
 * Scenarios: menus | play | match | bosses | pad | layout
 * Screenshots go to tools/verify/shots/e2e-<scenario>-<w>x<h>/. The console must stay free of errors and warnings.
 * Needs a server for the game (dev: `npm run dev` on :4427, or the static build).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { check, finish, info, section } from './lib.ts';

const [scenario = 'menus', w = '1280', h = '720', base = 'http://127.0.0.1:4427/'] = process.argv.slice(2);
const WIDTH = Number(w);
const HEIGHT = Number(h);
const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), `shots/e2e-${scenario}-${WIDTH}x${HEIGHT}`);
fs.mkdirSync(outDir, { recursive: true });

const PHASE_BATTLE = 1;
const PHASE_OVER = 3;
const FORM_BOSS = 2;

interface SeatInfo {
  name: string;
  alive: boolean;
  form: number;
  hp: number;
  gauge: number;
  x: number;
  y: number;
  kills: number;
  deaths: number;
}

interface Snapshot {
  screen: string;
  running: boolean;
  status?: string;
  tick?: number;
  phase?: number;
  round?: number;
  winner?: number;
  localSeat?: number;
  hash?: string;
  dropped?: number;
  projectiles?: number;
  neutrals?: number;
  orbs?: number;
  seats?: SeatInfo[];
}

/** A scripted gamepad the page polls exactly like hardware: window.__pad.axes / .buttons are set by the test. */
const FAKE_PAD = `
  window.__pad = { axes: [0, 0, 0, 0], buttons: {} };
  const buttonList = () => Array.from({ length: 17 }, (_, i) => ({ pressed: !!window.__pad.buttons[i], value: window.__pad.buttons[i] ? 1 : 0 }));
  navigator.getGamepads = () => [{ connected: true, id: 'test pad', index: 0, axes: window.__pad.axes, buttons: buttonList() }];
`;

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
if (scenario === 'pad') await page.addInitScript(FAKE_PAD);
const problems: string[] = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') problems.push(`[${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));

const snapshot = (): Promise<Snapshot> => page.evaluate(() => (window as unknown as { __bossform: { debug(): unknown } }).__bossform.debug() as never);
const shot = async (name: string): Promise<void> => {
  await page.screenshot({ path: path.join(outDir, `${name}.png`) });
};
const until = async (predicate: (s: Snapshot) => boolean, timeoutMs: number, stepMs = 100): Promise<Snapshot | null> => {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const s = await snapshot();
    if (predicate(s)) return s;
    await page.waitForTimeout(stepMs);
  }
  return null;
};
const open = async (query: string): Promise<void> => {
  await page.goto(new URL(query, base).toString());
  await page.waitForFunction('window.__bossformStarted === true', null, { timeout: 60000 });
};
const click = (selector: string) => page.locator(selector).first().click();
const visible = (selector: string) => page.locator(selector).first().isVisible();

/**
 * Share of pixels in a region of the SCREEN (a screenshot, so WebGL and 2D layers count exactly as the player sees them)
 * that are not near-black. The region is given as fractions of the window: x, y, width, height.
 */
async function litShare(region: readonly [number, number, number, number]): Promise<number> {
  const png = (await page.screenshot({ type: 'png' })).toString('base64');
  return page.evaluate(async ([data, [rx, ry, rw, rh]]) => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
    const sw = Math.max(1, Math.floor(bitmap.width * rw));
    const sh = Math.max(1, Math.floor(bitmap.height * rh));
    const canvas = document.createElement('canvas');
    canvas.width = 96;
    canvas.height = 54;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, Math.floor(bitmap.width * rx), Math.floor(bitmap.height * ry), sw, sh, 0, 0, 96, 54);
    const pixels = ctx.getImageData(0, 0, 96, 54).data;
    let lit = 0;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i] + pixels[i + 1] + pixels[i + 2] > 90) lit++;
    return lit / (96 * 54);
  }, [png, region] as const);
}

const WHOLE_SCREEN = [0, 0, 1, 1] as const;
/** Where the scoreboard and the local pilot panel live. */
const HUD_TOP_LEFT = [0, 0, 0.25, 0.45] as const;
const HUD_BOTTOM_CENTRE = [0.3, 0.72, 0.4, 0.28] as const;

async function menusScenario(): Promise<void> {
  section('title screen over a bot match');
  await open('index.html');
  await page.waitForTimeout(1500);
  const title = await snapshot();
  check('the title shows over a running bot match (attract mode)', title.screen === 'attract' && title.running === true && (title.tick ?? 0) > 0);
  for (const action of ['quick', 'custom', 'online', 'help']) check(`title button: ${action}`, await visible(`[data-title-action="${action}"]`));
  await shot('title');

  section('how to play');
  await click('[data-title-action="help"]');
  await page.waitForTimeout(300);
  check('the controls are listed', (await page.locator('text=Transform').count()) > 0 && (await page.locator('text=Ultima').count()) > 0);
  await shot('help');
  await click('[data-screen="title"]');

  section('quick battle: start, play, pause, resume, quit');
  await click('[data-title-action="quick"]');
  await page.waitForTimeout(300);
  await shot('setup');
  await click('[data-setup-start]');
  const started = await until((s) => s.screen === 'play' && (s.tick ?? 0) > 30, 10000);
  check('starting a quick battle enters the match', started !== null);
  const countdown = await until((s) => s.phase === PHASE_BATTLE, 15000);
  check('the countdown ends and the fight begins', countdown !== null);
  check('the menu is gone and the HUD is drawing', !(await visible('[data-title-action="quick"]')) && (await litShare(HUD_TOP_LEFT)) > 0.01 && (await litShare(HUD_BOTTOM_CENTRE)) > 0.01);
  await page.keyboard.press('Escape');
  const paused = await until((s) => s.screen === 'paused', 3000);
  const frozenAt = paused?.tick ?? -1;
  await page.waitForTimeout(700);
  const still = await snapshot();
  check('Escape pauses a single-machine match: the tick stops advancing', paused !== null && still.tick === frozenAt && (await visible('[data-pause-action="resume"]')));
  await shot('pause');
  await click('[data-pause-action="resume"]');
  const resumed = await until((s) => s.screen === 'play' && (s.tick ?? 0) > frozenAt + 20, 5000);
  check('resuming continues the match', resumed !== null);
  await page.keyboard.press('Escape');
  await until((s) => s.screen === 'paused', 3000);
  await click('[data-pause-action="quit"]');
  const back = await until((s) => s.screen === 'attract', 5000);
  check('quitting returns to the title over a new bot match', back !== null && (await visible('[data-title-action="quick"]')));
}

async function playScenario(): Promise<void> {
  section('real keyboard and mouse');
  await open('index.html?start=1,3,0,17');
  await until((s) => s.phase === PHASE_BATTLE, 15000);
  const before = (await snapshot()).seats![0];
  await page.keyboard.down('KeyD');
  await page.waitForTimeout(900);
  await page.keyboard.up('KeyD');
  const afterD = (await snapshot()).seats![0];
  check('holding D moves the ship to the right', afterD.x > before.x + 20, `${before.x.toFixed(0)} -> ${afterD.x.toFixed(0)}`);
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(700);
  await page.keyboard.up('KeyW');
  const afterW = (await snapshot()).seats![0];
  check('holding W moves the ship up', afterW.y > afterD.y + 15, `${afterD.y.toFixed(0)} -> ${afterW.y.toFixed(0)}`);

  const cx = WIDTH / 2;
  const cy = HEIGHT / 2;
  await page.mouse.move(cx + 200, cy - 80);
  const idle = (await snapshot()).projectiles ?? 0;
  await page.mouse.down();
  await page.waitForTimeout(900);
  const firing = await snapshot();
  await page.mouse.up();
  check('holding the left mouse button fires (projectiles appear)', (firing.projectiles ?? 0) > idle + 2, `${idle} -> ${firing.projectiles}`);
  check('the scene and the HUD are drawn', (await litShare(WHOLE_SCREEN)) > 0.05 && (await litShare(HUD_TOP_LEFT)) > 0.01);
  await shot('play');

  section('the pilot can be hurt, dies, and the camera goes on');
  const dead = await until((s) => s.seats![0].alive === false, 90000, 500);
  info(dead !== null ? 'the idle pilot was destroyed by the bots' : 'the idle pilot survived 90 s');
  await shot('later');
  check('the match keeps running without errors', (await snapshot()).status === 'running');
}

async function matchScenario(): Promise<void> {
  section('a whole elimination match, hands-free, to the results and back');
  await open('index.html?start=0,1,0,5&timescale=8&autoplay=1');
  const over = await until((s) => s.phase === PHASE_OVER, 240000, 500);
  check('the match ends by the rules (best of three rounds)', over !== null, over ? `round ${over.round}, winner team ${over.winner}` : 'timed out');
  await shot('over');
  const results = await until((s) => s.screen === 'results', 20000, 300);
  check('the results screen appears', results !== null && (await visible('[data-results-action="rematch"]')));
  await shot('results');
  await click('[data-results-action="rematch"]');
  const again = await until((s) => s.screen === 'play' && (s.tick ?? 0) > 20, 10000);
  check('rematch starts a fresh match', again !== null && again.phase !== PHASE_OVER);
  await page.waitForTimeout(500);
  await page.evaluate(() => (window as unknown as { __bossform: { debug(): unknown } }).__bossform.debug());
}

async function bossesScenario(): Promise<void> {
  section('bot pilots transform, fight as colossi and tear each other apart');
  await open('index.html?start=1,7,0,42&timescale=8&autoplay=1');
  const boss = await until((s) => s.seats!.some((seat) => seat.form === FORM_BOSS), 120000, 250);
  check('a pilot transforms into a colossus', boss !== null);
  await shot('boss-form');
  const end = Date.now() + 60000;
  while (Date.now() < end && ((await snapshot()).tick ?? 0) <= 11000) await page.waitForTimeout(500);
  const last = await snapshot();
  check('the deathmatch plays on without errors and without exhausting the projectile pool', last.status === 'running' && last.dropped === 0);
  check('pilots were destroyed by then', last.seats!.some((seat) => seat.deaths > 0));
  await shot('late');
}

async function padScenario(): Promise<void> {
  section('a gamepad');
  await open('index.html?start=1,3,1,23');
  await until((s) => s.phase === PHASE_BATTLE, 15000);
  const before = (await snapshot()).seats![0];
  await page.evaluate(() => { (window as unknown as { __pad: { axes: number[] } }).__pad.axes = [1, 0, 0, 0]; });
  await page.waitForTimeout(800);
  const moved = (await snapshot()).seats![0];
  check('the left stick moves the ship', moved.x > before.x + 20, `${before.x.toFixed(0)} -> ${moved.x.toFixed(0)}`);
  const idle = (await snapshot()).projectiles ?? 0;
  await page.evaluate(() => { const p = (window as unknown as { __pad: { axes: number[]; buttons: Record<number, boolean> } }).__pad; p.axes = [0, 0, 0, -1]; p.buttons[7] = true; });
  await page.waitForTimeout(800);
  check('the right trigger fires and the right stick aims (projectiles appear)', ((await snapshot()).projectiles ?? 0) > idle + 2);
  await page.evaluate(() => { const p = (window as unknown as { __pad: { axes: number[]; buttons: Record<number, boolean> } }).__pad; p.axes = [0, 0, 0, 0]; p.buttons[7] = false; p.buttons[9] = true; });
  const paused = await until((s) => s.screen === 'paused', 3000);
  check('Start pauses', paused !== null);
  await page.evaluate(() => { (window as unknown as { __pad: { buttons: Record<number, boolean> } }).__pad.buttons[9] = false; });
  await shot('pad');
}

async function layoutScenario(): Promise<void> {
  section(`layout at ${WIDTH}x${HEIGHT}`);
  await open('index.html');
  await page.waitForTimeout(800);
  await shot('title');
  const overflow = await page.evaluate(() => ({ x: document.documentElement.scrollWidth > window.innerWidth + 1, y: document.documentElement.scrollHeight > window.innerHeight + 1 }));
  check('the title fits the window without page scrolling', !overflow.x && !overflow.y, JSON.stringify(overflow));
  await click('[data-title-action="quick"]');
  await page.waitForTimeout(400);
  await shot('setup');
  check('the start button is reachable', await visible('[data-setup-start]'));
  await click('[data-setup-start]');
  await until((s) => s.phase === PHASE_BATTLE, 20000);
  await page.waitForTimeout(800);
  await shot('match');
  check('the scene and the HUD are drawn at this size', (await litShare(WHOLE_SCREEN)) > 0.05 && (await litShare(HUD_TOP_LEFT)) > 0.005);
}

const scenarios: Record<string, () => Promise<void>> = { menus: menusScenario, play: playScenario, match: matchScenario, bosses: bossesScenario, pad: padScenario, layout: layoutScenario };
if (!(scenario in scenarios)) throw new Error(`unknown scenario "${scenario}"`);
await scenarios[scenario]();
check('the browser console stayed free of errors and warnings', problems.length === 0, problems.slice(0, 4).join(' | '));
await browser.close();
finish(`e2e ${scenario}`);
