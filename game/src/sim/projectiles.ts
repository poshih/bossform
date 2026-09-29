import { fx } from '@metronome/engine';
import { PROJECTILE_RIM_MARGIN, SEEK_RANGE } from './constants.ts';
import { Ev } from './events.ts';
import { inside, within } from './geometry.ts';
import { W } from './layout.ts';
import { nearestHostile } from './query.ts';
import { SHOT_DEFS, ShotFlag } from './shots.ts';
import type { ShotDef } from './shots.ts';
import type { World } from './world.ts';

/** Who fired: recorded on every projectile so hits, kills and the boss-attack rules can be attributed. */
export interface Shooter {
  /** Seat, or NO_SEAT for neutral units. */
  readonly owner: number;
  readonly team: number;
  readonly attack: number;
  /** Boss-form part index, or -1. */
  readonly part: number;
}

/** Creates one projectile. The speed rule was enforced when the ShotDef was authored (see shots.ts). */
export function launch(w: World, who: Shooter, def: ShotDef, x: number, y: number, angle: number): number {
  const i = w.allocProjectile();
  if (i < 0) {
    w.m.world[W.Dropped]++;
    return -1;
  }
  const { m } = w;
  m.pAlive[i] = 1;
  m.pDef[i] = def.id;
  m.pOwner[i] = who.owner;
  m.pTeam[i] = who.team;
  m.pAttack[i] = who.attack;
  m.pPart[i] = who.part + 1;
  m.pX[i] = x;
  m.pY[i] = y;
  m.pAng[i] = angle & fx.ANGLE_MASK;
  m.pSpd[i] = def.spd;
  m.pAge[i] = 0;
  m.pGraze[i] = -1;
  return i;
}

/** `count` shots spread evenly across `spread` (total angle), centred on `center`. */
export function fan(w: World, who: Shooter, def: ShotDef, x: number, y: number, center: number, count: number, spread: number): void {
  if (count === 1) {
    launch(w, who, def, x, y, center);
    return;
  }
  const start = center - (spread >> 1);
  for (let k = 0; k < count; k++) launch(w, who, def, x, y, start + Math.floor((spread * k) / (count - 1)));
}

/** `count` shots evenly around a full circle, rotated by `offset`. */
export function ring(w: World, who: Shooter, def: ShotDef, x: number, y: number, count: number, offset: number): void {
  for (let k = 0; k < count; k++) launch(w, who, def, x, y, offset + Math.floor((fx.ANGLE_FULL * k) / count));
}

/** A projectile that hit something or ran out of life: bursts if it can, then goes away. */
export function detonate(w: World, p: number): void {
  const { m } = w;
  const def = SHOT_DEFS[m.pDef[p]];
  if (def.burst !== null) {
    const who: Shooter = { owner: m.pOwner[p], team: m.pTeam[p], attack: m.pAttack[p], part: m.pPart[p] - 1 };
    ring(w, who, def.burst.shot, m.pX[p], m.pY[p], def.burst.count, m.pAng[p]);
    w.emit(Ev.Burst, m.pX[p], m.pY[p], def.id, def.burst.count);
  }
  w.freeProjectile(p);
}

function steer(w: World, p: number, def: ShotDef): void {
  const { m } = w;
  const target = nearestHostile(w, m.pX[p], m.pY[p], m.pTeam[p]);
  if (target < 0) return;
  const dx = m.plX[target] - m.pX[p];
  const dy = m.plY[target] - m.pY[p];
  if (within(dx, dy, SEEK_RANGE)) m.pAng[p] = fx.turnToward(m.pAng[p], fx.atan2(dy, dx), def.turn);
}

/**
 * Moves every projectile one tick along its (optionally accelerating / turning / seeking) heading. Expiry is
 * a second pass: shrapnel born from a burst is created at age 0 and neither moves nor collides until next
 * tick, whatever slot it lands in.
 */
export function updateProjectiles(w: World): void {
  const { m } = w;
  const rim = w.arenaR + PROJECTILE_RIM_MARGIN;
  for (let p = 0; p < w.cap.projectiles; p++) {
    if (m.pAlive[p] !== 1) continue;
    const def = SHOT_DEFS[m.pDef[p]];
    m.pAge[p]++;
    if ((def.flags & ShotFlag.Seek) !== 0) steer(w, p, def);
    else if (def.turn !== 0) m.pAng[p] = (m.pAng[p] + def.turn) & fx.ANGLE_MASK;
    if (m.pSpd[p] < def.maxSpd) m.pSpd[p] = Math.min(def.maxSpd, m.pSpd[p] + def.acc);
    m.pX[p] += fx.mul(fx.cos(m.pAng[p]), m.pSpd[p]);
    m.pY[p] += fx.mul(fx.sin(m.pAng[p]), m.pSpd[p]);
    if (!inside(m.pX[p], m.pY[p], rim)) w.freeProjectile(p);
  }
  for (let p = 0; p < w.cap.projectiles; p++) {
    if (m.pAlive[p] === 1 && m.pAge[p] >= SHOT_DEFS[m.pDef[p]].life) detonate(w, p);
  }
}

/** Removes every projectile without effect (round changes). */
export function clearProjectiles(w: World): void {
  for (let p = 0; p < w.cap.projectiles; p++) if (w.m.pAlive[p] === 1) w.freeProjectile(p);
}
