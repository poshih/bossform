import { fx } from '@metronome/engine';
import { Attack } from './constants.ts';
import { Ev } from './events.ts';
import { Frame, GALE, JUGGERNAUT, MUZZLE, VANGUARD } from './frames.ts';
import { Button } from './input.ts';
import { fan, launch } from './projectiles.ts';
import type { Shooter } from './projectiles.ts';
import type { World } from './world.ts';

/** The three robots' own weapons (normal form). Every shot obeys the game's speed rule; see shots.ts. */
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
  if ((buttons & Button.Fire) !== 0 && m.plFireCd[seat] === 0) {
    const rifle = VANGUARD.rifle;
    fan(w, who, rifle.shot, muzzleX(w, seat), muzzleY(w, seat), m.plAim[seat], rifle.count, rifle.spread);
    m.plFireCd[seat] = rifle.interval;
    w.emit(Ev.Fire, m.plX[seat], m.plY[seat], seat, Frame.Vanguard);
  }
  if ((buttons & Button.Alt) !== 0 && m.plAltCd[seat] === 0) {
    const seekers = VANGUARD.seekers;
    fan(w, who, seekers.shot, muzzleX(w, seat), muzzleY(w, seat), m.plAim[seat], seekers.count, seekers.spread);
    m.plAltCd[seat] = seekers.cooldown;
    w.emit(Ev.Fire, m.plX[seat], m.plY[seat], seat, Frame.Vanguard);
  }
}

function gale(w: World, seat: number, who: Shooter, buttons: number, moveX: number, moveY: number): void {
  const { m } = w;
  if ((buttons & Button.Fire) !== 0 && m.plFireCd[seat] === 0) {
    const darts = GALE.darts;
    const side = m.plAim[seat] + fx.ANGLE_QUARTER;
    const ox = fx.mul(fx.cos(side), darts.offset);
    const oy = fx.mul(fx.sin(side), darts.offset);
    launch(w, who, darts.shot, muzzleX(w, seat) + ox, muzzleY(w, seat) + oy, m.plAim[seat]);
    launch(w, who, darts.shot, muzzleX(w, seat) - ox, muzzleY(w, seat) - oy, m.plAim[seat]);
    m.plFireCd[seat] = darts.interval;
    w.emit(Ev.Fire, m.plX[seat], m.plY[seat], seat, Frame.Gale);
  }
  if ((buttons & Button.Alt) !== 0 && m.plAltCd[seat] === 0) {
    const dash = GALE.dash;
    const heading = moveX !== 0 || moveY !== 0 ? fx.atan2(moveY, moveX) : m.plAim[seat];
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
  if ((buttons & Button.Fire) !== 0 && m.plFireCd[seat] === 0) {
    const mortar = JUGGERNAUT.mortar;
    launch(w, who, mortar.shot, muzzleX(w, seat), muzzleY(w, seat), m.plAim[seat]);
    m.plFireCd[seat] = mortar.interval;
    w.emit(Ev.Fire, m.plX[seat], m.plY[seat], seat, Frame.Juggernaut);
  }
  if ((buttons & Button.Alt) !== 0 && m.plAltCd[seat] === 0) {
    m.plBulwark[seat] = JUGGERNAUT.bulwark.ticks;
    m.plAltCd[seat] = JUGGERNAUT.bulwark.cooldown;
    w.emit(Ev.BulwarkUp, m.plX[seat], m.plY[seat], seat);
  }
}
