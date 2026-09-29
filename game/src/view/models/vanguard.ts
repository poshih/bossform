import { FRAME_STATS, Frame } from '../../sim/index.ts';
import { placeholderColossus, placeholderRobot } from './placeholder.ts';
import type { ColossusModel, RobotModel } from './types.ts';

const to = (raw: number): number => raw / 65536;

/** VANGUARD, the versatile hero, and PALADIN, the colossus it becomes. */
export function createVanguard(): RobotModel {
  return placeholderRobot(to(FRAME_STATS[Frame.Vanguard].bodyR));
}

export function createPaladin(): ColossusModel {
  return placeholderColossus(Frame.Vanguard);
}
