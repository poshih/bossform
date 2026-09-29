/**
 * Game rules eval (4/4): determinism and scale on the real game. The audit (twin runs, snapshot/restore parity,
 * tripwires), replay round trips, lockstep between eight machines over a hostile network (with one leaving), and
 * simulations built for many seat counts.
 */
import { auditDeterminism, createSession, decodeReplay, hashEquals, hashToString, playReplay, SimulatedNetwork, TickClock } from '@metronome/engine';
import type { Session } from '@metronome/engine';
import { createGameSim, gameCodec, Mode, W } from '../../game/src/sim/index.ts';
import type { GameInput } from '../../game/src/sim/index.ts';
import { freeForAll, rotatingFrames, runBots, scriptFromReplay } from './game-run.ts';
import { check, finish, info, section } from './lib.ts';

const dm8 = { mode: Mode.Deathmatch, frames: rotatingFrames(8), teams: freeForAll(8), seed: 21 } as const;
const el4 = { mode: Mode.Elimination, frames: rotatingFrames(4, 2), teams: [0, 0, 1, 1], seed: 22 } as const;

section('determinism audit and replays');
const recorded = new Map<string, ReturnType<typeof runBots>>();
for (const [name, spec, ticks] of [['deathmatch, 8 pilots', dm8, 6000], ['elimination, 2 v 2 (a whole match)', el4, 40000]] as const) {
  const run = runBots({ ...spec, ticks });
  recorded.set(name, run);
  const script = scriptFromReplay(run.replay);
  const report = auditDeterminism({
    factory: createGameSim, codec: gameCodec, params: script.params, ticks: script.ticks, inputAt: script.inputAt, restoreEvery: 500, fingerprintEvery: 60,
  });
  check(`${name}: twin runs, snapshot/restore parity and no non-deterministic API calls`, report.ok, report.failures.join('; '));
  info(`${script.ticks} ticks, final ${hashToString(report.finalHash)}, fingerprint ${hashToString(report.fingerprint)}, ${report.restoreChecks} restore checks, replay ${run.replay.length} bytes`);
  const replay = playReplay(decodeReplay(run.replay), createGameSim, gameCodec);
  check(`${name}: the replay reproduces every checkpoint and the final state`, replay.ok && hashEquals(replay.finalHash, run.sim.memory.hash()), replay.mismatch ? `diverged @${replay.mismatch.tick}` : '');
}

