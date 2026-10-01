import { fx } from '@metronome/engine';
import { Attack, MAX_PARTS, MIN_WINDUP_TICKS } from './constants.ts';
import { shotReach, ShotFlag } from './shots.ts';
import type { ShotDef } from './shots.ts';

/**
 * The boss-form kit: the types every colossus is written in, the helpers that build its parts at colossus scale, and
 * defineForm, which refuses a form that breaks the weight and tell rules. Each form lives next to its robot (forms.ts for
 * the original three, <robot>.ts for the others); forms.ts lists them all in FORMS.
 *
 * Boss forms: the large, heavy machine a robot becomes. Each form is an armoured body around a small core.
 * Parts are circles in body space (+x is the direction the body faces); only pods shoot and only the core hurts
 * the pilot. A form's table is the single source for the hitboxes, the attack origins AND the models: a model draws
 * a part exactly where, and as big as, its definition says.
 */
export const PartKind = { Armor: 0, Pod: 1 } as const;
/** Which attacks a pod takes part in. */
export const Role = { Salvo: 1, Siege: 2, Ultima: 4 } as const;

/**
 * How an attack releases. A salvo or a siege shot is a Volley (a fan of shots from each firing pod), a Beam (each firing pod
 * beams along its own facing for a while), Artillery (each firing pod lobs shells at a target point and around it) or a
 * Carpet (each firing pod lobs a line of shells along its facing). The ultima's barrage is a Spiral, a Wheel (a beam from
 * every ultima pod, pointing out from the core through it), a Bombard (shells lobbed around a target point) or a Carpet
 * (lines of shells along each pod's facing); every barrage also fires rings.
 */
export const Pattern = { Volley: 0, Beam: 1, Artillery: 2, Carpet: 3, Spiral: 4, Wheel: 5, Bombard: 6 } as const;

export interface PartDef {
  readonly name: string;
  readonly kind: number;
  /** Offset from the core in body space; for orbiting parts, in orbit space. */
  readonly x: number;
  readonly y: number;
  readonly rad: number;
  readonly hp: number;
  /** Pods only. */
  readonly roles: number;
  /** Pods only: distance from the pod's centre to where its shots appear. */
  readonly muzzle: number;
  /** Pods only: how fast this pod swings toward the aim direction (angle per tick). Heavier mounts turn slower. */
  readonly turn: number;
  /** Position rotates with the orbit angle instead of the body angle. */
  readonly orbit: boolean;
}

export interface VolleyDef {
  /** Shots per firing pod, fanned evenly across `spread`. */
  readonly count: number;
  readonly spread: number;
  readonly shot: ShotDef;
}

/** Each firing pod fires a fan of shots along its own facing. */
export interface VolleyAttack extends VolleyDef {
  readonly pattern: typeof Pattern.Volley;
}

/** Each firing pod beams along its own facing for `duration` ticks, sweeping only as fast as the pod turns (beams.ts). */
export interface BeamAttack {
  readonly pattern: typeof Pattern.Beam;
  readonly duration: number;
  readonly length: number;
  /** Half-width: added to the radius of everything the beam can meet. */
  readonly width: number;
  /** Ticks between damage pulses; the first pulse lands on the first tick. */
  readonly every: number;
  readonly dmg: number;
}

/**
 * Each firing pod lobs `count` shells: the first at its target point (projectiles.ts artilleryTarget, out to `range`), the rest
 * evenly on a circle of `radius` around it, turned by a random angle each volley.
 */
export interface ArtilleryAttack {
  readonly pattern: typeof Pattern.Artillery;
  readonly count: number;
  readonly radius: number;
  readonly range: number;
  readonly shell: ShotDef;
}

/** Each firing pod lobs a line of `count` shells along its facing, the first `first` ahead of its muzzle, then `gap` apart. */
export interface CarpetAttack {
  readonly pattern: typeof Pattern.Carpet;
  readonly count: number;
  readonly first: number;
  readonly gap: number;
  readonly shell: ShotDef;
}

/** Every attack: a wind-up (the tell), the release, and a recovery, paid for in energy up front. */
export interface AttackTiming {
  readonly windup: number;
  readonly recovery: number;
  readonly cost: number;
}

