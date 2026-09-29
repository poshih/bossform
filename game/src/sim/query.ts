import { fx } from '@metronome/engine';
import { Form, ORB_PICKUP_PAD } from './constants.ts';
import { FRAME_STATS } from './frames.ts';
import { FORMS } from './forms.ts';
import { span2 } from './geometry.ts';
import type { Vec } from './geometry.ts';
import type { World } from './world.ts';

/** In the match and not destroyed. */
export function isFighting(w: World, seat: number): boolean {
  return w.m.plActive[seat] === 1 && w.m.plAlive[seat] === 1;
}

/** Nearest fighting ship not on `team` (ties go to the lower seat), or -1. */
export function nearestHostile(w: World, x: number, y: number, team: number): number {
  const { m } = w;
  let best = -1;
  let bestD = Infinity;
  for (let seat = 0; seat < w.seats; seat++) {
    if (!isFighting(w, seat) || m.plTeam[seat] === team) continue;
    const d = span2(m.plX[seat] - x, m.plY[seat] - y);
    if (d < bestD) {
      bestD = d;
      best = seat;
    }
  }
  return best;
}

/** Nearest fighting ship of any team (ties go to the lower seat), or -1. */
export function nearestShip(w: World, x: number, y: number): number {
  const { m } = w;
  let best = -1;
  let bestD = Infinity;
  for (let seat = 0; seat < w.seats; seat++) {
    if (!isFighting(w, seat)) continue;
    const d = span2(m.plX[seat] - x, m.plY[seat] - y);
    if (d < bestD) {
      bestD = d;
      best = seat;
    }
  }
  return best;
}

/** Radius within which a ship collects energy orbs. */
export function pickupRadius(w: World, seat: number): number {
  const { m } = w;
  return m.plForm[seat] === Form.Boss ? FORMS[m.plFrame[seat]].pickupR : FRAME_STATS[m.plFrame[seat]].bodyR + ORB_PICKUP_PAD;
}

/** Centre of a boss-form part in world space. Orbiting parts turn with the orbit angle, the rest with the body. */
export function partCenter(w: World, seat: number, part: number, out: Vec): void {
  const { m } = w;
  const def = FORMS[m.plFrame[seat]].parts[part];
  const angle = def.orbit ? m.plOrbit[seat] : m.plBody[seat];
  const c = fx.cos(angle);
  const s = fx.sin(angle);
  out.x = m.plX[seat] + fx.mul(def.x, c) - fx.mul(def.y, s);
  out.y = m.plY[seat] + fx.mul(def.x, s) + fx.mul(def.y, c);
}

/** Where a pod's shots appear: out along the pod's own current facing, not along the cursor. */
export function podMuzzle(w: World, seat: number, part: number, out: Vec): void {
  const { m } = w;
  const def = FORMS[m.plFrame[seat]].parts[part];
  partCenter(w, seat, part, out);
  const facing = m.ptAng[w.partBase(seat) + part];
  out.x += fx.mul(fx.cos(facing), def.muzzle);
  out.y += fx.mul(fx.sin(facing), def.muzzle);
}
