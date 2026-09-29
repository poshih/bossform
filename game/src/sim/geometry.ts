import { fx } from '@metronome/engine';
import { RADIAL_SHIFT } from './constants.ts';

export interface Vec {
  x: number;
  y: number;
}

/**
 * Length of an arena-sized vector. fx.hypot only handles vectors up to about 700 units; positions and
 * point-to-point distances in a big arena exceed that, so the components are scaled down first.
 */
export function radial(x: number, y: number): number {
  return fx.hypot(x >> RADIAL_SHIFT, y >> RADIAL_SHIFT) << RADIAL_SHIFT;
}

/**
 * Squared length of an arena-sized vector in shifted units (see radial). The arena radius limit keeps it an exact integer
 * (below 2^53) for any two points in the arena, so arena-scale distances compare and order exactly.
 */
export function span2(x: number, y: number): number {
  return fx.len2(x >> RADIAL_SHIFT, y >> RADIAL_SHIFT);
}

/** |(x, y)| <= r for arena-scale vectors and radii (the rim, the safe zone), compared exactly in shifted units. */
export function inside(x: number, y: number, r: number): boolean {
  return span2(x, y) <= span2(r, 0);
}

/** |(dx, dy)| <= r for small radii (hitboxes, ranges). The cheap axis test comes first, so the squared test only ever sees small numbers. */
export function within(dx: number, dy: number, r: number): boolean {
  if (dx > r || dx < -r || dy > r || dy < -r) return false;
  return fx.len2(dx, dy) <= r * r;
}
