import { fx } from '@metronome/engine';
import {
  ARENA_HALF_H, ARENA_HALF_W, BOSS_ABSORB_SCORE, BOSS_MODE_TICKS, BOSS_REVERT_PULSE_R, BOSS_TRANSFORM_PULSE_R, Frame, FRAME_STATS, GALE, GAUGE_MAX,
  JUGGERNAUT, MAX_BULLETS, MAX_ENEMIES, MUZZLE, PLAYER_MARGIN_X, PLAYER_MARGIN_Y, PULSE_DAMAGE, ShotKind, TRANSFORM_TICKS, VANGUARD,
  BULLET_RADIUS, RESPAWN_INVULN,
} from './constants.ts';
import { addScore, cancelBulletsInRadius, damageEnemy, isDashing } from './combat.ts';
import { Ev } from './events.ts';
import { Button, MOVE_MAX } from './input.ts';
import type { GameInput } from './input.ts';
import { spawnShot } from './shots.ts';
import type { World } from './world.ts';
import { W } from './layout.ts';

const BOSS_REVERT_INVULN = 60;

export function updatePlayers(w: World, inputs: readonly GameInput[], present: readonly boolean[]): void {
  for (let p = 0; p < w.seats; p++) updatePlayer(w, p, inputs[p], present[p]);
}

function updatePlayer(w: World, p: number, input: GameInput, connected: boolean): void {
  const { m } = w;
  m.plPX[p] = m.plX[p];
  m.plPY[p] = m.plY[p];
  if (m.plActive[p] !== 1) return;
  tickTimers(w, p);
  if (m.plRespawn[p] > 0) {
    if (--m.plRespawn[p] === 0) respawn(w, p);
    m.plPrevButtons[p] = 0;
    return;
  }
  if (m.plHp[p] <= 0) return;

  const buttons = connected ? input.buttons : 0;
  if (connected) m.plAim[p] = input.aim;
  const pressed = buttons & ~m.plPrevButtons[p];
  m.plPrevButtons[p] = buttons;

  updateBossMode(w, p, pressed);
  move(w, p, input, connected);
  fireWeapons(w, p, buttons, pressed, input, connected);
}

function tickTimers(w: World, p: number): void {
  const { m } = w;
  if (m.plInvuln[p] > 0) m.plInvuln[p]--;
  if (m.plFlash[p] > 0) m.plFlash[p]--;
  if (m.plFireCd[p] > 0) m.plFireCd[p]--;
  if (m.plAltCd[p] > 0) m.plAltCd[p]--;
  if (m.plChainTimer[p] > 0 && --m.plChainTimer[p] === 0) m.plChain[p] = 0;
}

export function respawn(w: World, p: number): void {
  const { m } = w;
  m.plHp[p] = FRAME_STATS[m.plFrame[p]].maxHp;
  m.plInvuln[p] = RESPAWN_INVULN;
  m.plX[p] = m.plPX[p] = w.spawnX(p);
  m.plY[p] = m.plPY[p] = w.spawnY;
  m.plAim[p] = fx.ANGLE_QUARTER;
  cancelBulletsInRadius(w, m.plX[p], m.plY[p], fx.fromInt(90), -1);
  w.emit(Ev.PlayerRespawn, m.plX[p], m.plY[p], p);
}

// ---------------------------------------------------------------------------------------------------
// Boss mode
// ---------------------------------------------------------------------------------------------------

function updateBossMode(w: World, p: number, pressed: number): void {
  const { m } = w;
  if (m.plBoss[p] === 0) {
    if ((pressed & Button.Boss) !== 0 && m.plGauge[p] >= GAUGE_MAX) startBossMode(w, p);
    return;
  }
  m.plBoss[p]--;
  if (m.plTransform[p] > 0 && --m.plTransform[p] === 0) transformPulse(w, p);
  if (m.plBoss[p] <= 0) endBossMode(w, p);
  else m.plGauge[p] = Math.min(GAUGE_MAX, Math.floor((m.plBoss[p] * GAUGE_MAX) / BOSS_MODE_TICKS));
}

