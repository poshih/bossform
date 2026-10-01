import { PROJECTILE_SPEED_CAP } from './constants.ts';

/** How a projectile is drawn. Behaviour never depends on the kind, only on its shot definition's fields. */
export const Proj = {
  Bolt: 0, Dart: 1, Seeker: 2, Shell: 3, Shard: 4, Echo: 5, Orb: 6, Heavy: 7, Needle: 8, Blade: 9,
  Slash: 10, Shuriken: 11, Missile: 12, Mine: 13, Fist: 14, Bomb: 15,
} as const;
export const PROJ_KIND_COUNT = 16;

/**
 * Seek: steers toward the nearest targetable hostile ship. Inert: touches nothing, exists to detonate (delayed rings, mines,
 * lobbed shells). Proximity: an inert mine that detonates early once armed, when something hostile comes within its trigger
 * radius. Return: flies out, then comes back to its owner, who catches it (projectiles.ts). Lob: an inert shell thrown at a
 * ground point over everything in between, detonating where it lands (projectiles.ts lob).
 */
export const ShotFlag = { Seek: 1, Inert: 2, Proximity: 4, Return: 8, Lob: 16 } as const;

/** What a projectile turns into when it hits something or runs out of life: `count` shots evenly around a ring. */
export interface ShotBurst {
  readonly count: number;
  readonly shot: ShotDef;
}

/** An immutable projectile blueprint. Live projectiles store only the blueprint's index (`id`). */
export interface ShotDef {
  readonly id: number;
  readonly kind: number;
  /** Launch speed, units/tick. */
  readonly spd: number;
  readonly rad: number;
  readonly dmg: number;
  /** Ticks until it expires (and detonates, if it has a burst). */
  readonly life: number;
  /** Speed gained per tick until `maxSpd`. */
  readonly acc: number;
  readonly maxSpd: number;
  /**
   * Heading change per tick. A seeking shot turns toward its target by at most this much, a returning shot toward its owner;
   * any other shot curves by exactly this much (signed: positive counter-clockwise).
   */
  readonly turn: number;
  readonly flags: number;
  readonly burst: ShotBurst | null;
  /** Proximity mines: the distance from a hostile body's edge that sets them off. */
  readonly trigger: number;
  /** Proximity mines: ticks before they can be set off. */
  readonly arm: number;
  /** Returning shots: the age at which they turn for home, unless a strike turns them first. */
  readonly returnAt: number;
  /** Velocity (units/tick) given to a robot this shot strikes on the core or on its shield, along the shot's heading. */
  readonly knock: number;
  /** Radius and damage of the blast the shot makes when it detonates (blast.ts); 0 for none. */
  readonly blastR: number;
  readonly blastDmg: number;
}

export interface ShotSpec {
  readonly kind: number;
  readonly spd: number;
  readonly rad: number;
  readonly dmg: number;
  readonly life: number;
  readonly acc?: number;
  readonly maxSpd?: number;
  readonly turn?: number;
  readonly flags?: number;
  readonly burst?: ShotBurst;
  readonly trigger?: number;
  readonly arm?: number;
  readonly returnAt?: number;
  readonly knock?: number;
  readonly blastR?: number;
  readonly blastDmg?: number;
}

const registry: ShotDef[] = [];
/** Every shot blueprint, indexed by ShotDef.id (what projectile memory stores). Read-only after module load. */
export const SHOT_DEFS: readonly ShotDef[] = registry;

/**
 * The single place shots are defined. It enforces the game's speed rule at authoring time: every projectile,
 * whoever owns it, launches and accelerates only within (0, PROJECTILE_SPEED_CAP]; only a harmless inert fuse may stand still.
 * It also refuses flag combinations the simulation could not honour, and fields that would do nothing.
 */
