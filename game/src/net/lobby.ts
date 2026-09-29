import { RelayTransport } from '@metronome/engine';
import type { SocketLike, Transport } from '@metronome/engine';
import { FRAME_COUNT, MAX_PLAYERS, MIN_TEAMS, Mode, MODE_COUNT, TEAM_LIMIT } from '../sim/index.ts';
import type { LobbyEdits, LobbyPlayer, LobbyState, LobbyStatus, MatchSetup, PilotSetup } from '../setup.ts';
import { DEFAULT_NAMES } from '../setup.ts';

/**
 * The online lobby, over the dev relay (tools/relay/server.ts). The relay knows nothing about this game: it keeps
 * one opaque string per member and one for the room's settings, and tells everyone who the host is. This module
 * defines what those strings contain, validates them (they come from other machines) and turns them into a
 * LobbyState for the menus. Bots are owned by the host machine (a machine may own many seats).
 */
const NAME_MAX_CHARS = 12;
const DEFAULT_INPUT_DELAY_TICKS = 6;
const CONNECT_TIMEOUT_MS = 15000;
const RANDOM_SEED_WORDS = 1;

interface MemberData {
  readonly name: string;
  readonly frame: number;
  readonly team: number;
}

interface Settings {
  readonly mode: number;
  readonly bots: readonly MemberData[];
}

/** What every machine needs to run the match the host started. */
export interface OnlineStart {
  readonly setup: MatchSetup;
  /** This machine's peer id. */
  readonly self: number;
  /** Peer that supplies each seat's input (humans own their own seat; the host owns every bot). */
  readonly seatOwners: readonly number[];
  readonly transport: Transport;
  readonly inputDelay: number;
}

export interface LobbyRequest {
  readonly relayUrl: string;
  readonly room: string;
  readonly name: string;
  readonly frame: number;
  readonly team: number;
  /** Ticks of input delay for the match (the host's choice). */
  readonly inputDelay?: number;
}

export interface LobbyHandlers {
  readonly onState: (state: LobbyState) => void;
  readonly onStart: (start: OnlineStart) => void;
}

function cleanName(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const cleaned = value.replace(/[^A-Za-z0-9 _-]/g, '').trim().toUpperCase().slice(0, NAME_MAX_CHARS);
  return cleaned.length > 0 ? cleaned : fallback;
}

const isInt = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

/** Parses another machine's member data; anything malformed becomes a plain default pilot, never an exception. */
function parseMember(text: string, index: number): MemberData {
  let raw: { n?: unknown; f?: unknown; t?: unknown } = {};
  try {
    raw = JSON.parse(text) as typeof raw;
  } catch {
    raw = {};
  }
  return {
    name: cleanName(raw.n, DEFAULT_NAMES[index % DEFAULT_NAMES.length]),
    frame: isInt(raw.f, 0, FRAME_COUNT - 1) ? raw.f : 0,
    team: isInt(raw.t, 0, TEAM_LIMIT - 1) ? raw.t : index,
  };
}

const encodeMember = (member: MemberData): string => JSON.stringify({ n: member.name, f: member.frame, t: member.team });

function parseSettings(text: string): Settings {
  let raw: { m?: unknown; b?: unknown } = {};
  try {
    raw = text.length > 0 ? (JSON.parse(text) as typeof raw) : {};
  } catch {
    raw = {};
  }
  const bots = Array.isArray(raw.b) ? raw.b.slice(0, MAX_PLAYERS).map((b: unknown, i: number) => parseMember(JSON.stringify(b), i)) : [];
  return { mode: isInt(raw.m, 0, MODE_COUNT - 1) ? raw.m : Mode.Elimination, bots };
}

const encodeSettings = (settings: Settings): string =>
  JSON.stringify({ m: settings.mode, b: settings.bots.map((b) => ({ n: b.name, f: b.frame, t: b.team })) });

interface RoomState {
  readonly host: number;
  readonly members: readonly { peer: number; data: string }[];
  readonly settings: string;
}

/** Any text frame from the relay; every field is unchecked until the handler validates it. */
interface IncomingText extends Partial<RoomState> {
  readonly type?: string;
  readonly peer?: number;
  readonly capacity?: number;
  readonly data?: string;
}

