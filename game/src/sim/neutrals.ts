import { fx } from '@metronome/engine';
import { Attack, FLASH_TICKS, GAUGE_PER_DAMAGE_DEALT, NO_SEAT, ORB_VALUE, WARDEN_INTERVAL_TICKS } from './constants.ts';
import { earn } from './energy.ts';
import { Ev } from './events.ts';
import { radial, within } from './geometry.ts';
import { W } from './layout.ts';
import { dropOrbs } from './orbs.ts';
import { fan, launch } from './projectiles.ts';
import type { Shooter } from './projectiles.ts';
import { nearestShip } from './query.ts';
import { Proj, shot } from './shots.ts';
import type { World } from './world.ts';

/**
 * Neutral units: hazards that shoot at everyone and, when destroyed, drop energy orbs. They add pressure and
 * energy to the arena; the fight is still between the players.
 */
export const NeutralType = { Drone: 0, Sentinel: 1, Warden: 2 } as const;
export const NEUTRAL_TYPE_COUNT = 3;

export interface NeutralDef {
  readonly name: string;
  readonly hp: number;
  readonly rad: number;
  readonly speed: number;
  readonly orbs: number;
  readonly orbValue: number;
}

export const NEUTRAL_DEFS: readonly NeutralDef[] = [
  { name: 'DRONE', hp: 20, rad: fx.fromInt(7), speed: fx.lit(1.2), orbs: 2, orbValue: ORB_VALUE },
  { name: 'SENTINEL', hp: 70, rad: fx.fromInt(11), speed: fx.lit(0.6), orbs: 5, orbValue: ORB_VALUE },
  { name: 'WARDEN', hp: 900, rad: fx.fromInt(22), speed: fx.lit(0.3), orbs: 24, orbValue: 2 * ORB_VALUE },
];

const DRONE_SHOT = shot({ kind: Proj.Needle, spd: fx.lit(1.9), rad: fx.lit(2.6), dmg: 6, life: 260 });
const DRONE_STANDOFF = fx.fromInt(220);
const DRONE_FIRE_INTERVAL = 90;
const DRONE_FAN_COUNT = 3;
const DRONE_FAN_SPREAD = fx.deg(24);

const SENTINEL_SHOT = shot({ kind: Proj.Orb, spd: fx.lit(1.6), rad: fx.lit(3.4), dmg: 7, life: 320 });
const SENTINEL_FIRE_INTERVAL = 5;
const SENTINEL_ARMS = 3;
const SENTINEL_STEP = fx.deg(8);
const SENTINEL_ARRIVED = fx.fromInt(6);
/** Where sentinels take position, as a percent of the arena radius. */
const SENTINEL_HOLD_PCT = 45;

const WARDEN_RING_SHOT = shot({ kind: Proj.Orb, spd: fx.lit(1.4), rad: fx.lit(4.2), dmg: 9, life: 420 });
const WARDEN_FAN_SHOT = shot({ kind: Proj.Heavy, spd: fx.lit(1.8), rad: fx.lit(6.5), dmg: 14, life: 340 });
const WARDEN_CYCLE = 200;
const WARDEN_RING_COUNT = 24;
/** The Warden's ring leaves a lane open toward the nearest ship. */
const WARDEN_LANE_HALF = fx.deg(24);
const WARDEN_FAN_COUNT = 9;
const WARDEN_FAN_SPREAD = fx.deg(80);

/** Neutrals enter this far in from the rim (percent of the radius). */
const RIM_ENTRY_PCT = 96;

const NEUTRAL_SHOOTER: Shooter = { owner: NO_SEAT, team: NO_SEAT, attack: Attack.None, part: -1 };

function spawnNeutral(w: World, type: number, x: number, y: number, holdX: number, holdY: number): void {
  const n = w.allocNeutral();
  if (n < 0) return;
  const { m } = w;
  m.nAlive[n] = 1;
  m.nType[n] = type;
  m.nX[n] = x;
  m.nY[n] = y;
  m.nVX[n] = 0;
  m.nVY[n] = 0;
  m.nHp[n] = NEUTRAL_DEFS[type].hp;
  m.nAge[n] = 0;
  m.nAng[n] = type === NeutralType.Drone ? w.rng.int(DRONE_FIRE_INTERVAL) : 0;
  m.nTX[n] = holdX;
  m.nTY[n] = holdY;
  m.nFlash[n] = 0;
}

