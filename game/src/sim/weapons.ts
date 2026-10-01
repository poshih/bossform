import { fx } from '@metronome/engine';
import { stopBoost } from './boost.ts';
import { Attack } from './constants.ts';
import { spendEnergy } from './energy.ts';
import { Ev, FireSlot } from './events.ts';
import { ALT_ABILITIES, Frame, GALE, JUGGERNAUT, PRIMARY_WEAPONS, VANGUARD } from './frames.ts';
import { fireGauntlet } from './gauntlet-weapons.ts';
import type { Vec } from './geometry.ts';
import { fireHailstorm } from './hailstorm-weapons.ts';
import { Button } from './input.ts';
import { fireLongbow } from './longbow-weapons.ts';
import { firePrism, lanceReady } from './prism-weapons.ts';
import { PRISM } from './prism.ts';
import { fan, hasReturning, launch } from './projectiles.ts';
import type { Shooter } from './projectiles.ts';
import { muzzle } from './query.ts';
import { fireRonin } from './ronin-weapons.ts';
import { fireShade } from './shade-weapons.ts';
import type { World } from './world.ts';

/**
 * The alt can be used this tick: its cooldown has run out and the pool can pay for it (ALT_ABILITIES); PRISM also needs no
 * lance in its tell, GAUNTLET no fist of its own out.
 */
export function canUseAlt(w: World, seat: number): boolean {
  const { m } = w;
  const frame = m.plFrame[seat];
  if (m.plAltCd[seat] !== 0 || m.plEnergy[seat] < ALT_ABILITIES[frame].cost) return false;
  if (frame === Frame.Prism) return lanceReady(w, seat);
  if (frame === Frame.Gauntlet) return !hasReturning(w, seat);
  return true;
}

/**
 * The energy the primary needs to fire, or go on firing, now (below it the weapon is dry): its cost (PRIMARY_WEAPONS), except
 * PRISM's beam, which starts only with its whole tell and first firing tick in the pool and then pays tick by tick. `beam` is
 * the seat's plBeam (0 when no beam runs).
 */
export function primaryCost(frame: number, beam: number): number {
  if (frame !== Frame.Prism) return PRIMARY_WEAPONS[frame].cost;
  if (beam === 0) return PRISM.beam.start;
  return beam >= PRISM.beam.tell ? PRISM.beam.cost : PRISM.beam.tellCost;
}

/** Holding a weapon's button: the primary always, the alt when it is an attack. An attacking robot has no shield (energy.ts). */
export function attacking(frame: number, buttons: number): boolean {
  return (buttons & Button.Fire) !== 0 || ((buttons & Button.Alt) !== 0 && ALT_ABILITIES[frame].attack);
}

/**
 * The shield stays down while the robot attacks, while JUGGERNAUT's bulwark is raised (the bulwark takes its place, in front
 * only), while RONIN parries, and while PRISM's lance tells.
 */
export function shieldBlocked(w: World, seat: number, buttons: number): boolean {
  const { m } = w;
  return attacking(m.plFrame[seat], buttons) || m.plBulwark[seat] > 0 || m.plParry[seat] > 0 || m.plLance[seat] > 0;
}

/**
 * Each robot's own weapons (normal form), every tick: the original three below, the others in <robot>-weapons.ts. Every shot
 * obeys the game's speed rule (shots.ts) and pays its energy cost (frames.ts, <robot>.ts) before it fires: a weapon whose
 * cost the pool cannot pay stays silent.
 */
export function fireNormal(w: World, seat: number, buttons: number, moveX: number, moveY: number): void {
  const { m } = w;
  const who: Shooter = { owner: seat, team: m.plTeam[seat], attack: Attack.None, part: -1 };
  switch (m.plFrame[seat]) {
    case Frame.Vanguard:
      vanguard(w, seat, who, buttons);
      break;
    case Frame.Gale:
      gale(w, seat, who, buttons, moveX, moveY);
      break;
    case Frame.Juggernaut:
      juggernaut(w, seat, who, buttons);
      break;
    case Frame.Longbow:
      fireLongbow(w, seat, who, buttons, moveX, moveY);
      break;
    case Frame.Prism:
      firePrism(w, seat, who, buttons, moveX, moveY);
      break;
    case Frame.Hailstorm:
      fireHailstorm(w, seat, who, buttons, moveX, moveY);
      break;
    case Frame.Ronin:
      fireRonin(w, seat, who, buttons, moveX, moveY);
      break;
    case Frame.Shade:
      fireShade(w, seat, who, buttons, moveX, moveY);
      break;
    case Frame.Gauntlet:
      fireGauntlet(w, seat, who, buttons, moveX, moveY);
      break;
    default:
      throw new RangeError(`seat ${seat} flies unknown frame ${m.plFrame[seat]}`);
  }
}

