import { NEUTRAL_DEFS, NeutralType } from '../../sim/index.ts';
import { placeholderNeutral } from './placeholder.ts';
import type { NeutralModel } from './types.ts';

const to = (raw: number): number => raw / 65536;

/** Drone (aimed bursts), Sentinel (rotating spirals), Warden (the big contested prize). */
export function createDrone(): NeutralModel {
  return placeholderNeutral(to(NEUTRAL_DEFS[NeutralType.Drone].rad));
}

export function createSentinel(): NeutralModel {
  return placeholderNeutral(to(NEUTRAL_DEFS[NeutralType.Sentinel].rad));
}

export function createWarden(): NeutralModel {
  return placeholderNeutral(to(NEUTRAL_DEFS[NeutralType.Warden].rad));
}
