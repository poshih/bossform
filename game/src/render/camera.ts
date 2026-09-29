import * as THREE from 'three';
import { fx } from '@metronome/engine';
import type { World } from '../sim/index.ts';
import { Form } from '../sim/index.ts';
import { expStep, lerp, toWorld } from '../view/shared.ts';

const CAMERA_FOV_DEGREES = 32;
const CAMERA_NEAR = 8;
const CAMERA_FAR = 6000;
const CAMERA_TILT_DEGREES = 20;
const NORMAL_VIEW_HEIGHT = 520;
const BOSS_VIEW_HEIGHT = 700;
const AIM_LEAD = 52;
const VELOCITY_LEAD_SECONDS = 0.28;
const FRAME_FORWARD_OFFSET = 18;
const FOLLOW_SHARPNESS = 7.6;
const HEIGHT_SHARPNESS = 5.5;
const ROLL_SHARPNESS = 8;
const ROLL_FROM_LATERAL = 0.0035;
const MAX_ROLL = 0.12;
const SHAKE_DECAY = 2.2;
const SHAKE_ROTATION_SCALE = 0.0022;
const SHAKE_POSITION_SCALE = 0.34;

export interface CameraTarget {
  readonly seat: number;
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  readonly aim: number;
  readonly alive: boolean;
  readonly boss: boolean;
}

export class FollowCamera {
  readonly camera = new THREE.PerspectiveCamera(CAMERA_FOV_DEGREES, 1, CAMERA_NEAR, CAMERA_FAR);

  private cssWidth = 1;
  private cssHeight = 1;
  private readonly tilt = (CAMERA_TILT_DEGREES * Math.PI) / 180;
  private x = 0;
  private y = 0;
  private height = NORMAL_VIEW_HEIGHT;
  private roll = 0;
  private lastVX = 0;
  private lastVY = 0;
  private shake = 0;
  private shakeTime = 0;
  private readonly ndc = new THREE.Vector2();
  private readonly origin = new THREE.Vector3();
  private readonly direction = new THREE.Vector3();
  private readonly groundPoint = { x: 0, y: 0 };

  constructor(world: World) {
    if (world.seats > 0) {
      this.x = toWorld(world.m.plX[0]);
      this.y = toWorld(world.m.plY[0]);
      this.lastVX = toWorld(world.m.plVX[0]);
      this.lastVY = toWorld(world.m.plVY[0]);
    }
    this.updateProjection();
  }

  resize(cssWidth: number, cssHeight: number): void {
    this.cssWidth = Math.max(1, cssWidth);
    this.cssHeight = Math.max(1, cssHeight);
    this.camera.aspect = this.cssWidth / this.cssHeight;
    this.updateProjection();
  }

  impulse(weight: number): void {
    this.shake += weight;
  }

