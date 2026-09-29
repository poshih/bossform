import * as THREE from 'three';
import type { World } from '../sim/index.ts';
import { DrawLayer } from '../render/layers.ts';
import type { FrameContext, StageView } from './frame.ts';
import type { WorldSnapshot } from './snapshot.ts';
import { clamp01, easeOutBack, lerp, toWorld } from './shared.ts';

const ORB_Z = 1.16;
const TRAIL_Z = 1.04;
const ORB_BASE_RADIUS = 2.7;
const ORB_VALUE_RADIUS_GAIN = 1.7;
const ORB_SCATTER_TICKS = 18;
const ORB_TWINKLE_RATE = 7.2;
const ORB_TICK_RATE = 1.8;
const MAGNET_TRAIL_SPEED = 0.35;
const MAGNET_TRAIL_LENGTH_GAIN = 5.5;
const MAGNET_TRAIL_MIN = 10;
const MAGNET_TRAIL_WIDTH = 1.25;
const QUAD_POSITIONS = new Float32Array([
  -1, -1, 0,
  1, -1, 0,
  1, 1, 0,
  -1, 1, 0,
]);
const QUAD_INDEX = new Uint16Array([0, 1, 2, 0, 2, 3]);

const ORB_VERTEX = /* glsl */ `
attribute vec3 iCenter;
attribute float iScale;
attribute float iPulse;
attribute float iAge;
varying vec2 vLocal;
varying float vPulse;
varying float vAge;
void main() {
  vec2 local = position.xy * iScale;
  vec3 world = vec3(iCenter.xy + local, iCenter.z);
  vLocal = position.xy;
  vPulse = iPulse;
  vAge = iAge;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
}`;

const ORB_FRAGMENT = /* glsl */ `
varying vec2 vLocal;
varying float vPulse;
varying float vAge;
float diamond(vec2 p) { return abs(p.x) + abs(p.y) - 0.80; }
float ring(vec2 p, float r, float w) { return abs(length(p) - r) - w; }
float capsule(vec2 p, vec2 h) {
  vec2 q = abs(p) - h;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
}
void main() {
  vec2 p = vLocal;
  float orbitA = vAge * 1.8;
  vec2 tickA = vec2(cos(orbitA), sin(orbitA));
  vec2 tickB = vec2(cos(orbitA + 2.094), sin(orbitA + 2.094));
  vec2 tickC = vec2(cos(orbitA + 4.188), sin(orbitA + 4.188));
  float shell = min(diamond(p), ring(p, 0.70, 0.055));
  float core = length(p) - 0.25;
  float ticks = min(capsule(vec2(dot(p, tickA), dot(p, vec2(-tickA.y, tickA.x))) - vec2(0.68, 0.0), vec2(0.12, 0.025)), min(capsule(vec2(dot(p, tickB), dot(p, vec2(-tickB.y, tickB.x))) - vec2(0.68, 0.0), vec2(0.12, 0.025)), capsule(vec2(dot(p, tickC), dot(p, vec2(-tickC.y, tickC.x))) - vec2(0.68, 0.0), vec2(0.12, 0.025))));
  float edge = fwidth(shell) * 1.5;
  float shellAlpha = 1.0 - smoothstep(0.0, edge, shell);
  float coreAlpha = 1.0 - smoothstep(0.0, fwidth(core) * 1.5, core);
  float tickAlpha = 1.0 - smoothstep(0.0, fwidth(ticks) * 1.8, ticks);
  float twinkle = 0.78 + 0.22 * vPulse;
  vec3 cyan = vec3(0.20, 0.85, 1.35);
  vec3 white = vec3(1.15, 1.45, 1.65);
  vec3 color = cyan * shellAlpha * twinkle + white * (coreAlpha * 0.85 + tickAlpha * 0.9);
  float alpha = shellAlpha * 0.72 + coreAlpha * 0.42 + tickAlpha * 0.85;
  if (alpha <= 0.001) discard;
  gl_FragColor = vec4(color, alpha);
}`;

