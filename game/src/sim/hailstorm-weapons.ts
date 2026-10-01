import { spendEnergy } from './energy.ts';
import { Ev, FireSlot } from './events.ts';
import { Frame } from './frame-ids.ts';
import type { Vec } from './geometry.ts';
import { HAILSTORM } from './hailstorm.ts';
import { Button } from './input.ts';
import { carpet, launch } from './projectiles.ts';
import type { Shooter } from './projectiles.ts';
import { muzzle } from './query.ts';
import type { World } from './world.ts';

/**
 * HAILSTORM's ROTARY CANNON and CARPET BOMB (numbers in hailstorm.ts), every normal-form tick (weapons.ts fireNormal). The
 * cannon spins up with every shot and down on every tick fire is not held; the spin sets how soon it fires again. Its rounds
 * leave alternately either side of the aim (plSide: the barrel pair the next one leaves from, 0 left), each by a random share
 * of the jitter (the simulation's own random stream), so the spray has no hole along the aim line.
 */
export function fireHailstorm(w: World, seat: number, who: Shooter, buttons: number, _moveX: number, _moveY: number): void {
  const { m } = w;
  const cannon = HAILSTORM.cannon;
  const at: Vec = { x: 0, y: 0 };
  if ((buttons & Button.Fire) === 0) {
    if (m.plSpin[seat] > 0) m.plSpin[seat]--;
  } else if (m.plFireCd[seat] === 0 && spendEnergy(w, seat, cannon.cost)) {
    const off = w.rng.int(cannon.jitter + 1);
    muzzle(w, seat, m.plAim[seat], at);
    launch(w, who, cannon.shot, at.x, at.y, m.plAim[seat] + (m.plSide[seat] === 0 ? off : -off));
    m.plSide[seat] ^= 1;
    m.plSpin[seat] = Math.min(cannon.spinMax, m.plSpin[seat] + cannon.spinPerShot);
    m.plFireCd[seat] = cannon.slowest - Math.floor((cannon.spinUp * m.plSpin[seat]) / cannon.spinMax);
    w.emit(Ev.Fire, m.plX[seat], m.plY[seat], seat, Frame.Hailstorm, FireSlot.Primary);
  }
  const bombs = HAILSTORM.carpet;
  if ((buttons & Button.Alt) !== 0 && m.plAltCd[seat] === 0 && spendEnergy(w, seat, bombs.cost)) {
    muzzle(w, seat, m.plAim[seat], at);
    carpet(w, who, bombs.bomb, at.x, at.y, m.plAim[seat], bombs.first, bombs.gap, bombs.count);
    m.plAltCd[seat] = bombs.cooldown;
    w.emit(Ev.Fire, m.plX[seat], m.plY[seat], seat, Frame.Hailstorm, FireSlot.Alt);
  }
}
