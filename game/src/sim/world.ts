import { Rng, SimMemory } from '@metronome/engine';
import type { MemoryViews, SimInit } from '@metronome/engine';
import {
  ARENA_RADIUS_LIMIT, arenaRadius, capacityFor, MAX_PARTS, MIN_TEAMS, Mode, MODE_COUNT, NO_WINNER, Phase,
} from './constants.ts';
import type { Capacity } from './constants.ts';
import { EventQueue } from './events.ts';
import { FRAME_COUNT, FRAME_STATS } from './frames.ts';
import { layoutFor, W } from './layout.ts';

export type Layout = ReturnType<typeof layoutFor>;
export type Mem = MemoryViews<Layout>;

export interface SeatConfig {
  readonly frame: number;
  readonly team: number;
}

/** How a match is set up: the lobby's agreement, carried to every peer in SimInit.config. */
export interface MatchConfig {
  readonly mode: number;
  readonly seats: readonly SeatConfig[];
}

const CONFIG_HEADER_BYTES = 1;
const CONFIG_BYTES_PER_SEAT = 2;

/** Bytes: [mode, (frame, team) per seat]. Throws on anything the simulation could not run. */
export function encodeConfig(config: MatchConfig): Uint8Array {
  const out = new Uint8Array(CONFIG_HEADER_BYTES + CONFIG_BYTES_PER_SEAT * config.seats.length);
  out[0] = config.mode;
  config.seats.forEach((seat, i) => {
    out[CONFIG_HEADER_BYTES + i * CONFIG_BYTES_PER_SEAT] = seat.frame;
    out[CONFIG_HEADER_BYTES + i * CONFIG_BYTES_PER_SEAT + 1] = seat.team;
  });
  decodeConfig(out, config.seats.length);
  return out;
}

/** The one validator for match configuration; the bytes come from another machine, so it rejects loudly. */
export function decodeConfig(bytes: Uint8Array, seats: number): MatchConfig {
  const expected = CONFIG_HEADER_BYTES + CONFIG_BYTES_PER_SEAT * seats;
  if (bytes.length !== expected) throw new RangeError(`match config needs ${expected} bytes for ${seats} seats (got ${bytes.length})`);
  const mode = bytes[0];
  if (mode >= MODE_COUNT) throw new RangeError(`match config: unknown mode ${mode}`);
  const list: SeatConfig[] = [];
  const teams: number[] = [];
  for (let seat = 0; seat < seats; seat++) {
    const frame = bytes[CONFIG_HEADER_BYTES + seat * CONFIG_BYTES_PER_SEAT];
    const team = bytes[CONFIG_HEADER_BYTES + seat * CONFIG_BYTES_PER_SEAT + 1];
    if (frame >= FRAME_COUNT) throw new RangeError(`match config: seat ${seat} has unknown frame ${frame}`);
    if (!teams.includes(team)) teams.push(team);
    list.push({ frame, team });
  }
  if (teams.length < MIN_TEAMS) throw new RangeError(`match config: needs at least ${MIN_TEAMS} teams`);
  return { mode, seats: list };
}

/** Owner of the arena, the RNG and the event queue; passed explicitly to every simulation function. */
export class World {
  readonly memory: SimMemory<Layout>;
  readonly m: Mem;
  readonly rng: Rng;
  readonly events = new EventQueue();
  readonly seats: number;
  readonly cap: Capacity;
  readonly config: MatchConfig;
  readonly arenaR: number;
  /**
   * Boss-part centres, rebuilt from memory at the top of every collision pass and only read within that
   * pass. A cache, not state: nothing carries over from one tick to the next.
   */
  readonly partX: Int32Array;
  readonly partY: Int32Array;

  constructor(init: SimInit) {
    this.seats = init.seats;
    this.config = decodeConfig(init.config, init.seats);
    this.arenaR = arenaRadius(init.seats);
    if (this.arenaR > ARENA_RADIUS_LIMIT) throw new RangeError(`${init.seats} seats need an arena beyond the fixed-point range`);
    this.cap = capacityFor(init.seats);
    this.memory = new SimMemory(layoutFor(this.cap));
    this.m = this.memory.f;
    this.rng = new Rng(this.m.rng);
    this.rng.seed(init.seed);
    this.partX = new Int32Array(this.cap.parts);
    this.partY = new Int32Array(this.cap.parts);

    const { m } = this;
    const w = m.world;
    w[W.SafeR] = this.arenaR;
    w[W.Winner] = NO_WINNER;
    w[W.Round] = 1;
    w[W.Phase] = Phase.Countdown;
    for (let i = 0; i < this.cap.projectiles; i++) m.pFree[i] = this.cap.projectiles - 1 - i;
    for (let i = 0; i < this.cap.neutrals; i++) m.nFree[i] = this.cap.neutrals - 1 - i;
    for (let i = 0; i < this.cap.orbs; i++) m.oFree[i] = this.cap.orbs - 1 - i;
    w[W.ProjFree] = this.cap.projectiles;
    w[W.NeutralFree] = this.cap.neutrals;
    w[W.OrbFree] = this.cap.orbs;
    this.config.seats.forEach((seat, i) => {
      m.plActive[i] = 1;
      m.plFrame[i] = seat.frame;
      m.plTeam[i] = seat.team;
      m.plHp[i] = FRAME_STATS[seat.frame].hp;
      m.plLastHit[i] = -1;
    });
  }

  get mode(): number {
    return this.config.mode;
  }

  get isDeathmatch(): boolean {
    return this.config.mode === Mode.Deathmatch;
  }

  /** Index of a seat's first part in the per-part arrays. */
  partBase(seat: number): number {
    return seat * MAX_PARTS;
  }

  // ---- pools ----
  allocProjectile(): number {
    const w = this.m.world;
    return w[W.ProjFree] === 0 ? -1 : this.m.pFree[--w[W.ProjFree]];
  }

  freeProjectile(i: number): void {
    const { m } = this;
    m.pAlive[i] = 0;
    m.pFree[m.world[W.ProjFree]++] = i;
  }

  allocNeutral(): number {
    const w = this.m.world;
    return w[W.NeutralFree] === 0 ? -1 : this.m.nFree[--w[W.NeutralFree]];
  }

  freeNeutral(i: number): void {
    const { m } = this;
    m.nAlive[i] = 0;
    m.nFree[m.world[W.NeutralFree]++] = i;
  }

  allocOrb(): number {
    const w = this.m.world;
    return w[W.OrbFree] === 0 ? -1 : this.m.oFree[--w[W.OrbFree]];
  }

  freeOrb(i: number): void {
    const { m } = this;
    m.oAlive[i] = 0;
    m.oFree[m.world[W.OrbFree]++] = i;
  }

  emit(type: number, x = 0, y = 0, a = 0, b = 0, c = 0): void {
    this.events.push(type, x, y, a, b, c);
  }
}