const TRAIL_VERTEX = /* glsl */ `
attribute vec3 iCenter;
attribute vec2 iScale;
attribute float iAngle;
attribute vec4 iColor;
varying vec2 vLocal;
varying vec4 vColor;
void main() {
  float c = cos(iAngle);
  float s = sin(iAngle);
  vec2 local = position.xy * iScale;
  vec2 world = vec2(local.x * c - local.y * s, local.x * s + local.y * c) + iCenter.xy;
  vLocal = position.xy;
  vColor = iColor;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(world, iCenter.z, 1.0);
}`;

const TRAIL_FRAGMENT = /* glsl */ `
varying vec2 vLocal;
varying vec4 vColor;
void main() {
  float along = vLocal.x * 0.5 + 0.5;
  float width = mix(0.08, 0.85, along);
  float shape = 1.0 - smoothstep(width, width + fwidth(vLocal.y) * 2.0, abs(vLocal.y));
  float taper = smoothstep(0.0, 0.25, along) * (1.0 - smoothstep(0.84, 1.0, along));
  float alpha = shape * taper * vColor.a;
  if (alpha <= 0.001) discard;
  gl_FragColor = vec4(vColor.rgb, alpha);
}`;

export class OrbsView implements StageView {
  readonly root = new THREE.Group();

  private readonly orbMesh: THREE.Mesh;
  private readonly orbGeometry: THREE.InstancedBufferGeometry;
  private readonly orbMaterial: THREE.ShaderMaterial;
  private readonly trailMesh: THREE.Mesh;
  private readonly trailGeometry: THREE.InstancedBufferGeometry;
  private readonly trailMaterial: THREE.ShaderMaterial;
  private readonly centers: Float32Array;
  private readonly scales: Float32Array;
  private readonly pulses: Float32Array;
  private readonly ages: Float32Array;
  private readonly trailCenters: Float32Array;
  private readonly trailScales: Float32Array;
  private readonly trailAngles: Float32Array;
  private readonly trailColors: Float32Array;
  private readonly orbAttrs: readonly THREE.InstancedBufferAttribute[];
  private readonly trailAttrs: readonly THREE.InstancedBufferAttribute[];

