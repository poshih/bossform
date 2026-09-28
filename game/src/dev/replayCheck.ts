import { decodeReplay, fx, hashBytes, hashToString, playReplay, Rng } from '@metronome/engine';
import { createGameSim, gameCodec } from '../sim/index.ts';

/**
 * Development-only entry (never imported by the game): lets the cross-engine check replay a recording through
 * the real simulation inside any JS engine and report checksums for comparison with Node.
 */
export interface EngineReport {
  readonly tables: string;
  readonly probes: string;
  readonly replays: ReadonlyArray<{ ok: boolean; ticks: number; finalHash: string; firstMismatch: number | null }>;
}

/** Numeric spot checks whose values must be identical on every conforming engine. */
function probes(): string {
  const rng = new Rng(new Uint32Array(4));
  rng.seed(0xdecafbad);
  const out: number[] = [];
  for (let i = 0; i < 64; i++) out.push(rng.nextU32());
  for (let a = -40000; a <= 40000; a += 977) out.push(fx.sin(a), fx.cos(a), fx.atan2(a * 13, 40000 - a * 7));
  for (let n = 1; n < 4e15; n = Math.floor(n * 3.7) + 1) out.push(fx.isqrt(n));
  for (let a = 1; a < 3000000; a += 99991) out.push(fx.mul(a, 77777), fx.div(a * 3, 65537), fx.hypot(a, 1234567 - a));
  return hashToString(hashBytes(new Uint8Array(new Int32Array(out.map((v) => v | 0)).buffer)));
}

export function checkReplays(recordings: number[][]): EngineReport {
  const tables = fx.trigTables();
  const tableBytes = new Uint8Array(tables.sin.length * 4 + tables.atan.length * 4);
  tableBytes.set(new Uint8Array(tables.sin.buffer, tables.sin.byteOffset, tables.sin.byteLength));
  tableBytes.set(new Uint8Array(tables.atan.buffer, tables.atan.byteOffset, tables.atan.byteLength), tables.sin.byteLength);
  return {
    tables: hashToString(hashBytes(tableBytes)),
    probes: probes(),
    replays: recordings.map((bytes) => {
      const result = playReplay(decodeReplay(Uint8Array.from(bytes)), createGameSim, gameCodec);
      return { ok: result.ok, ticks: result.ticks, finalHash: hashToString(result.finalHash), firstMismatch: result.mismatch ? result.mismatch.tick : null };
    }),
  };
}
