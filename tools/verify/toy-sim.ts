/**
 * A small but non-trivial deterministic game used to verify the ENGINE on its own (ships, bullets, homing
 * rocks). It is built strictly on the public `@metronome/engine` API, exactly as a real game would be, so
 * engine verification never depends on the actual game.
 */
import { fx, Rng, SimMemory, field } from '@metronome/engine';
import type { InputCodec, SimFactory, Simulation, TickInput } from '@metronome/engine';

export interface ToyInput {
  moveX: number;
  moveY: number;
  aim: number;
  fire: boolean;
}

const clamp127 = (v: number) => (v < -127 ? -127 : v);

export const toyCodec: InputCodec<ToyInput> = {
  byteLength: 5,
  neutral: () => ({ moveX: 0, moveY: 0, aim: 0, fire: false }),
  encode(input, out, offset) {
    out[offset] = input.moveX & 0xff;
    out[offset + 1] = input.moveY & 0xff;
    out[offset + 2] = input.aim & 0xff;
    out[offset + 3] = (input.aim >> 8) & 0xff;
    out[offset + 4] = input.fire ? 1 : 0;
  },
  decode(bytes, offset) {
    return {
      moveX: clamp127((bytes[offset] << 24) >> 24),
      moveY: clamp127((bytes[offset + 1] << 24) >> 24),
      aim: bytes[offset + 2] | (bytes[offset + 3] << 8),
      fire: (bytes[offset + 4] & 1) !== 0,
    };
  },
};

const MAX_SHIPS = 4;
const MAX_BULLETS = 192;
const MAX_ROCKS = 48;
const ARENA = fx.fromInt(160);
const SHIP_ACCEL = fx.lit(0.02);
const SHIP_DRAG = fx.lit(0.96);
const BULLET_SPEED = fx.lit(6);
const BULLET_LIFE = 90;
const FIRE_COOLDOWN = 5;
const ROCK_SPEED = fx.lit(0.9);
const ROCK_TURN = fx.deg(2);
const ROCK_RADIUS = fx.fromInt(9);
const BULLET_RADIUS = fx.fromInt(3);
const SHIP_RADIUS = fx.fromInt(6);
const ROCK_SPAWN_EVERY = 20;
const ROCK_HP = 3;
const SHIP_HP = 40;

const LAYOUT = {
  rng: field.u32(4),
  world: field.i32(4),
  shipX: field.i32(MAX_SHIPS), shipY: field.i32(MAX_SHIPS), shipVX: field.i32(MAX_SHIPS), shipVY: field.i32(MAX_SHIPS),
  shipHp: field.i32(MAX_SHIPS), shipCooldown: field.i32(MAX_SHIPS), shipScore: field.i32(MAX_SHIPS),
  bulletX: field.i32(MAX_BULLETS), bulletY: field.i32(MAX_BULLETS), bulletVX: field.i32(MAX_BULLETS), bulletVY: field.i32(MAX_BULLETS),
  bulletLife: field.i32(MAX_BULLETS), bulletOwner: field.u8(MAX_BULLETS),
  rockX: field.i32(MAX_ROCKS), rockY: field.i32(MAX_ROCKS), rockAngle: field.i32(MAX_ROCKS), rockHp: field.i32(MAX_ROCKS),
} as const;

const W_TICK = 0;
const W_SPAWN_TIMER = 1;

export class ToySim implements Simulation<ToyInput> {
  readonly memory: SimMemory<typeof LAYOUT>;
  private readonly rng: Rng;
  private readonly seats: number;

  constructor(seed: number, seats: number) {
    this.memory = new SimMemory(LAYOUT);
    this.rng = new Rng(this.memory.f.rng);
    this.rng.seed(seed);
    this.seats = seats;
    const m = this.memory.f;
    for (let s = 0; s < seats; s++) {
      m.shipX[s] = fx.fromInt(-60 + s * 40);
      m.shipY[s] = fx.fromInt(-120);
      m.shipHp[s] = SHIP_HP;
    }
  }

  step(frame: TickInput<ToyInput>): void {
    const m = this.memory.f;
    m.world[W_TICK]++;
    for (let s = 0; s < this.seats; s++) if (frame.present[s] && m.shipHp[s] > 0) this.stepShip(s, frame.inputs[s]);
    this.spawnRocks();
    this.stepRocks();
    this.stepBullets();
  }

