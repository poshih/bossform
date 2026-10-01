import * as THREE from 'three';
import { Ev, Proj, ReturnMode, SHOT_DEFS, ShotFlag, type ShotDef, type World } from '../sim/index.ts';
import { NEUTRAL_COLORS, TEAM_COLORS } from '../config.ts';
import { DrawLayer } from '../render/layers.ts';
import type { FrameContext, StageView } from './frame.ts';
import type { WorldSnapshot } from './snapshot.ts';
import { binaryAngleToRadians, clamp01, colorIntoLinear, easeOutBack, easeOutExpo, lerp, lerpBinaryAngle, toWorld } from './shared.ts';

const NEUTRAL_EDGE = colorIntoLinear(new THREE.Color(), NEUTRAL_COLORS.accent);
const FRIENDLY_MARK_ALPHA = 0.45;
const WHITE_CORE = new THREE.Color(1.55, 1.7, 1.95);
const FRIENDLY_EDGE_GAIN = 0.42;
const FRIENDLY_CORE_GAIN = 0.55;
const HOSTILE_EDGE_GAIN = 1.45;
const HOSTILE_CORE_GAIN = 1.74;
const NEUTRAL_EDGE_GAIN = 1.28;
const BOSS_SCALE = 1.18;
const BULLET_Z = 1.55;
const TRAIL_Z = 1.18;
const END_FX_Z = 1.72;
const SPAWN_OVERSHOOT_TICKS = 8;
const BEAT_GLOW_GAIN = 0.15;
const TRAIL_WIDTH_GAIN = 0.72;
const TRAIL_MIN_LENGTH = 8;
const TRAIL_SPEED_GAIN = 6.8;
const SEEKER_WIGGLE = 0.14;
const BLADE_SPIN_RATE = 0.36;
const SHARD_TUMBLE_RATE = 0.22;
const SHURIKEN_SPIN_RATE = 0.5;
const MINE_TURN_RATE = 0.02;
const MISSILE_WOBBLE = 0.08;
/** A missile's exhaust (and a rocket fist's, flying out): its trail is this much longer and brighter than a plain shot's. */
const EXHAUST_LENGTH_GAIN = 1.9;
const EXHAUST_ALPHA_GAIN = 1.6;
/** Lobbed shells rise on an arc whose apex is this share of the flight distance, within these heights (world units). */
const LOB_ARC_SHARE = 0.26;
const LOB_ARC_MIN = 16;
const LOB_ARC_MAX = 96;
/** A lobbed shell grows this much at the top of its arc (it is nearer the camera, and it is what the arena watches fall). */
const LOB_APEX_GROWTH = 0.7;
/** The marker's closing ring starts this many blast radii out and tightens onto the blast radius at impact. */
const LOB_CLOSING_START = 1.7;
const LOB_MARK_MIN_ALPHA = 0.3;
const LOB_MARK_MAX_ALPHA = 0.95;
const LOB_SHADOW_RADIUS = 1.6;
const LOB_SHADOW_ALPHA = 0.5;
/** The shadow is the shell's own colour, dimmed: a dark one would vanish into the floor. */
const LOB_SHADOW_GAIN = 0.45;
/** Shells that burst into shrapnel instead of a blast mark a ring this many shell radii wide where they land. */
const LOB_SHRAPNEL_MARK_RADII = 3;
const MINE_TRIGGER_ALPHA = 0.22;
const MARK_Z = 0.3;
const MARK_KIND_BLAST = 0;
const MARK_KIND_CLOSING = 1;
const MARK_KIND_TRIGGER = 2;
const MARK_KIND_SHADOW = 3;
const MARKS_PER_PROJECTILE = 3;
const EVENT_MEMORY = 256;
const EVENT_NEAR_RADIUS = 18;
const EVENT_NEAR_RADIUS_SQ = EVENT_NEAR_RADIUS * EVENT_NEAR_RADIUS;
const END_FX_CAPACITY = 768;
const END_KIND_RING = 0;
const END_KIND_SPARK = 1;
const END_KIND_TRI = 2;
const END_KIND_FLASH = 3;
const END_LIFE_RING = 0.28;
const END_LIFE_SPARK = 0.22;
const END_LIFE_BURST = 0.34;
const MUZZLE_LIFE = 0.18;
const EXPIRY_LIFE = 0.24;
const IMPACT_SPARKS = 7;
const BURST_SPARKS = 14;

const QUAD_POSITIONS = new Float32Array([
  -1, -1, 0,
  1, -1, 0,
  1, 1, 0,
  -1, 1, 0,
]);
const QUAD_INDEX = new Uint16Array([0, 1, 2, 0, 2, 3]);

const BULLET_VERTEX = /* glsl */ `
attribute vec3 iCenter;
attribute float iAngle;
attribute vec2 iScale;
attribute float iKind;
attribute vec3 iColor;
attribute vec3 iCore;
attribute float iFriendly;
attribute float iBoss;
attribute float iPulse;
attribute float iAge;
attribute float iLife;
attribute float iAux;
varying vec2 vLocal;
varying vec3 vColor;
varying vec3 vCore;
varying float vKind;
varying float vFriendly;
varying float vBoss;
varying float vPulse;
varying float vAge;
varying float vLife;
varying float vAux;
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
  vAge = iAge;
  vLife = iLife;
  vAux = iAux;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(world, iCenter.z, 1.0);
}`;