function startBossMode(w: World, p: number): void {
  const { m } = w;
  m.plBoss[p] = BOSS_MODE_TICKS + TRANSFORM_TICKS;
  m.plTransform[p] = TRANSFORM_TICKS;
  m.plAltFx[p] = 0;
  m.plAltCd[p] = 0;
  m.plFireCd[p] = 0;
  w.emit(Ev.TransformStart, m.plX[p], m.plY[p], p);
}

/** The instant the transformation completes: a shockwave clears bullets and hurts everything nearby. */
function transformPulse(w: World, p: number): void {
  const { m } = w;
  cancelBulletsInRadius(w, m.plX[p], m.plY[p], BOSS_TRANSFORM_PULSE_R, p);
  pulseDamage(w, p, BOSS_TRANSFORM_PULSE_R);
  w.emit(Ev.TransformDone, m.plX[p], m.plY[p], p);
}

function endBossMode(w: World, p: number): void {
  const { m } = w;
  m.plBoss[p] = 0;
  m.plGauge[p] = 0;
  m.plBeam[p] = 0;
  m.plInvuln[p] = BOSS_REVERT_INVULN;
  cancelBulletsInRadius(w, m.plX[p], m.plY[p], BOSS_REVERT_PULSE_R, p);
  pulseDamage(w, p, BOSS_REVERT_PULSE_R);
  w.emit(Ev.BossModeEnd, m.plX[p], m.plY[p], p);
}

function pulseDamage(w: World, p: number, radius: number): void {
  const { m } = w;
  for (let e = 0; e < MAX_ENEMIES; e++) {
    if (m.eAlive[e] !== 1) continue;
    const reach = radius + m.eRad[e];
    if (fx.len2(m.eX[e] - m.plX[p], m.eY[e] - m.plY[p]) <= reach * reach) damageEnemy(w, e, PULSE_DAMAGE, p);
  }
}

// ---------------------------------------------------------------------------------------------------
// Movement
// ---------------------------------------------------------------------------------------------------

function slowPercent(w: World, p: number): number {
  const { m } = w;
  if (m.plFrame[p] === Frame.Juggernaut && m.plBoss[p] === 0 && m.plAltFx[p] > 0) return JUGGERNAUT.shieldSlowPct;
  if (m.plFrame[p] === Frame.Vanguard && m.plBoss[p] > 0 && m.plBeam[p] === 1) return VANGUARD.beamSlowPct;
  return 100;
}

function move(w: World, p: number, input: GameInput, connected: boolean): void {
  const { m } = w;
  let vx = 0;
  let vy = 0;
  if (m.plTransform[p] > 0) {
    // rooted while the transformation plays out
  } else if (isDashing(w, p)) {
    vx = m.plAltDX[p];
    vy = m.plAltDY[p];
  } else if (connected) {
    let mx = input.moveX;
    let my = input.moveY;
    const sq = mx * mx + my * my;
    if (sq > MOVE_MAX * MOVE_MAX) {
      const len = fx.isqrt(sq);
      mx = Math.floor((mx * MOVE_MAX) / len);
      my = Math.floor((my * MOVE_MAX) / len);
    }
    const stats = FRAME_STATS[m.plFrame[p]];
    const speed = Math.floor(((m.plBoss[p] > 0 ? stats.bossSpeed : stats.speed) * slowPercent(w, p)) / 100);
    vx = Math.floor((speed * mx) / MOVE_MAX);
    vy = Math.floor((speed * my) / MOVE_MAX);
  }
  m.plVX[p] = vx;
  m.plVY[p] = vy;
  m.plX[p] = fx.clamp(m.plX[p] + vx, -ARENA_HALF_W + PLAYER_MARGIN_X, ARENA_HALF_W - PLAYER_MARGIN_X);
  m.plY[p] = fx.clamp(m.plY[p] + vy, -ARENA_HALF_H + PLAYER_MARGIN_Y, ARENA_HALF_H - PLAYER_MARGIN_Y);
}

// ---------------------------------------------------------------------------------------------------
// Weapons
// ---------------------------------------------------------------------------------------------------

