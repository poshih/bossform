import { fx } from '@metronome/engine';
import {
  BOSS_EXTEND_PER_KILL, BOSS_EXTEND_PER_ORB, BOSS_MODE_MAX_TICKS, BOSS_ABSORB_SCORE, BOSS_SCORE_MULT, CHAIN_MAX, CHAIN_WINDOW_TICKS, ENEMY_DEFS, EnemyFlag, GAUGE_MAX,
  HIT_INVULN, MAX_BULLETS, MAX_ENEMIES, MAX_ORBS, ORB_ACCEL, ORB_COLLECT_R, ORB_HOMING_DELAY, ORB_LIFETIME, ORB_MAX_SPEED, ORB_SCORE, ORB_VALUE,
  RESPAWN_TICKS, SPLASH_PCT, Frame,
} from './constants.ts';
import { Ev } from './events.ts';
import { W } from './layout.ts';
import type { World } from './world.ts';

const NO_OWNER = -1;

// ---------------------------------------------------------------------------------------------------
// Player rewards
// ---------------------------------------------------------------------------------------------------

export function addScore(w: World, p: number, points: number): void {
  const { m } = w;
  let pct = 100 + Math.min(m.plChain[p], CHAIN_MAX) * 10;
  if (m.plBoss[p] > 0) pct *= BOSS_SCORE_MULT;
  m.plScore[p] += Math.floor((points * pct) / 100);
}

/** Feeds the boss gauge. Ignored while already transformed (the gauge is then the remaining time). */
export function addGauge(w: World, p: number, amount: number): void {
  const { m } = w;
  if (m.plBoss[p] > 0 || m.plHp[p] <= 0) return;
  const before = m.plGauge[p];
  const after = Math.min(GAUGE_MAX, before + amount);
  m.plGauge[p] = after;
  if (before < GAUGE_MAX && after === GAUGE_MAX) w.emit(Ev.GaugeFull, m.plX[p], m.plY[p], p);
}

export function extendBossMode(w: World, p: number, ticks: number): void {
  const { m } = w;
  if (m.plBoss[p] > 0) m.plBoss[p] = Math.min(BOSS_MODE_MAX_TICKS, m.plBoss[p] + ticks);
}

function registerKill(w: World, p: number): void {
  const { m } = w;
  m.plKills[p]++;
  m.plChain[p]++;
  m.plChainTimer[p] = CHAIN_WINDOW_TICKS;
  extendBossMode(w, p, BOSS_EXTEND_PER_KILL);
}

// ---------------------------------------------------------------------------------------------------
// Enemies
// ---------------------------------------------------------------------------------------------------

/** Nearest enemy that a homing weapon can hurt (alive, not invulnerable, not dying). */
export function nearestTarget(w: World, x: number, y: number): number {
  const { m } = w;
  let best = -1;
  let bestD = Infinity;
  for (let e = 0; e < MAX_ENEMIES; e++) {
    if (m.eAlive[e] !== 1 || (m.eFlags[e] & (EnemyFlag.Invulnerable | EnemyFlag.Dying)) !== 0) continue;
    const d = fx.len2(m.eX[e] - x, m.eY[e] - y);
    if (d < bestD) {
      bestD = d;
      best = e;
    }
  }
  return best;
}

export function damageEnemy(w: World, e: number, dmg: number, owner: number): void {
  const { m } = w;
  const flags = m.eFlags[e];
  if ((flags & (EnemyFlag.Invulnerable | EnemyFlag.Dying)) !== 0) return;
  m.eHp[e] -= dmg;
  m.eFlash[e] = 3;
  const isBoss = (flags & EnemyFlag.Boss) !== 0;
  w.emit(isBoss ? Ev.BossHit : Ev.EnemyHit, m.eX[e], m.eY[e], dmg);
  if (owner !== NO_OWNER) {
    addGauge(w, owner, 1);
    addScore(w, owner, 1);
  }
  if (m.eHp[e] <= 0) killEnemy(w, e, owner);
}

