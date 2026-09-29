import { fx } from '@metronome/engine';
import { Bot } from './bot/bot.ts';
import { TEAM_COLORS } from './config.ts';
import { evenTeams, freeForAllTeams } from './setup.ts';
import { Hud } from './ui/hud.ts';
import { createGameSim, encodeConfig, Form, FRAME_COUNT, MAX_PLAYERS, Mode, NEUTRAL_INPUT } from './sim/index.ts';
import type { GameInput } from './sim/index.ts';

declare global {
  interface Window { ready?: boolean; }
}

const BACKGROUND = '#04070f';
const GRID_MAJOR = 'rgba(111, 227, 255, 0.1)';
const GRID_MINOR = 'rgba(111, 227, 255, 0.04)';
const RIM_COLOR = 'rgba(111, 227, 255, 0.28)';
const SAFE_COLOR = 'rgba(255, 110, 130, 0.18)';
const WORLD_VIEW_HEIGHT = 520;
const CURSOR_DISTANCE = 180;
const FIXED_STEP = 1 / 60;

const query = new URLSearchParams(location.search);
const seatCount = clampInt(query.get('seats'), 6, 2, MAX_PLAYERS);
const localSeat = clampInt(query.get('seat'), 0, 0, seatCount - 1);
const mode = clampInt(query.get('mode'), Mode.Elimination, Mode.Elimination, Mode.Deathmatch);
const fastForward = clampInt(query.get('ticks'), 0, 0, 12_000);
const teams = mode === Mode.Deathmatch ? evenTeams(seatCount, Math.min(2, seatCount)) : freeForAllTeams(seatCount);
const config = encodeConfig({ mode, seats: Array.from({ length: seatCount }, (_, seat) => ({ frame: seat % FRAME_COUNT, team: teams[seat] })) });
const sim = createGameSim({ seed: 424242, seats: seatCount, config });
const hud = new Hud();
const bots = Array.from({ length: seatCount }, (_, seat) => new Bot(seat, 9000 + seat * 17, 0.85));
const names = Array.from({ length: seatCount }, (_, seat) => `PILOT ${seat + 1}`);
const canvas = document.querySelector('canvas')!;
const ctx = canvas.getContext('2d')!;

let cssWidth = 1;
let cssHeight = 1;
let accumulator = 0;
let last = performance.now();
let ready = false;

for (let i = 0; i < fastForward; i++) stepSim();

function clampInt(value: string | null, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.floor(parsed))) : fallback;
}

function resize(): void {
  const ratio = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
  cssWidth = Math.max(1, Math.floor(window.innerWidth));
  cssHeight = Math.max(1, Math.floor(window.innerHeight));
  canvas.width = Math.floor(cssWidth * ratio);
  canvas.height = Math.floor(cssHeight * ratio);
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
}

function lead(): { x: number; y: number; zoom: number; cursor: { x: number; y: number } } {
  const { m } = sim.world;
  const angle = fx.toRadians(m.plAim[localSeat]);
  const baseZoom = m.plForm[localSeat] === Form.Boss ? 0.84 : 1;
  return {
    x: fx.toFloat(m.plX[localSeat]) + Math.cos(angle) * 70,
    y: fx.toFloat(m.plY[localSeat]) + Math.sin(angle) * 50,
    zoom: baseZoom,
    cursor: {
      x: fx.toFloat(m.plX[localSeat]) + Math.cos(angle) * CURSOR_DISTANCE,
      y: fx.toFloat(m.plY[localSeat]) + Math.sin(angle) * CURSOR_DISTANCE,
    },
  };
}

function project(worldX: number, worldY: number, out: { x: number; y: number }): void {
  const camera = lead();
  const unitsPerPixel = (WORLD_VIEW_HEIGHT / camera.zoom) / cssHeight;
  out.x = cssWidth * 0.5 + (fx.toFloat(worldX) - camera.x) / unitsPerPixel;
  out.y = cssHeight * 0.5 - (fx.toFloat(worldY) - camera.y) / unitsPerPixel;
}

