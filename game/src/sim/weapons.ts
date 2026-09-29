import { fx } from '@metronome/engine';
import { stopBoost } from './boost.ts';
import { Attack } from './constants.ts';
import { spendEnergy } from './energy.ts';
import { Ev, FireSlot } from './events.ts';
import { ALT_ABILITIES, Frame, GALE, JUGGERNAUT, MUZZLE, VANGUARD } from './frames.ts';
import { Button } from './input.ts';
import { fan, launch } from './projectiles.ts';
import type { Shooter } from './projectiles.ts';
import type { World } from './world.ts';

/** The alt can be used this tick: its cooldown has run out and the pool can pay for it (ALT_ABILITIES). */
export function canUseAlt(w: World, seat: number): boolean {
  const { m } = w;
  return m.plAltCd[seat] === 0 && m.plEnergy[seat] >= ALT_ABILITIES[m.plFrame[seat]].cost;
}

/** Holding a weapon's button: the primary always, the alt when it is an attack. An attacking robot has no shield (energy.ts). */
export function attacking(frame: number, buttons: number): boolean {
  return (buttons & Button.Fire) !== 0 || ((buttons & Button.Alt) !== 0 && ALT_ABILITIES[frame].attack);
}

/** The shield stays down while the robot attacks, and while JUGGERNAUT's bulwark is raised: the bulwark takes its place, in front only. */
export function shieldBlocked(w: World, seat: number, buttons: number): boolean {
  return attacking(w.m.plFrame[seat], buttons) || w.m.plBulwark[seat] > 0;
}

/**
 * The three robots' own weapons (normal form). Every shot obeys the game's speed rule (shots.ts) and pays its energy cost
 * (frames.ts) before it fires: a weapon whose cost the pool cannot pay stays silent.
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
    default:
      juggernaut(w, seat, who, buttons);
  }
}

function muzzleX(w: World, seat: number): number {
  return w.m.plX[seat] + fx.mul(fx.cos(w.m.plAim[seat]), MUZZLE);
}

function muzzleY(w: World, seat: number): number {
  return w.m.plY[seat] + fx.mul(fx.sin(w.m.plAim[seat]), MUZZLE);
}

function vanguard(w: World, seat: number, who: Shooter, buttons: number): void {
  const { m } = w;
  if ((buttons & Button.Fire) !== 0 && m.plFireCd[seat] === 0 && spendEnergy(w, seat, VANGUARD.rifle.cost)) {
    const rifle = VANGUARD.rifle;
    fan(w, who, rifle.shot, muzzleX(w, seat), muzzleY(w, seat), m.plAim[seat], rifle.count, rifle.spread);
    m.plFireCd[seat] = rifle.interval;
    w.emit(Ev.Fire, m.plX[seat], m.plY[seat], seat, Frame.Vanguard, FireSlot.Primary);
  }
  if ((buttons & Button.Alt) !== 0 && m.plAltCd[seat] === 0 && spendEnergy(w, seat, VANGUARD.seekers.cost)) {
    const seekers = VANGUARD.seekers;
    fan(w, who, seekers.shot, muzzleX(w, seat), muzzleY(w, seat), m.plAim[seat], seekers.count, seekers.spread);
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
    launch(w, who, darts.shot, muzzleX(w, seat) + ox, muzzleY(w, seat) + oy, m.plAim[seat]);
    launch(w, who, darts.shot, muzzleX(w, seat) - ox, muzzleY(w, seat) - oy, m.plAim[seat]);
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
    launch(w, who, mortar.shot, muzzleX(w, seat), muzzleY(w, seat), m.plAim[seat]);
    m.plFireCd[seat] = mortar.interval;
    w.emit(Ev.Fire, m.plX[seat], m.plY[seat], seat, Frame.Juggernaut, FireSlot.Primary);
  }
  if ((buttons & Button.Alt) !== 0 && m.plAltCd[seat] === 0) {
    m.plBulwark[seat] = JUGGERNAUT.bulwark.ticks;
    m.plAltCd[seat] = JUGGERNAUT.bulwark.cooldown;
    w.emit(Ev.BulwarkUp, m.plX[seat], m.plY[seat], seat);
  }
}
