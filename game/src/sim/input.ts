import { fx } from '@metronome/engine';
import type { InputCodec } from '@metronome/engine';

/** One seat's controls for one tick: analog movement, an independent aim angle, and five buttons. */
export interface GameInput {
  /** -127..127 (right positive). */
  readonly moveX: number;
  /** -127..127 (up positive). */
  readonly moveY: number;
  /** Aim direction as a binary angle (0 = +x, counter-clockwise), decoupled from movement. */
  readonly aim: number;
  readonly buttons: number;
}

/**
 * Fire / Alt: the ship's two weapons (the boss form's salvo and siege shot). Boss: transform. Ultima: the boss form's final
 * attack. Boost: a robot's burst of speed (held, it boosts again whenever the boost is ready).
 */
export const Button = { Fire: 1, Alt: 2, Boss: 4, Ultima: 8, Boost: 16 } as const;
const BUTTON_MASK = Button.Fire | Button.Alt | Button.Boss | Button.Ultima | Button.Boost;
export const MOVE_MAX = 127;

export const NEUTRAL_INPUT: GameInput = Object.freeze({ moveX: 0, moveY: 0, aim: fx.ANGLE_QUARTER, buttons: 0 });

const clampAxis = (v: number) => (v < -MOVE_MAX ? -MOVE_MAX : v);

/** Total decoder: every byte pattern is a valid input (reserved bits ignored, -128 clamps to -127). */
export const gameCodec: InputCodec<GameInput> = {
  byteLength: 5,
  neutral: () => NEUTRAL_INPUT,
  encode(input, out, offset) {
    // Encoding is local (this machine's own input): a value out of range is a programmer error, never wrapped silently.
    for (const axis of [input.moveX, input.moveY]) {
      if (!Number.isInteger(axis) || axis < -MOVE_MAX || axis > MOVE_MAX) throw new RangeError(`movement axis ${axis} is outside -${MOVE_MAX}..${MOVE_MAX}`);
    }
    out[offset] = input.moveX & 0xff;
    out[offset + 1] = input.moveY & 0xff;
    out[offset + 2] = input.aim & 0xff;
    out[offset + 3] = (input.aim >> 8) & 0xff;
    out[offset + 4] = input.buttons & BUTTON_MASK;
  },
  decode(bytes, offset) {
    return {
      moveX: clampAxis((bytes[offset] << 24) >> 24),
      moveY: clampAxis((bytes[offset + 1] << 24) >> 24),
      aim: bytes[offset + 2] | (bytes[offset + 3] << 8),
      buttons: bytes[offset + 4] & BUTTON_MASK,
    };
  },
};