function stepSim(): void {
  const inputs: GameInput[] = Array.from({ length: seatCount }, (_, seat) => bots[seat]?.think(sim.world) ?? NEUTRAL_INPUT);
  const present = Array.from({ length: seatCount }, () => true);
  sim.step({ tick: sim.world.m.world[0], inputs, present });
  hud.handleEvents(sim.world);
  sim.world.events.clear();
}

function drawBackdrop(): void {
  ctx.fillStyle = BACKGROUND;
  ctx.fillRect(0, 0, cssWidth, cssHeight);
  const camera = lead();
  const unitsPerPixel = (WORLD_VIEW_HEIGHT / camera.zoom) / cssHeight;
  const minorStep = 80;
  const majorStep = minorStep * 4;
  const minX = camera.x - cssWidth * 0.5 * unitsPerPixel;
  const maxX = camera.x + cssWidth * 0.5 * unitsPerPixel;
  const minY = camera.y - cssHeight * 0.5 * unitsPerPixel;
  const maxY = camera.y + cssHeight * 0.5 * unitsPerPixel;
  ctx.lineWidth = 1;
  for (const step of [minorStep, majorStep]) {
    ctx.strokeStyle = step === minorStep ? GRID_MINOR : GRID_MAJOR;
    const startX = Math.floor(minX / step) * step;
    for (let x = startX; x <= maxX; x += step) {
      const px = cssWidth * 0.5 + (x - camera.x) / unitsPerPixel;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, cssHeight);
      ctx.stroke();
    }
    const startY = Math.floor(minY / step) * step;
    for (let y = startY; y <= maxY; y += step) {
      const py = cssHeight * 0.5 - (y - camera.y) / unitsPerPixel;
      ctx.beginPath();
      ctx.moveTo(0, py);
      ctx.lineTo(cssWidth, py);
      ctx.stroke();
    }
  }
  const arenaPoint = { x: 0, y: 0 };
  project(0, 0, arenaPoint);
  ctx.strokeStyle = RIM_COLOR;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(arenaPoint.x, arenaPoint.y, fx.toFloat(sim.world.arenaR) / unitsPerPixel, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = SAFE_COLOR;
  ctx.beginPath();
  ctx.arc(arenaPoint.x, arenaPoint.y, fx.toFloat(sim.world.m.world[5]) / unitsPerPixel, 0, Math.PI * 2);
  ctx.stroke();
}

function drawWorld(): void {
  const point = { x: 0, y: 0 };
  for (let seat = 0; seat < sim.world.seats; seat++) {
    if (sim.world.m.plAlive[seat] !== 1) continue;
    project(sim.world.m.plX[seat], sim.world.m.plY[seat], point);
    const radius = sim.world.m.plForm[seat] === Form.Boss ? 16 : 8;
    ctx.beginPath();
    ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = `#${TEAM_COLORS[sim.world.m.plTeam[seat] % TEAM_COLORS.length].toString(16).padStart(6, '0')}`;
    ctx.fill();
    const aim = fx.toRadians(sim.world.m.plAim[seat]);
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.beginPath();
    ctx.moveTo(point.x, point.y);
    ctx.lineTo(point.x + Math.cos(aim) * radius * 2, point.y - Math.sin(aim) * radius * 2);
    ctx.stroke();
  }
}

function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  accumulator += dt;
  while (accumulator >= FIXED_STEP) {
    accumulator -= FIXED_STEP;
    stepSim();
  }
  drawBackdrop();
  drawWorld();
  const cursorWorld = lead().cursor;
  const cursor = { x: 0, y: 0 };
  project(fx.lit(cursorWorld.x), fx.lit(cursorWorld.y), cursor);
  hud.draw(ctx, {
    world: sim.world,
    seat: localSeat,
    names,
    width: cssWidth,
    height: cssHeight,
    project,
    time: performance.now() / 1000,
    cursor,
  });
  if (!ready) {
    ready = true;
    window.ready = true;
  }
  requestAnimationFrame(frame);
}

resize();
window.addEventListener('resize', resize);
requestAnimationFrame(frame);
