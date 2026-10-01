import { fx } from '@metronome/engine';
import { DamageKind, damageShip } from './damage.ts';
import { dodging, knockBack } from './boost.ts';
import { Form } from './constants.ts';
import { absorbShot } from './energy.ts';
import { Ev } from './events.ts';
import { FORMS } from './forms.ts';
import { FRAME_STATS } from './frames.ts';
import { within } from './geometry.ts';
import type { Vec } from './geometry.ts';
import { damageNeutral, NEUTRAL_DEFS } from './neutrals.ts';
import { damagePart } from './parts.ts';
import { hasHome, ring, shooterOf } from './projectiles.ts';
import type { Shooter } from './projectiles.ts';
import { isFighting, partCenter } from './query.ts';
import { SHOT_DEFS, ShotFlag } from './shots.ts';
import type { ShotDef } from './shots.ts';
import type { World } from './world.ts';

/**
 * How projectiles end: a shot that hits something, runs out of life, lands (a lobbed shell) or is set off (a mine) detonates:
 * it bursts into shrapnel if it has a burst, blasts the area around it if it has a blast, then goes away.
 */

/**
 * A blast of `def` at (x, y): every hostile fighting robot whose core it reaches takes `blastDmg` through the damage window (a
 * raised shield stops it instead; protection and a boost's dodge let it pass; a `knock` pushes the robot away from the
 * centre), every live boss-form part it reaches takes it (hot parts more), and so do neutral units, if a pilot's shot blasts.
 */
function blast(w: World, who: Shooter, def: ShotDef, x: number, y: number): void {
  const { m } = w;
  const at: Vec = { x: 0, y: 0 };
  for (let seat = 0; seat < w.seats; seat++) {
    if (!isFighting(w, seat) || m.plTeam[seat] === who.team || m.plInvuln[seat] > 0) continue;
    const dx = m.plX[seat] - x;
    const dy = m.plY[seat] - y;
    if (m.plForm[seat] === Form.Boss) {
      const form = FORMS[m.plFrame[seat]];
      if (!within(dx, dy, form.reach + def.blastR)) continue;
      const base = w.partBase(seat);
      form.parts.forEach((part, k) => {
        if (m.ptHp[base + k] <= 0) return;
        partCenter(w, seat, k, at);
        if (within(at.x - x, at.y - y, part.rad + def.blastR)) damagePart(w, seat, k, def.blastDmg, who.owner);
      });
      continue;
    }
    if (dodging(w, seat) || !within(dx, dy, FRAME_STATS[m.plFrame[seat]].hurtR + def.blastR)) continue;
    if (m.plShield[seat] === 1) absorbShot(w, seat, def.blastDmg, who.owner, m.plX[seat], m.plY[seat]);
    else damageShip(w, seat, def.blastDmg, who.owner, DamageKind.Bullet);
    knockBack(w, seat, fx.atan2(dy, dx), def.knock);
  }
  if (who.owner >= 0) {
    for (let n = 0; n < w.cap.neutrals; n++) {
      if (m.nAlive[n] === 1 && within(m.nX[n] - x, m.nY[n] - y, NEUTRAL_DEFS[m.nType[n]].rad + def.blastR)) damageNeutral(w, n, def.blastDmg, who.owner);
    }
  }
  w.emit(Ev.Blast, x, y, who.owner, def.id);
}

/** A projectile that hit something, ran out of life, landed or was set off: bursts and blasts if it can, then goes away. */
export function detonate(w: World, p: number): void {
  const { m } = w;
  const def = SHOT_DEFS[m.pDef[p]];
  if (def.burst !== null || def.blastR > 0) {
    const who = shooterOf(w, p);
    if (def.burst !== null) {
      ring(w, who, def.burst.shot, m.pX[p], m.pY[p], def.burst.count, m.pAng[p]);
      w.emit(Ev.Burst, m.pX[p], m.pY[p], def.id, def.burst.count);
    }
    if (def.blastR > 0) blast(w, who, def, m.pX[p], m.pY[p]);
  }
  w.freeProjectile(p);
}

/**
 * The second pass after projectiles move (projectiles.ts updateProjectiles): a projectile detonates at the end of its life, a
 * lobbed shell where it lands (its pFuse), and a returning shot with no home to come back to (projectiles.ts hasHome) expires.
 */
export function expireProjectiles(w: World): void {
  const { m } = w;
  for (let p = 0; p < w.cap.projectiles; p++) {
    if (m.pAlive[p] !== 1) continue;
    const def = SHOT_DEFS[m.pDef[p]];
    const end = (def.flags & ShotFlag.Lob) !== 0 && m.pFuse[p] > 0 ? m.pFuse[p] : def.life;
    const orphan = (def.flags & ShotFlag.Return) !== 0 && !hasHome(w, p);
    if (m.pAge[p] >= end || orphan) detonate(w, p);
  }
}