export function killEnemy(w: World, e: number, owner: number): void {
  const { m } = w;
  const def = ENEMY_DEFS[m.eType[e]];
  if ((m.eFlags[e] & EnemyFlag.Boss) !== 0) {
    m.eFlags[e] = EnemyFlag.Boss | EnemyFlag.Invulnerable | EnemyFlag.Dying;
    m.eHp[e] = 0;
    m.eTimer[e] = 0;
    if (owner !== NO_OWNER) addScore(w, owner, def.score);
    convertBulletsToOrbs(w, owner);
    w.emit(Ev.BossDefeated, m.eX[e], m.eY[e], m.eType[e]);
    return;
  }
  w.emit(Ev.EnemyKilled, m.eX[e], m.eY[e], def.explosion);
  if (owner !== NO_OWNER) {
    addScore(w, owner, def.score);
    registerKill(w, owner);
  }
  spawnOrbs(w, m.eX[e], m.eY[e], def.orbs);
  w.freeEnemy(e);
}

/** Area damage. `exclude` is the enemy a shot already hit directly. */
export function explodeSplash(w: World, x: number, y: number, radius: number, dmg: number, owner: number, exclude: number): void {
  const { m } = w;
  w.emit(Ev.ShellBurst, x, y, radius);
  for (let e = 0; e < MAX_ENEMIES; e++) {
    if (e === exclude || m.eAlive[e] !== 1) continue;
    const reach = radius + m.eRad[e];
    if (fx.len2(m.eX[e] - x, m.eY[e] - y) <= reach * reach) damageEnemy(w, e, Math.max(1, Math.floor((dmg * SPLASH_PCT) / 100)), owner);
  }
}

// ---------------------------------------------------------------------------------------------------
// Energy orbs and bullet cancelling
// ---------------------------------------------------------------------------------------------------

export function spawnOrbs(w: World, x: number, y: number, count: number): void {
  const { m, rng } = w;
  for (let k = 0; k < count; k++) {
    const o = w.allocOrb();
    if (o < 0) {
      const p = w.nearestPlayer(x, y);
      if (p >= 0) addGauge(w, p, ORB_VALUE);
      continue;
    }
    const ang = rng.angle();
    const spd = rng.fixedRange(fx.lit(1), fx.lit(2.8));
    m.oAlive[o] = 1;
    m.oX[o] = x;
    m.oY[o] = y;
    m.oVX[o] = fx.mul(fx.cos(ang), spd);
    m.oVY[o] = fx.mul(fx.sin(ang), spd);
    m.oVal[o] = ORB_VALUE;
    m.oAge[o] = 0;
  }
}

const ORB_DRAG = fx.lit(0.93);
const ORB_MAX_SPEED_SQ = ORB_MAX_SPEED * ORB_MAX_SPEED;
const ORB_COLLECT_SQ = ORB_COLLECT_R * ORB_COLLECT_R;

export function updateOrbs(w: World): void {
  const { m } = w;
  for (let o = 0; o < MAX_ORBS; o++) {
    if (m.oAlive[o] !== 1) continue;
    m.oAge[o]++;
    if (m.oAge[o] > ORB_LIFETIME) {
      w.freeOrb(o);
      continue;
    }
    const p = w.nearestPlayer(m.oX[o], m.oY[o]);
    if (p >= 0 && m.oAge[o] > ORB_HOMING_DELAY) {
      const dx = m.plX[p] - m.oX[o];
      const dy = m.plY[p] - m.oY[o];
      if (fx.len2(dx, dy) <= ORB_COLLECT_SQ) {
        collectOrb(w, p, o);
        continue;
      }
      const toward = fx.atan2(dy, dx);
      m.oVX[o] += fx.mul(fx.cos(toward), ORB_ACCEL);
      m.oVY[o] += fx.mul(fx.sin(toward), ORB_ACCEL);
      if (fx.len2(m.oVX[o], m.oVY[o]) > ORB_MAX_SPEED_SQ) {
        m.oVX[o] = fx.mul(m.oVX[o], fx.lit(0.9));
        m.oVY[o] = fx.mul(m.oVY[o], fx.lit(0.9));
      }
    } else {
      m.oVX[o] = fx.mul(m.oVX[o], ORB_DRAG);
      m.oVY[o] = fx.mul(m.oVY[o], ORB_DRAG);
    }
    m.oX[o] += m.oVX[o];
    m.oY[o] += m.oVY[o];
  }
}