function vanguard(w: World, seat: number, who: Shooter, buttons: number): void {
  const { m } = w;
  const at: Vec = { x: 0, y: 0 };
  if ((buttons & Button.Fire) !== 0 && m.plFireCd[seat] === 0 && spendEnergy(w, seat, VANGUARD.rifle.cost)) {
    const rifle = VANGUARD.rifle;
    muzzle(w, seat, m.plAim[seat], at);
    fan(w, who, rifle.shot, at.x, at.y, m.plAim[seat], rifle.count, rifle.spread);
    m.plFireCd[seat] = rifle.interval;
    w.emit(Ev.Fire, m.plX[seat], m.plY[seat], seat, Frame.Vanguard, FireSlot.Primary);
  }
  if ((buttons & Button.Alt) !== 0 && m.plAltCd[seat] === 0 && spendEnergy(w, seat, VANGUARD.seekers.cost)) {
    const seekers = VANGUARD.seekers;
    muzzle(w, seat, m.plAim[seat], at);
    fan(w, who, seekers.shot, at.x, at.y, m.plAim[seat], seekers.count, seekers.spread);
    m.plAltCd[seat] = seekers.cooldown;
    w.emit(Ev.Fire, m.plX[seat], m.plY[seat], seat, Frame.Vanguard, FireSlot.Alt);
  }
}

function gale(w: World, seat: number, who: Shooter, buttons: number, moveX: number, moveY: number): void {
  const { m } = w;
  if ((buttons & Button.Fire) !== 0 && m.plFireCd[seat] === 0 && spendEnergy(w, seat, GALE.darts.cost)) {
    const darts = GALE.darts;
    const side = m.plAim[seat] + fx.ANGLE_QUARTER;
    const ox = fx.mul(fx.cos(side), darts.offset);
    const oy = fx.mul(fx.sin(side), darts.offset);
    const at: Vec = { x: 0, y: 0 };
    muzzle(w, seat, m.plAim[seat], at);
    launch(w, who, darts.shot, at.x + ox, at.y + oy, m.plAim[seat]);
    launch(w, who, darts.shot, at.x - ox, at.y - oy, m.plAim[seat]);
    m.plFireCd[seat] = darts.interval;
    w.emit(Ev.Fire, m.plX[seat], m.plY[seat], seat, Frame.Gale, FireSlot.Primary);
  }
  if ((buttons & Button.Alt) !== 0 && m.plAltCd[seat] === 0) {
    const dash = GALE.dash;
    const heading = moveX !== 0 || moveY !== 0 ? fx.atan2(moveY, moveX) : m.plAim[seat];
    stopBoost(w, seat);
    m.plVX[seat] = fx.mul(fx.cos(heading), dash.speed);
    m.plVY[seat] = fx.mul(fx.sin(heading), dash.speed);
    m.plDash[seat] = dash.ticks;
    m.plAltCd[seat] = dash.cooldown;
    m.plInvuln[seat] = Math.max(m.plInvuln[seat], dash.protect);
    launch(w, who, dash.echo, m.plX[seat], m.plY[seat], heading + fx.ANGLE_HALF);
    w.emit(Ev.Dash, m.plX[seat], m.plY[seat], seat, heading);
  }
}

function juggernaut(w: World, seat: number, who: Shooter, buttons: number): void {
  const { m } = w;
  if ((buttons & Button.Fire) !== 0 && m.plFireCd[seat] === 0 && spendEnergy(w, seat, JUGGERNAUT.mortar.cost)) {
    const mortar = JUGGERNAUT.mortar;
    const at: Vec = { x: 0, y: 0 };
    muzzle(w, seat, m.plAim[seat], at);
    launch(w, who, mortar.shot, at.x, at.y, m.plAim[seat]);
    m.plFireCd[seat] = mortar.interval;
    w.emit(Ev.Fire, m.plX[seat], m.plY[seat], seat, Frame.Juggernaut, FireSlot.Primary);
  }
  if ((buttons & Button.Alt) !== 0 && m.plAltCd[seat] === 0) {
    m.plBulwark[seat] = JUGGERNAUT.bulwark.ticks;
    m.plAltCd[seat] = JUGGERNAUT.bulwark.cooldown;
    w.emit(Ev.BulwarkUp, m.plX[seat], m.plY[seat], seat);
  }
}
