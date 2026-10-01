import { fx } from '@metronome/engine';
import { Frame } from './frame-ids.ts';
import { armor, big, core, defineForm, Pattern, pod, Role } from './formkit.ts';
import type { FrameStats } from './frames.ts';
import { Proj, shot, shotReach, ShotFlag } from './shots.ts';

/**
 * HAILSTORM, the bomber and walking arsenal: a rotary cannon that fires faster the longer it spins, and carpet bombs lobbed
 * over everything. Its colossus, ARMADA, is a flying battleship: a long hull from bow to stern, a bridge tower, missile silo
 * pods and broadside gatling turrets.
 */
export const HAILSTORM_STATS: FrameStats = {
  hp: 160, windowCap: 40, windowTicks: 60, speed: fx.lit(1.8), accel: fx.lit(0.16), brake: fx.lit(0.32), hurtR: fx.lit(3.6), bodyR: fx.fromInt(12), grazeR: fx.fromInt(20),
  boost: { speed: fx.lit(6), ticks: 12, dodge: 6, cooldown: 50 },
};

export const HAILSTORM = {
  /**
   * ROTARY CANNON: each shot spins it up by `spinPerShot` (at most `spinMax`), and every tick fire is not held it spins down by
   * one. The spin sets the refire interval: `slowest` ticks unspun, `slowest - spinUp` at full spin (6 to 20 rounds a second).
   * Shots leave alternately either side of the aim, each by a random amount up to `jitter`: a spray spread evenly across the
   * cone, the aim line included (a fixed ±jitter would fly a V with a hole where the target is: 25 units wide at 240).
   */
  cannon: {
    cost: 7,
    spinMax: 48,
    spinPerShot: 6,
    slowest: 10,
    spinUp: 7,
    jitter: fx.deg(3),
    shot: shot({ kind: Proj.Bolt, spd: fx.lit(2.7), rad: fx.lit(2), dmg: 4, life: 140 }),
  },
  /** CARPET BOMB: a line of `count` bombs lobbed along the aim, `first` ahead of the muzzle and `gap` apart; nearer ones land first. */
  carpet: {
    cost: 200,
    cooldown: 300,
    count: 6,
    first: fx.fromInt(70),
    gap: fx.fromInt(50),
    bomb: shot({ kind: Proj.Bomb, spd: fx.lit(2.4), rad: fx.fromInt(4), dmg: 0, life: 180, flags: ShotFlag.Inert | ShotFlag.Lob, blastR: fx.fromInt(26), blastDmg: 10 }),
  },
} as const;

const CARPET = HAILSTORM.carpet;
if (CARPET.first + CARPET.gap * (CARPET.count - 1) > shotReach(CARPET.bomb)) throw new RangeError('HAILSTORM carpet bombs cannot reach the end of their line');

const silo = (name: string, y: number) =>
  pod({ name, x: fx.fromInt(-18), y: fx.fromInt(y), rad: fx.fromInt(9), hp: 70, roles: Role.Siege | Role.Ultima, muzzle: fx.fromInt(10), turn: fx.deg(2) });
const gatling = (name: string, y: number) =>
  pod({ name, x: fx.fromInt(18), y: fx.fromInt(y), rad: fx.fromInt(9), hp: 70, roles: Role.Salvo | Role.Ultima, muzzle: fx.fromInt(14), turn: fx.deg(2.8) });

export const ARMADA = defineForm({
  name: 'ARMADA',
  frame: Frame.Hailstorm,
  speed: fx.lit(0.9),
  accel: fx.lit(0.035),
  bodyTurn: fx.deg(1),
  orbitTurn: 0,
  coreR: core(fx.fromInt(10)),
  pickupR: big(fx.fromInt(40)),
  parts: [
    armor('bow', fx.fromInt(34), 0, fx.fromInt(16), 150),
    armor('bridge', fx.fromInt(8), 0, fx.fromInt(14), 120),
    armor('hullL', fx.fromInt(-8), fx.fromInt(24), fx.fromInt(16), 120),
    armor('hullR', fx.fromInt(-8), fx.fromInt(-24), fx.fromInt(16), 120),
    armor('stern', fx.fromInt(-36), 0, fx.fromInt(16), 120),
    silo('vlsL', 12),
    silo('vlsR', -12),
    gatling('gatlingL', 28),
    gatling('gatlingR', -28),
  ],
  // BROADSIDE
  salvo: {
    windup: 16, recovery: 26, cost: 650, pattern: Pattern.Volley, count: 9, spread: fx.deg(30),
    shot: shot({ kind: Proj.Bolt, spd: fx.lit(2.4), rad: fx.lit(3.6), dmg: 7, life: 200 }),
  },
  // MISSILE CARNIVAL
  siege: {
    windup: 42, recovery: 52, cost: 5000, recoil: fx.lit(0.4), pattern: Pattern.Volley, count: 6, spread: fx.deg(150),
    shot: shot({
      kind: Proj.Missile, spd: fx.lit(1.2), acc: fx.lit(0.05), maxSpd: fx.lit(2.8), turn: fx.deg(2.6), rad: fx.fromInt(4), dmg: 10, life: 280,
      flags: ShotFlag.Seek,
    }),
  },
  // CARPET BOMBARDMENT
  ultima: {
    windup: 104, recovery: 140, cost: 32000, duration: 240, cooldown: 680,
    // The first bomb lands `first` ahead of each firing pod's muzzle: from the silos behind the bridge, 100 clears the bow.
    pattern: Pattern.Carpet, every: 30, count: 5, first: fx.fromInt(100), gap: fx.fromInt(60),
    shell: shot({ kind: Proj.Bomb, spd: fx.lit(2.4), rad: fx.fromInt(5), dmg: 0, life: 220, flags: ShotFlag.Inert | ShotFlag.Lob, blastR: fx.fromInt(30), blastDmg: 11 }),
    ringEvery: 60, ringPerPod: 8,
    // Curling, not seeking.
    ringShot: shot({ kind: Proj.Missile, spd: fx.lit(1.5), rad: fx.fromInt(4), dmg: 9, life: 360, turn: fx.deg(0.5) }),
  },
});
