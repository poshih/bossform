import type { Hash64 } from './hash.ts';
import { hashEquals } from './hash.ts';
import { ReplayRecorder } from './replay.ts';
import type { InputCodec, SessionParams, SimFactory, Simulation } from './sim.ts';
import { handshakeHash, validateParams } from './sim.ts';
import type { Transport } from './transport.ts';
import { decodePacket, encodeCheck, encodeFrame, encodeLeave, MAX_SEGMENT_TICKS, PacketType, WireError } from './wire.ts';
import type { AckEntry, Packet, Segment } from './wire.ts';

/** seatOwners entry for a seat nobody controls (it receives the neutral input forever). */
export const NO_PEER = -1;

export type SessionStatus = 'connecting' | 'running' | 'desynced' | 'aborted' | 'left';
export type AbortReason = 'peer-timeout' | 'params-mismatch' | 'conflicting-input';

export interface DesyncReport {
  /** Number of completed ticks at which the checksums first disagreed (the divergence is in the last interval). */
  readonly tick: number;
  readonly peer: number;
  readonly local: Hash64;
  readonly remote: Hash64;
}

export interface SessionStats {
  ticks: number;
  stalledUpdates: number;
  packetsIn: number;
  packetsOut: number;
  bytesIn: number;
  bytesOut: number;
  duplicateInputs: number;
  rejectedPackets: number;
  /** Smoothed time between sampling a local input and the peer acknowledging it (upper bound on RTT). */
  rttMs: number;
}

export interface SessionOptions<I> {
  readonly factory: SimFactory<I>;
  readonly codec: InputCodec<I>;
  readonly params: SessionParams;
  /** This machine's peer id (0..255). */
  readonly self: number;
  /** seatOwners[seat] = peer that supplies that seat's input, or NO_PEER for an empty seat. */
  readonly seatOwners: readonly number[];
  /** Omit for single-machine play. */
  readonly transport?: Transport;
  /** Called once for each tick that needs input from a seat this machine owns. Read devices here. */
  readonly sampleInput: (seat: number, tick: number) => I;
  readonly onDesync?: (report: DesyncReport) => void;
  readonly onStatus?: (status: SessionStatus, reason: AbortReason | null) => void;
  /** Called after each simulated tick with the index of the tick that just completed. */
  readonly onTick?: (tick: number) => void;
  readonly recordReplay?: boolean;
  readonly peerTimeoutMs?: number;
  readonly connectTimeoutMs?: number;
  readonly resendIntervalMs?: number;
  readonly keepAliveMs?: number;
}

export interface UpdateResult {
  /** Ticks simulated by this call. */
  readonly ticks: number;
  /** True when a tick was due but some seat's input had not arrived yet. */
  readonly stalled: boolean;
}

const INPUT_WINDOW = 256;
const INPUT_MASK = INPUT_WINDOW - 1;
/** A peer is at most inputDelay+1 ticks ahead of us; anything beyond this is not a legitimate sender. */
const ACCEPT_AHEAD = INPUT_WINDOW >> 1;
const CHECK_HISTORY = 64;
const CHECK_MASK = CHECK_HISTORY - 1;
const NEVER = 0x7fffffff;
const LEAVE_COPIES = 3;
const RTT_SMOOTHING = 0.2;

const DEFAULTS = { peerTimeoutMs: 5000, connectTimeoutMs: 30000, resendIntervalMs: 40, keepAliveMs: 200 } as const;

export class Session<I> {
  readonly params: SessionParams;
  readonly sim: Simulation<I>;
  readonly codec: InputCodec<I>;
  readonly stats: SessionStats = {
    ticks: 0, stalledUpdates: 0, packetsIn: 0, packetsOut: 0, bytesIn: 0, bytesOut: 0, duplicateInputs: 0, rejectedPackets: 0, rttMs: 0,
  };
  readonly localSeats: readonly number[];

