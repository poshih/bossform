import * as THREE from 'three';
import {
  ENERGY_MAX,
  Ev,
  FRAME_STATS,
  Form,
  JUGGERNAUT,
  SHIELD_COST_PER_DAMAGE,
  type World,
} from '../sim/index.ts';
import { TEAM_COLORS } from '../config.ts';
import { DrawLayer, setDrawLayer } from '../render/layers.ts';
import type { FrameContext, StageView } from './frame.ts';
import { drawnSeatPoint, seatBlend, type WorldSnapshot } from './snapshot.ts';
import { binaryAngleToRadians, clamp01, colorIntoLinear, easeOutCubic, expStep, lerp, smoothstep, toWorld } from './shared.ts';

const BUBBLE_SEGMENTS = 72;
const FACET_SIDES = 6;
const FACET_RINGS = 3;
const FACET_RING_STEP = 0.24;
const BUBBLE_Z = 2.15;
const BUBBLE_FILL_OPACITY = 0.055;
const BUBBLE_EDGE_OPACITY = 0.56;
const BUBBLE_LOW_FLICKER_HZ = 26;
const BUBBLE_LOW_ENERGY = 0.28;
const BUBBLE_RAISE_RATE = 18;
const BUBBLE_DROP_RATE = 34;
const BUBBLE_MIN_SCALE = 0.18;
const BROKEN_RING_OPACITY = 0.28;
const BROKEN_RING_RATE = 18;
const TEAM_EDGE_GAIN = 1.08;
const DODGE_EDGE_GAIN = 1.75;
const BOOST_INSTANCE_CAPACITY = 1536;
const KIND_RING = 0;
const KIND_DISC = 1;
const KIND_STREAK = 2;
const KIND_TRIANGLE = 3;
const KIND_SHARD = 4;
const EVENT_RING_Z = 3.3;
const BOOST_WAKE_Z = 2.85;
const SHIELD_HIT_LIFE = 0.26;
const SHIELD_RING_LIFE = 0.36;
const SHIELD_BREAK_LIFE = 0.42;
const SHIELD_BREAK_SHARDS = 18;
const SHIELD_BREAK_SPEED = 66;
const SHIELD_REBOOT_LIFE = 0.34;
const BOOST_BURST_LIFE = 0.30;
const BOOST_BURST_STREAKS = 9;
const BOOST_GHOSTS = 5;
const BOOST_GHOST_SPACING = 8.5;
const BOOST_STREAK_LENGTH = 34;
const BOOST_STREAK_WIDTH = 2.2;
const BOOST_BRAKE_LIFE = 0.18;
const BOOST_BRAKE_RADIUS = 14;
const BOOST_LOW_ALPHA = 0.34;
/** A shield hit that drains this much energy (a JUGGERNAUT mortar shell) draws the largest flash; lighter hits scale down. */
const SHIELD_HIT_HEAVY_DRAIN = JUGGERNAUT.mortar.shot.dmg * SHIELD_COST_PER_DAMAGE;

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
  if (vKind < 0.5) {
    d = abs(length(vLocal) - 0.82) - 0.055;
  } else if (vKind < 1.5) {
    d = length(vLocal) - 0.9;
  } else if (vKind < 2.5) {
    d = capsule(vLocal, vec2(0.96, 0.09));
  } else if (vKind < 3.5) {
    vec2 p = vLocal;
    float nose = abs(p.y) + p.x * 0.55 - 0.45;
    float tail = -p.x - 0.92;
    d = max(nose, tail);
    d = max(d, abs(p.y) - 0.5);
  } else {
    d = capsule(vLocal, vec2(0.78, 0.16));
  }
  float edge = max(fwidth(d) * 1.35, 0.0001);
  float alpha = (1.0 - smoothstep(0.0, edge, d)) * vColor.a;
  if (alpha <= 0.001) discard;
  gl_FragColor = vec4(vColor.rgb, alpha);
}`;

interface MotionPool {
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
  readonly color: Float32Array;
}

function makeMotionPool(): MotionPool {
  return {
    alive: new Uint8Array(BOOST_INSTANCE_CAPACITY),
    kind: new Uint8Array(BOOST_INSTANCE_CAPACITY),
    time: new Float32Array(BOOST_INSTANCE_CAPACITY),
    life: new Float32Array(BOOST_INSTANCE_CAPACITY),
    x: new Float32Array(BOOST_INSTANCE_CAPACITY),
    y: new Float32Array(BOOST_INSTANCE_CAPACITY),
    z: new Float32Array(BOOST_INSTANCE_CAPACITY),
    vx: new Float32Array(BOOST_INSTANCE_CAPACITY),
    vy: new Float32Array(BOOST_INSTANCE_CAPACITY),
    angle: new Float32Array(BOOST_INSTANCE_CAPACITY),
    spin: new Float32Array(BOOST_INSTANCE_CAPACITY),
    sx: new Float32Array(BOOST_INSTANCE_CAPACITY),
    sy: new Float32Array(BOOST_INSTANCE_CAPACITY),
    color: new Float32Array(BOOST_INSTANCE_CAPACITY * 4),
  };
}

interface BubbleRig {
  readonly group: THREE.Group;
  readonly fill: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>;
  readonly outer: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  readonly inner: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  readonly facets: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  readonly broken: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
}

function makeFacetGeometry(): THREE.BufferGeometry {
  const points: number[] = [];
  for (let ring = 1; ring <= FACET_RINGS; ring++) {
    const radius = FACET_RING_STEP * ring;
    for (let side = 0; side < FACET_SIDES; side++) {
      const a0 = (side / FACET_SIDES) * Math.PI * 2;
      const a1 = ((side + 1) / FACET_SIDES) * Math.PI * 2;
      points.push(Math.cos(a0) * radius, Math.sin(a0) * radius, 0, Math.cos(a1) * radius, Math.sin(a1) * radius, 0);
    }
  }
  for (let side = 0; side < FACET_SIDES; side++) {
    const angle = (side / FACET_SIDES) * Math.PI * 2;
    points.push(0, 0, 0, Math.cos(angle) * FACET_RING_STEP * FACET_RINGS, Math.sin(angle) * FACET_RING_STEP * FACET_RINGS, 0);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
  return geometry;
}

function teamColor(team: number): THREE.Color {
  return colorIntoLinear(new THREE.Color(), TEAM_COLORS[team % TEAM_COLORS.length]);
}

export class ShieldsBoostView implements StageView {
  readonly root = new THREE.Group();
  private readonly bubbles: BubbleRig[] = [];
  private readonly shieldAmount: Float32Array;
  private readonly previousBoost: Int32Array;
  private readonly hadBroken: Uint8Array;
  private readonly teamColors = TEAM_COLORS.map((hex: number) => colorIntoLinear(new THREE.Color(), hex));
  private readonly white = new THREE.Color(1.55, 1.62, 1.72);
  private readonly red = new THREE.Color(1.45, 0.22, 0.18);
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
  private readonly pool = makeMotionPool();
  private readonly point = { x: 0, y: 0 };
  private next = 0;

  constructor(seats: number) {
    this.shieldAmount = new Float32Array(seats);
    this.previousBoost = new Int32Array(seats);
    this.hadBroken = new Uint8Array(seats);
    const fillGeometry = new THREE.CircleGeometry(1, BUBBLE_SEGMENTS);
    const outerGeometry = new THREE.RingGeometry(0.965, 1, BUBBLE_SEGMENTS);
    const innerGeometry = new THREE.RingGeometry(0.69, 0.705, BUBBLE_SEGMENTS);
    const brokenGeometry = new THREE.RingGeometry(0.92, 1, BUBBLE_SEGMENTS);
    const facetGeometry = makeFacetGeometry();
    for (let seat = 0; seat < seats; seat++) {
      const color = teamColor(0);
      const group = new THREE.Group();
      group.visible = false;
      group.position.z = BUBBLE_Z;
      const fill = new THREE.Mesh(fillGeometry.clone(), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, depthWrite: false }));
      const outer = new THREE.Mesh(outerGeometry.clone(), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, depthWrite: false }));
      const inner = new THREE.Mesh(innerGeometry.clone(), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, depthWrite: false }));
      const facets = new THREE.LineSegments(facetGeometry.clone(), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0, depthWrite: false }));
      const broken = new THREE.Mesh(brokenGeometry.clone(), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, depthWrite: false }));
      group.add(fill, outer, inner, facets, broken);
      setDrawLayer(group, DrawLayer.Shields);
      this.root.add(group);
      this.bubbles.push({ group, fill, outer, inner, facets, broken });
    }
    fillGeometry.dispose();
    outerGeometry.dispose();
    innerGeometry.dispose();
    brokenGeometry.dispose();
    facetGeometry.dispose();

    this.geometry = new THREE.InstancedBufferGeometry();
    this.geometry.index = new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1);
    this.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    this.centers = new Float32Array(BOOST_INSTANCE_CAPACITY * 3);
    this.scales = new Float32Array(BOOST_INSTANCE_CAPACITY * 2);
    this.angles = new Float32Array(BOOST_INSTANCE_CAPACITY);
    this.kinds = new Float32Array(BOOST_INSTANCE_CAPACITY);
    this.colors = new Float32Array(BOOST_INSTANCE_CAPACITY * 4);
    this.phases = new Float32Array(BOOST_INSTANCE_CAPACITY);
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
    this.material = new THREE.ShaderMaterial({ vertexShader: VERTEX, fragmentShader: FRAGMENT, transparent: true, depthWrite: false });
    const mesh = new THREE.Mesh(this.geometry, this.material);
    mesh.frustumCulled = false;
    mesh.renderOrder = DrawLayer.ShipEffects;
    this.root.add(mesh);
  }

  handleEvents(world: World): void {
    const events = world.events;
    for (let i = 0; i < events.count; i++) {
      const type = events.type[i];
      const seat = events.a[i];
      if (seat < 0 || seat >= world.seats) continue;
      const color = this.teamColor(world.m.plTeam[seat]);
      const x = toWorld(events.x[i]);
      const y = toWorld(events.y[i]);
      if (type === Ev.Boost) {
        const heading = binaryAngleToRadians(events.b[i]);
        this.boostBurst(x, y, heading, color);
      } else if (type === Ev.ShieldHit) {
        const radius = toWorld(FRAME_STATS[world.m.plFrame[seat]].grazeR);
        const damageScale = smoothstep(0, SHIELD_HIT_HEAVY_DRAIN, events.b[i] * SHIELD_COST_PER_DAMAGE);
        this.spawn(KIND_DISC, x, y, EVENT_RING_Z, 0, 0, 0, 0, 4 + damageScale * 3, 4 + damageScale * 3, SHIELD_HIT_LIFE, this.white, 0.20 + damageScale * 0.16);
        this.spawn(KIND_RING, x, y, EVENT_RING_Z + 0.1, 0, 0, 0, 0, 9 + damageScale * 7, 9 + damageScale * 7, SHIELD_HIT_LIFE, color, 0.92);
        this.spawn(KIND_RING, toWorld(world.m.plX[seat]), toWorld(world.m.plY[seat]), EVENT_RING_Z, 0, 0, 0, 0, radius, radius, SHIELD_RING_LIFE, color, 0.28 + damageScale * 0.28);
      } else if (type === Ev.ShieldBreak) {
        this.hadBroken[seat] = 1;
        this.spawn(KIND_DISC, x, y, EVENT_RING_Z, 0, 0, 0, 0, 26, 26, 0.12, this.red, 0.30);
        this.spawn(KIND_RING, x, y, EVENT_RING_Z + 0.2, 0, 0, 0, 0, toWorld(FRAME_STATS[world.m.plFrame[seat]].grazeR) * 1.08, toWorld(FRAME_STATS[world.m.plFrame[seat]].grazeR) * 1.08, SHIELD_BREAK_LIFE, this.red, 0.95);
        for (let shard = 0; shard < SHIELD_BREAK_SHARDS; shard++) {
          const angle = (shard / SHIELD_BREAK_SHARDS) * Math.PI * 2 + (shard % 3) * 0.07;
          this.spawn(KIND_SHARD, x, y, EVENT_RING_Z + 0.4, Math.cos(angle) * SHIELD_BREAK_SPEED, Math.sin(angle) * SHIELD_BREAK_SPEED, angle, (shard % 2 === 0 ? 1 : -1) * 4.4, 8.5, 2.8, SHIELD_BREAK_LIFE, color, 0.86);
        }
      } else if (type === Ev.ShieldUp) {
        if (this.hadBroken[seat] === 1) {
          this.spawn(KIND_RING, x, y, EVENT_RING_Z, 0, 0, 0, 0, toWorld(FRAME_STATS[world.m.plFrame[seat]].grazeR) * 1.18, toWorld(FRAME_STATS[world.m.plFrame[seat]].grazeR) * 1.18, SHIELD_REBOOT_LIFE, color, 0.82);
          this.spawn(KIND_DISC, x, y, EVENT_RING_Z - 0.2, 0, 0, 0, 0, 12, 12, SHIELD_REBOOT_LIFE, this.white, 0.16);
        }
        this.hadBroken[seat] = 0;
      }
    }
  }

  update(previous: WorldSnapshot, current: WorldSnapshot, frame: FrameContext): void {
    let count = this.appendPersistentInstances(previous, current, frame);
    for (let i = 0; i < BOOST_INSTANCE_CAPACITY; i++) {
      if (this.pool.alive[i] !== 1) continue;
      this.pool.time[i] += frame.dt;
      if (this.pool.time[i] >= this.pool.life[i]) {
        this.pool.alive[i] = 0;
        continue;
      }
      this.pool.x[i] += this.pool.vx[i] * frame.dt;
      this.pool.y[i] += this.pool.vy[i] * frame.dt;
      this.pool.angle[i] += this.pool.spin[i] * frame.dt;
      count = this.appendInstance(count, this.pool.kind[i], this.pool.x[i], this.pool.y[i], this.pool.z[i], this.pool.angle[i], this.pool.sx[i], this.pool.sy[i], this.pool.color[i * 4], this.pool.color[i * 4 + 1], this.pool.color[i * 4 + 2], this.pool.color[i * 4 + 3] * (1 - this.pool.time[i] / this.pool.life[i]));
    }
    this.geometry.instanceCount = count;
    this.centerAttr.needsUpdate = true;
    this.scaleAttr.needsUpdate = true;
    this.angleAttr.needsUpdate = true;
    this.kindAttr.needsUpdate = true;
    this.colorAttr.needsUpdate = true;
    this.phaseAttr.needsUpdate = true;

    for (let seat = 0; seat < current.seats; seat++) this.updateBubble(previous, current, frame, seat);
  }

  dispose(): void {
    for (const bubble of this.bubbles) {
      bubble.fill.geometry.dispose();
      bubble.fill.material.dispose();
      bubble.outer.geometry.dispose();
      bubble.outer.material.dispose();
      bubble.inner.geometry.dispose();
      bubble.inner.material.dispose();
      bubble.facets.geometry.dispose();
      bubble.facets.material.dispose();
      bubble.broken.geometry.dispose();
      bubble.broken.material.dispose();
    }
    this.geometry.dispose();
    this.material.dispose();
  }

  private updateBubble(previous: WorldSnapshot, current: WorldSnapshot, frame: FrameContext, seat: number): void {
    const bubble = this.bubbles[seat];
    const alive = current.plActive[seat] === 1 && current.plAlive[seat] === 1;
    const normal = current.plForm[seat] === Form.Normal;
    const shieldUp = alive && normal && current.plShield[seat] === 1;
    const broken = alive && normal && current.plShieldBreak[seat] > 0;
    this.shieldAmount[seat] = expStep(this.shieldAmount[seat], shieldUp ? 1 : 0, shieldUp ? BUBBLE_RAISE_RATE : BUBBLE_DROP_RATE, frame.dt);
    const amount = this.shieldAmount[seat];
    const visible = amount > 0.015 || broken;
    bubble.group.visible = visible;
    if (!visible) return;
    drawnSeatPoint(previous, current, seat, frame.alpha, this.point);
    const { x, y } = this.point;
    const radius = toWorld(FRAME_STATS[current.plFrame[seat]].grazeR);
    const energy = clamp01(current.plEnergy[seat] / ENERGY_MAX);
    const low = smoothstep(BUBBLE_LOW_ENERGY, 0, energy);
    const flicker = low * (0.55 + 0.45 * Math.sin(frame.time * BUBBLE_LOW_FLICKER_HZ + seat));
    const scale = radius * (BUBBLE_MIN_SCALE + (1 - BUBBLE_MIN_SCALE) * easeOutCubic(amount));
    const alpha = amount * (1 - flicker * 0.34);
    const color = this.teamColor(current.plTeam[seat]);
    bubble.group.position.set(x, y, BUBBLE_Z);
    bubble.group.scale.setScalar(scale);
    bubble.group.rotation.z = frame.time * 0.18 + seat * 0.27;
    bubble.fill.material.color.copy(color).multiplyScalar(0.72 + energy * 0.28);
    bubble.outer.material.color.copy(color).multiplyScalar(TEAM_EDGE_GAIN);
    bubble.inner.material.color.copy(color).multiplyScalar(0.8);
    bubble.facets.material.color.copy(color).multiplyScalar(0.9);
    bubble.fill.material.opacity = BUBBLE_FILL_OPACITY * alpha * (0.45 + energy * 0.55);
    bubble.outer.material.opacity = BUBBLE_EDGE_OPACITY * alpha * (0.48 + energy * 0.52);
    bubble.inner.material.opacity = 0.18 * alpha * (0.4 + energy * 0.6);
    bubble.facets.material.opacity = 0.22 * alpha * (0.42 + energy * 0.58);
    bubble.broken.material.color.copy(energy <= 0.01 ? this.red : color);
    bubble.broken.material.opacity = broken ? BROKEN_RING_OPACITY * (0.62 + 0.38 * Math.sin(frame.time * BROKEN_RING_RATE + seat)) : 0;
    bubble.broken.rotation.z = -frame.time * 1.7;
    bubble.broken.scale.setScalar(0.96 + 0.035 * Math.sin(frame.time * 22 + seat));
  }

  /** The wake of every running boost, drawn where the robot is drawn (interpolated), and the brake ring when one ends. */
  private appendPersistentInstances(previous: WorldSnapshot, current: WorldSnapshot, frame: FrameContext): number {
    let count = 0;
    for (let seat = 0; seat < current.seats; seat++) {
      const boost = current.plBoost[seat];
      const frameId = current.plFrame[seat];
      const stats = FRAME_STATS[frameId].boost;
      const active = current.plActive[seat] === 1 && current.plAlive[seat] === 1 && current.plForm[seat] === Form.Normal;
      drawnSeatPoint(previous, current, seat, frame.alpha, this.point);
      const { x, y } = this.point;
      if (active && boost > 0) {
        const blend = seatBlend(previous, current, seat, frame.alpha);
        const vx = lerp(toWorld(previous.plVX[seat]), toWorld(current.plVX[seat]), blend);
        const vy = lerp(toWorld(previous.plVY[seat]), toWorld(current.plVY[seat]), blend);
        const moving = Math.abs(vx) + Math.abs(vy) > 0.0001;
        const angle = moving ? Math.atan2(vy, vx) : binaryAngleToRadians(current.plAim[seat]);
        const speed = moving ? Math.hypot(vx, vy) : toWorld(stats.speed);
        const dodge = boost >= stats.ticks - stats.dodge;
        const team = this.teamColor(current.plTeam[seat]);
        const color = dodge ? this.white : team;
        const gain = dodge ? DODGE_EDGE_GAIN : TEAM_EDGE_GAIN;
        for (let ghost = 0; ghost < BOOST_GHOSTS; ghost++) {
          const age = (ghost + 1) / BOOST_GHOSTS;
          const distance = BOOST_GHOST_SPACING * ghost + speed * age;
          count = this.appendInstance(count, KIND_TRIANGLE, x - Math.cos(angle) * distance, y - Math.sin(angle) * distance, BOOST_WAKE_Z, angle, 10 - ghost, 6 - ghost * 0.55, color.r * gain, color.g * gain, color.b * gain, (dodge ? 0.32 : 0.22) * (1 - age * 0.72));
        }
        for (let side = -1; side <= 1; side += 2) {
          const offset = side * 5.2;
          count = this.appendInstance(count, KIND_STREAK, x - Math.sin(angle) * offset - Math.cos(angle) * 11, y + Math.cos(angle) * offset - Math.sin(angle) * 11, BOOST_WAKE_Z - 0.15, angle, BOOST_STREAK_LENGTH, BOOST_STREAK_WIDTH, team.r * gain, team.g * gain, team.b * gain, dodge ? 0.42 : 0.28);
        }
      } else if (this.previousBoost[seat] > 0) {
        this.spawn(KIND_RING, x, y, BOOST_WAKE_Z, 0, 0, 0, 0, BOOST_BRAKE_RADIUS, BOOST_BRAKE_RADIUS, BOOST_BRAKE_LIFE, this.teamColor(current.plTeam[seat]), BOOST_LOW_ALPHA);
      }
      this.previousBoost[seat] = boost;
    }
    return count;
  }

  private appendInstance(count: number, kind: number, x: number, y: number, z: number, angle: number, sx: number, sy: number, r: number, g: number, b: number, a: number): number {
    if (count >= BOOST_INSTANCE_CAPACITY) return count;
    const i3 = count * 3;
    const i2 = count * 2;
    const i4 = count * 4;
    this.centers[i3] = x;
    this.centers[i3 + 1] = y;
    this.centers[i3 + 2] = z;
    this.scales[i2] = sx;
    this.scales[i2 + 1] = sy;
    this.angles[count] = angle;
    this.kinds[count] = kind;
    this.colors[i4] = r;
    this.colors[i4 + 1] = g;
    this.colors[i4 + 2] = b;
    this.colors[i4 + 3] = a;
    this.phases[count] = 0;
    return count + 1;
  }

  private boostBurst(x: number, y: number, heading: number, color: THREE.Color): void {
    this.spawn(KIND_RING, x, y, BOOST_WAKE_Z, 0, 0, heading, 0, 22, 22, BOOST_BURST_LIFE, color, 0.72);
    for (let i = 0; i < BOOST_BURST_STREAKS; i++) {
      const spread = (i / Math.max(1, BOOST_BURST_STREAKS - 1) - 0.5) * 1.35;
      const angle = heading + Math.PI + spread;
      this.spawn(KIND_STREAK, x - Math.cos(heading) * 5, y - Math.sin(heading) * 5, BOOST_WAKE_Z, Math.cos(angle) * 32, Math.sin(angle) * 32, angle, 0, 25, 3.2, BOOST_BURST_LIFE, color, 0.64);
    }
  }

  private spawn(kind: number, x: number, y: number, z: number, vx: number, vy: number, angle: number, spin: number, sx: number, sy: number, life: number, color: THREE.Color, alpha: number): void {
    const index = this.next;
    this.next = (this.next + 1) % BOOST_INSTANCE_CAPACITY;
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
    const i4 = index * 4;
    this.pool.color[i4] = color.r;
    this.pool.color[i4 + 1] = color.g;
    this.pool.color[i4 + 2] = color.b;
    this.pool.color[i4 + 3] = alpha;
  }

  private teamColor(team: number): THREE.Color {
    return this.teamColors[team % this.teamColors.length];
  }
}
