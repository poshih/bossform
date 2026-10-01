import { BOSS_MIN_GAUGE, ENERGY_MAX, Form, Phase, SPAWN_PROTECT_TICKS } from './constants.ts';
import { startMorph, updateBoss, updateMorph } from './boss.ts';
import { canBoost, continueBoost, startBoost, stopBursts } from './boost.ts';
import { dropShield, regenEnergy, updateShield } from './energy.ts';
import { Ev } from './events.ts';
import { FRAME_STATS, JUGGERNAUT } from './frames.ts';
import type { Vec } from './geometry.ts';
import { Button } from './input.ts';
import type { GameInput } from './input.ts';
import { clearKit } from './kit.ts';
import { W } from './layout.ts';
import { coast, driveRobot, keepInside } from './movement.ts';
import { clearBoss } from './parts.ts';
import { respawnPoint } from './spawn.ts';
import { fireNormal, shieldBlocked } from './weapons.ts';
import type { World } from './world.ts';

/** Puts a ship (back) into play at full health, in its normal form, at a spawn point, its kit idle and uncloaked. */
export function resetShip(w: World, seat: number, at: Vec, aim: number, protection: number): void {
  const { m } = w;
  clearBoss(w, seat);
  clearKit(w, seat);
  m.plAlive[seat] = 1;
  m.plHp[seat] = FRAME_STATS[m.plFrame[seat]].hp;
  m.plGauge[seat] = 0;
  m.plX[seat] = at.x;
  m.plY[seat] = at.y;
  m.plVX[seat] = 0;
  m.plVY[seat] = 0;
  m.plAim[seat] = aim;
  m.plBody[seat] = aim;
  m.plOrbit[seat] = 0;
  m.plInvuln[seat] = protection;
  m.plRespawn[seat] = 0;
  m.plWinEnd[seat] = 0;
  m.plWinDmg[seat] = 0;
  m.plFlash[seat] = 0;
  m.plFireCd[seat] = 0;
  m.plAltCd[seat] = 0;
  m.plUltCd[seat] = 0;
  m.plDash[seat] = 0;
  m.plBulwark[seat] = 0;
  m.plEnergy[seat] = ENERGY_MAX;
  m.plRegenWait[seat] = 0;
  m.plShield[seat] = 0;
  m.plShieldWait[seat] = 0;
  m.plShieldBreak[seat] = 0;
  m.plBoost[seat] = 0;
  m.plBoostCd[seat] = 0;
  m.plBeamAng[seat] = 0;
  m.plLanceAng[seat] = 0;
  m.plSide[seat] = 0;
  m.plLastHit[seat] = -1;
  m.plEpoch[seat]++;
}

/** A pilot who left the match: their ship is gone for good. */
function retire(w: World, seat: number): void {
  const { m } = w;
  clearBoss(w, seat);
  clearKit(w, seat);
  dropShield(w, seat);
  stopBursts(w, seat);
  m.plActive[seat] = 0;
  m.plAlive[seat] = 0;
  m.plRespawn[seat] = 0;
  w.emit(Ev.Left, m.plX[seat], m.plY[seat], seat);
}

function tickTimers(w: World, seat: number): void {
  const { m } = w;
  if (m.plInvuln[seat] > 0) m.plInvuln[seat]--;
  if (m.plFlash[seat] > 0) m.plFlash[seat]--;
  if (m.plFireCd[seat] > 0) m.plFireCd[seat]--;
  if (m.plAltCd[seat] > 0) m.plAltCd[seat]--;
  if (m.plUltCd[seat] > 0) m.plUltCd[seat]--;
  if (m.plBulwark[seat] > 0) m.plBulwark[seat]--;
  if (m.plShieldBreak[seat] > 0) m.plShieldBreak[seat]--;
  if (m.plShieldWait[seat] > 0) m.plShieldWait[seat]--;
  if (m.plBoostCd[seat] > 0) m.plBoostCd[seat]--;
  if (m.plParry[seat] > 0) m.plParry[seat]--;
  if (m.plCloak[seat] > 0 && --m.plCloak[seat] === 0) w.emit(Ev.Reveal, m.plX[seat], m.plY[seat], seat);
}

function respawnCountdown(w: World, seat: number): void {
  const { m } = w;
  if (!w.isDeathmatch || m.world[W.Phase] !== Phase.Battle || m.plRespawn[seat] === 0) return;
  if (--m.plRespawn[seat] > 0) return;
  const at: Vec = { x: 0, y: 0 };
  const aim = respawnPoint(w, seat, at);
  resetShip(w, seat, at, aim, SPAWN_PROTECT_TICKS);
  w.emit(Ev.Respawn, at.x, at.y, seat);
}

function updateNormal(w: World, seat: number, buttons: number, moveX: number, moveY: number): void {
  const { m } = w;
  const stats = FRAME_STATS[m.plFrame[seat]];
  m.plBody[seat] = m.plAim[seat];
  // Held, not pressed: a pilot holding the button while the gauge fills transforms the moment it can.
  if ((buttons & Button.Boss) !== 0 && m.plGauge[seat] >= BOSS_MIN_GAUGE) {
    startMorph(w, seat);
    return;
  }
  fireNormal(w, seat, buttons, moveX, moveY);
  updateShield(w, seat, shieldBlocked(w, seat, buttons));
  if (m.plDash[seat] > 0) {
    m.plDash[seat]--;
    coast(w, seat);
  } else {
    // Held, not pressed (like the transform button): a pilot holding boost boosts again the moment the cooldown allows.
    if ((buttons & Button.Boost) !== 0 && canBoost(w, seat)) startBoost(w, seat, moveX, moveY);
    if (m.plBoost[seat] > 0) {
      continueBoost(w, seat);
    } else {
      // JUGGERNAUT's raised bulwark slows it; PRISM braced in its lance tell stands still, so the locked line stays put.
      const bulwark = m.plBulwark[seat] > 0;
      const top = m.plLance[seat] > 0 ? 0 : bulwark ? Math.floor((stats.speed * JUGGERNAUT.bulwark.slowPct) / 100) : stats.speed;
      driveRobot(w, seat, moveX, moveY, top, stats.accel, stats.brake);
    }
  }
  keepInside(w, seat, stats.bodyR);
}

function updateShip(w: World, seat: number, input: GameInput, present: boolean): void {
  const { m } = w;
  if (m.plActive[seat] === 0) return;
  if (!present) {
    retire(w, seat);
    return;
  }
  tickTimers(w, seat);
  if (m.plAlive[seat] === 0) {
    respawnCountdown(w, seat);
    return;
  }
  regenEnergy(w, seat);
  const fighting = m.world[W.Phase] === Phase.Battle;
  const buttons = fighting ? input.buttons : 0;
  const moveX = fighting ? input.moveX : 0;
  const moveY = fighting ? input.moveY : 0;
  m.plAim[seat] = input.aim;
  switch (m.plForm[seat]) {
    case Form.Normal:
      updateNormal(w, seat, buttons, moveX, moveY);
      break;
    case Form.Morph:
      m.plBody[seat] = m.plAim[seat];
      updateMorph(w, seat);
      keepInside(w, seat, FRAME_STATS[m.plFrame[seat]].bodyR);
      break;
    default:
      updateBoss(w, seat, buttons, moveX, moveY);
  }
}

export function updateShips(w: World, inputs: readonly GameInput[], present: readonly boolean[]): void {
  for (let seat = 0; seat < w.seats; seat++) updateShip(w, seat, inputs[seat], present[seat]);
}

