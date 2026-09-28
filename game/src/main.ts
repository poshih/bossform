import { App } from './app.ts';
import { AudioEngine } from './audio/audio.ts';
import { joinRoom } from './net/lobby.ts';
import { Renderer } from './render/renderer.ts';

declare global {
  interface Window {
    __bossformStarted?: boolean;
    __bossformBootFail?: (message: string) => void;
    __bossform?: App;
  }
}

const MAX_FRAME_SECONDS = 0.1;
const ONLINE_NOTICE_SECONDS = 30;

const boot = document.getElementById('boot')!;
const status = document.getElementById('boot-status')!;

function fail(message: string, error?: unknown): void {
  if (error) console.error(error);
  window.__bossformStarted = false;
  boot.classList.remove('done');
  window.__bossformBootFail?.(message);
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

async function start(): Promise<void> {
  const container = document.getElementById('app')!;
  const canvas = document.createElement('canvas');
  canvas.id = 'game';
  canvas.tabIndex = 0;
  canvas.setAttribute('aria-label', 'BOSSFORM game canvas');
  container.appendChild(canvas);

  status.textContent = 'Preparing graphics…';
  await nextFrame();
  let renderer: Renderer;
  try {
    renderer = new Renderer(canvas);
  } catch (error) {
    fail('WebGL is unavailable in this browser, so BOSSFORM cannot start. Try enabling hardware acceleration.', error);
    return;
  }
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    fail('The graphics context was lost. Retry to restart the game.');
  });

  const audio = new AudioEngine();
  const query = new URLSearchParams(location.search);
  const relayUrl = query.get('relay');
  const app = new App(renderer, audio, canvas, { online: relayUrl !== null });
  window.__bossform = app;
  if (relayUrl !== null) {
    app.requestOnline = (frame, difficulty) => {
      app.notify('CONNECTING TO THE RELAY...', ONLINE_NOTICE_SECONDS);
      joinRoom({ relayUrl, room: query.get('room') ?? 'lobby', frame, difficulty }, (message) => app.notify(message, ONLINE_NOTICE_SECONDS))
        .then((start) => app.startOnline(start))
        .catch((error: Error) => app.notify(`ONLINE FAILED: ${error.message.toUpperCase()}`, ONLINE_NOTICE_SECONDS));
    };
  }

  const resize = () => {
    const r = container.getBoundingClientRect();
    renderer.resize(Math.max(1, Math.floor(r.width)), Math.max(1, Math.floor(r.height)));
  };
  resize();
  new ResizeObserver(resize).observe(container);
  window.addEventListener('resize', resize);

  window.addEventListener('blur', () => app.onFocusLost());
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) app.onFocusLost();
    audio.suspendForHidden(document.hidden);
  });
  const unlock = () => audio.unlock();
  window.addEventListener('pointerdown', () => {
    canvas.focus({ preventScroll: true });
    unlock();
  });
  window.addEventListener('keydown', unlock);

  status.textContent = 'Compiling shaders…';
  await nextFrame();
  app.warmup();

  status.textContent = 'Starting…';
  const autoFrame = query.get('auto');
  if (relayUrl !== null && autoFrame !== null) app.requestOnline?.(Math.max(0, Math.min(2, Number(autoFrame) || 0)), 1);
  let last = performance.now();
  let started = false;
  const loop = (now: number) => {
    const dt = Math.min(MAX_FRAME_SECONDS, Math.max(0, (now - last) / 1000));
    last = now;
    try {
      app.update(dt, now);
      app.render();
    } catch (error) {
      fail('Something went wrong while running the game. Retry to restart it.', error);
      return;
    }
    if (!started) {
      started = true;
      window.__bossformStarted = true;
      boot.classList.add('done');
      canvas.focus({ preventScroll: true });
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame((t) => {
    last = t;
    loop(t);
  });
}

start().catch((error) => fail('BOSSFORM failed to start. Retry to load it again.', error));