function fireWeapons(w: World, p: number, buttons: number, pressed: number, input: GameInput, connected: boolean): void {
  const { m } = w;
  m.plBeam[p] = 0;
  if (m.plTransform[p] > 0) return;
  const fire = (buttons & Button.Fire) !== 0;
  const alt = (buttons & Button.Alt) !== 0;
  const altPressed = (pressed & Button.Alt) !== 0;
  const inBossForm = m.plBoss[p] > 0;
  switch (m.plFrame[p]) {
    case Frame.Vanguard:
      if (inBossForm) paladin(w, p, fire, alt);
      else vanguard(w, p, fire, altPressed);
      break;
    case Frame.Gale:
      if (inBossForm) tempest(w, p, fire, alt);
      else gale(w, p, fire, altPressed, input, connected);
      break;
    default:
      if (inBossForm) fortress(w, p, fire, alt);
      else juggernaut(w, p, fire, altPressed);
      break;
  }
}

function muzzle(w: World, p: number, aim: number, dist: number = MUZZLE): { x: number; y: number } {
  const { m } = w;
  return { x: m.plX[p] + fx.mul(fx.cos(aim), dist), y: m.plY[p] + fx.mul(fx.sin(aim), dist) };
}

function vanguard(w: World, p: number, fire: boolean, altPressed: boolean): void {
  const { m } = w;
  const aim = m.plAim[p];
  if (fire && m.plFireCd[p] === 0) {
    m.plFireCd[p] = VANGUARD.rifleInterval;
    const at = muzzle(w, p, aim);
    spawnShot(w, p, {
      kind: ShotKind.Rifle, x: at.x, y: at.y, ang: aim + w.rng.range(-VANGUARD.rifleJitter, VANGUARD.rifleJitter), spd: VANGUARD.rifleSpeed,
      dmg: VANGUARD.rifleDmg, rad: VANGUARD.rifleRad, life: VANGUARD.rifleLife,
    });
    w.emit(Ev.ShotFired, at.x, at.y, m.plFrame[p]);
  }
  if (altPressed && m.plAltCd[p] === 0) {
    m.plAltCd[p] = VANGUARD.missileCooldown;
    const at = muzzle(w, p, aim);
    const last = VANGUARD.missileCount - 1;
    for (let k = 0; k <= last; k++) {
      spawnShot(w, p, {
        kind: ShotKind.Missile, x: at.x, y: at.y, ang: aim + Math.floor(((2 * k - last) * VANGUARD.missileSpread) / last), spd: VANGUARD.missileSpeed,
        acc: VANGUARD.missileAcc, maxSpd: VANGUARD.missileMaxSpeed, turn: VANGUARD.missileTurn, dmg: VANGUARD.missileDmg, rad: fx.fromInt(3),
        splash: VANGUARD.missileSplash, life: VANGUARD.missileLife,
      });
    }
    w.emit(Ev.MissileLaunch, at.x, at.y, p);
  }
}

function paladin(w: World, p: number, fire: boolean, alt: boolean): void {
  const { m } = w;
  const aim = m.plAim[p];
  if (fire && m.plFireCd[p] === 0) {
    m.plFireCd[p] = VANGUARD.spreadInterval;
    const at = muzzle(w, p, aim, fx.fromInt(20));
    const last = VANGUARD.spreadWays - 1;
    for (let k = 0; k <= last; k++) {
      spawnShot(w, p, {
        kind: ShotKind.Spread, x: at.x, y: at.y, ang: aim + (2 * k - last) * (VANGUARD.spreadStep >> 1), spd: VANGUARD.spreadSpeed, dmg: VANGUARD.spreadDmg,
        rad: fx.fromInt(3), life: VANGUARD.spreadLife, pierce: VANGUARD.spreadPierce,
      });
    }
    w.emit(Ev.ShotFired, at.x, at.y, m.plFrame[p]);
  }
  if (alt) beam(w, p, aim);
}

