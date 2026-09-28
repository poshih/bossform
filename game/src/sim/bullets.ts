import { fx } from '@metronome/engine';
import { ARENA_HALF_H, ARENA_HALF_W, CULL_MARGIN, MAX_BULLETS } from './constants.ts';
import type { World } from './world.ts';

const LIMIT_X = ARENA_HALF_W + CULL_MARGIN;
const LIMIT_Y = ARENA_HALF_H + CULL_MARGIN;

/** Moves every enemy bullet one tick along its (optionally accelerating / turning) heading. */
export function updateBullets(w: World): void {
  const { m } = w;
  for (let b = 0; b < MAX_BULLETS; b++) {
    if (m.bAlive[b] !== 1) continue;
    m.bAge[b]++;
    if (m.bTurn[b] !== 0) m.bAng[b] = (m.bAng[b] + m.bTurn[b]) & fx.ANGLE_MASK;
    const acc = m.bAcc[b];
    if (acc !== 0) {
      const cap = m.bMaxSpd[b];
      let spd = m.bSpd[b] + acc;
      if (cap > 0 && ((acc > 0 && spd > cap) || (acc < 0 && spd < cap))) spd = cap;
      m.bSpd[b] = spd < 0 ? 0 : spd;
    }
    m.bVX[b] = fx.mul(fx.cos(m.bAng[b]), m.bSpd[b]);
    m.bVY[b] = fx.mul(fx.sin(m.bAng[b]), m.bSpd[b]);
    m.bX[b] += m.bVX[b];
    m.bY[b] += m.bVY[b];
    if (Math.abs(m.bX[b]) > LIMIT_X || Math.abs(m.bY[b]) > LIMIT_Y) w.freeBullet(b);
  }
}