  update(target: CameraTarget, dtSeconds: number): void {
    const viewHeight = target.boss ? BOSS_VIEW_HEIGHT : NORMAL_VIEW_HEIGHT;
    this.height = expStep(this.height, viewHeight, HEIGHT_SHARPNESS, dtSeconds);
    const aimRadians = fx.toRadians(target.aim);
    const desiredX = target.alive
      ? target.x + Math.cos(aimRadians) * AIM_LEAD + target.vx * VELOCITY_LEAD_SECONDS
      : this.x;
    const desiredY = target.alive
      ? target.y + Math.sin(aimRadians) * (AIM_LEAD + FRAME_FORWARD_OFFSET) + target.vy * VELOCITY_LEAD_SECONDS
      : this.y;
    this.x = expStep(this.x, desiredX, FOLLOW_SHARPNESS, dtSeconds);
    this.y = expStep(this.y, desiredY, FOLLOW_SHARPNESS, dtSeconds);

    const ax = (target.vx - this.lastVX) / Math.max(dtSeconds, 1 / 240);
    const ay = (target.vy - this.lastVY) / Math.max(dtSeconds, 1 / 240);
    this.lastVX = lerp(this.lastVX, target.vx, 0.45);
    this.lastVY = lerp(this.lastVY, target.vy, 0.45);
    const rightX = Math.sin(aimRadians);
    const rightY = -Math.cos(aimRadians);
    const lateral = ax * rightX + ay * rightY;
    const wantedRoll = Math.max(-MAX_ROLL, Math.min(MAX_ROLL, -lateral * ROLL_FROM_LATERAL));
    this.roll = expStep(this.roll, wantedRoll, ROLL_SHARPNESS, dtSeconds);

    this.shake *= Math.exp(-SHAKE_DECAY * dtSeconds);
    this.shakeTime += dtSeconds * (10 + this.shake * 6);

    const distance = (this.height * 0.5) / Math.tan((this.camera.fov * Math.PI) / 360);
    const back = Math.sin(this.tilt) * distance;
    const up = Math.cos(this.tilt) * distance;
    const shakeWaveA = Math.sin(this.shakeTime * 1.7) + Math.sin(this.shakeTime * 2.9 + 1.1) * 0.7;
    const shakeWaveB = Math.cos(this.shakeTime * 2.4 + 0.3) + Math.sin(this.shakeTime * 3.3 + 0.9) * 0.6;
    const shakeWaveC = Math.sin(this.shakeTime * 1.2 + 1.8);
    const dx = shakeWaveA * this.shake * SHAKE_POSITION_SCALE;
    const dy = shakeWaveB * this.shake * SHAKE_POSITION_SCALE;
    const dz = Math.abs(shakeWaveC) * this.shake * SHAKE_POSITION_SCALE * 0.4;

    this.camera.position.set(this.x + dx, this.y - back + dy, up + dz);
    this.camera.up.set(Math.sin(this.roll + shakeWaveC * this.shake * SHAKE_ROTATION_SCALE), Math.cos(this.roll + shakeWaveC * this.shake * SHAKE_ROTATION_SCALE), 0);
    this.camera.lookAt(this.x, this.y, 0);
    this.camera.updateMatrixWorld();
  }

  project(x: number, y: number, out: { x: number; y: number }): void {
    const point = new THREE.Vector3(x, y, 0).project(this.camera);
    out.x = ((point.x + 1) * 0.5) * this.cssWidth;
    out.y = ((1 - point.y) * 0.5) * this.cssHeight;
  }

  /** The floor point (world units) under a screen position. The fixed tilt and field of view keep every pixel below the horizon. */
  ground(cssX: number, cssY: number, out: { x: number; y: number }): void {
    this.ndc.set((cssX / this.cssWidth) * 2 - 1, 1 - (cssY / this.cssHeight) * 2);
    this.origin.setFromMatrixPosition(this.camera.matrixWorld);
    this.direction.set(this.ndc.x, this.ndc.y, 0.5).unproject(this.camera).sub(this.origin).normalize();
    if (!(this.direction.z < 0)) throw new RangeError(`screen position (${cssX}, ${cssY}) does not look at the floor`);
    const t = -this.origin.z / this.direction.z;
    out.x = this.origin.x + this.direction.x * t;
    out.y = this.origin.y + this.direction.y * t;
  }

  aimFrom(world: World, seat: number, cssX: number, cssY: number): number {
    if (seat < 0 || seat >= world.seats) throw new RangeError(`seat ${seat} is out of range`);
    this.ground(cssX, cssY, this.groundPoint);
    return fx.fromRadians(Math.atan2(this.groundPoint.y - toWorld(world.m.plY[seat]), this.groundPoint.x - toWorld(world.m.plX[seat])));
  }

  private updateProjection(): void {
    this.camera.aspect = this.cssWidth / this.cssHeight;
    this.camera.updateProjectionMatrix();
  }
}

export function isBossSeat(world: World, seat: number): boolean {
  return world.m.plForm[seat] === Form.Boss;
}
