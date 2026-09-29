import { fx } from '@metronome/engine';
import {
  Button, createGameSim, encodeConfig, Form, FORMS, GameSim, Mode, NEUTRAL_DEFS, Phase, W,
} from '../../game/src/sim/index.ts';
import type { GameInput, Mem, ShotDef, World } from '../../game/src/sim/index.ts';

/** Every seat idles facing +x unless the scenario says otherwise (a ship's body follows its aim). */
export const IDLE: GameInput = Object.freeze({ moveX: 0, moveY: 0, aim: 0, buttons: 0 });
export const holding = (buttons: number, extra: Partial<GameInput> = {}): GameInput => ({ ...IDLE, buttons, ...extra });

export interface LoggedEvent {
  readonly tick: number;
  readonly type: number;
  readonly x: number;
  readonly y: number;
  readonly a: number;
  readonly b: number;
  readonly c: number;
}

export interface ScenarioOptions {
  readonly mode?: number;
  readonly frames: readonly number[];
  /** Defaults to free-for-all (team = seat). */
  readonly teams?: readonly number[];
  readonly seed?: number;
}

export const units = (value: number): number => fx.fromInt(value);

/** `exposed()` keeps shields broken this long: longer than any scenario runs. */
const SHIELDLESS_TICKS = 1 << 30;

/** A hand-built situation on the real simulation, with an event log and helpers to place ships and shots. */
export class Scenario {
  readonly sim: GameSim;
  readonly w: World;
  readonly m: Mem;
  readonly seats: number;
  readonly log: LoggedEvent[] = [];
  private readonly everyone: boolean[];

  constructor(opts: ScenarioOptions) {
    this.seats = opts.frames.length;
    const config = encodeConfig({
      mode: opts.mode ?? Mode.Elimination,
      seats: opts.frames.map((frame, seat) => ({ frame, team: opts.teams ? opts.teams[seat] : seat })),
    });
    this.sim = createGameSim({ seed: opts.seed ?? 7, seats: this.seats, config });
    this.w = this.sim.world;
    this.m = this.w.m;
    this.everyone = new Array<boolean>(this.seats).fill(true);
  }

  get tick(): number {
    return this.m.world[W.Tick];
  }

  step(count = 1, input?: (seat: number) => GameInput, present?: readonly boolean[]): void {
    for (let i = 0; i < count; i++) {
      const inputs: GameInput[] = [];
      for (let seat = 0; seat < this.seats; seat++) inputs.push(input ? input(seat) : IDLE);
      this.sim.step({ tick: this.tick, inputs, present: present ?? this.everyone });
      const q = this.w.events;
      for (let e = 0; e < q.count; e++) this.log.push({ tick: this.tick, type: q.type[e], x: q.x[e], y: q.y[e], a: q.a[e], b: q.b[e], c: q.c[e] });
      q.clear();
    }
  }

  stepTo(tick: number, input?: (seat: number) => GameInput): void {
    if (tick < this.tick) throw new RangeError(`stepTo(${tick}) is in the past (now ${this.tick})`);
    this.step(tick - this.tick, input);
  }

  /** Runs the countdown so the fight is on. Ships stay protected until `exposed()`. */
  battle(): this {
    while (this.m.world[W.Phase] !== Phase.Battle) this.step();
    return this;
  }

  /**
   * Takes away every protection: spawn protection ends, and shields stay down for the rest of the scenario (a test aid:
   * damage, grazing and the like are checked on bare robots; shields have sections of their own, see `shields()`).
   */
  exposed(): this {
    this.m.plInvuln.fill(0);
    this.m.plShield.fill(0);
    this.m.plShieldBreak.fill(SHIELDLESS_TICKS);
    return this;
  }

  /** Lets shields work again after `exposed()`: each comes up on the next tick its pilot is not attacking. */
  shields(): this {
    this.m.plShieldBreak.fill(0);
    return this;
  }

  events(type: number, since = 0): LoggedEvent[] {
    return this.log.filter((e) => e.type === type && e.tick >= since);
  }

