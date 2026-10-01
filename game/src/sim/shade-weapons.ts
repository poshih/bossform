import { spendEnergy } from './energy.ts';
import { Ev, FireSlot } from './events.ts';
import { Frame } from './frame-ids.ts';
import type { Vec } from './geometry.ts';
import { Button } from './input.ts';
import { reveal } from './kit.ts';
import { launch } from './projectiles.ts';
import type { Shooter } from './projectiles.ts';
import { muzzle } from './query.ts';
import { SHADE } from './shade.ts';
import type { World } from './world.ts';

/**
 * SHADE's SHURIKEN and SHADOW VEIL (numbers in shade.ts), every normal-form tick (weapons.ts fireNormal). A throw from under the
 * veil ends it, and throws AMBUSH stars.
 */
export function fireShade(w: World, seat: number, who: Shooter, buttons: number, _moveX: number, _moveY: number): void {
  const { m } = w;
  const stars = SHADE.shuriken;
  if ((buttons & Button.Fire) !== 0 && m.plFireCd[seat] === 0 && spendEnergy(w, seat, stars.cost)) {
    const ambush = m.plCloak[seat] > 0;
    reveal(w, seat);
    const at: Vec = { x: 0, y: 0 };
    muzzle(w, seat, m.plAim[seat], at);
    launch(w, who, ambush ? stars.ambushLeft : stars.left, at.x, at.y, m.plAim[seat] + stars.angle);
    launch(w, who, ambush ? stars.ambushRight : stars.right, at.x, at.y, m.plAim[seat] - stars.angle);
    m.plFireCd[seat] = stars.interval;
    w.emit(Ev.Fire, m.plX[seat], m.plY[seat], seat, Frame.Shade, FireSlot.Primary);
  }
  const veil = SHADE.veil;
  if ((buttons & Button.Alt) !== 0 && m.plAltCd[seat] === 0 && spendEnergy(w, seat, veil.cost)) {
    m.plCloak[seat] = veil.ticks;
    m.plAltCd[seat] = veil.cooldown;
    w.emit(Ev.Cloak, m.plX[seat], m.plY[seat], seat);
  }
}