  private status_: SessionStatus = 'connecting';
  private abortReason_: AbortReason | null = null;
  private tick_ = 0;
  private now = 0;
  private startedAt = -1;

  private readonly opts: SessionOptions<I>;
  private readonly transport: Transport | null;
  private readonly handshake: Hash64;
  private readonly seats: number;
  private readonly bytesPerInput: number;
  private readonly seatOwners: readonly number[];
  private readonly neutralBytes: Uint8Array;

  // Input storage: per seat a ring of INPUT_WINDOW encoded inputs, tagged with the tick they belong to.
  private readonly ring: Uint8Array;
  private readonly tag: Int32Array;
  /** Remote seat: first tick whose input has not arrived contiguously. Local seat: next tick to sample. */
  private readonly frontier: Int32Array;
  private readonly dropFrom: Int32Array;
  private readonly sentAt: Float64Array;

  // Peers
  private readonly remotePeers: readonly number[];
  private readonly peerSlot: Int16Array;
  private readonly seatsOfPeer: readonly (readonly number[])[];
  /** ackedBy[slot * seats + seat]: how far remote peer `slot` has acknowledged our local seat. */
  private readonly ackedBy: Int32Array;
  private readonly heard: Uint8Array;
  private readonly heardSinceUpdate: Uint8Array;
  private readonly hasLeft: Uint8Array;
  private readonly lastHeardAt: Float64Array;
  private readonly lastSentAt: Float64Array;
  private readonly ackDirty: Uint8Array;
  private inputsDirty = false;

  // Checksums
  private readonly localCheckTick = new Int32Array(CHECK_HISTORY).fill(-1);
  private readonly localCheckHash: Hash64[] = new Array<Hash64>(CHECK_HISTORY);
  private readonly remoteCheckTick: Int32Array;
  private readonly remoteCheckHash: Hash64[];

  private readonly recorder: ReplayRecorder | null;
  private readonly frameBytes: Uint8Array;

  constructor(opts: SessionOptions<I>) {
    validateParams(opts.params);
    const { params, codec } = opts;
    if (opts.seatOwners.length !== params.seats) throw new RangeError('Session: seatOwners must list every seat');
    for (const owner of opts.seatOwners) {
      if (owner !== NO_PEER && !(Number.isInteger(owner) && owner >= 0 && owner < 256)) throw new RangeError(`Session: bad seat owner ${owner}`);
    }
    if (!Number.isInteger(opts.self) || opts.self < 0 || opts.self > 255) throw new RangeError('Session: self must be a peer id in 0..255');

    this.opts = opts;
    this.params = params;
    this.codec = codec;
    this.seats = params.seats;
    this.bytesPerInput = codec.byteLength;
    this.seatOwners = opts.seatOwners;
    this.sim = opts.factory({ seed: params.seed, seats: params.seats, config: params.config });
    this.handshake = handshakeHash(params, codec.byteLength, this.sim.memory.layoutHash);
    this.localSeats = opts.seatOwners.flatMap((owner, seat) => (owner === opts.self ? [seat] : []));

    const remote = [...new Set(opts.seatOwners.filter((o) => o !== NO_PEER && o !== opts.self))].sort((a, b) => a - b);
    this.remotePeers = remote;
    this.transport = opts.transport ?? null;
    if (remote.length > 0 && this.transport === null) throw new RangeError('Session: remote seats need a transport');
    if (remote.length > 0 && this.localSeats.length === 0) throw new RangeError('Session: this peer owns no seat');
    this.peerSlot = new Int16Array(256).fill(-1);
    remote.forEach((peer, slot) => { this.peerSlot[peer] = slot; });
    this.seatsOfPeer = remote.map((peer) => opts.seatOwners.flatMap((o, seat) => (o === peer ? [seat] : [])));
    const peerCount = remote.length;
    this.ackedBy = new Int32Array(Math.max(1, peerCount) * this.seats);
    this.heard = new Uint8Array(peerCount);
    this.heardSinceUpdate = new Uint8Array(peerCount);
    this.hasLeft = new Uint8Array(peerCount);
    this.lastHeardAt = new Float64Array(peerCount);
    this.lastSentAt = new Float64Array(peerCount).fill(-Infinity);
    this.ackDirty = new Uint8Array(peerCount);
    this.remoteCheckTick = new Int32Array(Math.max(1, peerCount) * CHECK_HISTORY).fill(-1);
    this.remoteCheckHash = new Array<Hash64>(Math.max(1, peerCount) * CHECK_HISTORY);

    this.neutralBytes = new Uint8Array(this.bytesPerInput);
    codec.encode(codec.neutral(), this.neutralBytes, 0);
    this.ring = new Uint8Array(this.seats * INPUT_WINDOW * this.bytesPerInput);
    this.tag = new Int32Array(this.seats * INPUT_WINDOW).fill(-1);
    this.frontier = new Int32Array(this.seats);
    this.dropFrom = new Int32Array(this.seats).fill(NEVER);
    this.sentAt = new Float64Array(this.seats * INPUT_WINDOW);
    this.frameBytes = new Uint8Array(this.seats * this.bytesPerInput);

    // The first inputDelay ticks have no sampled input anywhere: they are neutral by definition.
    const delay = params.inputDelay;
    for (let seat = 0; seat < this.seats; seat++) {
      for (let t = 0; t < delay; t++) {
        const slot = seat * INPUT_WINDOW + (t & INPUT_MASK);
        this.ring.set(this.neutralBytes, slot * this.bytesPerInput);
        this.tag[slot] = t;
      }
      this.frontier[seat] = delay;
    }
    for (let slot = 0; slot < peerCount; slot++) for (let seat = 0; seat < this.seats; seat++) this.ackedBy[slot * this.seats + seat] = delay;

    this.recorder = opts.recordReplay ? new ReplayRecorder(params, codec.byteLength) : null;
    this.transport?.setReceiver((peer, data) => this.receive(peer, data));
    if (remote.length === 0) this.status_ = 'running';
  }

