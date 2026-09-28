/**
 * Engine lockstep eval: determinism audit, replays, and lockstep sessions over hostile simulated networks.
 * The decisive property: a networked run must end in EXACTLY the state an ideal local run produces.
 */
import { auditDeterminism, decodeReplay, hashEquals, hashToString, playReplay } from '@metronome/engine';
import type { Session, TickInput } from '@metronome/engine';
import { check, finish, info, section } from './lib.ts';
import { isTerminal, makeParams, makeRig, referenceRun, runRig, stepRig } from './harness.ts';
import type { PeerSpec } from './harness.ts';
import { scriptedInput, toyCodec, toyFactory, ToySim } from './toy-sim.ts';
import type { ToyInput } from './toy-sim.ts';

section('determinism audit (toy game, 3 seats, 1800 ticks)');
{
  const report = auditDeterminism({
    factory: toyFactory, codec: toyCodec, params: makeParams(3, 0), ticks: 1800, inputAt: (t, s) => scriptedInput(s, t), restoreEvery: 120,
  });
  check('twin runs, restore parity and tripwires all clean', report.ok, report.failures.join('; '));
  info(`final ${hashToString(report.finalHash)}  fingerprint ${hashToString(report.fingerprint)}  restore checks ${report.restoreChecks}`);

  class HiddenState extends ToySim {
    private calls = 0;
    override step(frame: TickInput<ToyInput>): void {
      super.step(frame);
      if (++this.calls > 100) this.memory.f.world[3] ^= 1; // depends on state that is NOT in sim memory
    }
  }
  const hidden = auditDeterminism({
    factory: (init) => new HiddenState(init.seed, init.seats), codec: toyCodec, params: makeParams(2, 0), ticks: 600,
    inputAt: (t, s) => scriptedInput(s, t), restoreEvery: 50,
  });
  check('audit catches state hidden outside sim memory (restore parity)', !hidden.ok && hidden.failures.some((f) => f.includes('outside simulation memory')), hidden.failures[0] ?? 'no failure reported');

  class UsesRandom extends ToySim {
    override step(frame: TickInput<ToyInput>): void {
      super.step(frame);
      if (frame.tick === 10) this.memory.f.world[3] = Math.floor(Math.random() * 1000);
    }
  }
  const random = auditDeterminism({
    factory: (init) => new UsesRandom(init.seed, init.seats), codec: toyCodec, params: makeParams(2, 0), ticks: 100, inputAt: (t, s) => scriptedInput(s, t),
  });
  check('audit tripwire catches Math.random inside step()', !random.ok && random.failures.some((f) => f.includes('Math.random')), random.failures[0] ?? 'no failure reported');

  class UsesSin extends ToySim {
    override step(frame: TickInput<ToyInput>): void {
      super.step(frame);
      this.memory.f.world[3] = Math.floor(Math.sin(frame.tick) * 65536);
    }
  }
  const sin = auditDeterminism({ factory: (i) => new UsesSin(i.seed, i.seats), codec: toyCodec, params: makeParams(1, 0), ticks: 20, inputAt: (t, s) => scriptedInput(s, t) });
  check('audit tripwire catches Math.sin (implementation-approximated)', !sin.ok && sin.failures.some((f) => f.includes('Math.sin')));
}

section('replay round trip');
{
  const session = referenceRun(2, 0, 2400);
  const bytes = session.exportReplay();
  const replay = decodeReplay(bytes);
  const result = playReplay(replay, toyFactory, toyCodec);
  check('replay reproduces every recorded checkpoint', result.ok && result.ticks === 2400, result.mismatch ? `mismatch at ${result.mismatch.tick}` : '');
  check('replay final state == live final state', hashEquals(result.finalHash, session.sim.memory.hash()));
  info(`${bytes.length} bytes for ${replay.tickCount} ticks (${(bytes.length / replay.tickCount).toFixed(1)} B/tick, 2 seats)`);
  const tampered = bytes.slice();
  tampered[7 + 26 + 1 + 4 + 5000] ^= 0x10;
  const bad = playReplay(decodeReplay(tampered), toyFactory, toyCodec);
  check('a corrupted replay is detected at its first divergent checkpoint', !bad.ok && bad.mismatch !== null, bad.mismatch ? `first bad checkpoint @${bad.mismatch.tick}` : 'not detected');
}