  private stepShip(s: number, input: ToyInput): void {
    const m = this.memory.f;
    m.shipVX[s] = fx.mul(m.shipVX[s] + input.moveX * SHIP_ACCEL, SHIP_DRAG);
    m.shipVY[s] = fx.mul(m.shipVY[s] + input.moveY * SHIP_ACCEL, SHIP_DRAG);
    m.shipX[s] = fx.clamp(m.shipX[s] + m.shipVX[s], -ARENA, ARENA);
    m.shipY[s] = fx.clamp(m.shipY[s] + m.shipVY[s], -ARENA, ARENA);
    if (m.shipCooldown[s] > 0) m.shipCooldown[s]--;
    if (input.fire && m.shipCooldown[s] === 0) {
      m.shipCooldown[s] = FIRE_COOLDOWN;
      for (let b = 0; b < MAX_BULLETS; b++) {
        if (m.bulletLife[b] > 0) continue;
        m.bulletX[b] = m.shipX[s];
        m.bulletY[b] = m.shipY[s];
        m.bulletVX[b] = fx.mul(fx.cos(input.aim), BULLET_SPEED);
        m.bulletVY[b] = fx.mul(fx.sin(input.aim), BULLET_SPEED);
        m.bulletLife[b] = BULLET_LIFE;
        m.bulletOwner[b] = s;
        break;
      }
    }
  }

  private spawnRocks(): void {
    const m = this.memory.f;
    if (--m.world[W_SPAWN_TIMER] > 0) return;
    m.world[W_SPAWN_TIMER] = ROCK_SPAWN_EVERY;
    for (let r = 0; r < MAX_ROCKS; r++) {
      if (m.rockHp[r] > 0) continue;
      m.rockX[r] = this.rng.fixedRange(-ARENA, ARENA);
      m.rockY[r] = ARENA;
      m.rockAngle[r] = this.rng.angle();
      m.rockHp[r] = ROCK_HP;
      return;
    }
  }

  private stepRocks(): void {
    const m = this.memory.f;
    for (let r = 0; r < MAX_ROCKS; r++) {
      if (m.rockHp[r] <= 0) continue;
      let best = -1;
      let bestD = Infinity;
      for (let s = 0; s < this.seats; s++) {
        if (m.shipHp[s] <= 0) continue;
        const d = fx.len2(m.shipX[s] - m.rockX[r], m.shipY[s] - m.rockY[r]);
        if (d < bestD) { bestD = d; best = s; }
      }
      if (best >= 0) {
        const want = fx.atan2(m.shipY[best] - m.rockY[r], m.shipX[best] - m.rockX[r]);
        m.rockAngle[r] = fx.turnToward(m.rockAngle[r], want, ROCK_TURN);
        if (bestD <= (ROCK_RADIUS + SHIP_RADIUS) * (ROCK_RADIUS + SHIP_RADIUS)) {
          m.shipHp[best]--;
          m.rockHp[r] = 0;
          continue;
        }
      }
      m.rockX[r] += fx.mul(fx.cos(m.rockAngle[r]), ROCK_SPEED);
      m.rockY[r] += fx.mul(fx.sin(m.rockAngle[r]), ROCK_SPEED);
    }
  }

  private stepBullets(): void {
    const m = this.memory.f;
    const reach = (ROCK_RADIUS + BULLET_RADIUS) * (ROCK_RADIUS + BULLET_RADIUS);
    for (let b = 0; b < MAX_BULLETS; b++) {
      if (m.bulletLife[b] <= 0) continue;
      m.bulletX[b] += m.bulletVX[b];
      m.bulletY[b] += m.bulletVY[b];
      m.bulletLife[b]--;
      for (let r = 0; r < MAX_ROCKS; r++) {
        if (m.rockHp[r] <= 0 || fx.len2(m.rockX[r] - m.bulletX[b], m.rockY[r] - m.bulletY[b]) > reach) continue;
        m.bulletLife[b] = 0;
        if (--m.rockHp[r] <= 0) m.shipScore[m.bulletOwner[b]] += 10;
        break;
      }
    }
  }

  score(seat: number): number {
    return this.memory.f.shipScore[seat];
  }

  hp(seat: number): number {
    return this.memory.f.shipHp[seat];
  }
}

export const toyFactory: SimFactory<ToyInput> = (init) => new ToySim(init.seed, init.seats);

/** Tiny seeded generator for scripted inputs (test tooling only; never used inside a simulation). */
export function scriptedInput(seat: number, tick: number): ToyInput {
  let h = Math.imul(tick + 1, 0x9e3779b1) ^ Math.imul(seat + 7, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h ^= h >>> 12;
  const phase = (tick >> 5) + seat;
  return {
    moveX: ((phase * 37) % 255) - 127,
    moveY: (((phase * 91) >> 1) % 255) - 127,
    aim: (h >>> 8) & 0xffff,
    fire: (h & 3) !== 0,
  };
}
