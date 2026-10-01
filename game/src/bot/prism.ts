import { fx } from '@metronome/engine';
import { ALT_ABILITIES, Button, Frame, PRISM, canUseAlt } from '../sim/index.ts';
import { inPrimaryReach, leadTicks, mayFire, type BotSense, type Point, type RobotTactics } from './tactics.ts';

/** PRISM fights from here: well inside its beam's reach, outside most brawlers' reach. */
const PREFERRED_RANGE = 300;
/**
 * A new beam is started only with the energy for this many ticks of fire after its tell (the simulation asks only for the tell
 * and one tick): the tell buys nothing, so a beam started nearly dry would die after its first pulse.
 */
const BEAM_FIRE_TICKS = 30;
/**
 * A beam lagging this far behind the target is let go: it would sweep for longer than it takes to cool down and tell again, and
 * a new beam starts right on the aim.
 */
const REAIM_ANGLE = fx.deg(45);
/** It lances pilots out to this distance (the rail reaches 900 from the muzzle)... */
const LANCE_MAX = 820;
/** ...with this much energy to spare on top of the lance's cost... */
const LANCE_SPARE_ENERGY = 160;
/** ...and no hostile shot due within this many ticks (the lance's tell leaves it without a shield). */
const LANCE_CALM_TICKS = 30;
/** While its lance tells, it stands its ground: moving would drag the locked line off the point it was led to. */
const STAND: Point = { x: 0, y: 0 };

/**
 * PRISM, the beam specialist: holds its beam on targets in reach (starting one only with the energy to make it count, and
 * re-aiming by letting go when it lags far behind), and snipes with the lance, led by its tell, at pilots beyond the beam's
 * reach when it is calm enough to stand still for the tell.
 */
export function createPrismTactics(): RobotTactics {
  let lancing = false;
  return {
    range: PREFERRED_RANGE,
    buttons(sense: BotSense): number {
      const { w, seat, range, target } = sense;
      const m = w.m;
      const inReach = inPrimaryReach(sense);
      const beaming = m.plBeam[seat] > 0;
      lancing = target.ship && !beaming && !inReach && range <= LANCE_MAX && !sense.threatened
        && sense.soonest > LANCE_CALM_TICKS && m.plEnergy[seat] >= ALT_ABILITIES[Frame.Prism].cost + LANCE_SPARE_ENERGY && canUseAlt(w, seat);
      if (lancing) return Button.Alt;
      if (m.plLance[seat] > 0 || !inReach || !mayFire(sense)) return 0;
      if (!beaming) return m.plEnergy[seat] >= PRISM.beam.start + BEAM_FIRE_TICKS * PRISM.beam.cost ? Button.Fire : 0;
      const toTarget = fx.fromRadians(Math.atan2(target.y - sense.me.y, target.x - sense.me.x));
      return Math.abs(fx.angleDiff(m.plBeamAng[seat], toTarget)) > REAIM_ANGLE ? 0 : Button.Fire;
    },
    // The lance locks its direction at the tap and fires when its tell ends: lead the target by the tell. The beam turns toward
    // the aim by itself, so it is aimed straight at the target.
    aim: (sense) => (lancing ? leadTicks(sense, PRISM.lance.tell) : sense.aim),
    move: (sense) => (sense.w.m.plLance[sense.seat] > 0 ? STAND : null),
  };
}
