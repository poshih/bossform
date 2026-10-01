import { fx } from '@metronome/engine';
import { Button, FRAME_STATS, Frame, MUZZLE, SHADE, canUseAlt } from '../sim/index.ts';
import { mayFire, to, type BotSense, type Point, type RobotTactics } from './tactics.ts';

/** Where SHADE's two stars cross its aim line, from its centre (about 147 units): the pincer's distance, its fighting range. */
const PINCER = to(MUZZLE + SHADE.shuriken.reach);

/**
 * The left star's flight, tick by tick (the right star's is its mirror image): its distance from SHADE's centre, which only
 * grows, and its bearing off the aim, which swings from 23 degrees out to the left, through the aim line at the pincer's
 * distance, to 18 degrees right.
 */
const PATH = ((): { distance: number[]; bearing: number[] } => {
  const stars = SHADE.shuriken;
  const turn = fx.toRadians(stars.right.turn);
  const speed = to(stars.right.spd);
  let x = to(MUZZLE);
  let y = 0;
  let heading = fx.toRadians(stars.angle);
  const distance: number[] = [];
  const bearing: number[] = [];
  for (let tick = 0; tick < stars.left.life; tick++) {
    heading -= turn;
    x += Math.cos(heading) * speed;
    y += Math.sin(heading) * speed;
    distance.push(Math.hypot(x, y));
    bearing.push(Math.atan2(y, x));
  }
  return { distance, bearing };
})();
/**
 * Near the pincer's distance it aims straight at the target: the two stars close on it from either side, bracketing where it
 * may have moved to; farther off it puts one star's curve through the target, the left and the right in turn.
 */
const BRACKET = 22;
/** A star reaches targets between these distances (leaving a little margin at its far end). */
const REACH_NEAR = 30;
const REACH_FAR = PATH.distance[PATH.distance.length - 1] - 8;

/** When (ticks) and at what bearing off the aim the left star is `distance` from SHADE's centre; null out of its reach. */
function starAt(distance: number): { ticks: number; bearing: number } | null {
  if (distance < REACH_NEAR || distance > REACH_FAR) return null;
  let tick = 0;
  while (PATH.distance[tick] < distance) tick++;
  if (tick === 0) return { ticks: 1, bearing: PATH.bearing[0] };
  const share = (distance - PATH.distance[tick - 1]) / (PATH.distance[tick] - PATH.distance[tick - 1]);
  return { ticks: tick + share, bearing: PATH.bearing[tick - 1] + (PATH.bearing[tick] - PATH.bearing[tick - 1]) * share };
}

/**
 * Veiled, it holds its throw (the ambush) until the target is this close to the pincer's distance, where both stars meet it;
 * in the veil's last ticks it takes whatever throw it has rather than let the veil run out.
 */
const AMBUSH_SLACK = 7;
const AMBUSH_LAST_TICKS = 30;
/**
 * It veils itself to close in on a pilot beyond its reach but within this distance, when no hostile shot will reach it for
 * this many ticks: a shot its shield stops gives it away at once.
 */
const VEIL_FAR = 450;
const VEIL_SAFE_TICKS = 24;
/** Down to this share of its health it veils itself to slip away, and runs this far before it turns to fight again. */
const LOW_HP_SHARE = 0.35;
const ESCAPE_RANGE = 330;
/**
 * Veiled, it heads straight for its flank point until this close to it. Seen, it closes on the pincer's distance (harder the
 * farther off it is) and circles the target once there, always at least a little round toward the target's side.
 */
const FLANK_ARRIVED = 36;
/** Straight in front of (or behind) the target both flanks are as near: it keeps circling the way it was going. */
const FLANK_CLEAR = 0.25;
const HOLD_GAIN = 1 / 24;
const CIRCLE_WEIGHT = 0.85;
const MIN_CIRCLE = 0.25;

/**
 * SHADE, the stealth ninja: veils itself to close in, comes at the target's side (square to where it aims, where it is not
 * looking) and opens with the ambush throw from the pincer's distance, where both stars meet the target; then circles at that
 * distance, throwing (off it, it puts one star's curve onto the target); hurt, it veils itself and slips away. It knows only
 * what the shared pilot lets it see (a cloaked pilot only up close: bot.ts).
 */
