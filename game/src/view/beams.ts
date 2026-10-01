import * as THREE from 'three';
import {
  Attack,
  AttackPhase,
  Ev,
  FORMS,
  Form,
  Frame,
  LONGBOW,
  MAX_PARTS,
  MUZZLE,
  PartKind,
  Pattern,
  PRIMARY_WEAPONS,
  PRISM,
  Role,
  type World,
} from '../sim/index.ts';
import type { FormDef } from '../sim/index.ts';
import { TEAM_COLORS } from '../config.ts';
import { DrawLayer } from '../render/layers.ts';
import type { FrameContext, StageView } from './frame.ts';
import { drawnMuzzle } from './models/index.ts';
import { drawnPartCenter, drawnPodFacing, drawnSeatPoint, seatBlend, type WorldSnapshot } from './snapshot.ts';
import { binaryAngleToRadians, clamp01, colorIntoLinear, lerp, lerpBinaryAngle, smoothstep, toWorld, TWO_PI } from './shared.ts';

/*
 * Beams, rails and their tells. A beam may only fire after a thin laser has shown exactly where it will go (the design's
 * rule for beams and hitscan), so every beam here has two looks: the tell (a thin bright line) and the beam itself (a bright
 * core in a soft glow, ending in an impact flare where something stopped it). Everything is one instanced mesh on
 * DrawLayer.Beams.
 */
const CAPACITY = 640;
const KIND_BEAM = 0;
const KIND_TELL = 1;
const KIND_DOTTED = 2;
const KIND_FLARE = 3;
const BEAM_Z = 2.6;
const FLARE_Z = 2.8;
/** Glow around a beam, beyond its gameplay half-width, world units. */
const BEAM_GLOW_PAD = 3.5;
const TELL_WIDTH = 0.34;
const TELL_GLOW_PAD = 2.2;
const DOTTED_WIDTH = 0.3;
const MIN_LENGTH = 0.5;
const FRIENDLY_ALPHA = 0.42;
const HOSTILE_GAIN = 1.35;
const FRIENDLY_GAIN = 0.8;
const WHITE = new THREE.Color(1.7, 1.75, 1.85);
/** PRISM's beam tell and the boss beam tells brighten toward the release. */
const TELL_BASE_ALPHA = 0.38;
const TELL_GROW_ALPHA = 0.5;
/** The lance tell pulses faster as the rail nears (Hz, from the tap to the shot). */
const LANCE_PULSE_START_HZ = 3;
const LANCE_PULSE_END_HZ = 16;
const RAIL_LIFE = 0.32;
const RAIL_CAPACITY = 16;
const CHARGE_LINE_MIN_ALPHA = 0.12;
const CHARGE_LINE_MAX_ALPHA = 0.62;
const IMPACT_FLARE_GAIN = 4.5;
const IMPACT_FLARE_MIN = 5;
const ORIGIN_FLARE_GAIN = 2.6;

const VERTEX = /* glsl */ `
attribute vec3 iCenter;
attribute float iAngle;
attribute vec2 iHalf;
attribute float iWidth;
attribute float iKind;
attribute vec4 iColor;
attribute vec3 iCore;
attribute float iPhase;
varying vec2 vLocal;
varying vec2 vHalf;
varying float vWidth;
varying float vKind;
varying vec4 vColor;
varying vec3 vCore;
varying float vPhase;
void main() {
  float c = cos(iAngle);
  float s = sin(iAngle);
  vec2 local = position.xy * iHalf;
  vec2 world = vec2(local.x * c - local.y * s, local.x * s + local.y * c) + iCenter.xy;
  vLocal = position.xy;
  vHalf = iHalf;
  vWidth = iWidth;
  vKind = iKind;
  vColor = iColor;
  vCore = iCore;
  vPhase = iPhase;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(world, iCenter.z, 1.0);
}`;

