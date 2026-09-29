import { fx } from '@metronome/engine';
import { Attack, MAX_PARTS, MIN_WINDUP_TICKS } from './constants.ts';
import { Frame, FRAME_COUNT } from './frames.ts';
import { Proj, shot, ShotFlag } from './shots.ts';
import type { ShotDef } from './shots.ts';

/**
 * Boss forms: the large, heavy machine a robot becomes. Each form is an armoured body around a small core.
 * Parts are circles in body space (+x is the direction the body faces); only pods shoot and only the core hurts
 * the pilot. This table is the single source for the hitboxes, the attack origins AND the models: a model draws
 * a part exactly where, and as big as, its definition says.
 */
export const PartKind = { Armor: 0, Pod: 1 } as const;
/** Which attacks a pod takes part in. */
export const Role = { Salvo: 1, Siege: 2, Ultima: 4 } as const;

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

/** Every attack: a wind-up (the tell), the release, and a recovery, paid for in energy up front. */
export interface AttackTiming {
  readonly windup: number;
  readonly recovery: number;
  readonly cost: number;
}

export interface SalvoDef extends AttackTiming, VolleyDef {}

export interface SiegeDef extends AttackTiming, VolleyDef {
  /** Velocity kick opposite to the firing pod on release (units/tick). */
  readonly recoil: number;
}

export interface UltimaDef extends AttackTiming {
  /** Ticks of barrage after the wind-up. */
  readonly duration: number;
  /** Ticks after the barrage ends before another ultima can start. */
  readonly cooldown: number;
  /** Ticks between spiral emissions; each live ultima pod fires `arms` shots per emission. */
  readonly interval: number;
  readonly arms: number;
  /** Spiral rotation per emission. */
  readonly step: number;
  readonly shot: ShotDef;
  readonly ringEvery: number;
  readonly ringCount: number;
  readonly ringShot: ShotDef;
}

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
  readonly salvo: SalvoDef;
  readonly siege: SiegeDef;
  readonly ultima: UltimaDef;
}

type PartSpec = Omit<PartDef, 'roles' | 'muzzle' | 'turn' | 'orbit'> & Partial<Pick<PartDef, 'roles' | 'muzzle' | 'turn' | 'orbit'>>;

const armor = (name: string, x: number, y: number, rad: number, hp: number): PartDef =>
  ({ name, kind: PartKind.Armor, x, y, rad, hp, roles: 0, muzzle: 0, turn: 0, orbit: false });

interface PodSpec { name: string; x: number; y: number; rad: number; hp: number; roles: number; muzzle: number; turn: number; orbit?: boolean }
const pod = (s: PodSpec): PartDef => ({ ...s, kind: PartKind.Pod, orbit: s.orbit ?? false });

export type { PartSpec };

function defineForm(def: Omit<FormDef, 'reach'>): FormDef {
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
  return Object.freeze({ ...def, reach });
}

// ---- PALADIN: the versatile hero's colossus ---------------------------------------------------------
const PALADIN_SEEKER = shot({
  kind: Proj.Seeker, spd: fx.lit(1.8), acc: fx.lit(0.02), maxSpd: fx.lit(2.6), turn: fx.deg(2), rad: fx.lit(3.4), dmg: 8, life: 160,
  flags: ShotFlag.Seek,
});

