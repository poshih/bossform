import { fx } from '@metronome/engine';
import { MOVE_MAX } from './input.ts';
import { radial, within } from './geometry.ts';
import type { World } from './world.ts';

/**
 * Steers a ship's velocity toward what the stick asks for, changing it by at most `accel` per tick (that limit is
 * the ship's inertia), then moves it. `top` is the speed at full deflection.
 */
export function drive(w: World, seat: number, moveX: number, moveY: number, top: number, accel: number): void {
  const { m } = w;
  let mx = moveX;
  let my = moveY;
  const length2 = mx * mx + my * my;
  if (length2 > MOVE_MAX * MOVE_MAX) {
    const length = fx.isqrt(length2);
    mx = Math.trunc((mx * MOVE_MAX) / length);
    my = Math.trunc((my * MOVE_MAX) / length);
  }
  let dvx = fx.mulDiv(top, mx, MOVE_MAX) - m.plVX[seat];
  let dvy = fx.mulDiv(top, my, MOVE_MAX) - m.plVY[seat];
  const change = fx.hypot(dvx, dvy);
  if (change > accel) {
    dvx = fx.mulDiv(dvx, accel, change);
    dvy = fx.mulDiv(dvy, accel, change);
  }
  m.plVX[seat] += dvx;
  m.plVY[seat] += dvy;
  coast(w, seat);
}

/** Moves a ship by its current velocity without steering it (dashes). */
export function coast(w: World, seat: number): void {
  const { m } = w;
  m.plX[seat] += m.plVX[seat];
  m.plY[seat] += m.plVY[seat];
}

/**
 * The rim is solid: a ship whose edge (`edge` from its centre) would cross it is put back on it, and only
 * the outward part of its velocity is removed, so it slides along the wall.
 */
export function keepInside(w: World, seat: number, edge: number): void {
  const { m } = w;
  const limit = w.arenaR - edge;
  if (within(m.plX[seat], m.plY[seat], limit)) return;
  const distance = radial(m.plX[seat], m.plY[seat]);
  const nx = fx.div(m.plX[seat], distance);
  const ny = fx.div(m.plY[seat], distance);
  m.plX[seat] = fx.mul(nx, limit);
  m.plY[seat] = fx.mul(ny, limit);
  const outward = fx.mul(m.plVX[seat], nx) + fx.mul(m.plVY[seat], ny);
  if (outward > 0) {
    m.plVX[seat] -= fx.mul(outward, nx);
    m.plVY[seat] -= fx.mul(outward, ny);
  }
}
