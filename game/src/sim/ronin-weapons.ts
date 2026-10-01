import { fx } from '@metronome/engine';
import { Attack, GAUGE_PER_ABSORB } from './constants.ts';
import { spendEnergy } from './energy.ts';
import { Ev, FireSlot, ReflectKind } from './events.ts';
import { Frame } from './frame-ids.ts';
import { earn } from './gauge.ts';
import { within } from './geometry.ts';
import type { Vec } from './geometry.ts';
import { Button } from './input.ts';
import { fan, reissue, turnBack } from './projectiles.ts';
import type { Shooter } from './projectiles.ts';
import { muzzle } from './query.ts';
import { RONIN } from './ronin.ts';
import { ShotFlag } from './shots.ts';
import type { ShotDef } from './shots.ts';
import type { World } from './world.ts';

/**
 * RONIN's KATANA and PARRY (numbers in ronin.ts), every normal-form tick (weapons.ts fireNormal). The blade is either cutting
 * or guarding: the katana does not swing while a parry is up.
 */
export function fireRonin(w: World, seat: number, who: Shooter, buttons: number, _moveX: number, _moveY: number): void {
  const { m } = w;
  const katana = RONIN.katana;
  if ((buttons & Button.Fire) !== 0 && m.plParry[seat] === 0 && m.plFireCd[seat] === 0 && spendEnergy(w, seat, katana.cost)) {
    const at: Vec = { x: 0, y: 0 };
    muzzle(w, seat, m.plAim[seat], at);
    fan(w, who, katana.shot, at.x, at.y, m.plAim[seat], katana.count, katana.spread);
    m.plFireCd[seat] = katana.interval;
    m.plSide[seat] ^= 1;
    w.emit(Ev.Fire, m.plX[seat], m.plY[seat], seat, Frame.Ronin, FireSlot.Primary);
  }
  if ((buttons & Button.Alt) !== 0 && m.plAltCd[seat] === 0) {
    // After the katana's check: a cut on the very tick the guard goes up still leaves.
    m.plParry[seat] = RONIN.parry.ticks;
    m.plAltCd[seat] = RONIN.parry.cooldown;
    w.emit(Ev.ParryUp, m.plX[seat], m.plY[seat], seat);
  }
}

/** Something at (dx, dy) from a RONIN, `rad` wide, is inside its raised parry: within reach, in front of its aim. */
export function parries(w: World, seat: number, dx: number, dy: number, rad: number): boolean {
  const { m } = w;
  const parry = RONIN.parry;
  return m.plParry[seat] > 0 && within(dx, dy, parry.radius + rad) && Math.abs(fx.angleDiff(m.plAim[seat], fx.atan2(dy, dx))) <= parry.halfArc;
}

/** A parry turned something back: the pilot earns as for an absorbed shot, and the parry's cooldown is cut to the riposte. */
function riposte(w: World, seat: number): void {
  const { m } = w;
  earn(w, seat, GAUGE_PER_ABSORB);
  m.plAltCd[seat] = Math.min(m.plAltCd[seat], RONIN.parry.riposte);
}

/**
 * The parry sends hostile projectile `p` back: it becomes the RONIN's own shot, fresh, flying along its aim at its own speed
 * and damage. A returning shot is only sent into its return (it stays its owner's, and will not strike this RONIN again).
 */
export function reflect(w: World, seat: number, p: number, def: ShotDef): void {
  const { m } = w;
  if ((def.flags & ShotFlag.Return) !== 0) turnBack(w, p, seat);
  else reissue(w, p, { owner: seat, team: m.plTeam[seat], attack: Attack.None, part: -1 }, m.plAim[seat]);
  riposte(w, seat);
  w.emit(Ev.Reflect, m.pX[p], m.pY[p], seat, def.id, ReflectKind.Shot);
}

/** The parry cut a beam's pulse short at (x, y) (beams.ts). */
export function cutBeam(w: World, seat: number, x: number, y: number): void {
  riposte(w, seat);
  w.emit(Ev.Reflect, x, y, seat, -1, ReflectKind.Beam);
}
