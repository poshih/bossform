/**
 * Dumb WebSocket relay + room lobby (development / self-hosting). It knows nothing about the game.
 *   node tools/relay/server.ts [port]        (default 4431)
 * Binary frames carry lockstep traffic: [peer u16 LE, ...payload], forwarded verbatim after rewriting the u16
 * ([destination] in, [origin] out; 0xFFFF = everyone else in the room). Text frames are the room protocol; every
 * `data` string is opaque to the relay (the game defines it, the relay only caps its size):
 *   server -> {type:'welcome', peer, capacity}                              on connect
 *   server -> {type:'room', host, members:[{peer, data}], settings, started}   whenever the room changes
 *   client -> {type:'member', data}          set this member's own data
 *   client -> {type:'settings', data}        host only (the lowest peer id): room-wide settings
 *   client -> {type:'start', data}           host only: closes the room; every member receives {type:'start', data, peer}
 *   server -> {type:'left', peer}            a member disconnected
 * Test conditions for the lockstep traffic (never applied to the room protocol), via environment:
 *   RELAY_LATENCY_MS, RELAY_JITTER_MS, RELAY_LOSS (0..1)   -> delayed, reordered and dropped datagrams
 *   ROOM_CAPACITY                                          -> members per room (default 8)
 */
import { WebSocketServer } from 'ws';
import type { RawData, WebSocket } from 'ws';

const PORT = Number(process.argv[2] ?? process.env.PORT ?? 4431);
const ROOM_CAPACITY = Number(process.env.ROOM_CAPACITY ?? 8);
const MAX_FRAME_BYTES = 1024;
const MAX_MEMBER_DATA_CHARS = 200;
const MAX_SETTINGS_CHARS = 1500;
const MAX_START_CHARS = 4000;
const LATENCY_MS = Number(process.env.RELAY_LATENCY_MS ?? 0);
const JITTER_MS = Number(process.env.RELAY_JITTER_MS ?? 0);
const LOSS = Number(process.env.RELAY_LOSS ?? 0);
const RELAY_HEADER_BYTES = 2;
const BROADCAST_PEER = 0xffff;
const CLOSE_TRY_AGAIN_LATER = 1013;
/** Text frames may be longer than binary ones (the start payload lists every seat). */
const MAX_TEXT_BYTES = 8192;

interface Member {
  socket: WebSocket;
  peer: number;
  data: string;
}

interface Room {
  members: Array<Member | null>;
  settings: string;
  started: boolean;
}

const rooms = new Map<string, Room>();
const wss = new WebSocketServer({ port: PORT, host: '127.0.0.1', maxPayload: MAX_TEXT_BYTES });

const send = (socket: WebSocket, message: object) => socket.send(JSON.stringify(message));
const present = (room: Room): Member[] => room.members.filter((m): m is Member => m !== null);
const hostOf = (room: Room): number => present(room)[0].peer;

function broadcastRoom(room: Room): void {
  const message = { type: 'room', host: hostOf(room), members: present(room).map((m) => ({ peer: m.peer, data: m.data })), settings: room.settings, started: room.started };
  for (const m of present(room)) send(m.socket, message);
}

function forwardBinary(sender: Member, peers: readonly (Member | null)[], data: Buffer): void {
  if (data.length < RELAY_HEADER_BYTES || data.length > MAX_FRAME_BYTES) return;
  const destination = data.readUInt16LE(0);
  const payload = data.subarray(RELAY_HEADER_BYTES);
  if (destination === BROADCAST_PEER) {
    for (const peer of peers) {
      if (!peer || peer === sender) continue;
      scheduleBinary(peer.socket, sender.peer, payload);
    }
    return;
  }
  const target = peers[destination];
  if (!target || target === sender) return;
  scheduleBinary(target.socket, sender.peer, payload);
}

function scheduleBinary(socket: WebSocket, origin: number, payload: Uint8Array): void {
  if (Math.random() < LOSS) return;
  const out = Buffer.allocUnsafe(RELAY_HEADER_BYTES + payload.length);
  out.writeUInt16LE(origin, 0);
  out.set(payload, RELAY_HEADER_BYTES);
  const delay = Math.max(0, LATENCY_MS + (Math.random() * 2 - 1) * JITTER_MS);
  if (delay === 0) {
    socket.send(out, { binary: true });
    return;
  }
  setTimeout(() => { if (socket.readyState === socket.OPEN) socket.send(out, { binary: true }); }, delay);
}

function handleText(room: Room, member: Member, raw: string): void {
  let message: { type?: string; data?: unknown };
  try {
    message = JSON.parse(raw) as typeof message;
  } catch {
    return;
  }
  if (typeof message.data !== 'string') return;
  const isHost = hostOf(room) === member.peer;
  switch (message.type) {
    case 'member':
      if (room.started || message.data.length > MAX_MEMBER_DATA_CHARS) return;
      member.data = message.data;
      broadcastRoom(room);
      break;
    case 'settings':
      if (room.started || !isHost || message.data.length > MAX_SETTINGS_CHARS) return;
      room.settings = message.data;
      broadcastRoom(room);
      break;
    case 'start':
      if (room.started || !isHost || message.data.length > MAX_START_CHARS) return;
      room.started = true;
      for (const m of present(room)) send(m.socket, { type: 'start', data: message.data, peer: m.peer });
      break;
    default:
  }
}

wss.on('connection', (socket, request) => {
  const name = new URL(request.url ?? '/', 'http://relay').searchParams.get('room') ?? 'lobby';
  let room = rooms.get(name);
  if (!room) {
    room = { members: new Array<Member | null>(ROOM_CAPACITY).fill(null), settings: '', started: false };
    rooms.set(name, room);
  }
  const peer = room.members.findIndex((m) => m === null);
  if (room.started || peer < 0) {
    socket.close(CLOSE_TRY_AGAIN_LATER, room.started ? 'match in progress' : 'room full');
    return;
  }
  const member: Member = { socket, peer, data: '' };
  room.members[peer] = member;
  const current = room;
  send(socket, { type: 'welcome', peer, capacity: ROOM_CAPACITY });
  broadcastRoom(current);

  socket.on('message', (data: RawData, isBinary: boolean) => {
    if (isBinary) forwardBinary(member, current.members, data as Buffer);
    else handleText(current, member, data.toString());
  });

  socket.on('close', () => {
    current.members[peer] = null;
    if (present(current).length === 0) {
      rooms.delete(name);
      return;
    }
    for (const m of present(current)) send(m.socket, { type: 'left', peer });
    broadcastRoom(current);
  });
});

wss.on('listening', () => console.log(`relay listening on ws://127.0.0.1:${PORT}/?room=<id>`));
