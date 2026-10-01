import { fx } from '@metronome/engine';
import { Frame, FRAME_COUNT } from './frame-ids.ts';
import { armor, big, core, defineForm, Pattern, pod, Role } from './formkit.ts';
import type { FormDef, PartDef } from './formkit.ts';
import { ATLAS } from './gauntlet.ts';
import { ARMADA } from './hailstorm.ts';
import { BALLISTA } from './longbow.ts';
import { HELIOS } from './prism.ts';
import { SHOGUN } from './ronin.ts';
import { KITSUNE } from './shade.ts';
import { Proj, shot, ShotFlag } from './shots.ts';

/**
 * Boss forms: the colossus each robot becomes (the kit they are written in is formkit.ts). The original three robots' forms
 * are defined here; every other form lives next to its robot, and FORMS lists them all by frame.
 */
export { armor, big, core, defineForm, PartKind, Pattern, pod, Role } from './formkit.ts';
export type {
  ArtilleryAttack, AttackTiming, BeamAttack, BombardUltima, CarpetAttack, CarpetUltima, FormDef, PartDef, PartSpec, PodSpec, SalvoDef,
  SiegeDef, SpiralUltima, UltimaBarrage, UltimaDef, VolleyAttack, VolleyDef, WheelUltima,
} from './formkit.ts';

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
  coreR: core(fx.fromInt(9)),
  pickupR: big(fx.fromInt(30)),
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
    windup: 14, recovery: 22, cost: 500, pattern: Pattern.Volley, count: 5, spread: fx.deg(40),
    shot: shot({ kind: Proj.Heavy, spd: fx.lit(2.2), rad: fx.fromInt(6), dmg: 12, life: 220 }),
  },
  siege: {
    windup: 40, recovery: 45, cost: 4500, pattern: Pattern.Volley, count: 1, spread: 0, recoil: fx.lit(1.2),
    shot: shot({ kind: Proj.Heavy, spd: fx.lit(1.4), rad: fx.fromInt(12), dmg: 26, life: 210, burst: { count: 8, shot: PALADIN_SEEKER } }),
  },
  ultima: {
    windup: 96, recovery: 130, cost: 30000, duration: 240, cooldown: 600, pattern: Pattern.Spiral, interval: 6, arms: 4, step: fx.deg(9),
    shot: shot({ kind: Proj.Orb, spd: fx.lit(1.9), rad: fx.fromInt(4), dmg: 9, life: 300 }),
    ringEvery: 60, ringPerPod: 12,
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
  coreR: core(fx.fromInt(8)),
  pickupR: big(fx.fromInt(28)),
  parts: [
    armor('shield', fx.fromInt(14), 0, fx.fromInt(13), 80),
    armor('back', fx.fromInt(-14), 0, fx.fromInt(12), 60),
    bit('bit1', 1, 1),
    bit('bit2', -1, 1),
    bit('bit3', -1, -1),
    bit('bit4', 1, -1),
  ],
  salvo: {
    windup: 12, recovery: 18, cost: 500, pattern: Pattern.Volley, count: 3, spread: fx.deg(14),
    shot: shot({ kind: Proj.Orb, spd: fx.lit(3), rad: fx.lit(4.2), dmg: 8, life: 160 }),
  },
  siege: {
    windup: 36, recovery: 40, cost: 4500, pattern: Pattern.Volley, count: 2, spread: fx.deg(30), recoil: fx.lit(0.6),
    shot: shot({
      kind: Proj.Seeker, spd: fx.lit(1.8), acc: fx.lit(0.04), maxSpd: fx.lit(3), turn: fx.deg(3), rad: fx.lit(3.6), dmg: 11, life: 260,
      flags: ShotFlag.Seek,
    }),
  },
  ultima: {
    windup: 90, recovery: 120, cost: 30000, duration: 240, cooldown: 600, pattern: Pattern.Spiral, interval: 5, arms: 3, step: fx.deg(13),
    shot: shot({ kind: Proj.Blade, spd: fx.lit(2.6), rad: fx.lit(3.6), dmg: 8, life: 200 }),
    ringEvery: 45, ringPerPod: 8,
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
  coreR: core(fx.fromInt(11)),
  pickupR: big(fx.fromInt(44)),
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
    windup: 18, recovery: 30, cost: 800, pattern: Pattern.Volley, count: 7, spread: fx.deg(84),
    shot: shot({ kind: Proj.Heavy, spd: fx.lit(1.6), rad: fx.fromInt(8), dmg: 16, life: 300 }),
  },
  siege: {
    windup: 48, recovery: 60, cost: 5500, pattern: Pattern.Volley, count: 1, spread: 0, recoil: fx.lit(1.5),
    shot: shot({
      kind: Proj.Heavy, spd: fx.lit(1.2), rad: fx.fromInt(14), dmg: 40, life: 320,
      burst: { count: 24, shot: shot({ kind: Proj.Shard, spd: fx.lit(2), rad: fx.fromInt(3), dmg: 10, life: 120 }) },
    }),
  },
  ultima: {
    windup: 110, recovery: 150, cost: 33000, duration: 240, cooldown: 720, pattern: Pattern.Spiral, interval: 6, arms: 5, step: fx.deg(7),
    shot: shot({ kind: Proj.Orb, spd: fx.lit(1.7), rad: fx.fromInt(5), dmg: 11, life: 320 }),
    ringEvery: 75, ringPerPod: 18,
    ringShot: shot({ kind: Proj.Heavy, spd: fx.lit(1.3), rad: fx.fromInt(7), dmg: 12, life: 420 }),
  },
});

/** Indexed by frame: the boss form each robot becomes. */
export const FORMS: readonly FormDef[] = [PALADIN, TEMPEST, FORTRESS, BALLISTA, HELIOS, ARMADA, SHOGUN, KITSUNE, ATLAS];

if (FORMS.length !== FRAME_COUNT || FORMS.some((form, frame) => form.frame !== frame)) throw new RangeError('FORMS must list one boss form per frame, in frame order');