const PALADIN = defineForm({
  name: 'PALADIN',
  frame: Frame.Vanguard,
  speed: fx.lit(1.2),
  accel: fx.lit(0.05),
  bodyTurn: fx.deg(1.5),
  orbitTurn: 0,
  coreR: fx.fromInt(9),
  pickupR: fx.fromInt(30),
  parts: [
    armor('chest', fx.fromInt(16), 0, fx.fromInt(16), 130),
    armor('wingL', fx.fromInt(-2), fx.fromInt(30), fx.fromInt(16), 90),
    armor('wingR', fx.fromInt(-2), fx.fromInt(-30), fx.fromInt(16), 90),
    armor('back', fx.fromInt(-24), 0, fx.fromInt(16), 80),
    pod({ name: 'cannonL', x: fx.fromInt(10), y: fx.fromInt(20), rad: fx.fromInt(10), hp: 70, roles: Role.Salvo | Role.Ultima, muzzle: fx.fromInt(14), turn: fx.deg(3) }),
    pod({ name: 'cannonR', x: fx.fromInt(10), y: fx.fromInt(-20), rad: fx.fromInt(10), hp: 70, roles: Role.Salvo | Role.Ultima, muzzle: fx.fromInt(14), turn: fx.deg(3) }),
    pod({ name: 'prow', x: fx.fromInt(36), y: 0, rad: fx.fromInt(10), hp: 80, roles: Role.Siege, muzzle: fx.fromInt(16), turn: fx.deg(2) }),
  ],
  salvo: {
    windup: 14, recovery: 22, cost: 500, count: 5, spread: fx.deg(40),
    shot: shot({ kind: Proj.Heavy, spd: fx.lit(2.2), rad: fx.fromInt(6), dmg: 12, life: 220 }),
  },
  siege: {
    windup: 40, recovery: 45, cost: 4500, count: 1, spread: 0, recoil: fx.lit(1.2),
    shot: shot({ kind: Proj.Heavy, spd: fx.lit(1.4), rad: fx.fromInt(12), dmg: 26, life: 210, burst: { count: 8, shot: PALADIN_SEEKER } }),
  },
  ultima: {
    windup: 96, recovery: 130, cost: 35000, duration: 240, cooldown: 600, interval: 6, arms: 4, step: fx.deg(9),
    shot: shot({ kind: Proj.Orb, spd: fx.lit(1.9), rad: fx.fromInt(4), dmg: 9, life: 300 }),
    ringEvery: 60, ringCount: 24,
    ringShot: shot({ kind: Proj.Orb, spd: fx.lit(1.5), rad: fx.fromInt(5), dmg: 10, life: 380 }),
  },
});

// ---- TEMPEST: the fast striker's colossus (light, quick to turn, four orbiting bit cannons) ------------
const BIT_ORBIT = fx.lit(21.21);
const bit = (name: string, sx: number, sy: number): PartDef =>
  pod({ name, x: sx * BIT_ORBIT, y: sy * BIT_ORBIT, rad: fx.fromInt(8), hp: 55, roles: Role.Salvo | Role.Siege | Role.Ultima, muzzle: fx.fromInt(10), turn: fx.deg(4.5), orbit: true });

const TEMPEST = defineForm({
  name: 'TEMPEST',
  frame: Frame.Gale,
  speed: fx.lit(1.7),
  accel: fx.lit(0.08),
  bodyTurn: fx.deg(2.2),
  orbitTurn: fx.deg(2),
  coreR: fx.fromInt(8),
  pickupR: fx.fromInt(28),
  parts: [
    armor('shield', fx.fromInt(14), 0, fx.fromInt(13), 80),
    armor('back', fx.fromInt(-14), 0, fx.fromInt(12), 60),
    bit('bit1', 1, 1),
    bit('bit2', -1, 1),
    bit('bit3', -1, -1),
    bit('bit4', 1, -1),
  ],
  salvo: {
    windup: 12, recovery: 18, cost: 500, count: 3, spread: fx.deg(14),
    shot: shot({ kind: Proj.Orb, spd: fx.lit(3), rad: fx.lit(4.2), dmg: 8, life: 160 }),
  },
  siege: {
    windup: 36, recovery: 40, cost: 4500, count: 2, spread: fx.deg(30), recoil: fx.lit(0.6),
    shot: shot({
      kind: Proj.Seeker, spd: fx.lit(1.8), acc: fx.lit(0.04), maxSpd: fx.lit(3), turn: fx.deg(3), rad: fx.lit(3.6), dmg: 11, life: 260,
      flags: ShotFlag.Seek,
    }),
  },
  ultima: {
    windup: 90, recovery: 120, cost: 35000, duration: 240, cooldown: 600, interval: 5, arms: 3, step: fx.deg(13),
    shot: shot({ kind: Proj.Blade, spd: fx.lit(2.6), rad: fx.lit(3.6), dmg: 8, life: 200 }),
    ringEvery: 45, ringCount: 30,
    ringShot: shot({ kind: Proj.Blade, spd: fx.lit(2), rad: fx.lit(3.2), dmg: 8, life: 260 }),
  },
});