/** A wave enters from random points of the rim: drones, with a sentinel among them every other wave. */
function spawnWave(w: World): void {
  const size = 2 + Math.floor(w.seats / 2);
  const wave = w.m.world[W.WaveCount];
  const entry = fx.mulDiv(w.arenaR, RIM_ENTRY_PCT, 100);
  const hold = fx.mulDiv(w.arenaR, SENTINEL_HOLD_PCT, 100);
  for (let i = 0; i < size; i++) {
    const angle = w.rng.int(fx.ANGLE_FULL);
    const type = wave % 2 === 1 && i % 2 === 1 ? NeutralType.Sentinel : NeutralType.Drone;
    const c = fx.cos(angle);
    const s = fx.sin(angle);
    spawnNeutral(w, type, fx.mul(c, entry), fx.mul(s, entry), fx.mul(c, hold), fx.mul(s, hold));
  }
}

function wardenAlive(w: World): boolean {
  for (let n = 0; n < w.cap.neutrals; n++) if (w.m.nAlive[n] === 1 && w.m.nType[n] === NeutralType.Warden) return true;
  return false;
}

/** Counts down to the next wave and the next Warden (the big, contested energy prize at the arena centre). */
export function updateWaves(w: World, waveInterval: number): void {
  const s = w.m.world;
  if (--s[W.WaveTimer] <= 0) {
    spawnWave(w);
    s[W.WaveCount]++;
    s[W.WaveTimer] = waveInterval;
  }
  if (--s[W.WardenTimer] <= 0) {
    if (!wardenAlive(w)) spawnNeutral(w, NeutralType.Warden, 0, 0, 0, 0);
    s[W.WardenTimer] = WARDEN_INTERVAL_TICKS;
  }
}

export function clearNeutrals(w: World): void {
  for (let n = 0; n < w.cap.neutrals; n++) if (w.m.nAlive[n] === 1) w.freeNeutral(n);
}

/** Hurts a neutral unit; whoever hurt it is paid energy for the damage, and its orbs drop where it dies. */
export function damageNeutral(w: World, n: number, amount: number, attacker: number): void {
  const { m } = w;
  const def = NEUTRAL_DEFS[m.nType[n]];
  const applied = Math.min(amount, m.nHp[n]);
  m.nHp[n] -= applied;
  m.nFlash[n] = FLASH_TICKS;
  if (attacker >= 0) {
    earn(w, attacker, applied * GAUGE_PER_DAMAGE_DEALT);
    m.plDealt[attacker] += applied;
  }
  if (m.nHp[n] > 0) {
    w.emit(Ev.NeutralHit, m.nX[n], m.nY[n], m.nType[n], applied);
    return;
  }
  dropOrbs(w, m.nX[n], m.nY[n], def.orbs, def.orbValue);
  w.emit(Ev.NeutralKilled, m.nX[n], m.nY[n], m.nType[n], attacker);
  w.freeNeutral(n);
}

function setVelocity(w: World, n: number, heading: number, speed: number): void {
  w.m.nVX[n] = fx.mul(fx.cos(heading), speed);
  w.m.nVY[n] = fx.mul(fx.sin(heading), speed);
}

function drone(w: World, n: number): void {
  const { m } = w;
  const def = NEUTRAL_DEFS[NeutralType.Drone];
  const target = nearestShip(w, m.nX[n], m.nY[n]);
  if (target < 0) {
    m.nVX[n] = 0;
    m.nVY[n] = 0;
    return;
  }
  const dx = m.plX[target] - m.nX[n];
  const dy = m.plY[target] - m.nY[n];
  const toTarget = fx.atan2(dy, dx);
  // Close in until at standoff range, then circle the target.
  setVelocity(w, n, radial(dx, dy) > DRONE_STANDOFF ? toTarget : toTarget + fx.ANGLE_QUARTER, def.speed);
  if ((m.nAge[n] + m.nAng[n]) % DRONE_FIRE_INTERVAL === 0) {
    fan(w, NEUTRAL_SHOOTER, DRONE_SHOT, m.nX[n], m.nY[n], toTarget, DRONE_FAN_COUNT, DRONE_FAN_SPREAD);
    w.emit(Ev.NeutralFire, m.nX[n], m.nY[n], NeutralType.Drone, n);
  }
}

