import { fx } from '@metronome/engine';
import { spendEnergy } from './energy.ts';
import { Ev, FireSlot } from './events.ts';
import { Frame } from './frame-ids.ts';
import { GAUNTLET } from './gauntlet.ts';
import type { Vec } from './geometry.ts';
import { Button } from './input.ts';
import { hasReturning, launch } from './projectiles.ts';
import type { Shooter } from './projectiles.ts';
import { muzzle } from './query.ts';
import type { World } from './world.ts';

/** Which arm a fist leaves from: the left of the aim line, or the right (the sign of its offset). */
const Arm = { Left: 1, Right: -1 } as const;
/** plSide: the arm the next knuckle leaves from (the view shows the latest from it). */
const Next = { Left: 0, Right: 1 } as const;

/** Where a fist leaves: the muzzle, moved the knuckle offset to the `arm` side of the aim line. */
function fistAt(w: World, seat: number, arm: number, out: Vec): void {
  const aim = w.m.plAim[seat];
  const across = aim + fx.ANGLE_QUARTER;
  muzzle(w, seat, aim, out);
  out.x += arm * fx.mul(fx.cos(across), GAUNTLET.knuckle.offset);
  out.y += arm * fx.mul(fx.sin(across), GAUNTLET.knuckle.offset);
}

/**
 * GAUNTLET's ROCKET PUNCH and KNUCKLE CANNON (numbers in gauntlet.ts), every normal-form tick (weapons.ts fireNormal). The rocket
 * punch (the left fist) waits until no fist of its own is out; it goes first, and the knuckle fired on the same tick, like the
 * next one, leaves from the right arm. The knuckles alternate arms.
 */
export function fireGauntlet(w: World, seat: number, who: Shooter, buttons: number, _moveX: number, _moveY: number): void {
  const { m } = w;
  const at: Vec = { x: 0, y: 0 };
  const rocket = GAUNTLET.rocket;
  if ((buttons & Button.Alt) !== 0 && m.plAltCd[seat] === 0 && !hasReturning(w, seat) && spendEnergy(w, seat, rocket.cost)) {
    fistAt(w, seat, Arm.Left, at);
    launch(w, who, rocket.fist, at.x, at.y, m.plAim[seat]);
    m.plAltCd[seat] = rocket.cooldown;
    m.plSide[seat] = Next.Right;
    w.emit(Ev.Fire, m.plX[seat], m.plY[seat], seat, Frame.Gauntlet, FireSlot.Alt);
  }
  const knuckle = GAUNTLET.knuckle;
  if ((buttons & Button.Fire) !== 0 && m.plFireCd[seat] === 0 && spendEnergy(w, seat, knuckle.cost)) {
    fistAt(w, seat, m.plSide[seat] === Next.Left ? Arm.Left : Arm.Right, at);
    launch(w, who, knuckle.shot, at.x, at.y, m.plAim[seat]);
    m.plSide[seat] ^= 1;
    m.plFireCd[seat] = knuckle.interval;
    w.emit(Ev.Fire, m.plX[seat], m.plY[seat], seat, Frame.Gauntlet, FireSlot.Primary);
  }
}
