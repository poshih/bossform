import { fx } from '@metronome/engine';
import { Form, GAUGE_PER_ABSORB, GAUGE_PER_GRAZE, SHIELD_COST_PER_DAMAGE } from './constants.ts';
import { detonate } from './blast.ts';
import { dodging, knockBack } from './boost.ts';
import { DamageKind, damageShip } from './damage.ts';
import { absorbShot, spendEnergy } from './energy.ts';
import { earn } from './gauge.ts';
import { Ev } from './events.ts';
import { FORMS } from './forms.ts';
import { FRAME_STATS, JUGGERNAUT } from './frames.ts';
import { within } from './geometry.ts';
import type { Vec } from './geometry.ts';
import { damageNeutral, NEUTRAL_DEFS } from './neutrals.ts';
import { damagePart } from './parts.ts';
import { struckNeutral, turnBack } from './projectiles.ts';
import { isFighting, partCenter } from './query.ts';
import { parries, reflect } from './ronin-weapons.ts';
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
 * Projectile `p` struck something and was stopped without going off (a shield smothered it, a bulwark swallowed it): it is
 * used up, unless it is a returning shot, which turns for home instead (`struck`: a seat, or struckNeutral(n)).
 */
function smother(w: World, p: number, def: ShotDef, struck: number): void {
  if ((def.flags & ShotFlag.Return) !== 0) turnBack(w, p, struck);
  else w.freeProjectile(p);
}

/** Projectile `p` struck something and hurt it: it detonates, unless it is a returning shot, which turns for home instead. */
function impact(w: World, p: number, def: ShotDef, struck: number): void {
  if ((def.flags & ShotFlag.Return) !== 0) turnBack(w, p, struck);
  else detonate(w, p);
}

/**
 * Returns true if the projectile was used up (or, a returning shot, turned back). In order: a RONIN's parry arc sends it back;
 * the bulwark wedge; protection (spawn, phase dash) lets everything pass; a boost's dodge ticks let everything pass, a touch
 * of the core included, which only grazes; a raised shield stops and smothers whatever reaches it (the graze radius is its
 * radius); otherwise a touch of the core hurts and a near miss grazes. A shot that stops at the shield or hurts the core
 * knocks the robot back by its `knock`.
 */
function hitRobot(w: World, seat: number, p: number, def: ShotDef): boolean {
  const { m } = w;
  const stats = FRAME_STATS[m.plFrame[seat]];
  const dx = m.pX[p] - m.plX[seat];
  const dy = m.pY[p] - m.plY[seat];
  if (parries(w, seat, dx, dy, def.rad)) {
    reflect(w, seat, p, def);
    return true;
  }
  if (bulwarkCatches(w, seat, dx, dy, def)) {
    earn(w, seat, GAUGE_PER_ABSORB);
    w.emit(Ev.Absorb, m.pX[p], m.pY[p], seat);
    smother(w, p, def, seat);
    return true;
  }
  if (m.plInvuln[seat] > 0 || !within(dx, dy, stats.grazeR + def.rad)) return false;
  if (!dodging(w, seat)) {
    if (m.plShield[seat] === 1) {
      // The shield smothers what it stops: a shell that would burst into shrapnel does not.
      absorbShot(w, seat, def.dmg, m.pOwner[p], m.pX[p], m.pY[p]);
      knockBack(w, seat, m.pAng[p], def.knock);
      smother(w, p, def, seat);
      return true;
    }
    if (within(dx, dy, stats.hurtR + def.rad)) {
      damageShip(w, seat, def.dmg, m.pOwner[p], DamageKind.Bullet);
      knockBack(w, seat, m.pAng[p], def.knock);
      impact(w, p, def, seat);
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
  damagePart(w, seat, part, def.dmg, w.m.pOwner[p]);
  impact(w, p, def, seat);
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
  impact(w, p, def, seat);
  return true;
}

/** A returning shot never strikes what it struck last. */
function hitShips(w: World, p: number, def: ShotDef): boolean {
  const { m } = w;
  const returning = (def.flags & ShotFlag.Return) !== 0;
  for (let seat = 0; seat < w.seats; seat++) {
    if (!isFighting(w, seat) || m.plTeam[seat] === m.pTeam[p] || (returning && m.pLast[p] === seat)) continue;
    const used = m.plForm[seat] === Form.Boss ? hitBoss(w, seat, p, def) : hitRobot(w, seat, p, def);
    if (used) return true;
  }
  return false;
}

function hitNeutrals(w: World, p: number, def: ShotDef): void {
  const { m } = w;
  const returning = (def.flags & ShotFlag.Return) !== 0;
  for (let n = 0; n < w.cap.neutrals; n++) {
    if (m.nAlive[n] !== 1 || (returning && m.pLast[p] === struckNeutral(n))) continue;
    if (!within(m.pX[p] - m.nX[n], m.pY[p] - m.nY[n], NEUTRAL_DEFS[m.nType[n]].rad + def.rad)) continue;
    damageNeutral(w, n, def.dmg, m.pOwner[p]);
    impact(w, p, def, struckNeutral(n));
    return;
  }
}

/**
 * An armed mine is set off by a hostile ship coming within its trigger radius of the ship's body (a colossus's whole reach),
 * cloaked or not, or, if a pilot laid it, by a neutral unit.
 */
function tripped(w: World, p: number, def: ShotDef): boolean {
  const { m } = w;
  for (let seat = 0; seat < w.seats; seat++) {
    if (!isFighting(w, seat) || m.plTeam[seat] === m.pTeam[p]) continue;
    const body = m.plForm[seat] === Form.Boss ? FORMS[m.plFrame[seat]].reach : FRAME_STATS[m.plFrame[seat]].bodyR;
    if (within(m.plX[seat] - m.pX[p], m.plY[seat] - m.pY[p], body + def.trigger)) return true;
  }
  if (m.pOwner[p] < 0) return false;
  for (let n = 0; n < w.cap.neutrals; n++) {
    if (m.nAlive[n] === 1 && within(m.nX[n] - m.pX[p], m.nY[n] - m.pY[p], NEUTRAL_DEFS[m.nType[n]].rad + def.trigger)) return true;
  }
  return false;
}

/**
 * Projectiles against ships (never their own team), boss-form parts and neutral units. Shots from players also hurt
 * neutral units; neutral shots hurt ships only. Inert projectiles touch nothing, but an armed mine is set off by what comes
 * near it. Projectiles born this tick (age 0) wait until next tick.
 */
export function collideProjectiles(w: World): void {
  const { m } = w;
  cacheParts(w);
  for (let p = 0; p < w.cap.projectiles; p++) {
    if (m.pAlive[p] !== 1 || m.pAge[p] === 0) continue;
    const def = SHOT_DEFS[m.pDef[p]];
    if ((def.flags & ShotFlag.Inert) !== 0) {
      if ((def.flags & ShotFlag.Proximity) !== 0 && m.pAge[p] >= def.arm && tripped(w, p, def)) detonate(w, p);
      continue;
    }
    if (hitShips(w, p, def)) continue;
    if (m.pOwner[p] >= 0) hitNeutrals(w, p, def);
  }
}