  get status(): SessionStatus {
    return this.status_;
  }

  get abortReason(): AbortReason | null {
    return this.abortReason_;
  }

  /** Number of ticks simulated so far == index of the next tick. */
  get tick(): number {
    return this.tick_;
  }

  /** Number of remote peers; 0 means a single-machine session. */
  get remotePeerCount(): number {
    return this.remotePeers.length;
  }

  /** Peer ids that have not been heard from yet (empty once running). */
  get missingPeers(): number[] {
    return this.remotePeers.filter((_, slot) => this.heard[slot] === 0);
  }

  private get terminal(): boolean {
    return this.status_ === 'desynced' || this.status_ === 'aborted' || this.status_ === 'left';
  }

  /**
   * Drives the session. Call once per rendered frame with a monotonic clock. Simulates up to `maxTicks`
   * ticks, fewer if a seat's input has not arrived (lockstep stalls rather than guessing).
   */
  update(nowMs: number, maxTicks: number): UpdateResult {
    this.now = nowMs;
    if (this.startedAt < 0) {
      this.startedAt = nowMs;
      this.lastHeardAt.fill(nowMs);
    }
    if (this.terminal) return { ticks: 0, stalled: false };
    for (let slot = 0; slot < this.remotePeers.length; slot++) {
      if (this.heardSinceUpdate[slot] !== 0) {
        this.lastHeardAt[slot] = nowMs;
        this.heardSinceUpdate[slot] = 0;
      }
    }
    this.checkTimeouts();
    if (this.terminal) return { ticks: 0, stalled: false };

    if (this.status_ === 'connecting') {
      if (this.heard.every((h) => h !== 0)) this.setStatus('running', null);
      else {
        this.flush();
        return { ticks: 0, stalled: true };
      }
    }

    this.fillLocalInputs();
    let ran = 0;
    let stalled = false;
    while (ran < maxTicks && this.status_ === 'running') {
      if (!this.hasAllInputs(this.tick_)) {
        stalled = true;
        break;
      }
      this.stepOnce();
      ran++;
      this.fillLocalInputs();
    }
    if (stalled) this.stats.stalledUpdates++;
    this.flush();
    return { ticks: ran, stalled };
  }

