import { createSession, SimulatedNetwork, TickClock } from '@metronome/engine';
import type { NetworkConditions, Session, SessionParams, SimFactory } from '@metronome/engine';
import { scriptedInput, toyCodec, toyFactory } from './toy-sim.ts';
import type { ToyInput } from './toy-sim.ts';

export const FRAME_MS = 1000 / 60;
const NO_CONFIG = new Uint8Array(0);

export function makeParams(seats: number, inputDelay: number, overrides: Partial<SessionParams> = {}): SessionParams {
  return { simVersion: 1, seed: 0xc0ffee, seats, tickRate: 60, inputDelay, checksumInterval: 30, config: NO_CONFIG, ...overrides };
}

export interface PeerSpec {
  /** Replace the simulation factory (tampering, hidden state...). */
  factory?: SimFactory<ToyInput>;
  /** Different parameters for this peer only (mismatch tests). */
  params?: Partial<SessionParams>;
  /** Phase offset of this peer's frame clock, so peers never tick in unison. */
  frameOffsetMs?: number;
}

export interface Rig {
  readonly net: SimulatedNetwork;
  readonly sessions: Session<ToyInput>[];
  readonly clocks: TickClock[];
  readonly specs: PeerSpec[];
  frame: number;
}

export interface RigOptions {
  readonly peers: number;
  readonly conditions: NetworkConditions;
  readonly netSeed?: number;
  readonly inputDelay: number;
  readonly specs?: PeerSpec[];
  readonly checksumInterval?: number;
  readonly onDesync?: (peer: number, tick: number) => void;
}

/** Peer i controls seat i; every peer talks through the same simulated network. */
export function makeRig(o: RigOptions): Rig {
  const net = new SimulatedNetwork(o.conditions, o.netSeed ?? 1);
  const specs = o.specs ?? [];
  const seatOwners = Array.from({ length: o.peers }, (_, i) => i);
  const sessions: Session<ToyInput>[] = [];
  const clocks: TickClock[] = [];
  for (let peer = 0; peer < o.peers; peer++) {
    const spec = specs[peer] ?? {};
    sessions.push(createSession({
      factory: spec.factory ?? toyFactory,
      codec: toyCodec,
      params: makeParams(o.peers, o.inputDelay, { checksumInterval: o.checksumInterval ?? 30, ...spec.params }),
      self: peer,
      seatOwners,
      transport: net.connect(peer),
      sampleInput: scriptedInput,
      recordReplay: true,
      onDesync: (report) => o.onDesync?.(peer, report.tick),
    }));
    clocks.push(new TickClock({ tickRate: 60 }));
  }
  return { net, sessions, clocks, specs, frame: 0 };
}

/** Advances virtual time by one display frame for every peer; no peer simulates past `targetTicks`. */
export function stepRig(rig: Rig, targetTicks: number): void {
  const now = rig.frame * FRAME_MS;
  rig.net.advance(now);
  rig.sessions.forEach((session, i) => {
    const t = now + (rig.specs[i]?.frameOffsetMs ?? 0);
    const due = rig.clocks[i].begin(t);
    const cap = Math.max(0, Math.min(due, targetTicks - session.tick));
    const result = session.update(t, cap);
    rig.clocks[i].end(result.ticks);
  });
  rig.frame++;
}

export function isTerminal(session: Session<ToyInput>): boolean {
  return session.status === 'desynced' || session.status === 'aborted' || session.status === 'left';
}

/** Runs until every peer completed `targetTicks` (or the virtual time budget runs out). */
export function runRig(rig: Rig, targetTicks: number, budgetMs: number): boolean {
  const end = rig.frame + Math.ceil(budgetMs / FRAME_MS);
  while (rig.frame < end) {
    stepRig(rig, targetTicks);
    if (rig.sessions.every((s) => s.tick >= targetTicks || isTerminal(s))) break;
  }
  return rig.sessions.every((s) => s.tick >= targetTicks);
}

/** Ideal reference: the same script on one machine with no network at all. */
export function referenceRun(seats: number, inputDelay: number, targetTicks: number, checksumInterval = 30) {
  const session = createSession({
    factory: toyFactory,
    codec: toyCodec,
    params: makeParams(seats, inputDelay, { checksumInterval }),
    self: 0,
    seatOwners: Array.from({ length: seats }, () => 0),
    sampleInput: scriptedInput,
    recordReplay: true,
  });
  while (session.tick < targetTicks) session.update(0, targetTicks - session.tick);
  return session;
}
