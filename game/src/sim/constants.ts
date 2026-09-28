import { fx } from '@metronome/engine';

/**
 * Every simulation tuning number, in one place. All values are fixed-point (fx.lit / fx.fromInt) or plain
 * integers (ticks, hit points, counts). Presentation constants live in ../config.ts, never here.
 */
export const SIM_VERSION = 1;
export const TICK_RATE = 60;

export const MAX_PLAYERS = 2;
export const MAX_BULLETS = 1500;
export const MAX_SHOTS = 384;
export const MAX_ENEMIES = 48;
export const MAX_ORBS = 96;

// Arena: origin at the centre, +x right, +y up.
export const ARENA_HALF_W = fx.fromInt(160);
export const ARENA_HALF_H = fx.fromInt(200);
export const PLAYER_MARGIN_X = fx.fromInt(12);
export const PLAYER_MARGIN_Y = fx.fromInt(14);
export const CULL_MARGIN = fx.fromInt(30);
export const SPAWN_Y = fx.fromInt(232);

export const Frame = { Vanguard: 0, Gale: 1, Juggernaut: 2 } as const;
export const FRAME_COUNT = 3;

export interface FrameStats {
  readonly maxHp: number;
  readonly speed: number;
  /** Radius that bullets must reach to hurt (tiny core, twin-stick bullet-hell style). */
  readonly hurtR: number;
  /** Radius that touches enemy bodies. */
  readonly bodyR: number;
  readonly grazeR: number;
  readonly bossSpeed: number;
  /** In boss form the whole body is the hitbox, and bullets that touch it are absorbed. */
  readonly bossBodyR: number;
}

export const FRAME_STATS: readonly FrameStats[] = [
  { maxHp: 100, speed: fx.lit(2.1), hurtR: fx.lit(3.2), bodyR: fx.fromInt(10), grazeR: fx.fromInt(16), bossSpeed: fx.lit(1.9), bossBodyR: fx.fromInt(23) },
  { maxHp: 64, speed: fx.lit(3.3), hurtR: fx.lit(2.6), bodyR: fx.fromInt(8), grazeR: fx.fromInt(15), bossSpeed: fx.lit(3.7), bossBodyR: fx.fromInt(18) },
  { maxHp: 180, speed: fx.lit(1.45), hurtR: fx.lit(4.6), bodyR: fx.fromInt(14), grazeR: fx.fromInt(20), bossSpeed: fx.lit(1.25), bossBodyR: fx.fromInt(31) },
];

export const START_LIVES = 3;
export const RESPAWN_TICKS = 96;
export const RESPAWN_INVULN = 180;
export const HIT_INVULN = 54;
export const STAGE_HEAL_PCT = 35;

// Energy ("boss gauge") and the boss-mode transformation.
export const GAUGE_MAX = 1000;
export const GAUGE_PER_GRAZE = 7;
export const GAUGE_PER_SHOT_HIT = 1;
export const ORB_VALUE = 12;
export const TRANSFORM_TICKS = 46;
export const BOSS_MODE_TICKS = 660;
export const BOSS_MODE_MAX_TICKS = 900;
/** Every bullet the boss form swallows burns this much of its remaining time. */
export const BOSS_ABSORB_COST_TICKS = 1;
export const BOSS_EXTEND_PER_KILL = 10;
export const BOSS_EXTEND_PER_ORB = 1;
export const BOSS_REVERT_PULSE_R = fx.fromInt(110);
export const BOSS_TRANSFORM_PULSE_R = fx.fromInt(150);
export const BOSS_ABSORB_SCORE = 5;
/** Boss-form body crushing enemies: damage per tick to ordinary enemies / to bosses. */
export const BOSS_CRUSH_DAMAGE = 60;
export const BOSS_CRUSH_DAMAGE_VS_BOSS = 5;
export const CONTACT_DAMAGE = 14;
export const CHAIN_WINDOW_TICKS = 100;
export const CHAIN_MAX = 20;

// Scoring
export const SCORE_GRAZE = 10;
export const BOSS_SCORE_MULT = 2;
export const STAGE_CLEAR_BONUS = 10000;

export const Difficulty = { Easy: 0, Normal: 1, Hard: 2 } as const;
/** Percent scalers per difficulty: [enemy hp, bullet speed, fire interval]. */
export const DIFFICULTY_SCALE: ReadonlyArray<readonly [number, number, number]> = [
  [75, 88, 128],
  [100, 100, 100],
  [135, 114, 82],
];

// Enemy bullets
export const BulletKind = { Orb: 0, OrbMid: 1, OrbBig: 2, Needle: 3, Shell: 4 } as const;
export const BULLET_KIND_COUNT = 5;
export const BULLET_RADIUS: readonly number[] = [fx.lit(2.6), fx.lit(4), fx.lit(7), fx.lit(2.4), fx.lit(9.5)];
export const BULLET_DAMAGE: readonly number[] = [8, 12, 20, 9, 26];
export const BulletColor = { Red: 0, Magenta: 1, Amber: 2, Cyan: 3, Violet: 4, White: 5 } as const;
export const BULLET_COLOR_COUNT = 6;
export const BulletFlag = { GrazedP0: 1, GrazedP1: 2 } as const;

// Player shots
export const ShotKind = {
  Rifle: 0, Missile: 1, Needle: 2, Slash: 3, Shell: 4, Spread: 5, Blade: 6, Rocket: 7, Bit: 8,
} as const;
export const SHOT_KIND_COUNT = 9;

