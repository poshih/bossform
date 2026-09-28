import type * as THREE from 'three';

/**
 * Contract between the field view and the procedural robot models.
 *
 * Conventions for every model:
 *  - Built from Three.js primitives + the toon/glow materials in render/meshkit.ts. No textures, no assets.
 *  - The camera looks straight down the -Z axis at the XY plane: +X is right, +Y is up on screen, +Z is toward
 *    the camera (height above the floor). The model is seen from ABOVE.
 *  - `root` sits at the machine's centre. An angle of 0 means "facing +X"; angles are radians, counter-clockwise.
 *  - Units are world units: 1 unit == 1 simulation unit. The arena is 320 x 400.
 *  - Models are pure presentation: they only read the pose given to update(); they never keep game state.
 */
export interface MechPose {
  /** Seconds, monotonically increasing (idle animation, pulsing glows). */
  time: number;
  /** Direction of travel. The lower body / legs / thrusters follow this. */
  moveAngle: number;
  /** 0..1: current speed as a fraction of this frame's top speed (lean, thruster strength). */
  speed: number;
  /** Direction the weapons point. The upper body follows this independently of moveAngle (twin-stick). */
  aimAngle: number;
  /** 1 on the tick a weapon fires, decaying to 0 (muzzle flash, recoil). */
  fire: number;
  /** 0 = normal form, 1 = full boss form. Animate armour/limbs unfolding as it moves 0 -> 1 (about 0.75 s). */
  transform: number;
  /** 0..1: alt ability active (dash streak, shield up). */
  alt: number;
  /** 0..1: damage flash. */
  hit: number;
  /** 0..1: how full the boss gauge is (a subtle "ready" glow near 1). */
  charge: number;
}

export interface MechModel {
  readonly root: THREE.Group;
  /** Footprint radius of the normal form and of the boss form, in world units. */
  readonly radius: number;
  readonly bossRadius: number;
  update(pose: MechPose): void;
  dispose(): void;
}

export interface EnemyPose {
  time: number;
  /** Direction the machine is travelling / facing. */
  heading: number;
  /** Direction toward the player it is targeting (turrets track this). */
  aim: number;
  /** 0..1 damage flash. */
  flash: number;
  /** 0..1 attack tell (lancer charging, boss winding up). */
  telegraph: number;
  /** 0..1 remaining health. */
  hp: number;
  /** Boss phase 0..2 (armour opens up, glows intensify, parts detach). Ignored by ordinary enemies. */
  phase: number;
  /** 0..1 progress through the death sequence (bosses). */
  dying: number;
  /** True while shielded / invulnerable (bosses gliding in or changing phase). */
  invulnerable: boolean;
  /** 0..1 speed fraction for thruster / lean effects. */
  speed: number;
}

export interface EnemyModel {
  readonly root: THREE.Group;
  /** Collision radius in world units the model was fitted to. */
  readonly radius: number;
  update(pose: EnemyPose): void;
  dispose(): void;
}