export function shot(spec: ShotSpec): ShotDef {
  const def: ShotDef = {
    id: registry.length,
    kind: spec.kind,
    spd: spec.spd,
    rad: spec.rad,
    dmg: spec.dmg,
    life: spec.life,
    acc: spec.acc ?? 0,
    maxSpd: spec.maxSpd ?? spec.spd,
    turn: spec.turn ?? 0,
    flags: spec.flags ?? 0,
    burst: spec.burst ?? null,
    trigger: spec.trigger ?? 0,
    arm: spec.arm ?? 0,
    returnAt: spec.returnAt ?? 0,
    knock: spec.knock ?? 0,
    blastR: spec.blastR ?? 0,
    blastDmg: spec.blastDmg ?? 0,
  };
  const fail = (why: string): never => {
    throw new RangeError(`shot #${def.id} (kind ${def.kind}): ${why}`);
  };
  const has = (flag: number): boolean => (def.flags & flag) !== 0;
  if (!(def.kind >= 0 && def.kind < PROJ_KIND_COUNT)) fail('unknown kind');
  // An inert fuse may stand still (a mine left behind); anything that can hurt must move.
  const inert = has(ShotFlag.Inert);
  if (!((inert ? def.spd >= 0 : def.spd > 0) && def.spd <= PROJECTILE_SPEED_CAP)) fail(inert ? 'an inert fuse needs a speed in [0, cap]' : 'launch speed must be in (0, cap]');
  if (!(def.maxSpd >= def.spd && def.maxSpd <= PROJECTILE_SPEED_CAP)) fail('maxSpd must be in [spd, cap]');
  if (def.acc < 0) fail('acceleration must not be negative');
  if (def.acc > 0 && def.maxSpd <= def.spd) fail('an accelerating shot needs maxSpd above its launch speed');
  if (!(def.rad > 0 && def.life >= 1 && def.dmg >= 0)) fail('radius, life and damage must be positive');
  if (has(ShotFlag.Seek) && def.turn <= 0) fail('a seeking shot needs a turn rate');
  if (inert && (def.dmg !== 0 || (def.burst === null && def.blastR === 0))) fail('an inert shot must deal no damage and have a burst or a blast');
  if (def.burst !== null && def.burst.count < 1) fail('burst needs at least one shot');
  if (def.burst !== null && (def.burst.shot.flags & ShotFlag.Lob) !== 0) fail('a burst rings its shots out; it cannot lob them at a point');
  // A pod throws one returning shot at a time and is away until it is back (boss.ts), so bursts cannot scatter more of them.
  if (def.burst !== null && (def.burst.shot.flags & ShotFlag.Return) !== 0) fail('a burst cannot ring out returning shots');
  if (has(ShotFlag.Proximity) && !(inert && def.trigger > 0 && def.arm >= 0 && def.arm < def.life)) fail('a mine must be inert, with a trigger radius and an arming time within its life');
  if (!has(ShotFlag.Proximity) && (def.trigger !== 0 || def.arm !== 0)) fail('only a mine (Proximity) has a trigger radius and an arming time');
  if (has(ShotFlag.Lob) && !(inert && def.spd > 0 && def.acc === 0 && def.turn === 0 && !has(ShotFlag.Proximity))) fail('a lobbed shell must be an inert, moving, straight, constant-speed shell (not a mine)');
  if (has(ShotFlag.Return) && !(def.turn > 0 && def.returnAt >= 1 && def.returnAt < def.life && !inert && !has(ShotFlag.Seek))) fail('a returning shot must strike (not inert, not seeking), turn home at some rate, and turn within its life');
  if (!has(ShotFlag.Return) && def.returnAt !== 0) fail('only a returning shot turns for home');
  if (def.knock < 0 || def.blastR < 0 || def.blastDmg < 0) fail('knock and blast must not be negative');
  if ((def.blastR > 0) !== (def.blastDmg > 0)) fail('a blast needs both a radius and damage');
  registry.push(Object.freeze(def));
  return def;
}

/**
 * How far a shot flies in a straight line before it expires, acceleration included (the speed grows before each move, as in
 * projectiles.ts). For a lobbed shell it is the farthest it can be thrown.
 */
export function shotReach(def: ShotDef): number {
  let speed = def.spd;
  let distance = 0;
  for (let tick = 0; tick < def.life; tick++) {
    if (speed < def.maxSpd) speed = Math.min(def.maxSpd, speed + def.acc);
    distance += speed;
  }
  return distance;
}