// ---- FORTRESS: the heavy bunker's colossus (the slowest, thickest, biggest shells) ---------------------
const FORTRESS = defineForm({
  name: 'FORTRESS',
  frame: Frame.Juggernaut,
  speed: fx.lit(0.8),
  accel: fx.lit(0.03),
  bodyTurn: fx.deg(0.9),
  orbitTurn: 0,
  coreR: fx.fromInt(11),
  pickupR: fx.fromInt(44),
  parts: [
    armor('front', fx.fromInt(26), 0, fx.fromInt(22), 190),
    armor('frontL', fx.fromInt(14), fx.fromInt(34), fx.fromInt(20), 150),
    armor('frontR', fx.fromInt(14), fx.fromInt(-34), fx.fromInt(20), 150),
    armor('rearL', fx.fromInt(-18), fx.fromInt(34), fx.fromInt(20), 140),
    armor('rearR', fx.fromInt(-18), fx.fromInt(-34), fx.fromInt(20), 140),
    armor('back', fx.fromInt(-34), 0, fx.fromInt(22), 160),
    pod({ name: 'mortar', x: fx.fromInt(46), y: 0, rad: fx.fromInt(14), hp: 130, roles: Role.Siege, muzzle: fx.fromInt(22), turn: fx.deg(1) }),
    pod({ name: 'turretL', x: fx.fromInt(-2), y: fx.fromInt(52), rad: fx.fromInt(12), hp: 90, roles: Role.Salvo | Role.Ultima, muzzle: fx.fromInt(18), turn: fx.deg(2) }),
    pod({ name: 'turretR', x: fx.fromInt(-2), y: fx.fromInt(-52), rad: fx.fromInt(12), hp: 90, roles: Role.Salvo | Role.Ultima, muzzle: fx.fromInt(18), turn: fx.deg(2) }),
  ],
  salvo: {
    windup: 18, recovery: 30, cost: 800, count: 7, spread: fx.deg(84),
    shot: shot({ kind: Proj.Heavy, spd: fx.lit(1.6), rad: fx.fromInt(8), dmg: 16, life: 300 }),
  },
  siege: {
    windup: 48, recovery: 60, cost: 5500, count: 1, spread: 0, recoil: fx.lit(1.5),
    shot: shot({
      kind: Proj.Heavy, spd: fx.lit(1.2), rad: fx.fromInt(14), dmg: 40, life: 320,
      burst: { count: 24, shot: shot({ kind: Proj.Shard, spd: fx.lit(2), rad: fx.fromInt(3), dmg: 10, life: 120 }) },
    }),
  },
  ultima: {
    windup: 110, recovery: 150, cost: 38000, duration: 240, cooldown: 720, interval: 6, arms: 5, step: fx.deg(7),
    shot: shot({ kind: Proj.Orb, spd: fx.lit(1.7), rad: fx.fromInt(5), dmg: 11, life: 320 }),
    ringEvery: 75, ringCount: 36,
    ringShot: shot({ kind: Proj.Heavy, spd: fx.lit(1.3), rad: fx.fromInt(7), dmg: 12, life: 420 }),
  },
});

/** Indexed by frame: the boss form each robot becomes. */
export const FORMS: readonly FormDef[] = [PALADIN, TEMPEST, FORTRESS];

if (FORMS.length !== FRAME_COUNT || FORMS.some((form, frame) => form.frame !== frame)) throw new RangeError('FORMS must list one boss form per frame, in frame order');
