import { createSession, decodeReplay } from '@metronome/engine';
import type { Session, SessionParams } from '@metronome/engine';
import { botInput } from '../../game/src/bot/bot.ts';
import { createGameSim, encodeConfig, gameCodec, GameSim, Phase, SIM_VERSION, TICK_RATE, W } from '../../game/src/sim/index.ts';
import type { GameInput } from '../../game/src/sim/index.ts';

export interface RunSpec {
  readonly seats: number;
  readonly frames: readonly number[];
  readonly difficulty?: number;
  readonly stage?: number;
  readonly ticks: number;
  readonly seed?: number;
  /** Called after every tick with the live simulation (scenario hooks / metrics). */
  readonly onTick?: (sim: GameSim, tick: number) => void;
}

export function gameParams(spec: Pick<RunSpec, 'seats' | 'frames' | 'difficulty' | 'stage' | 'seed'>, inputDelay = 0): SessionParams {
  return {
    simVersion: SIM_VERSION,
    seed: spec.seed ?? 0xb055f0,
    seats: spec.seats,
    tickRate: TICK_RATE,
    inputDelay,
    checksumInterval: 60,
    config: encodeConfig(spec.difficulty ?? 1, spec.frames, spec.stage ?? 0),
  };
}

export interface RunResult {
  readonly session: Session<GameInput>;
  readonly sim: GameSim;
  readonly replay: Uint8Array;
  readonly msPerTick: number;
  readonly worstMs: number;
}

/** Closed-loop autopilot run through the real Session (single machine), recording a replay. */
export function runBots(spec: RunSpec): RunResult {
  const holder: { sim: GameSim | null } = { sim: null };
  const session = createSession({
    factory: (init) => {
      const sim = createGameSim(init) as GameSim;
      holder.sim = sim;
      return sim;
    },
    codec: gameCodec,
    params: gameParams(spec),
    self: 0,
    seatOwners: Array.from({ length: spec.seats }, () => 0),
    sampleInput: (seat) => botInput(holder.sim!.world, seat),
    recordReplay: true,
    onTick: spec.onTick ? (tick) => spec.onTick!(holder.sim!, tick) : undefined,
  });
  let worst = 0;
  const started = performance.now();
  while (session.tick < spec.ticks) {
    const t0 = performance.now();
    session.update(0, 1);
    worst = Math.max(worst, performance.now() - t0);
    const phase = holder.sim!.world.m.world[W.Phase];
    if (phase === Phase.Over || phase === Phase.Win) {
      // keep ticking a little so the end state is exercised, then stop
      if (session.tick > spec.ticks) break;
    }
  }
  const total = performance.now() - started;
  return { session, sim: holder.sim!, replay: session.exportReplay(), msPerTick: total / session.tick, worstMs: worst };
}

/** Decodes a recorded replay into an open-loop input script: script(seat, tick). */
export function scriptFromReplay(bytes: Uint8Array): { params: SessionParams; ticks: number; inputAt: (tick: number, seat: number) => GameInput } {
  const replay = decodeReplay(bytes);
  const recordBytes = 1 + replay.params.seats * replay.inputByteLength;
  return {
    params: replay.params,
    ticks: replay.tickCount,
    inputAt: (tick, seat) => gameCodec.decode(replay.records, tick * recordBytes + 1 + seat * replay.inputByteLength),
  };
}