const BULLET_FRAGMENT = /* glsl */ `
varying vec2 vLocal;
varying vec3 vColor;
varying vec3 vCore;
varying float vKind;
varying float vFriendly;
varying float vBoss;
varying float vPulse;
varying float vAge;
varying float vLife;
/** Mines: 0 -> 1 while arming (dim until armed). Fists: 1 while a rocket fist flies home (its wrist port lit). */
varying float vAux;

float capsule(vec2 p, vec2 h) {
  vec2 q = abs(p) - h;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
}

float diamond(vec2 p, float r) { return abs(p.x) + abs(p.y) - r; }
float ring(vec2 p, float r, float w) { return abs(length(p) - r) - w; }
float tri(vec2 p) { return max(abs(p.y) * 1.6 + p.x * 0.55, -p.x) - 0.58; }
float hex(vec2 p, float r) { vec2 q = abs(p); return max(q.x * 0.866 + q.y * 0.5, q.y) - r; }

void main() {
  vec2 p = vLocal;
  float d;
  float line = 10.0;
  float detail = 0.0;
  if (vKind < 0.5) {
    d = capsule(p, vec2(0.76, 0.20));
    detail = capsule(p - vec2(0.34, 0.0), vec2(0.18, 0.13));
  } else if (vKind < 1.5) {
    d = capsule(p, vec2(0.98, 0.055));
    line = abs(p.y) - 0.018;
  } else if (vKind < 2.5) {
    d = tri(p);
    line = abs(p.y + sin(p.x * 9.0 + vAge * 0.28) * 0.055) - 0.055;
  } else if (vKind < 3.5) {
    float fuse = 0.62 - vLife * 0.48;
    d = min(ring(p, 0.64, 0.055), capsule(p, vec2(0.52, 0.25)));
    line = ring(p, fuse, 0.035);
  } else if (vKind < 4.5) {
    d = tri(p);
    line = abs(p.x * 0.5 + p.y) - 0.05;
  } else if (vKind < 5.5) {
    float closing = mix(0.74, 0.34, smoothstep(0.45, 1.0, vLife));
    d = ring(p, closing, 0.045);
    line = ring(p, 0.16 + closing * 0.25, 0.028);
  } else if (vKind < 6.5) {
    d = min(length(p) - 0.36, ring(p, 0.76, 0.05));
    line = hex(p, 0.50);
  } else if (vKind < 7.5) {
    d = min(length(p) - 0.52, ring(p, 0.84, 0.065));
    line = hex(p, 0.33);
  } else if (vKind < 8.5) {
    d = capsule(p, vec2(1.0, 0.048));
    line = abs(p.y) - 0.014;
  } else if (vKind < 9.5) {
    vec2 q = p + vec2(0.18, 0.0);
    d = max(length(q) - 0.84, -(length(q - vec2(0.30, 0.0)) - 0.58));
    line = max(abs(abs(p.x) - abs(p.y)) - 0.045, length(p) - 0.92);
  } else if (vKind < 10.5) {
    // Slash: a crescent sliver, convex side forward.
    d = max(length(p - vec2(-0.75, 0.0)) - 1.0, -(length(p - vec2(-1.05, 0.0)) - 1.0));
    line = abs(length(p - vec2(-0.9, 0.0)) - 1.0) - 0.022;
  } else if (vKind < 11.5) {
    // Shuriken: a four-point star (two crossed rhombi) around a hub.
    vec2 q = abs(p);
    d = min(q.x + q.y * 3.4 - 1.0, q.x * 3.4 + q.y - 1.0) * 0.28;
    line = ring(p, 0.2, 0.03);
  } else if (vKind < 12.5) {
    // Missile: a slim body with a pointed nose and a spine.
    d = max(capsule(p, vec2(0.72, 0.3)), p.x * 0.7 + abs(p.y) * 1.3 - 0.62);
    line = max(abs(p.y) - 0.03, abs(p.x + 0.1) - 0.5);
  } else if (vKind < 13.5) {
    // Mine: a hexagonal disc with a hub.
    d = hex(p, 0.7);
    line = min(abs(hex(p, 0.42)) - 0.03, length(p) - 0.12);
  } else if (vKind < 14.5) {
    // Fist: a chunky knuckle block, knuckles forward.
    vec2 q = abs(p) - vec2(0.56, 0.62);
    d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - 0.22;
    line = min(abs(p.x - 0.36) - 0.035, max(abs(abs(p.y) - 0.28) - 0.03, 0.36 - p.x));
  } else {
    // Bomb: a round body with a tail.
    vec2 c = p - vec2(0.12, 0.0);
    d = min(length(c) - 0.6, capsule(p + vec2(0.62, 0.0), vec2(0.24, 0.36)));
    line = abs(length(c) - 0.36) - 0.03;
  }

  float edgeSoft = fwidth(d) * 1.25;
  float fill = 1.0 - smoothstep(-0.28, -0.035, d);
  float outline = 1.0 - smoothstep(0.018, 0.080 + edgeSoft, abs(d));
  float outer = vBoss * (1.0 - smoothstep(0.10, 0.20 + edgeSoft, abs(d)));
  float hardCore = (1.0 - smoothstep(-0.13, 0.018, d)) * (1.0 - smoothstep(0.08, 0.34, length(p)));
  float hotHead = (1.0 - smoothstep(0.10, 0.38, length(p - vec2(0.48, 0.0)))) * step(vKind, 1.0);
  float detailLine = (1.0 - smoothstep(0.0, fwidth(line) * 1.6 + 0.01, abs(line))) * (1.0 - smoothstep(0.68, 0.95, length(p)));
  float detailDot = (1.0 - smoothstep(0.0, fwidth(detail) * 1.3 + 0.01, detail)) * step(vKind, 0.5);
  float pulse = 1.0 + vPulse;

  vec3 color = vColor * fill * 0.12;
  color += vColor * outline * pulse;
  color += vColor * outer * 0.45 * pulse;
  color += vColor * detailLine * 0.65 * pulse;
  color += vCore * (hardCore + hotHead * 0.75 + detailDot * 0.5) * pulse;

  float alpha = fill * mix(0.10, 0.055, vFriendly);
  alpha += outline * mix(0.94, 0.32, vFriendly);
  alpha += detailLine * mix(0.70, 0.24, vFriendly);
  alpha += outer * 0.42;
  alpha += hardCore * mix(0.48, 0.13, vFriendly);
  alpha += hotHead * mix(0.54, 0.18, vFriendly);
  // A slash is a short sweep of the blade: it thins out over the end of its life instead of popping.
  if (vKind > 9.5 && vKind < 10.5) alpha *= 1.0 - smoothstep(0.6, 1.0, vLife);
  if (vKind > 12.5 && vKind < 13.5) {
    float blink = step(0.999, vAux) * (0.5 + 0.5 * sin(vAge * 0.35));
    color *= mix(0.35, 1.0, vAux) + blink * 0.45;
    alpha *= mix(0.5, 1.0, vAux);
  }
  if (vKind > 13.5 && vKind < 14.5) {
    float wrist = vAux * (1.0 - smoothstep(0.06, 0.32, length(p - vec2(-0.62, 0.0))));
    color += vCore * wrist * 0.9 * pulse;
    alpha += wrist * mix(0.6, 0.2, vFriendly);
  }
  if (alpha <= 0.001) discard;
  gl_FragColor = vec4(color, alpha);
}`;

