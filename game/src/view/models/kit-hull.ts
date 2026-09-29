import * as THREE from 'three';
import type { FormDef } from '../../sim/index.ts';
import { toWorld } from '../shared.ts';

/** Points that approximate each part's disc when the hull is fitted around the parts. */
const DISC_SEGMENTS = 24;

type Point = readonly [number, number];

function cross(o: Point, a: Point, b: Point): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

/** Andrew's monotone chain: the convex hull, counter-clockwise, without repeated end point. */
function convexHull(points: readonly Point[]): Point[] {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const build = (input: readonly Point[]): Point[] => {
    const chain: Point[] = [];
    for (const p of input) {
      while (chain.length >= 2 && cross(chain[chain.length - 2], chain[chain.length - 1], p) <= 0) chain.pop();
      chain.push(p);
    }
    chain.pop();
    return chain;
  };
  return [...build(sorted), ...build([...sorted].reverse())];
}

/**
 * The armoured mass under a boss form: the convex hull of the core and every part that rides the body (orbiting parts are
 * not part of the mass), grown by `margin`, extruded `depth` thick and centred on z = 0, in body space (+x is forward).
 * Draw it dim under the parts so they read as panels of ONE machine instead of loose pieces. It is a picture of mass, not a
 * hitbox: only the parts and the core are hit, so it must never look like a shield of its own (dim edges, no glow).
 */
export function bodyHullGeometry(form: FormDef, margin: number, depth: number): THREE.BufferGeometry {
  const discs: Array<{ x: number; y: number; r: number }> = [{ x: 0, y: 0, r: toWorld(form.coreR) }];
  for (const part of form.parts) {
    if (!part.orbit) discs.push({ x: toWorld(part.x), y: toWorld(part.y), r: toWorld(part.rad) });
  }
  const points: Point[] = [];
  for (const disc of discs) {
    for (let i = 0; i < DISC_SEGMENTS; i++) {
      const angle = (i / DISC_SEGMENTS) * Math.PI * 2;
      points.push([disc.x + Math.cos(angle) * (disc.r + margin), disc.y + Math.sin(angle) * (disc.r + margin)]);
    }
  }
  const hull = convexHull(points);
  const shape = new THREE.Shape();
  hull.forEach(([x, y], index) => (index === 0 ? shape.moveTo(x, y) : shape.lineTo(x, y)));
  const geometry = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
  geometry.translate(0, 0, -depth * 0.5);
  return geometry;
}
