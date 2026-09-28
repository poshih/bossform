import type { Hash64 } from './hash.ts';
import { hashEquals } from './hash.ts';
import type { InputCodec, SessionParams, SimFactory, Simulation } from './sim.ts';
import { decodeParams, encodeParams } from './sim.ts';

/**
 * Replays fall out of determinism: (parameters + the per-tick inputs) reproduce a match exactly. The
 * recorder also stores the state checksums the live session computed, so playback can prove it is still
 * following the recorded timeline and report the first tick where it stops doing so.
 *
 * Layout: "MRPL" | version | params length u16 | params | inputBytes u8 | tickCount u32 |
 *         tickCount x ( presentMask u8 | seats x inputBytes ) | checkpointCount u32 | checkpointCount x (tick, lo, hi)
 */
const MAGIC = [0x4d, 0x52, 0x50, 0x4c];
const VERSION = 1;

export interface Checkpoint {
  readonly tick: number;
  readonly hash: Hash64;
}

export interface Replay {
  readonly params: SessionParams;
  readonly inputByteLength: number;
  readonly tickCount: number;
  /** tickCount records of (1 + seats * inputByteLength) bytes. */
  readonly records: Uint8Array;
  readonly checkpoints: readonly Checkpoint[];
}

export class ReplayRecorder {
  private readonly params: SessionParams;
  private readonly inputByteLength: number;
  private readonly recordBytes: number;
  private buffer: Uint8Array;
  private ticks = 0;
  private readonly checkpoints: Checkpoint[] = [];

  constructor(params: SessionParams, inputByteLength: number) {
    this.params = params;
    this.inputByteLength = inputByteLength;
    this.recordBytes = 1 + params.seats * inputByteLength;
    this.buffer = new Uint8Array(this.recordBytes * 1024);
  }

  get tickCount(): number {
    return this.ticks;
  }

  /** `seatBytes` holds seats * inputByteLength encoded inputs for the tick just simulated. */
  pushTick(presentMask: number, seatBytes: Uint8Array): void {
    const at = this.ticks * this.recordBytes;
    if (at + this.recordBytes > this.buffer.length) {
      const grown = new Uint8Array(this.buffer.length * 2);
      grown.set(this.buffer);
      this.buffer = grown;
    }
    this.buffer[at] = presentMask;
    this.buffer.set(seatBytes, at + 1);
    this.ticks++;
  }

  pushCheckpoint(tick: number, hash: Hash64): void {
    this.checkpoints.push({ tick, hash });
  }

  finish(): Uint8Array {
    const params = encodeParams(this.params);
    const header = 4 + 1 + 2 + params.length + 1 + 4;
    const body = this.ticks * this.recordBytes;
    const out = new Uint8Array(header + body + 4 + this.checkpoints.length * 12);
    const view = new DataView(out.buffer);
    out.set(MAGIC, 0);
    view.setUint8(4, VERSION);
    view.setUint16(5, params.length, true);
    out.set(params, 7);
    let o = 7 + params.length;
    view.setUint8(o++, this.inputByteLength);
    view.setUint32(o, this.ticks, true);
    o += 4;
    out.set(this.buffer.subarray(0, body), o);
    o += body;
    view.setUint32(o, this.checkpoints.length, true);
    o += 4;
    for (const c of this.checkpoints) {
      view.setUint32(o, c.tick, true);
      view.setUint32(o + 4, c.hash.lo, true);
      view.setUint32(o + 8, c.hash.hi, true);
      o += 12;
    }
    return out;
  }
}

export function decodeReplay(bytes: Uint8Array): Replay {
  if (bytes.length < 12 || MAGIC.some((m, i) => bytes[i] !== m)) throw new RangeError('replay: bad magic');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(4) !== VERSION) throw new RangeError(`replay: unsupported version ${view.getUint8(4)}`);
  const paramsLength = view.getUint16(5, true);
  const params = decodeParams(bytes.subarray(7, 7 + paramsLength));
  let o = 7 + paramsLength;
  const inputByteLength = view.getUint8(o++);
  const tickCount = view.getUint32(o, true);
  o += 4;
  const recordBytes = 1 + params.seats * inputByteLength;
  const body = tickCount * recordBytes;
  if (o + body + 4 > bytes.length) throw new RangeError('replay: truncated');
  const records = bytes.subarray(o, o + body);
  o += body;
  const checkpointCount = view.getUint32(o, true);
  o += 4;
  if (o + checkpointCount * 12 !== bytes.length) throw new RangeError('replay: bad checkpoint table');
  const checkpoints: Checkpoint[] = [];
  for (let i = 0; i < checkpointCount; i++) {
    checkpoints.push({ tick: view.getUint32(o, true), hash: { lo: view.getUint32(o + 4, true), hi: view.getUint32(o + 8, true) } });
    o += 12;
  }
  return { params, inputByteLength, tickCount, records, checkpoints };
}

export interface ReplayResult {
  readonly ok: boolean;
  readonly ticks: number;
  readonly finalHash: Hash64;
  /** First recorded checkpoint the playback failed to reproduce. */
  readonly mismatch: { readonly tick: number; readonly expected: Hash64; readonly actual: Hash64 } | null;
}

/** Plays a replay to the end on a freshly built simulation, verifying every recorded checkpoint. */
export function playReplay<I>(
  replay: Replay,
  factory: SimFactory<I>,
  codec: InputCodec<I>,
  onTick?: (tick: number, sim: Simulation<I>) => void,
): ReplayResult {
  if (codec.byteLength !== replay.inputByteLength) throw new RangeError('replay: input codec size differs from the recording');
  const { params } = replay;
  const sim = factory({ seed: params.seed, seats: params.seats, config: params.config });
  const recordBytes = 1 + params.seats * replay.inputByteLength;
  let nextCheckpoint = 0;
  let mismatch: ReplayResult['mismatch'] = null;
  for (let tick = 0; tick < replay.tickCount; tick++) {
    const at = tick * recordBytes;
    const mask = replay.records[at];
    const inputs: I[] = [];
    const present: boolean[] = [];
    for (let seat = 0; seat < params.seats; seat++) {
      inputs.push(codec.decode(replay.records, at + 1 + seat * replay.inputByteLength));
      present.push((mask & (1 << seat)) !== 0);
    }
    sim.step({ tick, inputs, present });
    onTick?.(tick, sim);
    const done = tick + 1;
    while (nextCheckpoint < replay.checkpoints.length && replay.checkpoints[nextCheckpoint].tick === done) {
      const expected = replay.checkpoints[nextCheckpoint].hash;
      const actual = sim.memory.hash();
      if (mismatch === null && !hashEquals(expected, actual)) mismatch = { tick: done, expected, actual };
      nextCheckpoint++;
    }
  }
  return { ok: mismatch === null, ticks: replay.tickCount, finalHash: sim.memory.hash(), mismatch };
}
