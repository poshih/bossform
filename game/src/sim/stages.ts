import { fx } from '@metronome/engine';
import { EnemyType, SPAWN_Y } from './constants.ts';

/**
 * Stage scripts are flat lists of steps (data, not code), authored with the builder below and executed by
 * the stage runner. A script is static content; only the pointer into it lives in simulation memory.
 */
export const Op = { Wait: 0, Spawn: 1, Clear: 2, Round: 3, Boss: 4, End: 5 } as const;
export const STEP_SIZE = 8;

class ScriptBuilder {
  private readonly steps: number[] = [];

  private push(op: number, a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0): this {
    this.steps.push(op, a, b, c, d, e, f, g);
    return this;
  }

  wait(ticks: number): this {
    return this.push(Op.Wait, ticks);
  }

  spawn(type: number, x: number, y: number, r0 = 0, r1 = 0, r2 = 0, r3 = 0): this {
    return this.push(Op.Spawn, type, x, y, r0, r1, r2, r3);
  }

  /** Blocks until the field is clear of ordinary enemies, or `maxTicks` passed. */
  clear(maxTicks: number): this {
    return this.push(Op.Clear, maxTicks);
  }

  round(number: number): this {
    return this.push(Op.Round, number);
  }

  boss(type: number): this {
    return this.push(Op.Boss, type);
  }

  end(): Int32Array {
    this.push(Op.End);
    return Int32Array.from(this.steps);
  }
}

const X = fx.fromInt;
const HOVER_LOW = 95;
const HOVER_MID = 120;
const HOVER_HIGH = 145;

/** A snaking line of drones that all follow the same weave. */
function droneStream(b: ScriptBuilder, count: number, baseX: number, amplitude: number, gap: number, phase = 0, descent = fx.lit(1.25)): void {
  for (let i = 0; i < count; i++) {
    b.spawn(EnemyType.Drone, X(baseX), SPAWN_Y, X(baseX), X(amplitude), fx.deg(phase), descent).wait(gap);
  }
}

/** Drone pairs fanning out symmetrically from a centre line. */
function droneVee(b: ScriptBuilder, pairs: number, centerX: number, spread: number, gap: number): void {
  for (let i = 0; i < pairs; i++) {
    for (const side of [-1, 1]) {
      const x = centerX + side * spread * (i + 1);
      b.spawn(EnemyType.Drone, X(x), SPAWN_Y, X(x), X(14), fx.deg(side * 90), fx.lit(1.35));
    }
    b.wait(gap);
  }
}

function gunners(b: ScriptBuilder, xs: readonly number[], hoverY = HOVER_MID): void {
  for (const x of xs) b.spawn(EnemyType.Gunner, X(x), SPAWN_Y, X(hoverY));
}

function lancers(b: ScriptBuilder, xs: readonly number[], gap: number, hoverY = HOVER_MID): void {
  for (const x of xs) b.spawn(EnemyType.Lancer, X(x), SPAWN_Y, X(hoverY)).wait(gap);
}

function spinner(b: ScriptBuilder, x: number, hoverY = HOVER_HIGH): void {
  b.spawn(EnemyType.Spinner, X(x), SPAWN_Y, X(hoverY));
}

function bomber(b: ScriptBuilder, x: number, hoverY = HOVER_MID): void {
  b.spawn(EnemyType.Bomber, X(x), SPAWN_Y, X(hoverY));
}

function stageOne(): Int32Array {
  const b = new ScriptBuilder();
  b.round(1).wait(30);
  droneStream(b, 6, -90, 40, 16);
  b.wait(50);
  droneStream(b, 6, 90, 40, 16, 180);
  b.clear(900);
  b.round(2).wait(40);
  gunners(b, [-70, 70]);
  b.wait(150);
  droneVee(b, 3, 0, 34, 24);
  b.clear(1300);
  b.round(3).wait(40);
  lancers(b, [-80, 0, 80], 34);
  b.wait(120);
  droneStream(b, 8, 0, 70, 12);
  b.clear(1300);
  b.round(4).wait(40);
  spinner(b, 0);
  gunners(b, [-100, 100], HOVER_LOW);
  b.wait(260);
  droneVee(b, 4, 0, 30, 20);
  b.clear(1700);
  b.wait(60).boss(EnemyType.Bulwark);
  return b.end();
}

function stageTwo(): Int32Array {
  const b = new ScriptBuilder();
  b.round(1).wait(30);
  droneVee(b, 5, 0, 26, 18);
  b.wait(40);
  lancers(b, [-90, 90, -50, 50], 26);
  b.clear(1200);
  b.round(2).wait(40);
  bomber(b, 0);
  b.wait(160);
  droneStream(b, 8, -60, 50, 14);
  droneStream(b, 8, 60, 50, 14, 180);
  b.clear(1700);
  b.round(3).wait(40);
  gunners(b, [-100, 0, 100], HOVER_LOW);
  spinner(b, -80);
  spinner(b, 80);
  b.wait(300);
  droneVee(b, 4, 0, 32, 20);
  b.clear(1700);
  b.round(4).wait(40);
  bomber(b, -70, HOVER_HIGH);
  bomber(b, 70, HOVER_HIGH);
  b.wait(120);
  lancers(b, [-110, -55, 0, 55, 110], 22);
  b.clear(1800);
  b.wait(60).boss(EnemyType.Seraph);
  return b.end();
}

function stageThree(): Int32Array {
  const b = new ScriptBuilder();
  b.round(1).wait(30);
  bomber(b, -70);
  bomber(b, 70);
  gunners(b, [-30, 30], HOVER_HIGH);
  b.wait(140);
  droneStream(b, 10, 0, 90, 12);
  b.clear(1800);
  b.round(2).wait(40);
  spinner(b, -90);
  spinner(b, 0, HOVER_HIGH + 10);
  spinner(b, 90);
  b.wait(200);
  lancers(b, [-100, -60, -20, 20, 60, 100], 16);
  b.clear(1800);
  b.round(3).wait(40);
  bomber(b, 0, HOVER_HIGH);
  gunners(b, [-100, 100], HOVER_LOW);
  b.wait(180);
  droneVee(b, 5, 0, 26, 16);
  droneStream(b, 8, -100, 40, 12);
  b.clear(1800);
  b.round(4).wait(40);
  bomber(b, -80, HOVER_HIGH);
  bomber(b, 80, HOVER_HIGH);
  spinner(b, 0, HOVER_MID);
  gunners(b, [-110, 110], HOVER_LOW);
  b.wait(240);
  lancers(b, [-90, 90, -45, 45, 0], 18);
  b.clear(2000);
  b.wait(60).boss(EnemyType.Overlord);
  return b.end();
}

export const STAGE_SCRIPTS: readonly Int32Array[] = [stageOne(), stageTwo(), stageThree()];
