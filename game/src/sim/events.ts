/**
 * Simulation output events. They are DERIVED from state transitions and exist only so the presentation layer
 * (sound, particles, camera) can react. They are never read by the simulation and are not part of the
 * checksummed state; overflowing the queue only loses effects, never correctness.
 *
 * Payload: x, y are fixed-point world positions; a, b and c are integers whose meaning is listed per event.
 */
export const Ev = {
  /**
   * A ship used one of its two weapons (a shot or volley, a mine laid, carpet bombs thrown, a PRISM beam or lance beginning its
   * tell): a = seat, b = frame, c = FireSlot. Alts that are not weapons have events of their own (Dash, BulwarkUp, ParryUp, Cloak).
   */
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
  /** A robot started a boost: a = seat, b = heading (binary angle), c = frame; x, y = where it started. */
  Boost: 28,
  /** A shield stopped a projectile: a = seat, b = the damage it stopped, c = the shooter's seat or NO_SEAT; x, y = the impact. */
  ShieldHit: 29,
  /** A shield ran dry stopping a projectile and shattered: a = seat, b = that projectile's damage, c = the shooter or NO_SEAT. */
  ShieldBreak: 30,
  /** A shield came up (the pilot stopped attacking, or it recovered from a break): a = seat. */
  ShieldUp: 31,
  /** A RONIN raised its parry: a = seat. */
  ParryUp: 32,
  /** A parry sent a shot back or cut a beam: a = the parrying seat, b = the shot's blueprint id or -1, c = ReflectKind; x, y = where. */
  Reflect: 33,
  /** A SHADE cloaked: a = seat. */
  Cloak: 34,
  /** A cloak ended (it ran out, or the SHADE threw, was hurt, stopped a shot with its shield, transformed, died or left): a = seat. */
  Reveal: 35,
  /** A returning shot came home: a = its owner, b = the pod it left + 1 (0: the robot itself); x, y = where it was caught. */
  Catch: 36,
  /** A LONGBOW's rail rifle reached a full charge: a = seat. */
  ChargeFull: 37,
  /** A shot blasted an area as it detonated: a = its owner or NO_SEAT, b = its blueprint id; x, y = the centre. */
  Blast: 38,
  /** A beam started firing: a = seat, b = the pod + 1 (0: the robot itself), c = BeamKind; x, y = where it starts. */
  BeamOn: 39,
  /** A PRISM's lance fired: a = seat; x, y = the far end of the rail (where it was stopped). */
  LanceFire: 40,
} as const;

/** Which of a robot's two weapons an Ev.Fire event is about. */
export const FireSlot = { Primary: 0, Alt: 1 } as const;

/** What an Ev.Reflect event is about: a shot sent back, or a beam cut short. */
export const ReflectKind = { Shot: 0, Beam: 1 } as const;

/** Which beam an Ev.BeamOn event is about: a PRISM's beam, its lance's rail, or a boss pod's beam (a sweep or a wheel spoke). */
export const BeamKind = { Primary: 0, Lance: 1, Boss: 2 } as const;

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
