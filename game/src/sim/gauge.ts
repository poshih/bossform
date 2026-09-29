import { Form, GAUGE_MAX } from './constants.ts';
import type { World } from './world.ts';

/**
 * The boss gauge: the meter that transforms a robot into its colossus and then burns as the colossus's fuel. Not to be
 * confused with energy (energy.ts), the pool that powers the shield and the weapons.
 */

/** Adds to the boss gauge from any source (orbs, and the like), up to a full gauge. */
export function refuel(w: World, seat: number, amount: number): void {
  const { m } = w;
  m.plGauge[seat] = Math.min(GAUGE_MAX, m.plGauge[seat] + amount);
}

/** Combat income (grazing, dealing and taking damage, shield hits). A boss form burns fuel; it does not earn it by fighting. */
export function earn(w: World, seat: number, amount: number): void {
  if (w.m.plForm[seat] !== Form.Boss) refuel(w, seat, amount);
}