  /** Graceful departure: peers treat this machine's seats as empty after the last input already sent. */
  leave(): void {
    if (this.terminal) return;
    const lastTick = Math.max(-1, ...this.localSeats.map((seat) => this.frontier[seat] - 1));
    for (let copy = 0; copy < LEAVE_COPIES; copy++) {
      for (const peer of this.remotePeers) this.send(peer, encodeLeave(this.opts.self, this.handshake, lastTick));
    }
    this.setStatus('left', null);
  }

  close(): void {
    this.transport?.setReceiver(null);
    this.transport?.close();
  }

  /** Recorded inputs and checkpoints so far (requires recordReplay). */
  exportReplay(): Uint8Array {
    if (this.recorder === null) throw new Error('Session: recordReplay was not enabled');
    return this.recorder.finish();
  }

  // ---------------------------------------------------------------------------------------------------
  // Simulation
  // ---------------------------------------------------------------------------------------------------

  private hasAllInputs(t: number): boolean {
    for (let seat = 0; seat < this.seats; seat++) {
      if (this.seatOwners[seat] === NO_PEER || t >= this.dropFrom[seat]) continue;
      if (this.tag[seat * INPUT_WINDOW + (t & INPUT_MASK)] !== t) return false;
    }
    return true;
  }

  private fillLocalInputs(): void {
    const horizon = this.tick_ + this.params.inputDelay;
    for (const seat of this.localSeats) {
      while (this.frontier[seat] <= horizon) {
        const t = this.frontier[seat];
        const slot = seat * INPUT_WINDOW + (t & INPUT_MASK);
        this.codec.encode(this.opts.sampleInput(seat, t), this.ring, slot * this.bytesPerInput);
        this.tag[slot] = t;
        this.sentAt[slot] = this.now;
        this.frontier[seat] = t + 1;
        this.inputsDirty = true;
      }
    }
  }

  private stepOnce(): void {
    const t = this.tick_;
    const B = this.bytesPerInput;
    const inputs: I[] = new Array<I>(this.seats);
    const present: boolean[] = new Array<boolean>(this.seats);
    let mask = 0;
    for (let seat = 0; seat < this.seats; seat++) {
      const isPresent = this.seatOwners[seat] !== NO_PEER && t < this.dropFrom[seat];
      present[seat] = isPresent;
      if (isPresent) {
        const at = (seat * INPUT_WINDOW + (t & INPUT_MASK)) * B;
        inputs[seat] = this.codec.decode(this.ring, at);
        this.frameBytes.set(this.ring.subarray(at, at + B), seat * B);
        mask |= 1 << seat;
      } else {
        inputs[seat] = this.codec.neutral();
        this.frameBytes.set(this.neutralBytes, seat * B);
      }
    }
    this.sim.step({ tick: t, inputs, present });
    this.tick_ = t + 1;
    this.stats.ticks++;
    this.recorder?.pushTick(mask, this.frameBytes);
    if (this.tick_ % this.params.checksumInterval === 0) this.checksum();
    this.opts.onTick?.(t);
  }

  // ---------------------------------------------------------------------------------------------------
  // Desync detection
  // ---------------------------------------------------------------------------------------------------

  private checksum(): void {
    const tick = this.tick_;
    const hash = this.sim.memory.hash();
    this.localCheckTick[tick & CHECK_MASK] = tick;
    this.localCheckHash[tick & CHECK_MASK] = hash;
    this.recorder?.pushCheckpoint(tick, hash);
    for (let slot = 0; slot < this.remotePeers.length; slot++) {
      this.send(this.remotePeers[slot], encodeCheck(this.opts.self, this.handshake, tick, hash));
      const at = slot * CHECK_HISTORY + (tick & CHECK_MASK);
      if (this.remoteCheckTick[at] === tick) this.compareChecks(this.remotePeers[slot], tick, hash, this.remoteCheckHash[at]);
      if (this.terminal) return;
    }
  }

