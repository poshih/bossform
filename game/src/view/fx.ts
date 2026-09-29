import * as THREE from 'three';
import {
  Attack,
  AttackPhase,
  Ev,
  FORMS,
  MAX_PARTS,
  PartKind,
  Role,
  podMuzzle,
  type World,
} from '../sim/index.ts';
import { NEUTRAL_COLORS, TEAM_COLORS } from '../config.ts';
import type { WorldSnapshot } from './snapshot.ts';
import { clamp01, colorIntoLinear, toWorld } from './shared.ts';

const FX_CAPACITY = 1536;
const KIND_RING = 0;
const KIND_STREAK = 1;
const KIND_ARC = 2;
const KIND_DISC = 3;
const KIND_DASH = 4;
const KIND_MARKER = 5;

const VERTEX = /* glsl */ `
attribute vec3 iCenter;
attribute vec2 iScale;
attribute float iAngle;
attribute float iKind;
attribute vec4 iColor;
attribute float iPhase;
varying vec2 vLocal;
varying float vKind;
varying vec4 vColor;
varying float vPhase;
void main() {
  float c = cos(iAngle);
  float s = sin(iAngle);
  vec2 local = position.xy * iScale;
  vec2 world = vec2(local.x * c - local.y * s, local.x * s + local.y * c) + iCenter.xy;
  vLocal = position.xy;
  vKind = iKind;
  vColor = iColor;
  vPhase = iPhase;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(world, iCenter.z, 1.0);
}`;

const FRAGMENT = /* glsl */ `
varying vec2 vLocal;
varying float vKind;
varying vec4 vColor;
varying float vPhase;

float capsule(vec2 p, vec2 h) {
  vec2 q = abs(p) - h;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
}

void main() {
  float d;
  if (vKind < 0.5) d = abs(length(vLocal) - 0.8) - 0.05;
  else if (vKind < 1.5) d = capsule(vLocal, vec2(0.95, 0.12));
  else if (vKind < 2.5) {
    float angle = atan(vLocal.y, vLocal.x);
    float gate = smoothstep(1.7, 1.0, abs(angle - vPhase));
    d = max(abs(length(vLocal) - 0.78) - 0.08, gate - 0.45);
  } else if (vKind < 3.5) d = length(vLocal) - 0.95;
  else if (vKind < 4.5) d = capsule(vLocal, vec2(0.95, 0.20));
  else {
    float dash = step(0.45, fract((vLocal.x * 0.5 + 0.5) * 8.0 + vPhase));
    d = capsule(vLocal, vec2(0.95, 0.10));
    d = max(d, 0.5 - dash);
  }
  float edge = fwidth(d) * 1.4;
  float alpha = (1.0 - smoothstep(0.0, edge, d)) * vColor.a;
  if (alpha <= 0.001) discard;
  gl_FragColor = vec4(vColor.rgb, alpha);
}`;

interface FxPool {
  readonly alive: Uint8Array;
  readonly kind: Uint8Array;
  readonly time: Float32Array;
  readonly life: Float32Array;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly z: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  readonly angle: Float32Array;
  readonly spin: Float32Array;
  readonly sx: Float32Array;
  readonly sy: Float32Array;
  readonly phase: Float32Array;
  readonly color: Float32Array;
}

function makePool(): FxPool {
  return {
    alive: new Uint8Array(FX_CAPACITY),
    kind: new Uint8Array(FX_CAPACITY),
    time: new Float32Array(FX_CAPACITY),
    life: new Float32Array(FX_CAPACITY),
    x: new Float32Array(FX_CAPACITY),
    y: new Float32Array(FX_CAPACITY),
    z: new Float32Array(FX_CAPACITY),
    vx: new Float32Array(FX_CAPACITY),
    vy: new Float32Array(FX_CAPACITY),
    angle: new Float32Array(FX_CAPACITY),
    spin: new Float32Array(FX_CAPACITY),
    sx: new Float32Array(FX_CAPACITY),
    sy: new Float32Array(FX_CAPACITY),
    phase: new Float32Array(FX_CAPACITY),
    color: new Float32Array(FX_CAPACITY * 4),
  };
}

