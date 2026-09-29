import { fx } from '@metronome/engine';
import {
  BOSS_PART_GAIN_PCT, FLASH_TICKS, Form, GAUGE_PER_ABSORB, GAUGE_PER_DAMAGE_DEALT, GAUGE_PER_GRAZE, HOT_PART_DAMAGE_PCT, SHIELD_COST_PER_DAMAGE,
} from './constants.ts';
import { dodging } from './boost.ts';
import { DamageKind, damageShip } from './damage.ts';
import { absorbShot, spendEnergy } from './energy.ts';
import { earn } from './gauge.ts';
import { Ev } from './events.ts';
import { FORMS } from './forms.ts';
import { FRAME_STATS, JUGGERNAUT } from './frames.ts';
import { within } from './geometry.ts';
import type { Vec } from './geometry.ts';
import { damageNeutral, NEUTRAL_DEFS } from './neutrals.ts';
import { detonate } from './projectiles.ts';
import { isFighting, partCenter } from './query.ts';
import { SHOT_DEFS, ShotFlag } from './shots.ts';
import type { ShotDef } from './shots.ts';
import type { World } from './world.ts';

/** Fills the boss-part centre cache for this pass (see World.partX). */
function cacheParts(w: World): void {
  const { m } = w;
  const at: Vec = { x: 0, y: 0 };
  for (let seat = 0; seat < w.seats; seat++) {
    if (!isFighting(w, seat) || m.plForm[seat] !== Form.Boss) continue;
    const base = w.partBase(seat);
    FORMS[m.plFrame[seat]].parts.forEach((_, k) => {
      if (m.ptHp[base + k] <= 0) return;
      partCenter(w, seat, k, at);
      w.partX[base + k] = at.x;
      w.partY[base + k] = at.y;
    });
  }
}

/**
 * A bulwark is a wedge in front of the ship: hostile projectiles inside it are swallowed. It runs on energy like the shield it
 * replaces (the same price per point of damage), so it catches only what the pool can pay for.
 */
function bulwarkCatches(w: World, seat: number, dx: number, dy: number, def: ShotDef): boolean {
  const { m } = w;
  const bulwark = JUGGERNAUT.bulwark;
  if (m.plBulwark[seat] === 0 || !within(dx, dy, bulwark.radius + def.rad)) return false;
  if (Math.abs(fx.angleDiff(fx.atan2(dy, dx), m.plAim[seat])) > bulwark.halfArc) return false;
  return spendEnergy(w, seat, def.dmg * SHIELD_COST_PER_DAMAGE);
}

/**
 * Returns true if the projectile was used up. In order: the bulwark wedge; protection (spawn, phase dash) lets everything
 * pass; a boost's dodge ticks let everything pass, a touch of the core included, which only grazes; a raised shield stops
 * and smothers whatever reaches it (the graze radius is its radius); otherwise a touch of the core hurts and a near miss grazes.
 */
function hitRobot(w: World, seat: number, p: number, def: ShotDef): boolean {
  const { m } = w;
  const stats = FRAME_STATS[m.plFrame[seat]];
  const dx = m.pX[p] - m.plX[seat];
  const dy = m.pY[p] - m.plY[seat];
  if (bulwarkCatches(w, seat, dx, dy, def)) {
    earn(w, seat, GAUGE_PER_ABSORB);
    w.emit(Ev.Absorb, m.pX[p], m.pY[p], seat);
    w.freeProjectile(p);
    return true;
  }
  if (m.plInvuln[seat] > 0 || !within(dx, dy, stats.grazeR + def.rad)) return false;
  if (!dodging(w, seat)) {
    if (m.plShield[seat] === 1) {
      // The shield smothers what it stops: a shell that would burst into shrapnel does not.
      absorbShot(w, seat, def.dmg, m.pOwner[p], m.pX[p], m.pY[p]);
      w.freeProjectile(p);
      return true;
    }
    if (within(dx, dy, stats.hurtR + def.rad)) {
      damageShip(w, seat, def.dmg, m.pOwner[p], DamageKind.Bullet);
      detonate(w, p);
      return true;
    }
  }
  if (m.pGraze[p] < 0) {
    m.pGraze[p] = seat;
    m.plGrazes[seat]++;
    earn(w, seat, GAUGE_PER_GRAZE);
    w.emit(Ev.Graze, m.pX[p], m.pY[p], seat);
  }
  return false;
}

