import { fx } from '@metronome/engine';
import {
  BOSS_ABSORB_COST_TICKS, BOSS_ABSORB_SCORE, BOSS_CRUSH_DAMAGE, BOSS_CRUSH_DAMAGE_VS_BOSS, BULLET_RADIUS, CONTACT_DAMAGE, EnemyFlag, Frame, FRAME_STATS,
  GAUGE_PER_GRAZE, JUGGERNAUT, MAX_BULLETS, MAX_ENEMIES, MAX_SHOTS, SCORE_GRAZE,
} from './constants.ts';
import { addGauge, addScore, damageEnemy, damagePlayer } from './combat.ts';
import { Ev } from './events.ts';
import { detonateShot } from './shots.ts';
import type { World } from './world.ts';

const NO_OWNER = -1;
const SHIELD_ABSORB_GAUGE = 2;

export function collideShots(w: World): void {
  const { m } = w;
  for (let s = 0; s < MAX_SHOTS; s++) {
    if (m.sAlive[s] !== 1) continue;
    for (let e = 0; e < MAX_ENEMIES; e++) {
      if (m.eAlive[e] !== 1 || e === m.sLastHit[s] || (m.eFlags[e] & EnemyFlag.Dying) !== 0) continue;
      const reach = m.sRad[s] + m.eRad[e];
      if (fx.len2(m.eX[e] - m.sX[s], m.eY[e] - m.sY[s]) > reach * reach) continue;
      if ((m.eFlags[e] & EnemyFlag.Invulnerable) !== 0) {
        detonateShot(w, s, NO_OWNER);
        break;
      }
      damageEnemy(w, e, m.sDmg[s], m.sOwner[s]);
      if (m.sPierce[s] > 0) {
        m.sPierce[s]--;
        m.sLastHit[s] = e;
        continue;
      }
      detonateShot(w, s, e);
      break;
    }
  }
}

function insideShield(w: World, p: number, dx: number, dy: number, d2: number): boolean {
  const { m } = w;
  if (m.plFrame[p] !== Frame.Juggernaut || m.plBoss[p] > 0 || m.plAltFx[p] <= 0) return false;
  if (d2 > JUGGERNAUT.shieldRadius * JUGGERNAUT.shieldRadius) return false;
  // (dx, dy) points from the bullet to the player; the shield faces along the aim.
  return Math.abs(fx.angleDiff(m.plAim[p], fx.atan2(-dy, -dx))) <= JUGGERNAUT.shieldHalfArc;
}

export function collideBullets(w: World): void {
  const { m } = w;
  for (let b = 0; b < MAX_BULLETS; b++) {
    if (m.bAlive[b] !== 1) continue;
    const br = BULLET_RADIUS[m.bKind[b]];
    for (let p = 0; p < w.seats; p++) {
      if (!w.isPlaying(p)) continue;
      const stats = FRAME_STATS[m.plFrame[p]];
      const dx = m.plX[p] - m.bX[b];
      const dy = m.plY[p] - m.bY[b];
      const d2 = fx.len2(dx, dy);

      if (m.plBoss[p] > 0) {
        const reach = stats.bossBodyR + br;
        if (d2 > reach * reach) continue;
        m.plBoss[p] = Math.max(1, m.plBoss[p] - BOSS_ABSORB_COST_TICKS);
        addScore(w, p, BOSS_ABSORB_SCORE);
        w.emit(Ev.Absorb, m.bX[b], m.bY[b], p);
        w.freeBullet(b);
        break;
      }
      if (insideShield(w, p, dx, dy, d2)) {
        addGauge(w, p, SHIELD_ABSORB_GAUGE);
        addScore(w, p, BOSS_ABSORB_SCORE);
        w.emit(Ev.Absorb, m.bX[b], m.bY[b], p);
        w.freeBullet(b);
        break;
      }
      const hitReach = stats.hurtR + br;
      if (d2 <= hitReach * hitReach) {
        if (damagePlayer(w, p, m.bDmg[b])) {
          w.freeBullet(b);
          break;
        }
        continue;
      }
      const grazeReach = stats.grazeR + br;
      const grazedBit = 1 << p;
      if (d2 <= grazeReach * grazeReach && (m.bFlags[b] & grazedBit) === 0) {
        m.bFlags[b] |= grazedBit;
        m.plGraze[p]++;
        addGauge(w, p, GAUGE_PER_GRAZE);
        addScore(w, p, SCORE_GRAZE);
        w.emit(Ev.Graze, m.bX[b], m.bY[b], p);
      }
    }
  }
}

/** Mech bodies against enemy bodies: contact hurts, unless the player is in boss form and crushes instead. */
export function collideBodies(w: World): void {
  const { m } = w;
  for (let p = 0; p < w.seats; p++) {
    if (!w.isPlaying(p)) continue;
    const stats = FRAME_STATS[m.plFrame[p]];
    const bossForm = m.plBoss[p] > 0;
    const bodyR = bossForm ? stats.bossBodyR : stats.bodyR;
    for (let e = 0; e < MAX_ENEMIES; e++) {
      if (m.eAlive[e] !== 1 || (m.eFlags[e] & EnemyFlag.Dying) !== 0) continue;
      const reach = bodyR + m.eRad[e];
      if (fx.len2(m.eX[e] - m.plX[p], m.eY[e] - m.plY[p]) > reach * reach) continue;
      if (bossForm) damageEnemy(w, e, (m.eFlags[e] & EnemyFlag.Boss) !== 0 ? BOSS_CRUSH_DAMAGE_VS_BOSS : BOSS_CRUSH_DAMAGE, p);
      else damagePlayer(w, p, CONTACT_DAMAGE);
    }
  }
}
