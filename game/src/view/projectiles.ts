import * as THREE from 'three';
import { SHOT_DEFS, type World } from '../sim/index.ts';
import { NEUTRAL_COLORS, TEAM_COLORS } from '../config.ts';
import type { FrameContext, StageView } from './frame.ts';
import type { WorldSnapshot } from './snapshot.ts';
import { colorIntoLinear, lerp, lerpBinaryAngle, toWorld } from './shared.ts';

const NEUTRAL_EDGE = colorIntoLinear(new THREE.Color(), NEUTRAL_COLORS.accent);
const FRIENDLY_EDGE_GAIN = 0.42;
const FRIENDLY_CORE_GAIN = 0.74;
const HOSTILE_EDGE_GAIN = 1.45;
const HOSTILE_CORE_GAIN = 1.78;
const NEUTRAL_EDGE_GAIN = 1.28;
const BOSS_SCALE = 1.18;
const DART_TAIL = 5.3;
const NEEDLE_TAIL = 6.6;

const VERTEX = /* glsl */ `
attribute vec3 iCenter;
attribute float iAngle;
attribute vec2 iScale;
attribute float iKind;
attribute vec3 iColor;
attribute vec3 iCore;
attribute float iFriendly;
attribute float iBoss;
attribute float iPulse;
varying vec2 vLocal;
varying vec3 vColor;
varying vec3 vCore;
varying float vKind;
varying float vFriendly;
varying float vBoss;
varying float vPulse;
void main() {
  float c = cos(iAngle);
  float s = sin(iAngle);
  vec2 local = position.xy * iScale;
  vec2 world = vec2(local.x * c - local.y * s, local.x * s + local.y * c) + iCenter.xy;
  vLocal = position.xy;
  vColor = iColor;
  vCore = iCore;
  vKind = iKind;
  vFriendly = iFriendly;
  vBoss = iBoss;
  vPulse = iPulse;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(world, iCenter.z, 1.0);
}`;

const FRAGMENT = /* glsl */ `
varying vec2 vLocal;
varying vec3 vColor;
varying vec3 vCore;
varying float vKind;
varying float vFriendly;
varying float vBoss;
varying float vPulse;

float capsule(vec2 p, vec2 h) {
  vec2 q = abs(p) - h;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
}

float diamond(vec2 p, float r) {
  return abs(p.x) + abs(p.y) - r;
}

float ring(vec2 p, float r, float w) {
  return abs(length(p) - r) - w;
}

void main() {
  vec2 p = vLocal;
  float d;
  if (vKind < 0.5) d = capsule(p, vec2(0.74, 0.22));
  else if (vKind < 1.5) d = capsule(p, vec2(0.92, 0.10));
  else if (vKind < 2.5) d = capsule(p, vec2(0.76, 0.20));
  else if (vKind < 3.5) d = min(ring(p, 0.64, 0.07), ring(p, 0.30, 0.04));
  else if (vKind < 4.5) d = diamond(p, 0.58);
  else if (vKind < 5.5) d = ring(p, 0.58, 0.04);
  else if (vKind < 6.5) d = min(length(p) - 0.38, ring(p, 0.78, 0.05));
  else if (vKind < 7.5) d = min(length(p) - 0.54, ring(p, 0.28, 0.06));
  else if (vKind < 8.5) d = capsule(p, vec2(0.98, 0.07));
  else {
    vec2 q = p + vec2(0.18, 0.0);
    d = max(length(q) - 0.84, -(length(q - vec2(0.30, 0.0)) - 0.58));
  }

  float edgeSoft = fwidth(d) * 1.25;
  float fill = 1.0 - smoothstep(-0.26, -0.03, d);
  float outline = 1.0 - smoothstep(0.02, 0.085 + edgeSoft, abs(d));
  float outer = vBoss * (1.0 - smoothstep(0.10, 0.18 + edgeSoft, abs(d)));
  float core = (1.0 - smoothstep(-0.14, 0.02, d)) * (1.0 - smoothstep(0.10, 0.34, length(p)));
  float pulse = 1.0 + vPulse * 0.18;

  vec3 color = vColor * fill * 0.14;
  color += vColor * outline * pulse;
  color += vColor * outer * 0.48 * pulse;
  color += vCore * core * pulse;

  float alpha = fill * mix(0.11, 0.06, vFriendly);
  alpha += outline * mix(0.92, 0.34, vFriendly);
  alpha += outer * 0.46;
  alpha += core * mix(0.52, 0.16, vFriendly);
  if (alpha <= 0.001) discard;
  gl_FragColor = vec4(color, alpha);
}`;

