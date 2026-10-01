import { fx } from '@metronome/engine';
import { fireBeam, traceBeam } from './beams.ts';
import type { Beam } from './beams.ts';
import { stopBursts } from './boost.ts';
import { spendEnergy } from './energy.ts';
import { BeamKind, Ev, FireSlot } from './events.ts';
import { Frame } from './frame-ids.ts';
import type { Vec } from './geometry.ts';
import { Button } from './input.ts';
import { PRISM } from './prism.ts';
import type { Shooter } from './projectiles.ts';
import { muzzle } from './query.ts';
import type { World } from './world.ts';

/** PRISM's lance can be tapped: no lance is in its tell (canUseAlt adds the cooldown and the energy). */
export function lanceReady(w: World, seat: number): boolean {
  return w.m.plLance[seat] === 0;
}

/**
 * PRISM's BEAM and LANCE (numbers in prism.ts), every normal-form tick (weapons.ts fireNormal): a lance in its tell counts
 * down and fires, a tap locks a new one, then the beam runs. Both hit through beams.ts, from the muzzle.
 */
export function firePrism(w: World, seat: number, _who: Shooter, buttons: number, _moveX: number, _moveY: number): void {
  const { m } = w;
  const lance = PRISM.lance;
  if (m.plLance[seat] > 0 && --m.plLance[seat] === 0) fireLance(w, seat);
  if ((buttons & Button.Alt) !== 0 && m.plAltCd[seat] === 0 && lanceReady(w, seat) && spendEnergy(w, seat, lance.cost)) {
    m.plLance[seat] = lance.tell;
    m.plLanceAng[seat] = m.plAim[seat];
    m.plAltCd[seat] = lance.cooldown;
    // PRISM braces so the line stays where its tell shows it: a running boost ends, and ships.ts holds it still until the rail.
    stopBursts(w, seat);
    w.emit(Ev.Fire, m.plX[seat], m.plY[seat], seat, Frame.Prism, FireSlot.Alt);
  }
  runBeam(w, seat, buttons);
}

/** The lance's tell is over: one instant rail along the locked angle, and its pulse lands on the first thing in the way. */
function fireLance(w: World, seat: number): void {
  const { m } = w;
  const lance = PRISM.lance;
  const angle = m.plLanceAng[seat];
  const at: Vec = { x: 0, y: 0 };
  muzzle(w, seat, angle, at);
  w.emit(Ev.BeamOn, at.x, at.y, seat, 0, BeamKind.Lance);
  const reach = fireBeam(w, { owner: seat, team: m.plTeam[seat], width: lance.width, dmg: lance.dmg }, at.x, at.y, angle, lance.length);
  w.emit(Ev.LanceFire, at.x + fx.mul(fx.cos(angle), reach), at.y + fx.mul(fx.sin(angle), reach), seat);
}

/** The beam ends (let go, the pool ran dry, a lance took over): the weapon cools down. */
function stopBeam(w: World, seat: number): void {
  const { m } = w;
  m.plBeam[seat] = 0;
  m.plBeamLen[seat] = 0;
  m.plFireCd[seat] = PRISM.beam.cooldown;
}

/**
 * One tick of the beam: a press starts it on the aim (if the pool can pay its whole tell and first firing tick), it tells, then
 * fires while fire is held and the pool pays, following the aim at its turn rate. plBeamLen is how far it reaches (where
 * something stops it), telling or firing.
 */
function runBeam(w: World, seat: number, buttons: number): void {
  const { m } = w;
  const beam = PRISM.beam;
  const held = (buttons & Button.Fire) !== 0 && m.plLance[seat] === 0;
  if (m.plBeam[seat] === 0) {
    if (!held || m.plFireCd[seat] !== 0 || m.plEnergy[seat] < beam.start || !spendEnergy(w, seat, beam.tellCost)) return;
    m.plBeam[seat] = 1;
    m.plBeamAng[seat] = m.plAim[seat];
    w.emit(Ev.Fire, m.plX[seat], m.plY[seat], seat, Frame.Prism, FireSlot.Primary);
  } else {
    const next = m.plBeam[seat] + 1;
    if (!held || !spendEnergy(w, seat, next > beam.tell ? beam.cost : beam.tellCost)) {
      stopBeam(w, seat);
      return;
    }
    m.plBeam[seat] = next;
    m.plBeamAng[seat] = fx.turnToward(m.plBeamAng[seat], m.plAim[seat], beam.turn);
  }
  const angle = m.plBeamAng[seat];
  const at: Vec = { x: 0, y: 0 };
  muzzle(w, seat, angle, at);
  const shot: Beam = { owner: seat, team: m.plTeam[seat], width: beam.width, dmg: beam.dmg };
  // Ticks since it began firing; negative while it tells.
  const firing = m.plBeam[seat] - beam.tell - 1;
  if (firing === 0) w.emit(Ev.BeamOn, at.x, at.y, seat, 0, BeamKind.Primary);
  m.plBeamLen[seat] = firing >= 0 && firing % beam.every === 0 ? fireBeam(w, shot, at.x, at.y, angle, beam.length) : traceBeam(w, shot, at.x, at.y, angle, beam.length);
}
