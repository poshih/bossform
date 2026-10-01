import { Phase } from './constants.ts';
import { spendEnergy } from './energy.ts';
import { Ev, FireSlot } from './events.ts';
import { Frame } from './frame-ids.ts';
import type { Vec } from './geometry.ts';
import { Button } from './input.ts';
import { W } from './layout.ts';
import { LONGBOW } from './longbow.ts';
import { launch } from './projectiles.ts';
import type { Shooter } from './projectiles.ts';
import { muzzle } from './query.ts';
import type { ShotDef } from './shots.ts';
import type { World } from './world.ts';

/**
 * LONGBOW's RAIL RIFLE and TRIPMINE (numbers in longbow.ts), every normal-form tick (weapons.ts fireNormal). Holding fire
 * charges the rifle (Ev.ChargeFull when it is full); letting go fires it. The tripmine is laid where the robot stands.
 */
export function fireLongbow(w: World, seat: number, who: Shooter, buttons: number, _moveX: number, _moveY: number): void {
  const { m } = w;
  if (m.world[W.Phase] !== Phase.Battle) {
    // Out of battle every button reads as released (ships.ts): a charge still held when the round ends is dropped, not fired.
    m.plCharge[seat] = 0;
    return;
  }
  const rail = LONGBOW.rail;
  if ((buttons & Button.Fire) !== 0) {
    // A tick the pool cannot pay for, the charge holds where it is.
    if (m.plFireCd[seat] === 0 && m.plCharge[seat] < rail.full && spendEnergy(w, seat, rail.cost) && ++m.plCharge[seat] === rail.full) {
      w.emit(Ev.ChargeFull, m.plX[seat], m.plY[seat], seat);
    }
  } else if (m.plCharge[seat] > 0) loose(w, seat, who);
  const tripmine = LONGBOW.tripmine;
  if ((buttons & Button.Alt) !== 0 && m.plAltCd[seat] === 0 && spendEnergy(w, seat, tripmine.cost)) {
    launch(w, who, tripmine.mine, m.plX[seat], m.plY[seat], m.plAim[seat]);
    m.plAltCd[seat] = tripmine.cooldown;
    w.emit(Ev.Fire, m.plX[seat], m.plY[seat], seat, Frame.Longbow, FireSlot.Alt);
  }
}

/** Fire was let go: the rifle fires the strongest tier its charge reached, if any, and cools down. Below the first tier the charge is lost. */
function loose(w: World, seat: number, who: Shooter): void {
  const { m } = w;
  const rail = LONGBOW.rail;
  let shot: ShotDef | null = null;
  for (const tier of rail.tiers) if (m.plCharge[seat] >= tier.charge) shot = tier.shot;
  m.plCharge[seat] = 0;
  if (shot === null) return;
  const at: Vec = { x: 0, y: 0 };
  muzzle(w, seat, m.plAim[seat], at);
  launch(w, who, shot, at.x, at.y, m.plAim[seat]);
  m.plFireCd[seat] = rail.cooldown;
  w.emit(Ev.Fire, m.plX[seat], m.plY[seat], seat, Frame.Longbow, FireSlot.Primary);
}