export class ProjectilesView implements StageView {
  readonly mesh: THREE.Mesh;

  get root(): THREE.Object3D {
    return this.mesh;
  }

  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly centers: Float32Array;
  private readonly angles: Float32Array;
  private readonly scales: Float32Array;
  private readonly kinds: Float32Array;
  private readonly colors: Float32Array;
  private readonly cores: Float32Array;
  private readonly friendly: Float32Array;
  private readonly boss: Float32Array;
  private readonly pulses: Float32Array;
  private readonly centerAttr: THREE.InstancedBufferAttribute;
  private readonly angleAttr: THREE.InstancedBufferAttribute;
  private readonly scaleAttr: THREE.InstancedBufferAttribute;
  private readonly kindAttr: THREE.InstancedBufferAttribute;
  private readonly colorAttr: THREE.InstancedBufferAttribute;
  private readonly coreAttr: THREE.InstancedBufferAttribute;
  private readonly friendlyAttr: THREE.InstancedBufferAttribute;
  private readonly bossAttr: THREE.InstancedBufferAttribute;
  private readonly pulseAttr: THREE.InstancedBufferAttribute;
  private readonly teamColors: THREE.Color[];

  constructor(world: World) {
    this.geometry = new THREE.InstancedBufferGeometry();
    this.geometry.index = new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1);
    this.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      -1, -1, 0,
      1, -1, 0,
      1, 1, 0,
      -1, 1, 0,
    ]), 3));
    const max = world.cap.projectiles;
    this.centers = new Float32Array(max * 3);
    this.angles = new Float32Array(max);
    this.scales = new Float32Array(max * 2);
    this.kinds = new Float32Array(max);
    this.colors = new Float32Array(max * 3);
    this.cores = new Float32Array(max * 3);
    this.friendly = new Float32Array(max);
    this.boss = new Float32Array(max);
    this.pulses = new Float32Array(max);
    this.centerAttr = new THREE.InstancedBufferAttribute(this.centers, 3).setUsage(THREE.DynamicDrawUsage);
    this.angleAttr = new THREE.InstancedBufferAttribute(this.angles, 1).setUsage(THREE.DynamicDrawUsage);
    this.scaleAttr = new THREE.InstancedBufferAttribute(this.scales, 2).setUsage(THREE.DynamicDrawUsage);
    this.kindAttr = new THREE.InstancedBufferAttribute(this.kinds, 1).setUsage(THREE.DynamicDrawUsage);
    this.colorAttr = new THREE.InstancedBufferAttribute(this.colors, 3).setUsage(THREE.DynamicDrawUsage);
    this.coreAttr = new THREE.InstancedBufferAttribute(this.cores, 3).setUsage(THREE.DynamicDrawUsage);
    this.friendlyAttr = new THREE.InstancedBufferAttribute(this.friendly, 1).setUsage(THREE.DynamicDrawUsage);
    this.bossAttr = new THREE.InstancedBufferAttribute(this.boss, 1).setUsage(THREE.DynamicDrawUsage);
    this.pulseAttr = new THREE.InstancedBufferAttribute(this.pulses, 1).setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('iCenter', this.centerAttr);
    this.geometry.setAttribute('iAngle', this.angleAttr);
    this.geometry.setAttribute('iScale', this.scaleAttr);
    this.geometry.setAttribute('iKind', this.kindAttr);
    this.geometry.setAttribute('iColor', this.colorAttr);
    this.geometry.setAttribute('iCore', this.coreAttr);
    this.geometry.setAttribute('iFriendly', this.friendlyAttr);
    this.geometry.setAttribute('iBoss', this.bossAttr);
    this.geometry.setAttribute('iPulse', this.pulseAttr);
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.teamColors = TEAM_COLORS.map((hex) => colorIntoLinear(new THREE.Color(), hex));
  }

  handleEvents(): void {}

  update(previous: WorldSnapshot, current: WorldSnapshot, frame: FrameContext): void {
    const { alpha, focusTeam, time: timeSeconds } = frame;
    let count = 0;
    for (let p = 0; p < current.projectiles; p++) {
      if (current.pAlive[p] !== 1) continue;
      const def = SHOT_DEFS[current.pDef[p]];
      const snap = current.pAge[p] <= 1 || previous.pAlive[p] !== 1 ? 1 : alpha;
      const x = lerp(toWorld(previous.pX[p]), toWorld(current.pX[p]), snap);
      const y = lerp(toWorld(previous.pY[p]), toWorld(current.pY[p]), snap);
      const angle = (lerpBinaryAngle(previous.pAng[p], current.pAng[p], snap) / 65536) * Math.PI * 2;
      const hostile = current.pTeam[p] !== focusTeam || current.pOwner[p] < 0;
      const friendly = hostile ? 0 : 1;
      const boss = current.pAttack[p] !== 0 ? 1 : 0;
      const baseColor = current.pOwner[p] < 0 ? NEUTRAL_EDGE : this.teamColors[current.pTeam[p] % this.teamColors.length];
      const pulse = boss === 1 ? 0.5 + 0.5 * Math.sin(timeSeconds * 3.2 + p * 0.11) : 0;
      const radius = toWorld(def.rad) * (boss === 1 ? BOSS_SCALE : 1);
      const length = this.lengthFor(def.kind, radius, boss === 1);
      const i3 = count * 3;
      const i2 = count * 2;
      this.centers[i3] = x;
      this.centers[i3 + 1] = y;
      this.centers[i3 + 2] = 1.4;
      this.angles[count] = angle;
      this.scales[i2] = length;
      this.scales[i2 + 1] = radius * (friendly === 1 ? 0.88 : 1.05);
      this.kinds[count] = def.kind;
      const edgeGain = current.pOwner[p] < 0 ? NEUTRAL_EDGE_GAIN : hostile ? HOSTILE_EDGE_GAIN : FRIENDLY_EDGE_GAIN;
      const coreGain = hostile ? HOSTILE_CORE_GAIN : FRIENDLY_CORE_GAIN;
      this.colors[i3] = baseColor.r * edgeGain;
      this.colors[i3 + 1] = baseColor.g * edgeGain;
      this.colors[i3 + 2] = baseColor.b * edgeGain;
      this.cores[i3] = coreGain;
      this.cores[i3 + 1] = coreGain;
      this.cores[i3 + 2] = coreGain;
      this.friendly[count] = friendly;
      this.boss[count] = boss;
      this.pulses[count] = pulse;
      count++;
    }
    this.geometry.instanceCount = count;
    this.centerAttr.needsUpdate = true;
    this.angleAttr.needsUpdate = true;
    this.scaleAttr.needsUpdate = true;
    this.kindAttr.needsUpdate = true;
    this.colorAttr.needsUpdate = true;
    this.coreAttr.needsUpdate = true;
    this.friendlyAttr.needsUpdate = true;
    this.bossAttr.needsUpdate = true;
    this.pulseAttr.needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }

  private lengthFor(kind: number, radius: number, boss: boolean): number {
    if (kind === 1) return radius * (boss ? DART_TAIL + 1 : DART_TAIL);
    if (kind === 8) return radius * NEEDLE_TAIL;
    if (kind === 5) return radius * 1.2;
    return radius * 2.0;
  }
}
