import { Button, LONGBOW, W, canUseAlt } from '../sim/index.ts';
import { FIRE_RANGE, inPrimaryReach, leadTicks, mayFire, to, type BotSense, type Point, type RobotTactics } from './tactics.ts';

const RAIL = LONGBOW.rail;
const SNAP = RAIL.tiers[0];
const HALF = RAIL.tiers[1];
const FULL = RAIL.tiers[RAIL.tiers.length - 1];

/** LONGBOW lays a tripmine when a pilot closing in comes this close (the mine arms before they reach it)... */
const MINE_RANGE = 160;
/** ...or when one is this close whatever it does. */
const MINE_POINT_BLANK = 90;
/** A pilot counts as closing in above this speed toward LONGBOW (world units per tick). */
const CLOSING_SPEED = 0.6;
/** Up close it does not wait for a FULL charge: a SNAP shot below this range, a HALF one below the next. */
const SNAP_RANGE = 130;
const HALF_RANGE = 240;
/**
 * A FULL charge is let go once the target has held its course (its velocity changing by less than SETTLE_TOLERANCE world
 * units per tick) for SETTLE_TICKS ticks in a row: then the shared lead is reliable. It is let go after FULL_HOLD_LIMIT ticks
 * at most, settled or not, since holding it keeps the shield down.
 */
const SETTLE_TICKS = 6;
const SETTLE_TOLERANCE = 0.12;
const FULL_HOLD_LIMIT = 45;
/** A charge already paid for is held for a target out to this range (it is let go, or lost, only beyond it). */
const HOLD_RANGE = FIRE_RANGE + 90;
/** It backs straight away from a pilot closer than this, drawing divers over its mines; farther out the shared strafe keeps its range. */
const RETREAT_RANGE = 250;
/** Near the storm's edge the retreat bends inward, fully this close to it, so a diver cannot pin it against the storm. */
const EDGE_MARGIN = 220;
/**
 * It starts no new charge while a hostile shot is due within this many ticks: with fire let go, its shield is back up (after
 * SHIELD_RAISE_TICKS) before the shot lands. A charge already started is never abandoned for it.
 */
const SHIELD_PAUSE_TICKS = 30;
/**
 * Preferred distance: the longest of any robot, held inside FIRE_RANGE with the shared range slack, so a bot that drifts to
 * the far side of its band can still start a charge.
 */
const PREFERRED_RANGE = 390;

/**
 * LONGBOW, the sniper: keeps its distance, charges its rail at a target in reach and lets a FULL shot go once the target holds
 * its course (up close, a SNAP or HALF shot as soon as it has one), and lays tripmines in the path of pilots diving at it.
 */
export function createLongbowTactics(): RobotTactics {
  let lastSeat = -2;
  let lastVx = 0;
  let lastVy = 0;
  let steady = 0;
  let heldFull = 0;
  /** The tier this bot means to fire at the current range. */
  const wanted = (range: number) => (range < SNAP_RANGE ? SNAP : range < HALF_RANGE ? HALF : FULL);
  return {
    range: PREFERRED_RANGE,
    buttons(sense: BotSense): number {
      const { w, seat, target } = sense;
      steady = target.seat === lastSeat && Math.hypot(target.vx - lastVx, target.vy - lastVy) <= SETTLE_TOLERANCE ? steady + 1 : 0;
      lastSeat = target.seat;
      lastVx = target.vx;
      lastVy = target.vy;

      let buttons = 0;
      if (target.ship && canUseAlt(w, seat) && (sense.range < MINE_POINT_BLANK || (sense.range < MINE_RANGE && closing(sense)))) buttons |= Button.Alt;

      const charge = w.m.plCharge[seat];
      heldFull = charge >= FULL.charge ? heldFull + 1 : 0;
      const tier = wanted(sense.range);
      if (charge >= tier.charge) {
        const letGo = tier !== FULL || steady >= SETTLE_TICKS || heldFull >= FULL_HOLD_LIMIT || (sense.exposed && charge >= HALF.charge);
        // Letting go of Fire is what fires the rail.
        if (letGo) return buttons;
      }
      // A new charge waits for the rail to cool (holding fire before it can charge only keeps the shield down) and for the
      // shot about to land to be taken on the shield.
      const start = w.m.plFireCd[seat] <= 1 && inPrimaryReach(sense) && mayFire(sense) && sense.soonest >= SHIELD_PAUSE_TICKS;
      if (charge > 0 ? sense.range < HOLD_RANGE : start) buttons |= Button.Fire;
      return buttons;
    },
    /** Leads the target for the needle it means to fire (the shared lead assumes the FULL needle's speed). */
    aim(sense: BotSense): number {
      const speed = to(wanted(sense.range).shot.spd);
      return leadTicks(sense, sense.range / speed);
    },
    /** A pilot too close: away from it, over the mines just laid, bending inward near the storm. */
    move(sense: BotSense): Point | null {
      const { me, target, range } = sense;
      if (!target.ship || range >= RETREAT_RANGE || range < 1) return null;
      const out = Math.hypot(me.x, me.y);
      const edge = out < 1 ? 0 : Math.min(1, Math.max(0, 1 - (to(sense.w.m.world[W.SafeR]) - out) / EDGE_MARGIN));
      const x = (me.x - target.x) / range - (edge * me.x) / Math.max(out, 1);
      const y = (me.y - target.y) / range - (edge * me.y) / Math.max(out, 1);
      const length = Math.hypot(x, y);
      // Straight at the centre with the diver in between: let the shared strafe circle round instead.
      return length < 0.2 ? null : { x: x / length, y: y / length };
    },
  };
}

/** The target is coming at LONGBOW. */
function closing(sense: BotSense): boolean {
  const { me, target, range } = sense;
  if (range < 1) return true;
  return (target.vx * (me.x - target.x) + target.vy * (me.y - target.y)) / range > CLOSING_SPEED;
}
