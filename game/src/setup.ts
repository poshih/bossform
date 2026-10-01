import { encodeConfig, Frame, FRAME_COUNT, MAX_PLAYERS, Mode, MODE_COUNT, SIM_VERSION, TICK_RATE } from './sim/index.ts';
import type { SessionParams } from '@metronome/engine';

/** One participant as chosen in the menus or the lobby. */
export interface PilotSetup {
  readonly name: string;
  readonly frame: number;
  /** Team id, below the pilot count. Free-for-all: team = seat. */
  readonly team: number;
  /** Flown by a computer pilot on the machine that owns the seat. */
  readonly bot: boolean;
}

/** Everything needed to start a match; on an online match every machine builds the same one from the room's start message. */
export interface MatchSetup {
  readonly mode: number;
  readonly pilots: readonly PilotSetup[];
  readonly seed: number;
}

export const DEFAULT_NAMES = ['ALPHA', 'BRAVO', 'CHARLIE', 'DELTA', 'ECHO', 'FOXTROT', 'GOLF', 'HOTEL'] as const;

export const CHECKSUM_INTERVAL_TICKS = 60;
/** Input delay for a match on one machine, ticks. */
export const LOCAL_INPUT_DELAY = 0;

export function sessionParams(setup: MatchSetup, inputDelay: number): SessionParams {
  return {
    simVersion: SIM_VERSION,
    seed: setup.seed,
    seats: setup.pilots.length,
    tickRate: TICK_RATE,
    inputDelay,
    checksumInterval: CHECKSUM_INTERVAL_TICKS,
    config: encodeConfig({ mode: setup.mode, seats: setup.pilots.map((p) => ({ frame: p.frame, team: p.team })) }),
  };
}

/** Free-for-all with everyone on their own team. */
export function freeForAllTeams(count: number): number[] {
  return Array.from({ length: count }, (_, seat) => seat);
}

/** Splits `count` pilots into `teams` groups as evenly as possible, teammates in adjacent seats (2v2, 4v4, 2v2v2v2...). */
export function evenTeams(count: number, teams: number): number[] {
  return Array.from({ length: count }, (_, seat) => Math.floor((seat * teams) / count));
}

/** A presentation table indexed by frame id: it must name every frame, in frame order (menu order is id order). */
function perFrame<T extends readonly string[]>(table: string, entries: T): T {
  if (entries.length !== FRAME_COUNT) throw new RangeError(`${table} lists ${entries.length} frames, the simulation has ${FRAME_COUNT}`);
  return entries;
}

// The single owner of every robot's presentation names: menus, HUD, docs and tools read them from here.
export const FRAME_NAMES = perFrame('FRAME_NAMES', ['VANGUARD', 'GALE', 'JUGGERNAUT', 'LONGBOW', 'PRISM', 'HAILSTORM', 'RONIN', 'SHADE', 'GAUNTLET'] as const);
export const FORM_NAMES = perFrame('FORM_NAMES', ['PALADIN', 'TEMPEST', 'FORTRESS', 'BALLISTA', 'HELIOS', 'ARMADA', 'SHOGUN', 'KITSUNE', 'ATLAS'] as const);
export const FRAME_TAGLINES = perFrame('FRAME_TAGLINES', ['VERSATILE', 'FAST', 'HEAVY', 'SNIPER', 'BEAM', 'ARSENAL', 'DUELIST', 'STEALTH', 'BRAWLER'] as const);
/** One honest line per robot: what it is good at, and what it pays for it. */
export const FRAME_BLURBS = perFrame('FRAME_BLURBS', [
  'A fan rifle for every range and two slow seeker orbs to finish the job.',
  'Rapid twin darts and a phase dash that slips through fire. Light on armour.',
  'Slow mortar shells and a bulwark that swallows bullets. Hard to move, harder to kill.',
  'Hold to charge a rail shot, mine the approaches. Deadly far away, weak up close.',
  'A held beam that sweeps slowly and a lance that fires where its laser points. Every shot is told.',
  'A cannon that spins up the longer it fires, carpet bombs that deny ground. Big and slow.',
  'Wide katana slashes and a parry that sends shots back. Lethal up close, if it gets there.',
  'Curving shuriken and a veil that hides it from eyes and radar until it strikes. Fragile.',
  'Knuckle shots that shove and a rocket fist that flies out and comes back. Built to brawl.',
] as const);
/** The primary weapon (fire) and the alt (right click / tap right) of each robot, as the HUD and the menus name them. */
export const PRIMARY_LABELS = perFrame('PRIMARY_LABELS', ['FAN RIFLE', 'TWIN DARTS', 'MORTAR', 'RAIL RIFLE', 'PRISM BEAM', 'ROTARY CANNON', 'KATANA', 'SHURIKEN', 'KNUCKLE CANNON'] as const);
export const ALT_LABELS = perFrame('ALT_LABELS', ['SEEKERS', 'PHASE DASH', 'BULWARK', 'TRIPMINE', 'LANCE', 'CARPET BOMB', 'PARRY', 'SHADOW VEIL', 'ROCKET PUNCH'] as const);
export const MODE_NAMES = ['ELIMINATION', 'DEATHMATCH'] as const;
export const MODE_BLURBS = ['Last team standing. Best of three. Sudden death shrinks the arena.', 'Score kills. Respawn after three seconds. Three minutes.'] as const;

/** A sensible default: you against `opponents` bots, everyone for themselves, frames rotating. */
export function quickMatch(mode: number, opponents: number, yourFrame: number, seed: number): MatchSetup {
  const count = Math.min(MAX_PLAYERS, opponents + 1);
  return {
    mode,
    seed,
    pilots: Array.from({ length: count }, (_, seat) => ({
      name: seat === 0 ? 'YOU' : DEFAULT_NAMES[seat],
      frame: seat === 0 ? yourFrame : (yourFrame + seat) % FRAME_COUNT,
      team: seat,
      bot: seat !== 0,
    })),
  };
}

export interface LobbyPlayer {
  readonly name: string;
  readonly frame: number;
  readonly team: number;
  readonly bot: boolean;
  /** This entry is the local machine's own pilot. */
  readonly self: boolean;
  readonly host: boolean;
}

export type LobbyStatus = 'connecting' | 'waiting' | 'starting' | 'failed';

export interface LobbyState {
  readonly room: string;
  readonly mode: number;
  readonly maxPlayers: number;
  readonly players: readonly LobbyPlayer[];
  /** This machine controls the settings, adds bots and starts the match. */
  readonly host: boolean;
  readonly status: LobbyStatus;
  readonly message: string;
}

/** What a player may change in the lobby: their own pilot always; the mode and the bots only for the host. */
export interface LobbyEdits {
  readonly frame?: number;
  readonly team?: number;
  readonly mode?: number;
  readonly addBot?: boolean;
  /** Index into LobbyState.players of a bot to remove. */
  readonly removeBot?: number;
}

export { Frame, MAX_PLAYERS, Mode, MODE_COUNT };