// Distances are in world units so a beam's core keeps its width whatever its length. Every smoothstep gets edge1 > edge0
// (an equal pair is undefined) and every division a floor: no NaN may leave this shader (see AGENTS.md, Rendering).
const FRAGMENT = /* glsl */ `
varying vec2 vLocal;
varying vec2 vHalf;
varying float vWidth;
varying float vKind;
varying vec4 vColor;
varying vec3 vCore;
varying float vPhase;
void main() {
  vec3 color;
  float alpha;
  if (vKind < 2.5) {
    float pad = max(vHalf.y - vWidth, 0.001);
    float segment = max(vHalf.x - pad, 0.0);
    float along = vLocal.x * vHalf.x;
    float across = abs(vLocal.y) * vHalf.y;
    float dist = length(vec2(max(abs(along) - segment, 0.0), across));
    float aa = fwidth(dist) * 1.5 + 0.001;
    float body = 1.0 - smoothstep(vWidth * 0.7, vWidth + aa, dist);
    float glow = 1.0 - clamp((dist - vWidth) / pad, 0.0, 1.0);
    glow *= glow;
    if (vKind < 0.5) {
      float core = 1.0 - smoothstep(vWidth * 0.18, vWidth * 0.46 + aa, dist);
      float flow = 0.86 + 0.14 * sin((along + vHalf.x) * 0.32 - vPhase * 22.0);
      color = vColor.rgb * (body * flow + glow * 0.4) + vCore * core;
      alpha = body * 0.88 + glow * 0.3 + core * 0.35;
    } else {
      float dots = vKind < 1.5 ? 1.0 : step(0.5, fract((along + vHalf.x) * 0.16 - vPhase));
      color = vColor.rgb * (body + glow * 0.35) + vCore * body * 0.4;
      alpha = (body * 0.92 + glow * 0.22) * dots;
    }
  } else {
    float r = length(vLocal);
    float disc = 1.0 - smoothstep(0.0, 0.62, r);
    float spikes = max(1.0 - abs(vLocal.x * vLocal.y) * 30.0, 0.0) * (1.0 - smoothstep(0.2, 1.0, r));
    float rim = 1.0 - smoothstep(0.0, 0.06 + fwidth(r) * 1.5, abs(r - 0.7));
    color = vCore * disc + vColor.rgb * (spikes + rim * 0.5);
    alpha = disc * 0.75 + spikes * 0.8 + rim * 0.3;
  }
  alpha *= vColor.a;
  if (alpha <= 0.001) discard;
  gl_FragColor = vec4(color, min(alpha, 1.0));
}`;

interface Rail {
  alive: boolean;
  time: number;
  seat: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export class BeamsView implements StageView {
  readonly root = new THREE.Group();
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly centers = new Float32Array(CAPACITY * 3);
  private readonly angles = new Float32Array(CAPACITY);
  private readonly halves = new Float32Array(CAPACITY * 2);
  private readonly widths = new Float32Array(CAPACITY);
  private readonly kinds = new Float32Array(CAPACITY);
  private readonly colors = new Float32Array(CAPACITY * 4);
  private readonly cores = new Float32Array(CAPACITY * 3);
  private readonly phases = new Float32Array(CAPACITY);
  private readonly attrs: readonly THREE.InstancedBufferAttribute[];
  private readonly teamColors = TEAM_COLORS.map((hex) => colorIntoLinear(new THREE.Color(), hex));
  private readonly lancePhase: Float32Array;
  private readonly rails: Rail[] = Array.from({ length: RAIL_CAPACITY }, () => ({ alive: false, time: 0, seat: 0, x0: 0, y0: 0, x1: 0, y1: 0 }));
  private nextRail = 0;
  private count = 0;
  private readonly point = { x: 0, y: 0 };
  private readonly core = { x: 0, y: 0 };
  private readonly scratch = new THREE.Color();

  constructor(seats: number) {
    this.lancePhase = new Float32Array(seats);
    this.geometry = new THREE.InstancedBufferGeometry();
    this.geometry.index = new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1);
    this.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    const attr = (name: string, data: Float32Array, size: number): THREE.InstancedBufferAttribute => {
      const attribute = new THREE.InstancedBufferAttribute(data, size).setUsage(THREE.DynamicDrawUsage);
      this.geometry.setAttribute(name, attribute);
      return attribute;
    };
    this.attrs = [
      attr('iCenter', this.centers, 3),
      attr('iAngle', this.angles, 1),
      attr('iHalf', this.halves, 2),
      attr('iWidth', this.widths, 1),
      attr('iKind', this.kinds, 1),
      attr('iColor', this.colors, 4),
      attr('iCore', this.cores, 3),
      attr('iPhase', this.phases, 1),
    ];
    this.material = new THREE.ShaderMaterial({ vertexShader: VERTEX, fragmentShader: FRAGMENT, transparent: true, depthWrite: false, blending: THREE.NormalBlending });
    const mesh = new THREE.Mesh(this.geometry, this.material);
    mesh.frustumCulled = false;
    mesh.renderOrder = DrawLayer.Beams;
    this.root.add(mesh);
  }