const PROFILES = [
  { name: 'LAN (1ms, no loss)', peers: 2, delay: 2, c: { latencyMs: 1, jitterMs: 0, lossRate: 0, duplicateRate: 0 } },
  { name: 'broadband (45ms +-10, 2% loss)', peers: 2, delay: 6, c: { latencyMs: 45, jitterMs: 10, lossRate: 0.02, duplicateRate: 0 } },
  { name: 'hostile (90ms +-70 reordering, 25% loss, 15% dup)', peers: 2, delay: 12, c: { latencyMs: 90, jitterMs: 70, lossRate: 0.25, duplicateRate: 0.15 } },
  { name: '4 peers, hostile (60ms +-40, 15% loss, 10% dup)', peers: 4, delay: 10, c: { latencyMs: 60, jitterMs: 40, lossRate: 0.15, duplicateRate: 0.1 } },
  { name: 'extreme delay budget (300ms +-100, 30% loss)', peers: 2, delay: 30, c: { latencyMs: 300, jitterMs: 100, lossRate: 0.3, duplicateRate: 0.1 } },
] as const;

section('lockstep over simulated networks == ideal local run');
for (const profile of PROFILES) {
  const target = 3600;
  const desyncs: string[] = [];
  const rig = makeRig({
    peers: profile.peers, conditions: profile.c, inputDelay: profile.delay, netSeed: 7,
    specs: Array.from({ length: profile.peers }, (_, i): PeerSpec => ({ frameOffsetMs: i * 5.3 })),
    onDesync: (peer, tick) => desyncs.push(`peer ${peer} @${tick}`),
  });
  const finished = runRig(rig, target, 240_000);
  const reference = referenceRun(profile.peers, profile.delay, target);
  const refReplay = decodeReplay(reference.exportReplay());
  const sameFinal = rig.sessions.every((s) => hashEquals(s.sim.memory.hash(), reference.sim.memory.hash()));
  const sameCheckpoints = rig.sessions.every((s) => {
    const cps = decodeReplay(s.exportReplay()).checkpoints;
    return cps.length === refReplay.checkpoints.length && cps.every((c, i) => c.tick === refReplay.checkpoints[i].tick && hashEquals(c.hash, refReplay.checkpoints[i].hash));
  });
  const stalls = rig.sessions.map((s) => s.stats.stalledUpdates).join('/');
  const rtt = rig.sessions.map((s) => Math.round(s.stats.rttMs)).join('/');
  check(profile.name, finished && sameFinal && sameCheckpoints && desyncs.length === 0,
    `${finished ? 'finished' : 'DID NOT FINISH'}, ${refReplay.checkpoints.length} checkpoints ${sameCheckpoints ? 'match' : 'DIFFER'}, stalled frames ${stalls}, rtt ${rtt}ms, sent ${rig.sessions[0].stats.packetsOut}, dups ${rig.sessions[0].stats.duplicateInputs}`);
}

section('network partition heals without desync');
{
  const rig = makeRig({ peers: 2, conditions: { latencyMs: 30, jitterMs: 5, lossRate: 0.02, duplicateRate: 0 }, inputDelay: 6, netSeed: 3 });
  for (let f = 0; f < 600; f++) stepRig(rig, 6000);
  rig.net.sever(0, 1, true);
  const before = rig.sessions.map((s) => s.tick);
  for (let f = 0; f < 240; f++) stepRig(rig, 6000);
  const advancedWhileCut = rig.sessions.map((s, i) => s.tick - before[i]);
  const frozen = advancedWhileCut.every((n) => n <= 7);
  rig.net.sever(0, 1, false);
  const finished = runRig(rig, 3000, 120_000);
  const reference = referenceRun(2, 6, 3000);
  check('both peers stall (never guess) while the link is cut', frozen, `advanced ${advancedWhileCut} ticks in 4 s (bounded by the input delay)`);
  check('after the link heals the run still equals the ideal run', finished && rig.sessions.every((s) => hashEquals(s.sim.memory.hash(), reference.sim.memory.hash())));
}

