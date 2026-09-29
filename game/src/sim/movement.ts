import { fx } from '@metronome/engine';
import { MOVE_MAX } from './input.ts';
import { inside, radial } from './geometry.ts';
import type { Vec } from './geometry.ts';
import type { World } from './world.ts';

/** The velocity the stick asks for: `top` at full deflection, in its direction (a diagonal is no faster). */
function wanted(moveX: number, moveY: number, top: number, out: Vec): void {
  let mx = moveX;
  let my = moveY;
  const length2 = mx * mx + my * my;
  if (length2 > MOVE_MAX * MOVE_MAX) {
    const length = fx.isqrt(length2);
    mx = Math.trunc((mx * MOVE_MAX) / length);
    my = Math.trunc((my * MOVE_MAX) / length);
  }
  out.x = fx.mulDiv(top, mx, MOVE_MAX);
  out.y = fx.mulDiv(top, my, MOVE_MAX);
}

/** Shortens (x, y) to at most `limit` long, keeping its direction. */
function capped(x: number, y: number, limit: number, out: Vec): void {
  const length = fx.hypot(x, y);
  out.x = length > limit ? fx.mulDiv(x, limit, length) : x;
  out.y = length > limit ? fx.mulDiv(y, limit, length) : y;
}

/**
 * Heavy steering (boss forms, the transformation, braking under a root): the velocity changes by at most `accel` per tick
 * in any direction (that limit is the machine's inertia), then the ship moves. `top` is the speed at full deflection.
 */
export function drive(w: World, seat: number, moveX: number, moveY: number, top: number, accel: number): void {
  const { m } = w;
  const target: Vec = { x: 0, y: 0 };
  wanted(moveX, moveY, top, target);
  const change: Vec = { x: 0, y: 0 };
  capped(target.x - m.plVX[seat], target.y - m.plVY[seat], accel, change);
  m.plVX[seat] += change.x;
  m.plVY[seat] += change.y;
  coast(w, seat);
}

/**
 * Robot steering: responsive but not weightless. Slowing down along the current heading (stopping, reversing) may change the
 * velocity by up to `brake` per tick; speeding up and turning by up to `accel`. The ship never gets faster than it was or
 * than `top`, whichever is more, so a turn cannot add speed.
 */
export function driveRobot(w: World, seat: number, moveX: number, moveY: number, top: number, accel: number, brake: number): void {
  const { m } = w;
  const vx = m.plVX[seat];
  const vy = m.plVY[seat];
  const target: Vec = { x: 0, y: 0 };
  wanted(moveX, moveY, top, target);
  const dvx = target.x - vx;
  const dvy = target.y - vy;
  const speed = fx.hypot(vx, vy);
  const change: Vec = { x: 0, y: 0 };
  const ux = speed > 0 ? fx.div(vx, speed) : 0;
  const uy = speed > 0 ? fx.div(vy, speed) : 0;
  const along = fx.mul(dvx, ux) + fx.mul(dvy, uy);
  if (along < 0) {
    const braking = Math.max(along, -brake);
    const side: Vec = { x: 0, y: 0 };
    capped(dvx - fx.mul(along, ux), dvy - fx.mul(along, uy), accel, side);
    change.x = fx.mul(braking, ux) + side.x;
    change.y = fx.mul(braking, uy) + side.y;
  } else {
    capped(dvx, dvy, accel, change);
  }
  const next: Vec = { x: 0, y: 0 };
  capped(vx + change.x, vy + change.y, Math.max(top, speed), next);
  m.plVX[seat] = next.x;
  m.plVY[seat] = next.y;
  coast(w, seat);
}

/** Moves a ship by its current velocity without steering it (dashes). */
export function coast(w: World, seat: number): void {
  const { m } = w;
  m.plX[seat] += m.plVX[seat];
  m.plY[seat] += m.plVY[seat];
}

/** Slows a ship to at most `top` without turning it (the end of a boost). */
export function limitSpeed(w: World, seat: number, top: number): void {
  const { m } = w;
  const next: Vec = { x: 0, y: 0 };
  capped(m.plVX[seat], m.plVY[seat], top, next);
  m.plVX[seat] = next.x;
  m.plVY[seat] = next.y;
}

/**
 * The rim is solid: a ship whose edge (`edge` from its centre) would cross it is put back on it, and only
 * the outward part of its velocity is removed, so it slides along the wall.
 */
export function keepInside(w: World, seat: number, edge: number): void {
  const { m } = w;
  const limit = w.arenaR - edge;
  if (inside(m.plX[seat], m.plY[seat], limit)) return;
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
