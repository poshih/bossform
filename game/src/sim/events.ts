/**
 * Simulation output events. They are DERIVED from state transitions and exist only so the presentation layer
 * (sound, particles, camera) can react. They are never read by the simulation and are not part of the
 * checksummed state; overflowing the queue only loses effects, never correctness.
 *
 * Payload: x, y are fixed-point world positions; a, b and c are integers whose meaning is listed per event.
 */
export const Ev = {
  /** A ship fired one of its two weapons: a = seat, b = frame, c = FireSlot. */
  Fire: 1,
  /** A ship's core took bullet damage: a = seat, b = damage applied, c = the shooter's seat or NO_SEAT. */
  Hit: 2,
  /** The damage window absorbed a hit: a = seat. */
  Blocked: 3,
  /** A boss-form part took damage: a = seat, b = part. */
  PartHit: 4,
  /** A boss-form part was destroyed: a = seat, b = part. */
  PartDown: 5,
  Graze: 6,
  /** A bulwark swallowed a projectile: a = seat. */
  Absorb: 7,
  /** A ship was destroyed: a = seat, b = killer seat or NO_SEAT, c = 1 if it was destroyed as a colossus (boss form). */
  Death: 8,
  Respawn: 9,
  Left: 10,
  MorphStart: 11,
  MorphDone: 12,
  /** The boss form ran out of fuel or was destroyed: a = seat. */
  BossEnd: 13,
  /** A boss attack started winding up: a = seat, b = Attack. */
  Windup: 14,
  /** A boss attack was released: a = seat, b = Attack. */
  Release: 15,
  /** A boss pod fired: a = seat, b = part; x, y = muzzle. */
  PodFire: 16,
  NeutralHit: 17,
  /** A neutral unit was destroyed: a = neutral type. */
  NeutralKilled: 18,
  /** A neutral unit fired: a = its NeutralType, b = its index in the neutral pool. */
  NeutralFire: 19,
  OrbPickup: 20,
  Dash: 21,
  BulwarkUp: 22,
  /** A projectile burst into shrapnel: a = shot id of the parent. */
  Burst: 23,
  /** Sudden death began. */
  StormStart: 24,
  /** a = Banner id, b = number. */
  Banner: 25,
  /** A round or the match ended: a = winning team or NO_WINNER, b = 1 if the whole match is over. */
  RoundEnd: 26,
  /** The storm hurt a ship outside the safe zone: a = seat, b = damage. */
  StormHit: 27,
} as const;

/** Which of a robot's two weapons an Ev.Fire event is about. */
export const FireSlot = { Primary: 0, Alt: 1 } as const;

export const Banner = { Round: 1, Fight: 2, RoundWon: 3, Draw: 4, MatchWon: 5, TimeUp: 6 } as const;

const CAPACITY = 1024;

export class EventQueue {
  readonly type = new Uint8Array(CAPACITY);
  readonly x = new Int32Array(CAPACITY);
  readonly y = new Int32Array(CAPACITY);
  readonly a = new Int32Array(CAPACITY);
  readonly b = new Int32Array(CAPACITY);
  readonly c = new Int32Array(CAPACITY);
  count = 0;

  push(type: number, x: number, y: number, a: number, b: number, c: number): void {
    if (this.count >= CAPACITY) return;
    const i = this.count++;
    this.type[i] = type;
    this.x[i] = x;
    this.y[i] = y;
    this.a[i] = a;
    this.b[i] = b;
    this.c[i] = c;
  }

  clear(): void {
    this.count = 0;
  }
}
