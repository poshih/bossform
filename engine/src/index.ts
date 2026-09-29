/**
 * METRONOME: a standalone deterministic lockstep engine.
 *
 * The public surface is deliberately small and game-agnostic: fixed-point math, a checksummable state
 * block, a seeded RNG, the Simulation/InputCodec contracts, the lockstep Session (+ transports, clock,
 * runner), replays, and the determinism audit. It knows nothing about rendering, DOM, or any game.
 */
import * as fx from './fixed.ts';

export { fx };
export { hashBytes, hashCombine, hashEquals, hashToString, hashWords } from './hash.ts';
export type { Hash64 } from './hash.ts';
export { Rng, RNG_STATE_WORDS } from './rng.ts';
export { SimMemory, field } from './memory.ts';
export type { FieldKind, FieldSpec, LayoutSpec, MemoryViews, StateAccess } from './memory.ts';
export {
  MAX_CONFIG_BYTES, MAX_INPUT_DELAY, MAX_SEATS, decodeParams, encodeParams, handshakeHash, validateParams,
} from './sim.ts';
export type { InputCodec, SessionParams, SimFactory, SimInit, Simulation, TickInput } from './sim.ts';
export { NO_PEER, Session, createSession } from './session.ts';
export type { AbortReason, DesyncReport, SessionOptions, SessionStats, SessionStatus, UpdateResult } from './session.ts';
export type { Transport } from './transport.ts';
export { SimulatedNetwork } from './netsim.ts';
export type { NetworkConditions } from './netsim.ts';
export { RelayTransport } from './relay.ts';
export type { RelayOptions, SocketLike } from './relay.ts';
export { LockstepRunner, TickClock } from './clock.ts';
export type { ClockOptions, FrameResult } from './clock.ts';
export { ReplayRecorder, decodeReplay, playReplay } from './replay.ts';
export type { Checkpoint, Replay, ReplayResult } from './replay.ts';
export { auditDeterminism, withTripwires } from './audit.ts';
export type { AuditOptions, AuditReport } from './audit.ts';
export { BROADCAST_PEER, MAX_SEGMENT_TICKS, PacketType, decodePacket, encodeCheck, encodeFrame, encodeLeave, WireError } from './wire.ts';
export type { AckEntry, Packet, Segment } from './wire.ts';