/** Continuous hitscan: damages enemies along the ray and erases the bullets it crosses. */
function beam(w: World, p: number, aim: number): void {
  const { m } = w;
  m.plBeam[p] = 1;
  const at = muzzle(w, p, aim, fx.fromInt(18));
  const dx = fx.cos(aim);
  const dy = fx.sin(aim);
  for (let e = 0; e < MAX_ENEMIES; e++) {
    if (m.eAlive[e] !== 1) continue;
    const rx = m.eX[e] - at.x;
    const ry = m.eY[e] - at.y;
    const along = fx.mul(rx, dx) + fx.mul(ry, dy);
    const across = Math.abs(fx.mul(rx, dy) - fx.mul(ry, dx));
    if (along >= -m.eRad[e] && along <= VANGUARD.beamLength + m.eRad[e] && across <= VANGUARD.beamHalfWidth + m.eRad[e]) damageEnemy(w, e, VANGUARD.beamDmg, p);
  }
  for (let b = 0; b < MAX_BULLETS; b++) {
    if (m.bAlive[b] !== 1) continue;
    const rx = m.bX[b] - at.x;
    const ry = m.bY[b] - at.y;
    const along = fx.mul(rx, dx) + fx.mul(ry, dy);
    if (along < 0 || along > VANGUARD.beamLength) continue;
    if (Math.abs(fx.mul(rx, dy) - fx.mul(ry, dx)) <= VANGUARD.beamHalfWidth + BULLET_RADIUS[m.bKind[b]]) {
      addScore(w, p, BOSS_ABSORB_SCORE);
      w.freeBullet(b);
    }
  }
}

function twinNeedles(w: World, p: number, aim: number, dmg: number): void {
  const { m } = w;
  const at = muzzle(w, p, aim);
  const px = -fx.sin(aim);
  const py = fx.cos(aim);
  for (const side of [-1, 1]) {
    spawnShot(w, p, {
      kind: ShotKind.Needle, x: at.x + side * fx.mul(px, GALE.needleOffset), y: at.y + side * fx.mul(py, GALE.needleOffset), ang: aim,
      spd: GALE.needleSpeed, dmg, rad: GALE.needleRad, life: GALE.needleLife, pierce: 1,
    });
  }
  w.emit(Ev.ShotFired, at.x, at.y, m.plFrame[p]);
}

function gale(w: World, p: number, fire: boolean, altPressed: boolean, input: GameInput, connected: boolean): void {
  const { m } = w;
  const aim = m.plAim[p];
  if (m.plAltFx[p] > 0) {
    if (--m.plAltFx[p] === 0) {
      const heading = fx.atan2(m.plAltDY[p], m.plAltDX[p]);
      spawnShot(w, p, {
        kind: ShotKind.Slash, x: m.plX[p], y: m.plY[p], ang: heading, spd: GALE.slashSpeed, dmg: GALE.slashDmg, rad: GALE.slashRad, life: GALE.slashLife, pierce: 255,
      });
    }
  }
  if (fire && m.plFireCd[p] === 0 && m.plAltFx[p] === 0) {
    m.plFireCd[p] = GALE.needleInterval;
    twinNeedles(w, p, aim, GALE.needleDmg);
  }
  if (altPressed && m.plAltCd[p] === 0) {
    const moving = connected && (input.moveX !== 0 || input.moveY !== 0);
    const heading = moving ? fx.atan2(input.moveY, input.moveX) : aim;
    m.plAltDX[p] = fx.mul(fx.cos(heading), GALE.dashSpeed);
    m.plAltDY[p] = fx.mul(fx.sin(heading), GALE.dashSpeed);
    m.plAltFx[p] = GALE.dashTicks;
    m.plAltCd[p] = GALE.dashCooldown;
    w.emit(Ev.Dash, m.plX[p], m.plY[p], heading);
  }
}