// Enemies
export const EnemyType = {
  Drone: 0, Gunner: 1, Lancer: 2, Spinner: 3, Bomber: 4, Bulwark: 5, Seraph: 6, Overlord: 7,
} as const;
export const ENEMY_TYPE_COUNT = 8;
export const EnemyFlag = { Invulnerable: 1, Boss: 2, Dying: 4, Telegraph: 8 } as const;

// Game phases (the UI reads these)
export const Phase = { Intro: 0, Play: 1, BossWarning: 2, Boss: 3, Clear: 4, Over: 5, Win: 6 } as const;
export const INTRO_TICKS = 170;
export const WARNING_TICKS = 190;
export const CLEAR_TICKS = 300;
export const STAGE_COUNT = 3;

// Weapons (per frame; the boss form has its own set)
export const MUZZLE = fx.fromInt(11);

export const VANGUARD = {
  rifleInterval: 4, rifleDmg: 4, rifleSpeed: fx.lit(10.5), rifleRad: fx.lit(2.2), rifleLife: 48, rifleJitter: 36,
  missileCount: 4, missileCooldown: 170, missileDmg: 9, missileSplash: fx.fromInt(17), missileSpeed: fx.lit(3.2),
  missileMaxSpeed: fx.lit(7.2), missileAcc: fx.lit(0.12), missileTurn: fx.deg(3.2), missileLife: 110, missileSpread: fx.deg(13),
  spreadInterval: 5, spreadDmg: 5, spreadSpeed: fx.lit(9.5), spreadStep: fx.deg(8), spreadWays: 5, spreadPierce: 2, spreadLife: 44,
  beamLength: fx.fromInt(330), beamHalfWidth: fx.fromInt(7), beamDmg: 3, beamSlowPct: 55,
} as const;

export const GALE = {
  needleInterval: 3, needleDmg: 2, needleSpeed: fx.lit(13.5), needleOffset: fx.fromInt(4), needleRad: fx.lit(1.8), needleLife: 40,
  dashTicks: 9, dashSpeed: fx.lit(10), dashCooldown: 84, slashDmg: 30, slashSpeed: fx.lit(6), slashRad: fx.fromInt(21), slashLife: 9,
  tempestInterval: 2, tempestDmg: 3, bitInterval: 6, bitDmg: 2, bitSpeed: fx.lit(10.5), bitOrbit: fx.fromInt(19), bitTurn: fx.deg(6), bitCount: 4,
  stormCooldown: 42, stormCount: 16, stormDmg: 10, stormSpeed: fx.lit(8.5), stormPierce: 3, stormLife: 36,
} as const;

export const JUGGERNAUT = {
  shellInterval: 16, shellDmg: 26, shellSplash: fx.fromInt(27), shellSpeed: fx.lit(6.6), shellRad: fx.lit(4.5), shellLife: 72,
  shieldTicks: 110, shieldCooldown: 330, shieldRadius: fx.fromInt(38), shieldHalfArc: fx.deg(72), shieldSlowPct: 55,
  fortressInterval: 9, fortressDmg: 30, fortressSplash: fx.fromInt(42), fortressSpeed: fx.lit(7.6), fortressOffset: fx.fromInt(9), fortressRad: fx.fromInt(6), fortressLife: 60,
  rocketCount: 10, rocketCooldown: 110, rocketDmg: 14, rocketSplash: fx.fromInt(23), rocketSpeed: fx.lit(3), rocketMaxSpeed: fx.lit(7), rocketAcc: fx.lit(0.16),
  rocketTurn: fx.deg(2.6), rocketLife: 120, rocketSpread: fx.deg(100),
} as const;

/** Splash damage to non-primary targets, in percent of the shot's damage. */
export const SPLASH_PCT = 60;
export const PULSE_DAMAGE = 30;

export interface EnemyDef {
  readonly hp: number;
  readonly rad: number;
  readonly score: number;
  /** Energy orbs dropped on destruction. */
  readonly orbs: number;
  /** 0 small .. 3 huge; drives explosion size in the presentation. */
  readonly explosion: number;
}

export const ENEMY_DEFS: readonly EnemyDef[] = [
  { hp: 8, rad: fx.fromInt(7), score: 100, orbs: 1, explosion: 0 }, // Drone
  { hp: 34, rad: fx.fromInt(9), score: 250, orbs: 3, explosion: 1 }, // Gunner
  { hp: 20, rad: fx.fromInt(8), score: 200, orbs: 2, explosion: 1 }, // Lancer
  { hp: 78, rad: fx.fromInt(11), score: 450, orbs: 5, explosion: 1 }, // Spinner
  { hp: 170, rad: fx.fromInt(15), score: 900, orbs: 9, explosion: 2 }, // Bomber
  { hp: 2600, rad: fx.fromInt(34), score: 30000, orbs: 0, explosion: 3 }, // Bulwark
  { hp: 3400, rad: fx.fromInt(30), score: 45000, orbs: 0, explosion: 3 }, // Seraph
  { hp: 4800, rad: fx.fromInt(38), score: 80000, orbs: 0, explosion: 3 }, // Overlord
];

// Energy orbs
export const ORB_LIFETIME = 480;
export const ORB_HOMING_DELAY = 16;
export const ORB_ACCEL = fx.lit(0.45);
export const ORB_MAX_SPEED = fx.lit(7.5);
export const ORB_COLLECT_R = fx.fromInt(11);
export const ORB_SCORE = 10;