export type SalvoDef = AttackTiming & (VolleyAttack | BeamAttack | ArtilleryAttack | CarpetAttack);

/** `recoil`: velocity kick opposite to each firing pod's facing on release (units/tick), whatever the pattern. */
export type SiegeDef = SalvoDef & { readonly recoil: number };

/** What every ultima has, whatever its pattern: a barrage of `duration` ticks, a cooldown after it, and rings. */
export interface UltimaBarrage {
  /** Ticks of barrage after the wind-up. */
  readonly duration: number;
  /** Ticks after the barrage ends before another ultima can start. */
  readonly cooldown: number;
  /** Every `ringEvery` ticks each live ultima pod fires a ring of `ringPerPod` shots from its own muzzle. */
  readonly ringEvery: number;
  readonly ringPerPod: number;
  readonly ringShot: ShotDef;
}

/** Every `interval` ticks each live ultima pod fires `arms` shots evenly around its facing, turned by `step` more each time. */
export interface SpiralUltima {
  readonly pattern: typeof Pattern.Spiral;
  readonly interval: number;
  readonly arms: number;
  readonly step: number;
  readonly shot: ShotDef;
}

/** Each live ultima pod beams outward, from the core through the pod, turning with the body or the orbit (beams.ts). */
export interface WheelUltima {
  readonly pattern: typeof Pattern.Wheel;
  readonly length: number;
  /** Half-width: added to the radius of everything the beam can meet. */
  readonly width: number;
  /** Ticks between damage pulses; the first pulse lands on the barrage's first tick. */
  readonly every: number;
  readonly dmg: number;
}

/** Every `every` ticks each live ultima pod lobs `count` shells at random points within `radius` of its target point. */
export interface BombardUltima {
  readonly pattern: typeof Pattern.Bombard;
  readonly every: number;
  readonly count: number;
  readonly radius: number;
  readonly range: number;
  readonly shell: ShotDef;
}

/** Every `every` ticks each live ultima pod lobs a line of shells along its facing (see CarpetAttack). */
export interface CarpetUltima {
  readonly pattern: typeof Pattern.Carpet;
  readonly every: number;
  readonly count: number;
  readonly first: number;
  readonly gap: number;
  readonly shell: ShotDef;
}

export type UltimaDef = AttackTiming & UltimaBarrage & (SpiralUltima | WheelUltima | BombardUltima | CarpetUltima);

export interface FormDef {
  readonly name: string;
  readonly frame: number;
  readonly speed: number;
  readonly accel: number;
  readonly bodyTurn: number;
  /** Orbit angle change per tick for orbiting parts. */
  readonly orbitTurn: number;
  /** Radius of the core hurtbox: the only thing that hurts the pilot. */
  readonly coreR: number;
  readonly pickupR: number;
  readonly parts: readonly PartDef[];
  /** Farthest any part's edge reaches from the core (broad phase for collisions). */
  readonly reach: number;
  /** Indices of the pods that take part in the ultima, in part order (each owns a fixed share of the ultima's rings). */
  readonly ultimaPods: readonly number[];
  readonly salvo: SalvoDef;
  readonly siege: SiegeDef;
  readonly ultima: UltimaDef;
}

export type PartSpec = Omit<PartDef, 'roles' | 'muzzle' | 'turn' | 'orbit'> & Partial<Pick<PartDef, 'roles' | 'muzzle' | 'turn' | 'orbit'>>;

/**
 * Colossi are drawn to a design scale and built here at COLOSSUS_SCALE_PCT of it: a boss form must dwarf the robot it
 * comes from (a big, heavy machine), and its armour must take a beating to match its bigger target. Lengths scale
 * exactly (integer percent); the core, the pilot's hurtbox, scales less so the machine is large without being easy
 * to finish.
 */
const COLOSSUS_SCALE_PCT = 150;
const CORE_SCALE_PCT = 125;
const PART_HP_SCALE_PCT = 140;
/** A design-scale length at colossus scale. */
export const big = (length: number): number => fx.mulDiv(length, COLOSSUS_SCALE_PCT, 100);
const tough = (hp: number): number => fx.mulDiv(hp, PART_HP_SCALE_PCT, 100);
/** A design-scale core radius at colossus scale. */
export const core = (radius: number): number => fx.mulDiv(radius, CORE_SCALE_PCT, 100);

