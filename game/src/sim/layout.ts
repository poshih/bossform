import { field } from '@metronome/engine';
import { MAX_BULLETS, MAX_ENEMIES, MAX_ORBS, MAX_PLAYERS, MAX_SHOTS } from './constants.ts';

/** Index map for the `world` scalar block. */
export const W = {
  Tick: 0,
  Stage: 1,
  Phase: 2,
  PhaseTimer: 3,
  ScriptPtr: 4,
  ScriptTimer: 5,
  Difficulty: 6,
  BossSlot: 7,
  PendingBoss: 8,
  StageTick: 9,
  StageHits: 10,
  BulletFree: 11,
  ShotFree: 12,
  EnemyFree: 13,
  OrbFree: 14,
  Count: 15,
} as const;

const P = MAX_PLAYERS;
const B = MAX_BULLETS;
const S = MAX_SHOTS;
const E = MAX_ENEMIES;
const O = MAX_ORBS;

/**
 * ALL simulation state. Nothing that influences a future tick may live anywhere else: this arena is what
 * gets checksummed, snapshotted and compared between peers.
 */
export const LAYOUT = {
  rng: field.u32(4),
  world: field.i32(W.Count),

  // Players (one entry per seat)
  plActive: field.u8(P), plFrame: field.u8(P), plPrevButtons: field.u8(P), plBeam: field.u8(P),
  plX: field.i32(P), plY: field.i32(P), plPX: field.i32(P), plPY: field.i32(P), plVX: field.i32(P), plVY: field.i32(P),
  plAim: field.i32(P), plHp: field.i32(P), plLives: field.i32(P), plInvuln: field.i32(P), plRespawn: field.i32(P),
  plGauge: field.i32(P), plBoss: field.i32(P), plTransform: field.i32(P), plFireCd: field.i32(P), plAltCd: field.i32(P),
  plAltFx: field.i32(P), plAltDX: field.i32(P), plAltDY: field.i32(P), plScore: field.i32(P), plGraze: field.i32(P),
  plKills: field.i32(P), plFlash: field.i32(P), plChain: field.i32(P), plChainTimer: field.i32(P), plBits: field.i32(P),

  // Enemy bullets (polar motion: heading + speed, both optionally animated)
  bAlive: field.u8(B), bKind: field.u8(B), bColor: field.u8(B), bFlags: field.u8(B),
  bDmg: field.i32(B), bX: field.i32(B), bY: field.i32(B), bVX: field.i32(B), bVY: field.i32(B), bAng: field.i32(B),
  bSpd: field.i32(B), bAcc: field.i32(B), bTurn: field.i32(B), bMaxSpd: field.i32(B), bAge: field.i32(B),
  bFree: field.i32(B),

  // Player shots
  sAlive: field.u8(S), sKind: field.u8(S), sOwner: field.u8(S), sPierce: field.u8(S),
  sX: field.i32(S), sY: field.i32(S), sVX: field.i32(S), sVY: field.i32(S), sAng: field.i32(S), sSpd: field.i32(S),
  sAcc: field.i32(S), sMaxSpd: field.i32(S), sTurn: field.i32(S), sDmg: field.i32(S), sSplash: field.i32(S),
  sRad: field.i32(S), sAge: field.i32(S), sLife: field.i32(S), sTarget: field.i32(S), sLastHit: field.i32(S), sFree: field.i32(S),

  // Enemies and bosses
  eAlive: field.u8(E), eType: field.u8(E), eFlags: field.u8(E), ePhase: field.u8(E),
  eX: field.i32(E), eY: field.i32(E), ePX: field.i32(E), ePY: field.i32(E), eVX: field.i32(E), eVY: field.i32(E),
  eHp: field.i32(E), eMaxHp: field.i32(E), eAge: field.i32(E), eTimer: field.i32(E), eRad: field.i32(E), eFlash: field.i32(E),
  eR0: field.i32(E), eR1: field.i32(E), eR2: field.i32(E), eR3: field.i32(E), eFree: field.i32(E),

  // Energy orbs dropped by destroyed enemies
  oAlive: field.u8(O), oX: field.i32(O), oY: field.i32(O), oVX: field.i32(O), oVY: field.i32(O), oVal: field.i32(O),
  oAge: field.i32(O), oFree: field.i32(O),
} as const;
