import { fx } from '@metronome/engine';
import { Frame } from './frame-ids.ts';
import { armor, big, core, defineForm, Pattern, pod, Role } from './formkit.ts';
import type { FrameStats } from './frames.ts';
import { Proj, shot, ShotFlag } from './shots.ts';

/**
 * GAUNTLET, the super robot: knuckle shots from alternating arms that knock robots back, and a rocket punch that flies out
 * and comes home. Its colossus, ATLAS, has a massive chest and V-crest, shoulder pylons, two giant fist pods and twin back
 * boosters.
 */
export const GAUNTLET_STATS: FrameStats = {
  hp: 190, windowCap: 46, windowTicks: 60, speed: fx.lit(1.9), accel: fx.lit(0.18), brake: fx.lit(0.36), hurtR: fx.lit(3.9), bodyR: fx.fromInt(13), grazeR: fx.fromInt(21),
  boost: { speed: fx.lit(6.4), ticks: 12, dodge: 6, cooldown: 48 },
};

export const GAUNTLET = {
  /**
   * KNUCKLE CANNON: one fist per shot, from the arms in turn, `offset` either side of the aim line. Each shoves what it strikes
   * (its core or its shield): a jolt of a unit or two, a few units off a pilot walking into the stream; it stalls an approach
   * and never pins anyone.
   */
  knuckle: {
    interval: 12,
    cost: 27,
    offset: fx.fromInt(7),
    shot: shot({ kind: Proj.Fist, spd: fx.lit(2.4), rad: fx.lit(4.2), dmg: 11, life: 80, knock: fx.lit(1.1) }),
  },
  /**
   * ROCKET PUNCH (a tap): the left fist flies out to about 225 units from GAUNTLET (a little past the knuckles' reach), turns
   * for home (or turns at its first strike) and is caught; it can be launched only while no fist of its own is out. Homeward it
   * turns at most `turn` a tick, and at top speed that circle (radius maxSpd / turn in radians: about 17 units) must fit inside
   * the radius it is caught in (its owner's pickup radius, bodyR + ORB_PICKUP_PAD, plus its own: 26), or a fist passing a still
   * owner just outside that radius would circle it until it expired. A strike on the way home pulls the target toward GAUNTLET.
   */
  rocket: {
    cost: 120,
    cooldown: 120,
    fist: shot({
      kind: Proj.Fist, spd: fx.lit(1.8), acc: fx.lit(0.05), maxSpd: fx.lit(3), rad: fx.fromInt(7), dmg: 22, life: 220,
      flags: ShotFlag.Return, returnAt: 76, turn: fx.deg(10), knock: fx.lit(2.8),
    }),
  },
} as const;

const fist = (name: string, y: number) =>
  pod({ name, x: fx.fromInt(22), y: fx.fromInt(y), rad: fx.fromInt(12), hp: 90, roles: Role.Salvo | Role.Siege | Role.Ultima, muzzle: fx.fromInt(12), turn: fx.deg(2.2) });
const booster = (name: string, y: number) =>
  pod({ name, x: fx.fromInt(-30), y: fx.fromInt(y), rad: fx.fromInt(8), hp: 60, roles: Role.Ultima, muzzle: fx.fromInt(10), turn: fx.deg(2) });

export const ATLAS = defineForm({
  name: 'ATLAS',
  frame: Frame.Gauntlet,
  speed: fx.lit(1),
  accel: fx.lit(0.045),
  bodyTurn: fx.deg(1.2),
  orbitTurn: 0,
  coreR: core(fx.fromInt(10)),
  pickupR: big(fx.fromInt(38)),
  parts: [
    armor('chest', fx.fromInt(14), 0, fx.fromInt(16), 150),
    armor('crest', fx.fromInt(32), 0, fx.fromInt(9), 80),
    armor('shoulderL', fx.fromInt(-2), fx.fromInt(32), fx.fromInt(16), 110),
    armor('shoulderR', fx.fromInt(-2), fx.fromInt(-32), fx.fromInt(16), 110),
    armor('back', fx.fromInt(-24), 0, fx.fromInt(16), 110),
    fist('fistL', 46),
    fist('fistR', -46),
    booster('boosterL', 22),
    booster('boosterR', -22),
  ],
  // KNUCKLE BARRAGE
  salvo: {
    windup: 15, recovery: 24, cost: 600, pattern: Pattern.Volley, count: 4, spread: fx.deg(22),
    shot: shot({ kind: Proj.Fist, spd: fx.lit(2.4), rad: fx.lit(5.5), dmg: 12, life: 160, knock: fx.lit(0.9) }),
  },
  // GIGA ROCKET PUNCH: each fist pod's fist flies out about 280 units along the pod's facing, swings in across the line of
  // fire and comes home; the pod is away until it is caught (ptAway). Homeward its turning circle at top speed (radius about
  // 40) fits well inside the radius ATLAS catches it in (pickupR + its own radius: 70), so it homes from any approach.
  siege: {
    windup: 42, recovery: 56, cost: 5200, recoil: fx.lit(1), pattern: Pattern.Volley, count: 1, spread: 0,
    shot: shot({
      kind: Proj.Fist, spd: fx.lit(1.4), acc: fx.lit(0.03), maxSpd: fx.lit(2.8), rad: fx.fromInt(13), dmg: 30, life: 300,
      flags: ShotFlag.Return, returnAt: 110, turn: fx.deg(4), knock: fx.lit(2.6),
    }),
  },
  // FINAL BREAKER
  ultima: {
    windup: 106, recovery: 146, cost: 32500, duration: 240, cooldown: 700,
    pattern: Pattern.Spiral, interval: 7, arms: 3, step: fx.deg(9),
    shot: shot({ kind: Proj.Heavy, spd: fx.lit(1.8), rad: fx.fromInt(5), dmg: 10, life: 300 }),
    ringEvery: 60, ringPerPod: 10,
    ringShot: shot({ kind: Proj.Fist, spd: fx.lit(1.4), rad: fx.fromInt(6), dmg: 11, life: 360, knock: fx.lit(0.6) }),
  },
});
