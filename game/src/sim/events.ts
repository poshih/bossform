/**
 * Simulation output events. They are DERIVED from state transitions and exist only so the presentation layer
 * (sound, particles, camera) can react. They are never read by the simulation and are not part of the
 * checksummed state; overflowing the queue only loses effects, never correctness.
 */
export const Ev = {
  ShotFired: 1,
  EnemyHit: 2,
  EnemyKilled: 3,
  BossHit: 4,
  PlayerHit: 5,
  Graze: 6,
  TransformStart: 7,
  TransformDone: 8,
  BossModeEnd: 9,
  Absorb: 10,
  OrbPickup: 11,
  Banner: 12,
  BossWarning: 13,
  BossDefeated: 14,
  PlayerDeath: 15,
  PlayerRespawn: 16,
  GameOver: 17,
  StageClear: 18,
  MissileLaunch: 19,
  Dash: 20,
  ShieldUp: 21,
  Explosion: 22,
  GaugeFull: 23,
  BossPhase: 24,
  Victory: 25,
  BladeStorm: 26,
  ShellBurst: 27,
  BulletsCleared: 28,
} as const;

/** Banner ids shown by the HUD. Stage and Round banners carry their 1-based number in the event's x. */
export const Banner = { Stage: 1, Round: 2, Warning: 3, Clear: 4, GameOver: 5, Victory: 6 } as const;

const CAPACITY = 768;

export class EventQueue {
  readonly type = new Uint8Array(CAPACITY);
  readonly x = new Int32Array(CAPACITY);
  readonly y = new Int32Array(CAPACITY);
  readonly a = new Int32Array(CAPACITY);
  count = 0;

  push(type: number, x = 0, y = 0, a = 0): void {
    if (this.count >= CAPACITY) return;
    const i = this.count++;
    this.type[i] = type;
    this.x[i] = x;
    this.y[i] = y;
    this.a[i] = a;
  }

  clear(): void {
    this.count = 0;
  }
}
