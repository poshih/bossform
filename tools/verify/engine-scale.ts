/**
 * Engine scale eval: protocol-v2 seat/peer widths, broadcast fan-out, multi-seat machines, replay bitsets,
 * relay framing, and hidden-cap regressions.
 */
import {
  BROADCAST_PEER,
  createSession,
  decodeReplay,
  encodeFrame,
  hashEquals,
  playReplay,
  RelayTransport,
  SimulatedNetwork,
  TickClock,
  validateParams,
  handshakeHash,
} from '@metronome/engine';
import type { Session, SocketLike, Transport } from '@metronome/engine';
import { check, finish, info, section } from './lib.ts';
import { FRAME_MS, makeParams, makeRig, referenceRun, runRig, stepRig } from './harness.ts';
import { scriptedInput, toyCodec, toyFactory, ToySim } from './toy-sim.ts';
import type { ToyInput } from './toy-sim.ts';

const HOSTILE = { latencyMs: 60, jitterMs: 30, lossRate: 0.08, duplicateRate: 0.05 };
const LOSSLESS = { latencyMs: 0, jitterMs: 0, lossRate: 0, duplicateRate: 0 };

function checkpointsMatch(a: Session<ToyInput>, b: Session<ToyInput>): boolean {
  const ra = decodeReplay(a.exportReplay()).checkpoints;
  const rb = decodeReplay(b.exportReplay()).checkpoints;
  return ra.length === rb.length && ra.every((c, i) => c.tick === rb[i].tick && hashEquals(c.hash, rb[i].hash));
}

function activeMaxStalls(rig: ReturnType<typeof makeRig>): number {
  return Math.max(...rig.sessions.map((s) => s.stats.stalledUpdates));
}

function measureBroadcastRate(peers: number, useBroadcast: boolean, targetTicks: number) {
  const net = new SimulatedNetwork(HOSTILE, peers + (useBroadcast ? 100 : 200));
  const seatOwners = Array.from({ length: peers }, (_, i) => i);
  const probes = seatOwners.map(() => ({ packets: 0, maxBytes: 0 }));
  const wrap = (transport: Transport, peer: number): Transport => ({
    send(target, data) {
      probes[peer].packets++;
      probes[peer].maxBytes = Math.max(probes[peer].maxBytes, data.length);
      transport.send(target, data);
    },
    broadcast: useBroadcast && typeof transport.broadcast === 'function'
      ? (data) => {
          probes[peer].packets++;
          probes[peer].maxBytes = Math.max(probes[peer].maxBytes, data.length);
          transport.broadcast!(data);
        }
      : undefined,
    setReceiver(receiver) { transport.setReceiver(receiver); },
    close() { transport.close(); },
  });
  const sessions = seatOwners.map((self) => createSession({
    factory: toyFactory,
    codec: toyCodec,
    params: makeParams(peers, 10),
    self,
    seatOwners,
    transport: wrap(net.connect(self), self),
    sampleInput: scriptedInput,
    recordReplay: true,
  }));
  const clocks = seatOwners.map(() => new TickClock({ tickRate: 60 }));
  let frame = 0;
  while (sessions.some((s) => s.tick < targetTicks) && frame < 60 * 120) {
    const now = frame * FRAME_MS;
    net.advance(now);
    sessions.forEach((session, i) => {
      const due = clocks[i].begin(now);
      const cap = Math.max(0, Math.min(due, targetTicks - session.tick));
      const result = session.update(now, cap);
      clocks[i].end(result.ticks);
    });
    frame++;
  }
  const seconds = targetTicks / 60;
  const avgPacketsPerSecond = probes.reduce((sum, probe) => sum + probe.packets / seconds, 0) / peers;
  const maxFrameBytes = Math.max(...probes.map((probe) => probe.maxBytes));
  return { sessions, avgPacketsPerSecond, maxFrameBytes };
}

section('validateParams protocol ceiling');
{
  let zeroRejected = false;
  let overRejected = false;
  validateParams(makeParams(0xffff, 6));
  try { validateParams(makeParams(0, 6)); } catch { zeroRejected = true; }
  try { validateParams(makeParams(0x10000, 6)); } catch { overRejected = true; }
  check('seats up to 0xFFFF are accepted, 0 and 0x10000 are rejected', zeroRejected && overRejected);
}