function collectOrb(w: World, p: number, o: number): void {
  const { m } = w;
  addGauge(w, p, m.oVal[o]);
  extendBossMode(w, p, BOSS_EXTEND_PER_ORB);
  addScore(w, p, ORB_SCORE);
  w.emit(Ev.OrbPickup, m.oX[o], m.oY[o], p);
  w.freeOrb(o);
}

/** Boss defeat: every enemy bullet is cancelled for points; a share of them turns into energy. */
export function convertBulletsToOrbs(w: World, owner: number): void {
  const { m } = w;
  for (let b = 0; b < MAX_BULLETS; b++) {
    if (m.bAlive[b] !== 1) continue;
    if (owner !== NO_OWNER) addScore(w, owner, BOSS_ABSORB_SCORE);
    if (b % 4 === 0) spawnOrbs(w, m.bX[b], m.bY[b], 1);
    w.freeBullet(b);
  }
  w.emit(Ev.BulletsCleared, 0, 0, 0);
}

/** Cancels enemy bullets in a radius (transformation / revert pulses, respawn mercy). Returns how many. */
export function cancelBulletsInRadius(w: World, cx: number, cy: number, radius: number, owner: number): number {
  const { m } = w;
  const r2 = radius * radius;
  let n = 0;
  for (let b = 0; b < MAX_BULLETS; b++) {
    if (m.bAlive[b] !== 1 || fx.len2(m.bX[b] - cx, m.bY[b] - cy) > r2) continue;
    if (owner !== NO_OWNER) addScore(w, owner, BOSS_ABSORB_SCORE);
    w.freeBullet(b);
    n++;
  }
  if (n > 0) w.emit(Ev.BulletsCleared, cx, cy, radius);
  return n;
}

// ---------------------------------------------------------------------------------------------------
// Players
// ---------------------------------------------------------------------------------------------------

export function isDashing(w: World, p: number): boolean {
  const { m } = w;
  return m.plFrame[p] === Frame.Gale && m.plBoss[p] === 0 && m.plAltFx[p] > 0;
}

export function isInvulnerable(w: World, p: number): boolean {
  const { m } = w;
  return m.plInvuln[p] > 0 || m.plTransform[p] > 0 || isDashing(w, p);
}

/** Applies a hit if the player can be hurt. Returns true when the hit landed. */
export function damagePlayer(w: World, p: number, dmg: number): boolean {
  const { m } = w;
  if (isInvulnerable(w, p) || !w.isPlaying(p)) return false;
  m.plHp[p] -= dmg;
  m.plInvuln[p] = HIT_INVULN;
  m.plFlash[p] = 12;
  m.plChain[p] = 0;
  m.world[W.StageHits]++;
  w.emit(Ev.PlayerHit, m.plX[p], m.plY[p], p);
  if (m.plHp[p] <= 0) killPlayer(w, p);
  return true;
}

function killPlayer(w: World, p: number): void {
  const { m } = w;
  m.plHp[p] = 0;
  m.plLives[p]--;
  m.plBoss[p] = 0;
  m.plTransform[p] = 0;
  m.plAltFx[p] = 0;
  m.plBeam[p] = 0;
  m.plGauge[p] = Math.floor(m.plGauge[p] / 2);
  m.plRespawn[p] = m.plLives[p] > 0 ? RESPAWN_TICKS : 0;
  w.emit(Ev.PlayerDeath, m.plX[p], m.plY[p], p);
}
