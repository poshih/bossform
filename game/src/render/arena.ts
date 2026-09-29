import * as THREE from 'three';
import type { World } from '../sim/index.ts';
import { W } from '../sim/index.ts';
import type { FrameContext, StageView } from '../view/frame.ts';
import type { WorldSnapshot } from '../view/snapshot.ts';
import { toWorld } from '../view/shared.ts';

const FLOOR_EXTENT = 12000;

const VERTEX = /* glsl */ `
varying vec2 vWorld;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xy;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const FRAGMENT = /* glsl */ `
uniform float uArenaR;
uniform float uSafeR;
uniform float uTime;
uniform float uUltimaDim;
varying vec2 vWorld;

float ring(float radius, float width, float value) {
  return 1.0 - smoothstep(width, width + fwidth(value) * 2.0, abs(value - radius));
}

float gridLine(float value, float stepSize, float width) {
  float coord = value / stepSize;
  float line = abs(fract(coord - 0.5) - 0.5) / max(fwidth(coord), 1e-4);
  return 1.0 - smoothstep(width, width + 1.0, line);
}

mat2 rot(float a) {
  float c = cos(a);
  float s = sin(a);
  return mat2(c, -s, s, c);
}

void main() {
  float r = length(vWorld);
  if (r > uArenaR + 22.0) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  float radial = clamp(r / uArenaR, 0.0, 1.0);
  vec3 col = mix(vec3(0.001, 0.003, 0.008), vec3(0.007, 0.015, 0.032), pow(1.0 - radial, 1.4));

  float minor = max(gridLine(vWorld.x, 25.0, 0.16), gridLine(vWorld.y, 25.0, 0.16));
  float major = max(gridLine(vWorld.x, 100.0, 0.22), gridLine(vWorld.y, 100.0, 0.22));
  col += vec3(0.010, 0.020, 0.030) * minor * 0.12;
  col += vec3(0.020, 0.045, 0.065) * major * 0.15;

  float calm = 1.0 - smoothstep(0.0, uArenaR * 0.85, r);
  col += vec3(0.0, 0.007, 0.014) * calm * 0.18;

  float spawnRing = ring(uArenaR * 0.7, 2.0, r);
  col += vec3(0.05, 0.09, 0.12) * spawnRing * 0.10;

  float rim = ring(uArenaR, 1.8, r);
  float rimGlow = 1.0 - smoothstep(0.0, 24.0, abs(r - uArenaR));
  col += vec3(0.10, 0.46, 0.78) * rim * 1.45;
  col += vec3(0.04, 0.18, 0.36) * rimGlow * 0.22;

  if (uSafeR < uArenaR - 0.5) {
    float stormPulse = 0.5 + 0.5 * sin(uTime * 2.4);
    float safeRing = ring(uSafeR, 1.3, r);
    col += vec3(1.0, 0.28, 0.08) * safeRing * 0.62;
    vec2 hatchUv = rot(0.55) * vWorld;
    float hatch = smoothstep(0.60, 0.95, sin(hatchUv.x * 0.24 + uTime * 4.0) * 0.5 + 0.5);
    float storm = smoothstep(uSafeR - 16.0, uSafeR + 90.0, r);
    col = mix(col, col + vec3(0.14, 0.016, 0.008) * (0.12 + 0.10 * hatch) * (0.65 + 0.35 * stormPulse), storm);
    col += vec3(0.16, 0.025, 0.01) * (1.0 - smoothstep(0.0, 60.0, abs(r - uSafeR))) * 0.10;
  }

  float rimFade = smoothstep(uArenaR - 18.0, uArenaR + 10.0, r);
  col *= 1.0 - rimFade;
  float centreVignette = smoothstep(0.12, 1.0, radial);
  col *= 1.0 - centreVignette * 0.18;
  col *= 1.0 - uUltimaDim * 0.14;
  gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
}`;

export class ArenaFloor implements StageView {
  readonly mesh: THREE.Mesh;

  get root(): THREE.Object3D {
    return this.mesh;
  }
  private readonly material: THREE.ShaderMaterial;

  constructor(world: World) {
    const geometry = new THREE.PlaneGeometry(FLOOR_EXTENT, FLOOR_EXTENT, 1, 1);
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: {
        uArenaR: { value: toWorld(world.arenaR) },
        uSafeR: { value: toWorld(world.m.world[W.SafeR]) },
        uTime: { value: 0 },
        uUltimaDim: { value: 0 },
      },
      transparent: false,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.position.z = -2;
    this.mesh.frustumCulled = false;
    this.setSafeRadius(world.m.world[W.SafeR]);
  }

  handleEvents(): void {}

  update(_previous: WorldSnapshot, current: WorldSnapshot, frame: FrameContext): void {
    this.setSafeRadius(current.safeR);
    this.advance(frame.time);
  }

  private advance(timeSeconds: number): void {
    this.material.uniforms.uTime.value = timeSeconds;
  }

  private setSafeRadius(rawRadius: number): void {
    this.material.uniforms.uSafeR.value = toWorld(rawRadius);
  }

  setUltimaDim(amount: number): void {
    this.material.uniforms.uUltimaDim.value = amount;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
