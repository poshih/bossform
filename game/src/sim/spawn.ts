import { fx } from '@metronome/engine';
import { RESPAWN_CANDIDATES, SPAWN_RING_PCT } from './constants.ts';
import type { Vec } from './geometry.ts';
import { isFighting } from './query.ts';
import type { World } from './world.ts';

function ringRadius(w: World): number {
  return fx.mulDiv(w.arenaR, SPAWN_RING_PCT, 100);
}

/** Point `index` of `count` evenly spaced around the spawn ring. */
function ringPoint(w: World, index: number, count: number, out: Vec): void {
  const angle = Math.floor((fx.ANGLE_FULL * index) / count);
  const radius = ringRadius(w);
  out.x = fx.mul(fx.cos(angle), radius);
  out.y = fx.mul(fx.sin(angle), radius);
}

/** Where a seat starts a round: teammates sit next to each other, everyone faces the centre. */
export function roundStart(w: World, seat: number, out: Vec): number {
  const { m } = w;
  let slot = 0;
  for (let other = 0; other < w.seats; other++) {
    if (m.plTeam[other] < m.plTeam[seat] || (m.plTeam[other] === m.plTeam[seat] && other < seat)) slot++;
  }
  ringPoint(w, slot, w.seats, out);
  return fx.atan2(-out.y, -out.x);
}

/** Respawn point: the spawn-ring position whose nearest hostile ship is farthest away (ties go to the lower point). */
export function respawnPoint(w: World, seat: number, out: Vec): number {
  const { m } = w;
  const at: Vec = { x: 0, y: 0 };
  let best = 0;
  let bestNearest = -1;
  for (let candidate = 0; candidate < RESPAWN_CANDIDATES; candidate++) {
    ringPoint(w, candidate, RESPAWN_CANDIDATES, at);
    let nearest = Infinity;
    for (let other = 0; other < w.seats; other++) {
      if (!isFighting(w, other) || m.plTeam[other] === m.plTeam[seat]) continue;
      nearest = Math.min(nearest, fx.len2(m.plX[other] - at.x, m.plY[other] - at.y));
    }
    if (nearest > bestNearest) {
      bestNearest = nearest;
      best = candidate;
    }
  }
  ringPoint(w, best, RESPAWN_CANDIDATES, out);
  return fx.atan2(-out.y, -out.x);
}
