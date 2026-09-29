import type { Transport } from './transport.ts';
import { BROADCAST_PEER } from './wire.ts';

/**
 * The slice of the WebSocket API the relay transport needs. Structural on purpose: the engine has no DOM or
 * Node dependency, so callers pass in whatever WebSocket implementation their platform provides.
 */
export interface SocketLike {
  binaryType: string;
  readyState: number;
  send(data: Uint8Array): void;
  close(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
}

const SOCKET_OPEN = 1;
const MAX_BUFFERED_PACKETS = 512;
const RELAY_HEADER_BYTES = 2;

export interface RelayOptions {
  /** Text frames (room membership, start signals...) are game/app protocol, not lockstep traffic. */
  readonly onControl?: (text: string) => void;
  readonly onClose?: () => void;
}

/**
 * Lockstep over a dumb WebSocket relay. Binary frames are [peerId u16 LE, ...payload]: the peer id is the
 * destination when sending and the origin when receiving. BROADCAST_PEER as a destination means "fan this
 * packet out to everyone else in the room". Packets that arrive before a receiver is installed (the room-
 * start window) are buffered instead of lost.
 */
export class RelayTransport implements Transport {
  private readonly socket: SocketLike;
  private receiver: ((peer: number, data: Uint8Array) => void) | null = null;
  private buffered: Array<{ peer: number; data: Uint8Array }> = [];

  constructor(socket: SocketLike, opts: RelayOptions = {}) {
    this.socket = socket;
    socket.binaryType = 'arraybuffer';
    socket.onmessage = (event) => {
      const payload = event.data;
      if (typeof payload === 'string') {
        opts.onControl?.(payload);
        return;
      }
      if (!(payload instanceof ArrayBuffer) || payload.byteLength < RELAY_HEADER_BYTES) return;
      const bytes = new Uint8Array(payload);
      const peer = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(0, true);
      const data = bytes.subarray(RELAY_HEADER_BYTES);
      if (this.receiver) this.receiver(peer, data);
      else if (this.buffered.length < MAX_BUFFERED_PACKETS) this.buffered.push({ peer, data });
    };
    socket.onclose = () => opts.onClose?.();
  }

  send(peer: number, data: Uint8Array): void {
    this.sendFrame(peer, data);
  }

  broadcast(data: Uint8Array): void {
    this.sendFrame(BROADCAST_PEER, data);
  }

  setReceiver(receiver: ((peer: number, data: Uint8Array) => void) | null): void {
    this.receiver = receiver;
    if (receiver === null) return;
    const pending = this.buffered;
    this.buffered = [];
    for (const p of pending) receiver(p.peer, p.data);
  }

  close(): void {
    this.receiver = null;
    this.socket.close();
  }

  private sendFrame(peer: number, data: Uint8Array): void {
    if (this.socket.readyState !== SOCKET_OPEN) return;
    const frame = new Uint8Array(data.length + RELAY_HEADER_BYTES);
    new DataView(frame.buffer).setUint16(0, peer, true);
    frame.set(data, RELAY_HEADER_BYTES);
    this.socket.send(frame);
  }
}
