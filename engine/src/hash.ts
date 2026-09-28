/**
 * 64-bit state checksums (two independent 32-bit MurmurHash3-style lanes). Not cryptographic: the goal is to
 * make an accidental divergence between peers practically undetectable-by-chance (2^-64), cheaply.
 */

export interface Hash64 {
  readonly lo: number;
  readonly hi: number;
}

const LANE_A = { seed: 0x9747b28c, c1: 0xcc9e2d51, c2: 0x1b873593 } as const;
const LANE_B = { seed: 0x2545f491, c1: 0x85ebca6b, c2: 0xc2b2ae35 } as const;

const IS_LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
if (!IS_LITTLE_ENDIAN) throw new Error('metronome: big-endian platforms are not supported (state bytes would differ between peers)');

function lane(words: Int32Array, count: number, seed: number, c1: number, c2: number): number {
  let h = seed | 0;
  for (let i = 0; i < count; i++) {
    let k = Math.imul(words[i], c1);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, c2);
    h ^= k;
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }
  return h;
}

function finalize(h: number, byteLength: number): number {
  h ^= byteLength;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Hashes 32-bit words (fast path used for simulation memory). */
export function hashWords(words: Int32Array): Hash64 {
  const n = words.length;
  const byteLength = n * 4;
  return {
    lo: finalize(lane(words, n, LANE_A.seed, LANE_A.c1, LANE_A.c2), byteLength),
    hi: finalize(lane(words, n, LANE_B.seed, LANE_B.c1, LANE_B.c2), byteLength),
  };
}

/** Hashes arbitrary bytes (any length, any alignment). Trailing bytes are zero-padded into a final word. */
export function hashBytes(bytes: Uint8Array): Hash64 {
  const fullWords = bytes.length >> 2;
  const words = new Int32Array(fullWords + 1);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < fullWords; i++) words[i] = view.getInt32(i * 4, true);
  let tail = 0;
  for (let i = fullWords * 4, shift = 0; i < bytes.length; i++, shift += 8) tail |= bytes[i] << shift;
  words[fullWords] = tail;
  const byteLength = bytes.length;
  return {
    lo: finalize(lane(words, words.length, LANE_A.seed, LANE_A.c1, LANE_A.c2), byteLength),
    hi: finalize(lane(words, words.length, LANE_B.seed, LANE_B.c1, LANE_B.c2), byteLength),
  };
}

export function hashEquals(a: Hash64, b: Hash64): boolean {
  return a.lo === b.lo && a.hi === b.hi;
}

export function hashToString(h: Hash64): string {
  return h.hi.toString(16).padStart(8, '0') + h.lo.toString(16).padStart(8, '0');
}

/** Order-sensitive combination of checksums (used to fingerprint long runs compactly). */
export function hashCombine(acc: Hash64, next: Hash64): Hash64 {
  const words = new Int32Array([acc.lo | 0, acc.hi | 0, next.lo | 0, next.hi | 0]);
  return hashWords(words);
}
