import type { Session, SessionStatus } from './session.ts';

export interface ClockOptions {
  readonly tickRate: number;
  /** Most ticks one rendered frame may simulate (a stalled tab never fast-forwards minutes). */
  readonly maxCatchUpTicks?: number;
  /** Most unsimulated time the clock will remember, in ticks; the rest is dropped (slow-motion beats a sprint). */
  readonly maxDebtTicks?: number;
  /** Longest single frame delta honoured, in ms. */
  readonly maxFrameMs?: number;
}

const DEFAULT_CATCH_UP = 8;
const DEFAULT_DEBT = 12;
const DEFAULT_MAX_FRAME_MS = 250;

/** Converts real time into whole simulation ticks and a render interpolation fraction. */
export class TickClock {
  readonly tickMs: number;
  private readonly maxCatchUp: number;
  private readonly maxDebtMs: number;
  private readonly maxFrameMs: number;
  private accumulatorMs = 0;
  private lastMs = -1;

  constructor(opts: ClockOptions) {
    this.tickMs = 1000 / opts.tickRate;
    this.maxCatchUp = opts.maxCatchUpTicks ?? DEFAULT_CATCH_UP;
    this.maxDebtMs = (opts.maxDebtTicks ?? DEFAULT_DEBT) * this.tickMs;
    this.maxFrameMs = opts.maxFrameMs ?? DEFAULT_MAX_FRAME_MS;
  }

  /** Feed a monotonic timestamp (ms); returns how many ticks are due right now. */
  begin(nowMs: number): number {
    if (this.lastMs < 0) {
      this.lastMs = nowMs;
      return 0;
    }
    const delta = Math.min(this.maxFrameMs, Math.max(0, nowMs - this.lastMs));
    this.lastMs = nowMs;
    this.accumulatorMs += delta;
    return Math.min(this.maxCatchUp, Math.floor(this.accumulatorMs / this.tickMs));
  }

  /** Report how many of the due ticks were really simulated (fewer when the session stalled). */
  end(simulated: number): void {
    this.accumulatorMs = Math.min(this.maxDebtMs, this.accumulatorMs - simulated * this.tickMs);
  }

  /** Fraction (0..1) of the way from the previous tick to the next, for render interpolation. */
  get alpha(): number {
    return Math.min(1, Math.max(0, this.accumulatorMs / this.tickMs));
  }

  /** Forget elapsed time (after a pause or a resume from the background). */
  reset(): void {
    this.accumulatorMs = 0;
    this.lastMs = -1;
  }
}

export interface FrameResult {
  readonly ticks: number;
  readonly alpha: number;
  readonly stalled: boolean;
  readonly status: SessionStatus;
}

/** One call per rendered frame: paces a session from wall-clock time. */
export class LockstepRunner<I> {
  readonly session: Session<I>;
  readonly clock: TickClock;
  private paused_ = false;

  constructor(session: Session<I>, clock?: TickClock) {
    this.session = session;
    this.clock = clock ?? new TickClock({ tickRate: session.params.tickRate });
  }

  get paused(): boolean {
    return this.paused_;
  }

  /** Only a single-machine session can pause: peers cannot be asked to wait without an in-band protocol. */
  setPaused(paused: boolean): void {
    if (paused && this.session.remotePeerCount > 0) throw new Error('LockstepRunner: a networked session cannot be paused');
    this.paused_ = paused;
    this.clock.reset();
  }

  frame(nowMs: number): FrameResult {
    if (this.paused_) return { ticks: 0, alpha: this.clock.alpha, stalled: false, status: this.session.status };
    const due = this.clock.begin(nowMs);
    const result = this.session.update(nowMs, due);
    this.clock.end(result.ticks);
    return { ticks: result.ticks, alpha: this.clock.alpha, stalled: result.stalled, status: this.session.status };
  }
}
