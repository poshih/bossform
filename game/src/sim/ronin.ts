import { fx } from '@metronome/engine';
import { Frame } from './frame-ids.ts';
import { armor, big, core, defineForm, Pattern, pod, Role } from './formkit.ts';
import type { FrameStats } from './frames.ts';
import { Proj, shot } from './shots.ts';

/**
 * RONIN, the samurai duelist: a katana sweep of short-lived slashes, and a parry that sends shots back and cuts beams. Its
 * colossus, SHOGUN, wears a crested helm and great shoulder plates, cuts CRESCENT slashes with its two arm blades, draws ISSEN
 * (one sword-beam flash) from the great sword (odachi) held forward on its centreline, and pours THOUSAND CUTS from the four
 * banner blades fanned behind it.
 */
export const RONIN_STATS: FrameStats = {
  hp: 110, windowCap: 26, windowTicks: 60, speed: fx.lit(2.6), accel: fx.lit(0.32), brake: fx.lit(0.64), hurtR: fx.lit(2.7), bodyR: fx.fromInt(9), grazeR: fx.fromInt(17),
  boost: { speed: fx.lit(7.8), ticks: 12, dodge: 6, cooldown: 40 },
};

export const RONIN = {
  /** KATANA: a sweep of `count` slashes fanned across `spread`; they fade within a few body lengths. */
  katana: {
    interval: 14,
    cost: 32,
    count: 5,
    spread: fx.deg(76),
    shot: shot({ kind: Proj.Slash, spd: fx.lit(2.6), rad: fx.lit(3.4), dmg: 7, life: 24 }),
  },
  /**
   * PARRY (a tap, free): for `ticks` ticks the arc in front of the aim (`radius` out, `halfArc` either side; under a right angle)
   * sends hostile shots back along the aim and cuts beams short. It is a commitment: while it lasts the shield is down and the
   * katana does not cut, and a parry that turns nothing back leaves the full `cooldown`. The first thing it turns back cuts that
   * cooldown to at most `riposte` ticks.
   */
  parry: { ticks: 14, radius: fx.fromInt(36), halfArc: fx.deg(80), cooldown: 150, riposte: 50 },
} as const;

const blade = (name: string, y: number) =>
  pod({ name, x: fx.fromInt(14), y: fx.fromInt(y), rad: fx.fromInt(9), hp: 70, roles: Role.Salvo, muzzle: fx.fromInt(16), turn: fx.deg(3.2) });
const banner = (name: string, x: number, y: number) =>
  pod({ name, x: fx.fromInt(x), y: fx.fromInt(y), rad: fx.fromInt(7), hp: 45, roles: Role.Ultima, muzzle: fx.fromInt(10), turn: fx.deg(2.6) });

export const SHOGUN = defineForm({
  name: 'SHOGUN',
  frame: Frame.Ronin,
  speed: fx.lit(1.3),
  accel: fx.lit(0.06),
  bodyTurn: fx.deg(1.8),
  orbitTurn: 0,
  coreR: core(fx.fromInt(9)),
  pickupR: big(fx.fromInt(30)),
  parts: [
    armor('kabuto', fx.fromInt(18), 0, fx.fromInt(13), 110),
    armor('sodeL', 0, fx.fromInt(28), fx.fromInt(15), 90),
    armor('sodeR', 0, fx.fromInt(-28), fx.fromInt(15), 90),
    armor('dou', fx.fromInt(-20), 0, fx.fromInt(15), 90),
    blade('bladeL', 36),
    blade('bladeR', -36),
    banner('banner1', -30, 22),
    banner('banner2', -36, 8),
    banner('banner3', -36, -8),
    banner('banner4', -30, -22),
    // ISSEN leaves the great sword on the centreline. Pods fire along their own facing, which swings to the aim's angle, so
    // beams from the arm blades would run parallel, 108 units apart, either side of the pilot they were aimed at. Heavier than
    // the arm blades and the banners, it swings slower than they do, if a little faster than the body.
    pod({ name: 'odachi', x: fx.fromInt(40), y: 0, rad: fx.fromInt(8), hp: 80, roles: Role.Siege, muzzle: fx.fromInt(16), turn: fx.deg(2) }),
  ],
  // CRESCENT
  salvo: {
    windup: 14, recovery: 22, cost: 550, pattern: Pattern.Volley, count: 7, spread: fx.deg(64),
    shot: shot({ kind: Proj.Slash, spd: fx.lit(2.2), rad: fx.fromInt(5), dmg: 10, life: 100 }),
  },
  // ISSEN: a sword-beam flash
  siege: { windup: 40, recovery: 48, cost: 4800, recoil: fx.lit(0.8), pattern: Pattern.Beam, duration: 10, length: fx.fromInt(420), width: fx.fromInt(4), every: 2, dmg: 7 },
  // THOUSAND CUTS
  ultima: {
    windup: 98, recovery: 135, cost: 31000, duration: 240, cooldown: 640,
    pattern: Pattern.Spiral, interval: 6, arms: 2, step: fx.deg(17),
    shot: shot({ kind: Proj.Slash, spd: fx.lit(2.4), rad: fx.lit(3.6), dmg: 8, life: 220 }),
    ringEvery: 60, ringPerPod: 8,
    ringShot: shot({ kind: Proj.Slash, spd: fx.lit(1.8), rad: fx.fromInt(4), dmg: 9, life: 300 }),
  },
});