  place(seat: number, x: number, y: number): this {
    this.m.plX[seat] = units(x);
    this.m.plY[seat] = units(y);
    this.m.plVX[seat] = 0;
    this.m.plVY[seat] = 0;
    return this;
  }

  /**
   * Puts a projectile where one step of its own motion (heading +x) lands it exactly on (x, y) in units, so it
   * meets whatever is there this coming tick.
   */
  shootAt(def: ShotDef, owner: number, team: number, x: number, y: number): number {
    const i = this.w.allocProjectile();
    const { m } = this;
    m.pAlive[i] = 1;
    m.pDef[i] = def.id;
    m.pOwner[i] = owner;
    m.pTeam[i] = team;
    m.pAttack[i] = 0;
    m.pPart[i] = 0;
    m.pX[i] = units(x) - def.spd;
    m.pY[i] = units(y);
    m.pAng[i] = 0;
    m.pSpd[i] = def.spd;
    m.pAge[i] = 1;
    m.pGraze[i] = -1;
    return i;
  }

  spawnNeutral(type: number, x: number, y: number): number {
    const n = this.w.allocNeutral();
    const { m } = this;
    m.nAlive[n] = 1;
    m.nType[n] = type;
    m.nX[n] = units(x);
    m.nY[n] = units(y);
    m.nVX[n] = 0;
    m.nVY[n] = 0;
    m.nHp[n] = NEUTRAL_DEFS[type].hp;
    m.nAge[n] = 0;
    m.nAng[n] = 0;
    m.nTX[n] = units(x);
    m.nTY[n] = units(y);
    m.nFlash[n] = 0;
    return n;
  }

  spawnOrb(x: number, y: number, value: number): number {
    const o = this.w.allocOrb();
    const { m } = this;
    m.oAlive[o] = 1;
    m.oX[o] = units(x);
    m.oY[o] = units(y);
    m.oVX[o] = 0;
    m.oVY[o] = 0;
    m.oVal[o] = value;
    m.oAge[o] = 1;
    return o;
  }

  /** Transforms `seat` through the real button path and returns once the colossus is fully formed. */
  transform(seat: number, gauge: number): this {
    this.m.plGauge[seat] = gauge;
    this.step(1, (s) => (s === seat ? holding(Button.Boss) : IDLE));
    while (this.m.plForm[seat] !== Form.Boss) this.step();
    this.m.plGauge[seat] = gauge;
    return this;
  }

  /** Projectiles that appeared this tick (age 1) carrying a boss-attack tag. */
  newBossShots(): number[] {
    const out: number[] = [];
    for (let p = 0; p < this.w.cap.projectiles; p++) {
      if (this.m.pAlive[p] === 1 && this.m.pAge[p] === 1 && this.m.pAttack[p] !== 0) out.push(p);
    }
    return out;
  }

  liveProjectiles(): number {
    let live = 0;
    for (let p = 0; p < this.w.cap.projectiles; p++) if (this.m.pAlive[p] === 1) live++;
    return live;
  }
}

/**
 * A point (in units, relative to the core, body angle 0) that lies on part `part` of a boss form and on no other
 * part, so a shot placed there can only meet that part. Found by brute force over the part's rim.
 */
export function exposedPoint(frame: number, part: number, margin: number): { x: number; y: number } {
  const parts = FORMS[frame].parts;
  const to = (v: number) => v / fx.ONE;
  const target = parts[part];
  for (let step = 0; step < 360; step += 3) {
    const angle = (step * Math.PI) / 180;
    for (const shrink of [0.8, 0.5, 0.2]) {
      const x = to(target.x) + Math.cos(angle) * to(target.rad) * shrink;
      const y = to(target.y) + Math.sin(angle) * to(target.rad) * shrink;
      const clear = parts.every((other, k) => k === part || Math.hypot(x - to(other.x), y - to(other.y)) > to(other.rad) + margin);
      const coreClear = Math.hypot(x, y) > to(FORMS[frame].coreR) + margin;
      if (clear && coreClear) return { x, y };
    }
  }
  throw new Error(`no exposed point on part ${target.name}`);
}
