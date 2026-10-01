import { field } from '@metronome/engine';
import { TEAM_LIMIT } from './constants.ts';
import type { Capacity } from './constants.ts';

/** Index map for the `world` scalar block. */
export const W = {
  Tick: 0,
  Phase: 1,
  PhaseTimer: 2,
  /** 1-based round number (Elimination); always 1 in Deathmatch. */
  Round: 3,
  /** Ticks of battle so far this round. */
  RoundTick: 4,
  /** Radius of the safe zone; equals the arena radius until sudden death shrinks it. */
  SafeR: 5,
  /** Winning team once the match is over, else NO_WINNER. */
  Winner: 6,
  WaveTimer: 7,
  WaveCount: 8,
  WardenTimer: 9,
  ProjFree: 10,
  NeutralFree: 11,
  OrbFree: 12,
  /** Projectiles that could not be created because the pool was full (verification asserts this stays 0). */
  Dropped: 13,
  Count: 14,
} as const;

/**
 * ALL simulation state, sized from the seat count. Nothing that influences a future tick may live anywhere
 * else: this memory is what gets checksummed, snapshotted and compared between peers.
 */
export function layoutFor(cap: Capacity) {
  const S = cap.seats;
  const P = cap.projectiles;
  const N = cap.neutrals;
  const O = cap.orbs;
  const K = cap.parts;
  return {
    rng: field.u32(4),
    world: field.i32(W.Count),

    // Teams (indexed by team id)
    teamWins: field.i32(TEAM_LIMIT), teamScore: field.i32(TEAM_LIMIT),

    // Ships (one entry per seat)
    plActive: field.u8(S), plAlive: field.u8(S), plFrame: field.u8(S), plTeam: field.u8(S), plForm: field.u8(S),
    plAtk: field.u8(S), plAtkPhase: field.u8(S),
    plX: field.i32(S), plY: field.i32(S), plVX: field.i32(S), plVY: field.i32(S),
    plAim: field.i32(S), plBody: field.i32(S), plOrbit: field.i32(S),
    plHp: field.i32(S), plWinEnd: field.i32(S), plWinDmg: field.i32(S), plInvuln: field.i32(S), plRespawn: field.i32(S),
    plGauge: field.i32(S), plTimer: field.i32(S), plFlash: field.i32(S),
    plFireCd: field.i32(S), plAltCd: field.i32(S), plUltCd: field.i32(S), plDash: field.i32(S), plBulwark: field.i32(S),
    plAtkTimer: field.i32(S), plAtkSeq: field.i32(S),
    // Energy and shield (energy.ts), boost (boost.ts)
    plShield: field.u8(S), plEnergy: field.i32(S), plRegenWait: field.i32(S), plShieldWait: field.i32(S), plShieldBreak: field.i32(S),
    plBoost: field.i32(S), plBoostCd: field.i32(S),
    plLastHit: field.i32(S), plLastHitAt: field.i32(S), plEpoch: field.i32(S),
    plKills: field.i32(S), plDeaths: field.i32(S), plDealt: field.i32(S), plGrazes: field.i32(S),
    // Robot kits (weapons.ts, <robot>-weapons.ts): LONGBOW's charge, HAILSTORM's spin, RONIN's parry and SHADE's cloak (ticks
    // left), PRISM's beam (0 idle, 1..tell telling, then firing; its angle; how far it reaches before something stops it) and
    // lance (ticks left in its locked tell; its angle), and the side (0 or 1) the next alternating shot leaves from.
    plCharge: field.i32(S), plSpin: field.i32(S), plParry: field.i32(S), plCloak: field.i32(S),
    plBeam: field.i32(S), plBeamAng: field.i32(S), plBeamLen: field.i32(S), plLance: field.i32(S), plLanceAng: field.i32(S),
    plSide: field.u8(S),

    // Boss-form parts: MAX_PARTS entries per seat
    ptHp: field.i32(K), ptAng: field.i32(K), ptFlash: field.i32(K), ptHeat: field.i32(K),
    // Length of the beam the pod fired this tick (where it was stopped); 0 on any tick it fired none. Away: 1 while a returning
    // shot the pod threw is out (its weapon is away: it cannot fire until the shot is caught or gone).
    ptBeamLen: field.i32(K), ptAway: field.u8(K),

    // Projectiles: one pool for every owner
    pAlive: field.u8(P), pAttack: field.u8(P), pPart: field.u8(P), pDef: field.u16(P),
    pOwner: field.i32(P), pTeam: field.i32(P), pX: field.i32(P), pY: field.i32(P), pAng: field.i32(P), pSpd: field.i32(P),
    pAge: field.i32(P), pGraze: field.i32(P), pFree: field.i32(P),
    // Returning shots: ReturnMode, and the last thing struck (a seat, -2 - n for neutral unit n, or -1). Lobbed shells: the age
    // at which they land and detonate (0: the blueprint's life).
    pMode: field.u8(P), pLast: field.i32(P), pFuse: field.i32(P),

    // Neutral units
    nAlive: field.u8(N), nType: field.u8(N),
    nX: field.i32(N), nY: field.i32(N), nVX: field.i32(N), nVY: field.i32(N), nHp: field.i32(N), nAge: field.i32(N),
    nAng: field.i32(N), nTX: field.i32(N), nTY: field.i32(N), nFlash: field.i32(N), nFree: field.i32(N),

    // Energy orbs
    oAlive: field.u8(O), oX: field.i32(O), oY: field.i32(O), oVX: field.i32(O), oVY: field.i32(O), oVal: field.i32(O),
    oAge: field.i32(O), oFree: field.i32(O),
  } as const;
}
