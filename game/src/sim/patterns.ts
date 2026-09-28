import { fx } from '@metronome/engine';
import { BULLET_DAMAGE, MAX_BULLETS } from './constants.ts';
import { W } from './layout.ts';
import type { World } from './world.ts';

export interface BulletOptions {
  /** Speed change per tick along the heading. */
  readonly acc?: number;
  /** Heading change per tick (binary angle units). */
  readonly turn?: number;
  /** Speed clamp reached by acc. */
  readonly maxSpd?: number;
  readonly dmg?: number;
}

/** Spawns one enemy bullet. Speed is scaled by difficulty here so every pattern scales uniformly. */
export function spawnBullet(w: World, x: number, y: number, ang: number, spd: number, kind: number, color: number, opts?: BulletOptions): number {
  const i = w.allocBullet();
  if (i < 0) return -1;
  const { m } = w;
  const speed = w.scaleSpeed(spd);
  const heading = ang & fx.ANGLE_MASK;
  m.bAlive[i] = 1;
  m.bKind[i] = kind;
  m.bColor[i] = color;
  m.bFlags[i] = 0;
  m.bDmg[i] = opts?.dmg ?? BULLET_DAMAGE[kind];
  m.bX[i] = x;
  m.bY[i] = y;
  m.bAng[i] = heading;
  m.bSpd[i] = speed;
  m.bVX[i] = fx.mul(fx.cos(heading), speed);
  m.bVY[i] = fx.mul(fx.sin(heading), speed);
  m.bAcc[i] = opts?.acc ?? 0;
  m.bTurn[i] = opts?.turn ?? 0;
  m.bMaxSpd[i] = opts?.maxSpd !== undefined ? w.scaleSpeed(opts.maxSpd) : 0;
  m.bAge[i] = 0;
  return i;
}

/** `count` bullets spread evenly across `spread` (total angle), centred on `center`. */
export function fan(w: World, x: number, y: number, center: number, count: number, spread: number, spd: number, kind: number, color: number, opts?: BulletOptions): void {
  if (count === 1) {
    spawnBullet(w, x, y, center, spd, kind, color, opts);
    return;
  }
  const start = center - (spread >> 1);
  for (let k = 0; k < count; k++) spawnBullet(w, x, y, start + Math.floor((spread * k) / (count - 1)), spd, kind, color, opts);
}

/** `count` bullets evenly around a full circle, rotated by `offset`. */
export function ring(w: World, x: number, y: number, count: number, offset: number, spd: number, kind: number, color: number, opts?: BulletOptions): void {
  for (let k = 0; k < count; k++) spawnBullet(w, x, y, offset + Math.floor((fx.ANGLE_FULL * k) / count), spd, kind, color, opts);
}

/** A ring with a hole: bullets within `gapHalf` of `gapCenter` are skipped, leaving a lane to slip through. */
export function gapRing(w: World, x: number, y: number, count: number, gapCenter: number, gapHalf: number, spd: number, kind: number, color: number): void {
  for (let k = 0; k < count; k++) {
    const ang = Math.floor((fx.ANGLE_FULL * k) / count);
    if (Math.abs(fx.angleDiff(gapCenter, ang)) > gapHalf) spawnBullet(w, x, y, ang, spd, kind, color);
  }
}

export function aimedFan(w: World, x: number, y: number, count: number, spread: number, spd: number, kind: number, color: number, opts?: BulletOptions): void {
  fan(w, x, y, w.angleToPlayer(x, y), count, spread, spd, kind, color, opts);
}

/** Destroys every enemy bullet without reward (stage transitions). */
export function wipeBullets(w: World): void {
  const { m } = w;
  for (let i = 0; i < m.bAlive.length; i++) if (m.bAlive[i] === 1) w.freeBullet(i);
}

export function bulletCount(w: World): number {
  return MAX_BULLETS - w.m.world[W.BulletFree];
}
