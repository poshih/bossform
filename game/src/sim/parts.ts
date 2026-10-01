import { fx } from '@metronome/engine';
import {
  Attack, AttackPhase, BOSS_PART_GAIN_PCT, FLASH_TICKS, Form, GAUGE_PER_DAMAGE_DEALT, HOT_PART_DAMAGE_PCT, MAX_PARTS,
} from './constants.ts';
import { Ev } from './events.ts';
import { earn } from './gauge.ts';
import type { Vec } from './geometry.ts';
import { partCenter } from './query.ts';
import type { World } from './world.ts';

/**
 * Boss-form state that more than the colossus itself touches: clearing a colossus away, and the damage its parts take. Kept
 * apart from the colossus's own update (boss.ts), so what ends or hurts a colossus (damage.ts, combat.ts, beams.ts, blast.ts)
 * does not import it, and boss.ts can fire beams without an import cycle.
 */

/** Resets everything boss-form: parts gone (none away), attacks idle, back to the normal form. */
export function clearBoss(w: World, seat: number): void {
  const { m } = w;
  const base = w.partBase(seat);
  for (let k = 0; k < MAX_PARTS; k++) {
    m.ptHp[base + k] = 0;
    m.ptFlash[base + k] = 0;
    m.ptHeat[base + k] = 0;
    m.ptBeamLen[base + k] = 0;
    m.ptAway[base + k] = 0;
  }
  m.plForm[seat] = Form.Normal;
  m.plTimer[seat] = 0;
  m.plAtk[seat] = Attack.None;
  m.plAtkPhase[seat] = AttackPhase.Idle;
  m.plAtkTimer[seat] = 0;
  m.plAtkSeq[seat] = 0;
}

/**
 * Hurts a live boss-form part. Parts that just fired are hot (+50%); parts are not windowed. Whoever hurt it refuels at
 * BOSS_PART_GAIN_PCT of the normal rate. `attacker` is a seat or NO_SEAT.
 */
export function damagePart(w: World, seat: number, part: number, amount: number, attacker: number): void {
  const { m } = w;
  const at = w.partBase(seat) + part;
  const damage = m.ptHeat[at] > 0 ? fx.mulDiv(amount, HOT_PART_DAMAGE_PCT, 100) : amount;
  const applied = Math.min(damage, m.ptHp[at]);
  m.ptHp[at] -= applied;
  m.ptFlash[at] = FLASH_TICKS;
  if (attacker >= 0) {
    earn(w, attacker, fx.mulDiv(applied * GAUGE_PER_DAMAGE_DEALT, BOSS_PART_GAIN_PCT, 100));
    m.plDealt[attacker] += applied;
  }
  const center: Vec = { x: 0, y: 0 };
  partCenter(w, seat, part, center);
  w.emit(m.ptHp[at] === 0 ? Ev.PartDown : Ev.PartHit, center.x, center.y, seat, part);
}
