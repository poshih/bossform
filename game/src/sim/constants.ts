import { fx } from '@metronome/engine';

/**
 * Match rules, arena, energy and pool sizing. Frames, boss forms and neutral units keep their own tuning next
 * to their definitions (frames.ts, forms.ts, neutrals.ts). All values are fixed-point (fx.lit / fx.fromInt) or
 * plain integers (ticks, hit points, counts). Presentation constants live in ../config.ts, never here.
 */
export const SIM_VERSION = 3;
export const TICK_RATE = 60;

// ---- Match rules -----------------------------------------------------------------------------------
/** A game rule, not a technical limit: the engine and the simulation layout are sized from the seat count. */
export const MAX_PLAYERS = 8;
export const MIN_TEAMS = 2;
/** Team ids are bytes, so a lobby's team colours survive into the match unchanged. */
export const TEAM_LIMIT = 256;
export const Mode = { Elimination: 0, Deathmatch: 1 } as const;
export const MODE_COUNT = 2;
export const Phase = { Countdown: 0, Battle: 1, RoundEnd: 2, Over: 3 } as const;
export const NO_WINNER = -1;
/** "Nobody": the owner of neutral projectiles, the killer of a ship the storm took. */
export const NO_SEAT = -1;

export const ROUNDS_TO_WIN = 2;
export const COUNTDOWN_TICKS = 3 * TICK_RATE;
export const ROUND_END_TICKS = 3 * TICK_RATE;
export const SUDDEN_DEATH_TICKS = 75 * TICK_RATE;
export const SHRINK_TICKS = 60 * TICK_RATE;
export const STORM_INTERVAL = 6;
export const STORM_DAMAGE = 1;
export const DEATHMATCH_TICKS = 180 * TICK_RATE;
export const RESPAWN_TICKS = 3 * TICK_RATE;
export const SPAWN_PROTECT_TICKS = 2 * TICK_RATE;
export const KILL_CREDIT_TICKS = 5 * TICK_RATE;
export const KILL_SCORE = 1;
export const BOSS_KILL_SCORE = 2;
/** Deathmatch respawn points tried per respawn (evenly spaced on the spawn ring). */
export const RESPAWN_CANDIDATES = 16;

// ---- Arena: circular, origin at the centre, +x right, +y up ------------------------------------------
export const ARENA_BASE_RADIUS = fx.fromInt(500);
export const ARENA_RADIUS_PER_SEAT = fx.fromInt(100);
/** Ships start (and respawn) on a ring at this percent of the arena radius. */
export const SPAWN_RING_PCT = 70;
export const SAFE_RADIUS_MIN = fx.fromInt(140);
/** Radial distances are computed on values shifted right by this many bits so far-apart points stay in range. */
export const RADIAL_SHIFT = 3;
/** Beyond this radius the fixed-point range used by radial() is exhausted. */
export const ARENA_RADIUS_LIMIT = fx.fromInt(4000);

export interface Capacity {
  readonly seats: number;
  readonly projectiles: number;
  readonly neutrals: number;
  readonly orbs: number;
  readonly parts: number;
}

export const MAX_PARTS = 12;
const PROJECTILES_BASE = 800;
const PROJECTILES_PER_SEAT = 400;
const NEUTRALS_BASE = 12;
const NEUTRALS_PER_SEAT = 4;
const ORBS_BASE = 64;
const ORBS_PER_SEAT = 24;

/** Every pool is sized from the seat count when the simulation is built, so nothing caps the player count. */
export function capacityFor(seats: number): Capacity {
  return {
    seats,
    projectiles: PROJECTILES_BASE + PROJECTILES_PER_SEAT * seats,
    neutrals: NEUTRALS_BASE + NEUTRALS_PER_SEAT * seats,
    orbs: ORBS_BASE + ORBS_PER_SEAT * seats,
    parts: MAX_PARTS * seats,
  };
}

export function arenaRadius(seats: number): number {
  return ARENA_BASE_RADIUS + seats * ARENA_RADIUS_PER_SEAT;
}

