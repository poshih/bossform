import type * as THREE from 'three';

/**
 * The scene's draw order, bottom to top. Every material in the scene is transparent and none writes depth, so the order in
 * which things are drawn IS their layering. Three draws transparent objects by renderOrder first and depth second (farthest
 * first), so every renderable carries its layer as its renderOrder, and depth only orders things within one layer: that is
 * how the parts of a robot, a colossus or a neutral unit stack by height.
 *
 * Depth cannot order anything across layers: a batch of instances (bullets, effects) is one mesh whose depth is taken at the
 * world origin, and the arena floor's at its centre, wherever the camera is.
 *
 * Groups never carry a renderOrder: three makes a Group's renderOrder the first sort key for everything beneath it, and
 * every nested Group resets it, so a layer set on a Group would silently stop at the next Group down.
 */
export const DrawLayer = {
  Backdrop: -60,
  Floor: -50,
  Storm: -45,
  Orbs: -40,
  /** The dark plate and team glow under each ship, so it reads against any floor. */
  ShipUnderlay: -30,
  /** Robots, colossi and neutral units: three's default renderOrder, so the model factories need not know about layers. */
  Bodies: 0,
  Shields: 10,
  /** The rings around a ship that carry information: energy arc, marker, bulwark, ready aura. */
  ShipOverlay: 20,
  /** Shield hits and breaks, boost wakes and afterimages. */
  ShipEffects: 30,
  /** Explosions and sparks: under the bullets, which must stay readable through them. */
  Fx: 35,
  Projectiles: 40,
  /** The hurtbox core, above everything, like a danmaku hitbox: the one thing a pilot must always be able to see. */
  CoreRing: 60,
  CoreDot: 61,
} as const;

/** Puts every renderable under `root` (itself included) on `layer`, leaving the Groups alone (see DrawLayer). */
export function setDrawLayer(root: THREE.Object3D, layer: number): void {
  root.traverse((object) => {
    const drawable = object as THREE.Object3D & { isMesh?: boolean; isLine?: boolean; isPoints?: boolean };
    if (drawable.isMesh === true || drawable.isLine === true || drawable.isPoints === true) object.renderOrder = layer;
  });
}
