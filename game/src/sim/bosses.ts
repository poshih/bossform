import { fx } from '@metronome/engine';
import { BulletColor, BulletKind, EnemyFlag, EnemyType, SPAWN_Y } from './constants.ts';
import { convertBulletsToOrbs } from './combat.ts';
import { Ev } from './events.ts';
import { W } from './layout.ts';
import { aimedFan, gapRing, ring, spawnBullet } from './patterns.ts';
import { spawnEnemy } from './spawn.ts';
import type { World } from './world.ts';

const INTRO_GLIDE_TICKS = 120;
const PHASE_FREEZE_TICKS = 70;
const DEATH_TICKS = 120;
const HOVER_Y = fx.fromInt(118);
const NO_BOSS = -1;

/** Boss phases by remaining health: 0 above 66%, 1 above 33%, 2 below. */
function phaseForHealth(hp: number, maxHp: number): number {
  if (hp * 100 > maxHp * 66) return 0;
  return hp * 100 > maxHp * 33 ? 1 : 2;
}

export function spawnBoss(w: World, type: number): number {
  const e = spawnEnemy(w, type, 0, SPAWN_Y, { r0: 0, r1: HOVER_Y });
  if (e < 0) return NO_BOSS;
  w.m.eFlags[e] = EnemyFlag.Boss | EnemyFlag.Invulnerable;
  w.m.world[W.BossSlot] = e;
  return e;
}

export function updateBoss(w: World, e: number): void {
  const { m } = w;
  if ((m.eFlags[e] & EnemyFlag.Dying) !== 0) {
    dying(w, e);
    return;
  }
  const age = m.eAge[e];
  if (age <= INTRO_GLIDE_TICKS) {
    m.eY[e] = SPAWN_Y + Math.floor(((HOVER_Y - SPAWN_Y) * age) / INTRO_GLIDE_TICKS);
    if (age === INTRO_GLIDE_TICKS) m.eFlags[e] &= ~EnemyFlag.Invulnerable;
    return;
  }
  if (m.eR3[e] > 0) {
    if (--m.eR3[e] === 0) {
      m.eFlags[e] &= ~EnemyFlag.Invulnerable;
      m.eTimer[e] = 0;
    }
    return;
  }
  const phase = phaseForHealth(m.eHp[e], m.eMaxHp[e]);
  if (phase > m.ePhase[e]) {
    m.ePhase[e] = phase;
    m.eR3[e] = PHASE_FREEZE_TICKS;
    m.eFlags[e] |= EnemyFlag.Invulnerable;
    convertBulletsToOrbs(w, -1);
    w.emit(Ev.BossPhase, m.eX[e], m.eY[e], phase);
    return;
  }
  m.eTimer[e]++;
  switch (m.eType[e]) {
    case EnemyType.Bulwark: bulwark(w, e, phase); break;
    case EnemyType.Seraph: seraph(w, e, phase); break;
    default: overlord(w, e, phase); break;
  }
}

function dying(w: World, e: number): void {
  const { m } = w;
  const t = ++m.eTimer[e];
  if (t % 6 === 0) {
    w.emit(Ev.Explosion, m.eX[e] + w.rng.fixedRange(-m.eRad[e], m.eRad[e]), m.eY[e] + w.rng.fixedRange(-m.eRad[e], m.eRad[e]), t > 70 ? 2 : 1);
  }
  m.eY[e] -= fx.lit(0.15);
  if (t >= DEATH_TICKS) {
    w.emit(Ev.Explosion, m.eX[e], m.eY[e], 3);
    m.world[W.BossSlot] = NO_BOSS;
    w.freeEnemy(e);
  }
}

/** Glides toward (tx, ty) with speed capped at maxSpeed; `softness` is how many ticks the approach takes. */
function steer(w: World, e: number, tx: number, ty: number, maxSpeed: number, softness: number): void {
  const { m } = w;
  const vx = fx.clamp(Math.floor((tx - m.eX[e]) / softness), -maxSpeed, maxSpeed);
  const vy = fx.clamp(Math.floor((ty - m.eY[e]) / softness), -maxSpeed, maxSpeed);
  m.eX[e] += vx;
  m.eY[e] += vy;
  m.eVX[e] = vx;
  m.eVY[e] = vy;
}

