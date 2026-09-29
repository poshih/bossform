import type { Hash64 } from './hash.ts';

/**
 * Datagram formats. Every packet starts with:
 *   type u8 | sender u16 | handshake.lo u32 | handshake.hi u32
 * All integers are little-endian.
 *
 * FRAME payload:
 *   ackCount u16 |
 *   ackCount x (seat u16 | frontier u32) |
 *   segmentCount u16 |
 *   segmentCount x (seat u16 | start u32 | count u16 | count * inputByteLength bytes)
 *
 * CHECK payload:
 *   tick u32 | hash.lo u32 | hash.hi u32
 *
 * LEAVE payload:
 *   lastTick i32
 *
 * FRAME total size is:
 *   15 + 6 * ackCount + sum(8 + count * inputByteLength)
 * so the ack table alone crosses a 1200-byte MTU at about 198 seats, before any input segments are added.
 *
 * FRAME packets are intentionally peer-independent: one encoded packet can be broadcast to every other peer.
 * Acks report the contiguous-input frontier for every seat owned by some other peer; receivers keep the entries
 * for their own seats and ignore the rest. Segments carry every locally owned seat from the minimum frontier any
 * still-active remote peer has acknowledged, capped by MAX_SEGMENT_TICKS.
 */
export const PacketType = { Frame: 1, Check: 2, Leave: 3 } as const;

/** Destination used by relay-style transports to fan a packet out to every other peer. */
export const BROADCAST_PEER = 0xffff;

/** Redundant ticks per segment. Must cover 2 * MAX_INPUT_DELAY + 2 (how far a peer can lag our acknowledgements); still one MTU. */
export const MAX_SEGMENT_TICKS = 64;

const HEADER_BYTES = 1 + 2 + 4 + 4;
const ACK_BYTES = 2 + 4;
const SEGMENT_HEADER_BYTES = 2 + 4 + 2;

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
  view.setUint16(1, sender, true);
  view.setUint32(3, handshake.lo, true);
  view.setUint32(7, handshake.hi, true);
  return HEADER_BYTES;
}

export function encodeFrame(
  sender: number,
  handshake: Hash64,
  acks: readonly AckEntry[],
  segments: readonly Segment[],
): Uint8Array {
  let size = HEADER_BYTES + 2 + acks.length * ACK_BYTES + 2;
  for (const s of segments) size += SEGMENT_HEADER_BYTES + s.bytes.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let o = writeHeader(view, PacketType.Frame, sender, handshake);
  view.setUint16(o, acks.length, true);
  o += 2;
  for (const a of acks) {
    view.setUint16(o, a.seat, true);
    view.setUint32(o + 2, a.frontier, true);
    o += ACK_BYTES;
  }
  view.setUint16(o, segments.length, true);
  o += 2;
  for (const s of segments) {
    view.setUint16(o, s.seat, true);
    view.setUint32(o + 2, s.start, true);
    view.setUint16(o + 6, s.count, true);
    o += SEGMENT_HEADER_BYTES;
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
  const sender = view.getUint16(1, true);
  const handshake: Hash64 = { lo: view.getUint32(3, true), hi: view.getUint32(7, true) };
  let o = HEADER_BYTES;
  const need = (n: number) => {
    if (o + n > data.length) throw new WireError('truncated packet');
  };
  switch (type) {
    case PacketType.Frame: {
      need(2);
      const ackCount = view.getUint16(o, true);
      o += 2;
      need(ackCount * ACK_BYTES);
      const acks: AckEntry[] = [];
      for (let i = 0; i < ackCount; i++) {
        acks.push({ seat: view.getUint16(o, true), frontier: view.getUint32(o + 2, true) });
        o += ACK_BYTES;
      }
      need(2);
      const segCount = view.getUint16(o, true);
      o += 2;
      const segments: Segment[] = [];
      for (let i = 0; i < segCount; i++) {
        need(SEGMENT_HEADER_BYTES);
        const seat = view.getUint16(o, true);
        const start = view.getUint32(o + 2, true);
        const count = view.getUint16(o + 6, true);
        o += SEGMENT_HEADER_BYTES;
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
