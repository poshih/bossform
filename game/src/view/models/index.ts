import { Frame, NeutralType } from '../../sim/index.ts';
import { createFortress, createJuggernaut } from './juggernaut.ts';
import { createGale, createTempest } from './gale.ts';
import { createDrone, createSentinel, createWarden } from './neutrals.ts';
import { createPaladin, createVanguard } from './vanguard.ts';
import type { ColossusModel, NeutralModel, RobotModel } from './types.ts';

export type { ColossusModel, ColossusPose, NeutralModel, NeutralPose, PartPose, RobotModel, RobotPose } from './types.ts';

/** The one place models are looked up by the simulation's ids. */
export function createRobot(frame: number): RobotModel {
  switch (frame) {
    case Frame.Vanguard:
      return createVanguard();
    case Frame.Gale:
      return createGale();
    case Frame.Juggernaut:
      return createJuggernaut();
    default:
      throw new RangeError(`no robot model for frame ${frame}`);
  }
}

export function createColossus(frame: number): ColossusModel {
  switch (frame) {
    case Frame.Vanguard:
      return createPaladin();
    case Frame.Gale:
      return createTempest();
    case Frame.Juggernaut:
      return createFortress();
    default:
      throw new RangeError(`no colossus model for frame ${frame}`);
  }
}

export function createNeutral(type: number): NeutralModel {
  switch (type) {
    case NeutralType.Drone:
      return createDrone();
    case NeutralType.Sentinel:
      return createSentinel();
    case NeutralType.Warden:
      return createWarden();
    default:
      throw new RangeError(`no neutral model for type ${type}`);
  }
}
