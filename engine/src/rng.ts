/**
 * xoshiro128** pseudo random generator over a 4-word state that lives in caller-provided memory (normally
 * SimMemory), so the generator is snapshotted, restored and hashed together with the rest of the simulation.
 */
export const RNG_STATE_WORDS = 4;

function rotl(x: number, k: number): number {
  return (x << k) | (x >>> (32 - k));
}

/** SplitMix32 step: expands one 32-bit seed into well-mixed words. Returns the next state and output. */
function splitMix32(state: number): { state: number; out: number } {
  const s = (state + 0x9e3779b9) | 0;
  let z = s ^ (s >>> 16);
  z = Math.imul(z, 0x21f0aaad);
  z ^= z >>> 15;
  z = Math.imul(z, 0x735a2d97);
  z ^= z >>> 15;
  return { state: s, out: z >>> 0 };
}

const TWO_POW_32 = 4294967296;

export class Rng {
  readonly state: Uint32Array;

  constructor(state: Uint32Array) {
    if (state.length !== RNG_STATE_WORDS) throw new RangeError(`Rng needs a Uint32Array of ${RNG_STATE_WORDS} words`);
    this.state = state;
  }

  /** Seeds the generator. `stream` derives independent sequences from the same seed. */
  seed(seed: number, stream = 0): void {
    let s = (seed ^ Math.imul(stream + 1, 0x85ebca6b)) | 0;
    let any = 0;
    for (let i = 0; i < RNG_STATE_WORDS; i++) {
      const step = splitMix32(s);
      s = step.state;
      this.state[i] = step.out;
      any |= step.out;
    }
    if (any === 0) this.state[0] = 1;
  }

  /** Uniform 32-bit unsigned integer. */
  nextU32(): number {
    const s = this.state;
    const result = Math.imul(rotl(Math.imul(s[1], 5), 7), 9) >>> 0;
    const t = s[1] << 9;
    s[2] ^= s[0];
    s[3] ^= s[1];
    s[1] ^= s[2];
    s[0] ^= s[3];
    s[2] ^= t;
    s[3] = rotl(s[3], 11);
    return result;
  }

  /** Uniform integer in [0, n) for 1 <= n <= 2^21 (multiply-shift; bias < 2^-11 relative for the largest n). */
  int(n: number): number {
    return Math.floor((this.nextU32() * n) / TWO_POW_32);
  }

  /** Uniform integer in [lo, hi] inclusive. */
  range(lo: number, hi: number): number {
    return lo + this.int(hi - lo + 1);
  }

  /** True with probability numerator/denominator. */
  chance(numerator: number, denominator: number): boolean {
    return this.int(denominator) < numerator;
  }

  /** -1 or +1. */
  sign(): number {
    return (this.nextU32() & 0x80000000) === 0 ? 1 : -1;
  }

  /** Fixed-point value uniformly in [0, 1). */
  fixed(): number {
    return this.nextU32() >>> 16;
  }

  /** Fixed-point value uniformly in [lo, hi). */
  fixedRange(lo: number, hi: number): number {
    return lo + Math.floor(((hi - lo) * this.fixed()) / 65536);
  }

  /** Uniform binary angle. */
  angle(): number {
    return this.nextU32() >>> 16;
  }
}