// ---- Projectiles: one speed rule for everyone ---------------------------------------------------------
/** No projectile of any owner ever travels faster than this (units/tick). Enforced where projectiles are made and moved. */
export const PROJECTILE_SPEED_CAP = fx.lit(3.2);
/** Projectiles vanish this far outside the arena rim. */
export const PROJECTILE_RIM_MARGIN = fx.fromInt(4);
/** Seeking shots only steer toward ships this close. */
export const SEEK_RANGE = fx.fromInt(360);
/** Ticks a hit flash lasts (ships, boss parts, neutral units). */
export const FLASH_TICKS = 8;

// ---- Energy gauge (fixed point of 1/100 point) -------------------------------------------------------
export const GAUGE_SCALE = 100;
export const GAUGE_MAX = 1000 * GAUGE_SCALE;
export const BOSS_MIN_GAUGE = 500 * GAUGE_SCALE;
export const GAUGE_PER_GRAZE = 3 * GAUGE_SCALE;
export const GAUGE_PER_DAMAGE_DEALT = 25;
export const GAUGE_PER_DAMAGE_TAKEN = 40;
export const GAUGE_PER_ABSORB = 3 * GAUGE_SCALE;
/** Damage dealt to boss-form parts refuels the attacker at this percent of the normal rate. */
export const BOSS_PART_GAIN_PCT = 200;

// ---- Boss form ----------------------------------------------------------------------------------------
/** Damage percent taken by parts that just fired (recovery is the punish window). */
export const HOT_PART_DAMAGE_PCT = 150;
export const Form = { Normal: 0, Morph: 1, Boss: 2 } as const;
export const MORPH_TICKS = 46;
export const REVERT_PROTECT_TICKS = 30;
/** Passive fuel burn: 0.28 gauge points per tick, about 17 per second. */
export const BOSS_DRAIN_PER_TICK = 28;
/** Velocity removed per tick while a rooted boss form brakes (units/tick). */
export const ROOT_BRAKE = fx.lit(0.25);

export const Attack = { None: 0, Salvo: 1, Siege: 2, Ultima: 3 } as const;
export const ATTACK_COUNT = 4;
export const AttackPhase = { Idle: 0, Windup: 1, Release: 2, Recovery: 3 } as const;
/** The tell: no boss-attack projectile may exist before its wind-up has run at least this long. Indexed by Attack. */
export const MIN_WINDUP_TICKS: readonly number[] = [0, 12, 36, 90];

// ---- Energy orbs ----------------------------------------------------------------------------------------
export const ORB_VALUE = 8 * GAUGE_SCALE;
export const ORB_LIFETIME = 15 * TICK_RATE;
export const ORB_MAGNET_DELAY = 30;
export const ORB_MAGNET_RADIUS = fx.fromInt(90);
export const ORB_ACCEL = fx.lit(0.14);
export const ORB_MAX_SPEED = fx.lit(3.4);
export const ORB_DRAG_PCT = 94;
export const ORB_SCATTER_SPEED = fx.lit(1.4);
export const ORB_PICKUP_PAD = fx.fromInt(6);
/** A destroyed ship drops orbs worth this base plus a share of its remaining gauge. */
export const KILL_ORBS = 5;
export const KILL_ORB_BASE = 20 * GAUGE_SCALE;
export const KILL_ORB_GAUGE_PCT = 40;
export const BOSS_KILL_ORBS = 4;

// ---- Neutral waves ---------------------------------------------------------------------------------------
export const FIRST_WAVE_TICKS = 10 * TICK_RATE;
export const WAVE_INTERVAL_TICKS = 25 * TICK_RATE;
export const WAVE_INTERVAL_SUDDEN_DEATH_TICKS = 12 * TICK_RATE;
export const WARDEN_FIRST_TICKS = 40 * TICK_RATE;
export const WARDEN_INTERVAL_TICKS = 45 * TICK_RATE;
