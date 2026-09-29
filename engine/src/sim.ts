import type { Hash64 } from './hash.ts';
import { hashBytes } from './hash.ts';
import type { StateAccess } from './memory.ts';

/**
 * The only two things the engine asks of a game: a Simulation (state + step) and an InputCodec (the
 * per-seat, per-tick input as fixed-size bytes). Everything else about the game stays on the game's side.
 */

/** Protocol ceiling imposed by the u16 wire format, not a design target for gameplay. */
export const MAX_SEATS = 0xffff;
export const MAX_INPUT_DELAY = 30;
export const MAX_CONFIG_BYTES = 512;

/** Fixed-size wire/replay encoding of one seat's input for one tick. */
export interface InputCodec<I> {
  /** Exact encoded size in bytes. */
  readonly byteLength: number;
  /** The input used for empty or departed seats and for the first `inputDelay` ticks. */
  neutral(): I;
  encode(input: I, out: Uint8Array, offset: number): void;
  /**
   * MUST be total: every byte pattern decodes to a valid input (clamp / mask instead of rejecting), because
   * the bytes come from other machines. It must also be a pure function of the bytes.
   */
  decode(bytes: Uint8Array, offset: number): I;
}

/** What one simulated tick looks like from the simulation's side. */
export interface TickInput<I> {
  /** Index of the tick being simulated (0-based). */
  readonly tick: number;
  /** Input per seat; departed or empty seats hold codec.neutral(). Treat as read-only. */
  readonly inputs: readonly I[];
  /** present[seat] is false once a seat has left (deterministically, at the same tick on every peer). */
  readonly present: readonly boolean[];
}

export interface Simulation<I> {
  /** Everything that influences future ticks must be inside this memory. */
  readonly memory: StateAccess;
  /** Advances exactly one tick. Must be a pure function of (memory, frame). */
  step(frame: TickInput<I>): void;
}

/** Deterministic construction parameters, identical on every peer. */
export interface SimInit {
  readonly seed: number;
  readonly seats: number;
  /** Opaque game configuration (frame picks, difficulty...). */
  readonly config: Uint8Array;
}

export type SimFactory<I> = (init: SimInit) => Simulation<I>;

/** Everything all peers must agree on before tick 0. Its hash is verified during the handshake. */
export interface SessionParams {
  /** Bump when game rules/content change: peers on different versions refuse to play together. */
  readonly simVersion: number;
  readonly seed: number;
  readonly seats: number;
  readonly tickRate: number;
  /** Ticks between sampling a local input and it being simulated. 0 for single machine play. */
  readonly inputDelay: number;
  /** Ticks between state checksum exchanges. */
  readonly checksumInterval: number;
  readonly config: Uint8Array;
}

export function validateParams(p: SessionParams): void {
  const int = (v: number, lo: number, hi: number, name: string) => {
    if (!Number.isInteger(v) || v < lo || v > hi) throw new RangeError(`SessionParams.${name} must be an integer in [${lo}, ${hi}] (got ${v})`);
  };
  int(p.simVersion, 0, 0xffffffff, 'simVersion');
  int(p.seed, 0, 0xffffffff, 'seed');
  int(p.seats, 1, MAX_SEATS, 'seats');
  int(p.tickRate, 1, 240, 'tickRate');
  int(p.inputDelay, 0, MAX_INPUT_DELAY, 'inputDelay');
  int(p.checksumInterval, 1, 3600, 'checksumInterval');
  if (p.config.length > MAX_CONFIG_BYTES) throw new RangeError(`SessionParams.config is limited to ${MAX_CONFIG_BYTES} bytes`);
}

const PARAM_HEADER_BYTES = 4 * 6 + 2;

export function encodeParams(p: SessionParams): Uint8Array {
  const out = new Uint8Array(PARAM_HEADER_BYTES + p.config.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, p.simVersion, true);
  view.setUint32(4, p.seed, true);
  view.setUint32(8, p.seats, true);
  view.setUint32(12, p.tickRate, true);
  view.setUint32(16, p.inputDelay, true);
  view.setUint32(20, p.checksumInterval, true);
  view.setUint16(24, p.config.length, true);
  out.set(p.config, PARAM_HEADER_BYTES);
  return out;
}

export function decodeParams(bytes: Uint8Array): SessionParams {
  if (bytes.length < PARAM_HEADER_BYTES) throw new RangeError('decodeParams: truncated');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const configLength = view.getUint16(24, true);
  if (bytes.length !== PARAM_HEADER_BYTES + configLength) throw new RangeError('decodeParams: length mismatch');
  const params: SessionParams = {
    simVersion: view.getUint32(0, true),
    seed: view.getUint32(4, true),
    seats: view.getUint32(8, true),
    tickRate: view.getUint32(12, true),
    inputDelay: view.getUint32(16, true),
    checksumInterval: view.getUint32(20, true),
    config: bytes.slice(PARAM_HEADER_BYTES),
  };
  validateParams(params);
  return params;
}

/**
 * Handshake fingerprint: parameters + input encoding size + state layout. Two builds that differ in any of
 * these cannot stay in lockstep, so a mismatch aborts the session before tick 0 instead of desyncing later.
 */
export function handshakeHash(params: SessionParams, inputByteLength: number, layout: Hash64): Hash64 {
  const body = encodeParams(params);
  const bytes = new Uint8Array(body.length + 12);
  bytes.set(body);
  const view = new DataView(bytes.buffer);
  view.setUint32(body.length, inputByteLength, true);
  view.setUint32(body.length + 4, layout.lo, true);
  view.setUint32(body.length + 8, layout.hi, true);
  return hashBytes(bytes);
}