/** Picks a fresh hover point every `every` ticks. */
function wander(w: World, e: number, every: number, halfWidth: number, yMin: number, yMax: number): void {
  const { m } = w;
  if (m.eTimer[e] % every !== 1) return;
  m.eR0[e] = w.rng.fixedRange(-halfWidth, halfWidth);
  m.eR1[e] = fx.fromInt(yMin) + w.rng.fixedRange(0, fx.fromInt(yMax - yMin));
}

/** `arms` bullets around the boss, rotated a little further every emission. */
function spiral(w: World, e: number, arms: number, step: number, speed: number, kind: number, color: number): void {
  const { m } = w;
  for (let k = 0; k < arms; k++) spawnBullet(w, m.eX[e], m.eY[e], m.eR2[e] + Math.floor((fx.ANGLE_FULL * k) / arms), speed, kind, color);
  m.eR2[e] = (m.eR2[e] + step) & fx.ANGLE_MASK;
}

/** Two curving streams that peel off the boss's wings. */
function helix(w: World, e: number, speed: number, color: number, curve: number): void {
  const { m } = w;
  const wing = fx.fromInt(22);
  const down = fx.deg(-90);
  spawnBullet(w, m.eX[e] - wing, m.eY[e], down + fx.deg(18), speed, BulletKind.Orb, color, { turn: -curve });
  spawnBullet(w, m.eX[e] + wing, m.eY[e], down - fx.deg(18), speed, BulletKind.Orb, color, { turn: curve });
}

const BULWARK_SPEED = [fx.lit(0.9), fx.lit(1.1), fx.lit(1.5)] as const;

function bulwark(w: World, e: number, phase: number): void {
  const { m } = w;
  const t = m.eTimer[e];
  const x = m.eX[e];
  const y = m.eY[e];
  wander(w, e, 210, fx.fromInt(85), 100, 135);
  steer(w, e, m.eR0[e], m.eR1[e], BULWARK_SPEED[phase], 26);
  if (phase === 0) {
    if (t % w.scaleInterval(56) === 20) aimedFan(w, x, y, 5, fx.deg(44), fx.lit(2.1), BulletKind.OrbMid, BulletColor.Amber);
    if (t % w.scaleInterval(160) === 100) ring(w, x, y, 20, t * fx.deg(3), fx.lit(1.1), BulletKind.OrbBig, BulletColor.Red);
  } else if (phase === 1) {
    if (t % w.scaleInterval(46) === 20) aimedFan(w, x, y, 5, fx.deg(50), fx.lit(2.2), BulletKind.OrbMid, BulletColor.Amber);
    if (t % w.scaleInterval(6) === 0) spiral(w, e, 2, fx.deg(9), fx.lit(1.8), BulletKind.Orb, BulletColor.White);
    if (t % w.scaleInterval(130) === 90) ring(w, x, y, 24, t * fx.deg(2), fx.lit(1.2), BulletKind.OrbMid, BulletColor.Violet);
  } else {
    if (t % w.scaleInterval(34) === 10) aimedFan(w, x, y, 7, fx.deg(60), fx.lit(2.6), BulletKind.Needle, BulletColor.Red);
    if (t % w.scaleInterval(5) === 0) spiral(w, e, 3, fx.deg(8), fx.lit(1.9), BulletKind.Orb, BulletColor.White);
    if (t % w.scaleInterval(90) === 60) ring(w, x, y, 28, (t >> 1) * fx.deg(3), fx.lit(1.3), BulletKind.OrbMid, BulletColor.Magenta);
    if (t % w.scaleInterval(70) === 35) spawnBullet(w, x, y, w.angleToPlayer(x, y), fx.lit(1.9), BulletKind.Shell, BulletColor.Red);
  }
}