  private compareChecks(peer: number, tick: number, local: Hash64, remote: Hash64): void {
    if (hashEquals(local, remote)) return;
    this.setStatus('desynced', null);
    this.opts.onDesync?.({ tick, peer, local, remote });
  }

  // ---------------------------------------------------------------------------------------------------
  // Networking
  // ---------------------------------------------------------------------------------------------------

  private receive(peer: number, data: Uint8Array): void {
    if (this.terminal) return;
    const slot = peer >= 0 && peer < 256 ? this.peerSlot[peer] : -1;
    if (slot < 0) {
      this.stats.rejectedPackets++;
      return;
    }
    let packet: Packet;
    try {
      packet = decodePacket(data, this.bytesPerInput);
    } catch (error) {
      if (error instanceof WireError) {
        this.stats.rejectedPackets++;
        return;
      }
      throw error;
    }
    if (packet.sender !== peer) {
      this.stats.rejectedPackets++;
      return;
    }
    if (!hashEquals(packet.handshake, this.handshake)) {
      this.abort('params-mismatch');
      return;
    }
    this.stats.packetsIn++;
    this.stats.bytesIn += data.length;
    this.heard[slot] = 1;
    this.heardSinceUpdate[slot] = 1;

    switch (packet.type) {
      case PacketType.Frame:
        this.onFrame(peer, slot, packet.acks, packet.segments);
        break;
      case PacketType.Check: {
        const at = slot * CHECK_HISTORY + (packet.tick & CHECK_MASK);
        const mine = packet.tick & CHECK_MASK;
        if (this.localCheckTick[mine] === packet.tick) this.compareChecks(peer, packet.tick, this.localCheckHash[mine], packet.hash);
        else if (packet.tick > this.tick_) {
          this.remoteCheckTick[at] = packet.tick;
          this.remoteCheckHash[at] = packet.hash;
        }
        break;
      }
      case PacketType.Leave: {
        this.hasLeft[slot] = 1;
        for (const seat of this.seatsOfPeer[slot]) this.dropFrom[seat] = Math.min(this.dropFrom[seat], packet.lastTick + 1);
        break;
      }
    }
  }

  private onFrame(peer: number, slot: number, acks: readonly AckEntry[], segments: readonly Segment[]): void {
    for (const ack of acks) {
      if (ack.seat >= this.seats || this.seatOwners[ack.seat] !== this.opts.self) continue;
      const at = slot * this.seats + ack.seat;
      const acknowledged = Math.min(ack.frontier, this.frontier[ack.seat]);
      if (acknowledged > this.ackedBy[at]) {
        this.ackedBy[at] = acknowledged;
        const sample = this.now - this.sentAt[ack.seat * INPUT_WINDOW + ((acknowledged - 1) & INPUT_MASK)];
        if (acknowledged > this.params.inputDelay && sample >= 0) {
          this.stats.rttMs = this.stats.rttMs === 0 ? sample : this.stats.rttMs + (sample - this.stats.rttMs) * RTT_SMOOTHING;
        }
      }
    }
    for (const seg of segments) {
      // A peer may only supply inputs for seats it owns; anything else is spoofing or a bug.
      if (seg.seat >= this.seats || this.seatOwners[seg.seat] !== peer) {
        this.stats.rejectedPackets++;
        continue;
      }
      if (!this.storeRemote(seg)) return;
    }
    this.ackDirty[slot] = 1;
  }