function sentinel(w: World, n: number): void {
  const { m } = w;
  const def = NEUTRAL_DEFS[NeutralType.Sentinel];
  const dx = m.nTX[n] - m.nX[n];
  const dy = m.nTY[n] - m.nY[n];
  if (within(dx, dy, SENTINEL_ARRIVED)) {
    m.nVX[n] = 0;
    m.nVY[n] = 0;
  } else {
    setVelocity(w, n, fx.atan2(dy, dx), def.speed);
  }
  if (m.nAge[n] % SENTINEL_FIRE_INTERVAL === 0) {
    for (let arm = 0; arm < SENTINEL_ARMS; arm++) {
      launch(w, NEUTRAL_SHOOTER, SENTINEL_SHOT, m.nX[n], m.nY[n], m.nAng[n] + Math.floor((fx.ANGLE_FULL * arm) / SENTINEL_ARMS));
    }
    m.nAng[n] = (m.nAng[n] + SENTINEL_STEP) & fx.ANGLE_MASK;
    w.emit(Ev.NeutralFire, m.nX[n], m.nY[n], NeutralType.Sentinel, n);
  }
}

function warden(w: World, n: number): void {
  const { m } = w;
  const def = NEUTRAL_DEFS[NeutralType.Warden];
  const target = nearestShip(w, m.nX[n], m.nY[n]);
  if (target < 0) {
    m.nVX[n] = 0;
    m.nVY[n] = 0;
    return;
  }
  const toTarget = fx.atan2(m.plY[target] - m.nY[n], m.plX[target] - m.nX[n]);
  setVelocity(w, n, toTarget, def.speed);
  const phase = m.nAge[n] % WARDEN_CYCLE;
  if (phase === 0) {
    for (let k = 0; k < WARDEN_RING_COUNT; k++) {
      const angle = Math.floor((fx.ANGLE_FULL * k) / WARDEN_RING_COUNT);
      if (Math.abs(fx.angleDiff(toTarget, angle)) > WARDEN_LANE_HALF) launch(w, NEUTRAL_SHOOTER, WARDEN_RING_SHOT, m.nX[n], m.nY[n], angle);
    }
    w.emit(Ev.NeutralFire, m.nX[n], m.nY[n], NeutralType.Warden, n);
  } else if (phase === WARDEN_CYCLE / 2) {
    fan(w, NEUTRAL_SHOOTER, WARDEN_FAN_SHOT, m.nX[n], m.nY[n], toTarget, WARDEN_FAN_COUNT, WARDEN_FAN_SPREAD);
    w.emit(Ev.NeutralFire, m.nX[n], m.nY[n], NeutralType.Warden, n);
  }
}

/** Neutral units stay inside the rim like ships do. */
function keepNeutralInside(w: World, n: number): void {
  const { m } = w;
  const limit = w.arenaR - NEUTRAL_DEFS[m.nType[n]].rad;
  if (within(m.nX[n], m.nY[n], limit)) return;
  const distance = radial(m.nX[n], m.nY[n]);
  m.nX[n] = fx.mul(fx.div(m.nX[n], distance), limit);
  m.nY[n] = fx.mul(fx.div(m.nY[n], distance), limit);
}

export function updateNeutrals(w: World): void {
  const { m } = w;
  for (let n = 0; n < w.cap.neutrals; n++) {
    if (m.nAlive[n] !== 1) continue;
    m.nAge[n]++;
    if (m.nFlash[n] > 0) m.nFlash[n]--;
    switch (m.nType[n]) {
      case NeutralType.Drone:
        drone(w, n);
        break;
      case NeutralType.Sentinel:
        sentinel(w, n);
        break;
      default:
        warden(w, n);
    }
    m.nX[n] += m.nVX[n];
    m.nY[n] += m.nVY[n];
    keepNeutralInside(w, n);
  }
}