/** An armour plate: design-scale position and radius, design hit points. */
export const armor = (name: string, x: number, y: number, rad: number, hp: number): PartDef =>
  ({ name, kind: PartKind.Armor, x: big(x), y: big(y), rad: big(rad), hp: tough(hp), roles: 0, muzzle: 0, turn: 0, orbit: false });

export interface PodSpec { name: string; x: number; y: number; rad: number; hp: number; roles: number; muzzle: number; turn: number; orbit?: boolean }
/** A cannon pod: design-scale position, radius and muzzle, design hit points. */
export const pod = (s: PodSpec): PartDef => ({ ...s, x: big(s.x), y: big(s.y), rad: big(s.rad), hp: tough(s.hp), muzzle: big(s.muzzle), kind: PartKind.Pod, orbit: s.orbit ?? false });

type Fail = (why: string) => never;

/** A shot fired straight out of a muzzle (a fan, a spiral, a ring) cannot be a lobbed shell: that needs a target point. */
function checkDirect(shot: ShotDef, what: string, fail: Fail): void {
  if ((shot.flags & ShotFlag.Lob) !== 0) fail(`${what} fires straight out: a lobbed shell needs a target point`);
}

/**
 * A pod that throws a returning shot is away until it is back (ptAway), so it throws one at a time: a returning shot can only
 * be a one-shot salvo or siege volley, never part of the ultima's spirals or rings.
 */
const returns = (shot: ShotDef): boolean => (shot.flags & ShotFlag.Return) !== 0;

/** Shells thrown at points must be lobbed, and able to reach the farthest point the attack throws one at. */
function checkShell(shell: ShotDef, farthest: number, what: string, fail: Fail): void {
  if ((shell.flags & ShotFlag.Lob) === 0) fail(`${what} throws its shells at points: they must be lobbed (ShotFlag.Lob)`);
  if (farthest > shotReach(shell)) fail(`${what} throws shells ${fx.toFloat(farthest)} units out, beyond their reach of ${fx.toFloat(shotReach(shell))}`);
}

function checkRelease(attack: SalvoDef, what: string, fail: Fail): void {
  switch (attack.pattern) {
    case Pattern.Volley:
      if (!(attack.count >= 1 && attack.spread >= 0)) fail(`${what}: a volley needs at least one shot`);
      checkDirect(attack.shot, what, fail);
      if (returns(attack.shot) && attack.count !== 1) fail(`${what}: a pod throws one returning shot at a time`);
      break;
    case Pattern.Beam:
      if (!(attack.duration >= 1 && attack.length > 0 && attack.width > 0 && attack.every >= 1 && attack.dmg > 0)) fail(`${what}: a beam needs a duration, a length, a width, a pulse interval and damage`);
      break;
    case Pattern.Artillery:
      if (!(attack.count >= 1 && attack.range > 0 && attack.radius >= 0 && (attack.count === 1 || attack.radius > 0))) fail(`${what}: artillery needs shells, a range, and a radius to spread them over`);
      checkShell(attack.shell, attack.range + attack.radius, what, fail);
      break;
    default:
      if (!(attack.count >= 1 && attack.first > 0 && attack.gap > 0)) fail(`${what}: a carpet needs shells, a first distance and a gap`);
      checkShell(attack.shell, attack.first + attack.gap * (attack.count - 1), what, fail);
  }
}

