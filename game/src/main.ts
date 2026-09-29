import { App } from './app.ts';
import { AudioEngine } from './audio/audio.ts';
import { quickMatch } from './setup.ts';
import type { MatchSetup } from './setup.ts';

declare global {
  interface Window {
    __bossformStarted?: boolean;
    __bossformBootFail?: (message: string) => void;
    __bossform?: App;
  }
}

const MAX_FRAME_SECONDS = 0.1;
const DEFAULT_RELAY_PORT = 4431;
const DEFAULT_PLAYER_NAME = 'PILOT';
const MAX_TIMESCALE = 8;

const boot = document.getElementById('boot')!;
const status = document.getElementById('boot-status')!;

function fail(message: string, error?: unknown): void {
  if (error) console.error(error);
  window.__bossformStarted = false;
  boot.classList.remove('done');
  window.__bossformBootFail?.(message);
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/**
 * `?start=<mode>,<opponents>,<frame>,<seed>` skips the menus (mode 0 elimination / 1 deathmatch): a link straight into a
 * match. `&autoplay=1` lets a bot fly your seat too, so a whole match can be watched (or tested) hands-free.
 */
function parseStart(query: URLSearchParams): MatchSetup | null {
  const raw = query.get('start');
  if (raw === null) return null;
  const [mode, opponents, frame, seed] = raw.split(',').map(Number);
  const setup = quickMatch(mode, opponents, frame, seed);
  return query.get('autoplay') === '1' ? { ...setup, pilots: setup.pilots.map((pilot) => ({ ...pilot, bot: true })) } : setup;
}

async function start(): Promise<void> {
  const query = new URLSearchParams(location.search);
  const container = document.getElementById('app')!;
  const stageCanvas = document.getElementById('stage') as HTMLCanvasElement;
  const hudCanvas = document.getElementById('hud') as HTMLCanvasElement;
  status.textContent = 'Preparing graphics…';
  await nextFrame();

  const audio = new AudioEngine();
  let app: App;
  try {
    app = new App(
      { stageCanvas, hudCanvas, menusRoot: document.getElementById('menus')!, notice: document.getElementById('notice')! },
      {
        relayUrl: query.get('relay') ?? `ws://${location.hostname}:${DEFAULT_RELAY_PORT}/`,
        playerName: query.get('name') ?? DEFAULT_PLAYER_NAME,
        timescale: Math.min(MAX_TIMESCALE, Math.max(1, Math.floor(Number(query.get('timescale') ?? 1)))),
        start: parseStart(query),
        freezeOnWindup: query.has('freeze') ? Number(query.get('freeze')) : null,
      },
      audio,
    );
    app.begin();
  } catch (error) {
    fail('WebGL is unavailable in this browser, so BOSSFORM cannot start. Try enabling hardware acceleration.', error);
    return;
  }
  window.__bossform = app;
  stageCanvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    fail('The graphics context was lost. Retry to restart the game.');
  });

  const resize = () => {
    const box = container.getBoundingClientRect();
    app.resize(Math.max(1, Math.floor(box.width)), Math.max(1, Math.floor(box.height)), window.devicePixelRatio);
  };
  resize();
  new ResizeObserver(resize).observe(container);
  document.addEventListener('visibilitychange', () => audio.suspendForHidden(document.hidden));
  const unlock = () => audio.unlock();
  window.addEventListener('pointerdown', () => {
    stageCanvas.focus({ preventScroll: true });
    unlock();
  });
  window.addEventListener('keydown', unlock);

  status.textContent = 'Starting…';
  let last = performance.now();
  let started = false;
  const loop = (now: number) => {
    const dt = Math.min(MAX_FRAME_SECONDS, Math.max(0, (now - last) / 1000));
    last = now;
    try {
      app.frame(now, dt);
    } catch (error) {
      fail('Something went wrong while running the game. Retry to restart it.', error);
      return;
    }
    if (!started) {
      started = true;
      window.__bossformStarted = true;
      boot.classList.add('done');
      stageCanvas.focus({ preventScroll: true });
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame((t) => {
    last = t;
    loop(t);
  });
}

start().catch((error) => fail('BOSSFORM failed to start. Retry to load it again.', error));
