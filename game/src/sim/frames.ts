import { fx } from '@metronome/engine';
import { Proj, shot, ShotFlag } from './shots.ts';

/** The three robot designs: a versatile hero, a fast striker and a heavy bunker. */
export const Frame = { Vanguard: 0, Gale: 1, Juggernaut: 2 } as const;
export const FRAME_COUNT = 3;

export interface FrameStats {
  readonly hp: number;
  /** Most damage this robot can take inside one window; the rest is ignored. Lighter, faster robots take less. */
  readonly windowCap: number;
  readonly windowTicks: number;
  readonly speed: number;
  readonly accel: number;
  /** Radius a projectile must reach to hurt: the small core inside the body. */
  readonly hurtR: number;
  /** Body radius: touches the rim and picks up orbs. */
  readonly bodyR: number;
  readonly grazeR: number;
}

export const FRAME_STATS: readonly FrameStats[] = [
  { hp: 120, windowCap: 24, windowTicks: 60, speed: fx.lit(2.1), accel: fx.lit(0.22), hurtR: fx.lit(3), bodyR: fx.fromInt(10), grazeR: fx.fromInt(18) },
  { hp: 88, windowCap: 16, windowTicks: 60, speed: fx.lit(3), accel: fx.lit(0.35), hurtR: fx.lit(2.4), bodyR: fx.fromInt(8), grazeR: fx.fromInt(16) },
  { hp: 220, windowCap: 44, windowTicks: 60, speed: fx.lit(1.5), accel: fx.lit(0.12), hurtR: fx.lit(4.4), bodyR: fx.fromInt(14), grazeR: fx.fromInt(22) },
];

/** Shots leave the hull this far along the aim direction. */
export const MUZZLE = fx.fromInt(11);

export const VANGUARD = {
  rifle: {
    interval: 9,
    count: 3,
    spread: fx.deg(16),
    shot: shot({ kind: Proj.Bolt, spd: fx.lit(2.8), rad: fx.lit(2.4), dmg: 6, life: 150 }),
  },
  seekers: {
    cooldown: 140,
    count: 2,
    spread: fx.deg(80),
    shot: shot({
      kind: Proj.Seeker, spd: fx.lit(1.6), acc: fx.lit(0.03), maxSpd: fx.lit(2.6), turn: fx.deg(2.6), rad: fx.lit(3.6), dmg: 9, life: 240,
      flags: ShotFlag.Seek,
    }),
  },
} as const;

export const GALE = {
  darts: {
    interval: 5,
    /** Sideways offset of each of the twin darts from the aim line. */
    offset: fx.fromInt(4),
    shot: shot({ kind: Proj.Dart, spd: fx.lit(3.2), rad: fx.lit(1.9), dmg: 3, life: 110 }),
  },
  dash: {
    ticks: 9,
    speed: fx.lit(6.5),
    cooldown: 150,
    /** Invulnerability granted by a dash, ticks (covers the dash and a short glide after it). */
    protect: 14,
    /** Left where the dash began: detonates into a ring once its fuse (its life) is up. */
    echo: shot({
      kind: Proj.Echo, spd: fx.lit(1.2), rad: fx.lit(5), dmg: 0, life: 30, flags: ShotFlag.Inert,
      burst: { count: 12, shot: shot({ kind: Proj.Shard, spd: fx.lit(2.4), rad: fx.lit(2.4), dmg: 5, life: 90 }) },
    }),
  },
} as const;

export const JUGGERNAUT = {
  mortar: {
    interval: 34,
    shot: shot({
      kind: Proj.Shell, spd: fx.lit(1.8), rad: fx.lit(6), dmg: 20, life: 170,
      burst: { count: 10, shot: shot({ kind: Proj.Shard, spd: fx.lit(2.2), rad: fx.lit(2.4), dmg: 6, life: 60 }) },
    }),
  },
  bulwark: {
    ticks: 100,
    cooldown: 300,
    radius: fx.fromInt(42),
    halfArc: fx.deg(70),
    /** Movement speed while the bulwark is raised, percent. */
    slowPct: 60,
  },
} as const;
