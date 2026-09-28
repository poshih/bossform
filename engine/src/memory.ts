import { hashWords, hashBytes } from './hash.ts';
import type { Hash64 } from './hash.ts';

/**
 * Simulation memory: ALL state that influences future ticks lives in one ArrayBuffer, carved into typed
 * arrays from a declarative layout. That single rule makes these generic:
 *  - snapshot / restore  = one memcpy
 *  - state checksums      = one pass over the words
 *  - hidden-state leaks   = detectable (restore into a fresh sim, replay, compare; see audit.ts)
 */

export type FieldKind = 'i8' | 'u8' | 'i16' | 'u16' | 'i32' | 'u32';

export interface FieldSpec<K extends FieldKind = FieldKind> {
  readonly kind: K;
  readonly length: number;
}

export type LayoutSpec = Readonly<Record<string, FieldSpec>>;

interface ArrayByKind {
  i8: Int8Array;
  u8: Uint8Array;
  i16: Int16Array;
  u16: Uint16Array;
  i32: Int32Array;
  u32: Uint32Array;
}

export type MemoryViews<L extends LayoutSpec> = { readonly [N in keyof L]: ArrayByKind[L[N]['kind']] };

/** Field constructors: `{ hp: field.i32(64), alive: field.u8(64) }`. */
export const field = {
  i8: (length: number): FieldSpec<'i8'> => ({ kind: 'i8', length }),
  u8: (length: number): FieldSpec<'u8'> => ({ kind: 'u8', length }),
  i16: (length: number): FieldSpec<'i16'> => ({ kind: 'i16', length }),
  u16: (length: number): FieldSpec<'u16'> => ({ kind: 'u16', length }),
  i32: (length: number): FieldSpec<'i32'> => ({ kind: 'i32', length }),
  u32: (length: number): FieldSpec<'u32'> => ({ kind: 'u32', length }),
};

const CONSTRUCTORS = {
  i8: Int8Array,
  u8: Uint8Array,
  i16: Int16Array,
  u16: Uint16Array,
  i32: Int32Array,
  u32: Uint32Array,
} as const;

const BYTES_PER_ELEMENT: Readonly<Record<FieldKind, number>> = { i8: 1, u8: 1, i16: 2, u16: 2, i32: 4, u32: 4 };

const FIELD_ALIGN = 8;
const SNAPSHOT_HEADER_BYTES = 8;
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** What a session needs from a simulation's state, without knowing anything about its contents. */
export interface StateAccess {
  /** Identifies the memory layout; peers with different layouts cannot be in lockstep. */
  readonly layoutHash: Hash64;
  hash(): Hash64;
  snapshot(): Uint8Array;
  restore(snapshot: Uint8Array): void;
}

export class SimMemory<L extends LayoutSpec> implements StateAccess {
  /** Typed-array views keyed by field name. Destructure once and keep the references. */
  readonly f: MemoryViews<L>;
  readonly bytes: Uint8Array;
  readonly layoutHash: Hash64;
  private readonly words: Int32Array;

  constructor(spec: L) {
    let offset = 0;
    const placed: Array<{ name: string; kind: FieldKind; length: number; offset: number }> = [];
    const signature: string[] = [];
    for (const name of Object.keys(spec)) {
      if (!NAME_PATTERN.test(name)) throw new RangeError(`SimMemory: field name "${name}" must be an identifier`);
      const { kind, length } = spec[name];
      if (!(kind in CONSTRUCTORS)) throw new RangeError(`SimMemory: unknown kind "${kind}" for "${name}"`);
      if (!Number.isInteger(length) || length < 1) throw new RangeError(`SimMemory: "${name}" needs a positive integer length`);
      offset = Math.ceil(offset / FIELD_ALIGN) * FIELD_ALIGN;
      placed.push({ name, kind, length, offset });
      signature.push(`${name}:${kind}:${length}`);
      offset += length * BYTES_PER_ELEMENT[kind];
    }
    const total = Math.max(FIELD_ALIGN, Math.ceil(offset / FIELD_ALIGN) * FIELD_ALIGN);
    const buffer = new ArrayBuffer(total);
    const views: Record<string, ArrayBufferView> = {};
    for (const p of placed) views[p.name] = new CONSTRUCTORS[p.kind](buffer, p.offset, p.length);
    this.f = views as unknown as MemoryViews<L>;
    this.bytes = new Uint8Array(buffer);
    this.words = new Int32Array(buffer);
    this.layoutHash = hashBytes(asciiBytes(signature.join('|')));
  }

  hash(): Hash64 {
    return hashWords(this.words);
  }

  /** Self-describing copy: [layout hash lo, hi][state bytes]. */
  snapshot(): Uint8Array {
    const out = new Uint8Array(SNAPSHOT_HEADER_BYTES + this.bytes.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, this.layoutHash.lo, true);
    view.setUint32(4, this.layoutHash.hi, true);
    out.set(this.bytes, SNAPSHOT_HEADER_BYTES);
    return out;
  }

  restore(snapshot: Uint8Array): void {
    const view = new DataView(snapshot.buffer, snapshot.byteOffset, snapshot.byteLength);
    if (snapshot.length !== SNAPSHOT_HEADER_BYTES + this.bytes.length || view.getUint32(0, true) !== this.layoutHash.lo || view.getUint32(4, true) !== this.layoutHash.hi) {
      throw new RangeError('SimMemory.restore: snapshot belongs to a different memory layout');
    }
    this.bytes.set(snapshot.subarray(SNAPSHOT_HEADER_BYTES));
  }
}

function asciiBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}
