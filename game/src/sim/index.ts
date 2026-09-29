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
export { Frame, FRAME_COUNT, FRAME_STATS, MUZZLE, VANGUARD, GALE, JUGGERNAUT } from './frames.ts';
export type { FrameStats } from './frames.ts';
export { FORMS, PartKind, Role } from './forms.ts';
export type { AttackTiming, FormDef, PartDef, SalvoDef, SiegeDef, UltimaDef, VolleyDef } from './forms.ts';
export { Proj, PROJ_KIND_COUNT, SHOT_DEFS, ShotFlag } from './shots.ts';
export type { ShotDef } from './shots.ts';
export { NEUTRAL_DEFS, NEUTRAL_TYPE_COUNT, NeutralType } from './neutrals.ts';
export type { NeutralDef } from './neutrals.ts';
export { isFighting, partCenter, pickupRadius, podMuzzle } from './query.ts';
export { radial, within } from './geometry.ts';
export type { Vec } from './geometry.ts';
