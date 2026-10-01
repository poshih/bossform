/**
 * Public surface of the BOSSFORM simulation. Everything outside `sim/` (views, UI, audio, bots, tools) imports
 * from here only, and treats the world as read-only.
 */
export { GameSim, createGameSim } from './sim.ts';
export { World, decodeConfig, encodeConfig } from './world.ts';
export type { Layout, Mem, MatchConfig, SeatConfig } from './world.ts';
export { W, layoutFor } from './layout.ts';
export { Ev, Banner, BeamKind, EventQueue, FireSlot, ReflectKind } from './events.ts';
export { gameCodec, Button, MOVE_MAX, NEUTRAL_INPUT } from './input.ts';
export type { GameInput } from './input.ts';
export * from './constants.ts';
export { ALT_ABILITIES, Frame, FRAME_COUNT, FRAME_STATS, MUZZLE, PRIMARY_WEAPONS, VANGUARD, GALE, JUGGERNAUT } from './frames.ts';
export type { AltAbility, BoostStats, FrameStats, PrimaryWeapon } from './frames.ts';
export { LONGBOW, BALLISTA } from './longbow.ts';
export { PRISM, HELIOS } from './prism.ts';
export { HAILSTORM, ARMADA } from './hailstorm.ts';
export { RONIN, SHOGUN } from './ronin.ts';
export { SHADE, KITSUNE } from './shade.ts';
export { GAUNTLET, ATLAS } from './gauntlet.ts';
export { canBoost, dodging } from './boost.ts';
export { attacking, canUseAlt, primaryCost } from './weapons.ts';
export { FORMS, PartKind, Pattern, Role } from './forms.ts';
export type {
  ArtilleryAttack, AttackTiming, BeamAttack, BombardUltima, CarpetAttack, CarpetUltima, FormDef, PartDef, SalvoDef, SiegeDef, SpiralUltima,
  UltimaBarrage, UltimaDef, VolleyAttack, VolleyDef, WheelUltima,
} from './forms.ts';
export { Proj, PROJ_KIND_COUNT, SHOT_DEFS, ShotFlag, shotReach } from './shots.ts';
export type { ShotDef } from './shots.ts';
export { hasReturning, ReturnMode } from './projectiles.ts';
export { NEUTRAL_DEFS, NEUTRAL_TYPE_COUNT, NeutralType } from './neutrals.ts';
export type { NeutralDef } from './neutrals.ts';
export { AttackBlock, attackBlocker, attackFuel, canStartAttack } from './boss.ts';
export { isFighting, partCenter, pickupRadius, podMuzzle, podReady, targetable } from './query.ts';
export { inside, radial, span2, within } from './geometry.ts';
export type { Vec } from './geometry.ts';