section('16 peers over hostile network with broadcast');
{
  const target = 1500;
  const rig = makeRig({
    peers: 16,
    conditions: HOSTILE,
    inputDelay: 10,
    netSeed: 16,
    specs: Array.from({ length: 16 }, (_, i) => ({ frameOffsetMs: i * 1.7 })),
  });
  const finished = runRig(rig, target, 240_000);
  const reference = referenceRun(16, 10, target);
  const sameFinal = rig.sessions.every((s) => hashEquals(s.sim.memory.hash(), reference.sim.memory.hash()));
  const sameCheckpoints = rig.sessions.every((s) => checkpointsMatch(s, reference));
  const maxStalls = activeMaxStalls(rig);
  check('16 peers with broadcast match the ideal run and recorded checkpoints', finished && sameFinal && sameCheckpoints, `stalls ${maxStalls}`);
  check('stalls stay bounded under the hostile profile', maxStalls <= 1400, `max stalled updates ${maxStalls}`);
  info(`final ${rig.sessions[0].tick} ticks, max stalled updates ${maxStalls}`);
}

section('16 peers without broadcast');
{
  const target = 1500;
  const rig = makeRig({
    peers: 16,
    conditions: HOSTILE,
    inputDelay: 10,
    netSeed: 17,
    useBroadcast: false,
    specs: Array.from({ length: 16 }, (_, i) => ({ frameOffsetMs: i * 1.7 })),
  });
  const finished = runRig(rig, target, 240_000);
  const reference = referenceRun(16, 10, target);
  check('per-peer send fallback reaches the same final hash', finished && rig.sessions.every((s) => hashEquals(s.sim.memory.hash(), reference.sim.memory.hash())));
}

section('20 seats across 3 machines, graceful leave, replay v2');
{
  const seatOwners = [
    ...Array.from({ length: 12 }, () => 0),
    ...Array.from({ length: 5 }, () => 1),
    ...Array.from({ length: 3 }, () => 2),
  ];
  const rig = makeRig({ peers: 3, seatOwners, conditions: HOSTILE, inputDelay: 10, netSeed: 33, specs: [{ frameOffsetMs: 0 }, { frameOffsetMs: 4 }, { frameOffsetMs: 9 }] });
  while (rig.sessions[0].tick < 240) stepRig(rig, 4000);
  rig.sessions[0].leave();
  const survivors = [rig.sessions[1], rig.sessions[2]];
  const done = () => survivors.every((s) => s.tick >= 900);
  while (!done() && rig.frame < 60 * 120) stepRig(rig, 900);
  const sameFinal = hashEquals(survivors[0].sim.memory.hash(), survivors[1].sim.memory.hash());
  const sameCheckpoints = checkpointsMatch(survivors[0], survivors[1]);
  const replay = decodeReplay(survivors[0].exportReplay());
  const replayResult = playReplay(replay, toyFactory, toyCodec);
  check('remaining machines agree after a 12/5/3 seat owner leaves', done() && rig.sessions[0].status === 'left' && sameFinal && sameCheckpoints);
  check('20-seat replay v2 round-trips to the same final hash and checkpoints', replay.params.seats === 20 && replayResult.ok && hashEquals(replayResult.finalHash, survivors[0].sim.memory.hash()));
  info(`replay bytes ${survivors[0].exportReplay().length} for ${replay.tickCount} ticks, ${replay.checkpoints.length} checkpoints`);
}

section('spoofed seat from a multi-seat owner is rejected');
{
  const params = makeParams(4, 4);
  const handshake = handshakeHash(params, toyCodec.byteLength, new ToySim(params.seed, 4).memory.layoutHash);
  const net = new SimulatedNetwork(LOSSLESS, 99);
  const victim = createSession({
    factory: toyFactory,
    codec: toyCodec,
    params,
    self: 0,
    seatOwners: [0, 1, 1, 2],
    transport: net.connect(0),
    sampleInput: scriptedInput,
  });
  const attacker = net.connect(1);
  const pump = (frames: number) => {
    for (let i = 0; i < frames; i++) {
      const now = i * FRAME_MS;
      net.advance(now);
      victim.update(now, 8);
    }
  };
  attacker.send(0, encodeFrame(1, handshake, [], [{ seat: 3, start: params.inputDelay, count: 1, bytes: new Uint8Array(toyCodec.byteLength) }]));
  pump(8);
  check('a peer that owns seats 1 and 2 is rejected when it sends seat 3', victim.stats.rejectedPackets > 0 && victim.status === 'connecting', `${victim.stats.rejectedPackets} rejected`);
}

