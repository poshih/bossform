import { fx } from '@metronome/engine';
import { PRIMARY_WEAPONS } from '../sim/index.ts';
import type { World } from '../sim/index.ts';

/*
 * The contract between the shared computer pilot (bot.ts) and each robot's own tactics (bot/<robot>.ts). The pilot does what
 * every robot does alike: it picks a target, leads its aim, dodges, runs chores, boosts, keeps its energy discipline, flies
 * the boss form and decides when to transform. A robot's tactics decide only what is its own: its fighting distance, when to
 * use its primary and its alt, and, where the robot needs it, a different aim or approach. Tactics are created per bot and
 * may keep state between ticks; they must decide deterministically (use `sense.random`, never Math.random).
 */

const UNIT = 1 / fx.ONE;
/** Fixed point to world units. */
export const to = (raw: number): number => raw * UNIT;

/** No robot opens fire at anything farther away than this, whatever its primary's reach. */
export const FIRE_RANGE = 430;
/** A robot opens fire only where its primary's shots still reach (energy is not spent on shots that fade short). */
const REACH_SHARE = 0.92;

export interface Point {
  x: number;
  y: number;
}

/** What a bot aims at: an opposing pilot (`seat`) or a neutral unit (`seat` -1). */
export interface Target extends Point {
  vx: number;
  vy: number;
  ship: boolean;
  seat: number;
}

/** A normal-form bot's reading of this tick, built by bot.ts for its robot's tactics. Positions in world units. */
export interface BotSense {
  readonly w: World;
  readonly seat: number;
  readonly me: Point;
  readonly target: Target;
  /** Distance to the target. */
  readonly range: number;
  /** The shared aim at the target, led for the primary's shot speed (binary angle). */
  readonly aim: number;
  /** A hostile shot or hazard is about to land and the bot is dodging it. */
  readonly threatened: boolean;
  /** Ticks until the soonest hostile shot or hazard reaches the bot (Infinity when none threatens). */
  readonly soonest: number;
  /** Energy discipline: the bot holds fire until its pool refills (see bot.ts). */
  readonly conserving: boolean;
  /** The target's shield just shattered: fire on it whatever the discipline says. */
  readonly exposed: boolean;
  /** 0..1: how sharply the bot reacts and how well it leads its aim. */
  readonly skill: number;
  /** The bot's own deterministic random stream. */
  random(): number;
}

export interface RobotTactics {
  /** Preferred fighting distance, world units. */
  readonly range: number;
  /** Fire and Alt this tick (the shared pilot adds Boost and Boss). Called once per tick, before `aim`. */
  buttons(sense: BotSense): number;
  /** Where to aim this tick, binary angle (`sense.aim` to keep the shared lead). */
  aim(sense: BotSense): number;
  /** A movement goal replacing the shared approach-and-strafe (dodging and chores still come first), or null to keep it. */
  move(sense: BotSense): Point | null;
}

/** The target is within the reach of the robot's primary. */
export function inPrimaryReach(sense: BotSense): boolean {
  const reach = Math.min(FIRE_RANGE, to(PRIMARY_WEAPONS[sense.w.m.plFrame[sense.seat]].reach) * REACH_SHARE);
  return sense.range < reach;
}

/** Energy discipline allows an attack now. */
export function mayFire(sense: BotSense): boolean {
  return !sense.conserving || sense.exposed;
}

/** The binary angle toward where the target will be in `ticks` ticks if it keeps its velocity (scaled by skill). */
export function leadTicks(sense: BotSense, ticks: number): number {
  const t = ticks * sense.skill;
  const { target, me } = sense;
  return fx.fromRadians(Math.atan2(target.y + target.vy * t - me.y, target.x + target.vx * t - me.x));
}