  handleEvents(world: World): void {
    const { m } = world;
    const events = world.events;
    for (let i = 0; i < events.count; i++) {
      if (events.type[i] !== Ev.LanceFire) continue;
      const seat = events.a[i];
      const angle = binaryAngleToRadians(m.plLanceAng[seat]);
      const rail = this.rails[this.nextRail];
      this.nextRail = (this.nextRail + 1) % RAIL_CAPACITY;
      rail.alive = true;
      rail.time = 0;
      rail.seat = seat;
      rail.x0 = toWorld(m.plX[seat]) + Math.cos(angle) * toWorld(MUZZLE);
      rail.y0 = toWorld(m.plY[seat]) + Math.sin(angle) * toWorld(MUZZLE);
      rail.x1 = toWorld(events.x[i]);
      rail.y1 = toWorld(events.y[i]);
    }
  }

  update(previous: WorldSnapshot, current: WorldSnapshot, frame: FrameContext): void {
    this.count = 0;
    for (let seat = 0; seat < current.seats; seat++) {
      if (current.plActive[seat] !== 1 || current.plAlive[seat] !== 1) continue;
      const hostile = current.plTeam[seat] !== frame.focusTeam;
      const form = current.plForm[seat];
      if (form === Form.Normal) this.robot(previous, current, frame, seat, hostile);
      else if (form === Form.Boss) this.colossus(previous, current, frame, seat, hostile);
    }
    this.updateRails(current, frame);
    this.geometry.instanceCount = this.count;
    for (const attribute of this.attrs) attribute.needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }

  private robot(previous: WorldSnapshot, current: WorldSnapshot, frame: FrameContext, seat: number, hostile: boolean): void {
    const robot = current.plFrame[seat];
    const t = seatBlend(previous, current, seat, frame.alpha);
    drawnSeatPoint(previous, current, seat, frame.alpha, this.point);
    const muzzle = toWorld(MUZZLE);
    if (robot === Frame.Longbow && current.plCharge[seat] > 0) {
      const charge = clamp01(lerp(previous.plCharge[seat], current.plCharge[seat], t) / LONGBOW.rail.full);
      const angle = binaryAngleToRadians(lerpBinaryAngle(previous.plAim[seat], current.plAim[seat], t));
      const full = current.plCharge[seat] >= LONGBOW.rail.full;
      const alpha = lerp(CHARGE_LINE_MIN_ALPHA, CHARGE_LINE_MAX_ALPHA, charge) * (full ? 0.85 + 0.15 * Math.sin(frame.time * 18) : 1);
      // From the drawn rifle's muzzle to where the shot's reach (from the simulation's muzzle) ends.
      const start = drawnMuzzle(robot);
      const length = toWorld(PRIMARY_WEAPONS[robot].reach) - (start - muzzle);
      this.line(KIND_DOTTED, this.point.x + Math.cos(angle) * start, this.point.y + Math.sin(angle) * start, angle, length, DOTTED_WIDTH, TELL_GLOW_PAD, this.team(current, seat), hostile, alpha, frame.time * 0.8);
      return;
    }
    if (robot !== Frame.Prism) return;
    const beam = current.plBeam[seat];
    if (beam > 0) {
      const angle = binaryAngleToRadians(previous.plBeam[seat] > 0 ? lerpBinaryAngle(previous.plBeamAng[seat], current.plBeamAng[seat], t) : current.plBeamAng[seat]);
      const length = toWorld(previous.plBeam[seat] > 0 ? lerp(previous.plBeamLen[seat], current.plBeamLen[seat], t) : current.plBeamLen[seat]);
      const x = this.point.x + Math.cos(angle) * muzzle;
      const y = this.point.y + Math.sin(angle) * muzzle;
      const color = this.team(current, seat);
      if (beam <= PRISM.beam.tell) {
        const progress = beam / PRISM.beam.tell;
        this.line(KIND_TELL, x, y, angle, length, TELL_WIDTH, TELL_GLOW_PAD, color, hostile, TELL_BASE_ALPHA + TELL_GROW_ALPHA * progress, 0);
      } else {
        this.beam(x, y, angle, length, toWorld(PRISM.beam.width), toWorld(PRIMARY_WEAPONS[robot].reach), color, hostile, frame.time, 1);
      }
    }
    if (current.plLance[seat] > 0) {
      const progress = 1 - current.plLance[seat] / PRISM.lance.tell;
      this.lancePhase[seat] = (this.lancePhase[seat] + frame.dt * lerp(LANCE_PULSE_START_HZ, LANCE_PULSE_END_HZ, progress) * TWO_PI) % TWO_PI;
      const angle = binaryAngleToRadians(current.plLanceAng[seat]);
      const pulse = 0.5 + 0.5 * Math.sin(this.lancePhase[seat]);
      this.line(KIND_TELL, this.point.x + Math.cos(angle) * muzzle, this.point.y + Math.sin(angle) * muzzle, angle, toWorld(PRISM.lance.length), TELL_WIDTH * (1 + progress * 0.6), TELL_GLOW_PAD, WHITE, hostile, 0.45 + 0.4 * pulse + 0.15 * progress, 0);
    } else {
      this.lancePhase[seat] = 0;
    }
  }

