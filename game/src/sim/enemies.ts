import { fx } from '@metronome/engine';
import { ARENA_HALF_H, ARENA_HALF_W, BulletColor, BulletKind, CULL_MARGIN, EnemyFlag, EnemyType, MAX_ENEMIES } from './constants.ts';
import { updateBoss } from './bosses.ts';
import { aimedFan, ring, spawnBullet } from './patterns.ts';
import type { World } from './world.ts';

const OFFSCREEN_X = ARENA_HALF_W + CULL_MARGIN;
const OFFSCREEN_Y = ARENA_HALF_H + CULL_MARGIN;

/** Behaviour states shared by the hovering enemy types (stored in register r3). */
const State = { Enter: 0, Active: 1, Leave: 2 } as const;
const LancerState = { Enter: 0, Telegraph: 1, Dash: 2, Leave: 3 } as const;

/** Ordinary (non-boss) enemies currently on the field; stage scripts wait on this. */
export function aliveEnemyCount(w: World): number {
  const { m } = w;
  let n = 0;
  for (let e = 0; e < MAX_ENEMIES; e++) if (m.eAlive[e] === 1 && (m.eFlags[e] & EnemyFlag.Boss) === 0) n++;
  return n;
}

export function updateEnemies(w: World): void {
  const { m } = w;
  for (let e = 0; e < MAX_ENEMIES; e++) {
    if (m.eAlive[e] !== 1) continue;
    m.ePX[e] = m.eX[e];
    m.ePY[e] = m.eY[e];
    m.eAge[e]++;
    if (m.eFlash[e] > 0) m.eFlash[e]--;
    switch (m.eType[e]) {
      case EnemyType.Drone: drone(w, e); break;
      case EnemyType.Gunner: gunner(w, e); break;
      case EnemyType.Lancer: lancer(w, e); break;
      case EnemyType.Spinner: spinner(w, e); break;
      case EnemyType.Bomber: bomber(w, e); break;
      default: updateBoss(w, e); break;
    }
  }
}

function offscreen(w: World, e: number): boolean {
  const { m } = w;
  return Math.abs(m.eX[e]) > OFFSCREEN_X || Math.abs(m.eY[e]) > OFFSCREEN_Y;
}

function drone(w: World, e: number): void {
  const { m } = w;
  const age = m.eAge[e];
  m.eY[e] -= m.eR3[e];
  m.eX[e] = m.eR0[e] + fx.mul(fx.sin(m.eR2[e] + age * fx.deg(3)), m.eR1[e]);
  if (age >= 24 && (age - 24) % w.scaleInterval(84) === 0) {
    spawnBullet(w, m.eX[e], m.eY[e], w.angleToPlayer(m.eX[e], m.eY[e]), fx.lit(1.9), BulletKind.OrbMid, BulletColor.Magenta);
  }
  if (m.eY[e] < -OFFSCREEN_Y) w.freeEnemy(e);
}

function leave(w: World, e: number, speed: number): void {
  const { m } = w;
  m.eY[e] += speed;
  if (offscreen(w, e)) w.freeEnemy(e);
}

function gunner(w: World, e: number): void {
  const { m } = w;
  switch (m.eR3[e]) {
    case State.Enter:
      m.eY[e] -= fx.lit(1.5);
      if (m.eY[e] <= m.eR0[e]) {
        m.eR3[e] = State.Active;
        m.eTimer[e] = 0;
      }
      break;
    case State.Active: {
      const p = w.nearestPlayer(m.eX[e], m.eY[e]);
      if (p >= 0) m.eX[e] += fx.clamp(Math.floor((m.plX[p] - m.eX[e]) / 30), -fx.lit(0.9), fx.lit(0.9));
      m.eTimer[e]++;
      if (m.eTimer[e] % w.scaleInterval(88) === 40) aimedFan(w, m.eX[e], m.eY[e], 3, fx.deg(26), fx.lit(2.1), BulletKind.OrbMid, BulletColor.Cyan);
      if (m.eAge[e] > 820) m.eR3[e] = State.Leave;
      break;
    }
    default:
      leave(w, e, fx.lit(1.8));
  }
}

