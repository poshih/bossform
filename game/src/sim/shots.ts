import { PROJECTILE_SPEED_CAP } from './constants.ts';

/** How a projectile is drawn. Behaviour never depends on the kind, only on its shot definition's fields. */
export const Proj = { Bolt: 0, Dart: 1, Seeker: 2, Shell: 3, Shard: 4, Echo: 5, Orb: 6, Heavy: 7, Needle: 8, Blade: 9 } as const;
export const PROJ_KIND_COUNT = 10;

/** Seek: steers toward the nearest hostile ship. Inert: touches nothing, exists to detonate (delayed rings). */
export const ShotFlag = { Seek: 1, Inert: 2 } as const;

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
  /** Heading change per tick. */
  readonly turn: number;
  readonly flags: number;
  readonly burst: ShotBurst | null;
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
}

const registry: ShotDef[] = [];
/** Every shot blueprint, indexed by ShotDef.id (what projectile memory stores). Read-only after module load. */
export const SHOT_DEFS: readonly ShotDef[] = registry;

/**
 * The single place shots are defined. It enforces the game's speed rule at authoring time: every projectile,
 * whoever owns it, launches and accelerates only within (0, PROJECTILE_SPEED_CAP]; only a harmless inert fuse may stand still.
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
  };
  const fail = (why: string): never => {
    throw new RangeError(`shot #${def.id} (kind ${def.kind}): ${why}`);
  };
  if (!(def.kind >= 0 && def.kind < PROJ_KIND_COUNT)) fail('unknown kind');
  // An inert fuse may stand still (a mine left behind); anything that can hurt must move.
  const inert = (def.flags & ShotFlag.Inert) !== 0;
  if (!((inert ? def.spd >= 0 : def.spd > 0) && def.spd <= PROJECTILE_SPEED_CAP)) fail(inert ? 'an inert fuse needs a speed in [0, cap]' : 'launch speed must be in (0, cap]');
  if (!(def.maxSpd >= def.spd && def.maxSpd <= PROJECTILE_SPEED_CAP)) fail('maxSpd must be in [spd, cap]');
  if (def.acc < 0) fail('acceleration must not be negative');
  if (def.acc > 0 && def.maxSpd <= def.spd) fail('an accelerating shot needs maxSpd above its launch speed');
  if (!(def.rad > 0 && def.life >= 1 && def.dmg >= 0)) fail('radius, life and damage must be positive');
  if ((def.flags & ShotFlag.Seek) !== 0 && def.turn <= 0) fail('a seeking shot needs a turn rate');
  if ((def.flags & ShotFlag.Inert) !== 0 && (def.dmg !== 0 || def.burst === null)) fail('an inert shot must deal no damage and have a burst');
  if (def.burst !== null && def.burst.count < 1) fail('burst needs at least one shot');
  registry.push(Object.freeze(def));
  return def;
}
