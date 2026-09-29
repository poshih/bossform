/**
 * Public surface of the BOSSFORM simulation. Everything outside `sim/` (views, UI, audio, bots, tools) imports
 * from here only, and treats the world as read-only.
 */
export { GameSim, createGameSim } from './sim.ts';
export { World, decodeConfig, encodeConfig } from './world.ts';
export type { Layout, Mem, MatchConfig, SeatConfig } from './world.ts';
export { W, layoutFor } from './layout.ts';
export { Ev, Banner, EventQueue, FireSlot } from './events.ts';
export { gameCodec, Button, MOVE_MAX, NEUTRAL_INPUT } from './input.ts';
export type { GameInput } from './input.ts';
export * from './constants.ts';
export { ALT_ABILITIES, Frame, FRAME_COUNT, FRAME_STATS, MUZZLE, PRIMARY_WEAPONS, VANGUARD, GALE, JUGGERNAUT } from './frames.ts';
export type { BoostStats, FrameStats } from './frames.ts';
export { canBoost, dodging } from './boost.ts';
export { attacking, canUseAlt } from './weapons.ts';
export { FORMS, PartKind, Role } from './forms.ts';
export type { AttackTiming, FormDef, PartDef, SalvoDef, SiegeDef, UltimaDef, VolleyDef } from './forms.ts';
export { Proj, PROJ_KIND_COUNT, SHOT_DEFS, ShotFlag } from './shots.ts';
export type { ShotDef } from './shots.ts';
export { NEUTRAL_DEFS, NEUTRAL_TYPE_COUNT, NeutralType } from './neutrals.ts';
export type { NeutralDef } from './neutrals.ts';
export { AttackBlock, attackBlocker, attackFuel, canStartAttack } from './boss.ts';
export { isFighting, partCenter, pickupRadius, podMuzzle } from './query.ts';
export { inside, radial, span2, within } from './geometry.ts';
export type { Vec } from './geometry.ts';
