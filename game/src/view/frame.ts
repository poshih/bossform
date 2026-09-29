import type * as THREE from 'three';
import type { Beat } from '../beat.ts';
import type { World } from '../sim/index.ts';
import type { WorldSnapshot } from './snapshot.ts';

/** Everything a view may know about the frame being drawn. Built once per frame by the Stage. */
export interface FrameContext {
  /** The live simulation, read only (for queries such as podMuzzle); positions to draw come from the snapshots. */
  readonly world: World;
  /** 0..1 between the previous and the current snapshot (render interpolation). */
  readonly alpha: number;
  /** Seconds since the last rendered frame. */
  readonly dt: number;
  /** Seconds since this stage was created (presentation time; stops while the match is paused). */
  readonly time: number;
  /** The pilot the camera follows (the local pilot, or whoever is being spectated). */
  readonly focusSeat: number;
  readonly focusTeam: number;
  readonly beat: Beat;
}

/**
 * One part of the scene (ships, projectiles, effects, the arena...). The Stage owns the list and calls every view the
 * same way, so a view is self-contained: it reacts to the simulation's events and draws from the two latest snapshots.
 */
export interface StageView {
  readonly root: THREE.Object3D;
  /** The events of the ticks simulated since the last frame (world.events), before they are cleared. */
  handleEvents(world: World, focusSeat: number): void;
  update(previous: WorldSnapshot, current: WorldSnapshot, frame: FrameContext): void;
  dispose(): void;
}
