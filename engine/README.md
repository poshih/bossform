# METRONOME — a standalone deterministic lockstep engine

Zero dependencies. Pure TypeScript compiled with `lib: ES2023` and **no ambient types**: it cannot touch the DOM,
Node, timers or the console. It knows nothing about rendering, audio or any particular game.

```ts
import { createSession, LockstepRunner, fx, SimMemory, field, Rng } from '@metronome/engine';
```

## What it gives a game

| Module | Purpose |
|---|---|
| `fixed.ts` (`fx`) | Q16.16 fixed point; exact `isqrt`; table `sin/cos/atan2` built from IEEE-exact ops; binary angles |
| `memory.ts` | `SimMemory`: all simulation state in one `ArrayBuffer` -> snapshot, restore, checksum, layout hash |
| `rng.ts` | xoshiro128\*\* whose 4-word state lives in sim memory |
| `hash.ts` | 64-bit state checksums |
| `sim.ts` | The contracts: `Simulation`, `InputCodec`, `SessionParams`, handshake hash |
| `session.ts` | The lockstep session (input delay, redundancy, stalls, checksums, leave, timeouts, replay recording) |
| `wire.ts`, `transport.ts` | Datagram formats and the `Transport` interface |
| `netsim.ts` | `SimulatedNetwork`: latency, jitter, loss, duplication, partitions on a virtual clock (seeded, reproducible) |
| `relay.ts` | `RelayTransport` over a WebSocket-like object (structural type: no DOM dependency) |
| `clock.ts` | `TickClock` and `LockstepRunner`: wall-clock to ticks, catch-up limits, render interpolation alpha |
| `replay.ts` | `ReplayRecorder`, `decodeReplay`, `playReplay` (verifies every recorded checkpoint) |
| `audit.ts` | `auditDeterminism` and `withTripwires` |

## Minimal use

```ts
const codec: InputCodec<Pad> = { byteLength: 2, neutral: () => ({ x: 0, y: 0 }), encode, decode };
const factory: SimFactory<Pad> = (init) => new MyGame(init);           // init = { seed, seats, config }
const session = createSession({
  factory, codec,
  params: { simVersion: 1, seed, seats: 2, tickRate: 60, inputDelay: 6, checksumInterval: 60, config: new Uint8Array(0) },
  self: 0, seatOwners: [0, 1], transport,                              // omit transport for single-machine play
  sampleInput: (seat, tick) => readMyControls(),
  onDesync: (report) => { /* stop and show it: the session already stopped simulating */ },
});
const runner = new LockstepRunner(session);
requestAnimationFrame(function frame(now) {
  const { ticks, alpha, stalled, status } = runner.frame(now);          // ticks simulated this frame
  render(alpha);
});
```

## The contract for simulation authors

1. **All state lives in `SimMemory`** (including the RNG). Anything else is invisible to snapshots and checksums.
2. **`step(frame)` is a pure function of (memory, frame).** Treat `frame.inputs` as read-only; departed/empty seats
   arrive as `codec.neutral()` with `present[seat] === false` (identically on every peer).
3. **Integers only.** Use `fx.*`. Never `Math.random`, `Math.sin/cos/tan/atan2/pow/exp/log/hypot/sqrt`, `**`,
   `Date`, `performance`. Iterate in index order; avoid `Map/Set` iteration and `for..in`. Keep operands in the
   documented ranges (`|a*b| < 2^53`); `isqrt` throws outside `[0, 2^52)` and `fx.div` throws on zero (fail loud).
4. **`InputCodec.decode` must be total** (every byte pattern valid) because the bytes come from other machines.
5. Outputs for presentation (events) must be derived, never read back by the simulation.

`auditDeterminism` checks 1-3 at runtime: twin instances must agree every tick, a fresh instance restored from a
mid-run snapshot must follow the original exactly (this fails if state hides outside memory), and non-deterministic
globals are replaced by throwing tripwires while `step` runs.

## Lockstep, briefly

Every seat's input for tick *T* is sampled at *T - inputDelay* and broadcast with the still-unacknowledged inputs
before it (so loss, duplication and reordering cost nothing but latency). A tick is simulated only when every seat's
input is present; otherwise the session **stalls** (never guesses). Every `checksumInterval` ticks the peers exchange
64-bit state hashes; a mismatch stops the session and reports the first divergent interval. The first packet also
carries a hash of (parameters, input size, memory layout), so a different build or setup aborts before tick 0.
Inputs are only accepted for seats the sender owns; conflicting duplicates abort the session; malformed packets are
counted and dropped. A graceful `leave()` makes the seat absent for everyone at the same tick; a vanished peer times
out and aborts (without an authority there is no deterministic way to continue).

## Verifying the engine

`tools/verify/engine-*.ts` (run with `npm run verify` at the repo root) exercise it with a toy game built only on
this public API: numerics against exact BigInt/float oracles, audit, replays, networked runs equal to the ideal run
under 30% loss / duplication / reordering / partitions, desync injection, timeouts, version mismatch, graceful leave,
5000 garbage packets, spoofed seats and conflicting inputs, and a build with plain `tsc` consumed from outside the
repository. `tools/verify/cross-engine.ts` replays recordings on V8, SpiderMonkey and JavaScriptCore.
