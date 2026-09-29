import * as THREE from 'three';
import { Attack, Ev, type World, W } from '../sim/index.ts';
import type { FrameContext, StageView } from '../view/frame.ts';
import type { WorldSnapshot } from '../view/snapshot.ts';
import { clamp01, toWorld } from '../view/shared.ts';
import { DemoBackdrop } from './backdrop.ts';
import { DrawLayer } from './layers.ts';

const FLOOR_EXTENT = 12000;
const MAX_RIPPLES = 12;
const RIPPLE_DURATION_SECONDS = 2.4;
const RIPPLE_SPEED = 315;
const RIPPLE_GRID_BEND = 5.8;
const RIPPLE_BRIGHTNESS = 0.18;
const BAR_WAVE_SPEED = 470;
const STORM_PARTICLES = 360;
const STORM_PARTICLE_SPREAD = 118;
const STORM_PARTICLE_MIN_SIZE = 1.8;
const STORM_PARTICLE_SIZE_RANGE = 3.4;
const EVENT_BACKDROP_SCALE = 0.36;
const TWO_PI = Math.PI * 2;

const VERTEX = /* glsl */ `
varying vec2 vWorld;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xy;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const FRAGMENT = /* glsl */ `
#define MAX_RIPPLES ${MAX_RIPPLES}
uniform float uArenaR;
uniform float uSafeR;
uniform float uTime;
uniform float uUltimaDim;
uniform float uBeatPulse;
uniform float uBarPulse;
uniform float uBeatPhase;
uniform vec4 uRipples[MAX_RIPPLES];
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

float scan(float value, float speed, float scale) {
  return smoothstep(0.68, 1.0, sin(value * scale + uTime * speed) * 0.5 + 0.5);
}

