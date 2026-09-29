import { createSession, decodeReplay } from '@metronome/engine';
import type { Session, SessionParams } from '@metronome/engine';
import { Bot } from '../../game/src/bot/bot.ts';
import { createGameSim, encodeConfig, gameCodec, GameSim, Phase, SIM_VERSION, TICK_RATE, W } from '../../game/src/sim/index.ts';
import type { GameInput } from '../../game/src/sim/index.ts';

export interface MatchSpec {
  readonly mode: number;
  /** One frame per seat. */
  readonly frames: readonly number[];
  /** One team per seat (free-for-all: team = seat). */
  readonly teams: readonly number[];
  readonly seed?: number;
}

export const freeForAll = (count: number): number[] => Array.from({ length: count }, (_, seat) => seat);
export const rotatingFrames = (count: number, offset = 0): number[] => Array.from({ length: count }, (_, seat) => (seat + offset) % 3);

export function matchConfig(spec: MatchSpec): Uint8Array {
  return encodeConfig({ mode: spec.mode, seats: spec.frames.map((frame, seat) => ({ frame, team: spec.teams[seat] })) });
}

export function gameParams(spec: MatchSpec, inputDelay = 0): SessionParams {
  return {
    simVersion: SIM_VERSION,
    seed: spec.seed ?? 0xb055f0,
    seats: spec.frames.length,
    tickRate: TICK_RATE,
    inputDelay,
    checksumInterval: 60,
    config: matchConfig(spec),
  };
}

export interface RunSpec extends MatchSpec {
  readonly ticks: number;
  /** 0..1, how well the pilots dodge and lead their shots. */
  readonly skill?: number;
  /** Called after every tick with the live simulation (scenario hooks / metrics). */
  readonly onTick?: (sim: GameSim, tick: number) => void;
}

export interface RunResult {
  readonly session: Session<GameInput>;
  readonly sim: GameSim;
  readonly replay: Uint8Array;
  readonly msPerTick: number;
  readonly worstMs: number;
}

const DEFAULT_SKILL = 0.85;

/** Closed-loop bot run through the real Session (single machine), recording a replay. Stops early when the match is over. */
export function runBots(spec: RunSpec): RunResult {
  const holder: { sim: GameSim | null } = { sim: null };
  const seats = spec.frames.length;
  const bots = Array.from({ length: seats }, (_, seat) => new Bot(seat, spec.seed ?? 0, spec.skill ?? DEFAULT_SKILL));
  const session = createSession({
    factory: (init) => {
      const sim = createGameSim(init);
      holder.sim = sim;
      return sim;
    },
    codec: gameCodec,
    params: gameParams(spec),
    self: 0,
    seatOwners: Array.from({ length: seats }, () => 0),
    sampleInput: (seat) => bots[seat].think(holder.sim!.world),
    recordReplay: true,
    onTick: spec.onTick ? (tick) => spec.onTick!(holder.sim!, tick) : undefined,
  });
  let worst = 0;
  const started = performance.now();
  while (session.tick < spec.ticks && holder.sim!.world.m.world[W.Phase] !== Phase.Over) {
    const t0 = performance.now();
    session.update(0, 1);
    worst = Math.max(worst, performance.now() - t0);
  }
  const total = performance.now() - started;
  return { session, sim: holder.sim!, replay: session.exportReplay(), msPerTick: total / session.tick, worstMs: worst };
}

/** Decodes a recorded replay into an open-loop input script: script(seat, tick). */
export function scriptFromReplay(bytes: Uint8Array): { params: SessionParams; ticks: number; inputAt: (tick: number, seat: number) => GameInput } {
  const replay = decodeReplay(bytes);
  const presenceBytes = Math.ceil(replay.params.seats / 8);
  const recordBytes = presenceBytes + replay.params.seats * replay.inputByteLength;
  return {
    params: replay.params,
    ticks: replay.tickCount,
    inputAt: (tick, seat) => gameCodec.decode(replay.records, tick * recordBytes + presenceBytes + seat * replay.inputByteLength),
  };
}