function hitPart(w: World, seat: number, part: number, p: number, def: ShotDef): void {
  const { m } = w;
  const at = w.partBase(seat) + part;
  const damage = m.ptHeat[at] > 0 ? fx.mulDiv(def.dmg, HOT_PART_DAMAGE_PCT, 100) : def.dmg;
  const applied = Math.min(damage, m.ptHp[at]);
  m.ptHp[at] -= applied;
  m.ptFlash[at] = FLASH_TICKS;
  const attacker = m.pOwner[p];
  if (attacker >= 0) {
    earn(w, attacker, fx.mulDiv(applied * GAUGE_PER_DAMAGE_DEALT, BOSS_PART_GAIN_PCT, 100));
    m.plDealt[attacker] += applied;
  }
  w.emit(m.ptHp[at] === 0 ? Ev.PartDown : Ev.PartHit, w.partX[at], w.partY[at], seat, part);
  detonate(w, p);
}

/** Parts soak up bullets first; only the core, once nothing live covers the bullet's path, hurts the pilot. */
function hitBoss(w: World, seat: number, p: number, def: ShotDef): boolean {
  const { m } = w;
  if (m.plInvuln[seat] > 0) return false;
  const form = FORMS[m.plFrame[seat]];
  const dx = m.pX[p] - m.plX[seat];
  const dy = m.pY[p] - m.plY[seat];
  if (!within(dx, dy, form.reach + def.rad)) return false;
  const base = w.partBase(seat);
  for (let k = 0; k < form.parts.length; k++) {
    if (m.ptHp[base + k] <= 0) continue;
    if (within(m.pX[p] - w.partX[base + k], m.pY[p] - w.partY[base + k], form.parts[k].rad + def.rad)) {
      hitPart(w, seat, k, p, def);
      return true;
    }
  }
  if (!within(dx, dy, form.coreR + def.rad)) return false;
  damageShip(w, seat, def.dmg, m.pOwner[p], DamageKind.Bullet);
  detonate(w, p);
  return true;
}

function hitShips(w: World, p: number, def: ShotDef): boolean {
  const { m } = w;
  for (let seat = 0; seat < w.seats; seat++) {
    if (!isFighting(w, seat) || m.plTeam[seat] === m.pTeam[p]) continue;
    const used = m.plForm[seat] === Form.Boss ? hitBoss(w, seat, p, def) : hitRobot(w, seat, p, def);
    if (used) return true;
  }
  return false;
}

function hitNeutrals(w: World, p: number, def: ShotDef): void {
  const { m } = w;
  for (let n = 0; n < w.cap.neutrals; n++) {
    if (m.nAlive[n] !== 1) continue;
    if (!within(m.pX[p] - m.nX[n], m.pY[p] - m.nY[n], NEUTRAL_DEFS[m.nType[n]].rad + def.rad)) continue;
    damageNeutral(w, n, def.dmg, m.pOwner[p]);
    detonate(w, p);
    return;
  }
}

/**
 * Projectiles against ships (never their own team), boss-form parts and neutral units. Shots from players also hurt
 * neutral units; neutral shots hurt ships only. Projectiles born this tick (age 0) wait until next tick.
 */
export function collideProjectiles(w: World): void {
  const { m } = w;
  cacheParts(w);
  for (let p = 0; p < w.cap.projectiles; p++) {
    if (m.pAlive[p] !== 1 || m.pAge[p] === 0) continue;
    const def = SHOT_DEFS[m.pDef[p]];
    if ((def.flags & ShotFlag.Inert) !== 0) continue;
    if (hitShips(w, p, def)) continue;
    if (m.pOwner[p] >= 0) hitNeutrals(w, p, def);
  }
}