  /** Boss beams: thin lasers along every firing pod's line through the wind-up, then the beams themselves (ptBeamLen). */
  private colossus(previous: WorldSnapshot, current: WorldSnapshot, frame: FrameContext, seat: number, hostile: boolean): void {
    const attack = current.plAtk[seat];
    const phase = current.plAtkPhase[seat];
    if (attack === Attack.None || (phase !== AttackPhase.Windup && phase !== AttackPhase.Release)) return;
    const form = FORMS[current.plFrame[seat]];
    const def = attack === Attack.Salvo ? form.salvo : attack === Attack.Siege ? form.siege : form.ultima;
    if (def.pattern !== Pattern.Beam && def.pattern !== Pattern.Wheel) return;
    const role = attack === Attack.Salvo ? Role.Salvo : attack === Attack.Siege ? Role.Siege : Role.Ultima;
    const radial = def.pattern === Pattern.Wheel;
    const color = this.team(current, seat);
    const length = toWorld(def.length);
    const width = toWorld(def.width);
    const progress = phase === AttackPhase.Windup ? clamp01(1 - current.plAtkTimer[seat] / def.windup) : 1;
    const t = seatBlend(previous, current, seat, frame.alpha);
    const base = seat * MAX_PARTS;
    for (let k = 0; k < form.parts.length; k++) {
      const part = form.parts[k];
      // A pod whose weapon is away cannot fire: no tell, no beam.
      if (part.kind !== PartKind.Pod || (part.roles & role) === 0 || current.ptHp[base + k] <= 0 || current.ptAway[base + k] === 1) continue;
      const angle = this.podLine(previous, current, frame.alpha, form, seat, k, radial);
      const x = this.point.x;
      const y = this.point.y;
      if (phase === AttackPhase.Windup) {
        const alpha = TELL_BASE_ALPHA + TELL_GROW_ALPHA * smoothstep(0, 1, progress) + (progress > 0.75 ? 0.12 * Math.sin(frame.time * 26) : 0);
        this.line(KIND_TELL, x, y, angle, length, TELL_WIDTH * (1 + progress * 0.8), TELL_GLOW_PAD, color, hostile, alpha, 0);
        continue;
      }
      const now = current.ptBeamLen[base + k];
      if (now <= 0) continue;
      const before = previous.ptBeamLen[base + k];
      this.beam(x, y, angle, toWorld(before > 0 ? lerp(before, now, t) : now), width, length, color, hostile, frame.time, 1);
    }
  }

  /** Where a pod's beam starts (left in this.point) and its direction: along its barrel, or out from the core for a wheel. */
  private podLine(previous: WorldSnapshot, current: WorldSnapshot, alpha: number, form: FormDef, seat: number, part: number, radial: boolean): number {
    drawnPartCenter(previous, current, seat, part, alpha, this.point);
    let angle: number;
    if (radial) {
      drawnSeatPoint(previous, current, seat, alpha, this.core);
      angle = Math.atan2(this.point.y - this.core.y, this.point.x - this.core.x);
    } else {
      angle = drawnPodFacing(previous, current, seat, part, alpha);
    }
    const muzzle = toWorld(form.parts[part].muzzle);
    this.point.x += Math.cos(angle) * muzzle;
    this.point.y += Math.sin(angle) * muzzle;
    return angle;
  }

