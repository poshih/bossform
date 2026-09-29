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
import { DrawLayer } from '../render/layers.ts';
import type { FrameContext, StageView } from './frame.ts';
import type { WorldSnapshot } from './snapshot.ts';
import { clamp01, colorIntoLinear, toWorld } from './shared.ts';

const FX_CAPACITY = 1536;
const KIND_RING = 0;
const KIND_STREAK = 1;
const KIND_ARC = 2;
const KIND_DISC = 3;
const KIND_DASH = 4;
const KIND_MARKER = 5;
const PUNCH_DECAY_SECONDS = 0.3;
const PUNCH_DECAY_RATE = 1 / PUNCH_DECAY_SECONDS;
const BIG_EVENT_PUNCH_RADIUS = 360;
const BIG_EVENT_PUNCH_RADIUS_SQ = BIG_EVENT_PUNCH_RADIUS * BIG_EVENT_PUNCH_RADIUS;
const COLOSSUS_DEATH_SECONDARIES = 9;
const ROBOT_DEATH_SHARDS = 26;
const COLOSSUS_DEATH_SHARDS = 54;
const GRAZE_COMBO_DECAY = 5.8;
const GRAZE_STREAK_LENGTH = 34;
const PART_DOWN_SHARDS_MIN = 6;
const PART_DOWN_SHARDS_SPAN = 7;
const STORM_CRACKLES = 5;
const GRAZE_SEAT_CAP = 256;

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
    // The gate only shapes the ring itself (gate - GATE_CUT never exceeds 1 - GATE_CUT); atan(0, 0) at the quad's centre is undefined.
    const float GATE_CUT = 0.45;
    d = abs(length(vLocal) - 0.78) - 0.08;
    if (d < 1.0 - GATE_CUT) {
      float angle = atan(vLocal.y, vLocal.x);
      float gate = smoothstep(1.7, 1.0, abs(angle - vPhase));
      d = max(d, gate - GATE_CUT);
    }
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

export class FxView implements StageView {
  readonly mesh: THREE.Mesh;
  readonly root = new THREE.Group();

  screenFlash = 0;
  ultimaDim = 0;

