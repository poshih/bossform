import { Button, VANGUARD } from '../sim/index.ts';
import { inPrimaryReach, mayFire, type BotSense, type RobotTactics } from './tactics.ts';

/** VANGUARD launches its seekers only at a target this close... */
const SEEKER_RANGE = 300;
/** ...and with this much energy to spare on top of their cost. */
const SEEKER_SPARE_ENERGY = 200;

/** VANGUARD, the versatile hero: rifle in reach, seekers when close with energy to spare. */
export function createVanguardTactics(): RobotTactics {
  return {
    range: 230,
    buttons(sense: BotSense): number {
      let buttons = 0;
      if (inPrimaryReach(sense) && mayFire(sense)) buttons |= Button.Fire;
      if (sense.range < SEEKER_RANGE && sense.w.m.plEnergy[sense.seat] >= VANGUARD.seekers.cost + SEEKER_SPARE_ENERGY) buttons |= Button.Alt;
      return buttons;
    },
    aim: (sense) => sense.aim,
    move: () => null,
  };
}
