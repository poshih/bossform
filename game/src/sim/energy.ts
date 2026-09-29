import {
  ENERGY_MAX, ENERGY_REGEN_DELAY, ENERGY_REGEN_PER_TICK, GAUGE_PER_DAMAGE_DEALT, SHIELD_BREAK_TICKS, SHIELD_COST_PER_DAMAGE,
  SHIELD_RAISE_ENERGY, SHIELD_RAISE_TICKS,
} from './constants.ts';
import { Ev } from './events.ts';
import { earn } from './gauge.ts';
import type { World } from './world.ts';

/**
 * Energy (design doc §5.4): one pool per robot that powers both its shield and its weapons. Shots pay for themselves up
 * front, the shield pays for the damage it stops, and the pool refills once nothing has been spent for a moment. So every
 * moment spent attacking is a moment without a shield, paid for from the energy the shield would have used.
 */

/**
 * Once per tick for every living ship, whatever its form (a colossus's pool keeps refilling for when it folds back). The
 * refill resumes ENERGY_REGEN_DELAY ticks after the last spend.
 */
export function regenEnergy(w: World, seat: number): void {
  const { m } = w;
  if (m.plRegenWait[seat] > 0 && --m.plRegenWait[seat] > 0) return;
  m.plEnergy[seat] = Math.min(ENERGY_MAX, m.plEnergy[seat] + ENERGY_REGEN_PER_TICK);
}

/** Pays `cost` if the pool holds it: a weapon fires only if it can pay. */
export function spendEnergy(w: World, seat: number, cost: number): boolean {
  const { m } = w;
  if (m.plEnergy[seat] < cost) return false;
  m.plEnergy[seat] -= cost;
  m.plRegenWait[seat] = ENERGY_REGEN_DELAY;
  return true;
}

/**
 * A robot's shield is up whenever its pilot is not attacking. Attacking (holding a weapon's button; weapons.ts shieldBlocked
 * also counts a raised bulwark) drops it at once; it comes back SHIELD_RAISE_TICKS after the last blocked tick (plShieldWait
 * counts down with the ship's other timers, ships.ts), unless it is broken or the pool holds less than SHIELD_RAISE_ENERGY.
 * Called once per tick in normal form only, after the robot's weapons: a transforming or transformed robot has no shield.
 */
export function updateShield(w: World, seat: number, blocked: boolean): void {
  const { m } = w;
  if (blocked) {
    m.plShield[seat] = 0;
    m.plShieldWait[seat] = SHIELD_RAISE_TICKS;
    return;
  }
  if (m.plShield[seat] === 1 || m.plShieldWait[seat] > 0 || m.plShieldBreak[seat] > 0 || m.plEnergy[seat] < SHIELD_RAISE_ENERGY) return;
  m.plShield[seat] = 1;
  w.emit(Ev.ShieldUp, m.plX[seat], m.plY[seat], seat);
}

/**
 * A hostile projectile reached a raised shield (at the graze radius): the shield stops it and the pool pays
 * SHIELD_COST_PER_DAMAGE per point of its damage. If paying would leave the pool empty, the shield still stops this one,
 * then shatters: the pool is empty and the shield stays down for SHIELD_BREAK_TICKS. The shooter's boss gauge earns as for a
 * hit; the shielded pilot's does not (it earns from damage taken, a comeback, and a shield means none was taken).
 */
export function absorbShot(w: World, seat: number, damage: number, attacker: number, x: number, y: number): void {
  const { m } = w;
  const cost = damage * SHIELD_COST_PER_DAMAGE;
  m.plRegenWait[seat] = ENERGY_REGEN_DELAY;
  if (attacker >= 0) earn(w, attacker, damage * GAUGE_PER_DAMAGE_DEALT);
  if (m.plEnergy[seat] > cost) {
    m.plEnergy[seat] -= cost;
    w.emit(Ev.ShieldHit, x, y, seat, damage, attacker);
    return;
  }
  m.plEnergy[seat] = 0;
  m.plShield[seat] = 0;
  m.plShieldBreak[seat] = SHIELD_BREAK_TICKS;
  w.emit(Ev.ShieldBreak, m.plX[seat], m.plY[seat], seat, damage, attacker);
}

/** The shield is gone for now (destroyed, transforming): it comes back through updateShield like any other time. */
export function dropShield(w: World, seat: number): void {
  w.m.plShield[seat] = 0;
}
