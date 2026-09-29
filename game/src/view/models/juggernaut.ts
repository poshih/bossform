import { FRAME_STATS, Frame } from '../../sim/index.ts';
import { placeholderColossus, placeholderRobot } from './placeholder.ts';
import type { ColossusModel, RobotModel } from './types.ts';

const to = (raw: number): number => raw / 65536;

/** JUGGERNAUT, the heavy bunker, and FORTRESS, the colossus it becomes. */
export function createJuggernaut(): RobotModel {
  return placeholderRobot(to(FRAME_STATS[Frame.Juggernaut].bodyR));
}

export function createFortress(): ColossusModel {
  return placeholderColossus(Frame.Juggernaut);
}
