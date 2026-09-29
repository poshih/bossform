# METRONOME — a standalone deterministic lockstep engine

Zero dependencies. Pure TypeScript compiled with `lib: ES2023` and **no ambient types**: it cannot touch the DOM,
Node, timers or the console. It knows nothing about rendering, audio or any particular game.

```ts
import { BROADCAST_PEER, createSession, LockstepRunner, fx, SimMemory, field, Rng } from '@metronome/engine';
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
| `wire.ts`, `transport.ts` | Datagram formats, `BROADCAST_PEER`, and the `Transport` interface |
| `netsim.ts` | `SimulatedNetwork`: latency, jitter, loss, duplication, partitions on a virtual clock (seeded, reproducible) |
| `relay.ts` | `RelayTransport` over a WebSocket-like object (structural type: no DOM dependency) |
| `clock.ts` | `TickClock` and `LockstepRunner`: wall-clock to ticks, catch-up limits, render interpolation alpha |
| `replay.ts` | `ReplayRecorder`, replay format v2, `decodeReplay`, `playReplay` |
| `audit.ts` | `auditDeterminism` and `withTripwires` |

## Protocol ceilings and API surface

- `MAX_SEATS = 0xFFFF` is a **wire-format ceiling**, not a gameplay recommendation.
- Peer ids are `u16` too: valid session peer ids are `0..0xFFFE`; `0xFFFF` is exported as `BROADCAST_PEER` for
  relay-style transports; `NO_PEER = -1` still means an empty seat.
- A machine may own any number of seats (`seatOwners[seat] = peer`), including several local players or bots.
- `Transport` now has optional `broadcast(data)`: when present, `Session` encodes one peer-independent FRAME/CHECK/
  LEAVE packet and sends it once; otherwise it falls back to `send(peer, data)` with identical bytes per peer.
- Replay format is **version 2**: each tick stores `ceil(seats / 8)` presence bytes plus `seats * inputByteLength`
  input bytes. Version 1 is rejected loudly.

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
  const { ticks, alpha, stalled, status } = runner.frame(now);
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

## Lockstep and wire format, briefly

Every seat's input for tick *T* is sampled at *T - inputDelay* and sent redundantly until every active remote peer
acknowledges it. A tick is simulated only when every seat's input is present; otherwise the session **stalls**
(never guesses). Every `checksumInterval` ticks the peers exchange 64-bit state hashes; a mismatch stops the session
and reports the first divergent interval. The first packet also carries a hash of (parameters, input size, memory
layout), so a different build or setup aborts before tick 0.

All integers are little-endian. Every packet starts with:

- `type u8`
- `sender u16`
- `handshake.lo u32`
- `handshake.hi u32`

Then:

- `FRAME`: `ackCount u16`, `ackCount x (seat u16, frontier u32)`, `segmentCount u16`, `segmentCount x (seat u16, start u32, count u16, bytes...)`
- `CHECK`: `tick u32`, `hash.lo u32`, `hash.hi u32`
- `LEAVE`: `lastTick i32`

FRAME packets are **peer-independent**: the same encoded bytes are valid for every recipient. Acks cover the
contiguous frontier for every seat owned by some other peer; receivers keep the entries for their own seats and ignore
all others. Segments carry every locally owned seat from the minimum frontier any still-active remote peer has
acknowledged, capped by `MAX_SEGMENT_TICKS = 64`.

FRAME size is:

- `15 + 6 * ackCount + sum(8 + count * inputByteLength)` bytes

So the ack table alone crosses a 1200-byte MTU at about **198 seats**, before any input segments are added.

## Transport contract

`Transport` is deliberately tiny:

```ts
interface Transport {
  send(peer: number, data: Uint8Array): void;
  broadcast?(data: Uint8Array): void;
  setReceiver(receiver: ((peer: number, data: Uint8Array) => void) | null): void;
  close(): void;
}
```

`send()` and `broadcast()` are both best-effort and must not throw for an unreachable peer. `Session` tolerates loss,
duplication and reordering. `SimulatedNetwork` implements both methods in-process. `RelayTransport` wraps a dumb
WebSocket relay whose binary frames are `[peer u16 LE, ...payload]`: destination when sending, origin when receiving,
and `BROADCAST_PEER` as a destination means “fan this out to everyone else in the room”.

## Replays

Replay v2 stores:

- params
- `inputByteLength` (`u8`)
- `tickCount` (`u32`)
- `tickCount x (presenceBitset + per-seat input bytes)`
- recorded checksum checkpoints

Round-tripping a replay must reproduce every recorded checkpoint and the final state exactly. Presence is a bitset so
20-seat, 64-seat, and other non-trivial seat counts record compactly without a one-byte mask cap.

## Verifying the engine

`tools/verify/engine-*.ts` (run with `npm run verify` at the repo root) exercise it with a toy game built only on
this public API: numerics against exact BigInt/float oracles, audit, replays, networked runs equal to the ideal run,
16-peer hostile broadcast and fallback runs, 20-seat multi-owner leave + replay proof, 64-peer cap proof, hostile
packets, relay framing, and a build with plain `tsc` consumed from outside the repository. `tools/verify/cross-engine.ts`
replays recordings on V8, SpiderMonkey and JavaScriptCore.
