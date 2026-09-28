import { fx } from '@metronome/engine';
import { ARENA_HALF_H, ARENA_HALF_W } from './sim/index.ts';

// Presentation constants (never read by the simulation).

/** The playfield in world units (1 unit == 1 simulation unit). */
export const PLAY_W = fx.toFloat(ARENA_HALF_W) * 2;
export const PLAY_H = fx.toFloat(ARENA_HALF_H) * 2;

/** Target low-resolution height of the playfield in "16-bit" pixels. */
export const LOWRES_TARGET_H = 360;
export const MAX_DPR = 2;

export const PALETTE = {
  ink: 0x03040a,
  navy: 0x0b1a33,
  cyan: 0x27e1ff,
  magenta: 0xff2e88,
  violet: 0x8b5cff,
  gold: 0xffc34d,
  amber: 0xff8a2a,
  white: 0xf2f8ff,
  steel: 0x5b6b86,
  jade: 0x2fe0a8,
  red: 0xff3b4e,
} as const;