function checkBarrage(def: Omit<FormDef, 'reach' | 'ultimaPods'>, ultimaPods: readonly number[], fail: Fail): void {
  const ultima = def.ultima;
  if (!(ultima.duration >= 1 && ultima.cooldown >= 0 && ultima.ringEvery >= 1 && ultima.ringPerPod >= 1)) fail('ultima: a barrage needs a duration, a cooldown and rings');
  checkDirect(ultima.ringShot, 'ultima rings', fail);
  if (returns(ultima.ringShot)) fail('ultima rings: a pod throws one returning shot at a time, never a ring of them');
  switch (ultima.pattern) {
    case Pattern.Spiral:
      if (!(ultima.interval >= 1 && ultima.arms >= 1)) fail('ultima: a spiral needs an interval and arms');
      checkDirect(ultima.shot, 'ultima spiral', fail);
      if (returns(ultima.shot)) fail('ultima spiral: a pod throws one returning shot at a time, never a spiral of them');
      break;
    case Pattern.Wheel:
      if (!(ultima.length > 0 && ultima.width > 0 && ultima.every >= 1 && ultima.dmg > 0)) fail('ultima: a wheel needs a length, a width, a pulse interval and damage');
      // A spoke points from the core through its pod, so no ultima pod may sit on the core.
      if (ultimaPods.some((k) => def.parts[k].x === 0 && def.parts[k].y === 0)) fail('ultima: a wheel spoke needs its pod away from the core');
      break;
    case Pattern.Bombard:
      if (!(ultima.every >= 1 && ultima.count >= 1 && ultima.range > 0 && ultima.radius >= 0)) fail('ultima: a bombardment needs an interval, shells, a range and a radius');
      checkShell(ultima.shell, ultima.range + ultima.radius, 'ultima bombardment', fail);
      break;
    default:
      if (!(ultima.every >= 1 && ultima.count >= 1 && ultima.first > 0 && ultima.gap > 0)) fail('ultima: a carpet needs an interval, shells, a first distance and a gap');
      checkShell(ultima.shell, ultima.first + ultima.gap * (ultima.count - 1), 'ultima carpet', fail);
  }
}

/**
 * Builds a boss form and refuses one that breaks the rules: at most MAX_PARTS parts, a live pod for every attack, the tell
 * minimums, Salvo < Siege < Ultima in wind-up, recovery and cost, and attack patterns the simulation can carry out.
 */
export function defineForm(def: Omit<FormDef, 'reach' | 'ultimaPods'>): FormDef {
  const fail = (why: string): never => {
    throw new RangeError(`boss form ${def.name}: ${why}`);
  };
  if (def.parts.length > MAX_PARTS) fail(`at most ${MAX_PARTS} parts`);
  let reach = def.coreR;
  const roleCount = { [Role.Salvo]: 0, [Role.Siege]: 0, [Role.Ultima]: 0 };
  for (const part of def.parts) {
    reach = Math.max(reach, fx.hypot(part.x, part.y) + part.rad);
    if (part.kind === PartKind.Pod) {
      if (part.turn <= 0 || part.muzzle <= 0 || part.roles === 0) fail(`pod ${part.name} needs turn, muzzle and roles`);
      for (const role of [Role.Salvo, Role.Siege, Role.Ultima]) if ((part.roles & role) !== 0) roleCount[role]++;
    }
  }
  for (const role of [Role.Salvo, Role.Siege, Role.Ultima]) if (roleCount[role] === 0) fail(`no pod has role ${role}`);
  const attacks = [null, def.salvo, def.siege, def.ultima] as const;
  for (const id of [Attack.Salvo, Attack.Siege, Attack.Ultima]) {
    const a = attacks[id]!;
    if (a.windup < MIN_WINDUP_TICKS[id]) fail(`attack ${id} winds up for ${a.windup} ticks, below the tell minimum ${MIN_WINDUP_TICKS[id]}`);
    const heavier = id === Attack.Salvo ? null : attacks[id - 1]!;
    if (heavier !== null && !(a.windup > heavier.windup && a.recovery > heavier.recovery && a.cost > heavier.cost)) {
      fail(`attack ${id} must be heavier than attack ${id - 1}: longer wind-up, longer recovery, higher cost`);
    }
  }
  const ultimaPods = def.parts.flatMap((part, k) => (part.kind === PartKind.Pod && (part.roles & Role.Ultima) !== 0 ? [k] : []));
  checkRelease(def.salvo, 'salvo', fail);
  checkRelease(def.siege, 'siege', fail);
  checkBarrage(def, ultimaPods, fail);
  return Object.freeze({ ...def, reach, ultimaPods: Object.freeze(ultimaPods) });
}
