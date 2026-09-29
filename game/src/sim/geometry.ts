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

/** |(dx, dy)| <= r. The cheap axis test comes first, so the exact squared test only ever sees small numbers. */
export function within(dx: number, dy: number, r: number): boolean {
  if (dx > r || dx < -r || dy > r || dy < -r) return false;
  return fx.len2(dx, dy) <= r * r;
}
