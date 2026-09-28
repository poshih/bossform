import { RelayTransport } from '@metronome/engine';
import type { SocketLike } from '@metronome/engine';
import type { OnlineStart } from '../app.ts';

/** What the relay tells every client once both seats are filled. */
interface StartMessage {
  type: 'start';
  seed: number;
  frames: number[];
  difficulty: number;
  stage: number;
  delay: number;
}

interface WelcomeMessage {
  type: 'welcome';
  peer: number;
  size: number;
}

const CONNECT_TIMEOUT_MS = 20000;

export interface LobbyRequest {
  readonly relayUrl: string;
  readonly room: string;
  readonly frame: number;
  readonly difficulty: number;
}

/** Joins a relay room and resolves when every seat has picked a frame and the match is ready to start. */
export function joinRoom(request: LobbyRequest, onStatus: (message: string) => void): Promise<OnlineStart> {
  return new Promise((resolve, reject) => {
    const url = new URL(request.relayUrl);
    url.searchParams.set('room', request.room);
    const socket = new WebSocket(url.toString());
    let peer = -1;
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('relay timed out'));
    }, CONNECT_TIMEOUT_MS);

    const transport = new RelayTransport(socket as unknown as SocketLike, {
      onControl: (raw) => {
        let message: WelcomeMessage | StartMessage | { type: 'left'; peer: number };
        try {
          message = JSON.parse(raw);
        } catch {
          return;
        }
        if (message.type === 'welcome') {
          peer = message.peer;
          onStatus(`ROOM ${request.room.toUpperCase()}  PLAYER ${peer + 1}/${message.size}  WAITING...`);
          socket.send(JSON.stringify({ type: 'hello', frame: request.frame, difficulty: request.difficulty }));
        } else if (message.type === 'start') {
          clearTimeout(timer);
          const seats = message.frames.length;
          resolve({
            label: `ONLINE  P${peer + 1}  DELAY ${message.delay}T`,
            setup: { seats, frames: message.frames, difficulty: message.difficulty, stage: message.stage, seed: message.seed },
            network: { transport, self: peer, seatOwners: message.frames.map((_, seat) => seat), inputDelay: message.delay },
          });
        }
      },
      onClose: () => {
        clearTimeout(timer);
        reject(new Error('relay connection closed'));
      },
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('could not reach the relay'));
    });
  });
}
