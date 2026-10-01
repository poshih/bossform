import { ROBOT_VISUAL_SCALE } from '../../config.ts';
import { Frame, MUZZLE, NeutralType } from '../../sim/index.ts';
import { toWorld } from '../shared.ts';
import { createGale, createTempest } from './gale.ts';
import { createAtlas, createGauntlet } from './gauntlet.ts';
import { createArmada, createHailstorm } from './hailstorm.ts';
import { createFortress, createJuggernaut } from './juggernaut.ts';
import { createBallista, createLongbow, LONGBOW_MUZZLE_X } from './longbow.ts';
import { createDrone, createSentinel, createWarden } from './neutrals.ts';
import { createHelios, createPrism } from './prism.ts';
import { createRonin, createShogun } from './ronin.ts';
import { createKitsune, createShade } from './shade.ts';
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
    case Frame.Longbow:
      return createLongbow();
    case Frame.Prism:
      return createPrism();
    case Frame.Hailstorm:
      return createHailstorm();
    case Frame.Ronin:
      return createRonin();
    case Frame.Shade:
      return createShade();
    case Frame.Gauntlet:
      return createGauntlet();
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
    case Frame.Longbow:
      return createBallista();
    case Frame.Prism:
      return createHelios();
    case Frame.Hailstorm:
      return createArmada();
    case Frame.Ronin:
      return createShogun();
    case Frame.Shade:
      return createKitsune();
    case Frame.Gauntlet:
      return createAtlas();
    default:
      throw new RangeError(`no colossus model for frame ${frame}`);
  }
}

/**
 * How far along the aim a robot's weapon is drawn, in world units: where its muzzle effects (charge line, glint) belong. It is the
 * simulation's MUZZLE, except for a model whose weapon reaches further (LONGBOW's long rail rifle).
 */
export function drawnMuzzle(frame: number): number {
  return frame === Frame.Longbow ? LONGBOW_MUZZLE_X * ROBOT_VISUAL_SCALE : toWorld(MUZZLE);
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
