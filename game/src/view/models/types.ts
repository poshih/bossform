import type * as THREE from 'three';

/**
 * Contract between the scene views and the procedural models.
 *
 * Conventions for every model:
 *  - Built only from Three.js geometry drawn with the vector-mesh material (render/vector.ts). No textures, no assets.
 *  - Ground plane is XY, +Z points toward the camera (height above the floor). The camera looks down from +Z, tilted.
 *    Angles are radians, counter-clockwise, 0 = +X. Units are world units: 1 unit == 1 simulation unit.
 *  - The view sets `root.position` (x, y, z = 0). The MODEL owns every rotation (hull, pods, orbit) from the pose it is
 *    given, and adds animation (idle bob, banking, glows) on top. Models keep no game state and never read the sim.
 *  - Team colour: `setTeam` tints the edge colour of the hull. Part edges may vary brightness but keep the hue.
 *  - Sizes come from the simulation's tables: a colossus builds each part at exactly FORMS[frame].parts[k]
 *    (offset, radius) so what is drawn is what is hit. Robots fit inside FRAME_STATS[frame].bodyR (visual radius
 *    of the core hurtbox is much smaller: the hull is drawn bigger than the hurtbox on purpose).
 */

/** A robot in its normal form. */
export interface RobotPose {
  /** Seconds, monotonically increasing (idle animation, pulsing glows). */
  time: number;
  /** Direction the weapons and hull face (twin-stick: independent of travel). */
  aim: number;
  /** Direction of travel (thrusters, banking). */
  move: number;
  /** 0..1 speed as a fraction of the frame's top speed. */
  speed: number;
  /** 1 on the tick a weapon fires, decaying to 0 (muzzle flash, recoil). */
  fire: number;
  /**
   * 0..1 alt ability active (VANGUARD: seekers launching, GALE: dash streak, JUGGERNAUT: bulwark raised, PRISM: lance tell
   * progress 0 -> 1 until the rail fires; every other robot: a pulse on the tick its alt is used, decaying to 0).
   */
  alt: number;
  /**
   * 0..1 the robot's own weapon state, 0 for VANGUARD, GALE and JUGGERNAUT. LONGBOW: rail charge (1 = FULL). PRISM: 0 idle,
   * 0 -> 0.5 through the beam's tell, 1 while the beam fires. HAILSTORM: rotary spin. RONIN: parry stance. SHADE: cloak (the
   * model fades to a thin shimmering outline; only its own team ever sees it cloaked). GAUNTLET: 1 while its rocket fist is in
   * flight (the left fist is gone).
   */
  special: number;
  /**
   * Where the latest of the robot's alternating shots left from: 1 its left (+y in its own frame, aiming along +x), -1 its
   * right; 0 for robots whose shots do not alternate. RONIN's katana swings from this side, GAUNTLET's knuckle leaves from
   * this arm, HAILSTORM's shot left from this barrel pair (paired with `fire`).
   */
  side: number;
  /** 0..1 damage flash. */
  hit: number;
  /** 0..1 energy gauge fullness (a "ready" glow as it nears the transform threshold and beyond). */
  charge: number;
  /** 0..1 spawn / dash protection (a shimmering shell). */
  shield: number;
  /** 0..1 folding away into the colossus (0 = normal, 1 = gone). Animate the hull collapsing toward the core. */
  morph: number;
}

export interface RobotModel {
  readonly root: THREE.Group;
  setTeam(color: THREE.Color): void;
  update(pose: RobotPose): void;
  dispose(): void;
}

/** One boss-form part; the array index equals the part's index in FORMS[frame].parts. */
export interface PartPose {
  /** 0..1 health; 0 = destroyed: the part is gone (hide it; the view spawns debris). */
  hp: number;
  /** Where a pod's barrel points, world radians (armour ignores it). */
  facing: number;
  /** 0..1 hit flash. */
  flash: number;
  /** 0..1 recently fired: vents glow, the part is vulnerable (takes extra damage). */
  heat: number;
  /** 0..1 this pod's wind-up progress: the tell (barrel extends and brightens, energy gathers). 0 when idle. */
  charge: number;
  /** The pod's own returning shot (a rocket fist) is in flight: hide what it launched until it is caught. */
  away: boolean;
}

/** A boss form: a large armoured machine around a small core. */
export interface ColossusPose {
  time: number;
  /** Body angle, world radians. */
  body: number;
  /** Orbit angle for parts flagged `orbit`. */
  orbit: number;
  /** 0..1 assembly during the transformation (parts fly out from the core into place). */
  assemble: number;
  /** 0..1 speed fraction (thrusters). */
  speed: number;
  /** Attack in progress: Attack id (0 none) and AttackPhase (0 idle, 1 wind-up, 2 release, 3 recovery). */
  attack: number;
  phase: number;
  /** 0..1 progress through the current phase (wind-up: the tell grows with this). */
  progress: number;
  /** 0..1 fuel left: the core dims as it burns down. */
  fuel: number;
  /** 0..1 core hit flash. */
  hit: number;
  parts: readonly PartPose[];
}

export interface ColossusModel {
  readonly root: THREE.Group;
  setTeam(color: THREE.Color): void;
  update(pose: ColossusPose): void;
  dispose(): void;
}

/** Neutral units: hazards that shoot at everyone and drop energy. */
export interface NeutralPose {
  time: number;
  /** 0..1 warp-in draw-on state after spawning. */
  spawn?: number;
  /** Direction of travel / facing. */
  heading: number;
  /** 0..1 damage flash. */
  flash: number;
  /** 0..1 remaining health. */
  hp: number;
  /** 0..1 just fired or about to (cannons glow). */
  telegraph: number;
  /** 0..1 speed fraction. */
  speed: number;
}

export interface NeutralModel {
  readonly root: THREE.Group;
  update(pose: NeutralPose): void;
  dispose(): void;
}