function tempest(w: World, p: number, fire: boolean, alt: boolean): void {
  const { m } = w;
  const aim = m.plAim[p];
  m.plBits[p] = (m.plBits[p] + GALE.bitTurn) & fx.ANGLE_MASK;
  if (fire && m.plFireCd[p] === 0) {
    m.plFireCd[p] = GALE.tempestInterval;
    twinNeedles(w, p, aim, GALE.tempestDmg);
  }
  if (fire && m.world[W.Tick] % GALE.bitInterval === 0) {
    for (let k = 0; k < GALE.bitCount; k++) {
      const orbit = m.plBits[p] + Math.floor((fx.ANGLE_FULL * k) / GALE.bitCount);
      spawnShot(w, p, {
        kind: ShotKind.Bit, x: m.plX[p] + fx.mul(fx.cos(orbit), GALE.bitOrbit), y: m.plY[p] + fx.mul(fx.sin(orbit), GALE.bitOrbit), ang: aim,
        spd: GALE.bitSpeed, dmg: GALE.bitDmg, rad: fx.lit(1.8), life: GALE.needleLife,
      });
    }
  }
  if (alt && m.plAltCd[p] === 0) {
    m.plAltCd[p] = GALE.stormCooldown;
    for (let k = 0; k < GALE.stormCount; k++) {
      spawnShot(w, p, {
        kind: ShotKind.Blade, x: m.plX[p], y: m.plY[p], ang: aim + Math.floor((fx.ANGLE_FULL * k) / GALE.stormCount), spd: GALE.stormSpeed, dmg: GALE.stormDmg,
        rad: fx.fromInt(4), life: GALE.stormLife, pierce: GALE.stormPierce,
      });
    }
    w.emit(Ev.BladeStorm, m.plX[p], m.plY[p], p);
  }
}

function juggernaut(w: World, p: number, fire: boolean, altPressed: boolean): void {
  const { m } = w;
  const aim = m.plAim[p];
  if (m.plAltFx[p] > 0) m.plAltFx[p]--;
  if (fire && m.plFireCd[p] === 0) {
    m.plFireCd[p] = JUGGERNAUT.shellInterval;
    const at = muzzle(w, p, aim, fx.fromInt(16));
    spawnShot(w, p, {
      kind: ShotKind.Shell, x: at.x, y: at.y, ang: aim, spd: JUGGERNAUT.shellSpeed, dmg: JUGGERNAUT.shellDmg, rad: JUGGERNAUT.shellRad,
      life: JUGGERNAUT.shellLife, splash: JUGGERNAUT.shellSplash,
    });
    w.emit(Ev.ShotFired, at.x, at.y, m.plFrame[p]);
  }
  if (altPressed && m.plAltCd[p] === 0) {
    m.plAltFx[p] = JUGGERNAUT.shieldTicks;
    m.plAltCd[p] = JUGGERNAUT.shieldCooldown;
    w.emit(Ev.ShieldUp, m.plX[p], m.plY[p], p);
  }
}

function fortress(w: World, p: number, fire: boolean, alt: boolean): void {
  const { m } = w;
  const aim = m.plAim[p];
  if (fire && m.plFireCd[p] === 0) {
    m.plFireCd[p] = JUGGERNAUT.fortressInterval;
    const at = muzzle(w, p, aim, fx.fromInt(26));
    const px = -fx.sin(aim);
    const py = fx.cos(aim);
    for (const side of [-1, 1]) {
      spawnShot(w, p, {
        kind: ShotKind.Shell, x: at.x + side * fx.mul(px, JUGGERNAUT.fortressOffset), y: at.y + side * fx.mul(py, JUGGERNAUT.fortressOffset), ang: aim,
        spd: JUGGERNAUT.fortressSpeed, dmg: JUGGERNAUT.fortressDmg, rad: JUGGERNAUT.fortressRad, life: JUGGERNAUT.fortressLife, splash: JUGGERNAUT.fortressSplash,
      });
    }
    w.emit(Ev.ShotFired, at.x, at.y, m.plFrame[p]);
  }
  if (alt && m.plAltCd[p] === 0) {
    m.plAltCd[p] = JUGGERNAUT.rocketCooldown;
    const at = muzzle(w, p, aim, fx.fromInt(20));
    const last = JUGGERNAUT.rocketCount - 1;
    for (let k = 0; k <= last; k++) {
      spawnShot(w, p, {
        kind: ShotKind.Rocket, x: at.x, y: at.y, ang: aim + Math.floor(((2 * k - last) * (JUGGERNAUT.rocketSpread >> 1)) / last), spd: JUGGERNAUT.rocketSpeed,
        acc: JUGGERNAUT.rocketAcc, maxSpd: JUGGERNAUT.rocketMaxSpeed, turn: JUGGERNAUT.rocketTurn, dmg: JUGGERNAUT.rocketDmg, rad: fx.fromInt(3),
        splash: JUGGERNAUT.rocketSplash, life: JUGGERNAUT.rocketLife,
      });
    }
    w.emit(Ev.MissileLaunch, at.x, at.y, p);
  }
}