/** A relay room as one player sees it. Construct, react to onState, call edit / start / leave. */
export class RelayLobby {
  private readonly socket: WebSocket;
  private readonly transport: RelayTransport;
  private readonly request: LobbyRequest;
  private readonly handlers: LobbyHandlers;
  private peer = -1;
  private capacity = MAX_PLAYERS;
  private room: RoomState | null = null;
  private status: LobbyStatus = 'connecting';
  private message = 'CONNECTING...';
  private closed = false;
  private readonly timer: ReturnType<typeof setTimeout>;

  constructor(request: LobbyRequest, handlers: LobbyHandlers) {
    this.request = request;
    this.handlers = handlers;
    const url = new URL(request.relayUrl);
    url.searchParams.set('room', request.room);
    this.socket = new WebSocket(url.toString());
    this.timer = setTimeout(() => this.fail('THE RELAY DID NOT ANSWER'), CONNECT_TIMEOUT_MS);
    this.transport = new RelayTransport(this.socket as unknown as SocketLike, {
      onControl: (text) => this.onText(text),
      onClose: () => this.fail(this.status === 'starting' ? 'CONNECTION LOST' : 'THE RELAY CLOSED THE CONNECTION'),
    });
    this.socket.addEventListener('error', () => this.fail('COULD NOT REACH THE RELAY'));
    this.publish();
  }

  /** The local player's own pilot always; mode and bots only for the host (others' requests are ignored). */
  edit(edits: LobbyEdits): void {
    if (this.room === null || this.status !== 'waiting') return;
    const own = this.ownMember();
    if (edits.frame !== undefined || edits.team !== undefined) {
      const next: MemberData = {
        name: own.name,
        frame: edits.frame !== undefined && isInt(edits.frame, 0, FRAME_COUNT - 1) ? edits.frame : own.frame,
        team: edits.team !== undefined && isInt(edits.team, 0, TEAM_LIMIT - 1) ? edits.team : own.team,
      };
      this.socket.send(JSON.stringify({ type: 'member', data: encodeMember(next) }));
    }
    if (!this.isHost()) return;
    const settings = parseSettings(this.room.settings);
    let bots = [...settings.bots];
    if (edits.addBot === true && this.room.members.length + bots.length < this.capacityForPlayers()) {
      const used = new Set<number>([...this.room.members.map((m, i) => parseMember(m.data, i).team), ...bots.map((b) => b.team)]);
      let team = 0;
      while (used.has(team)) team++;
      bots = [...bots, { name: DEFAULT_NAMES[(this.room.members.length + bots.length) % DEFAULT_NAMES.length], frame: bots.length % FRAME_COUNT, team }];
    }
    if (edits.removeBot !== undefined) bots = bots.filter((_, i) => i !== edits.removeBot! - this.room!.members.length);
    const mode = edits.mode !== undefined && isInt(edits.mode, 0, MODE_COUNT - 1) ? edits.mode : settings.mode;
    this.socket.send(JSON.stringify({ type: 'settings', data: encodeSettings({ mode, bots }) }));
  }

  /** Host only: starts the match for everyone in the room. */
  start(): void {
    if (this.room === null || !this.isHost() || this.status !== 'waiting') return;
    const pilots = this.pilots();
    if (new Set(pilots.map((p) => p.team)).size < MIN_TEAMS) {
      this.message = `NEED AT LEAST ${MIN_TEAMS} TEAMS`;
      this.publish();
      return;
    }
    const settings = parseSettings(this.room.settings);
    const seed = crypto.getRandomValues(new Uint32Array(RANDOM_SEED_WORDS))[0];
    const owners = [...this.room.members.map((m) => m.peer), ...settings.bots.map(() => this.peer)];
    const payload = {
      seed,
      mode: settings.mode,
      delay: this.request.inputDelay ?? DEFAULT_INPUT_DELAY_TICKS,
      pilots: pilots.map((p) => ({ n: p.name, f: p.frame, t: p.team, b: p.bot ? 1 : 0 })),
      owners,
    };
    this.socket.send(JSON.stringify({ type: 'start', data: JSON.stringify(payload) }));
  }

  /** Leaves the room. The transport stays open if a match already started (the session owns it then). */
  leave(): void {
    this.closed = true;
    clearTimeout(this.timer);
    if (this.status !== 'starting') this.transport.close();
  }

  private isHost(): boolean {
    return this.room !== null && this.room.host === this.peer;
  }

  private capacityForPlayers(): number {
    return Math.min(this.capacity, MAX_PLAYERS);
  }

