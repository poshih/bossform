/**
 * Screen shake is for rare, big explosions only: a colossus destroyed. It shakes at full strength when it happens near
 * the followed pilot and fades to nothing at FAR_SHAKE_DISTANCE (an explosion across the arena does not move your camera).
 */
export const COLOSSUS_DEATH_SHAKE = 1;
export const NEAR_SHAKE_DISTANCE = 260;
export const FAR_SHAKE_DISTANCE = 900;

/** 0..1: how strongly an explosion `distance` world units from the followed pilot shakes the camera. */
export function shakeFalloff(distance: number): number {
  return 1 - Math.min(1, Math.max(0, (distance - NEAR_SHAKE_DISTANCE) / (FAR_SHAKE_DISTANCE - NEAR_SHAKE_DISTANCE)));
}
