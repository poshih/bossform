/**
 * Engine hostile-input eval: packet bytes come from other machines, so garbage, spoofing, replayed-with-
 * different-content inputs and far-future ticks must never crash or corrupt a session. Uses the wire codec
 * directly (engine internals) to forge packets, which is exactly what a hostile peer could do.
 */
import { createSession, handshakeHash, hashEquals, SimulatedNetwork } from '@metronome/engine';
import type { Session, Transport } from '@metronome/engine';
import { encodeCheck, encodeFrame, encodeLeave } from '../../engine/src/wire.ts';
import { check, finish, section } from './lib.ts';
import { makeParams } from './harness.ts';
import { scriptedInput, toyCodec, toyFactory, ToySim } from './toy-sim.ts';
import type { ToyInput } from './toy-sim.ts';

const PARAMS = makeParams(2, 3);
const HANDSHAKE = handshakeHash(PARAMS, toyCodec.byteLength, new ToySim(PARAMS.seed, 2).memory.layoutHash);
const LAN = { latencyMs: 0, jitterMs: 0, lossRate: 0, duplicateRate: 0 };

function encodeInputs(seat: number, from: number, count: number): Uint8Array {
  const bytes = new Uint8Array(count * toyCodec.byteLength);
  for (let i = 0; i < count; i++) toyCodec.encode(scriptedInput(seat, from + i), bytes, i * toyCodec.byteLength);
  return bytes;
}

/** A victim session (peer 0) plus a raw endpoint standing in for peer 1. */
function setup() {
  const net = new SimulatedNetwork(LAN, 1);
  const victim = createSession({
    factory: toyFactory, codec: toyCodec, params: PARAMS, self: 0, seatOwners: [0, 1], transport: net.connect(0), sampleInput: scriptedInput,
  });
  const attacker: Transport = net.connect(1);
  let now = 0;
  const pump = (ticks = 1) => {
    net.advance(now);
    const result = victim.update(now, ticks);
    now += 1000 / 60;
    return result;
  };
  const legit = (from: number, count: number) => encodeFrame(1, HANDSHAKE, [{ seat: 1, frontier: PARAMS.inputDelay }], [{ seat: 1, start: from, count, bytes: encodeInputs(1, from, count) }]);
  return { net, victim, attacker, pump, legit };
}

function finalState(session: Session<ToyInput>) {
  return session.sim.memory.hash();
}

section('hostile packets');
{
  // Control run: only legitimate traffic.
  const control = setup();
  control.attacker.send(0, control.legit(PARAMS.inputDelay, 40));
  for (let i = 0; i < 60; i++) control.pump(4);
  check('control: victim runs on legitimate traffic', control.victim.tick === 40 + PARAMS.inputDelay, `tick ${control.victim.tick}`);

  // Same legitimate traffic mixed with heavy abuse.
  const t = setup();
  const seed = new Uint32Array([123456789, 362436069, 521288629, 88675123]);
  const nextByte = () => {
    seed[0] ^= seed[0] << 11;
    const w = seed[3];
    seed[3] = seed[2]; seed[2] = seed[1]; seed[1] = seed[0];
    seed[0] = (seed[0] ^ (seed[0] >>> 19) ^ w ^ (w >>> 8)) >>> 0;
    return seed[0] & 0xff;
  };
  let threw = false;
  try {
    t.attacker.send(0, t.legit(PARAMS.inputDelay, 40));
    for (let i = 0; i < 5000; i++) {
      const junk = new Uint8Array(1 + (nextByte() % 96));
      for (let k = 0; k < junk.length; k++) junk[k] = nextByte();
      if (i % 3 === 0) junk[0] = 1 + (i % 3);
      t.attacker.send(0, junk);
    }
    // Valid headers with lying bodies.
    const good = t.legit(PARAMS.inputDelay, 8);
    for (let cut = 1; cut < good.length; cut++) t.attacker.send(0, good.subarray(0, cut));
    t.attacker.send(0, encodeFrame(1, HANDSHAKE, [{ seat: 0, frontier: 1e9 }, { seat: 200, frontier: 5 }], []));
    t.attacker.send(0, encodeFrame(1, HANDSHAKE, [], [{ seat: 1, start: 4_000_000_000, count: 4, bytes: encodeInputs(1, 0, 4) }]));
    t.attacker.send(0, encodeFrame(1, HANDSHAKE, [], [{ seat: 0, start: 0, count: 4, bytes: encodeInputs(0, 0, 4) }]));
    t.attacker.send(0, encodeCheck(1, HANDSHAKE, 4_000_000_000, { lo: 1, hi: 2 }));
    for (let i = 0; i < 60; i++) t.pump(4);
  } catch (error) {
    threw = true;
    console.log(error);
  }
  check('5000 garbage packets, every truncation of a real packet, out-of-range acks/seats/ticks: no exception', !threw);
  check('abuse is counted and rejected', t.victim.stats.rejectedPackets > 1000, `${t.victim.stats.rejectedPackets} rejected`);
  check('spoofed seat (peer 1 sending seat 0) and far-future ticks did not change the outcome',
    t.victim.status === 'running' && t.victim.tick === control.victim.tick && hashEquals(finalState(t.victim), finalState(control.victim)));
}

section('conflicting inputs');
{
  const t = setup();
  t.attacker.send(0, t.legit(PARAMS.inputDelay, 10));
  for (let i = 0; i < 20; i++) t.pump(4);
  const forged = encodeInputs(1, 30, 1);
  const legitBytes = encodeInputs(1, 30, 1);
  forged[0] ^= 0x55;
  t.attacker.send(0, encodeFrame(1, HANDSHAKE, [], [{ seat: 1, start: 30, count: 1, bytes: legitBytes }]));
  t.pump(0);
  const running = t.victim.status === 'running';
  t.attacker.send(0, encodeFrame(1, HANDSHAKE, [], [{ seat: 1, start: 30, count: 1, bytes: forged }]));
  t.pump(0);
  check('an identical retransmission is harmless', running);
  check('the same tick re-sent with different content aborts the session (conflicting-input)', t.victim.status === 'aborted' && t.victim.abortReason === 'conflicting-input', `${t.victim.status}/${t.victim.abortReason}`);
}

section('leave semantics');
{
  const t = setup();
  t.attacker.send(0, t.legit(PARAMS.inputDelay, 20));
  t.attacker.send(0, encodeLeave(1, HANDSHAKE, PARAMS.inputDelay + 19));
  for (let i = 0; i < 200; i++) t.pump(4);
  check('a peer that leaves after its last input lets the others continue past it', t.victim.status === 'running' && t.victim.tick > 100, `tick ${t.victim.tick}`);
}

finish('engine-hostile');
