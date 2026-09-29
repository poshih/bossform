import { fx } from '@metronome/engine';
import {
  KILL_ORB_BASE, KILL_ORB_GAUGE_PCT, KILL_ORBS, BOSS_KILL_ORBS, Form, ORB_ACCEL, ORB_DRAG_PCT, ORB_LIFETIME, ORB_MAGNET_DELAY,
  ORB_MAGNET_RADIUS, ORB_MAX_SPEED, ORB_SCATTER_SPEED,
} from './constants.ts';
import { refuel } from './energy.ts';
import { Ev } from './events.ts';
import { within } from './geometry.ts';
import { isFighting, pickupRadius } from './query.ts';
import type { World } from './world.ts';

const SCATTER_MIN_PCT = 40;
const SCATTER_SPREAD_PCT = 61;

/** Scatters `count` orbs worth `value` each around a point. */
export function dropOrbs(w: World, x: number, y: number, count: number, value: number): void {
  const { m } = w;
  for (let k = 0; k < count; k++) {
    const o = w.allocOrb();
    if (o < 0) return;
    const angle = w.rng.int(fx.ANGLE_FULL);
    const speed = fx.mulDiv(ORB_SCATTER_SPEED, SCATTER_MIN_PCT + w.rng.int(SCATTER_SPREAD_PCT), 100);
    m.oAlive[o] = 1;
    m.oX[o] = x;
    m.oY[o] = y;
    m.oVX[o] = fx.mul(fx.cos(angle), speed);
    m.oVY[o] = fx.mul(fx.sin(angle), speed);
    m.oVal[o] = value;
    m.oAge[o] = 0;
  }
}

/** A destroyed ship drops a share of the energy it was carrying; a boss form is worth a bounty on top. */
export function dropKillOrbs(w: World, seat: number, wasBoss: boolean): void {
  const { m } = w;
  const value = KILL_ORB_BASE + fx.mulDiv(m.plGauge[seat], KILL_ORB_GAUGE_PCT, 100);
  const count = KILL_ORBS + (wasBoss ? BOSS_KILL_ORBS : 0);
  dropOrbs(w, m.plX[seat], m.plY[seat], count, Math.floor(value / KILL_ORBS));
}

export function clearOrbs(w: World): void {
  for (let o = 0; o < w.cap.orbs; o++) if (w.m.oAlive[o] === 1) w.freeOrb(o);
}

/** Nearest fighting ship within `radius` of a point, or -1 (ties go to the lower seat). */
function nearestWithin(w: World, x: number, y: number, radius: (seat: number) => number): number {
  const { m } = w;
  let best = -1;
  let bestD = Infinity;
  for (let seat = 0; seat < w.seats; seat++) {
    if (!isFighting(w, seat)) continue;
    const dx = m.plX[seat] - x;
    const dy = m.plY[seat] - y;
    if (!within(dx, dy, radius(seat))) continue;
    const d = fx.len2(dx, dy);
    if (d < bestD) {
      bestD = d;
      best = seat;
    }
  }
  return best;
}

/** Orbs drift, are pulled toward a nearby ship after a short delay, and refuel whoever touches them. */
export function updateOrbs(w: World): void {
  const { m } = w;
  const magnet = (seat: number) => ORB_MAGNET_RADIUS + pickupRadius(w, seat);
  const pickup = (seat: number) => pickupRadius(w, seat);
  for (let o = 0; o < w.cap.orbs; o++) {
    if (m.oAlive[o] !== 1) continue;
    if (++m.oAge[o] > ORB_LIFETIME) {
      w.freeOrb(o);
      continue;
    }
    m.oVX[o] = fx.mulDiv(m.oVX[o], ORB_DRAG_PCT, 100);
    m.oVY[o] = fx.mulDiv(m.oVY[o], ORB_DRAG_PCT, 100);
    if (m.oAge[o] >= ORB_MAGNET_DELAY) {
      const puller = nearestWithin(w, m.oX[o], m.oY[o], magnet);
      if (puller >= 0) {
        const heading = fx.atan2(m.plY[puller] - m.oY[o], m.plX[puller] - m.oX[o]);
        m.oVX[o] += fx.mul(fx.cos(heading), ORB_ACCEL);
        m.oVY[o] += fx.mul(fx.sin(heading), ORB_ACCEL);
        const speed = fx.hypot(m.oVX[o], m.oVY[o]);
        if (speed > ORB_MAX_SPEED) {
          m.oVX[o] = fx.mulDiv(m.oVX[o], ORB_MAX_SPEED, speed);
          m.oVY[o] = fx.mulDiv(m.oVY[o], ORB_MAX_SPEED, speed);
        }
      }
    }
    m.oX[o] += m.oVX[o];
    m.oY[o] += m.oVY[o];
    const taker = nearestWithin(w, m.oX[o], m.oY[o], pickup);
    if (taker >= 0) {
      refuel(w, taker, m.oVal[o]);
      w.emit(Ev.OrbPickup, m.oX[o], m.oY[o], taker, m.plForm[taker] === Form.Boss ? 1 : 0);
      w.freeOrb(o);
    }
  }
}
