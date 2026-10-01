import { Button, SHOT_DEFS, ShotFlag } from '../sim/index.ts';
import type { World } from '../sim/index.ts';
import { inPrimaryReach, mayFire, to, type BotSense, type RobotTactics } from './tactics.ts';

/** JUGGERNAUT raises its bulwark when more hostile shots than this are within INCOMING_RADIUS. */
const BULWARK_THREAT = 4;
const INCOMING_RADIUS = 90;

/** JUGGERNAUT, the heavy bunker: keeps its distance, mortars in reach, raises the bulwark under fire. */
export function createJuggernautTactics(): RobotTactics {
  return {
    range: 270,
    buttons(sense: BotSense): number {
      let buttons = 0;
      if (inPrimaryReach(sense) && mayFire(sense)) buttons |= Button.Fire;
      if (sense.threatened || incoming(sense.w, sense.seat) > BULWARK_THREAT) buttons |= Button.Alt;
      return buttons;
    },
    aim: (sense) => sense.aim,
    move: () => null,
  };
}

/** Hostile shots that can hurt, within INCOMING_RADIUS of the seat. */
function incoming(w: World, seat: number): number {
  const { m } = w;
  const x = to(m.plX[seat]);
  const y = to(m.plY[seat]);
  let count = 0;
  for (let p = 0; p < w.cap.projectiles; p++) {
    if (m.pAlive[p] !== 1 || m.pTeam[p] === m.plTeam[seat] || (SHOT_DEFS[m.pDef[p]].flags & ShotFlag.Inert) !== 0) continue;
    if (Math.hypot(to(m.pX[p]) - x, to(m.pY[p]) - y) < INCOMING_RADIUS) count++;
  }
  return count;
}