  private ownMember(): MemberData {
    const index = this.room!.members.findIndex((m) => m.peer === this.peer);
    return parseMember(this.room!.members[index].data, index);
  }

  private pilots(): PilotSetup[] {
    const room = this.room!;
    const humans = room.members.map((m, i) => ({ ...parseMember(m.data, i), bot: false }));
    const bots = parseSettings(room.settings).bots.map((b) => ({ ...b, bot: true }));
    return [...humans, ...bots].slice(0, this.capacityForPlayers()).map((p) => ({ name: p.name, frame: p.frame, team: p.team, bot: p.bot }));
  }

  private onText(text: string): void {
    let raw: IncomingText;
    try {
      raw = JSON.parse(text) as IncomingText;
    } catch {
      return;
    }
    if (raw.type === 'welcome' && isInt(raw.peer, 0, 0xfffe) && isInt(raw.capacity, 1, 0xfffe)) {
      clearTimeout(this.timer);
      this.peer = raw.peer;
      this.capacity = raw.capacity;
      this.status = 'waiting';
      this.message = 'WAITING FOR PLAYERS';
      this.socket.send(JSON.stringify({
        type: 'member',
        data: encodeMember({ name: cleanName(this.request.name, DEFAULT_NAMES[raw.peer % DEFAULT_NAMES.length]), frame: this.request.frame, team: this.request.team }),
      }));
    } else if (raw.type === 'room' && Array.isArray(raw.members) && typeof raw.settings === 'string' && isInt(raw.host, 0, 0xfffe)) {
      this.room = { host: raw.host, members: raw.members, settings: raw.settings };
      this.publish();
    } else if (raw.type === 'start' && typeof raw.data === 'string') {
      this.beginMatch(raw.data);
    }
  }

  private beginMatch(data: string): void {
    let raw: { seed?: unknown; mode?: unknown; delay?: unknown; pilots?: unknown; owners?: unknown };
    try {
      raw = JSON.parse(data) as typeof raw;
    } catch {
      this.fail('THE HOST SENT A BAD START MESSAGE');
      return;
    }
    const pilotList = Array.isArray(raw.pilots) ? raw.pilots : [];
    const owners = Array.isArray(raw.owners) ? raw.owners : [];
    const valid = isInt(raw.seed, 0, 0xffffffff) && isInt(raw.mode, 0, MODE_COUNT - 1) && isInt(raw.delay, 0, 30) && pilotList.length >= 2 &&
      pilotList.length === owners.length && owners.every((o) => isInt(o, 0, 0xfffe));
    if (!valid) {
      this.fail('THE HOST SENT A BAD START MESSAGE');
      return;
    }
    const pilots: PilotSetup[] = pilotList.map((p: { n?: unknown; f?: unknown; t?: unknown; b?: unknown }, i: number) => ({
      name: cleanName(p.n, DEFAULT_NAMES[i % DEFAULT_NAMES.length]),
      frame: isInt(p.f, 0, FRAME_COUNT - 1) ? p.f : 0,
      team: isInt(p.t, 0, TEAM_LIMIT - 1) ? p.t : i,
      bot: p.b === 1,
    }));
    this.status = 'starting';
    this.message = 'STARTING...';
    this.publish();
    this.handlers.onStart({
      setup: { mode: raw.mode as number, seed: raw.seed as number, pilots },
      self: this.peer,
      seatOwners: owners as number[],
      transport: this.transport,
      inputDelay: raw.delay as number,
    });
  }

  private fail(reason: string): void {
    if (this.closed || this.status === 'failed') return;
    clearTimeout(this.timer);
    this.status = 'failed';
    this.message = reason;
    this.publish();
  }

  private publish(): void {
    if (this.closed) return;
    const settings = this.room !== null ? parseSettings(this.room.settings) : { mode: Mode.Elimination, bots: [] };
    const humans: LobbyPlayer[] = (this.room?.members ?? []).map((m, i) => ({
      ...parseMember(m.data, i), bot: false, self: m.peer === this.peer, host: this.room !== null && m.peer === this.room.host,
    }));
    const bots: LobbyPlayer[] = settings.bots.map((b) => ({ ...b, bot: true, self: false, host: false }));
    this.handlers.onState({
      room: this.request.room,
      mode: settings.mode,
      maxPlayers: this.capacityForPlayers(),
      players: [...humans, ...bots].slice(0, this.capacityForPlayers()),
      host: this.isHost(),
      status: this.status,
      message: this.message,
    });
  }
}
