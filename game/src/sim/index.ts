/**
 * Public surface of the BOSSFORM simulation. Everything outside `sim/` (views, UI, audio, bots, tools) imports
 * from here only, and treats the world as read-only.
 */
export { GameSim, createGameSim } from './sim.ts';
export { World, Config, encodeConfig } from './world.ts';
export type { Mem } from './world.ts';
export { W, LAYOUT } from './layout.ts';
export { Ev, Banner, EventQueue } from './events.ts';
export { gameCodec, Button, MOVE_MAX, NEUTRAL_INPUT } from './input.ts';
export type { GameInput } from './input.ts';
export * from './constants.ts';