  constructor(world: World) {
    const max = world.cap.orbs;
    this.orbGeometry = this.makeGeometry();
    this.centers = new Float32Array(max * 3);
    this.scales = new Float32Array(max);
    this.pulses = new Float32Array(max);
    this.ages = new Float32Array(max);
    this.orbAttrs = [
      this.attr(this.orbGeometry, 'iCenter', this.centers, 3),
      this.attr(this.orbGeometry, 'iScale', this.scales, 1),
      this.attr(this.orbGeometry, 'iPulse', this.pulses, 1),
      this.attr(this.orbGeometry, 'iAge', this.ages, 1),
    ];
    this.orbMaterial = new THREE.ShaderMaterial({ vertexShader: ORB_VERTEX, fragmentShader: ORB_FRAGMENT, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    this.orbMesh = new THREE.Mesh(this.orbGeometry, this.orbMaterial);
    this.orbMesh.frustumCulled = false;
    this.orbMesh.renderOrder = DrawLayer.Orbs;

    this.trailGeometry = this.makeGeometry();
    this.trailCenters = new Float32Array(max * 3);
    this.trailScales = new Float32Array(max * 2);
    this.trailAngles = new Float32Array(max);
    this.trailColors = new Float32Array(max * 4);
    this.trailAttrs = [
      this.attr(this.trailGeometry, 'iCenter', this.trailCenters, 3),
      this.attr(this.trailGeometry, 'iScale', this.trailScales, 2),
      this.attr(this.trailGeometry, 'iAngle', this.trailAngles, 1),
      this.attr(this.trailGeometry, 'iColor', this.trailColors, 4),
    ];
    this.trailMaterial = new THREE.ShaderMaterial({ vertexShader: TRAIL_VERTEX, fragmentShader: TRAIL_FRAGMENT, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    this.trailMesh = new THREE.Mesh(this.trailGeometry, this.trailMaterial);
    this.trailMesh.frustumCulled = false;
    this.trailMesh.renderOrder = DrawLayer.Orbs;
    this.root.add(this.trailMesh, this.orbMesh);
  }

  handleEvents(): void {}

  update(previous: WorldSnapshot, current: WorldSnapshot, frame: FrameContext): void {
    const { alpha, time: timeSeconds } = frame;
    let count = 0;
    let trailCount = 0;
    for (let o = 0; o < current.orbs; o++) {
      if (current.oAlive[o] !== 1) continue;
      const snap = previous.oAlive[o] !== 1 ? 1 : alpha;
      const x = lerp(toWorld(previous.oX[o]), toWorld(current.oX[o]), snap);
      const y = lerp(toWorld(previous.oY[o]), toWorld(current.oY[o]), snap);
      const vx = toWorld(current.oVX[o]);
      const vy = toWorld(current.oVY[o]);
      const speed = Math.hypot(vx, vy);
      const scaleIn = current.oAge[o] >= ORB_SCATTER_TICKS ? 1 : 0.2 + easeOutBack(current.oAge[o] / ORB_SCATTER_TICKS) * 0.8;
      const i3 = count * 3;
      this.centers[i3] = x;
      this.centers[i3 + 1] = y;
      this.centers[i3 + 2] = ORB_Z;
      this.scales[count] = (ORB_BASE_RADIUS + clamp01(current.oVal[o] / 2400) * ORB_VALUE_RADIUS_GAIN) * scaleIn;
      this.pulses[count] = 0.5 + 0.5 * Math.sin(timeSeconds * ORB_TWINKLE_RATE + o * 0.73);
      this.ages[count] = timeSeconds * ORB_TICK_RATE + o * 0.31;
      count++;
      if (speed > MAGNET_TRAIL_SPEED) trailCount = this.appendTrail(trailCount, x, y, vx, vy, speed);
    }
    this.orbGeometry.instanceCount = count;
    this.trailGeometry.instanceCount = trailCount;
    this.markNeedsUpdate(this.orbAttrs);
    this.markNeedsUpdate(this.trailAttrs);
  }

  dispose(): void {
    this.orbGeometry.dispose();
    this.orbMaterial.dispose();
    this.trailGeometry.dispose();
    this.trailMaterial.dispose();
  }

  private appendTrail(count: number, x: number, y: number, vx: number, vy: number, speed: number): number {
    const angle = Math.atan2(vy, vx);
    const length = MAGNET_TRAIL_MIN + speed * MAGNET_TRAIL_LENGTH_GAIN;
    const i3 = count * 3;
    const i2 = count * 2;
    const i4 = count * 4;
    this.trailCenters[i3] = x - Math.cos(angle) * length * 0.45;
    this.trailCenters[i3 + 1] = y - Math.sin(angle) * length * 0.45;
    this.trailCenters[i3 + 2] = TRAIL_Z;
    this.trailScales[i2] = length;
    this.trailScales[i2 + 1] = MAGNET_TRAIL_WIDTH;
    this.trailAngles[count] = angle;
    this.trailColors[i4] = 0.28;
    this.trailColors[i4 + 1] = 1.05;
    this.trailColors[i4 + 2] = 1.55;
    this.trailColors[i4 + 3] = clamp01(speed * 0.18);
    return count + 1;
  }

  private makeGeometry(): THREE.InstancedBufferGeometry {
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.index = new THREE.BufferAttribute(QUAD_INDEX, 1);
    geometry.setAttribute('position', new THREE.BufferAttribute(QUAD_POSITIONS, 3));
    return geometry;
  }

  private attr(geometry: THREE.InstancedBufferGeometry, name: string, data: Float32Array, itemSize: number): THREE.InstancedBufferAttribute {
    const attr = new THREE.InstancedBufferAttribute(data, itemSize).setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute(name, attr);
    return attr;
  }

  private markNeedsUpdate(attrs: readonly THREE.InstancedBufferAttribute[]): void {
    for (const attr of attrs) attr.needsUpdate = true;
  }
}
