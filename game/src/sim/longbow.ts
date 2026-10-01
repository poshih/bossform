import { fx } from '@metronome/engine';
import { Frame } from './frame-ids.ts';
import { armor, big, core, defineForm, Pattern, pod, Role } from './formkit.ts';
import type { FrameStats } from './frames.ts';
import { Proj, shot, ShotFlag } from './shots.ts';

/**
 * LONGBOW, the sniper: a rail rifle whose shot grows with the charge, and tripmines. Its colossus, BALLISTA, is a great siege
 * bow: a long rail spine, huge swept-back bow limbs, a stock, twin flechette guns and lens pods at the limb tips.
 */
export const LONGBOW_STATS: FrameStats = {
  hp: 96, windowCap: 24, windowTicks: 60, speed: fx.lit(1.9), accel: fx.lit(0.2), brake: fx.lit(0.44), hurtR: fx.lit(2.6), bodyR: fx.fromInt(9), grazeR: fx.fromInt(17),
  boost: { speed: fx.lit(6), ticks: 12, dodge: 6, cooldown: 52 },
};

export const LONGBOW = {
  /**
   * RAIL RIFLE: holding fire charges it by one each tick up to `full`, for `cost` energy per charging tick (a tick the pool
   * cannot pay, the charge holds). Letting go fires the strongest tier the charge reached (nothing below the first), then the
   * rifle cools down for `cooldown` ticks.
   */
  rail: {
    full: 60,
    cost: 2,
    cooldown: 18,
    /** Ascending: the shot each charge buys (SNAP, HALF, FULL). */
    tiers: [
      { charge: 12, shot: shot({ kind: Proj.Needle, spd: fx.lit(3), rad: fx.lit(2.2), dmg: 10, life: 200 }) },
      { charge: 36, shot: shot({ kind: Proj.Needle, spd: fx.lit(3.1), rad: fx.lit(2.8), dmg: 18, life: 240 }) },
      { charge: 60, shot: shot({ kind: Proj.Needle, spd: fx.lit(3.2), rad: fx.lit(3.4), dmg: 30, life: 280 }) },
    ],
  },
  /** TRIPMINE: a mine left where the robot stands. Once armed, anything hostile that comes near sets it off into shrapnel. */
  tripmine: {
    cost: 100,
    cooldown: 210,
    mine: shot({
      kind: Proj.Mine, spd: 0, rad: fx.fromInt(4), dmg: 0, life: 600, flags: ShotFlag.Inert | ShotFlag.Proximity, arm: 36, trigger: fx.fromInt(40),
      burst: { count: 14, shot: shot({ kind: Proj.Shard, spd: fx.lit(2.2), rad: fx.lit(2.6), dmg: 6, life: 70 }) },
    }),
  },
} as const;

const tiers = LONGBOW.rail.tiers;
if (tiers.some((tier, k) => k > 0 && tier.charge <= tiers[k - 1].charge) || tiers[tiers.length - 1].charge !== LONGBOW.rail.full) {
  throw new RangeError('LONGBOW rail tiers must rise, and the last must be the full charge');
}

const lens = (name: string, y: number) =>
  pod({ name, x: fx.fromInt(-10), y: fx.fromInt(y), rad: fx.fromInt(7), hp: 50, roles: Role.Ultima, muzzle: fx.fromInt(9), turn: fx.deg(2.4) });
const gun = (name: string, y: number) =>
  pod({ name, x: fx.fromInt(6), y: fx.fromInt(y), rad: fx.fromInt(8), hp: 60, roles: Role.Salvo, muzzle: fx.fromInt(12), turn: fx.deg(3) });

export const BALLISTA = defineForm({
  name: 'BALLISTA',
  frame: Frame.Longbow,
  speed: fx.lit(1),
  accel: fx.lit(0.04),
  bodyTurn: fx.deg(1.1),
  orbitTurn: 0,
  coreR: core(fx.fromInt(8)),
  pickupR: big(fx.fromInt(30)),
  parts: [
    armor('shroud', fx.fromInt(16), 0, fx.fromInt(12), 110),
    armor('limbL', fx.fromInt(-6), fx.fromInt(30), fx.fromInt(14), 80),
    armor('limbR', fx.fromInt(-6), fx.fromInt(-30), fx.fromInt(14), 80),
    armor('stock', fx.fromInt(-26), 0, fx.fromInt(14), 90),
    pod({ name: 'rail', x: fx.fromInt(40), y: 0, rad: fx.fromInt(9), hp: 90, roles: Role.Siege | Role.Ultima, muzzle: fx.fromInt(28), turn: fx.deg(1.2) }),
    gun('gunL', 16),
    gun('gunR', -16),
    lens('lensL', 44),
    lens('lensR', -44),
  ],
  // FLECHETTE
  salvo: {
    windup: 16, recovery: 24, cost: 600, pattern: Pattern.Volley, count: 3, spread: fx.deg(8),
    shot: shot({ kind: Proj.Needle, spd: fx.lit(3), rad: fx.fromInt(3), dmg: 10, life: 220 }),
  },
  // RAIL SHOT
  siege: {
    windup: 46, recovery: 52, cost: 5000, recoil: fx.lit(2), pattern: Pattern.Volley, count: 1, spread: 0,
    shot: shot({ kind: Proj.Needle, spd: fx.lit(3.2), rad: fx.fromInt(9), dmg: 36, life: 320 }),
  },
  // ARROW RAIN
  ultima: {
    windup: 100, recovery: 136, cost: 31000, duration: 240, cooldown: 660,
    pattern: Pattern.Bombard, every: 20, count: 3, radius: fx.fromInt(80), range: fx.fromInt(520),
    shell: shot({ kind: Proj.Needle, spd: fx.lit(2.6), rad: fx.fromInt(3), dmg: 0, life: 240, flags: ShotFlag.Inert | ShotFlag.Lob, blastR: fx.fromInt(20), blastDmg: 9 }),
    ringEvery: 60, ringPerPod: 8,
    ringShot: shot({ kind: Proj.Orb, spd: fx.lit(1.4), rad: fx.lit(4.6), dmg: 10, life: 380 }),
  },
});
