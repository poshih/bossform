import { createSession, LockstepRunner, TickClock } from '@metronome/engine';
import type { Session, SessionParams, Transport } from '@metronome/engine';
import { botInput } from './bot/bot.ts';
import {
  ARENA_HALF_W, createGameSim, encodeConfig, Ev, Frame, gameCodec, SIM_VERSION, TICK_RATE,
} from './sim/index.ts';
import type { GameInput, GameSim, World } from './sim/index.ts';
import type { PlayOptions, Sfx } from './audio/audio.ts';

export type RunKind = 'demo' | 'play' | 'online';

export interface RunSetup {
  readonly seats: number;
  readonly frames: readonly number[];
  readonly difficulty: number;
  readonly stage: number;
  readonly seed: number;
}

export interface NetworkSetup {
  readonly transport: Transport;
  readonly self: number;
  readonly seatOwners: readonly number[];
  readonly inputDelay: number;
}

export interface Run {
  readonly kind: RunKind;
  readonly setup: RunSetup;
  readonly session: Session<GameInput>;
  readonly runner: LockstepRunner<GameInput>;
  readonly sim: GameSim;
  readonly world: World;
  /** Seats this machine controls. */
  readonly localSeats: readonly number[];
  desynced: boolean;
}

export interface RunHooks {
  readonly sample: (seat: number) => GameInput;
  readonly onDesync?: () => void;
}

const CHECKSUM_INTERVAL = 60;

export function sessionParams(setup: RunSetup, inputDelay: number): SessionParams {
  return {
    simVersion: SIM_VERSION,
    seed: setup.seed >>> 0,
    seats: setup.seats,
    tickRate: TICK_RATE,
    inputDelay,
    checksumInterval: CHECKSUM_INTERVAL,
    config: encodeConfig(setup.difficulty, setup.frames, setup.stage),
  };
}

/** Builds a lockstep session around a fresh simulation. Single machine unless `network` is given. */
export function createRun(kind: RunKind, setup: RunSetup, hooks: RunHooks | null, network?: NetworkSetup): Run {
  if (kind !== 'demo' && hooks === null) throw new Error('createRun: a playable run needs input hooks');
  const holder: { sim: GameSim | null } = { sim: null };
  const seatOwners = network ? network.seatOwners : Array.from({ length: setup.seats }, () => 0);
  const self = network ? network.self : 0;
  let run: Run | null = null;
  const session = createSession({
    factory: (init) => {
      const sim = createGameSim(init);
      holder.sim = sim;
      return sim;
    },
    codec: gameCodec,
    params: sessionParams(setup, network ? network.inputDelay : 0),
    self,
    seatOwners,
    transport: network?.transport,
    sampleInput: hooks === null ? (seat) => botInput(holder.sim!.world, seat) : (seat) => hooks.sample(seat),
    recordReplay: kind !== 'demo',
    onDesync: () => {
      if (run) run.desynced = true;
      hooks?.onDesync?.();
    },
  });
  const sim = holder.sim!;
  run = {
    kind,
    setup,
    session,
    runner: new LockstepRunner(session, new TickClock({ tickRate: TICK_RATE })),
    sim,
    world: sim.world,
    localSeats: seatOwners.flatMap((owner, seat) => (owner === self ? [seat] : [])),
    desynced: false,
  };
  return run;
}

export function randomSeed(): number {
  return Math.floor(Math.random() * 0xffffffff) >>> 0;
}

type SoundCue = (x: number, a: number) => { sfx: Sfx; options?: PlayOptions } | null;

const pan = (x: number): PlayOptions => ({ pan: Math.max(-1, Math.min(1, x / ARENA_HALF_W)) * 0.7 });
const SHOT_BY_FRAME: readonly Sfx[] = ['shotRifle', 'shotNeedle', 'shotShell'];
const KILL_BY_SIZE: readonly Sfx[] = ['explodeS', 'explodeM', 'explodeL', 'explodeBoss'];
const EXPLOSION_BY_SIZE: readonly Sfx[] = ['explodeM', 'explodeM', 'explodeL', 'explodeBoss'];

const CUES: Readonly<Record<number, SoundCue>> = {
  [Ev.ShotFired]: (x, a) => ({ sfx: SHOT_BY_FRAME[a] ?? 'shotRifle', options: pan(x) }),
  [Ev.MissileLaunch]: (x) => ({ sfx: 'missile', options: pan(x) }),
  [Ev.Dash]: (x) => ({ sfx: 'dash', options: pan(x) }),
  [Ev.ShieldUp]: (x) => ({ sfx: 'shield', options: pan(x) }),
  [Ev.BladeStorm]: (x) => ({ sfx: 'blade', options: pan(x) }),
  [Ev.EnemyHit]: (x) => ({ sfx: 'enemyHit', options: pan(x) }),
  [Ev.BossHit]: (x) => ({ sfx: 'bossHit', options: pan(x) }),
  [Ev.EnemyKilled]: (x, a) => ({ sfx: KILL_BY_SIZE[a] ?? 'explodeS', options: pan(x) }),
  [Ev.Explosion]: (x, a) => ({ sfx: EXPLOSION_BY_SIZE[a] ?? 'explodeM', options: pan(x) }),
  [Ev.ShellBurst]: (x) => ({ sfx: 'shellBurst', options: pan(x) }),
  [Ev.Graze]: (x) => ({ sfx: 'graze', options: pan(x) }),
  [Ev.OrbPickup]: (x) => ({ sfx: 'orb', options: pan(x) }),
  [Ev.Absorb]: (x) => ({ sfx: 'absorb', options: pan(x) }),
  [Ev.PlayerHit]: () => ({ sfx: 'playerHit' }),
  [Ev.PlayerDeath]: () => ({ sfx: 'playerDeath' }),
  [Ev.PlayerRespawn]: () => ({ sfx: 'respawn' }),
  [Ev.GaugeFull]: () => ({ sfx: 'gaugeFull' }),
  [Ev.TransformStart]: () => ({ sfx: 'transformStart' }),
  [Ev.TransformDone]: () => ({ sfx: 'transformDone' }),
  [Ev.BossModeEnd]: () => ({ sfx: 'bossModeEnd' }),
  [Ev.BossWarning]: () => ({ sfx: 'bossWarning' }),
  [Ev.BossPhase]: () => ({ sfx: 'bossPhase' }),
  [Ev.BossDefeated]: () => ({ sfx: 'explodeBoss' }),
  [Ev.StageClear]: () => ({ sfx: 'stageClear' }),
  [Ev.Victory]: () => ({ sfx: 'victory' }),
  [Ev.GameOver]: () => ({ sfx: 'gameOver' }),
  [Ev.Banner]: () => ({ sfx: 'banner' }),
};

export function soundFor(type: number, rawX: number, a: number): { sfx: Sfx; options?: PlayOptions } | null {
  return CUES[type]?.(rawX / 65536, a) ?? null;
}

/** Frame used by the attract-mode demo for demo number `n`. */
export function demoFrame(n: number): number {
  return [Frame.Vanguard, Frame.Gale, Frame.Juggernaut][n % 3];
}
