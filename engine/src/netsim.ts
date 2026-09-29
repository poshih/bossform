import { Rng } from './rng.ts';
import type { Transport } from './transport.ts';

/**
 * In-process network with configurable latency, jitter, loss, duplication and partitions, driven by a
 * virtual clock and a seeded generator: a lockstep run over it is exactly reproducible. It exists to prove
 * the session survives hostile networks; games can use it to test their own netcode paths too.
 */
export interface NetworkConditions {
  readonly latencyMs: number;
  readonly jitterMs: number;
  /** 0..1 */
  readonly lossRate: number;
  /** 0..1 */
  readonly duplicateRate: number;
}

interface InFlight {
  readonly deliverAt: number;
  readonly order: number;
  readonly from: number;
  readonly to: number;
  readonly data: Uint8Array;
}

const TWO_POW_32 = 4294967296;

class Endpoint implements Transport {
  receiver: ((peer: number, data: Uint8Array) => void) | null = null;
  private readonly net: SimulatedNetwork;
  private readonly id: number;

  constructor(net: SimulatedNetwork, id: number) {
    this.net = net;
    this.id = id;
  }

  send(peer: number, data: Uint8Array): void {
    this.net.enqueue(this.id, peer, data);
  }

  broadcast(data: Uint8Array): void {
    this.net.broadcast(this.id, data);
  }

  setReceiver(receiver: ((peer: number, data: Uint8Array) => void) | null): void {
    this.receiver = receiver;
  }

  close(): void {
    this.receiver = null;
  }
}

export class SimulatedNetwork {
  private conditions: NetworkConditions;
  private readonly rng = new Rng(new Uint32Array(4));
  private readonly endpoints = new Map<number, Endpoint>();
  private readonly severed = new Set<string>();
  private queue: InFlight[] = [];
  private counter = 0;
  private now = 0;
  delivered = 0;
  dropped = 0;

  constructor(conditions: NetworkConditions, seed: number) {
    this.conditions = conditions;
    this.rng.seed(seed);
  }

  connect(peer: number): Transport {
    const endpoint = new Endpoint(this, peer);
    this.endpoints.set(peer, endpoint);
    return endpoint;
  }

  setConditions(conditions: NetworkConditions): void {
    this.conditions = conditions;
  }

  /** Cuts (or restores) the link between two peers in both directions. */
  sever(a: number, b: number, cut: boolean): void {
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    if (cut) this.severed.add(key);
    else this.severed.delete(key);
  }

  enqueue(from: number, to: number, data: Uint8Array): void {
    const key = from < to ? `${from}:${to}` : `${to}:${from}`;
    if (this.severed.has(key) || this.unit() < this.conditions.lossRate) {
      this.dropped++;
      return;
    }
    const copies = this.unit() < this.conditions.duplicateRate ? 2 : 1;
    for (let i = 0; i < copies; i++) {
      const jitter = (this.unit() * 2 - 1) * this.conditions.jitterMs;
      const deliverAt = this.now + Math.max(0, this.conditions.latencyMs + jitter);
      this.queue.push({ deliverAt, order: this.counter++, from, to, data: data.slice() });
    }
  }

  broadcast(from: number, data: Uint8Array): void {
    for (const peer of this.endpoints.keys()) {
      if (peer === from) continue;
      this.enqueue(from, peer, data);
    }
  }

  /** Advances the virtual clock and delivers every packet that has arrived, in deterministic order. */
  advance(nowMs: number): void {
    this.now = nowMs;
    if (this.queue.length === 0) return;
    const due = this.queue.filter((p) => p.deliverAt <= nowMs).sort((a, b) => a.deliverAt - b.deliverAt || a.order - b.order);
    if (due.length === 0) return;
    this.queue = this.queue.filter((p) => p.deliverAt > nowMs);
    for (const packet of due) {
      const target = this.endpoints.get(packet.to);
      if (target?.receiver) {
        target.receiver(packet.from, packet.data);
        this.delivered++;
      }
    }
  }

  private unit(): number {
    return this.rng.nextU32() / TWO_POW_32;
  }
}
