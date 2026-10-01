import { fx } from '@metronome/engine';
import { Form } from './constants.ts';
import { Ev } from './events.ts';
import { FRAME_STATS } from './frames.ts';
import { coast, limitSpeed } from './movement.ts';
import { isFighting } from './query.ts';
import type { World } from './world.ts';

/**
 * Boost (design doc §5.1): every robot can burst in the direction its pilot presses (or, pressing nothing, where it aims) at
 * several times its top speed, for a fixed number of ticks, then drops back to its top speed. The first ticks of a boost are
 * a dodge: projectiles pass through the robot (combat.ts). Boss forms never boost.
 */

/**
 * Ready to boost: a robot in play (normal form), not boosting, not in a GALE phase dash, not braced in PRISM's lance tell, and
 * the cooldown has run out.
 */
export function canBoost(w: World, seat: number): boolean {
  const { m } = w;
  return isFighting(w, seat) && m.plForm[seat] === Form.Normal && m.plBoost[seat] === 0 && m.plBoostCd[seat] === 0 && m.plDash[seat] === 0 && m.plLance[seat] === 0;
}

export function startBoost(w: World, seat: number, moveX: number, moveY: number): void {
  const { m } = w;
  const boost = FRAME_STATS[m.plFrame[seat]].boost;
  const heading = moveX !== 0 || moveY !== 0 ? fx.atan2(moveY, moveX) : m.plAim[seat];
  m.plVX[seat] = fx.mul(fx.cos(heading), boost.speed);
  m.plVY[seat] = fx.mul(fx.sin(heading), boost.speed);
  m.plBoost[seat] = boost.ticks;
  m.plBoostCd[seat] = boost.cooldown;
  w.emit(Ev.Boost, m.plX[seat], m.plY[seat], seat, heading, m.plFrame[seat]);
}

/** One tick of a boost: the robot flies straight at boost speed; on the boost's last tick it drops to its top speed. */
export function continueBoost(w: World, seat: number): void {
  const { m } = w;
  coast(w, seat);
  if (--m.plBoost[seat] === 0) limitSpeed(w, seat, FRAME_STATS[m.plFrame[seat]].speed);
}

/** A GALE phase dash takes over from a running boost. */
export function stopBoost(w: World, seat: number): void {
  w.m.plBoost[seat] = 0;
}

/**
 * Ends both bursts of movement, a boost and a GALE phase dash, and leaves the robot at most at its top speed. For when the
 * robot stops moving under its own power: it transforms, it is destroyed, its pilot leaves, or PRISM braces for its lance.
 */
export function stopBursts(w: World, seat: number): void {
  const { m } = w;
  m.plBoost[seat] = 0;
  m.plDash[seat] = 0;
  limitSpeed(w, seat, FRAME_STATS[m.plFrame[seat]].speed);
}

/**
 * A hit's knock (a shot's `knock`): a robot in normal form struck on its core or stopped by its shield is pushed along
 * `heading` by `impulse` (units/tick). The push ends a running boost first (the robot is thrown off its line), so it never
 * flies faster than its boost. Callers never knock a protected or dodging robot: nothing touches it.
 */
export function knockBack(w: World, seat: number, heading: number, impulse: number): void {
  const { m } = w;
  if (impulse === 0 || m.plAlive[seat] === 0 || m.plForm[seat] !== Form.Normal) return;
  if (m.plBoost[seat] > 0) stopBursts(w, seat);
  m.plVX[seat] += fx.mul(fx.cos(heading), impulse);
  m.plVY[seat] += fx.mul(fx.sin(heading), impulse);
}

/**
 * During the first `dodge` ticks of a boost projectiles pass through the robot. Collisions run after movement, so on the
 * boost's first collision pass `plBoost` is already `ticks - 1`.
 */
export function dodging(w: World, seat: number): boolean {
  const { m } = w;
  const boost = FRAME_STATS[m.plFrame[seat]].boost;
  return m.plBoost[seat] > 0 && m.plBoost[seat] >= boost.ticks - boost.dodge;
}
