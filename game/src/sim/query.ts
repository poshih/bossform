import { fx } from '@metronome/engine';
import { Form, ORB_PICKUP_PAD } from './constants.ts';
import { FRAME_STATS, MUZZLE } from './frames.ts';
import { FORMS } from './forms.ts';
import { span2 } from './geometry.ts';
import type { Vec } from './geometry.ts';
import type { World } from './world.ts';

/** In the match and not destroyed. */
export function isFighting(w: World, seat: number): boolean {
  return w.m.plActive[seat] === 1 && w.m.plAlive[seat] === 1;
}

/**
 * Something may pick this ship as a target (seeking shots, neutral units, artillery; bots play by the same rule): it is
 * fighting and not cloaked. Being cloaked hides a SHADE from targeting only; it can still be hit.
 */
export function targetable(w: World, seat: number): boolean {
  return isFighting(w, seat) && w.m.plCloak[seat] === 0;
}

/** Nearest targetable ship not on `team` (ties go to the lower seat), or -1. */
export function nearestHostile(w: World, x: number, y: number, team: number): number {
  const { m } = w;
  let best = -1;
  let bestD = Infinity;
  for (let seat = 0; seat < w.seats; seat++) {
    if (!targetable(w, seat) || m.plTeam[seat] === team) continue;
    const d = span2(m.plX[seat] - x, m.plY[seat] - y);
    if (d < bestD) {
      bestD = d;
      best = seat;
    }
  }
  return best;
}

/** Nearest targetable ship of any team (ties go to the lower seat), or -1. */
export function nearestShip(w: World, x: number, y: number): number {
  const { m } = w;
  let best = -1;
  let bestD = Infinity;
  for (let seat = 0; seat < w.seats; seat++) {
    if (!targetable(w, seat)) continue;
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

/**
 * Pod `part` of `seat`'s colossus can fire right now: it is live and its weapon is not away (no returning shot of its own is
 * out). An away pod takes part in no attack, as if it had no weapon for the moment; it still has its hit points and soaks hits.
 */
export function podReady(w: World, seat: number, part: number): boolean {
  const at = w.partBase(seat) + part;
  return w.m.ptHp[at] > 0 && w.m.ptAway[at] === 0;
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

/** Where a robot's shots leave its hull: MUZZLE out from its centre along `angle` (its aim, for most weapons). */
export function muzzle(w: World, seat: number, angle: number, out: Vec): void {
  out.x = w.m.plX[seat] + fx.mul(fx.cos(angle), MUZZLE);
  out.y = w.m.plY[seat] + fx.mul(fx.sin(angle), MUZZLE);
}
