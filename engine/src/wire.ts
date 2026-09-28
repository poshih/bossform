import type { Hash64 } from './hash.ts';

/**
 * Datagram formats. Every packet starts with: type, sender peer id, handshake hash (so a build or parameter
 * mismatch is caught on the very first packet). All integers are little-endian.
 *
 *   FRAME  acks + redundant, unacknowledged inputs for the seats the sender owns
 *   CHECK  state checksum after `tick` completed ticks
 *   LEAVE  graceful departure: the sender's last valid input is for `lastTick`
 */
export const PacketType = { Frame: 1, Check: 2, Leave: 3 } as const;

/** Redundant ticks per segment. Must cover 2 * MAX_INPUT_DELAY + 2 (how far a peer can lag our acknowledgements); still one MTU. */
export const MAX_SEGMENT_TICKS = 64;

const HEADER_BYTES = 1 + 1 + 4 + 4;

export class WireError extends Error {}

export interface AckEntry {
  readonly seat: number;
  /** Receiver holds every input of `seat` for ticks < frontier. */
  readonly frontier: number;
}

export interface Segment {
  readonly seat: number;
  readonly start: number;
  readonly count: number;
  /** count * inputByteLength bytes (a view into the packet). */
  readonly bytes: Uint8Array;
}

export type Packet =
  | { readonly type: typeof PacketType.Frame; readonly sender: number; readonly handshake: Hash64; readonly acks: AckEntry[]; readonly segments: Segment[] }
  | { readonly type: typeof PacketType.Check; readonly sender: number; readonly handshake: Hash64; readonly tick: number; readonly hash: Hash64 }
  | { readonly type: typeof PacketType.Leave; readonly sender: number; readonly handshake: Hash64; readonly lastTick: number };

function writeHeader(view: DataView, type: number, sender: number, handshake: Hash64): number {
  view.setUint8(0, type);
  view.setUint8(1, sender);
  view.setUint32(2, handshake.lo, true);
  view.setUint32(6, handshake.hi, true);
  return HEADER_BYTES;
}

export function encodeFrame(
  sender: number,
  handshake: Hash64,
  acks: readonly AckEntry[],
  segments: readonly Segment[],
): Uint8Array {
  let size = HEADER_BYTES + 1 + acks.length * 5 + 1;
  for (const s of segments) size += 1 + 4 + 1 + s.bytes.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let o = writeHeader(view, PacketType.Frame, sender, handshake);
  view.setUint8(o++, acks.length);
  for (const a of acks) {
    view.setUint8(o++, a.seat);
    view.setUint32(o, a.frontier, true);
    o += 4;
  }
  view.setUint8(o++, segments.length);
  for (const s of segments) {
    view.setUint8(o++, s.seat);
    view.setUint32(o, s.start, true);
    o += 4;
    view.setUint8(o++, s.count);
    out.set(s.bytes, o);
    o += s.bytes.length;
  }
  return out;
}

export function encodeCheck(sender: number, handshake: Hash64, tick: number, hash: Hash64): Uint8Array {
  const out = new Uint8Array(HEADER_BYTES + 12);
  const view = new DataView(out.buffer);
  const o = writeHeader(view, PacketType.Check, sender, handshake);
  view.setUint32(o, tick, true);
  view.setUint32(o + 4, hash.lo, true);
  view.setUint32(o + 8, hash.hi, true);
  return out;
}

export function encodeLeave(sender: number, handshake: Hash64, lastTick: number): Uint8Array {
  const out = new Uint8Array(HEADER_BYTES + 4);
  const view = new DataView(out.buffer);
  const o = writeHeader(view, PacketType.Leave, sender, handshake);
  view.setInt32(o, lastTick, true);
  return out;
}

/** Parses untrusted bytes. Throws WireError on any malformation; never reads out of bounds. */
export function decodePacket(data: Uint8Array, inputByteLength: number): Packet {
  if (data.length < HEADER_BYTES) throw new WireError('short packet');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const type = view.getUint8(0);
  const sender = view.getUint8(1);
  const handshake: Hash64 = { lo: view.getUint32(2, true), hi: view.getUint32(6, true) };
  let o = HEADER_BYTES;
  const need = (n: number) => {
    if (o + n > data.length) throw new WireError('truncated packet');
  };
  switch (type) {
    case PacketType.Frame: {
      need(1);
      const ackCount = view.getUint8(o++);
      need(ackCount * 5);
      const acks: AckEntry[] = [];
      for (let i = 0; i < ackCount; i++) {
        acks.push({ seat: view.getUint8(o), frontier: view.getUint32(o + 1, true) });
        o += 5;
      }
      need(1);
      const segCount = view.getUint8(o++);
      const segments: Segment[] = [];
      for (let i = 0; i < segCount; i++) {
        need(6);
        const seat = view.getUint8(o);
        const start = view.getUint32(o + 1, true);
        const count = view.getUint8(o + 5);
        o += 6;
        if (count > MAX_SEGMENT_TICKS) throw new WireError('segment too long');
        const length = count * inputByteLength;
        need(length);
        segments.push({ seat, start, count, bytes: data.subarray(o, o + length) });
        o += length;
      }
      if (o !== data.length) throw new WireError('trailing bytes');
      return { type, sender, handshake, acks, segments };
    }
    case PacketType.Check: {
      need(12);
      if (o + 12 !== data.length) throw new WireError('trailing bytes');
      return { type, sender, handshake, tick: view.getUint32(o, true), hash: { lo: view.getUint32(o + 4, true), hi: view.getUint32(o + 8, true) } };
    }
    case PacketType.Leave: {
      need(4);
      if (o + 4 !== data.length) throw new WireError('trailing bytes');
      return { type, sender, handshake, lastTick: view.getInt32(o, true) };
    }
    default:
      throw new WireError(`unknown packet type ${type}`);
  }
}