section('lockstep: eight machines over a hostile network equal the ideal single-machine run');
{
  const source = recorded.get('deathmatch, 8 pilots')!;
  const script = scriptFromReplay(source.replay);
  const delay = 8;
  const target = 4000;
  const params = { ...script.params, inputDelay: delay };
  const sample = (seat: number, tick: number): GameInput => script.inputAt(tick, seat);
  const seats = params.seats;
  const reference = createSession({ factory: createGameSim, codec: gameCodec, params, self: 0, seatOwners: new Array<number>(seats).fill(0), sampleInput: sample });
  while (reference.tick < target) reference.update(0, target - reference.tick);

  const net = new SimulatedNetwork({ latencyMs: 60, jitterMs: 40, lossRate: 0.1, duplicateRate: 0.05 }, 7);
  const owners = Array.from({ length: seats }, (_, seat) => seat);
  const peers: Session<GameInput>[] = owners.map((self) => createSession({
    factory: createGameSim, codec: gameCodec, params, self, seatOwners: owners, transport: net.connect(self), sampleInput: sample,
  }));
  const clocks = peers.map(() => new TickClock({ tickRate: 60 }));
  const desynced: number[] = [];
  const leaver = 7;
  const leaveAt = 1500;
  let left = false;
  for (let frame = 0; frame < 60 * 240 && peers.some((p, i) => i !== leaver && p.tick < target); frame++) {
    const now = frame * (1000 / 60);
    net.advance(now);
    peers.forEach((p, i) => {
      if (i === leaver && left) return;
      const t = now + i * 2.3;
      const due = clocks[i].begin(t);
      clocks[i].end(p.update(t, Math.max(0, Math.min(due, target - p.tick))).ticks);
      if (p.status === 'desynced') desynced.push(i);
      if (i === leaver && p.tick >= leaveAt) {
        p.leave();
        left = true;
      }
    });
  }
  const stayers = peers.filter((_, i) => i !== leaver);
  const equal = stayers.every((p) => p.tick === target && hashEquals(p.sim.memory.hash(), stayers[0].sim.memory.hash()));
  check('with one pilot leaving mid-match, the seven who remain finish bit-identical and nobody desynced', equal && desynced.length === 0,
    `ticks ${stayers.map((p) => p.tick)}, desynced ${desynced}`);
  const gone = stayers.every((p) => (p.sim as unknown as { world: { m: { plActive: Uint8Array } } }).world.m.plActive[leaver] === 0);
  check('and the departed pilot\'s ship is out of the match on every machine', gone);
  info(`stalls ${stayers.map((p) => p.stats.stalledUpdates)}, rtt ${stayers.map((p) => Math.round(p.stats.rttMs))} ms, packets out ${stayers.map((p) => p.stats.packetsOut)}`);

  // Everyone stays: the full eight must equal the reference exactly.
  const net2 = new SimulatedNetwork({ latencyMs: 60, jitterMs: 40, lossRate: 0.1, duplicateRate: 0.05 }, 8);
  const all: Session<GameInput>[] = owners.map((self) => createSession({
    factory: createGameSim, codec: gameCodec, params, self, seatOwners: owners, transport: net2.connect(self), sampleInput: sample,
  }));
  const clocks2 = all.map(() => new TickClock({ tickRate: 60 }));
  for (let frame = 0; frame < 60 * 240 && all.some((p) => p.tick < target); frame++) {
    const now = frame * (1000 / 60);
    net2.advance(now);
    all.forEach((p, i) => {
      const t = now + i * 2.3;
      const due = clocks2[i].begin(t);
      clocks2[i].end(p.update(t, Math.max(0, Math.min(due, target - p.tick))).ticks);
    });
  }
  check('with everyone staying, all eight machines equal the ideal local run (lossy, jittery, duplicating network)',
    all.every((p) => p.tick === target && hashEquals(p.sim.memory.hash(), reference.sim.memory.hash())), `final ${hashToString(reference.sim.memory.hash())}`);
}

section('the simulation is built from the seat count: nothing caps the number of pilots');
{
  const hashes = new Set<string>();
  for (const seats of [2, 3, 5, 8, 12, 16]) {
    const run = runBots({ mode: Mode.Deathmatch, frames: rotatingFrames(seats), teams: freeForAll(seats), ticks: 700, seed: seats });
    const w = run.sim.world;
    hashes.add(hashToString(run.sim.memory.layoutHash));
    check(`${seats} pilots: ${run.sim.memory.bytes.length} bytes of state, ${w.cap.projectiles} projectile slots, arena radius ${w.arenaR / 65536}`, run.session.tick === 700 && w.m.world[W.Dropped] === 0 && w.m.plAlive.some((a) => a === 1));
  }
  check('every seat count has its own memory layout (so mismatched peers are refused at the handshake)', hashes.size === 6);
  let refused = false;
  try {
    runBots({ mode: Mode.Deathmatch, frames: rotatingFrames(36), teams: freeForAll(36), ticks: 5 });
  } catch (error) {
    refused = error instanceof RangeError;
  }
  check('a seat count whose arena would exceed the fixed-point range is refused loudly, not simulated wrongly', refused);
}

section('performance');
{
  const run = recorded.get('deathmatch, 8 pilots')!;
  const started = performance.now();
  const replay = playReplay(decodeReplay(run.replay), createGameSim, gameCodec);
  const perTick = (performance.now() - started) / replay.ticks;
  check('an 8-pilot match steps in well under a millisecond per tick (simulation only)', perTick < 1, `${perTick.toFixed(3)} ms/tick over ${replay.ticks} ticks`);
}

finish('game-determinism');
