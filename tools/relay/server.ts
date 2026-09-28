/**
 * Dumb WebSocket relay + room matchmaker for lockstep co-op (development / self-hosting).
 *   node tools/relay/server.ts [port]        (default 4431)
 * It never inspects lockstep traffic: binary frames are [peer, ...payload] and are forwarded verbatim
 * ([destination] in, [origin] out). Only the tiny JSON room protocol below is understood:
 *   client -> {type:'hello', frame, difficulty}
 *   server -> {type:'welcome', peer, size}          on connect
 *   server -> {type:'start', seed, frames, difficulty, stage, delay}   once every seat said hello
 *   server -> {type:'left', peer}                    when someone disconnects
 * Test conditions for the lockstep traffic (never applied to the JSON room protocol), via environment:
 *   RELAY_LATENCY_MS, RELAY_JITTER_MS, RELAY_LOSS (0..1)   -> delayed, reordered and dropped datagrams
 */
import { WebSocketServer } from 'ws';
import type { RawData, WebSocket } from 'ws';

const PORT = Number(process.argv[2] ?? process.env.PORT ?? 4431);
const ROOM_SIZE = 2;
const INPUT_DELAY_TICKS = 6;
const MAX_FRAME_BYTES = 1024;
const LATENCY_MS = Number(process.env.RELAY_LATENCY_MS ?? 0);
const JITTER_MS = Number(process.env.RELAY_JITTER_MS ?? 0);
const LOSS = Number(process.env.RELAY_LOSS ?? 0);

interface Member {
  socket: WebSocket;
  peer: number;
  frame: number | null;
  difficulty: number;
}

interface Room {
  members: Array<Member | null>;
  started: boolean;
}

const rooms = new Map<string, Room>();
const wss = new WebSocketServer({ port: PORT, host: '127.0.0.1', maxPayload: MAX_FRAME_BYTES });

const send = (socket: WebSocket, message: object) => socket.send(JSON.stringify(message));

wss.on('connection', (socket, request) => {
  const room = new URL(request.url ?? '/', 'http://relay').searchParams.get('room') ?? 'lobby';
  let state = rooms.get(room);
  if (!state || state.started || state.members.every((m) => m === null)) {
    state = { members: new Array<Member | null>(ROOM_SIZE).fill(null), started: false };
    rooms.set(room, state);
  }
  const peer = state.members.findIndex((m) => m === null);
  if (peer < 0) {
    socket.close(1013, 'room full');
    return;
  }
  const member: Member = { socket, peer, frame: null, difficulty: 1 };
  state.members[peer] = member;
  const current = state;
  send(socket, { type: 'welcome', peer, size: ROOM_SIZE });

  socket.on('message', (data: RawData, isBinary: boolean) => {
    if (!isBinary) {
      let message: { type?: string; frame?: number; difficulty?: number };
      try {
        message = JSON.parse(data.toString()) as typeof message;
      } catch {
        return;
      }
      if (message.type !== 'hello') return;
      member.frame = Math.max(0, Math.min(2, Math.floor(Number(message.frame) || 0)));
      member.difficulty = Math.max(0, Math.min(2, Math.floor(Number(message.difficulty) ?? 1)));
      if (!current.started && current.members.every((m) => m !== null && m.frame !== null)) {
        current.started = true;
        const seed = Math.floor(Math.random() * 0xffffffff) >>> 0;
        const start = {
          type: 'start', seed, frames: current.members.map((m) => m!.frame), difficulty: current.members[0]!.difficulty, stage: 0, delay: INPUT_DELAY_TICKS,
        };
        for (const m of current.members) send(m!.socket, start);
      }
      return;
    }
    const bytes = data as Buffer;
    if (bytes.length < 2) return;
    const target = current.members[bytes[0]];
    if (!target || target === member) return;
    if (Math.random() < LOSS) return;
    const out = Buffer.from(bytes);
    out[0] = peer;
    const delay = Math.max(0, LATENCY_MS + (Math.random() * 2 - 1) * JITTER_MS);
    if (delay === 0) target.socket.send(out, { binary: true });
    else setTimeout(() => { if (target.socket.readyState === target.socket.OPEN) target.socket.send(out, { binary: true }); }, delay);
  });

  socket.on('close', () => {
    current.members[peer] = null;
    for (const m of current.members) if (m) send(m.socket, { type: 'left', peer });
    if (current.members.every((m) => m === null)) rooms.delete(room);
  });
});

wss.on('listening', () => console.log(`relay listening on ws://127.0.0.1:${PORT}/?room=<id>`));
