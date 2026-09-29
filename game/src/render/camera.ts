import * as THREE from 'three';
import { fx } from '@metronome/engine';
import type { World } from '../sim/index.ts';
import { toWorld } from '../view/shared.ts';

const CAMERA_FOV_DEGREES = 32;
const CAMERA_NEAR = 8;
const CAMERA_FAR = 6000;
const CAMERA_TILT_DEGREES = 20;
/** World units of floor from the top to the bottom of the screen around the followed pilot. */
const NORMAL_VIEW_HEIGHT = 520;
/** A colossus is large and slow: its pilot sees more of the arena. */
const BOSS_VIEW_HEIGHT = 700;
/**
 * Seconds for the camera to settle on the followed pilot. The follow is a critically damped spring: it never overshoots
 * and never oscillates, so dodging back and forth does not swing the view. The camera never leads toward the aim: the
 * aim is read through the camera, so leading would feed the aim back into itself.
 */
const FOLLOW_SMOOTH_SECONDS = 0.1;
/** When the followed point is farther than this (a respawn, or spectating someone else), the camera travels more gently. */
const TRAVEL_DISTANCE = 360;
const TRAVEL_SMOOTH_SECONDS = 0.3;
const ZOOM_SMOOTH_SECONDS = 0.45;
/**
 * Screen shake is reserved for rare, big explosions (a colossus destroyed). `shake(strength)` adds trauma (0..1); the offset
 * is trauma squared times the peak, it is a pure translation (the view never tilts or rolls) and it never reaches the aim.
 */
const SHAKE_PEAK_UNITS = 9;
const SHAKE_TRAUMA_DECAY_PER_SECOND = 1.5;
const SHAKE_WOBBLE_HZ = [7.3, 11.9, 5.1] as const;

export interface CameraTarget {
  readonly x: number;
  readonly y: number;
  readonly alive: boolean;
  readonly boss: boolean;
}

/** Critically damped smoothing toward a moving target (Game Programming Gems 4, 1.10): frame-rate independent. */
class SmoothValue {
  value: number;
  private velocity = 0;

  constructor(value: number) {
    this.value = value;
  }

  step(target: number, smoothSeconds: number, dtSeconds: number): number {
    const omega = 2 / smoothSeconds;
    const x = omega * dtSeconds;
    const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
    const change = this.value - target;
    const temp = (this.velocity + omega * change) * dtSeconds;
    this.velocity = (this.velocity - omega * temp) * decay;
    this.value = target + (change + temp) * decay;
    return this.value;
  }

  snap(value: number): void {
    this.value = value;
    this.velocity = 0;
  }
}

/**
 * Follows one pilot from above and slightly behind (a fixed tilt, no roll). Two cameras share the pose: `camera` is what is
 * drawn (it carries the shake), `steady` never shakes and is the one aiming and floor picks go through.
 */
export class FollowCamera {
  readonly camera = new THREE.PerspectiveCamera(CAMERA_FOV_DEGREES, 1, CAMERA_NEAR, CAMERA_FAR);
  private readonly steady = new THREE.PerspectiveCamera(CAMERA_FOV_DEGREES, 1, CAMERA_NEAR, CAMERA_FAR);
  private readonly tilt = (CAMERA_TILT_DEGREES * Math.PI) / 180;
  private readonly x = new SmoothValue(0);
  private readonly y = new SmoothValue(0);
  private readonly height = new SmoothValue(NORMAL_VIEW_HEIGHT);
  private placed = false;
  private cssWidth = 1;
  private cssHeight = 1;
  private trauma = 0;
  private shakeTime = 0;
  private readonly scratch = new THREE.Vector3();
  private readonly ndc = new THREE.Vector2();
  private readonly origin = new THREE.Vector3();
  private readonly direction = new THREE.Vector3();
  private readonly groundPoint = { x: 0, y: 0 };

  constructor() {
    this.pose(this.steady, 0, 0);
    this.pose(this.camera, 0, 0);
  }

  resize(cssWidth: number, cssHeight: number): void {
    this.cssWidth = Math.max(1, cssWidth);
    this.cssHeight = Math.max(1, cssHeight);
    for (const camera of [this.camera, this.steady]) {
      camera.aspect = this.cssWidth / this.cssHeight;
      camera.updateProjectionMatrix();
    }
  }