function lancer(w: World, e: number): void {
  const { m } = w;
  switch (m.eR3[e]) {
    case LancerState.Enter:
      m.eY[e] -= fx.lit(2.2);
      if (m.eY[e] <= m.eR0[e]) {
        m.eR3[e] = LancerState.Telegraph;
        m.eTimer[e] = 0;
      }
      break;
    case LancerState.Telegraph:
      m.eFlags[e] |= EnemyFlag.Telegraph;
      m.eY[e] += fx.lit(0.25);
      if (++m.eTimer[e] >= w.scaleInterval(38)) {
        m.eR1[e] = w.angleToPlayer(m.eX[e], m.eY[e]);
        m.eFlags[e] &= ~EnemyFlag.Telegraph;
        m.eR3[e] = LancerState.Dash;
        m.eTimer[e] = 0;
        ring(w, m.eX[e], m.eY[e], 8, m.eR1[e], fx.lit(1.5), BulletKind.Orb, BulletColor.Red);
      }
      break;
    default:
      m.eX[e] += fx.mul(fx.cos(m.eR1[e]), fx.lit(4.6));
      m.eY[e] += fx.mul(fx.sin(m.eR1[e]), fx.lit(4.6));
      if (offscreen(w, e)) w.freeEnemy(e);
  }
}

function spinner(w: World, e: number): void {
  const { m } = w;
  switch (m.eR3[e]) {
    case State.Enter:
      m.eY[e] -= fx.lit(1.4);
      if (m.eY[e] <= m.eR0[e]) {
        m.eR3[e] = State.Active;
        m.eTimer[e] = 0;
        m.eR2[e] = m.eX[e];
      }
      break;
    case State.Active:
      m.eX[e] = m.eR2[e] + fx.mul(fx.sin(m.eAge[e] * fx.deg(1.5)), fx.fromInt(28));
      if (++m.eTimer[e] % w.scaleInterval(5) === 0) {
        for (let arm = 0; arm < 3; arm++) {
          spawnBullet(w, m.eX[e], m.eY[e], m.eR1[e] + Math.floor((fx.ANGLE_FULL * arm) / 3), fx.lit(1.7), BulletKind.Orb, BulletColor.Amber);
        }
        m.eR1[e] = (m.eR1[e] + fx.deg(7)) & fx.ANGLE_MASK;
      }
      if (m.eAge[e] > 560) m.eR3[e] = State.Leave;
      break;
    default:
      leave(w, e, fx.lit(1.6));
  }
}

function bomber(w: World, e: number): void {
  const { m } = w;
  switch (m.eR3[e]) {
    case State.Enter:
      m.eY[e] -= fx.lit(0.7);
      if (m.eY[e] <= m.eR0[e]) {
        m.eR3[e] = State.Active;
        m.eTimer[e] = 0;
        m.eR2[e] = m.eX[e];
      }
      break;
    case State.Active: {
      m.eX[e] = m.eR2[e] + fx.mul(fx.sin(m.eAge[e] * fx.deg(0.9)), fx.fromInt(24));
      const interval = w.scaleInterval(150);
      const t = ++m.eTimer[e] % interval;
      if (t === 30) ring(w, m.eX[e], m.eY[e], 14, m.eAge[e] * fx.deg(2), fx.lit(1.25), BulletKind.OrbMid, BulletColor.Violet);
      if (t === 90) {
        const aim = w.angleToPlayer(m.eX[e], m.eY[e]);
        spawnBullet(w, m.eX[e], m.eY[e], aim, fx.lit(1.7), BulletKind.Shell, BulletColor.Red);
        aimedFan(w, m.eX[e], m.eY[e], 4, fx.deg(36), fx.lit(2), BulletKind.Orb, BulletColor.Magenta);
      }
      if (m.eAge[e] > 1100) m.eR3[e] = State.Leave;
      break;
    }
    default:
      leave(w, e, fx.lit(1));
  }
}