section('failure modes are loud');
{
  // 1. A peer whose state diverges is detected within one checksum interval.
  class Tampered extends ToySim {
    override step(frame: TickInput<ToyInput>): void {
      super.step(frame);
      if (frame.tick === 200) this.memory.bytes[64] ^= 1;
    }
  }
  const reports: Array<{ peer: number; tick: number }> = [];
  const rig = makeRig({
    peers: 2, conditions: { latencyMs: 20, jitterMs: 0, lossRate: 0, duplicateRate: 0 }, inputDelay: 4,
    specs: [{}, { factory: (init) => new Tampered(init.seed, init.seats) }], onDesync: (peer, tick) => reports.push({ peer, tick }),
  });
  for (let f = 0; f < 900 && !rig.sessions.every(isTerminal); f++) stepRig(rig, 100000);
  check('desync injected at tick 200 is reported by both peers as desynced', rig.sessions.every((s) => s.status === 'desynced'), rig.sessions.map((s) => s.status).join(','));
  check('reported within one checksum interval (30 ticks) of the divergence', reports.length > 0 && reports.every((r) => r.tick > 200 && r.tick <= 230), JSON.stringify(reports));
  check('a desynced session stops simulating', rig.sessions.every((s) => s.tick <= 240), `ticks ${rig.sessions.map((s) => s.tick)}`);

  // 2. Silent peer -> timeout abort (never an endless stall).
  const timeoutRig = makeRig({ peers: 2, conditions: { latencyMs: 20, jitterMs: 0, lossRate: 0, duplicateRate: 0 }, inputDelay: 4 });
  for (let f = 0; f < 120; f++) stepRig(timeoutRig, 100000);
  timeoutRig.net.sever(0, 1, true);
  for (let f = 0; f < 60 * 8; f++) stepRig(timeoutRig, 100000);
  check('a vanished peer aborts the session with peer-timeout', timeoutRig.sessions.every((s) => s.status === 'aborted' && s.abortReason === 'peer-timeout'), timeoutRig.sessions.map((s) => `${s.status}/${s.abortReason}`).join(' '));

  // 3. Different game versions refuse to play together.
  const mismatch = makeRig({
    peers: 2, conditions: { latencyMs: 10, jitterMs: 0, lossRate: 0, duplicateRate: 0 }, inputDelay: 3, specs: [{}, { params: { simVersion: 2 } }],
  });
  for (let f = 0; f < 60; f++) stepRig(mismatch, 1000);
  check('mismatched simVersion aborts before any tick is simulated', mismatch.sessions.every((s) => s.status === 'aborted' && s.abortReason === 'params-mismatch' && s.tick === 0), mismatch.sessions.map((s) => `${s.status}/${s.abortReason}/${s.tick}`).join(' '));

  // 4. Different seeds are also caught (they would silently diverge otherwise).
  const seedMismatch = makeRig({
    peers: 2, conditions: { latencyMs: 10, jitterMs: 0, lossRate: 0, duplicateRate: 0 }, inputDelay: 3, specs: [{}, { params: { seed: 5 } }],
  });
  for (let f = 0; f < 60; f++) stepRig(seedMismatch, 1000);
  check('mismatched seed aborts too', seedMismatch.sessions.every((s) => s.status === 'aborted'));
}

section('graceful leave');
{
  const rig = makeRig({ peers: 3, conditions: { latencyMs: 25, jitterMs: 8, lossRate: 0.05, duplicateRate: 0.05 }, inputDelay: 6, netSeed: 11 });
  while (rig.sessions[2].tick < 400) stepRig(rig, 100000);
  rig.sessions[2].leave();
  const remaining: Session<ToyInput>[] = [rig.sessions[0], rig.sessions[1]];
  const done = () => remaining.every((s) => s.tick >= 1500);
  let parked: number | null = null;
  for (let f = 0; f < 60 * 60 && !done(); f++) {
    const now = rig.frame * (1000 / 60);
    rig.net.advance(now);
    remaining.forEach((s, i) => {
      const due = rig.clocks[i].begin(now);
      rig.clocks[i].end(s.update(now, Math.max(0, Math.min(due, 1500 - s.tick))).ticks);
    });
    rig.frame++;
    if (parked === null && remaining[0].tick >= 600) parked = (remaining[0].sim as unknown as ToySim).memory.f.shipX[2];
  }
  const [a, b] = remaining;
  check('the leaver reports status left; the others keep playing', rig.sessions[2].status === 'left' && a.status === 'running' && b.status === 'running' && done());
  check('remaining peers are still bit-identical after a seat departs', hashEquals(a.sim.memory.hash(), b.sim.memory.hash()));
  const departed = (a.sim as unknown as ToySim).memory.f.shipX[2];
  check('the departed seat is absent for everyone: its ship never moves again', parked !== null && departed === parked, `x ${parked} -> ${departed}`);
}

finish('engine-lockstep');
