import { Button } from '../sim/index.ts';
import { inPrimaryReach, mayFire, type BotSense, type RobotTactics } from './tactics.ts';

/** Chance per threatened tick that GALE dashes out. */
const DASH_CHANCE = 0.15;

/** GALE, the fast striker: brawls close, darts in reach, phase-dashes out of shots about to land. */
export function createGaleTactics(): RobotTactics {
  return {
    range: 170,
    buttons(sense: BotSense): number {
      let buttons = 0;
      if (inPrimaryReach(sense) && mayFire(sense)) buttons |= Button.Fire;
      if (sense.threatened && sense.random() < DASH_CHANCE) buttons |= Button.Alt;
      return buttons;
    },
    aim: (sense) => sense.aim,
    move: () => null,
  };
}
