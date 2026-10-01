import { Ev } from './events.ts';
import type { World } from './world.ts';

/**
 * Robot kit state that outlives a single tick (layout.ts: LONGBOW's charge, HAILSTORM's spin, RONIN's parry, SHADE's cloak,
 * PRISM's beam and lance), and the ways it ends. Kept apart from the weapons themselves (weapons.ts and <robot>-weapons.ts),
 * so what hurts, transforms or removes a robot can end its kit without importing its weapons.
 */

/** A SHADE's cloak ends (an Ev.Reveal); nothing happens if it was not cloaked. */
export function reveal(w: World, seat: number): void {
  const { m } = w;
  if (m.plCloak[seat] === 0) return;
  m.plCloak[seat] = 0;
  w.emit(Ev.Reveal, m.plX[seat], m.plY[seat], seat);
}

/**
 * The robot stops using its kit (it transforms, is destroyed, leaves, or is put back into play): a charge, a spin, a parry, a
 * beam or a lance in its tell is dropped, and a cloak ends.
 */
export function clearKit(w: World, seat: number): void {
  const { m } = w;
  m.plCharge[seat] = 0;
  m.plSpin[seat] = 0;
  m.plParry[seat] = 0;
  m.plBeam[seat] = 0;
  m.plBeamLen[seat] = 0;
  m.plLance[seat] = 0;
  reveal(w, seat);
}