  private updateRails(current: WorldSnapshot, frame: FrameContext): void {
    for (const rail of this.rails) {
      if (!rail.alive) continue;
      rail.time += frame.dt;
      if (rail.time >= RAIL_LIFE) {
        rail.alive = false;
        continue;
      }
      const fade = 1 - rail.time / RAIL_LIFE;
      const dx = rail.x1 - rail.x0;
      const dy = rail.y1 - rail.y0;
      const length = Math.hypot(dx, dy);
      if (length < MIN_LENGTH) continue;
      const hostile = current.plTeam[rail.seat] !== frame.focusTeam;
      const width = toWorld(PRISM.lance.width) * (0.4 + 0.6 * fade);
      this.beam(rail.x0, rail.y0, Math.atan2(dy, dx), length, width, length, this.team(current, rail.seat), hostile, frame.time, fade);
    }
  }

  /** A live beam from (x, y): the beam, a flare at its source and, where something stopped it short, an impact flare. */
  private beam(x: number, y: number, angle: number, length: number, width: number, reach: number, color: THREE.Color, hostile: boolean, time: number, fade: number): void {
    this.line(KIND_BEAM, x, y, angle, length, width, BEAM_GLOW_PAD, color, hostile, fade, time);
    this.flare(x, y, width * ORIGIN_FLARE_GAIN + IMPACT_FLARE_MIN * 0.5, color, hostile, fade * 0.8);
    const stopped = length < reach - MIN_LENGTH;
    const flicker = 0.85 + 0.15 * Math.sin(time * 40);
    this.flare(x + Math.cos(angle) * length, y + Math.sin(angle) * length, (width * IMPACT_FLARE_GAIN + IMPACT_FLARE_MIN) * (stopped ? flicker : 0.55), color, hostile, fade * (stopped ? 1 : 0.5));
  }

  private line(kind: number, x: number, y: number, angle: number, length: number, width: number, pad: number, color: THREE.Color, hostile: boolean, alpha: number, phase: number): void {
    if (length < MIN_LENGTH || this.count >= CAPACITY) return;
    const i = this.count++;
    const half = length * 0.5;
    this.centers[i * 3] = x + Math.cos(angle) * half;
    this.centers[i * 3 + 1] = y + Math.sin(angle) * half;
    this.centers[i * 3 + 2] = BEAM_Z;
    this.angles[i] = angle;
    this.halves[i * 2] = half + pad;
    this.halves[i * 2 + 1] = width + pad;
    this.widths[i] = width;
    this.kinds[i] = kind;
    this.setColor(i, color, hostile, alpha);
    this.phases[i] = phase;
  }

  private flare(x: number, y: number, radius: number, color: THREE.Color, hostile: boolean, alpha: number): void {
    if (this.count >= CAPACITY) return;
    const i = this.count++;
    this.centers[i * 3] = x;
    this.centers[i * 3 + 1] = y;
    this.centers[i * 3 + 2] = FLARE_Z;
    this.angles[i] = 0;
    this.halves[i * 2] = radius;
    this.halves[i * 2 + 1] = radius;
    this.widths[i] = 0;
    this.kinds[i] = KIND_FLARE;
    this.setColor(i, color, hostile, alpha);
    this.phases[i] = 0;
  }

  private setColor(i: number, color: THREE.Color, hostile: boolean, alpha: number): void {
    const gain = hostile ? HOSTILE_GAIN : FRIENDLY_GAIN;
    this.colors[i * 4] = color.r * gain;
    this.colors[i * 4 + 1] = color.g * gain;
    this.colors[i * 4 + 2] = color.b * gain;
    this.colors[i * 4 + 3] = alpha * (hostile ? 1 : FRIENDLY_ALPHA);
    this.cores[i * 3] = WHITE.r;
    this.cores[i * 3 + 1] = WHITE.g;
    this.cores[i * 3 + 2] = WHITE.b;
  }

  private team(current: WorldSnapshot, seat: number): THREE.Color {
    return this.scratch.copy(this.teamColors[current.plTeam[seat] % this.teamColors.length]);
  }
}
