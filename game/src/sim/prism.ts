import { fx } from '@metronome/engine';
import { ENERGY_REGEN_DELAY, MIN_BEAM_TELL_TICKS, MIN_HITSCAN_TELL_TICKS } from './constants.ts';
import { Frame } from './frame-ids.ts';
import { armor, big, core, defineForm, Pattern, pod, Role } from './formkit.ts';
import type { FrameStats } from './frames.ts';
import { Proj, shot } from './shots.ts';

/**
 * PRISM, the beam specialist: a held beam and an instant lance, each shown first by a thin laser along exactly the line it
 * will fire on. Its colossus, HELIOS, is a floating sun disk: a crown, halo-ring armour, a keel, four orbiting prisms and a
 * forward solar cannon.
 */
export const PRISM_STATS: FrameStats = {
  hp: 104, windowCap: 26, windowTicks: 60, speed: fx.lit(2), accel: fx.lit(0.2), brake: fx.lit(0.44), hurtR: fx.lit(2.8), bodyR: fx.fromInt(10), grazeR: fx.fromInt(18),
  boost: { speed: fx.lit(6.4), ticks: 12, dodge: 6, cooldown: 46 },
};

/** The beam's tell and what its ticks cost (PRISM.beam lists them with the rest of the beam). */
const BEAM_TELL = { tell: 18, tellCost: 2, cost: 3 } as const;

export const PRISM = {
  /**
   * PRISM BEAM (held): pressing fire starts it; its first `tell` ticks are the tell (a thin laser), then it fires while fire is
   * held, pulsing `dmg` into whatever stops it every `every` ticks (the first pulse on its first firing tick). It starts on the
   * aim and follows it at `turn` per tick. It costs `tellCost` energy per tick of tell and `cost` per tick of fire; a tick the
   * pool cannot pay ends it, like letting go, and the weapon then cools down for `cooldown` ticks.
   * A beam starts only if the pool holds `start`: its whole tell and its first firing tick. So the tell never lies (held, it
   * always ends in the beam), and a pilot who keeps fire held on a dry pool gets a beam as soon as the pool refills that far,
   * instead of telling again and again without ever firing (which also kept the pool from refilling).
   * The turn is the counterplay: a pilot running across the beam slips out of it within about 70 (JUGGERNAUT) to 140 (GALE)
   * units, a boost across it anywhere out to 260-370 units (most of its reach), and its tell swings at most 22 degrees before
   * it fires. At PRISM's own fighting distance (300) nobody outruns it on foot: that is its strength.
   */
  beam: {
    ...BEAM_TELL, start: BEAM_TELL.tell * BEAM_TELL.tellCost + BEAM_TELL.cost,
    turn: fx.deg(1.2), length: fx.fromInt(360), width: fx.fromInt(2), every: 6, dmg: 3, cooldown: 12,
  },
  /**
   * LANCE (a tap): locks the aim and tells along it for `tell` ticks (shield down, beam silenced, PRISM braced: no driving, no
   * boost, so the line stays put), then fires one instant rail that deals `dmg` to the first thing in its way. Paid and cooling
   * down from the tap.
   */
  lance: { tell: 42, cost: 160, cooldown: 210, length: fx.fromInt(900), width: fx.lit(2.5), dmg: 26 },
} as const;

if (PRISM.beam.tell < MIN_BEAM_TELL_TICKS || PRISM.lance.tell < MIN_HITSCAN_TELL_TICKS) throw new RangeError('PRISM tells too briefly for a beam or an instant shot');
if (PRISM.beam.cooldown >= ENERGY_REGEN_DELAY) throw new RangeError('PRISM beam: its cool-down must stay under the energy refill delay, like every refire');

/** The four prisms orbit the core like TEMPEST's bits (orbit radius 36, design scale). */
const PRISM_ORBIT = fx.lit(25.46);
const prism = (name: string, sx: number, sy: number) =>
  pod({ name, x: sx * PRISM_ORBIT, y: sy * PRISM_ORBIT, rad: fx.fromInt(7), hp: 50, roles: Role.Salvo | Role.Ultima, muzzle: fx.fromInt(8), turn: fx.deg(3), orbit: true });

export const HELIOS = defineForm({
  name: 'HELIOS',
  frame: Frame.Prism,
  speed: fx.lit(1.1),
  accel: fx.lit(0.05),
  bodyTurn: fx.deg(1.4),
  orbitTurn: fx.deg(1.2),
  coreR: core(fx.fromInt(9)),
  pickupR: big(fx.fromInt(32)),
  parts: [
    armor('crown', fx.fromInt(18), 0, fx.fromInt(12), 100),
    armor('ringL', 0, fx.fromInt(26), fx.fromInt(13), 80),
    armor('ringR', 0, fx.fromInt(-26), fx.fromInt(13), 80),
    armor('keel', fx.fromInt(-22), 0, fx.fromInt(13), 90),
    // The slowest mount of any colossus: a pilot running across the SOLAR CANNON's 900-unit sweep can outrun it at close and
    // middle range, and a boost across it slips out almost anywhere it reaches (at 1 degree a tick it tracked everything past
    // 170 units, for 70 ticks).
    pod({ name: 'focus', x: fx.fromInt(36), y: 0, rad: fx.fromInt(9), hp: 90, roles: Role.Siege, muzzle: fx.fromInt(20), turn: fx.deg(0.6) }),
    prism('prism1', 1, 1),
    prism('prism2', -1, 1),
    prism('prism3', -1, -1),
    prism('prism4', 1, -1),
  ],
  // PRISM LANCES
  salvo: { windup: 18, recovery: 26, cost: 650, pattern: Pattern.Beam, duration: 20, length: fx.fromInt(300), width: fx.lit(2.5), every: 5, dmg: 4 },
  // SOLAR CANNON
  siege: { windup: 50, recovery: 60, cost: 5200, recoil: fx.lit(0.6), pattern: Pattern.Beam, duration: 70, length: fx.fromInt(900), width: fx.fromInt(7), every: 4, dmg: 6 },
  // HALO WHEEL. Its spokes never track a target: they turn with the orbit and sweep over whatever they meet, so they pulse often
  // for little: a spoke that visibly crosses a pilot hurts (every crossing within about 290 units lands a pulse), and more the
  // longer it takes to cross (nearer the core); a boost's dodge ticks slip through one.
  ultima: {
    windup: 104, recovery: 140, cost: 32000, duration: 240, cooldown: 700,
    pattern: Pattern.Wheel, length: fx.fromInt(520), width: fx.fromInt(3), every: 2, dmg: 2,
    ringEvery: 60, ringPerPod: 8,
    ringShot: shot({ kind: Proj.Orb, spd: fx.lit(1.5), rad: fx.fromInt(4), dmg: 9, life: 360 }),
  },
});
