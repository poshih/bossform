import { createSession, LockstepRunner, TickClock } from '@metronome/engine';
import type { FrameResult, Session, Transport } from '@metronome/engine';
import { Bot } from './bot/bot.ts';
import { LOCAL_INPUT_DELAY, sessionParams } from './setup.ts';
import type { MatchSetup } from './setup.ts';
import { createGameSim, gameCodec, NEUTRAL_INPUT, TICK_RATE } from './sim/index.ts';
import type { GameInput, GameSim, World } from './sim/index.ts';

/** How well computer pilots dodge and lead their shots (0..1). */
const BOT_SKILL = 0.85;

export interface MatchNetwork {
  readonly transport: Transport;
  /** This machine's peer id. */
  readonly self: number;
  /** Peer that supplies each seat's input. */
  readonly seatOwners: readonly number[];
  readonly inputDelay: number;
}

export interface MatchHooks {
  /** The local human's input for the next tick. */
  readonly sampleHuman: () => GameInput;
  /** After every simulated tick (before the frame's events are consumed). */
  readonly onTick: (world: World) => void;
}

/**
 * One match: a lockstep session around a fresh simulation, the computer pilots this machine owns, and the local human's
 * seat. On a single machine every seat is owned locally; online, each machine owns its human's seat and the host also
 * owns the bots.
 */
export class MatchRun {
  readonly setup: MatchSetup;
  readonly session: Session<GameInput>;
  readonly runner: LockstepRunner<GameInput>;
  readonly sim: GameSim;
  /** The seat this machine's human flies, or -1 for a run with no human (a spectated bot match). */
  readonly localSeat: number;
  readonly online: boolean;

  constructor(setup: MatchSetup, hooks: MatchHooks, network?: MatchNetwork) {
    this.setup = setup;
    this.online = network !== undefined;
    const self = network !== undefined ? network.self : 0;
    const owners = network !== undefined ? network.seatOwners : setup.pilots.map(() => self);
    this.localSeat = setup.pilots.findIndex((pilot, seat) => !pilot.bot && owners[seat] === self);
    const bots = setup.pilots.map((pilot, seat) => (pilot.bot && owners[seat] === self ? new Bot(seat, setup.seed, BOT_SKILL) : null));
    const holder: { sim: GameSim | null } = { sim: null };
    this.session = createSession({
      factory: (init) => {
        holder.sim = createGameSim(init);
        return holder.sim;
      },
      codec: gameCodec,
      params: sessionParams(setup, network !== undefined ? network.inputDelay : LOCAL_INPUT_DELAY),
      self,
      seatOwners: owners,
      transport: network?.transport,
      sampleInput: (seat) => {
        const bot = bots[seat];
        if (bot !== null) return bot.think(holder.sim!.world);
        return seat === this.localSeat ? hooks.sampleHuman() : NEUTRAL_INPUT;
      },
      onTick: () => hooks.onTick(holder.sim!.world),
      recordReplay: false,
    });
    this.sim = holder.sim!;
    this.runner = new LockstepRunner(this.session, new TickClock({ tickRate: TICK_RATE }));
  }

  get world(): World {
    return this.sim.world;
  }

  /** One call per rendered frame. */
  frame(nowMs: number): FrameResult {
    return this.runner.frame(nowMs);
  }

  /** A single-machine match can be paused; a networked one cannot (peers would stall). */
  get canPause(): boolean {
    return !this.online;
  }

  setPaused(paused: boolean): void {
    this.runner.setPaused(paused);
  }

  /** Leaves an online match gracefully (peers keep playing without this machine's seats). */
  leave(): void {
    if (this.online) this.session.leave();
    this.session.close();
  }
}
