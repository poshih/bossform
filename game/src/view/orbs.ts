import * as THREE from 'three';
import type { World } from '../sim/index.ts';
import type { WorldSnapshot } from './snapshot.ts';
import { clamp01, lerp, toWorld } from './shared.ts';

const VERTEX = /* glsl */ `
attribute vec3 iCenter;
attribute float iScale;
attribute float iPulse;
varying vec2 vLocal;
varying float vPulse;
void main() {
  vec2 local = position.xy * iScale;
  vec3 world = vec3(iCenter.xy + local, iCenter.z);
  vLocal = position.xy;
  vPulse = iPulse;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
}`;

const FRAGMENT = /* glsl */ `
varying vec2 vLocal;
varying float vPulse;
float diamond(vec2 p) { return abs(p.x) + abs(p.y) - 0.82; }
void main() {
  float d = min(diamond(vLocal), abs(length(vLocal) - 0.72) - 0.08);
  float edge = fwidth(d) * 1.5;
  float alpha = 1.0 - smoothstep(0.0, edge, d);
  vec3 color = mix(vec3(0.16, 0.72, 1.2), vec3(1.3, 1.6, 1.8), 0.5 + 0.5 * vPulse);
  gl_FragColor = vec4(color, alpha * 0.88);
}`;

export class OrbsView {
  readonly mesh: THREE.Mesh;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly centers: Float32Array;
  private readonly scales: Float32Array;
  private readonly pulses: Float32Array;
  private readonly centerAttr: THREE.InstancedBufferAttribute;
  private readonly scaleAttr: THREE.InstancedBufferAttribute;
  private readonly pulseAttr: THREE.InstancedBufferAttribute;

  constructor(world: World) {
    const max = world.cap.orbs;
    this.geometry = new THREE.InstancedBufferGeometry();
    this.geometry.index = new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1);
    this.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      -1, -1, 0,
      1, -1, 0,
      1, 1, 0,
      -1, 1, 0,
    ]), 3));
    this.centers = new Float32Array(max * 3);
    this.scales = new Float32Array(max);
    this.pulses = new Float32Array(max);
    this.centerAttr = new THREE.InstancedBufferAttribute(this.centers, 3).setUsage(THREE.DynamicDrawUsage);
    this.scaleAttr = new THREE.InstancedBufferAttribute(this.scales, 1).setUsage(THREE.DynamicDrawUsage);
    this.pulseAttr = new THREE.InstancedBufferAttribute(this.pulses, 1).setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('iCenter', this.centerAttr);
    this.geometry.setAttribute('iScale', this.scaleAttr);
    this.geometry.setAttribute('iPulse', this.pulseAttr);
    this.material = new THREE.ShaderMaterial({ vertexShader: VERTEX, fragmentShader: FRAGMENT, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
  }

  update(previous: WorldSnapshot, current: WorldSnapshot, alpha: number, timeSeconds: number): void {
    let count = 0;
    for (let o = 0; o < current.orbs; o++) {
      if (current.oAlive[o] !== 1) continue;
      const snap = previous.oAlive[o] !== 1 ? 1 : alpha;
      const x = lerp(toWorld(previous.oX[o]), toWorld(current.oX[o]), snap);
      const y = lerp(toWorld(previous.oY[o]), toWorld(current.oY[o]), snap);
      const i3 = count * 3;
      this.centers[i3] = x;
      this.centers[i3 + 1] = y;
      this.centers[i3 + 2] = 1.1;
      this.scales[count] = 2.8 + clamp01(current.oVal[o] / 2400) * 1.6;
      this.pulses[count] = 0.5 + 0.5 * Math.sin(timeSeconds * 6 + o * 0.3);
      count++;
    }
    this.geometry.instanceCount = count;
    this.centerAttr.needsUpdate = true;
    this.scaleAttr.needsUpdate = true;
    this.pulseAttr.needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