export function createShadeTactics(): RobotTactics {
  /** Which star the next throw aims onto the target: 1 the left one, -1 the right one. */
  let star = 1;
  /** The way it circles its target: 1 counter-clockwise, -1 clockwise. */
  let circle = 1;
  /** This tick's throw, if the target is in a star's reach: the bearing (radians) to where it will be, and the star's bearing there. */
  let aimed = false;
  let toTarget = 0;
  let offset = 0;
  const low = (sense: BotSense): boolean => sense.w.m.plHp[sense.seat] < FRAME_STATS[Frame.Shade].hp * LOW_HP_SHARE;
  return {
    range: PINCER,
    buttons(sense: BotSense): number {
      const { w, seat, range, target, me } = sense;
      const cloaked = w.m.plCloak[seat] > 0;
      const hurt = low(sense);
      let buttons = 0;
      const approach = target.ship && range > REACH_FAR && range < VEIL_FAR && sense.soonest > VEIL_SAFE_TICKS;
      if (!cloaked && canUseAlt(w, seat) && (hurt || approach)) buttons |= Button.Alt;
      // Where the target will be when a star gets there (led as well as the bot's skill allows), and how far that is.
      aimed = false;
      let flight = starAt(range);
      if (flight === null) return buttons;
      // A boost or a knock does not last: the target is led at no more than its top speed.
      const speed = Math.hypot(target.vx, target.vy);
      const top = target.ship ? to(FRAME_STATS[w.m.plFrame[target.seat]].speed) : speed;
      const lead = (flight.ticks * sense.skill * Math.min(speed, top)) / Math.max(speed, 1e-6);
      const aheadX = target.x + target.vx * lead - me.x;
      const aheadY = target.y + target.vy * lead - me.y;
      const ahead = Math.hypot(aheadX, aheadY);
      flight = starAt(ahead);
      if (flight === null) return buttons;
      aimed = true;
      toTarget = Math.atan2(aheadY, aheadX);
      offset = Math.abs(ahead - PINCER) <= BRACKET ? 0 : flight.bearing;
      // Under the veil it throws once, the ambush, where both stars meet the target, and not at all while it slips away.
      const veil = w.m.plCloak[seat];
      const ready = cloaked ? !hurt && (Math.abs(ahead - PINCER) <= AMBUSH_SLACK || veil <= AMBUSH_LAST_TICKS) : true;
      if (ready && mayFire(sense) && w.m.plFireCd[seat] === 0) {
        buttons |= Button.Fire;
        star = -star;
      }
      return buttons;
    },
    /** At the target, or turned off it by a star's bearing at that distance so that the star's curve runs through it. */
    aim(sense: BotSense): number {
      return aimed ? fx.fromRadians(toTarget - star * offset) : sense.aim;
    },
    move(sense: BotSense): Point | null {
      const { w, seat, me, target, range } = sense;
      if (!target.ship || range < 1) return null;
      const cloaked = w.m.plCloak[seat] > 0;
      const awayX = (me.x - target.x) / range;
      const awayY = (me.y - target.y) / range;
      if (cloaked && low(sense)) return range < ESCAPE_RANGE ? { x: awayX, y: awayY } : null;
      // The flank point: the pincer's distance out on the target's side, square to where it aims, on the side nearer the bot.
      const facing = fx.toRadians(w.m.plAim[target.seat]);
      const sideX = -Math.sin(facing);
      const sideY = Math.cos(facing);
      const across = awayX * sideX + awayY * sideY;
      const side = across >= 0 ? 1 : -1;
      // Round the target toward that point (counter-clockwise when it lies that way round), keeping pace with the target.
      if (Math.abs(across) > FLANK_CLEAR) circle = awayX * sideY - awayY * sideX >= 0 ? side : -side;
      if (cloaked) {
        const dx = target.x + sideX * side * PINCER - me.x;
        const dy = target.y + sideY * side * PINCER - me.y;
        const distance = Math.hypot(dx, dy);
        if (distance > FLANK_ARRIVED) return { x: dx / distance, y: dy / distance };
      }
      const off = range - PINCER;
      const closing = Math.max(-1, Math.min(1, off * HOLD_GAIN));
      const circling = Math.max(MIN_CIRCLE, CIRCLE_WEIGHT * (1 - Math.min(1, Math.abs(off) * HOLD_GAIN)));
      const pace = 1 / to(FRAME_STATS[Frame.Shade].speed);
      return {
        x: -awayX * closing - awayY * circle * circling + target.vx * pace,
        y: -awayY * closing + awayX * circle * circling + target.vy * pace,
      };
    },
  };
}
