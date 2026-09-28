import type { Hash64 } from './hash.ts';
import { hashCombine, hashEquals, hashToString } from './hash.ts';
import type { InputCodec, SessionParams, SimFactory, Simulation, TickInput } from './sim.ts';

/**
 * Determinism audit: runs a simulation the way lockstep peers would and proves what can be proven.
 *
 *  1. twin runs       two independent instances fed identical inputs must agree on every tick's checksum
 *  2. restore parity  a fresh instance restored from a mid-run snapshot must follow the original exactly
 *                     (fails if any state lives outside the simulation memory)
 *  3. tripwires       Math.random / Math.sin / Date.now ... called inside step() are reported with the tick
 *  4. input hygiene   step() receives frozen input objects, so mutating them fails loudly
 *
 * The returned fingerprint folds every sampled checksum, so it can be compared across processes and JS
 * engines (Node, Chromium, Firefox, WebKit) to prove cross-runtime determinism.
 */
export interface AuditOptions<I> {
  readonly factory: SimFactory<I>;
  readonly codec: InputCodec<I>;
  readonly params: SessionParams;
  readonly ticks: number;
  /** Deterministic source of inputs (seed your own generator; never Math.random). */
  readonly inputAt: (tick: number, seat: number) => I;
  /** Take a snapshot and check restore parity every N ticks (0 disables). */
  readonly restoreEvery?: number;
  /** Fold the checksum into the fingerprint every N ticks. */
  readonly fingerprintEvery?: number;
  /** Extra ticks to run after each restore before comparing (default: until the end of the run). */
  readonly restoreHorizon?: number;
}

export interface AuditReport {
  readonly ok: boolean;
  readonly failures: readonly string[];
  readonly ticks: number;
  readonly finalHash: Hash64;
  readonly fingerprint: Hash64;
  readonly restoreChecks: number;
}

const BANNED_MATH = [
  'random', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'sinh', 'cosh', 'tanh', 'asinh', 'acosh', 'atanh',
  'exp', 'expm1', 'log', 'log1p', 'log2', 'log10', 'pow', 'cbrt', 'hypot',
] as const;

/** Temporarily replaces non-deterministic globals with throwing stubs while `fn` runs. */
export function withTripwires<T>(fn: () => T, onViolation: (api: string) => void): T {
  const saved: Array<{ owner: Record<string, unknown>; key: string; original: unknown }> = [];
  const arm = (owner: Record<string, unknown> | undefined, key: string, label: string) => {
    if (!owner || typeof owner[key] !== 'function') return;
    saved.push({ owner, key, original: owner[key] });
    owner[key] = () => {
      onViolation(label);
      throw new Error(`metronome tripwire: ${label} is not allowed inside a simulation step`);
    };
  };
  const scope = globalThis as unknown as Record<string, Record<string, unknown> | undefined>;
  try {
    for (const name of BANNED_MATH) arm(Math as unknown as Record<string, unknown>, name, `Math.${name}`);
    arm(Date as unknown as Record<string, unknown>, 'now', 'Date.now');
    arm(scope.performance, 'now', 'performance.now');
    return fn();
  } finally {
    for (let i = saved.length - 1; i >= 0; i--) saved[i].owner[saved[i].key] = saved[i].original;
  }
}

function frameFor<I>(tick: number, opts: AuditOptions<I>, scratch: Uint8Array): TickInput<I> {
  const { seats } = opts.params;
  const inputs: I[] = [];
  const present: boolean[] = [];
  for (let seat = 0; seat < seats; seat++) {
    // Same normalisation a live session applies: what is simulated is decode(encode(x)).
    opts.codec.encode(opts.inputAt(tick, seat), scratch, 0);
    const decoded = opts.codec.decode(scratch, 0);
    inputs.push(typeof decoded === 'object' && decoded !== null ? Object.freeze(decoded) : decoded);
    present.push(true);
  }
  return { tick, inputs: Object.freeze(inputs), present: Object.freeze(present) };
}

export function auditDeterminism<I>(opts: AuditOptions<I>): AuditReport {
  const failures: string[] = [];
  const { params } = opts;
  const init = { seed: params.seed, seats: params.seats, config: params.config };
  const scratch = new Uint8Array(opts.codec.byteLength);
  const fingerprintEvery = opts.fingerprintEvery ?? 30;
  const restoreEvery = opts.restoreEvery ?? 0;

  const make = (): Simulation<I> => opts.factory(init);
  const a = make();
  const b = make();
  let fingerprint: Hash64 = { lo: 0, hi: 0 };
  let restoreChecks = 0;
  let violation: string | null = null;
  const restoreRuns: Array<{ startTick: number; sim: Simulation<I> }> = [];

  const step = (sim: Simulation<I>, frame: TickInput<I>, label: string): boolean => {
    try {
      withTripwires(() => sim.step(frame), (api) => { violation = api; });
      return true;
    } catch (error) {
      failures.push(`${label} threw at tick ${frame.tick}: ${violation ?? (error instanceof Error ? error.message : String(error))}`);
      return false;
    }
  };

  let finalHash = a.memory.hash();
  for (let tick = 0; tick < opts.ticks; tick++) {
    const frame = frameFor(tick, opts, scratch);
    if (!step(a, frame, 'run A') || !step(b, frame, 'run B')) break;
    const hashA = a.memory.hash();
    if (!hashEquals(hashA, b.memory.hash())) {
      failures.push(`twin runs diverged after tick ${tick} (${hashToString(hashA)} vs ${hashToString(b.memory.hash())})`);
      break;
    }
    let broken = false;
    for (const run of restoreRuns) {
      if (!step(run.sim, frame, `restored@${run.startTick}`)) { broken = true; break; }
      if (!hashEquals(run.sim.memory.hash(), hashA)) {
        failures.push(`snapshot taken at tick ${run.startTick} did not reproduce tick ${tick}: state lives outside simulation memory`);
        broken = true;
        break;
      }
    }
    if (broken) break;
    finalHash = hashA;
    if ((tick + 1) % fingerprintEvery === 0) fingerprint = hashCombine(fingerprint, hashA);
    if (restoreEvery > 0 && (tick + 1) % restoreEvery === 0) {
      const restored = make();
      restored.memory.restore(a.memory.snapshot());
      if (!hashEquals(restored.memory.hash(), hashA)) {
        failures.push(`restore at tick ${tick + 1} did not reproduce its own checksum`);
        break;
      }
      restoreRuns.push({ startTick: tick + 1, sim: restored });
      restoreChecks++;
      if (opts.restoreHorizon !== undefined && restoreRuns.length > 4) restoreRuns.shift();
    }
  }
  return { ok: failures.length === 0, failures, ticks: opts.ticks, finalHash, fingerprint, restoreChecks };
}
