import { fx, Rng, SimMemory } from '@metronome/engine';
import type { MemoryViews, SimInit } from '@metronome/engine';
import {
  DIFFICULTY_SCALE, Difficulty, FRAME_COUNT, FRAME_STATS, INTRO_TICKS, MAX_BULLETS, MAX_ENEMIES, MAX_ORBS, MAX_PLAYERS, MAX_SHOTS,
  Phase, START_LIVES, STAGE_COUNT,
} from './constants.ts';
import { Banner, Ev, EventQueue } from './events.ts';
import { LAYOUT, W } from './layout.ts';

export type Mem = MemoryViews<typeof LAYOUT>;

/** Byte positions inside SimInit.config (the lobby's agreement on how this run is set up). */
export const Config = { Difficulty: 0, FrameSeat0: 1, FrameSeat1: 2, StartStage: 3, Length: 4 } as const;

const NO_TARGET = -1;
const SPAWN_Y = fx.fromInt(-140);
const SPAWN_SPREAD = fx.fromInt(50);

/** Builds the config bytes that SimInit carries (the game's own lobby encoding). */
export function encodeConfig(difficulty: number, frames: readonly number[], startStage: number): Uint8Array {
  const out = new Uint8Array(Config.Length);
  out[Config.Difficulty] = difficulty;
  out[Config.FrameSeat0] = frames[0] ?? 0;
  out[Config.FrameSeat1] = frames[1] ?? 0;
  out[Config.StartStage] = startStage;
  return out;
}

function clampByte(config: Uint8Array, index: number, max: number): number {
  const v = index < config.length ? config[index] : 0;
  return v > max ? max : v;
}

/** Owner of the arena, the RNG and the event queue; passed explicitly to every simulation function. */
export class World {
  readonly memory: SimMemory<typeof LAYOUT>;
  readonly m: Mem;
  readonly rng: Rng;
  readonly events = new EventQueue();
  readonly seats: number;
  private readonly speedPct: number;
  private readonly intervalPct: number;
  private readonly hpPct: number;

  constructor(init: SimInit) {
    this.memory = new SimMemory(LAYOUT);
    this.m = this.memory.f;
    this.rng = new Rng(this.m.rng);
    this.rng.seed(init.seed);
    this.seats = Math.min(init.seats, MAX_PLAYERS);

    const difficulty = clampByte(init.config, Config.Difficulty, Difficulty.Hard);
    [this.hpPct, this.speedPct, this.intervalPct] = DIFFICULTY_SCALE[difficulty];
    const { m } = this;
    const w = m.world;
    w[W.Difficulty] = difficulty;
    w[W.Stage] = clampByte(init.config, Config.StartStage, STAGE_COUNT - 1);
    w[W.Phase] = Phase.Intro;
    w[W.PhaseTimer] = INTRO_TICKS;
    w[W.BossSlot] = NO_TARGET;

    for (let i = 0; i < MAX_BULLETS; i++) m.bFree[i] = MAX_BULLETS - 1 - i;
    for (let i = 0; i < MAX_SHOTS; i++) m.sFree[i] = MAX_SHOTS - 1 - i;
    for (let i = 0; i < MAX_ENEMIES; i++) m.eFree[i] = MAX_ENEMIES - 1 - i;
    for (let i = 0; i < MAX_ORBS; i++) m.oFree[i] = MAX_ORBS - 1 - i;
    w[W.BulletFree] = MAX_BULLETS;
    w[W.ShotFree] = MAX_SHOTS;
    w[W.EnemyFree] = MAX_ENEMIES;
    w[W.OrbFree] = MAX_ORBS;

    for (let p = 0; p < this.seats; p++) {
      const frame = clampByte(init.config, Config.FrameSeat0 + p, FRAME_COUNT - 1);
      m.plActive[p] = 1;
      m.plFrame[p] = frame;
      m.plHp[p] = FRAME_STATS[frame].maxHp;
      m.plLives[p] = START_LIVES;
      m.plX[p] = m.plPX[p] = this.spawnX(p);
      m.plY[p] = m.plPY[p] = SPAWN_Y;
      m.plAim[p] = fx.ANGLE_QUARTER;
    }
    this.events.push(Ev.Banner, 0, 0, Banner.Stage);
  }

  spawnX(seat: number): number {
    if (this.seats === 1) return 0;
    return seat === 0 ? -SPAWN_SPREAD : SPAWN_SPREAD;
  }

  get spawnY(): number {
    return SPAWN_Y;
  }

  // ---- difficulty scalers (integer percent math, applied where things are created) ----
  scaleSpeed(v: number): number {
    return Math.floor((v * this.speedPct) / 100);
  }

  scaleInterval(ticks: number): number {
    return Math.max(1, Math.floor((ticks * this.intervalPct) / 100));
  }

  scaleHp(hp: number): number {
    return Math.max(1, Math.floor((hp * this.hpPct) / 100));
  }

  // ---- pools ----
  allocBullet(): number {
    const w = this.m.world;
    return w[W.BulletFree] === 0 ? -1 : this.m.bFree[--w[W.BulletFree]];
  }

  freeBullet(i: number): void {
    const { m } = this;
    m.bAlive[i] = 0;
    m.bFree[m.world[W.BulletFree]++] = i;
  }

  allocShot(): number {
    const w = this.m.world;
    return w[W.ShotFree] === 0 ? -1 : this.m.sFree[--w[W.ShotFree]];
  }

  freeShot(i: number): void {
    const { m } = this;
    m.sAlive[i] = 0;
    m.sFree[m.world[W.ShotFree]++] = i;
  }

  allocEnemy(): number {
    const w = this.m.world;
    return w[W.EnemyFree] === 0 ? -1 : this.m.eFree[--w[W.EnemyFree]];
  }

  freeEnemy(i: number): void {
    const { m } = this;
    m.eAlive[i] = 0;
    m.eFree[m.world[W.EnemyFree]++] = i;
  }

  allocOrb(): number {
    const w = this.m.world;
    return w[W.OrbFree] === 0 ? -1 : this.m.oFree[--w[W.OrbFree]];
  }

  freeOrb(i: number): void {
    const { m } = this;
    m.oAlive[i] = 0;
    m.oFree[m.world[W.OrbFree]++] = i;
  }

  // ---- queries ----
  /** A player who can be shot at and can shoot: active, alive, not waiting to respawn. */
  isPlaying(p: number): boolean {
    return this.m.plActive[p] === 1 && this.m.plHp[p] > 0 && this.m.plRespawn[p] === 0;
  }

  /** Index of the closest playing player to (x, y), or -1. Ties go to the lower seat. */
  nearestPlayer(x: number, y: number): number {
    const { m } = this;
    let best = -1;
    let bestD = Infinity;
    for (let p = 0; p < this.seats; p++) {
      if (!this.isPlaying(p)) continue;
      const d = fx.len2(m.plX[p] - x, m.plY[p] - y);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }

  /** Angle from (x, y) toward the nearest player; straight down when nobody is left. */
  angleToPlayer(x: number, y: number): number {
    const p = this.nearestPlayer(x, y);
    if (p < 0) return fx.ANGLE_QUARTER * 3;
    return fx.atan2(this.m.plY[p] - y, this.m.plX[p] - x);
  }

  emit(type: number, x = 0, y = 0, a = 0): void {
    this.events.push(type, x, y, a);
  }
}
