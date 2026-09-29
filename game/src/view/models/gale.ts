import { FRAME_STATS, Frame } from '../../sim/index.ts';
import { placeholderColossus, placeholderRobot } from './placeholder.ts';
import type { ColossusModel, RobotModel } from './types.ts';

const to = (raw: number): number => raw / 65536;

/** GALE, the fast striker, and TEMPEST, the colossus it becomes. */
export function createGale(): RobotModel {
  return placeholderRobot(to(FRAME_STATS[Frame.Gale].bodyR));
}

export function createTempest(): ColossusModel {
  return placeholderColossus(Frame.Gale);
}