  private storeRemote(seg: Segment): boolean {
    const B = this.bytesPerInput;
    for (let i = 0; i < seg.count; i++) {
      const t = seg.start + i;
      if (t < this.tick_) continue;
      if (t >= this.tick_ + ACCEPT_AHEAD) {
        this.stats.rejectedPackets++;
        return true;
      }
      const slot = seg.seat * INPUT_WINDOW + (t & INPUT_MASK);
      const at = slot * B;
      if (this.tag[slot] === t) {
        for (let k = 0; k < B; k++) {
          if (this.ring[at + k] !== seg.bytes[i * B + k]) {
            this.abort('conflicting-input');
            return false;
          }
        }
        this.stats.duplicateInputs++;
      } else {
        this.ring.set(seg.bytes.subarray(i * B, (i + 1) * B), at);
        this.tag[slot] = t;
      }
    }
    let f = this.frontier[seg.seat];
    while (this.tag[seg.seat * INPUT_WINDOW + (f & INPUT_MASK)] === f) f++;
    this.frontier[seg.seat] = f;
    return true;
  }

  private flush(): void {
    for (let slot = 0; slot < this.remotePeers.length; slot++) {
      if (this.hasLeft[slot] !== 0) continue;
      const sinceSent = this.now - this.lastSentAt[slot];
      const due =
        this.inputsDirty ||
        this.ackDirty[slot] !== 0 ||
        sinceSent >= (this.opts.keepAliveMs ?? DEFAULTS.keepAliveMs) ||
        (this.hasUnacknowledged(slot) && sinceSent >= (this.opts.resendIntervalMs ?? DEFAULTS.resendIntervalMs));
      if (!due) continue;
      this.sendFrame(slot);
      this.lastSentAt[slot] = this.now;
      this.ackDirty[slot] = 0;
    }
    this.inputsDirty = false;
  }

  private hasUnacknowledged(slot: number): boolean {
    for (const seat of this.localSeats) if (this.ackedBy[slot * this.seats + seat] < this.frontier[seat]) return true;
    return false;
  }

  private sendFrame(slot: number): void {
    const B = this.bytesPerInput;
    const acks: AckEntry[] = this.seatsOfPeer[slot].map((seat) => ({ seat, frontier: this.frontier[seat] }));
    const segments: Segment[] = [];
    for (const seat of this.localSeats) {
      const head = this.frontier[seat];
      const start = Math.max(this.ackedBy[slot * this.seats + seat], head - MAX_SEGMENT_TICKS);
      const count = head - start;
      if (count <= 0) continue;
      const bytes = new Uint8Array(count * B);
      for (let i = 0; i < count; i++) {
        const at = (seat * INPUT_WINDOW + ((start + i) & INPUT_MASK)) * B;
        bytes.set(this.ring.subarray(at, at + B), i * B);
      }
      segments.push({ seat, start, count, bytes });
    }
    this.send(this.remotePeers[slot], encodeFrame(this.opts.self, this.handshake, acks, segments));
  }

  private send(peer: number, data: Uint8Array): void {
    this.stats.packetsOut++;
    this.stats.bytesOut += data.length;
    this.transport?.send(peer, data);
  }

  private checkTimeouts(): void {
    const peerTimeout = this.opts.peerTimeoutMs ?? DEFAULTS.peerTimeoutMs;
    const connectTimeout = this.opts.connectTimeoutMs ?? DEFAULTS.connectTimeoutMs;
    for (let slot = 0; slot < this.remotePeers.length; slot++) {
      if (this.hasLeft[slot] !== 0) continue;
      const silent = this.heard[slot] === 0 ? this.now - this.startedAt > connectTimeout : this.now - this.lastHeardAt[slot] > peerTimeout;
      if (silent) {
        this.abort('peer-timeout');
        return;
      }
    }
  }

  private abort(reason: AbortReason): void {
    this.abortReason_ = reason;
    this.setStatus('aborted', reason);
  }

  private setStatus(next: SessionStatus, reason: AbortReason | null): void {
    if (this.status_ === next) return;
    this.status_ = next;
    this.opts.onStatus?.(next, reason);
  }
}

export function createSession<I>(opts: SessionOptions<I>): Session<I> {
  return new Session(opts);
}
