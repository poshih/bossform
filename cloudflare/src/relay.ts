import { DurableObject } from 'cloudflare:workers';
import { BROADCAST_PEER } from '@metronome/engine';
import {
  DEFAULT_ROOM_CAPACITY,
  MAX_FRAME_BYTES,
  MAX_MEMBER_DATA_CHARS,
  MAX_SETTINGS_CHARS,
  MAX_START_CHARS,
  MAX_TEXT_BYTES,
  RELAY_HEADER_BYTES,
} from '../../tools/relay/protocol.ts';
import type { RelayControlMessage } from '../../tools/relay/protocol.ts';

const ROOM_STATE_KEY = 'room';
const MAX_ROOM_CHARS = 64;
const SOCKET_OPEN = 1;

interface Env {
  readonly ROOMS: DurableObjectNamespace<RelayRoom>;
}

interface Connection {
  readonly peer: number;
  readonly data: string;
}

interface Member extends Connection {
  readonly socket: WebSocket;
}

interface RoomState {
  readonly settings: string;
  readonly started: boolean;
}

const emptyRoom = (): RoomState => ({ settings: '', started: false });
const textEncoder = new TextEncoder();

function connectionOf(socket: WebSocket): Connection | null {
  const value: unknown = socket.deserializeAttachment();
  if (typeof value !== 'object' || value === null) return null;
  const peer = Reflect.get(value, 'peer');
  const data = Reflect.get(value, 'data');
  return typeof peer === 'number' && Number.isInteger(peer) && peer >= 0 && peer < DEFAULT_ROOM_CAPACITY && typeof data === 'string'
    ? { peer, data }
    : null;
}

function sendJson(socket: WebSocket, message: object): void {
  if (socket.readyState === SOCKET_OPEN) socket.send(JSON.stringify(message));
}

function sendBinary(socket: WebSocket, origin: number, payload: Uint8Array): void {
  if (socket.readyState !== SOCKET_OPEN) return;
  const out = new Uint8Array(RELAY_HEADER_BYTES + payload.length);
  new DataView(out.buffer).setUint16(0, origin, true);
  out.set(payload, RELAY_HEADER_BYTES);
  socket.send(out);
}

export class RelayRoom extends DurableObject<Env> {
  private room: RoomState = emptyRoom();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      this.room = (await this.ctx.storage.get<RoomState>(ROOM_STATE_KEY)) ?? emptyRoom();
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected a WebSocket upgrade', { status: 426, headers: { Upgrade: 'websocket' } });
    }
    const members = this.members();
    if (this.room.started) return new Response('Match already in progress', { status: 409 });
    if (members.length >= DEFAULT_ROOM_CAPACITY) return new Response('Room is full', { status: 409 });

    const used = new Set(members.map((member) => member.peer));
    let peer = 0;
    while (used.has(peer)) peer++;

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ peer, data: '' } satisfies Connection);
    sendJson(server, { type: 'welcome', peer, capacity: DEFAULT_ROOM_CAPACITY });
    this.broadcastRoom();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket: WebSocket, message: ArrayBuffer | string): Promise<void> {
    const sender = connectionOf(socket);
    if (sender === null) {
      socket.close(1011, 'Missing relay connection state');
      return;
    }
    if (typeof message === 'string') {
      if (textEncoder.encode(message).byteLength <= MAX_TEXT_BYTES) await this.handleText(socket, sender, message);
      return;
    }
    this.forwardBinary(sender, message);
  }

  async webSocketClose(socket: WebSocket): Promise<void> {
    const departed = connectionOf(socket);
    if (departed === null) return;
    const members = this.members(socket);
    if (members.length === 0) {
      this.room = emptyRoom();
      await this.ctx.storage.delete(ROOM_STATE_KEY);
      return;
    }
    for (const member of members) sendJson(member.socket, { type: 'left', peer: departed.peer });
    this.broadcastRoom(members);
  }

  private members(exclude?: WebSocket): Member[] {
    const members: Member[] = [];
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === exclude || socket.readyState !== SOCKET_OPEN) continue;
      const connection = connectionOf(socket);
      if (connection !== null) members.push({ ...connection, socket });
    }
    members.sort((a, b) => a.peer - b.peer);
    return members;
  }

  private broadcastRoom(members = this.members()): void {
    const host = members[0]?.peer;
    if (host === undefined) return;
    const message = {
      type: 'room',
      host,
      members: members.map(({ peer, data }) => ({ peer, data })),
      settings: this.room.settings,
      started: this.room.started,
    };
    for (const member of members) sendJson(member.socket, message);
  }

  private async handleText(socket: WebSocket, sender: Connection, text: string): Promise<void> {
    let message: RelayControlMessage;
    try {
      message = JSON.parse(text) as RelayControlMessage;
    } catch {
      return;
    }
    if (typeof message.data !== 'string' || this.room.started) return;
    const members = this.members();
    const isHost = members[0]?.peer === sender.peer;
    switch (message.type) {
      case 'member':
        if (message.data.length > MAX_MEMBER_DATA_CHARS) return;
        socket.serializeAttachment({ peer: sender.peer, data: message.data } satisfies Connection);
        this.broadcastRoom();
        break;
      case 'settings':
        if (!isHost || message.data.length > MAX_SETTINGS_CHARS) return;
        this.room = { ...this.room, settings: message.data };
        await this.ctx.storage.put(ROOM_STATE_KEY, this.room);
        this.broadcastRoom();
        break;
      case 'start':
        if (!isHost || message.data.length > MAX_START_CHARS) return;
        this.room = { ...this.room, started: true };
        await this.ctx.storage.put(ROOM_STATE_KEY, this.room);
        for (const member of members) sendJson(member.socket, { type: 'start', data: message.data, peer: member.peer });
        break;
      default:
    }
  }

  private forwardBinary(sender: Connection, message: ArrayBuffer): void {
    const bytes = new Uint8Array(message);
    if (bytes.length < RELAY_HEADER_BYTES || bytes.length > MAX_FRAME_BYTES) return;
    const destination = new DataView(message).getUint16(0, true);
    const payload = bytes.subarray(RELAY_HEADER_BYTES);
    const members = this.members();
    if (destination === BROADCAST_PEER) {
      for (const member of members) {
        if (member.peer !== sender.peer) sendBinary(member.socket, sender.peer, payload);
      }
      return;
    }
    const target = members.find((member) => member.peer === destination);
    if (target !== undefined && target.peer !== sender.peer) sendBinary(target.socket, sender.peer, payload);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return new Response('BOSSFORM relay ready', {
        headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('BOSSFORM WebSocket relay', { status: 200 });
    }
    const room = (url.searchParams.get('room') ?? 'lobby').trim() || 'lobby';
    if (room.length > MAX_ROOM_CHARS || /[\u0000-\u001f\u007f]/.test(room)) {
      return new Response('Invalid room name', { status: 400 });
    }
    return env.ROOMS.getByName(room).fetch(request);
  },
} satisfies ExportedHandler<Env>;
