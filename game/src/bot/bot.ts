import { fx } from '@metronome/engine';
import { ARENA_HALF_H, ARENA_HALF_W, BULLET_RADIUS, Button, EnemyFlag, Frame, GAUGE_MAX, MAX_BULLETS, MAX_ENEMIES, MOVE_MAX, W } from '../sim/index.ts';
import type { GameInput, World } from '../sim/index.ts';

/**
 * A simple autopilot: aims at the most valuable target, keeps its distance, dodges bullets with a potential
 * field, and uses the alt weapon and boss mode. It only READS the world and returns an ordinary input, so it
 * drives headless verification and the title-screen attract demo through exactly the same path as a human.
 */
const DANGER_RADIUS = 78;
const WALL_MARGIN = 34;
const KEEP_AWAY = 82;
const PULL_IN = 150;
const THREAT_FRONT_RADIUS = 60;

interface Vec {
  x: number;
  y: number;
}

function pickTarget(world: World, from: Vec): { x: number; y: number; boss: boolean } | null {
  const { m } = world;
  let best: { x: number; y: number; boss: boolean } | null = null;
  let bestScore = Infinity;
  for (let e = 0; e < MAX_ENEMIES; e++) {
    if (m.eAlive[e] !== 1 || (m.eFlags[e] & EnemyFlag.Dying) !== 0) continue;
    const x = fx.toFloat(m.eX[e]);
    const y = fx.toFloat(m.eY[e]);
    if (Math.abs(x) > fx.toFloat(ARENA_HALF_W) || y > fx.toFloat(ARENA_HALF_H)) continue;
    const isBoss = (m.eFlags[e] & EnemyFlag.Boss) !== 0;
    const score = Math.hypot(x - from.x, y - from.y) - (isBoss ? 60 : 0);
    if (score < bestScore) {
      bestScore = score;
      best = { x, y, boss: isBoss };
    }
  }
  return best;
}

export function botInput(world: World, seat: number): GameInput {
  const { m } = world;
  const pos: Vec = { x: fx.toFloat(m.plX[seat]), y: fx.toFloat(m.plY[seat]) };
  const target = pickTarget(world, pos);
  const aim = target ? fx.fromRadians(Math.atan2(target.y - pos.y, target.x - pos.x)) : fx.ANGLE_QUARTER;

  let fxTotal = 0;
  let fyTotal = 0;
  let threatFront = false;
  let nearest = Infinity;
  const aimX = fx.toFloat(fx.cos(aim));
  const aimY = fx.toFloat(fx.sin(aim));
  for (let b = 0; b < MAX_BULLETS; b++) {
    if (m.bAlive[b] !== 1) continue;
    const bx = fx.toFloat(m.bX[b]);
    const by = fx.toFloat(m.bY[b]);
    const dx = pos.x - bx;
    const dy = pos.y - by;
    const d2 = dx * dx + dy * dy;
    if (d2 > DANGER_RADIUS * DANGER_RADIUS || d2 < 0.01) continue;
    const d = Math.sqrt(d2);
    nearest = Math.min(nearest, d - fx.toFloat(BULLET_RADIUS[m.bKind[b]]));
    const closing = -(dx * fx.toFloat(m.bVX[b]) + dy * fx.toFloat(m.bVY[b]));
    const weight = (closing > 0 ? 2.4 : 1) * (2600 / (d2 + 40));
    fxTotal += (dx / d) * weight;
    fyTotal += (dy / d) * weight;
    if (d < THREAT_FRONT_RADIUS && (-dx * aimX - dy * aimY) / d > 0.3) threatFront = true;
  }
  const halfW = fx.toFloat(ARENA_HALF_W);
  const halfH = fx.toFloat(ARENA_HALF_H);
  fxTotal += (pos.x > halfW - WALL_MARGIN ? -1 : pos.x < -halfW + WALL_MARGIN ? 1 : 0) * 1.8;
  fyTotal += (pos.y > halfH - WALL_MARGIN ? -1 : pos.y < -halfH + WALL_MARGIN ? 1 : 0) * 1.8;
  if (target) {
    const dx = target.x - pos.x;
    const dy = target.y - pos.y;
    const d = Math.hypot(dx, dy) || 1;
    if (d < KEEP_AWAY) {
      fxTotal -= (dx / d) * 0.9;
      fyTotal -= (dy / d) * 0.9;
    } else if (d > PULL_IN) {
      fxTotal += (dx / d) * 0.35;
      fyTotal += (dy / d) * 0.35;
    }
    // Circle the target so the bot never parks in a lane.
    const strafe = (m.world[W.Tick] >> 8) % 2 === 0 ? 1 : -1;
    fxTotal += (-dy / d) * 0.45 * strafe;
    fyTotal += (dx / d) * 0.45 * strafe;
  } else {
    fxTotal -= pos.x * 0.004;
    fyTotal -= (pos.y + 120) * 0.006;
  }

  const mag = Math.hypot(fxTotal, fyTotal);
  const scale = mag > 1 ? 1 / mag : 1;
  const moveX = Math.round(fxTotal * scale * MOVE_MAX);
  const moveY = Math.round(fyTotal * scale * MOVE_MAX);

  const tick = m.world[W.Tick];
  let buttons = 0;
  if (target) buttons |= Button.Fire;
  const frame = m.plFrame[seat];
  const altReady = m.plAltCd[seat] === 0;
  if (altReady && ((frame === Frame.Juggernaut && threatFront) || (frame === Frame.Gale && nearest < 14) || (frame === Frame.Vanguard && target !== null))) {
    if (tick % 2 === 0) buttons |= Button.Alt;
  }
  if (m.plBoss[seat] > 0 && altReady && target) buttons |= Button.Alt;
  if (m.plGauge[seat] >= GAUGE_MAX && m.plBoss[seat] === 0 && tick % 2 === 0) buttons |= Button.Boss;
  return { moveX, moveY, aim, buttons };
}