const TRAIL_VERTEX = /* glsl */ `
attribute vec3 iCenter;
attribute float iAngle;
attribute vec2 iScale;
attribute vec4 iColor;
attribute float iPhase;
varying vec2 vLocal;
varying vec4 vColor;
varying float vPhase;
void main() {
  float c = cos(iAngle);
  float s = sin(iAngle);
  vec2 local = position.xy * iScale;
  vec2 world = vec2(local.x * c - local.y * s, local.x * s + local.y * c) + iCenter.xy;
  vLocal = position.xy;
  vColor = iColor;
  vPhase = iPhase;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(world, iCenter.z, 1.0);
}`;

const TRAIL_FRAGMENT = /* glsl */ `
varying vec2 vLocal;
varying vec4 vColor;
varying float vPhase;
void main() {
  float along = vLocal.x * 0.5 + 0.5;
  float width = mix(0.06, 0.95, along);
  float edge = 1.0 - smoothstep(width, width + fwidth(vLocal.y) * 2.0, abs(vLocal.y));
  float taper = smoothstep(0.0, 0.18, along) * (1.0 - smoothstep(0.86, 1.0, along));
  float comb = 0.72 + 0.28 * sin((along + vPhase) * 24.0);
  float alpha = edge * taper * comb * vColor.a;
  if (alpha <= 0.001) discard;
  gl_FragColor = vec4(vColor.rgb, alpha);
}`;