void main() {
  float r = length(vWorld);
  if (r > uArenaR + 38.0) discard;

  float radial = clamp(r / uArenaR, 0.0, 1.0);
  float breathe = 1.0 + uBeatPulse * 0.045;
  vec2 warped = vWorld;
  float rippleLight = 0.0;
  float rippleShadow = 0.0;
  for (int i = 0; i < MAX_RIPPLES; i++) {
    vec4 ripple = uRipples[i];
    float age = uTime - ripple.z;
    if (age <= 0.0 || age >= ${RIPPLE_DURATION_SECONDS.toFixed(1)} || ripple.w <= 0.0) continue;
    vec2 delta = vWorld - ripple.xy;
    float dist = length(delta);
    float radius = age * ${RIPPLE_SPEED.toFixed(1)};
    float width = 8.0 + age * 12.0;
    float x = abs(dist - radius) / width;
    float wave = max(0.0, 1.0 - x);
    wave = wave * wave * (1.0 - age / ${RIPPLE_DURATION_SECONDS.toFixed(1)}) * ripple.w;
    vec2 dir = delta / max(dist, 1.0);
    warped += dir * wave * ${RIPPLE_GRID_BEND.toFixed(1)};
    rippleLight += wave;
    rippleShadow += smoothstep(radius - width * 2.0, radius, dist) * (1.0 - smoothstep(radius, radius + width * 2.0, dist)) * wave;
  }

  float drift = sin((warped.x + warped.y) * 0.011 + uTime * 0.62) * 0.5 + 0.5;
  float radialFlow = sin(r * 0.026 - uTime * 0.9) * 0.5 + 0.5;
  vec3 col = mix(vec3(0.0008, 0.0025, 0.007), vec3(0.006, 0.014, 0.029), pow(1.0 - radial, 1.35));
  col *= 0.93 + 0.07 * drift;

  float minor = max(gridLine(warped.x, 25.0, 0.16), gridLine(warped.y, 25.0, 0.16));
  float major = max(gridLine(warped.x, 100.0, 0.22), gridLine(warped.y, 100.0, 0.22));
  vec2 diagUv = rot(0.785398) * warped;
  float diag = max(gridLine(diagUv.x, 175.0, 0.12), gridLine(diagUv.y, 175.0, 0.12));
  col += vec3(0.010, 0.024, 0.035) * minor * (0.12 + uBeatPulse * 0.035);
  col += vec3(0.026, 0.058, 0.086) * major * (0.18 + uBeatPulse * 0.055);
  col += vec3(0.022, 0.055, 0.080) * diag * 0.045;

  float barRadius = mod(uTime * ${BAR_WAVE_SPEED.toFixed(1)}, uArenaR + 260.0) - 130.0;
  float downbeatWave = exp(-abs(r - barRadius) / 42.0) * uBarPulse;
  col += vec3(0.04, 0.18, 0.30) * downbeatWave * 0.17;

  float calm = 1.0 - smoothstep(0.0, uArenaR * 0.85, r);
  col += vec3(0.0, 0.007, 0.014) * calm * (0.18 + radialFlow * 0.045);
  col += vec3(0.11, 0.38, 0.62) * rippleLight * ${RIPPLE_BRIGHTNESS.toFixed(2)};
  col -= vec3(0.0, 0.018, 0.025) * rippleShadow * 0.12;

  float spawnRing = ring(uArenaR * 0.7, 2.0, r);
  col += vec3(0.05, 0.09, 0.12) * spawnRing * (0.10 + uBeatPulse * 0.03);

  float rimPhase = atan(vWorld.y, vWorld.x) * 16.0 - uTime * 3.8;
  float rimFlow = 0.68 + 0.32 * sin(rimPhase);
  float rim = ring(uArenaR, 1.8, r);
  float rimGlow = 1.0 - smoothstep(0.0, 30.0, abs(r - uArenaR));
  col += vec3(0.10, 0.46, 0.78) * rim * (1.25 + rimFlow * 0.45 + uBeatPulse * 0.12);
  col += vec3(0.04, 0.18, 0.36) * rimGlow * (0.20 + rimFlow * 0.06);

  if (uSafeR < uArenaR - 0.5) {
    float stormPulse = 0.5 + 0.5 * sin(uTime * 2.4);
    float safeRing = ring(uSafeR, 1.3, r);
    col += vec3(1.0, 0.28, 0.08) * safeRing * (0.58 + uBeatPulse * 0.08);
    vec2 hatchUv = rot(0.55) * vWorld;
    float hatch = scan(hatchUv.x, 4.0, 0.24);
    float band = scan(r, -5.2, 0.055);
    float outside = smoothstep(uSafeR - 10.0, uSafeR + 96.0, r);
    vec3 stormTint = vec3(0.14, 0.016, 0.008) * (0.14 + 0.11 * hatch + 0.06 * band) * (0.72 + 0.28 * stormPulse);
    col = mix(col, col + stormTint, outside);
    col += vec3(0.36, 0.055, 0.018) * (1.0 - smoothstep(0.0, 72.0, abs(r - uSafeR))) * 0.11;
    col *= 1.0 - outside * 0.16;
  }

  float rimFade = smoothstep(uArenaR - 12.0, uArenaR + 34.0, r);
  col *= 1.0 - rimFade;
  float centreVignette = smoothstep(0.12, 1.0, radial);
  col *= 1.0 - centreVignette * 0.17;
  col *= 1.0 - uUltimaDim * 0.24;
  gl_FragColor = vec4(max(col, vec3(0.0)), 0.97);
}`;

const STORM_VERTEX = /* glsl */ `
attribute float aPhase;
attribute float aOffset;
uniform float uSafeR;
uniform float uArenaR;
uniform float uTime;
uniform float uActive;
uniform float uPulse;
varying float vAlpha;
void main() {
  float radius = uSafeR + aOffset + sin(uTime * 2.7 + aPhase) * 7.0;
  vec3 pos = vec3(position.xy * radius, -6.0 + sin(uTime * 3.1 + aPhase) * 10.0);
  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = (${STORM_PARTICLE_MIN_SIZE.toFixed(1)} + ${STORM_PARTICLE_SIZE_RANGE.toFixed(1)} * fract(aPhase * 0.137)) * (1.0 + uPulse * 0.28) * (360.0 / max(80.0, -mv.z));
  vAlpha = uActive * smoothstep(0.0, uArenaR - 80.0, uSafeR) * (0.35 + 0.65 * sin(aPhase + uTime * 5.0) * 0.5 + 0.325);
}`;

const STORM_FRAGMENT = /* glsl */ `
varying float vAlpha;
void main() {
  vec2 d = gl_PointCoord - vec2(0.5);
  float core = 1.0 - smoothstep(0.16, 0.5, length(d));
  gl_FragColor = vec4(vec3(1.0, 0.22, 0.06) * core, core * vAlpha * 0.38);
}`;

function createStormGeometry(): THREE.BufferGeometry {
  const positions = new Float32Array(STORM_PARTICLES * 3);
  const phases = new Float32Array(STORM_PARTICLES);
  const offsets = new Float32Array(STORM_PARTICLES);
  for (let i = 0; i < STORM_PARTICLES; i++) {
    const angle = (i / STORM_PARTICLES) * TWO_PI;
    const j = i * 3;
    positions[j] = Math.cos(angle);
    positions[j + 1] = Math.sin(angle);
    positions[j + 2] = 0;
    phases[i] = i * 2.399963 + (i % 7) * 0.37;
    offsets[i] = ((i * 37) % STORM_PARTICLE_SPREAD) - STORM_PARTICLE_SPREAD * 0.5;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
  geometry.setAttribute('aOffset', new THREE.BufferAttribute(offsets, 1));
  return geometry;
}

function eventStrength(type: number, b: number, c: number): number {
  if (type === Ev.Death) return c === 1 ? 1.0 : 0.56;
  if (type === Ev.PartDown) return 0.68;
  if (type === Ev.Burst) return 0.52;
  if (type === Ev.Release && b === Attack.Ultima) return 1.0;
  if (type === Ev.Release && b === Attack.Siege) return 0.78;
  if (type === Ev.MorphDone) return 0.64;
  if (type === Ev.Respawn) return 0.42;
  if (type === Ev.StormStart) return 0.72;
  return 0;
}

export class ArenaFloor implements StageView {
  readonly group = new THREE.Group();
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;
  private readonly storm: THREE.Points;
  private readonly stormMaterial: THREE.ShaderMaterial;
  private readonly backdrop = new DemoBackdrop();
  private readonly ripples: THREE.Vector4[] = [];
  private arenaRadius: number;
  private nextRipple = 0;
  private latestTime = 0;

  get root(): THREE.Object3D {
    return this.group;
  }

  constructor(world: World) {
    this.arenaRadius = toWorld(world.arenaR);
    for (let i = 0; i < MAX_RIPPLES; i++) this.ripples.push(new THREE.Vector4(0, 0, -1000, 0));
    this.group.add(this.backdrop.root);

    const geometry = new THREE.PlaneGeometry(FLOOR_EXTENT, FLOOR_EXTENT, 1, 1);
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: {
        uArenaR: { value: this.arenaRadius },
        uSafeR: { value: toWorld(world.m.world[W.SafeR]) },
        uTime: { value: 0 },
        uUltimaDim: { value: 0 },
        uBeatPulse: { value: 0 },
        uBarPulse: { value: 0 },
        uBeatPhase: { value: 0 },
        uRipples: { value: this.ripples },
      },
      transparent: true,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.position.z = -2;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = DrawLayer.Floor;
    this.group.add(this.mesh);

    this.stormMaterial = new THREE.ShaderMaterial({
      vertexShader: STORM_VERTEX,
      fragmentShader: STORM_FRAGMENT,
      uniforms: {
        uSafeR: { value: toWorld(world.m.world[W.SafeR]) },
        uArenaR: { value: this.arenaRadius },
        uTime: { value: 0 },
        uActive: { value: 0 },
        uPulse: { value: 0 },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.storm = new THREE.Points(createStormGeometry(), this.stormMaterial);
    this.storm.frustumCulled = false;
    this.storm.renderOrder = DrawLayer.Storm;
    this.group.add(this.storm);
    this.setSafeRadius(world.m.world[W.SafeR]);
  }

  handleEvents(world: World): void {
    const events = world.events;
    for (let i = 0; i < events.count; i++) {
      const strength = eventStrength(events.type[i], events.b[i], events.c[i]);
      if (strength <= 0) continue;
      this.addRipple(toWorld(events.x[i]), toWorld(events.y[i]), strength);
      this.backdrop.strike(strength * EVENT_BACKDROP_SCALE);
    }
  }

  update(_previous: WorldSnapshot, current: WorldSnapshot, frame: FrameContext): void {
    this.latestTime = frame.time;
    this.setSafeRadius(current.safeR);
    this.advance(frame.time, frame.dt, frame.beat.pulse, frame.beat.barPulse, frame.beat.phase);
    this.backdrop.update(frame.time, frame.dt, frame.beat);
  }

  private addRipple(x: number, y: number, strength: number): void {
    const ripple = this.ripples[this.nextRipple];
    ripple.set(x, y, this.latestTime, clamp01(strength));
    this.nextRipple = (this.nextRipple + 1) % MAX_RIPPLES;
  }

  private advance(timeSeconds: number, dtSeconds: number, beatPulse: number, barPulse: number, beatPhase: number): void {
    this.material.uniforms.uTime.value = timeSeconds;
    this.material.uniforms.uBeatPulse.value = beatPulse;
    this.material.uniforms.uBarPulse.value = barPulse;
    this.material.uniforms.uBeatPhase.value = beatPhase;
    this.stormMaterial.uniforms.uTime.value = timeSeconds;
    this.stormMaterial.uniforms.uPulse.value = beatPulse;
    this.storm.rotation.z += dtSeconds * 0.24;
  }

  private setSafeRadius(rawRadius: number): void {
    const safeRadius = toWorld(rawRadius);
    this.material.uniforms.uSafeR.value = safeRadius;
    this.stormMaterial.uniforms.uSafeR.value = safeRadius;
    this.stormMaterial.uniforms.uActive.value = safeRadius < this.arenaRadius - 0.5 ? 1 : 0;
  }

  setUltimaDim(amount: number): void {
    const dim = clamp01(amount);
    this.material.uniforms.uUltimaDim.value = dim;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.storm.geometry.dispose();
    this.stormMaterial.dispose();
    this.backdrop.dispose();
  }
}
