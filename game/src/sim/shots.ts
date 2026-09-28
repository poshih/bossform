import { fx } from '@metronome/engine';
import { ARENA_HALF_H, ARENA_HALF_W, CULL_MARGIN, MAX_SHOTS } from './constants.ts';
import { explodeSplash, nearestTarget } from './combat.ts';
import type { World } from './world.ts';

const NO_TARGET = -1;
const NO_HIT = -1;
const LIMIT_X = ARENA_HALF_W + CULL_MARGIN;
const LIMIT_Y = ARENA_HALF_H + CULL_MARGIN;

export interface ShotSpec {
  readonly kind: number;
  readonly x: number;
  readonly y: number;
  readonly ang: number;
  readonly spd: number;
  readonly dmg: number;
  readonly rad: number;
  readonly life: number;
  /** Extra enemies the shot passes through before it is spent. */
  readonly pierce?: number;
  /** Splash radius (0 = none). */
  readonly splash?: number;
  readonly acc?: number;
  readonly maxSpd?: number;
  /** Homing turn rate per tick (0 = flies straight). */
  readonly turn?: number;
}

export function spawnShot(w: World, owner: number, s: ShotSpec): number {
  const i = w.allocShot();
  if (i < 0) return -1;
  const { m } = w;
  const heading = s.ang & fx.ANGLE_MASK;
  m.sAlive[i] = 1;
  m.sKind[i] = s.kind;
  m.sOwner[i] = owner;
  m.sPierce[i] = s.pierce ?? 0;
  m.sX[i] = s.x;
  m.sY[i] = s.y;
  m.sAng[i] = heading;
  m.sSpd[i] = s.spd;
  m.sVX[i] = fx.mul(fx.cos(heading), s.spd);
  m.sVY[i] = fx.mul(fx.sin(heading), s.spd);
  m.sAcc[i] = s.acc ?? 0;
  m.sMaxSpd[i] = s.maxSpd ?? 0;
  m.sTurn[i] = s.turn ?? 0;
  m.sDmg[i] = s.dmg;
  m.sSplash[i] = s.splash ?? 0;
  m.sRad[i] = s.rad;
  m.sAge[i] = 0;
  m.sLife[i] = s.life;
  m.sTarget[i] = NO_TARGET;
  m.sLastHit[i] = NO_HIT;
  return i;
}

/** Ends a shot's flight; splash shells detonate where they are. */
export function detonateShot(w: World, i: number, exclude: number): void {
  const { m } = w;
  if (m.sSplash[i] > 0) explodeSplash(w, m.sX[i], m.sY[i], m.sSplash[i], m.sDmg[i], m.sOwner[i], exclude);
  w.freeShot(i);
}

export function updateShots(w: World): void {
  const { m } = w;
  for (let i = 0; i < MAX_SHOTS; i++) {
    if (m.sAlive[i] !== 1) continue;
    m.sAge[i]++;
    if (m.sTurn[i] > 0) {
      let target = m.sTarget[i];
      if (target < 0 || m.eAlive[target] !== 1) {
        target = nearestTarget(w, m.sX[i], m.sY[i]);
        m.sTarget[i] = target;
      }
      if (target >= 0) m.sAng[i] = fx.turnToward(m.sAng[i], fx.atan2(m.eY[target] - m.sY[i], m.eX[target] - m.sX[i]), m.sTurn[i]);
    }
    if (m.sAcc[i] !== 0) {
      m.sSpd[i] += m.sAcc[i];
      if (m.sMaxSpd[i] > 0 && m.sSpd[i] > m.sMaxSpd[i]) m.sSpd[i] = m.sMaxSpd[i];
    }
    m.sVX[i] = fx.mul(fx.cos(m.sAng[i]), m.sSpd[i]);
    m.sVY[i] = fx.mul(fx.sin(m.sAng[i]), m.sSpd[i]);
    m.sX[i] += m.sVX[i];
    m.sY[i] += m.sVY[i];
    if (--m.sLife[i] <= 0) {
      detonateShot(w, i, NO_HIT);
      continue;
    }
    if (Math.abs(m.sX[i]) > LIMIT_X || Math.abs(m.sY[i]) > LIMIT_Y) w.freeShot(i);
  }
}
