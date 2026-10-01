import { fx } from '@metronome/engine';
import { Frame } from './frame-ids.ts';
import { armor, big, core, defineForm, Pattern, pod, Role } from './formkit.ts';
import type { FrameStats } from './frames.ts';
import { Proj, shot, ShotFlag } from './shots.ts';
import type { ShotDef } from './shots.ts';

/**
 * SHADE, the stealth ninja: pairs of shuriken that arc out and cross ahead of it, and a veil that hides it from everything
 * that picks targets. Its colossus, KITSUNE, is a fox spirit: a masked head with snout and ears, haunch armour and nine long
 * tail plumes fanned behind it, foxfire at their tips.
 */
export const SHADE_STATS: FrameStats = {
  hp: 84, windowCap: 20, windowTicks: 60, speed: fx.lit(2.8), accel: fx.lit(0.34), brake: fx.lit(0.68), hurtR: fx.lit(2.3), bodyR: fx.fromInt(8), grazeR: fx.fromInt(15),
  boost: { speed: fx.lit(7.2), ticks: 12, dodge: 6, cooldown: 38 },
};

const SHURIKEN_SPEED = fx.lit(2.6);
const SHURIKEN_LIFE = 84;
const SHURIKEN_CURVE = fx.deg(1.4);
/** A shuriken curving by `turn` per tick (negative: clockwise). */
const shuriken = (turn: number, rad: number, dmg: number): ShotDef => shot({ kind: Proj.Shuriken, spd: SHURIKEN_SPEED, rad, dmg, life: SHURIKEN_LIFE, turn });

/**
 * How far ahead a shot launched `offset` to the left of the aim, and curving back to the right, crosses the aim line again
 * (its whole straight-line run if it never does): the same fixed-point steps projectiles.ts moves it by.
 */
function crossing(def: ShotDef, offset: number): number {
  let x = 0;
  let y = 0;
  let heading = offset;
  for (let tick = 0; tick < def.life; tick++) {
    heading = (heading + def.turn) & fx.ANGLE_MASK;
    x += fx.mul(fx.cos(heading), def.spd);
    y += fx.mul(fx.sin(heading), def.spd);
    if (y <= 0) break;
  }
  return x;
}

const LEFT = shuriken(-SHURIKEN_CURVE, fx.lit(2.3), 5);
const THROW_ANGLE = fx.deg(40);

export const SHADE = {
  /**
   * SHURIKEN: each throw sends two stars out `angle` either side of the aim, curving back so that they cross the aim line
   * `reach` ahead of the muzzle. The throw that breaks a cloak throws AMBUSH stars on the same paths.
   */
  shuriken: {
    interval: 10,
    cost: 22,
    angle: THROW_ANGLE,
    /** Leaves to the left of the aim and curves right; `right` is its mirror image. */
    left: LEFT,
    right: shuriken(SHURIKEN_CURVE, fx.lit(2.3), 5),
    ambushLeft: shuriken(-SHURIKEN_CURVE, fx.lit(2.8), 9),
    ambushRight: shuriken(SHURIKEN_CURVE, fx.lit(2.8), 9),
    reach: crossing(LEFT, THROW_ANGLE),
  },
  /** SHADOW VEIL: `ticks` of cloak (see query.ts targetable); paid and cooling down from activation. */
  veil: { ticks: 150, cost: 150, cooldown: 480 },
} as const;

/** Tail plumes fan behind the core at radius 36 (design scale): the siege pods at the centre, salvo and ultima pods outside. */
const SNARE = Role.Siege;
const FOXFIRE = Role.Salvo | Role.Ultima;
const tail = (name: string, x: number, y: number, roles: number) =>
  pod({ name, x: fx.fromInt(x), y: fx.fromInt(y), rad: fx.fromInt(6), hp: 40, roles, muzzle: fx.fromInt(8), turn: fx.deg(3) });

/** A lobbed foxfire that lands and becomes a mine. */
const FOXFIRE_MINE = shot({
  kind: Proj.Mine, spd: 0, rad: fx.fromInt(4), dmg: 0, life: 360, flags: ShotFlag.Inert | ShotFlag.Proximity, arm: 20, trigger: fx.fromInt(34),
  burst: { count: 10, shot: shot({ kind: Proj.Shard, spd: fx.lit(2.2), rad: fx.lit(2.6), dmg: 6, life: 70 }) },
});

export const KITSUNE = defineForm({
  name: 'KITSUNE',
  frame: Frame.Shade,
  speed: fx.lit(1.6),
  accel: fx.lit(0.075),
  bodyTurn: fx.deg(2),
  orbitTurn: 0,
  coreR: core(fx.fromInt(8)),
  pickupR: big(fx.fromInt(28)),
  parts: [
    armor('mask', fx.fromInt(15), 0, fx.fromInt(12), 90),
    armor('haunch', fx.fromInt(-15), 0, fx.fromInt(12), 70),
    // At 180, 164, 196, 148, 212, 132, 228, 116 and 244 degrees.
    tail('tail0', -36, 0, SNARE),
    tail('tail1', -35, 10, SNARE),
    tail('tail2', -35, -10, SNARE),
    tail('tail3', -31, 19, FOXFIRE),
    tail('tail4', -31, -19, FOXFIRE),
    tail('tail5', -24, 27, FOXFIRE),
    tail('tail6', -24, -27, FOXFIRE),
    tail('tail7', -16, 32, FOXFIRE),
    tail('tail8', -16, -32, FOXFIRE),
  ],
  // FOXFIRE: foxfire that drifts to the left as it flies. Gently: the salvo pods sit behind the core and their fans only
  // converge on the aim far ahead, so a stronger curl (0.8 degrees a tick) never got further than 171 units out.
  salvo: {
    windup: 12, recovery: 18, cost: 500, pattern: Pattern.Volley, count: 2, spread: fx.deg(18),
    shot: shot({ kind: Proj.Orb, spd: fx.lit(2.4), rad: fx.lit(3.6), dmg: 7, life: 170, turn: fx.deg(0.1) }),
  },
  // FOXFIRE SNARE: lobbed foxfire lands and becomes a minefield around the target. Every siege tail's first shell lands on
  // the target itself, so each also throws two around it (at opposite points of the circle): a field, not one stacked heap.
  siege: {
    windup: 38, recovery: 44, cost: 4600, recoil: fx.lit(0.3), pattern: Pattern.Artillery, count: 3, radius: fx.fromInt(56), range: fx.fromInt(420),
    shell: shot({ kind: Proj.Orb, spd: fx.lit(2.2), rad: fx.fromInt(4), dmg: 0, life: 220, flags: ShotFlag.Inert | ShotFlag.Lob, burst: { count: 1, shot: FOXFIRE_MINE } }),
  },
  // NIGHT PARADE
  ultima: {
    windup: 94, recovery: 128, cost: 30500, duration: 240, cooldown: 620,
    pattern: Pattern.Spiral, interval: 8, arms: 2, step: fx.deg(15),
    shot: shot({ kind: Proj.Shuriken, spd: fx.lit(2.2), rad: fx.lit(3.2), dmg: 7, life: 240, turn: fx.deg(0.6) }),
    ringEvery: 48, ringPerPod: 5,
    ringShot: shot({ kind: Proj.Orb, spd: fx.lit(1.6), rad: fx.fromInt(4), dmg: 9, life: 340 }),
  },
});
