import type { Transport } from './transport.ts';

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

export interface RelayOptions {
  /** Text frames (room membership, start signals...) are game/app protocol, not lockstep traffic. */
  readonly onControl?: (text: string) => void;
  readonly onClose?: () => void;
}

/**
 * Lockstep over a dumb WebSocket relay. Binary frames are [peerId, ...payload]: the peer id is the
 * destination when sending and the origin when receiving; the relay only forwards. Packets that arrive
 * before a receiver is installed (the room-start window) are buffered instead of lost.
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
      if (!(payload instanceof ArrayBuffer) || payload.byteLength < 1) return;
      const bytes = new Uint8Array(payload);
      const data = bytes.subarray(1);
      if (this.receiver) this.receiver(bytes[0], data);
      else if (this.buffered.length < MAX_BUFFERED_PACKETS) this.buffered.push({ peer: bytes[0], data });
    };
    socket.onclose = () => opts.onClose?.();
  }

  send(peer: number, data: Uint8Array): void {
    if (this.socket.readyState !== SOCKET_OPEN) return;
    const frame = new Uint8Array(data.length + 1);
    frame[0] = peer;
    frame.set(data, 1);
    this.socket.send(frame);
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
}