  /** Adds screen shake (0..1). Only for rare big explosions; see SHAKE_PEAK_UNITS. */
  shake(strength: number): void {
    this.trauma = Math.min(1, this.trauma + strength);
  }

  update(target: CameraTarget, dtSeconds: number): void {
    const viewHeight = target.boss ? BOSS_VIEW_HEIGHT : NORMAL_VIEW_HEIGHT;
    if (!this.placed) {
      this.x.snap(target.x);
      this.y.snap(target.y);
      this.height.snap(viewHeight);
      this.placed = true;
    }
    this.height.step(viewHeight, ZOOM_SMOOTH_SECONDS, dtSeconds);
    if (target.alive) {
      const far = Math.hypot(target.x - this.x.value, target.y - this.y.value) > TRAVEL_DISTANCE;
      const smooth = far ? TRAVEL_SMOOTH_SECONDS : FOLLOW_SMOOTH_SECONDS;
      this.x.step(target.x, smooth, dtSeconds);
      this.y.step(target.y, smooth, dtSeconds);
    }
    this.pose(this.steady, 0, 0);

    this.trauma = Math.max(0, this.trauma - SHAKE_TRAUMA_DECAY_PER_SECOND * dtSeconds);
    this.shakeTime += dtSeconds;
    const amount = this.trauma * this.trauma * SHAKE_PEAK_UNITS;
    const t = this.shakeTime * Math.PI * 2;
    const [a, b, c] = SHAKE_WOBBLE_HZ;
    const shakeX = amount * (Math.sin(t * a) * 0.6 + Math.sin(t * c + 1.3) * 0.4);
    const shakeY = amount * (Math.sin(t * b + 0.7) * 0.6 + Math.sin(t * c + 2.1) * 0.4);
    this.pose(this.camera, shakeX, shakeY);
  }

  /** The camera's pose, for tools and E2E checks: where it looks, how much floor it shows, and the current shake offset. */
  get state(): { readonly x: number; readonly y: number; readonly height: number; readonly shake: number } {
    return { x: this.x.value, y: this.y.value, height: this.height.value, shake: this.trauma * this.trauma * SHAKE_PEAK_UNITS };
  }

  /** World units to CSS pixels, through the drawn camera (overlays stay on what is drawn). */
  project(x: number, y: number, out: { x: number; y: number }): void {
    const point = this.scratch.set(x, y, 0).project(this.camera);
    out.x = ((point.x + 1) * 0.5) * this.cssWidth;
    out.y = ((1 - point.y) * 0.5) * this.cssHeight;
  }

  /** The floor point (world units) under a screen position, through the steady camera. The fixed tilt keeps every pixel below the horizon. */
  ground(cssX: number, cssY: number, out: { x: number; y: number }): void {
    this.ndc.set((cssX / this.cssWidth) * 2 - 1, 1 - (cssY / this.cssHeight) * 2);
    this.origin.setFromMatrixPosition(this.steady.matrixWorld);
    this.direction.set(this.ndc.x, this.ndc.y, 0.5).unproject(this.steady).sub(this.origin).normalize();
    if (!(this.direction.z < 0)) throw new RangeError(`screen position (${cssX}, ${cssY}) does not look at the floor`);
    const t = -this.origin.z / this.direction.z;
    out.x = this.origin.x + this.direction.x * t;
    out.y = this.origin.y + this.direction.y * t;
  }

  /** Binary angle from a pilot to the floor point under the cursor: where a shot fired now would go. */
  aimFrom(world: World, seat: number, cssX: number, cssY: number): number {
    if (seat < 0 || seat >= world.seats) throw new RangeError(`seat ${seat} is out of range`);
    this.ground(cssX, cssY, this.groundPoint);
    return fx.fromRadians(Math.atan2(this.groundPoint.y - toWorld(world.m.plY[seat]), this.groundPoint.x - toWorld(world.m.plX[seat])));
  }

  private pose(camera: THREE.PerspectiveCamera, offsetX: number, offsetY: number): void {
    const x = this.x.value + offsetX;
    const y = this.y.value + offsetY;
    const distance = (this.height.value * 0.5) / Math.tan((camera.fov * Math.PI) / 360);
    camera.position.set(x, y - Math.sin(this.tilt) * distance, Math.cos(this.tilt) * distance);
    camera.up.set(0, 1, 0);
    camera.lookAt(x, y, 0);
    camera.updateMatrixWorld();
  }
}