export class FxView {
  readonly mesh: THREE.Mesh;
  readonly root = new THREE.Group();

  screenFlash = 0;
  ultimaDim = 0;

  private readonly pool = makePool();
  private next = 0;
  private readonly teamColors = TEAM_COLORS.map((hex: number) => colorIntoLinear(new THREE.Color(), hex));
  private readonly neutralColor = colorIntoLinear(new THREE.Color(), NEUTRAL_COLORS.accent);
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly centers: Float32Array;
  private readonly scales: Float32Array;
  private readonly angles: Float32Array;
  private readonly kinds: Float32Array;
  private readonly colors: Float32Array;
  private readonly phases: Float32Array;
  private readonly centerAttr: THREE.InstancedBufferAttribute;
  private readonly scaleAttr: THREE.InstancedBufferAttribute;
  private readonly angleAttr: THREE.InstancedBufferAttribute;
  private readonly kindAttr: THREE.InstancedBufferAttribute;
  private readonly colorAttr: THREE.InstancedBufferAttribute;
  private readonly phaseAttr: THREE.InstancedBufferAttribute;
  private readonly tellPosition = { x: 0, y: 0 };
  private readonly tellBurst = { x: 0, y: 0 };

  constructor() {
    this.geometry = new THREE.InstancedBufferGeometry();
    this.geometry.index = new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1);
    this.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      -1, -1, 0,
      1, -1, 0,
      1, 1, 0,
      -1, 1, 0,
    ]), 3));
    this.centers = new Float32Array(FX_CAPACITY * 3);
    this.scales = new Float32Array(FX_CAPACITY * 2);
    this.angles = new Float32Array(FX_CAPACITY);
    this.kinds = new Float32Array(FX_CAPACITY);
    this.colors = new Float32Array(FX_CAPACITY * 4);
    this.phases = new Float32Array(FX_CAPACITY);
    this.centerAttr = new THREE.InstancedBufferAttribute(this.centers, 3).setUsage(THREE.DynamicDrawUsage);
    this.scaleAttr = new THREE.InstancedBufferAttribute(this.scales, 2).setUsage(THREE.DynamicDrawUsage);
    this.angleAttr = new THREE.InstancedBufferAttribute(this.angles, 1).setUsage(THREE.DynamicDrawUsage);
    this.kindAttr = new THREE.InstancedBufferAttribute(this.kinds, 1).setUsage(THREE.DynamicDrawUsage);
    this.colorAttr = new THREE.InstancedBufferAttribute(this.colors, 4).setUsage(THREE.DynamicDrawUsage);
    this.phaseAttr = new THREE.InstancedBufferAttribute(this.phases, 1).setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('iCenter', this.centerAttr);
    this.geometry.setAttribute('iScale', this.scaleAttr);
    this.geometry.setAttribute('iAngle', this.angleAttr);
    this.geometry.setAttribute('iKind', this.kindAttr);
    this.geometry.setAttribute('iColor', this.colorAttr);
    this.geometry.setAttribute('iPhase', this.phaseAttr);
    this.material = new THREE.ShaderMaterial({ vertexShader: VERTEX, fragmentShader: FRAGMENT, transparent: true, depthWrite: false, blending: THREE.NormalBlending });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.root.add(this.mesh);
  }

  handleEvents(world: World, focusSeat: number): void {
    const focusTeam = focusSeat >= 0 && focusSeat < world.seats ? world.m.plTeam[focusSeat] : -999;
    for (let i = 0; i < world.events.count; i++) {
      const type = world.events.type[i];
      const x = toWorld(world.events.x[i]);
      const y = toWorld(world.events.y[i]);
      const a = world.events.a[i];
      const b = world.events.b[i];
      const attackerTeam = b >= 0 && b < world.seats ? world.m.plTeam[b] : -1;
      switch (type) {
        case Ev.Hit:
          this.ring(x, y, 12, 0.28, this.hostileColor(attackerTeam, focusTeam), 0.9);
          this.burst(x, y, 5, 10, 0.22, this.hostileColor(attackerTeam, focusTeam), 1.2);
          break;
        case Ev.Blocked:
          this.arc(x, y, 18, 0.24, this.teamColor(world.m.plTeam[a]), 0.85);
          break;
        case Ev.Graze:
          this.arc(x, y, 9, 0.18, new THREE.Color(1.2, 1.2, 1.3), 0.75);
          break;
        case Ev.PartHit:
          this.burst(x, y, 7, 12, 0.28, this.teamColor(world.m.plTeam[a]), 1.2);
          break;
        case Ev.PartDown:
          this.ring(x, y, 28, 0.55, this.teamColor(world.m.plTeam[a]), 0.82);
          this.burst(x, y, 12, 20, 0.58, this.teamColor(world.m.plTeam[a]), 1.0);
          break;
        case Ev.Death:
          this.ring(x, y, 42, 0.85, new THREE.Color(1.15, 1.15, 1.2), 0.85);
          this.burst(x, y, 18, 34, 0.82, new THREE.Color(1.15, 1.15, 1.2), 1.35);
          this.disc(x, y, 36, 0.18, new THREE.Color(1.5, 1.5, 1.6), 0.35);
          this.screenFlash = Math.min(1, this.screenFlash + 0.28);
          break;
        case Ev.MorphStart:
        case Ev.MorphDone:
          this.ring(x, y, type === Ev.MorphStart ? 30 : 38, 0.6, this.teamColor(world.m.plTeam[a]), 0.72);
          this.disc(x, y, type === Ev.MorphStart ? 20 : 26, 0.18, this.teamColor(world.m.plTeam[a]), 0.24);
          break;
        case Ev.BossEnd:
          this.ring(x, y, 56, 1.0, new THREE.Color(1.0, 0.8, 0.5), 0.58);
          break;
        case Ev.Respawn:
          this.ring(x, y, 32, 0.55, new THREE.Color(0.4, 1.2, 1.5), 0.85);
          this.streak(x, y, Math.PI / 2, 6, 38, 0.34, new THREE.Color(0.6, 1.3, 1.8), 0.7);
          break;
        case Ev.OrbPickup:
          this.disc(x, y, world.events.b[i] === 1 ? 18 : 12, 0.2, new THREE.Color(0.6, 1.4, 1.8), 0.26);
          break;
        case Ev.Absorb:
          this.ring(x, y, 22, 0.32, new THREE.Color(0.8, 1.3, 1.6), 0.7);
          break;
        case Ev.Burst:
          this.ring(x, y, 24, 0.32, new THREE.Color(1.1, 0.95, 0.8), 0.75);
          break;
        case Ev.Dash:
          this.streak(x, y, (world.events.b[i] / 65536) * Math.PI * 2, 10, 44, 0.32, this.teamColor(world.m.plTeam[a]), 0.55);
          break;
        case Ev.BulwarkUp:
          this.arc(x, y, 28, 0.45, this.teamColor(world.m.plTeam[a]), 0.95);
          break;
        case Ev.Release:
          if (b === Attack.Siege || b === Attack.Ultima) this.screenFlash = Math.min(1, this.screenFlash + (b === Attack.Ultima ? 0.22 : 0.1));
          break;
        default:
      }
    }
  }

  update(world: World, current: WorldSnapshot, dtSeconds: number, timeSeconds: number): void {
    this.screenFlash *= Math.exp(-6 * dtSeconds);
    this.ultimaDim = 0;
    let count = 0;
    for (let i = 0; i < FX_CAPACITY; i++) {
      if (this.pool.alive[i] !== 1) continue;
      this.pool.time[i] += dtSeconds;
      if (this.pool.time[i] >= this.pool.life[i]) {
        this.pool.alive[i] = 0;
        continue;
      }
      this.pool.x[i] += this.pool.vx[i] * dtSeconds;
      this.pool.y[i] += this.pool.vy[i] * dtSeconds;
      this.pool.angle[i] += this.pool.spin[i] * dtSeconds;
      const life = this.pool.time[i] / this.pool.life[i];
      const fade = 1 - life;
      const i3 = count * 3;
      const i2 = count * 2;
      const i4 = count * 4;
      this.centers[i3] = this.pool.x[i];
      this.centers[i3 + 1] = this.pool.y[i];
      this.centers[i3 + 2] = this.pool.z[i];
      this.scales[i2] = this.pool.sx[i] * (1 + life * 0.55);
      this.scales[i2 + 1] = this.pool.sy[i] * (1 + life * 0.28);
      this.angles[count] = this.pool.angle[i];
      this.kinds[count] = this.pool.kind[i];
      this.colors[i4] = this.pool.color[i4];
      this.colors[i4 + 1] = this.pool.color[i4 + 1];
      this.colors[i4 + 2] = this.pool.color[i4 + 2];
      this.colors[i4 + 3] = this.pool.color[i4 + 3] * fade;
      this.phases[count] = this.pool.phase[i] + timeSeconds * 0.3;
      count++;
    }

    for (let seat = 0; seat < world.seats; seat++) {
      if (current.plAlive[seat] !== 1 || current.plForm[seat] !== 2) continue;
      const frame = current.plFrame[seat];
      const form = FORMS[frame];
      const attack = current.plAtk[seat];
      const phase = current.plAtkPhase[seat];
      if (attack === Attack.None || phase !== AttackPhase.Windup) continue;
      const progress = attack === Attack.Salvo ? clamp01(1 - current.plAtkTimer[seat] / form.salvo.windup)
        : attack === Attack.Siege ? clamp01(1 - current.plAtkTimer[seat] / form.siege.windup)
          : clamp01(1 - current.plAtkTimer[seat] / form.ultima.windup);
      if (attack === Attack.Siege) {
        for (let k = 0; k < form.parts.length; k++) {
          const part = form.parts[k];
          if (part.kind !== PartKind.Pod || (part.roles & Role.Siege) === 0 || current.ptHp[seat * MAX_PARTS + k] <= 0) continue;
          podMuzzle(world, seat, k, this.tellPosition);
          const angle = current.ptAng[seat * MAX_PARTS + k];
          const shot = form.siege.shot;
          const reach = shot.spd * shot.life;
          this.tellBurst.x = toWorld(this.tellPosition.x + Math.cos((angle / 65536) * Math.PI * 2) * reach);
          this.tellBurst.y = toWorld(this.tellPosition.y + Math.sin((angle / 65536) * Math.PI * 2) * reach);
          count = this.appendMarker(count, toWorld(this.tellPosition.x), toWorld(this.tellPosition.y), this.tellBurst.x, this.tellBurst.y, progress);
        }
      } else if (attack === Attack.Ultima) {
        const i3 = count * 3;
        const i2 = count * 2;
        const i4 = count * 4;
        this.centers[i3] = toWorld(current.plX[seat]);
        this.centers[i3 + 1] = toWorld(current.plY[seat]);
        this.centers[i3 + 2] = 2.4;
        const radius = 32 + (1 - progress) * 140;
        this.scales[i2] = radius;
        this.scales[i2 + 1] = radius;
        this.angles[count] = 0;
        this.kinds[count] = KIND_RING;
        const c = this.teamColor(current.plTeam[seat]);
        this.colors[i4] = c.r * 1.25;
        this.colors[i4 + 1] = c.g * 1.25;
        this.colors[i4 + 2] = c.b * 1.25;
        this.colors[i4 + 3] = 0.34 - progress * 0.10;
        this.phases[count] = 0;
        count++;
        this.ultimaDim = Math.max(this.ultimaDim, progress);
      }
    }

    this.geometry.instanceCount = count;
    this.centerAttr.needsUpdate = true;
    this.scaleAttr.needsUpdate = true;
    this.angleAttr.needsUpdate = true;
    this.kindAttr.needsUpdate = true;
    this.colorAttr.needsUpdate = true;
    this.phaseAttr.needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }

  private appendMarker(count: number, x0: number, y0: number, x1: number, y1: number, progress: number): number {
    const mx = (x0 + x1) * 0.5;
    const my = (y0 + y1) * 0.5;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const line = count;
    let i3 = line * 3;
    let i2 = line * 2;
    let i4 = line * 4;
    this.centers[i3] = mx;
    this.centers[i3 + 1] = my;
    this.centers[i3 + 2] = 1.6;
    this.scales[i2] = Math.hypot(dx, dy) * 0.5;
    this.scales[i2 + 1] = 1.6;
    this.angles[line] = Math.atan2(dy, dx);
    this.kinds[line] = KIND_MARKER;
    this.colors[i4] = 1.1;
    this.colors[i4 + 1] = 0.7;
    this.colors[i4 + 2] = 0.45;
    this.colors[i4 + 3] = 0.42 + progress * 0.3;
    this.phases[line] = progress * 2;
    count++;

    const ring = count;
    i3 = ring * 3;
    i2 = ring * 2;
    i4 = ring * 4;
    this.centers[i3] = x1;
    this.centers[i3 + 1] = y1;
    this.centers[i3 + 2] = 1.8;
    this.scales[i2] = 14 + progress * 6;
    this.scales[i2 + 1] = 14 + progress * 6;
    this.angles[ring] = 0;
    this.kinds[ring] = KIND_RING;
    this.colors[i4] = 1.15;
    this.colors[i4 + 1] = 0.65;
    this.colors[i4 + 2] = 0.35;
    this.colors[i4 + 3] = 0.55;
    this.phases[ring] = 0;
    return count + 1;
  }

  private ring(x: number, y: number, radius: number, life: number, color: THREE.Color, alpha: number): void {
    this.spawn(KIND_RING, x, y, 2, 0, 0, 0, 0, radius, radius, life, color, alpha, 0);
  }

  private disc(x: number, y: number, radius: number, life: number, color: THREE.Color, alpha: number): void {
    this.spawn(KIND_DISC, x, y, 2.6, 0, 0, 0, 0, radius, radius, life, color, alpha, 0);
  }

  private streak(x: number, y: number, angle: number, width: number, length: number, life: number, color: THREE.Color, alpha: number): void {
    this.spawn(KIND_STREAK, x, y, 2.3, 0, 0, angle, 0, length, width, life, color, alpha, 0);
  }

  private arc(x: number, y: number, radius: number, life: number, color: THREE.Color, alpha: number): void {
    this.spawn(KIND_ARC, x, y, 2.3, 0, 0, 0, 0, radius, radius, life, color, alpha, Math.PI * 0.25);
  }

  private burst(x: number, y: number, count: number, speed: number, life: number, color: THREE.Color, alpha: number): void {
    for (let i = 0; i < count; i++) {
      const angle = (Math.PI * 2 * i) / count + (i % 2) * 0.17;
      this.spawn(KIND_DASH, x, y, 2.1, Math.cos(angle) * speed, Math.sin(angle) * speed, angle, (i % 2 === 0 ? -1 : 1) * 1.5, 8, 2.1, life, color, alpha, 0);
    }
  }

  private spawn(kind: number, x: number, y: number, z: number, vx: number, vy: number, angle: number, spin: number, sx: number, sy: number, life: number, color: THREE.Color, alpha: number, phase: number): void {
    const index = this.next;
    this.next = (this.next + 1) % FX_CAPACITY;
    this.pool.alive[index] = 1;
    this.pool.kind[index] = kind;
    this.pool.time[index] = 0;
    this.pool.life[index] = life;
    this.pool.x[index] = x;
    this.pool.y[index] = y;
    this.pool.z[index] = z;
    this.pool.vx[index] = vx;
    this.pool.vy[index] = vy;
    this.pool.angle[index] = angle;
    this.pool.spin[index] = spin;
    this.pool.sx[index] = sx;
    this.pool.sy[index] = sy;
    this.pool.phase[index] = phase;
    const i4 = index * 4;
    this.pool.color[i4] = color.r;
    this.pool.color[i4 + 1] = color.g;
    this.pool.color[i4 + 2] = color.b;
    this.pool.color[i4 + 3] = alpha;
  }

  private teamColor(team: number): THREE.Color {
    return this.teamColors[team % this.teamColors.length];
  }

  private hostileColor(attackerTeam: number, focusTeam: number): THREE.Color {
    if (attackerTeam < 0) return this.neutralColor;
    return this.teamColor(attackerTeam === focusTeam ? focusTeam : attackerTeam);
  }
}
