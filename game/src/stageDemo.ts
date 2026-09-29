import { createGameSim } from './sim/index.ts';
import { BeatClock } from './beat.ts';
import { Bot } from './bot/bot.ts';
import { encodeConfig, Frame, Mode, TICK_RATE, type MatchConfig, type SeatConfig } from './sim/index.ts';
import type { GameInput } from './sim/index.ts';
import { Stage } from './view/stage.ts';

interface DemoWindow extends Window {
  ready?: boolean;
  __stats?: { averageMs: number; samples: number };
}

const STEP_SECONDS = 1 / TICK_RATE;
const MAX_FRAME_SECONDS = 0.1;
const STATS_PRINT_INTERVAL = 120;
const FOLLOW_BOSS_LIMIT = 12000;

const query = new URLSearchParams(location.search);
const inferredSeats = inferSeats();
const seats = clampInt(query.get('seats'), inferredSeats, 2, 8);
const seat = clampInt(query.get('seat'), 0, 0, seats - 1);
const mode = clampInt(query.get('mode'), Mode.Deathmatch, Mode.Elimination, Mode.Deathmatch);
const preTicks = clampInt(query.get('ticks'), 0, 0, 20000);
const frameOverride = query.get('frame');
const followBoss = query.get('followBoss') === '1';
const statsEnabled = query.get('stats') === '1';
const seed = clampInt(query.get('seed'), 1337, 0, 0xffffffff);
const canvas = document.getElementById('c') as HTMLCanvasElement;
bootStage();

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const value = raw === null ? fallback : Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function parseTeams(count: number): number[] {
  const spec = query.get('teams');
  if (spec === null || spec === 'ffa') return Array.from({ length: count }, (_, index) => index);
  const groups = spec.split('v').map(Number);
  if (groups.some((group) => !Number.isInteger(group) || group <= 0)) throw new RangeError(`invalid teams spec "${spec}"`);
  const total = groups.reduce((sum, group) => sum + group, 0);
  if (total !== count) throw new RangeError(`teams spec "${spec}" needs ${total} seats, not ${count}`);
  const out: number[] = [];
  groups.forEach((group, team) => {
    for (let i = 0; i < group; i++) out.push(team);
  });
  return out;
}

function inferSeats(): number {
  const spec = query.get('teams');
  if (spec === null || spec === 'ffa') return 8;
  const groups = spec.split('v').map(Number);
  if (groups.some((group) => !Number.isInteger(group) || group <= 0)) return 8;
  return groups.reduce((sum, group) => sum + group, 0);
}

function frameFor(index: number): number {
  if (index === seat && frameOverride !== null) return clampInt(frameOverride, Frame.Vanguard, Frame.Vanguard, Frame.Juggernaut);
  return index % 3;
}

function createConfig(count: number): MatchConfig {
  const teams = parseTeams(count);
  const seatsConfig: SeatConfig[] = [];
  for (let index = 0; index < count; index++) seatsConfig.push({ frame: frameFor(index), team: teams[index] });
  return { mode, seats: seatsConfig };
}

function bootStage(): Stage {
  const config = createConfig(seats);
  const sim = createGameSim({ seed, seats, config: encodeConfig(config) });
  const world = sim.world;
  const bots = Array.from({ length: seats }, (_, index) => new Bot(index, seed ^ ((index + 1) * 0x9e3779b1), 0.85));
  const stageInstance = new Stage(canvas, world);
  stageInstance.focus(seat);

  const resize = () => stageInstance.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio);
  resize();
  window.addEventListener('resize', resize);

  const step = (tick: number): void => {
    const inputs: GameInput[] = bots.map((bot) => bot.think(world));
    sim.step({ tick, inputs, present: inputs.map(() => true) });
    stageInstance.tick(world);
    stageInstance.handleEvents(world);
    world.events.clear();
  };

  let simulated = 0;
  while (simulated < preTicks) {
    step(simulated);
    simulated++;
  }
  if (followBoss) {
    while (simulated < preTicks + FOLLOW_BOSS_LIMIT && world.m.plForm[seat] !== 2) {
      step(simulated);
      simulated++;
    }
  }

  let accumulator = 0;
  let last = performance.now();
  const beatClock = new BeatClock();
  let frameCounter = 0;
  let totalRenderMs = 0;
  let ready = false;

  const loop = (now: number) => {
    const dt = Math.min(MAX_FRAME_SECONDS, Math.max(0, (now - last) / 1000));
    last = now;
    accumulator += dt;
    while (accumulator >= STEP_SECONDS) {
      step(simulated);
      simulated++;
      accumulator -= STEP_SECONDS;
    }
    const started = performance.now();
    beatClock.advance(dt, null);
    stageInstance.render(world, accumulator / STEP_SECONDS, dt, beatClock.state);
    const renderMs = performance.now() - started;
    totalRenderMs += renderMs;
    frameCounter++;
    const averageMs = totalRenderMs / frameCounter;
    (window as DemoWindow).__stats = { averageMs, samples: frameCounter };
    if (statsEnabled && frameCounter % STATS_PRINT_INTERVAL === 0) {
      console.log(`[stage-demo] avg render ${averageMs.toFixed(3)} ms over ${frameCounter} frames; phase=${world.m.world[1]} tick=${world.m.world[0]}`);
    }
    if (!ready) {
      ready = true;
      (window as DemoWindow).ready = true;
    }
    requestAnimationFrame(loop);
  };

  requestAnimationFrame((now) => {
    last = now;
    loop(now);
  });
  return stageInstance;
}