  /** 0..1 impact this frame for the post-processing (see PostInput.punch). */
  get punch(): number {
    return this.screenFlash;
  }

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
  private readonly grazeCombo = new Float32Array(GRAZE_SEAT_CAP);

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
    this.mesh.renderOrder = DrawLayer.Fx;
    this.root.add(this.mesh);
  }

  handleEvents(world: World, focusSeat: number): void {
    const focusTeam = focusSeat >= 0 && focusSeat < world.seats ? world.m.plTeam[focusSeat] : -999;
    const focusX = focusSeat >= 0 && focusSeat < world.seats ? toWorld(world.m.plX[focusSeat]) : 0;
    const focusY = focusSeat >= 0 && focusSeat < world.seats ? toWorld(world.m.plY[focusSeat]) : 0;
    for (let i = 0; i < world.events.count; i++) {
      const type = world.events.type[i];
      const x = toWorld(world.events.x[i]);
      const y = toWorld(world.events.y[i]);
      const a = world.events.a[i];
      const b = world.events.b[i];
      const c = world.events.c[i];
      const attackerTeam = c >= 0 && c < world.seats ? world.m.plTeam[c] : -1;
      switch (type) {
        case Ev.Hit:
          this.disc(x, y, 9, 0.08, new THREE.Color(1.6, 1.7, 1.9), 0.26);
          this.ring(x, y, 12, 0.22, this.hostileColor(attackerTeam, focusTeam), 0.9);
          this.burst(x, y, 9, 18, 0.22, this.hostileColor(attackerTeam, focusTeam), 1.2);
          break;
        case Ev.Blocked:
          this.arc(x, y, 20, 0.22, this.teamColor(world.m.plTeam[a]), 0.95);
          this.ring(x, y, 25, 0.28, new THREE.Color(0.45, 1.1, 1.45), 0.42);
          break;
        case Ev.Graze:
          this.grazeCombo[a] = Math.min(1, this.grazeCombo[a] + 0.18);
          this.graze(world, x, y, a);
          break;
        case Ev.PartHit:
          this.burst(x, y, 8, 20, 0.28, this.teamColor(world.m.plTeam[a]), 1.15);
          this.burst(x, y, 4, 12, 0.36, new THREE.Color(1.2, 0.9, 0.52), 0.65);
          break;
        case Ev.PartDown:
          this.ring(x, y, 32, 0.48, this.teamColor(world.m.plTeam[a]), 0.82);
          this.burst(x, y, PART_DOWN_SHARDS_MIN + (b % PART_DOWN_SHARDS_SPAN), 34, 0.62, this.teamColor(world.m.plTeam[a]), 1.0);
          this.disc(x, y, 17, 0.12, new THREE.Color(1.35, 1.28, 1.1), 0.24);
          break;
        case Ev.Death:
          if (c === 1) this.colossusDeath(x, y, this.teamColor(world.m.plTeam[a]));
          else this.robotDeath(x, y, this.teamColor(world.m.plTeam[a]));
          if (a === focusSeat || (c === 1 && this.nearFocus(x, y, focusX, focusY))) this.screenFlash = Math.min(1, this.screenFlash + (c === 1 ? 0.92 : 0.55));
          break;
        case Ev.MorphStart:
          this.spiral(x, y, 7, 42, this.teamColor(world.m.plTeam[a]), 0.58);
          this.ring(x, y, 30, 0.6, this.teamColor(world.m.plTeam[a]), 0.72);
          break;
        case Ev.MorphDone:
          this.ring(x, y, 42, 0.55, this.teamColor(world.m.plTeam[a]), 0.76);
          this.disc(x, y, 27, 0.14, this.teamColor(world.m.plTeam[a]), 0.26);
          break;
        case Ev.BossEnd:
          this.ring(x, y, 64, 0.9, new THREE.Color(1.0, 0.8, 0.5), 0.58);
          this.spiral(x, y, 10, 54, new THREE.Color(1.0, 0.75, 0.48), 0.45);
          break;
        case Ev.Respawn:
          this.ring(x, y, 32, 0.55, new THREE.Color(0.4, 1.2, 1.5), 0.85);
          this.streak(x, y, Math.PI / 2, 6, 38, 0.34, new THREE.Color(0.6, 1.3, 1.8), 0.7);
          this.ring(x, y, 18, 0.32, new THREE.Color(0.9, 1.5, 1.8), 0.7);
          break;
        case Ev.OrbPickup:
          this.disc(x, y, world.events.b[i] === 1 ? 18 : 12, 0.2, new THREE.Color(0.6, 1.4, 1.8), 0.26);
          this.burst(x, y, 6, 20, 0.24, new THREE.Color(0.55, 1.35, 1.8), 0.68);
          break;
        case Ev.Absorb:
          this.ring(x, y, 22, 0.32, new THREE.Color(0.8, 1.3, 1.6), 0.7);
          this.spiral(x, y, 6, 28, new THREE.Color(0.55, 1.25, 1.6), 0.5);
          break;
        case Ev.Burst:
          this.ring(x, y, 24, 0.32, new THREE.Color(1.1, 0.95, 0.8), 0.75);
          this.burst(x, y, Math.min(24, Math.max(8, b)), 38, 0.32, new THREE.Color(1.2, 0.92, 0.58), 0.75);
          break;
        case Ev.Dash:
          this.streak(x, y, (world.events.b[i] / 65536) * Math.PI * 2, 10, 44, 0.32, this.teamColor(world.m.plTeam[a]), 0.55);
          this.streak(x, y, (world.events.b[i] / 65536) * Math.PI * 2 + Math.PI, 4, 26, 0.22, this.teamColor(world.m.plTeam[a]), 0.35);
          break;
        case Ev.BulwarkUp:
          this.arc(x, y, 28, 0.45, this.teamColor(world.m.plTeam[a]), 0.95);
          this.ring(x, y, 36, 0.38, new THREE.Color(0.45, 1.15, 1.45), 0.45);
          break;
        case Ev.NeutralKilled:
          this.ring(x, y, 30, 0.46, this.neutralColor, 0.76);
          this.burst(x, y, 14, 30, 0.44, this.neutralColor, 0.9);
          break;
        case Ev.NeutralHit:
          this.burst(x, y, 5, 16, 0.22, this.neutralColor, 0.65);
          break;
        case Ev.StormHit:
          this.crackle(x, y);
          break;
        case Ev.Release:
          if (b === Attack.Siege) {
            this.ring(x, y, 35, 0.28, this.teamColor(world.m.plTeam[a]), 0.55);
            this.burst(x, y, 10, 34, 0.24, this.teamColor(world.m.plTeam[a]), 0.68);
          } else if (b === Attack.Ultima) {
            this.ring(x, y, 86, 0.58, this.teamColor(world.m.plTeam[a]), 0.72);
            this.spiral(x, y, 16, 70, this.teamColor(world.m.plTeam[a]), 0.62);
            if (this.nearFocus(x, y, focusX, focusY)) this.screenFlash = Math.min(1, this.screenFlash + 0.75);
          }
          break;
        default:
      }
    }
  }

  update(_previous: WorldSnapshot, current: WorldSnapshot, frame: FrameContext): void {
    const { world, dt: dtSeconds, time: timeSeconds } = frame;
    this.screenFlash *= Math.exp(-PUNCH_DECAY_RATE * dtSeconds);
    for (let seat = 0; seat < current.seats && seat < GRAZE_SEAT_CAP; seat++) {
      this.grazeCombo[seat] *= Math.exp(-GRAZE_COMBO_DECAY * dtSeconds);
    }
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

  private graze(world: World, x: number, y: number, seat: number): void {
    const combo = seat >= 0 && seat < GRAZE_SEAT_CAP ? this.grazeCombo[seat] : 0;
    const shipX = seat >= 0 && seat < world.seats ? toWorld(world.m.plX[seat]) : x;
    const shipY = seat >= 0 && seat < world.seats ? toWorld(world.m.plY[seat]) : y;
    const angle = Math.atan2(shipY - y, shipX - x);
    const sparkColor = new THREE.Color(1.35, 1.48, 1.75);
    this.arc(x, y, 10 + combo * 9, 0.16, sparkColor, 0.72 + combo * 0.28);
    this.streak((x + shipX) * 0.5, (y + shipY) * 0.5, angle, 2.4 + combo * 2.2, GRAZE_STREAK_LENGTH, 0.18, sparkColor, 0.58 + combo * 0.28);
    this.burst(x, y, 4 + Math.floor(combo * 8), 28 + combo * 24, 0.16, sparkColor, 0.75);
  }

  private robotDeath(x: number, y: number, color: THREE.Color): void {
    this.disc(x, y, 34, 0.12, new THREE.Color(1.55, 1.5, 1.35), 0.32);
    this.ring(x, y, 48, 0.72, new THREE.Color(1.15, 1.15, 1.2), 0.82);
    this.burst(x, y, ROBOT_DEATH_SHARDS, 42, 0.78, color, 1.05);
    this.burst(x, y, 12, 25, 0.95, new THREE.Color(1.0, 0.56, 0.28), 0.62);
  }

  private colossusDeath(x: number, y: number, color: THREE.Color): void {
    this.disc(x, y, 72, 0.14, new THREE.Color(1.65, 1.55, 1.35), 0.34);
    this.ring(x, y, 150, 1.05, new THREE.Color(1.25, 1.2, 1.12), 0.9);
    this.burst(x, y, COLOSSUS_DEATH_SHARDS, 72, 1.05, color, 1.08);
    for (let i = 0; i < COLOSSUS_DEATH_SECONDARIES; i++) {
      const angle = (Math.PI * 2 * i) / COLOSSUS_DEATH_SECONDARIES + (i % 2) * 0.19;
      const radius = 18 + (i % 4) * 10;
      const sx = x + Math.cos(angle) * radius;
      const sy = y + Math.sin(angle) * radius;
      this.disc(sx, sy, 16 + (i % 3) * 4, 0.16 + i * 0.018, new THREE.Color(1.35, 0.85, 0.48), 0.18);
      this.burst(sx, sy, 8, 36 + i * 3, 0.42, color, 0.62);
    }
  }

  private spiral(x: number, y: number, count: number, radius: number, color: THREE.Color, alpha: number): void {
    for (let i = 0; i < count; i++) {
      const t = i / Math.max(1, count - 1);
      const angle = t * Math.PI * 4.6;
      const px = x + Math.cos(angle) * radius * (1 - t);
      const py = y + Math.sin(angle) * radius * (1 - t);
      this.streak(px, py, angle + Math.PI * 0.5, 3.5, 18 + 18 * (1 - t), 0.34 + t * 0.18, color, alpha * (1 - t * 0.35));
    }
  }

  private crackle(x: number, y: number): void {
    const color = new THREE.Color(1.0, 0.42, 0.34);
    for (let i = 0; i < STORM_CRACKLES; i++) {
      const angle = (Math.PI * 2 * i) / STORM_CRACKLES + 0.31;
      this.streak(x, y, angle, 2.2, 24, 0.18, color, 0.62);
    }
  }

  private nearFocus(x: number, y: number, focusX: number, focusY: number): boolean {
    const dx = x - focusX;
    const dy = y - focusY;
    return dx * dx + dy * dy <= BIG_EVENT_PUNCH_RADIUS_SQ;
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