section('frame size and packets/s stay flat in broadcast mode');
{
  const eight = measureBroadcastRate(8, true, 900);
  const sixteen = measureBroadcastRate(16, true, 900);
  const sixteenFallback = measureBroadcastRate(16, false, 900);
  const delta = Math.abs(eight.avgPacketsPerSecond - sixteen.avgPacketsPerSecond);
  check('16-peer FRAME bytes stay under 1200', sixteen.maxFrameBytes < 1200, `${sixteen.maxFrameBytes} B`);
  check('broadcast packets/s per peer stay effectively constant as peer count doubles', delta <= 2, `${eight.avgPacketsPerSecond.toFixed(1)} vs ${sixteen.avgPacketsPerSecond.toFixed(1)}`);
  check('fallback emits materially more packets than broadcast at 16 peers', sixteenFallback.avgPacketsPerSecond > sixteen.avgPacketsPerSecond * 4,
    `${sixteenFallback.avgPacketsPerSecond.toFixed(1)} vs ${sixteen.avgPacketsPerSecond.toFixed(1)}`);
  info(`broadcast 8p ${eight.avgPacketsPerSecond.toFixed(1)} pkt/s per peer, 16p ${sixteen.avgPacketsPerSecond.toFixed(1)}, fallback 16p ${sixteenFallback.avgPacketsPerSecond.toFixed(1)}, max frame ${sixteen.maxFrameBytes} B`);
}

class FakeRelayHub {
  private readonly sockets: FakeSocket[] = [];

  connect(): FakeSocket {
    const socket = new FakeSocket(this, this.sockets.length);
    this.sockets.push(socket);
    return socket;
  }

  forward(from: number, data: Uint8Array): void {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const destination = view.getUint16(0, true);
    const payload = data.subarray(2);
    if (destination === BROADCAST_PEER) {
      for (const target of this.sockets) {
        if (target.id === from) continue;
        target.deliver(this.wrap(from, payload));
      }
      return;
    }
    const target = this.sockets[destination];
    if (!target || target.id === from) return;
    target.deliver(this.wrap(from, payload));
  }

  private wrap(origin: number, payload: Uint8Array): Uint8Array {
    const out = new Uint8Array(payload.length + 2);
    new DataView(out.buffer).setUint16(0, origin, true);
    out.set(payload, 2);
    return out;
  }
}

class FakeSocket implements SocketLike {
  binaryType = 'arraybuffer';
  readyState = 1;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  readonly id: number;
  private readonly hub: FakeRelayHub;

  constructor(hub: FakeRelayHub, id: number) {
    this.hub = hub;
    this.id = id;
  }

  send(data: Uint8Array): void {
    this.hub.forward(this.id, data);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.({});
  }

  deliver(data: Uint8Array): void {
    const arrayBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    this.onmessage?.({ data: arrayBuffer });
  }
}

section('relay transport u16 framing and broadcast fan-out');
{
  const hub = new FakeRelayHub();
  const sockets = [hub.connect(), hub.connect(), hub.connect(), hub.connect()];
  const transports = sockets.map((socket) => new RelayTransport(socket));
  const inbox = transports.map(() => new Array<{ peer: number; data: Uint8Array }>());
  transports.forEach((transport, index) => transport.setReceiver((peer, data) => inbox[index].push({ peer, data })));
  transports[0].send(2, Uint8Array.from([7, 8, 9]));
  transports[1].broadcast!(Uint8Array.from([5, 4, 3, 2]));
  check('direct send arrives only at its u16 destination with origin rewritten', inbox[2].some((m) => m.peer === 0 && m.data.length === 3 && m.data[0] === 7) && inbox[0].length === 1 && inbox[1].length === 0);
  check('broadcast fans out to every other relay transport', inbox[0].some((m) => m.peer === 1 && m.data[0] === 5) && inbox[2].some((m) => m.peer === 1 && m.data[0] === 5) && inbox[3].some((m) => m.peer === 1 && m.data[0] === 5));
}

section('64 peers prove there is no hidden cap');
{
  const target = 240;
  const rig = makeRig({ peers: 64, conditions: LOSSLESS, inputDelay: 6, netSeed: 64 });
  const finished = runRig(rig, target, 180_000);
  const reference = referenceRun(64, 6, target);
  check('64 peers (1 seat each) finish and match the ideal local run', finished && rig.sessions.every((s) => hashEquals(s.sim.memory.hash(), reference.sim.memory.hash())));
  info(`64-peer packets out per session ${rig.sessions[0].stats.packetsOut}, final ${rig.sessions[0].tick} ticks`);
}

finish('engine-scale');
