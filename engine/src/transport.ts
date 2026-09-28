/**
 * Datagram transport between peers. The session tolerates loss, duplication and reordering, so anything
 * from a WebRTC unreliable channel to a WebSocket relay to an in-process simulator can implement this.
 */
export interface Transport {
  /** Best-effort send of one datagram to a remote peer. Must not throw for an unreachable peer. */
  send(peer: number, data: Uint8Array): void;
  /** Installs (or clears) the single receiver. Called by the session. */
  setReceiver(receiver: ((peer: number, data: Uint8Array) => void) | null): void;
  close(): void;
}
