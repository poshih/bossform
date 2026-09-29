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

export const FRAME_NAMES = ['VANGUARD', 'GALE', 'JUGGERNAUT'] as const;
export const FORM_NAMES = ['PALADIN', 'TEMPEST', 'FORTRESS'] as const;
export const FRAME_TAGLINES = ['VERSATILE', 'FAST', 'HEAVY'] as const;
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
