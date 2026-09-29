import { fx } from '@metronome/engine';
import { Proj, shot, ShotFlag } from './shots.ts';

/** The three robot designs: a versatile hero, a fast striker and a heavy bunker. */
export const Frame = { Vanguard: 0, Gale: 1, Juggernaut: 2 } as const;
export const FRAME_COUNT = 3;

export interface BoostStats {
  /** Units per tick while boosting (the robot's top speed is 2 to 3.5 times slower). */
  readonly speed: number;
  readonly ticks: number;
  /** The boost's first ticks are a dodge: projectiles pass through the robot, and one touching its core only grazes. */
  readonly dodge: number;
  /** Ticks from one boost's start until the next may start. */
  readonly cooldown: number;
}

export interface FrameStats {
  readonly hp: number;
  /** Most damage this robot can take inside one window; the rest is ignored. Lighter, faster robots take less. */
  readonly windowCap: number;
  readonly windowTicks: number;
  readonly speed: number;
  /** Most the velocity may change per tick when speeding up or turning. */
  readonly accel: number;
  /** Most the velocity may change per tick when slowing down along its heading (stopping, reversing): quicker than `accel`. */
  readonly brake: number;
  /** Radius a projectile must reach to hurt: the small core inside the body. */
  readonly hurtR: number;
  /** Body radius: touches the rim and picks up orbs. */
  readonly bodyR: number;
  /** Near misses inside this radius graze. It is also the shield's radius: a raised shield stops what reaches it. */
  readonly grazeR: number;
  readonly boost: BoostStats;
}

export const FRAME_STATS: readonly FrameStats[] = [
  {
    hp: 120, windowCap: 30, windowTicks: 60, speed: fx.lit(2.1), accel: fx.lit(0.22), brake: fx.lit(0.44), hurtR: fx.lit(3), bodyR: fx.fromInt(10), grazeR: fx.fromInt(18),
    boost: { speed: fx.lit(6.5), ticks: 12, dodge: 6, cooldown: 45 },
  },
  {
    hp: 88, windowCap: 20, windowTicks: 60, speed: fx.lit(3), accel: fx.lit(0.35), brake: fx.lit(0.7), hurtR: fx.lit(2.4), bodyR: fx.fromInt(8), grazeR: fx.fromInt(16),
    boost: { speed: fx.lit(7.5), ticks: 12, dodge: 6, cooldown: 36 },
  },
  {
    hp: 220, windowCap: 55, windowTicks: 60, speed: fx.lit(1.5), accel: fx.lit(0.12), brake: fx.lit(0.24), hurtR: fx.lit(4.4), bodyR: fx.fromInt(14), grazeR: fx.fromInt(22),
    boost: { speed: fx.lit(5.5), ticks: 12, dodge: 6, cooldown: 54 },
  },
];

/** Shots leave the hull this far along the aim direction. */
export const MUZZLE = fx.fromInt(11);

/**
 * Every weapon costs energy per shot (`cost`, see ENERGY_MAX): each primary weapon drains a full pool in about 7 s of
 * continuous fire (about 135 energy per second).
 */
export const VANGUARD = {
  rifle: {
    interval: 9,
    cost: 20,
    count: 3,
    spread: fx.deg(16),
    shot: shot({ kind: Proj.Bolt, spd: fx.lit(2.8), rad: fx.lit(2.4), dmg: 6, life: 150 }),
  },
  seekers: {
    cooldown: 140,
    cost: 100,
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
    cost: 11,
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
      kind: Proj.Echo, spd: 0, rad: fx.lit(5), dmg: 0, life: 30, flags: ShotFlag.Inert,
      burst: { count: 12, shot: shot({ kind: Proj.Shard, spd: fx.lit(2.4), rad: fx.lit(2.4), dmg: 5, life: 90 }) },
    }),
  },
} as const;

export const JUGGERNAUT = {
  mortar: {
    interval: 34,
    cost: 80,
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

/** Each robot's primary weapon, by frame: its refire interval, its energy cost per shot and its projectile. */
export const PRIMARY_WEAPONS = [VANGUARD.rifle, GALE.darts, JUGGERNAUT.mortar] as const;

/**
 * Each robot's alt, by frame: whether it is an attack (holding it drops the shield, like firing) and the energy it costs to
 * use. VANGUARD's seekers are a weapon; GALE's phase dash moves the robot; JUGGERNAUT's bulwark takes the shield's place and
 * pays per bullet it swallows (combat.ts), not to be raised.
 */
export const ALT_ABILITIES = [
  { attack: true, cost: VANGUARD.seekers.cost },
  { attack: false, cost: 0 },
  { attack: false, cost: 0 },
] as const;
