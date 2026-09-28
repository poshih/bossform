import { ENEMY_DEFS } from './constants.ts';
import type { World } from './world.ts';

export interface EnemyParams {
  readonly r0?: number;
  readonly r1?: number;
  readonly r2?: number;
  readonly r3?: number;
}

export function spawnEnemy(w: World, type: number, x: number, y: number, params: EnemyParams = {}): number {
  const e = w.allocEnemy();
  if (e < 0) return -1;
  const { m } = w;
  const def = ENEMY_DEFS[type];
  m.eAlive[e] = 1;
  m.eType[e] = type;
  m.eFlags[e] = 0;
  m.ePhase[e] = 0;
  m.eX[e] = m.ePX[e] = x;
  m.eY[e] = m.ePY[e] = y;
  m.eVX[e] = 0;
  m.eVY[e] = 0;
  m.eHp[e] = m.eMaxHp[e] = w.scaleHp(def.hp);
  m.eAge[e] = 0;
  m.eTimer[e] = 0;
  m.eRad[e] = def.rad;
  m.eFlash[e] = 0;
  m.eR0[e] = params.r0 ?? 0;
  m.eR1[e] = params.r1 ?? 0;
  m.eR2[e] = params.r2 ?? 0;
  m.eR3[e] = params.r3 ?? 0;
  return e;
}