function seraph(w: World, e: number, phase: number): void {
  const { m } = w;
  const t = m.eTimer[e];
  const x = m.eX[e];
  const y = m.eY[e];
  if (t % 150 === 1) {
    m.eR0[e] = (x > 0 ? -1 : 1) * fx.fromInt(w.rng.range(55, 105));
    m.eR1[e] = fx.fromInt(w.rng.range(108, 132));
  }
  steer(w, e, m.eR0[e], m.eR1[e], fx.lit(2.7), 14);
  if (phase === 0) {
    const cycle = t % 110;
    if (cycle < 24 && cycle % 4 === 0) aimedFan(w, x, y, 3, fx.deg(12), fx.lit(3.2), BulletKind.Needle, BulletColor.Cyan);
    if (cycle === 60) ring(w, x, y, 16, t * fx.deg(4), fx.lit(1.4), BulletKind.OrbMid, BulletColor.White);
  } else if (phase === 1) {
    if (t % w.scaleInterval(5) === 0) helix(w, e, fx.lit(1.8), BulletColor.Cyan, fx.deg(0.9));
    if (t % w.scaleInterval(52) === 30) aimedFan(w, x, y, 3, fx.deg(22), fx.lit(2.2), BulletKind.OrbMid, BulletColor.Magenta);
  } else {
    if (t % w.scaleInterval(64) === 20) gapRing(w, x, y, 32, w.angleToPlayer(x, y), fx.deg(22), fx.lit(1.7), BulletKind.OrbMid, BulletColor.Violet);
    if (t % w.scaleInterval(3) === 0) {
      spawnBullet(w, x + w.rng.fixedRange(-fx.fromInt(36), fx.fromInt(36)), y, fx.deg(-90) + w.rng.range(-fx.deg(28), fx.deg(28)),
        w.rng.fixedRange(fx.lit(2.4), fx.lit(3.4)), BulletKind.Needle, BulletColor.Red);
    }
  }
}

function overlord(w: World, e: number, phase: number): void {
  const { m } = w;
  const t = m.eTimer[e];
  const x = m.eX[e];
  const y = m.eY[e];
  wander(w, e, 170, fx.fromInt(90), 100, 140);
  steer(w, e, m.eR0[e], m.eR1[e], phase === 2 ? fx.lit(2) : fx.lit(1.3), 22);
  if (phase === 0) {
    if (t % w.scaleInterval(6) === 0) spiral(w, e, 2, fx.deg(10), fx.lit(1.9), BulletKind.Orb, BulletColor.Cyan);
    if (t % w.scaleInterval(8) === 0) helix(w, e, fx.lit(1.7), BulletColor.Amber, fx.deg(0.8));
    if (t % w.scaleInterval(60) === 30) aimedFan(w, x, y, 5, fx.deg(40), fx.lit(2.3), BulletKind.OrbMid, BulletColor.Magenta);
  } else if (phase === 1) {
    if (t % w.scaleInterval(5) === 0) spiral(w, e, 4, fx.deg(6), fx.lit(1.9), BulletKind.Orb, BulletColor.White);
    if (t % w.scaleInterval(90) === 40) gapRing(w, x, y, 36, w.angleToPlayer(x, y), fx.deg(20), fx.lit(1.6), BulletKind.OrbMid, BulletColor.Violet);
    if (t % w.scaleInterval(80) === 10) spawnBullet(w, x, y, w.angleToPlayer(x, y), fx.lit(2), BulletKind.Shell, BulletColor.Red);
  } else {
    if (t % w.scaleInterval(4) === 0) spiral(w, e, 4, fx.deg(-7), fx.lit(2.1), BulletKind.Orb, BulletColor.Red);
    if (t % w.scaleInterval(60) === 20) gapRing(w, x, y, 40, w.angleToPlayer(x, y), fx.deg(18), fx.lit(1.8), BulletKind.OrbMid, BulletColor.Magenta);
    if (t % w.scaleInterval(28) === 5) aimedFan(w, x, y, 9, fx.deg(70), fx.lit(2.8), BulletKind.Needle, BulletColor.Cyan);
    if (t % w.scaleInterval(70) === 45) aimedFan(w, x, y, 3, fx.deg(24), fx.lit(2), BulletKind.Shell, BulletColor.Red);
  }
}