const END_VERTEX = /* glsl */ `
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

const END_FRAGMENT = /* glsl */ `
varying vec2 vLocal;
varying float vKind;
varying vec4 vColor;
varying float vPhase;
float capsule(vec2 p, vec2 h) {
  vec2 q = abs(p) - h;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
}
float tri(vec2 p) { return max(abs(p.y) * 1.5 + p.x * 0.55, -p.x) - 0.56; }
void main() {
  float d;
  if (vKind < 0.5) d = abs(length(vLocal) - 0.74) - 0.045;
  else if (vKind < 1.5) d = capsule(vLocal, vec2(0.94, 0.08));
  else if (vKind < 2.5) d = tri(vLocal);
  else d = length(vLocal) - 0.9;
  float alpha = (1.0 - smoothstep(0.0, fwidth(d) * 1.6, d)) * vColor.a;
  if (alpha <= 0.001) discard;
  gl_FragColor = vec4(vColor.rgb, alpha);
}`;

const MARK_VERTEX = /* glsl */ `
attribute vec3 iCenter;
attribute float iRadius;
attribute float iKind;
attribute vec4 iColor;
attribute float iPhase;
varying vec2 vLocal;
varying float vRadius;
varying float vKind;
varying vec4 vColor;
varying float vPhase;
void main() {
  // The quad is a little larger than the mark's radius so the rim ring is not clipped by it.
  vec2 local = position.xy * 1.12;
  vLocal = local;
  vRadius = iRadius;
  vKind = iKind;
  vColor = iColor;
  vPhase = iPhase;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(iCenter.xy + local * iRadius, iCenter.z, 1.0);
}`;

// Marks painted on the floor, in radii of the mark (vLocal); line widths are in world units, whatever the radius.
const MARK_FRAGMENT = /* glsl */ `
varying vec2 vLocal;
varying float vRadius;
varying float vKind;
varying vec4 vColor;
varying float vPhase;
const float TWO_PI = 6.2831853;
float dashes(vec2 p, float count, float phase) {
  // atan is only taken away from the centre: atan(0, 0) is undefined.
  if (length(p) < 0.5) return 1.0;
  return step(0.5, fract(atan(p.y, p.x) * count / TWO_PI + phase));
}
void main() {
  float r = length(vLocal);
  float aa = fwidth(r) * 1.5 + 0.0005;
  float lineW = 0.55 / max(vRadius, 1.0);
  float rim = 1.0 - smoothstep(lineW, lineW + aa, abs(r - 1.0));
  float alpha;
  if (vKind < 0.5) {
    float fill = (1.0 - smoothstep(1.0 - aa, 1.0 + aa, r)) * 0.07;
    float crosshair = (1.0 - smoothstep(lineW, lineW + aa, min(abs(vLocal.x), abs(vLocal.y)))) * (1.0 - smoothstep(0.2, 0.2 + aa, r));
    alpha = rim + fill + crosshair * 0.8;
  } else if (vKind < 1.5) {
    alpha = rim * dashes(vLocal, 24.0, vPhase) * 0.85;
  } else if (vKind < 2.5) {
    alpha = rim * dashes(vLocal, 36.0, vPhase) * 0.7;
  } else {
    alpha = (1.0 - smoothstep(0.35, 1.0, r)) * 0.8 + rim * 0.25;
  }
  alpha *= vColor.a;
  if (alpha <= 0.001) discard;
  gl_FragColor = vec4(vColor.rgb, min(alpha, 1.0));
}`;

interface EndPool {
  readonly alive: Uint8Array;
  readonly kind: Uint8Array;
  readonly time: Float32Array;
  readonly life: Float32Array;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  readonly angle: Float32Array;
  readonly spin: Float32Array;
  readonly sx: Float32Array;
  readonly sy: Float32Array;
  readonly color: Float32Array;
}

function makeEndPool(): EndPool {
  return {
    alive: new Uint8Array(END_FX_CAPACITY),
    kind: new Uint8Array(END_FX_CAPACITY),
    time: new Float32Array(END_FX_CAPACITY),
    life: new Float32Array(END_FX_CAPACITY),
    x: new Float32Array(END_FX_CAPACITY),
    y: new Float32Array(END_FX_CAPACITY),
    vx: new Float32Array(END_FX_CAPACITY),
    vy: new Float32Array(END_FX_CAPACITY),
    angle: new Float32Array(END_FX_CAPACITY),
    spin: new Float32Array(END_FX_CAPACITY),
    sx: new Float32Array(END_FX_CAPACITY),
    sy: new Float32Array(END_FX_CAPACITY),
    color: new Float32Array(END_FX_CAPACITY * 4),
  };
}

export class ProjectilesView implements StageView {
  readonly root = new THREE.Group();

  private readonly bulletMesh: THREE.Mesh;
  private readonly bulletGeometry: THREE.InstancedBufferGeometry;
  private readonly bulletMaterial: THREE.ShaderMaterial;
  private readonly trailMesh: THREE.Mesh;
  private readonly trailGeometry: THREE.InstancedBufferGeometry;
  private readonly trailMaterial: THREE.ShaderMaterial;
  private readonly endMesh: THREE.Mesh;
  private readonly endGeometry: THREE.InstancedBufferGeometry;
  private readonly endMaterial: THREE.ShaderMaterial;
  private readonly markGeometry: THREE.InstancedBufferGeometry;
  private readonly markMaterial: THREE.ShaderMaterial;
  private readonly markCapacity: number;
  private readonly markCenters: Float32Array;
  private readonly markRadii: Float32Array;
  private readonly markKinds: Float32Array;
  private readonly markColors: Float32Array;
  private readonly markPhases: Float32Array;
  private readonly markAttrs: readonly THREE.InstancedBufferAttribute[];
  private readonly centers: Float32Array;
  private readonly angles: Float32Array;
  private readonly scales: Float32Array;
  private readonly kinds: Float32Array;
  private readonly colors: Float32Array;
  private readonly cores: Float32Array;
  private readonly friendly: Float32Array;
  private readonly boss: Float32Array;
  private readonly pulses: Float32Array;
  private readonly ages: Float32Array;
  private readonly lifes: Float32Array;
  private readonly auxes: Float32Array;
  private readonly trailCenters: Float32Array;
  private readonly trailAngles: Float32Array;
  private readonly trailScales: Float32Array;
  private readonly trailColors: Float32Array;
  private readonly trailPhases: Float32Array;
  private readonly endCenters: Float32Array;
  private readonly endScales: Float32Array;
  private readonly endAngles: Float32Array;
  private readonly endKinds: Float32Array;
  private readonly endColors: Float32Array;
  private readonly endPhases: Float32Array;
  private readonly bulletAttrs: readonly THREE.InstancedBufferAttribute[];
  private readonly trailAttrs: readonly THREE.InstancedBufferAttribute[];
  private readonly endAttrs: readonly THREE.InstancedBufferAttribute[];
  private readonly teamColors: THREE.Color[];
  private readonly eventType = new Uint8Array(EVENT_MEMORY);
  private readonly eventX = new Float32Array(EVENT_MEMORY);
  private readonly eventY = new Float32Array(EVENT_MEMORY);
  private eventCount = 0;
  private markCount = 0;
  /** The snapshot whose vanished shots were last given their end effects (detectDisappearances). */
  private endedTick = -1;
  private readonly endPool = makeEndPool();
  private nextEnd = 0;

  constructor(world: World) {
    const max = world.cap.projectiles;
    this.bulletGeometry = this.makeGeometry();
    this.centers = new Float32Array(max * 3);
    this.angles = new Float32Array(max);
    this.scales = new Float32Array(max * 2);
    this.kinds = new Float32Array(max);
    this.colors = new Float32Array(max * 3);
    this.cores = new Float32Array(max * 3);
    this.friendly = new Float32Array(max);
    this.boss = new Float32Array(max);
    this.pulses = new Float32Array(max);
    this.ages = new Float32Array(max);
    this.lifes = new Float32Array(max);
    this.auxes = new Float32Array(max);
    this.bulletAttrs = [
      this.attr(this.bulletGeometry, 'iCenter', this.centers, 3),
      this.attr(this.bulletGeometry, 'iAngle', this.angles, 1),
      this.attr(this.bulletGeometry, 'iScale', this.scales, 2),
      this.attr(this.bulletGeometry, 'iKind', this.kinds, 1),
      this.attr(this.bulletGeometry, 'iColor', this.colors, 3),
      this.attr(this.bulletGeometry, 'iCore', this.cores, 3),
      this.attr(this.bulletGeometry, 'iFriendly', this.friendly, 1),
      this.attr(this.bulletGeometry, 'iBoss', this.boss, 1),
      this.attr(this.bulletGeometry, 'iPulse', this.pulses, 1),
      this.attr(this.bulletGeometry, 'iAge', this.ages, 1),
      this.attr(this.bulletGeometry, 'iLife', this.lifes, 1),
      this.attr(this.bulletGeometry, 'iAux', this.auxes, 1),
    ];
    this.bulletMaterial = new THREE.ShaderMaterial({ vertexShader: BULLET_VERTEX, fragmentShader: BULLET_FRAGMENT, transparent: true, depthWrite: false, blending: THREE.NormalBlending });
    this.bulletMesh = new THREE.Mesh(this.bulletGeometry, this.bulletMaterial);
    this.bulletMesh.frustumCulled = false;
    this.bulletMesh.renderOrder = DrawLayer.Projectiles;

    this.trailGeometry = this.makeGeometry();
    this.trailCenters = new Float32Array(max * 3);
    this.trailAngles = new Float32Array(max);
    this.trailScales = new Float32Array(max * 2);
    this.trailColors = new Float32Array(max * 4);
    this.trailPhases = new Float32Array(max);
    this.trailAttrs = [
      this.attr(this.trailGeometry, 'iCenter', this.trailCenters, 3),
      this.attr(this.trailGeometry, 'iAngle', this.trailAngles, 1),
      this.attr(this.trailGeometry, 'iScale', this.trailScales, 2),
      this.attr(this.trailGeometry, 'iColor', this.trailColors, 4),
      this.attr(this.trailGeometry, 'iPhase', this.trailPhases, 1),
    ];
    this.trailMaterial = new THREE.ShaderMaterial({ vertexShader: TRAIL_VERTEX, fragmentShader: TRAIL_FRAGMENT, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    this.trailMesh = new THREE.Mesh(this.trailGeometry, this.trailMaterial);
    this.trailMesh.frustumCulled = false;
    this.trailMesh.renderOrder = DrawLayer.Projectiles;

    this.endGeometry = this.makeGeometry();
    this.endCenters = new Float32Array(END_FX_CAPACITY * 3);
    this.endScales = new Float32Array(END_FX_CAPACITY * 2);
    this.endAngles = new Float32Array(END_FX_CAPACITY);
    this.endKinds = new Float32Array(END_FX_CAPACITY);
    this.endColors = new Float32Array(END_FX_CAPACITY * 4);
    this.endPhases = new Float32Array(END_FX_CAPACITY);
    this.endAttrs = [
      this.attr(this.endGeometry, 'iCenter', this.endCenters, 3),
      this.attr(this.endGeometry, 'iScale', this.endScales, 2),
      this.attr(this.endGeometry, 'iAngle', this.endAngles, 1),
      this.attr(this.endGeometry, 'iKind', this.endKinds, 1),
      this.attr(this.endGeometry, 'iColor', this.endColors, 4),
      this.attr(this.endGeometry, 'iPhase', this.endPhases, 1),
    ];
    this.endMaterial = new THREE.ShaderMaterial({ vertexShader: END_VERTEX, fragmentShader: END_FRAGMENT, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    this.endMesh = new THREE.Mesh(this.endGeometry, this.endMaterial);
    this.endMesh.frustumCulled = false;
    this.endMesh.renderOrder = DrawLayer.Projectiles;

    this.markGeometry = this.makeGeometry();
    this.markCapacity = max * MARKS_PER_PROJECTILE;
    this.markCenters = new Float32Array(this.markCapacity * 3);
    this.markRadii = new Float32Array(this.markCapacity);
    this.markKinds = new Float32Array(this.markCapacity);
    this.markColors = new Float32Array(this.markCapacity * 4);
    this.markPhases = new Float32Array(this.markCapacity);
    this.markAttrs = [
      this.attr(this.markGeometry, 'iCenter', this.markCenters, 3),
      this.attr(this.markGeometry, 'iRadius', this.markRadii, 1),
      this.attr(this.markGeometry, 'iKind', this.markKinds, 1),
      this.attr(this.markGeometry, 'iColor', this.markColors, 4),
      this.attr(this.markGeometry, 'iPhase', this.markPhases, 1),
    ];
    this.markMaterial = new THREE.ShaderMaterial({ vertexShader: MARK_VERTEX, fragmentShader: MARK_FRAGMENT, transparent: true, depthWrite: false, blending: THREE.NormalBlending });
    const markMesh = new THREE.Mesh(this.markGeometry, this.markMaterial);
    markMesh.frustumCulled = false;
    markMesh.renderOrder = DrawLayer.FloorMarks;

    this.root.add(markMesh, this.trailMesh, this.endMesh, this.bulletMesh);
    this.teamColors = TEAM_COLORS.map((hex) => colorIntoLinear(new THREE.Color(), hex));
  }

  handleEvents(world: World): void {
    this.eventCount = 0;
    for (let i = 0; i < world.events.count; i++) {
      const type = world.events.type[i];
      const x = toWorld(world.events.x[i]);
      const y = toWorld(world.events.y[i]);
      if (this.isImpactEvent(type)) this.rememberEvent(type, x, y);
      if (type === Ev.Fire || type === Ev.NeutralFire || type === Ev.PodFire) {
        const team = type === Ev.NeutralFire ? -1 : world.events.a[i] >= 0 && world.events.a[i] < world.seats ? world.m.plTeam[world.events.a[i]] : -1;
        this.muzzleFlash(x, y, this.colorForTeam(team));
      }
    }
  }

  update(previous: WorldSnapshot, current: WorldSnapshot, frame: FrameContext): void {
    const { alpha, focusTeam, time: timeSeconds, dt: dtSeconds, beat } = frame;
    // Once per new snapshot: frames between ticks see the same pair (and no events), and would end every shot again.
    if (current.tick !== this.endedTick) {
      this.endedTick = current.tick;
      this.detectDisappearances(previous, current);
    }
    let count = 0;
    let trailCount = 0;
    this.markCount = 0;
    for (let p = 0; p < current.projectiles; p++) {
      if (current.pAlive[p] !== 1) continue;
      const def = SHOT_DEFS[current.pDef[p]];
      const snap = current.pAge[p] <= 1 || previous.pAlive[p] !== 1 ? 1 : alpha;
      const x = lerp(toWorld(previous.pX[p]), toWorld(current.pX[p]), snap);
      const y = lerp(toWorld(previous.pY[p]), toWorld(current.pY[p]), snap);
      let angle = (lerpBinaryAngle(previous.pAng[p], current.pAng[p], snap) / 65536) * Math.PI * 2;
      angle += this.kindMotionAngle(def.kind, current.pAge[p], p);
      const hostile = current.pTeam[p] !== focusTeam || current.pOwner[p] < 0;
      const friendly = hostile ? 0 : 1;
      const boss = current.pAttack[p] !== 0 ? 1 : 0;
      const baseColor = this.colorForProjectile(current.pOwner[p], current.pTeam[p]);
      const ageNorm = current.pAge[p] / Math.max(1, def.life);
      const beatPulse = beat.pulse * BEAT_GLOW_GAIN;
      const bossPulse = boss === 1 ? 0.08 + 0.06 * Math.sin(timeSeconds * 4.2 + p * 0.11) : 0;
      const radius = toWorld(def.rad) * (boss === 1 ? BOSS_SCALE : 1);
      const lift = (def.flags & ShotFlag.Lob) !== 0 ? this.lob(current, p, def, x, y, lerp(current.pAge[p] - 1, current.pAge[p], snap), hostile, baseColor, timeSeconds) : 0;
      const grow = lift > 0 ? 1 + LOB_APEX_GROWTH * lift / LOB_ARC_MAX : 1;
      if ((def.flags & ShotFlag.Proximity) !== 0 && current.pAge[p] >= def.arm) {
        this.mark(MARK_KIND_TRIGGER, x, y, toWorld(def.trigger), baseColor, markGain(hostile), MINE_TRIGGER_ALPHA * markFade(hostile), timeSeconds * 0.05);
      }
      const spawnScale = this.spawnScale(current.pAge[p]) * grow;
      // A rocket fist flies out knuckles first on its wrist rocket and comes home wrist first, to dock, its wrist port lit.
      const rocketFist = def.kind === Proj.Fist && (def.flags & ShotFlag.Return) !== 0;
      const homeward = rocketFist && current.pMode[p] === ReturnMode.Returning;
      const i3 = count * 3;
      const i2 = count * 2;
      this.centers[i3] = x;
      this.centers[i3 + 1] = y;
      this.centers[i3 + 2] = BULLET_Z + lift;
      this.angles[count] = homeward ? angle + Math.PI : angle;
      this.scales[i2] = this.lengthFor(def.kind, radius, boss === 1) * spawnScale;
      this.scales[i2 + 1] = this.widthFor(def.kind, radius) * spawnScale;
      this.kinds[count] = def.kind;
      const edgeGain = current.pOwner[p] < 0 ? NEUTRAL_EDGE_GAIN : hostile ? HOSTILE_EDGE_GAIN : FRIENDLY_EDGE_GAIN;
      const coreGain = hostile ? HOSTILE_CORE_GAIN : FRIENDLY_CORE_GAIN;
      this.colors[i3] = baseColor.r * edgeGain;
      this.colors[i3 + 1] = baseColor.g * edgeGain;
      this.colors[i3 + 2] = baseColor.b * edgeGain;
      this.cores[i3] = WHITE_CORE.r * coreGain;
      this.cores[i3 + 1] = WHITE_CORE.g * coreGain;
      this.cores[i3 + 2] = WHITE_CORE.b * coreGain;
      this.friendly[count] = friendly;
      this.boss[count] = boss;
      this.pulses[count] = beatPulse + bossPulse;
      this.ages[count] = current.pAge[p];
      this.lifes[count] = clamp01(ageNorm);
      this.auxes[count] = def.kind === Proj.Fist ? (homeward ? 1 : 0) : def.arm > 0 ? clamp01(current.pAge[p] / def.arm) : 1;
      count++;
      // A trail says where a bullet came from: a fuse that stands still has none.
      if (def.spd > 0) {
        const exhaust = def.kind === Proj.Missile || (rocketFist && !homeward);
        trailCount = this.appendTrail(trailCount, x, y, TRAIL_Z + lift, angle, toWorld(def.spd), exhaust, radius, baseColor, hostile, friendly, timeSeconds, p);
      }
    }
    const endCount = this.updateEndFx(dtSeconds);
    this.bulletGeometry.instanceCount = count;
    this.trailGeometry.instanceCount = trailCount;
    this.endGeometry.instanceCount = endCount;
    this.markGeometry.instanceCount = this.markCount;
    this.markNeedsUpdate(this.bulletAttrs);
    this.markNeedsUpdate(this.trailAttrs);
    this.markNeedsUpdate(this.endAttrs);
    this.markNeedsUpdate(this.markAttrs);
  }

  /**
   * A lobbed shell flies over everything to a ground point: it is drawn up on its arc (the height it returns), its shadow on
   * the ground track, and from launch its landing marker shows the blast radius, with a ring that tightens as impact nears.
   */
  private lob(current: WorldSnapshot, p: number, def: ShotDef, x: number, y: number, age: number, hostile: boolean, color: THREE.Color, timeSeconds: number): number {
    const fuse = current.pFuse[p] > 0 ? current.pFuse[p] : def.life;
    const speed = toWorld(current.pSpd[p]);
    const progress = clamp01(age / fuse);
    const apex = Math.min(LOB_ARC_MAX, Math.max(LOB_ARC_MIN, speed * fuse * LOB_ARC_SHARE));
    const heading = binaryAngleToRadians(current.pAng[p]);
    const remaining = speed * (fuse - current.pAge[p]);
    const landX = toWorld(current.pX[p]) + Math.cos(heading) * remaining;
    const landY = toWorld(current.pY[p]) + Math.sin(heading) * remaining;
    const radius = landingRadius(def);
    const alpha = lerp(LOB_MARK_MIN_ALPHA, LOB_MARK_MAX_ALPHA, progress * progress) * markFade(hostile);
    this.mark(MARK_KIND_BLAST, landX, landY, radius, color, markGain(hostile), alpha, 0);
    this.mark(MARK_KIND_CLOSING, landX, landY, radius * lerp(LOB_CLOSING_START, 1, progress), color, markGain(hostile), alpha, timeSeconds * 0.4);
    this.mark(MARK_KIND_SHADOW, x, y, toWorld(def.rad) * LOB_SHADOW_RADIUS, color, LOB_SHADOW_GAIN, LOB_SHADOW_ALPHA * markFade(hostile) * (1 - 0.4 * Math.sin(progress * Math.PI)), 0);
    return 4 * apex * progress * (1 - progress);
  }

  private mark(kind: number, x: number, y: number, radius: number, color: THREE.Color, gain: number, alpha: number, phase: number): void {
    if (this.markCount >= this.markCapacity) return;
    const i = this.markCount++;
    this.markCenters[i * 3] = x;
    this.markCenters[i * 3 + 1] = y;
    this.markCenters[i * 3 + 2] = MARK_Z;
    this.markRadii[i] = radius;
    this.markKinds[i] = kind;
    this.markColors[i * 4] = color.r * gain;
    this.markColors[i * 4 + 1] = color.g * gain;
    this.markColors[i * 4 + 2] = color.b * gain;
    this.markColors[i * 4 + 3] = alpha;
    this.markPhases[i] = phase;
  }

  dispose(): void {
    this.markGeometry.dispose();
    this.markMaterial.dispose();
    this.bulletGeometry.dispose();
    this.bulletMaterial.dispose();
    this.trailGeometry.dispose();
    this.trailMaterial.dispose();
    this.endGeometry.dispose();
    this.endMaterial.dispose();
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

  private appendTrail(count: number, x: number, y: number, z: number, angle: number, speed: number, exhaust: boolean, radius: number, color: THREE.Color, hostile: boolean, friendly: number, timeSeconds: number, index: number): number {
    const length = Math.max(TRAIL_MIN_LENGTH, speed * TRAIL_SPEED_GAIN + radius * 2.4) * (exhaust ? EXHAUST_LENGTH_GAIN : 1);
    const back = length * 0.52;
    const i3 = count * 3;
    const i2 = count * 2;
    const i4 = count * 4;
    this.trailCenters[i3] = x - Math.cos(angle) * back;
    this.trailCenters[i3 + 1] = y - Math.sin(angle) * back;
    this.trailCenters[i3 + 2] = z;
    this.trailAngles[count] = angle;
    this.trailScales[i2] = length;
    this.trailScales[i2 + 1] = radius * TRAIL_WIDTH_GAIN;
    const alpha = (hostile ? 0.22 : 0.08 + friendly * 0.03) * (exhaust ? EXHAUST_ALPHA_GAIN : 1);
    this.trailColors[i4] = color.r * (hostile ? 1.05 : 0.46);
    this.trailColors[i4 + 1] = color.g * (hostile ? 1.05 : 0.46);
    this.trailColors[i4 + 2] = color.b * (hostile ? 1.05 : 0.46);
    this.trailColors[i4 + 3] = alpha;
    this.trailPhases[count] = timeSeconds * 0.7 + index * 0.013;
    return count + 1;
  }

  private updateEndFx(dtSeconds: number): number {
    let count = 0;
    for (let i = 0; i < END_FX_CAPACITY; i++) {
      if (this.endPool.alive[i] !== 1) continue;
      this.endPool.time[i] += dtSeconds;
      if (this.endPool.time[i] >= this.endPool.life[i]) {
        this.endPool.alive[i] = 0;
        continue;
      }
      this.endPool.x[i] += this.endPool.vx[i] * dtSeconds;
      this.endPool.y[i] += this.endPool.vy[i] * dtSeconds;
      this.endPool.angle[i] += this.endPool.spin[i] * dtSeconds;
      const t = clamp01(this.endPool.time[i] / this.endPool.life[i]);
      const grow = easeOutExpo(t);
      const fade = 1 - t;
      const i3 = count * 3;
      const i2 = count * 2;
      const i4 = count * 4;
      const p4 = i * 4;
      this.endCenters[i3] = this.endPool.x[i];
      this.endCenters[i3 + 1] = this.endPool.y[i];
      this.endCenters[i3 + 2] = END_FX_Z;
      this.endScales[i2] = this.endPool.sx[i] * (0.35 + grow * 0.95);
      this.endScales[i2 + 1] = this.endPool.sy[i] * (0.35 + grow * 0.95);
      this.endAngles[count] = this.endPool.angle[i];
      this.endKinds[count] = this.endPool.kind[i];
      this.endColors[i4] = this.endPool.color[p4];
      this.endColors[i4 + 1] = this.endPool.color[p4 + 1];
      this.endColors[i4 + 2] = this.endPool.color[p4 + 2];
      this.endColors[i4 + 3] = this.endPool.color[p4 + 3] * fade;
      this.endPhases[count] = t;
      count++;
    }
    return count;
  }

  private detectDisappearances(previous: WorldSnapshot, current: WorldSnapshot): void {
    for (let p = 0; p < previous.projectiles; p++) {
      if (previous.pAlive[p] !== 1 || current.pAlive[p] === 1) continue;
      const def = SHOT_DEFS[previous.pDef[p]];
      const x = toWorld(previous.pX[p]);
      const y = toWorld(previous.pY[p]);
      const color = this.colorForProjectile(previous.pOwner[p], previous.pTeam[p]);
      const nearby = this.nearEventType(x, y);
      // The effects view draws blasts and catches; a lobbed shell that bursts still sprays its shrapnel here.
      if (nearby === Ev.Catch || ((def.flags & ShotFlag.Lob) !== 0 && def.burst === null)) continue;
      if (nearby === Ev.Burst || def.burst !== null) this.endBurst(x, y, color, true);
      else if (nearby !== 0) this.endImpact(x, y, color);
      else if (previous.pAge[p] >= def.life - 1) {
        if (def.kind !== Proj.Slash) this.endExpiry(x, y, color);
      }
      else this.endImpact(x, y, color);
    }
  }

  private rememberEvent(type: number, x: number, y: number): void {
    if (this.eventCount >= EVENT_MEMORY) return;
    this.eventType[this.eventCount] = type;
    this.eventX[this.eventCount] = x;
    this.eventY[this.eventCount] = y;
    this.eventCount++;
  }

  private nearEventType(x: number, y: number): number {
    for (let i = 0; i < this.eventCount; i++) {
      const dx = x - this.eventX[i];
      const dy = y - this.eventY[i];
      if (dx * dx + dy * dy <= EVENT_NEAR_RADIUS_SQ) return this.eventType[i];
    }
    return 0;
  }

  private isImpactEvent(type: number): boolean {
    return type === Ev.Hit || type === Ev.PartHit || type === Ev.Blocked || type === Ev.Absorb || type === Ev.NeutralHit || type === Ev.Burst || type === Ev.Catch;
  }

  private muzzleFlash(x: number, y: number, color: THREE.Color): void {
    this.spawnEnd(END_KIND_FLASH, x, y, 0, 0, 0, 0, 10, 10, MUZZLE_LIFE, WHITE_CORE, 0.28);
    this.spawnEnd(END_KIND_RING, x, y, 0, 0, 0, 0, 13, 13, MUZZLE_LIFE, color, 0.55);
    this.sparks(x, y, 5, 26, color, 0.48, END_LIFE_SPARK);
  }

  private endImpact(x: number, y: number, color: THREE.Color): void {
    this.spawnEnd(END_KIND_FLASH, x, y, 0, 0, 0, 0, 7, 7, END_LIFE_SPARK, WHITE_CORE, 0.36);
    this.sparks(x, y, IMPACT_SPARKS, 42, color, 0.72, END_LIFE_SPARK);
  }

  private endBurst(x: number, y: number, color: THREE.Color, shardSpray: boolean): void {
    this.spawnEnd(END_KIND_RING, x, y, 0, 0, 0, 0, 24, 24, END_LIFE_RING, WHITE_CORE, 0.58);
    this.sparks(x, y, BURST_SPARKS, 56, color, 0.68, END_LIFE_BURST);
    if (shardSpray) this.triangles(x, y, 8, 38, color);
  }

  private endExpiry(x: number, y: number, color: THREE.Color): void {
    this.spawnEnd(END_KIND_RING, x, y, 0, 0, 0, 0, 15, 15, EXPIRY_LIFE, color, 0.34);
    this.spawnEnd(END_KIND_FLASH, x, y, 0, 0, 0, 0, 5, 5, EXPIRY_LIFE, WHITE_CORE, 0.20);
  }

  private sparks(x: number, y: number, count: number, speed: number, color: THREE.Color, alpha: number, life: number): void {
    for (let i = 0; i < count; i++) {
      const angle = (Math.PI * 2 * i) / count + (i % 3) * 0.21;
      const gain = 0.58 + (i % 4) * 0.13;
      this.spawnEnd(END_KIND_SPARK, x, y, Math.cos(angle) * speed * gain, Math.sin(angle) * speed * gain, angle, 0, 7 + (i % 3) * 2, 1.3, life, color, alpha);
    }
  }

  private triangles(x: number, y: number, count: number, speed: number, color: THREE.Color): void {
    for (let i = 0; i < count; i++) {
      const angle = (Math.PI * 2 * i) / count + 0.12;
      this.spawnEnd(END_KIND_TRI, x, y, Math.cos(angle) * speed, Math.sin(angle) * speed, angle, (i % 2 === 0 ? 1 : -1) * 8, 5, 4, END_LIFE_BURST, color, 0.54);
    }
  }

  private spawnEnd(kind: number, x: number, y: number, vx: number, vy: number, angle: number, spin: number, sx: number, sy: number, life: number, color: THREE.Color, alpha: number): void {
    const index = this.nextEnd;
    this.nextEnd = (this.nextEnd + 1) % END_FX_CAPACITY;
    this.endPool.alive[index] = 1;
    this.endPool.kind[index] = kind;
    this.endPool.time[index] = 0;
    this.endPool.life[index] = life;
    this.endPool.x[index] = x;
    this.endPool.y[index] = y;
    this.endPool.vx[index] = vx;
    this.endPool.vy[index] = vy;
    this.endPool.angle[index] = angle;
    this.endPool.spin[index] = spin;
    this.endPool.sx[index] = sx;
    this.endPool.sy[index] = sy;
    const i4 = index * 4;
    this.endPool.color[i4] = color.r;
    this.endPool.color[i4 + 1] = color.g;
    this.endPool.color[i4 + 2] = color.b;
    this.endPool.color[i4 + 3] = alpha;
  }

  /** Half-length of a projectile's quad along its heading (the shader's shapes are drawn in that quad). */
  private lengthFor(kind: number, radius: number, boss: boolean): number {
    switch (kind) {
      case Proj.Dart:
        return radius * (boss ? 7.2 : 6.3);
      case Proj.Needle:
        return radius * 8.0;
      case Proj.Seeker:
        return radius * 2.5;
      case Proj.Shell:
        return radius * 1.65;
      case Proj.Echo:
        return radius * 1.35;
      case Proj.Blade:
        return radius * 1.75;
      case Proj.Missile:
        return radius * 2.3;
      case Proj.Slash:
      case Proj.Shuriken:
      case Proj.Mine:
      case Proj.Fist:
      case Proj.Bomb:
        return this.widthFor(kind, radius);
      default:
        return radius * 2.0;
    }
  }

  /** Half-width of a projectile's quad across its heading: the radius, but square quads for the shapes drawn round. */
  private widthFor(kind: number, radius: number): number {
    switch (kind) {
      case Proj.Slash:
        return radius * 1.55;
      case Proj.Shuriken:
        return radius * 1.5;
      case Proj.Mine:
        return radius * 1.3;
      case Proj.Bomb:
        return radius * 1.5;
      case Proj.Fist:
        return radius * 1.25;
      default:
        return radius;
    }
  }

  private kindMotionAngle(kind: number, age: number, index: number): number {
    switch (kind) {
      case Proj.Seeker:
        return Math.sin(age * 0.24 + index * 0.37) * SEEKER_WIGGLE;
      case Proj.Shard:
        return age * SHARD_TUMBLE_RATE + index * 0.19;
      case Proj.Blade:
        return age * BLADE_SPIN_RATE;
      case Proj.Shuriken:
        return age * SHURIKEN_SPIN_RATE;
      case Proj.Mine:
        return age * MINE_TURN_RATE + index * 0.4;
      case Proj.Missile:
        return Math.sin(age * 0.3 + index * 0.53) * MISSILE_WOBBLE;
      default:
        return 0;
    }
  }

  private spawnScale(age: number): number {
    if (age >= SPAWN_OVERSHOOT_TICKS) return 1;
    return 0.28 + easeOutBack(age / SPAWN_OVERSHOOT_TICKS) * 0.82;
  }

  private colorForProjectile(owner: number, team: number): THREE.Color {
    if (owner < 0) return NEUTRAL_EDGE;
    return this.teamColors[team % this.teamColors.length];
  }

  private colorForTeam(team: number): THREE.Color {
    if (team < 0) return NEUTRAL_EDGE;
    return this.teamColors[team % this.teamColors.length];
  }
}

/**
 * The radius a lobbed shell's landing marker shows, world units: its blast; for a shell that bursts into a proximity mine,
 * the mine's trigger radius; for one that bursts into shrapnel, a ring a few shell radii wide round the burst point.
 */
function landingRadius(def: ShotDef): number {
  if (def.blastR > 0) return toWorld(def.blastR);
  if (def.burst !== null && (def.burst.shot.flags & ShotFlag.Proximity) !== 0) return toWorld(def.burst.shot.trigger);
  return toWorld(def.rad) * LOB_SHRAPNEL_MARK_RADII;
}

/** Marks are tinted like the shots that make them: hostile ones bright, the viewer's own team's ghosted. */
function markGain(hostile: boolean): number {
  return hostile ? HOSTILE_EDGE_GAIN : FRIENDLY_EDGE_GAIN;
}

function markFade(hostile: boolean): number {
  return hostile ? 1 : FRIENDLY_MARK_ALPHA;
}
