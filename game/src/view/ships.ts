import * as THREE from 'three';
import {
  Attack,
  AttackPhase,
  BeamKind,
  BOSS_MIN_GAUGE,
  ENERGY_MAX,
  Ev,
  FireSlot,
  FLASH_TICKS,
  FORMS,
  FRAME_STATS,
  Form,
  Frame,
  GAUGE_MAX,
  HAILSTORM,
  JUGGERNAUT,
  LONGBOW,
  MAX_PARTS,
  MORPH_TICKS,
  Pattern,
  primaryCost,
  PRISM,
  RONIN,
  Role,
  SHOT_DEFS,
  ShotFlag,
} from '../sim/index.ts';
import type { World } from '../sim/index.ts';
import { ROBOT_VISUAL_SCALE, TEAM_COLORS } from '../config.ts';
import { DrawLayer, setDrawLayer } from '../render/layers.ts';
import { createVectorMaterial, vectorMesh } from '../render/vector.ts';
import type { VectorMaterial } from '../render/vector.ts';
import { createColossus, createRobot } from './models/index.ts';
import type { ColossusPose, PartPose, RobotPose } from './models/index.ts';
import type { FrameContext, StageView } from './frame.ts';
import { hiddenFrom, seatBlend, seatJumped, type WorldSnapshot } from './snapshot.ts';
import { binaryAngleToRadians, clamp01, colorIntoLinear, easeOutCubic, expStep, lerp, lerpRadiansBinary, smoothstep, toWorld, wrapAngleRadians } from './shared.ts';

interface ShipRenderSample {
  x: number;
  y: number;
  vx: number;
  vy: number;
  aim: number;
  body: number;
  orbit: number;
  speed: number;
  alive: boolean;
  epochChanged: boolean;
}

/** The bulwark wedge is gameplay, not decoration: it is drawn from the simulation's radius and arc, never scaled. */
const BULWARK_RADIUS = toWorld(JUGGERNAUT.bulwark.radius);
const BULWARK_HALF_ARC = binaryAngleToRadians(JUGGERNAUT.bulwark.halfArc);
const BULWARK_INNER_RADIUS = toWorld(FRAME_STATS[Frame.Juggernaut].bodyR) * ROBOT_VISUAL_SCALE;
const BULWARK_SEGMENTS = 32;
const BULWARK_CREASE_DEGREES = 40;
const BULWARK_FILL_ALPHA = 0.16;
const BULWARK_FILL_TINT = 0.1;
const BULWARK_EDGE_WIDTH = 1.7;
const BULWARK_GLOW = 1.5;
/** RONIN's parry arc is gameplay too: drawn at the simulation's radius and arc, a band inside its rim. */
const GUARD_RADIUS = toWorld(RONIN.parry.radius);
const GUARD_HALF_ARC = binaryAngleToRadians(RONIN.parry.halfArc);
const GUARD_BAND = 0.3;
const GUARD_SEGMENTS = 32;
const GUARD_FILL_ALPHA = 0.1;
const GUARD_EDGE_WIDTH = 1.9;
const GUARD_GLOW = 1.9;
/** The arc fades over the parry's last ticks. */
const GUARD_FADE_TICKS = 4;
/** Eased stances (per second): RONIN snaps into its parry and eases out; SHADE fades in and out of its cloak. */
const PARRY_STANCE_IN = 40;
const PARRY_STANCE_OUT = 12;
const CLOAK_FADE_RATE = 8;
/**
 * A cloaked SHADE is invisible to its opponents but for a faint shimmer that appears once it moves fast: from this share of
 * its top speed, full at the second (a boost).
 */
const SHIMMER_SPEED_START = 0.55;
const SHIMMER_SPEED_FULL = 1.6;
const SHIMMER_OPACITY = 0.24;
const SHIMMER_RADIUS = 1.25;
const SHIMMER_Z = 2.4;
const SHIMMER_COLOR = new THREE.Color(0.75, 0.8, 0.95);
const SHIMMER_VERTEX = /* glsl */ `
varying vec2 vLocal;
void main() {
  vLocal = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
// A thin wobbling ring broken into flickering arcs: bent light, not a ship. atan is taken only away from the centre.
const SHIMMER_FRAGMENT = /* glsl */ `
uniform float uTime;
uniform float uOpacity;
uniform vec3 uColor;
varying vec2 vLocal;
void main() {
  float r = length(vLocal);
  float wobble = 0.0;
  float arcs = 1.0;
  if (r > 0.3) {
    float a = atan(vLocal.y, vLocal.x);
    wobble = 0.035 * sin(a * 7.0 + uTime * 9.0) + 0.025 * sin(a * 13.0 - uTime * 14.0);
    arcs = 0.5 + 0.5 * sin(a * 5.0 - uTime * 6.0);
  }
  float aa = fwidth(r) * 1.5 + 0.001;
  float ring = 1.0 - smoothstep(0.03, 0.03 + aa + 0.05, abs(r - (0.72 + wobble)));
  float alpha = ring * (0.3 + 0.7 * arcs) * uOpacity;
  if (alpha <= 0.001) discard;
  gl_FragColor = vec4(uColor, alpha);
}`;
const INVULN_FADE_TICKS = 20;
/** How fast the fire and alt pulses (muzzle flash, recoil) fade after a shot, per second. */
const FIRE_DECAY = 8;
const ALT_DECAY = 5;
/** PRISM faces its beam or locked lance while one runs; after, it turns back to the aim at this rate (per second). */
const BEAM_FACING_RETURN = 14;
const NORMAL_MARKER_SCALE = 1.14;
const BOSS_MARKER_SCALE = 1.02;
const MIN_CORE_VISUAL_RADIUS = 2.2;
const NORMAL_CORE_SCALE = 1.18;
const BOSS_CORE_SCALE = 1.05;
const FOCUS_CORE_GAIN = 1.18;
const READY_TICKS = 12;
const READY_AURA_RADIUS = 19;
const READY_AURA_Z = 4.2;
const READY_AURA_FLOW = 0.32;
const READY_AURA_EDGE_WIDTH = 1.35;
const READY_TICK_LENGTH = 3.1;
const READY_TICK_WIDTH = 0.42;
const ENERGY_ARC_SEGMENTS = 72;
const ENERGY_ARC_INNER_RADIUS = 13.0;
const ENERGY_ARC_OUTER_RADIUS = 14.35;
const ENERGY_ARC_Z = 2.1;
const ENERGY_ARC_START = Math.PI * 0.5;
const ENERGY_ARC_HEALTHY_OPACITY = 0.92;
const ENERGY_ARC_DOWN_OPACITY = 0.46;
const ENERGY_ARC_WARNING = 0.3;
const ENERGY_ARC_DASH_PERIOD = 4;
const ENERGY_ARC_DASH_ON = 2;
const ENERGY_ARC_PULSE_HZ = 10;
const ENERGY_ARC_BACK_OPACITY = 0.18;
const ENERGY_ARC_AMBER = 0xffb23a;
const ENERGY_ARC_RED = 0xff3c35;
const CORE_DOT_NORMAL_OPACITY = 0.46;
const CORE_DOT_FOCUS_OPACITY = 0.58;
const CORE_DOT_BOSS_OPACITY = 0.34;
const CORE_RING_NORMAL_OPACITY = 0.68;
const CORE_RING_FOCUS_OPACITY = 0.82;
const CORE_RING_BOSS_OPACITY = 0.84;
const CORE_DOT_TEAM_GAIN = 0.56;
const CORE_DOT_BOSS_COLOR = 0x05080d;
const BACKPLATE_ROBOT_SCALE = 1.72;
const BACKPLATE_BOSS_SCALE = 0.86;
const BACKPLATE_FOCUS_OPACITY = 0.30;
const BACKPLATE_OPACITY = 0.22;

function teamColor(team: number): THREE.Color {
  return colorIntoLinear(new THREE.Color(), TEAM_COLORS[team % TEAM_COLORS.length]);
}

function createEnergyArcGeometry(): THREE.BufferGeometry {
  const positions = new Float32Array(ENERGY_ARC_SEGMENTS * 4 * 3);
  const indices = new Uint16Array(ENERGY_ARC_SEGMENTS * 6);
  for (let segment = 0; segment < ENERGY_ARC_SEGMENTS; segment++) {
    const vertex = segment * 4;
    const index = segment * 6;
    indices.set([vertex, vertex + 1, vertex + 2, vertex + 2, vertex + 1, vertex + 3], index);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  return geometry;
}

function setEnergyArcGeometry(geometry: THREE.BufferGeometry, fraction: number, dashed: boolean): void {
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  const positions = position.array as Float32Array;
  const filled = clamp01(fraction) * ENERGY_ARC_SEGMENTS;
  for (let segment = 0; segment < ENERGY_ARC_SEGMENTS; segment++) {
    const visible = segment < filled && (!dashed || segment % ENERGY_ARC_DASH_PERIOD < ENERGY_ARC_DASH_ON);
    const a0 = ENERGY_ARC_START - (segment / ENERGY_ARC_SEGMENTS) * Math.PI * 2;
    const a1 = ENERGY_ARC_START - ((segment + Math.min(1, Math.max(0, filled - segment))) / ENERGY_ARC_SEGMENTS) * Math.PI * 2;
    const base = segment * 12;
    if (!visible) {
      positions.fill(0, base, base + 12);
      continue;
    }
    positions.set([
      Math.cos(a0) * ENERGY_ARC_INNER_RADIUS, Math.sin(a0) * ENERGY_ARC_INNER_RADIUS, 0,
      Math.cos(a0) * ENERGY_ARC_OUTER_RADIUS, Math.sin(a0) * ENERGY_ARC_OUTER_RADIUS, 0,
      Math.cos(a1) * ENERGY_ARC_INNER_RADIUS, Math.sin(a1) * ENERGY_ARC_INNER_RADIUS, 0,
      Math.cos(a1) * ENERGY_ARC_OUTER_RADIUS, Math.sin(a1) * ENERGY_ARC_OUTER_RADIUS, 0,
    ], base);
  }
  position.needsUpdate = true;
}

export class ShipsView implements StageView {
  readonly root = new THREE.Group();
  private readonly firePulse: Float32Array;
  private readonly altPulse: Float32Array;

  private readonly robots = [] as ReturnType<typeof createRobot>[];
  private readonly robotMounts: THREE.Group[] = [];
  private readonly bulwarks: THREE.Mesh[] = [];
  private readonly bulwarkMaterials: VectorMaterial[] = [];
  private readonly colossi = [] as ReturnType<typeof createColossus>[];
  private readonly markers: THREE.Mesh[] = [];
  private readonly markerMaterials: THREE.ShaderMaterial[] = [];
  private readonly energyArcs: THREE.Mesh[] = [];
  private readonly energyArcMaterials: THREE.MeshBasicMaterial[] = [];
  private readonly energyArcBacks: THREE.Mesh[] = [];
  private readonly energyArcBackMaterials: THREE.MeshBasicMaterial[] = [];
  private readonly backplates: THREE.Mesh[] = [];
  private readonly backplateMaterials: THREE.MeshBasicMaterial[] = [];
  private readonly glows: THREE.Mesh[] = [];
  private readonly glowMaterials: THREE.MeshBasicMaterial[] = [];
  private readonly coreDots: THREE.Mesh[] = [];
  private readonly coreDotMaterials: THREE.MeshBasicMaterial[] = [];
  private readonly coreRings: THREE.Mesh[] = [];
  private readonly coreRingMaterials: THREE.MeshBasicMaterial[] = [];
  private readonly readyAuras: THREE.Group[] = [];
  private readonly readyAuraMaterials: VectorMaterial[] = [];
  private readonly modelFrames: number[] = [];
  private readonly partPoses: PartPose[][];
  private readonly guards: THREE.Mesh[] = [];
  private readonly guardMaterials: VectorMaterial[] = [];
  private readonly shimmers: THREE.Mesh[] = [];
  private readonly shimmerMaterials: THREE.ShaderMaterial[] = [];
  /** Eased RONIN parry stance or SHADE cloak (RobotPose.special), per seat. */
  private readonly stance: Float32Array;
  /** Whose rocket fist is in flight, per seat (GAUNTLET's RobotPose.special; a colossus's pods keep theirs in ptAway). */
  private readonly robotAway: Uint8Array;
  /** How far PRISM's drawn facing is turned off its aim, radians, per seat (onto its beam or lance, then easing back). */
  private readonly beamFacing: Float32Array;

  constructor(seats: number) {
    this.firePulse = new Float32Array(seats);
    this.altPulse = new Float32Array(seats);
    this.stance = new Float32Array(seats);
    this.robotAway = new Uint8Array(seats);
    this.beamFacing = new Float32Array(seats);
    this.partPoses = Array.from({ length: seats }, () => Array.from({ length: MAX_PARTS }, () => ({ hp: 0, facing: 0, flash: 0, heat: 0, charge: 0, away: false })));
    const markerGeometry = new THREE.RingGeometry(13, 14.2, 48);
    const energyArcBackGeometry = new THREE.RingGeometry(ENERGY_ARC_INNER_RADIUS, ENERGY_ARC_OUTER_RADIUS, ENERGY_ARC_SEGMENTS);
    const glowGeometry = new THREE.CircleGeometry(1, 48);
    const coreDotGeometry = new THREE.CircleGeometry(1, 28);
    const coreRingGeometry = new THREE.RingGeometry(1.1, 1.55, 28);
    const bulwarkGeometry = new THREE.RingGeometry(BULWARK_INNER_RADIUS, BULWARK_RADIUS, BULWARK_SEGMENTS, 1, -BULWARK_HALF_ARC, BULWARK_HALF_ARC * 2);
    const guardGeometry = new THREE.RingGeometry(GUARD_RADIUS * (1 - GUARD_BAND), GUARD_RADIUS, GUARD_SEGMENTS, 1, -GUARD_HALF_ARC, GUARD_HALF_ARC * 2);
    const shimmerGeometry = new THREE.PlaneGeometry(2, 2);
    for (let seat = 0; seat < seats; seat++) {
      const robot = createRobot(Frame.Vanguard);
      const mount = new THREE.Group();
      mount.scale.setScalar(ROBOT_VISUAL_SCALE);
      mount.visible = false;
      mount.add(robot.root);
      this.robots.push(robot);
      this.robotMounts.push(mount);
      this.root.add(mount);

      const bulwarkMaterial = createVectorMaterial({ fillAlpha: BULWARK_FILL_ALPHA, edgeWidth: BULWARK_EDGE_WIDTH, glow: BULWARK_GLOW });
      const bulwark = vectorMesh(bulwarkGeometry.clone(), bulwarkMaterial, BULWARK_CREASE_DEGREES);
      bulwark.position.z = 2.4;
      bulwark.renderOrder = DrawLayer.ShipOverlay;
      bulwark.visible = false;
      this.root.add(bulwark);
      this.bulwarks.push(bulwark);
      this.bulwarkMaterials.push(bulwarkMaterial);

      const guardMaterial = createVectorMaterial({ fillAlpha: GUARD_FILL_ALPHA, edgeWidth: GUARD_EDGE_WIDTH, glow: GUARD_GLOW });
      const guard = vectorMesh(guardGeometry.clone(), guardMaterial, BULWARK_CREASE_DEGREES);
      guard.position.z = 2.5;
      guard.renderOrder = DrawLayer.ShipOverlay;
      guard.visible = false;
      this.root.add(guard);
      this.guards.push(guard);
      this.guardMaterials.push(guardMaterial);

      const shimmerMaterial = new THREE.ShaderMaterial({
        vertexShader: SHIMMER_VERTEX,
        fragmentShader: SHIMMER_FRAGMENT,
        uniforms: { uTime: { value: 0 }, uOpacity: { value: 0 }, uColor: { value: SHIMMER_COLOR } },
        transparent: true,
        depthWrite: false,
      });
      const shimmer = new THREE.Mesh(shimmerGeometry.clone(), shimmerMaterial);
      shimmer.position.z = SHIMMER_Z;
      shimmer.renderOrder = DrawLayer.ShipEffects;
      shimmer.visible = false;
      this.root.add(shimmer);
      this.shimmers.push(shimmer);
      this.shimmerMaterials.push(shimmerMaterial);

      const colossus = createColossus(Frame.Vanguard);
      colossus.root.visible = false;
      this.colossi.push(colossus);
      this.root.add(colossus.root);

      const markerMaterial = createVectorMaterial({ edge: 0xffffff, fill: 0x03060c, fillAlpha: 0.0, edgeWidth: 1.25, glow: 1.45 });
      const marker = vectorMesh(markerGeometry.clone(), markerMaterial, 12);
      marker.position.z = 2;
      marker.renderOrder = DrawLayer.ShipOverlay;
      marker.visible = false;
      this.root.add(marker);
      this.markers.push(marker);
      this.markerMaterials.push(markerMaterial);

      const energyArcBackMaterial = new THREE.MeshBasicMaterial({ color: teamColor(0), transparent: true, opacity: 0, depthWrite: false });
      const energyArcBack = new THREE.Mesh(energyArcBackGeometry.clone(), energyArcBackMaterial);
      energyArcBack.position.z = ENERGY_ARC_Z - 0.02;
      energyArcBack.renderOrder = DrawLayer.ShipOverlay;
      energyArcBack.visible = false;
      this.root.add(energyArcBack);
      this.energyArcBacks.push(energyArcBack);
      this.energyArcBackMaterials.push(energyArcBackMaterial);

      const energyArcMaterial = new THREE.MeshBasicMaterial({ color: teamColor(0), transparent: true, opacity: 0, depthWrite: false });
      const energyArc = new THREE.Mesh(createEnergyArcGeometry(), energyArcMaterial);
      energyArc.position.z = ENERGY_ARC_Z;
      energyArc.renderOrder = DrawLayer.ShipOverlay;
      energyArc.visible = false;
      this.root.add(energyArc);
      this.energyArcs.push(energyArc);
      this.energyArcMaterials.push(energyArcMaterial);

      const backplateMaterial = new THREE.MeshBasicMaterial({ color: 0x00040a, transparent: true, opacity: 0, depthWrite: false });
      const backplate = new THREE.Mesh(glowGeometry.clone(), backplateMaterial);
      backplate.position.z = -0.42;
      backplate.renderOrder = DrawLayer.ShipUnderlay;
      backplate.visible = false;
      this.root.add(backplate);
      this.backplates.push(backplate);
      this.backplateMaterials.push(backplateMaterial);

      const glowMaterial = new THREE.MeshBasicMaterial({ color: teamColor(0), transparent: true, opacity: 0.08, depthWrite: false });
      const glow = new THREE.Mesh(glowGeometry.clone(), glowMaterial);
      glow.position.z = -0.35;
      glow.renderOrder = DrawLayer.ShipUnderlay;
      glow.visible = false;
      this.root.add(glow);
      this.glows.push(glow);
      this.glowMaterials.push(glowMaterial);

      const coreDotMaterial = new THREE.MeshBasicMaterial({ color: teamColor(0), transparent: true, opacity: CORE_DOT_NORMAL_OPACITY, depthWrite: false, depthTest: false });
      const coreDot = new THREE.Mesh(coreDotGeometry.clone(), coreDotMaterial);
      coreDot.position.z = 3.2;
      coreDot.renderOrder = DrawLayer.CoreDot;
      coreDot.visible = false;
      this.root.add(coreDot);
      this.coreDots.push(coreDot);
      this.coreDotMaterials.push(coreDotMaterial);

      const coreRingMaterial = new THREE.MeshBasicMaterial({ color: teamColor(0), transparent: true, opacity: 0.9, depthWrite: false, depthTest: false });
      const coreRing = new THREE.Mesh(coreRingGeometry.clone(), coreRingMaterial);
      coreRing.position.z = 3.1;
      coreRing.renderOrder = DrawLayer.CoreRing;
      coreRing.visible = false;
      this.root.add(coreRing);
      this.coreRings.push(coreRing);
      this.coreRingMaterials.push(coreRingMaterial);

      const readyAura = new THREE.Group();
      const readyAuraMaterial = createVectorMaterial({ edge: 0xffffff, fill: 0x07111a, fillAlpha: 0.0, edgeWidth: READY_AURA_EDGE_WIDTH, glow: 1.85 });
      for (let tick = 0; tick < READY_TICKS; tick++) {
        const tickGeometry = new THREE.BoxGeometry(READY_TICK_LENGTH, READY_TICK_WIDTH, 0.18);
        const mesh = vectorMesh(tickGeometry, readyAuraMaterial, 14);
        tickGeometry.dispose();
        const angle = (tick / READY_TICKS) * Math.PI * 2;
        mesh.position.set(Math.cos(angle) * READY_AURA_RADIUS, Math.sin(angle) * READY_AURA_RADIUS, READY_AURA_Z);
        mesh.rotation.z = angle + Math.PI * 0.5;
        readyAura.add(mesh);
      }
      setDrawLayer(readyAura, DrawLayer.ShipOverlay);
      readyAura.visible = false;
      this.root.add(readyAura);
      this.readyAuras.push(readyAura);
      this.readyAuraMaterials.push(readyAuraMaterial);
      this.modelFrames.push(Frame.Vanguard);
    }
    markerGeometry.dispose();
    energyArcBackGeometry.dispose();
    glowGeometry.dispose();
    coreDotGeometry.dispose();
    coreRingGeometry.dispose();
    bulwarkGeometry.dispose();
    guardGeometry.dispose();
    shimmerGeometry.dispose();
  }

  handleEvents(world: World): void {
    const events = world.events;
    for (let i = 0; i < events.count; i++) {
      const type = events.type[i];
      const seat = events.a[i];
      if (type === Ev.Fire) {
        this.firePulse[seat] = 1;
        if (events.c[i] === FireSlot.Alt) this.altPulse[seat] = 1;
      } else if (type === Ev.LanceFire || (type === Ev.BeamOn && events.c[i] === BeamKind.Primary)) {
        this.firePulse[seat] = 1;
      } else if (type === Ev.ParryUp || type === Ev.Cloak) {
        this.altPulse[seat] = 1;
      }
    }
  }

  private setTeams(snapshot: WorldSnapshot): void {
    for (let seat = 0; seat < snapshot.seats; seat++) {
      const frame = snapshot.plFrame[seat];
      const color = teamColor(snapshot.plTeam[seat]);
      if (frame !== this.modelFrames[seat]) {
        this.robotMounts[seat].remove(this.robots[seat].root);
        this.robots[seat].dispose();
        this.robots[seat] = createRobot(frame);
        this.robotMounts[seat].add(this.robots[seat].root);

        this.root.remove(this.colossi[seat].root);
        this.colossi[seat].dispose();
        this.colossi[seat] = createColossus(frame);
        this.colossi[seat].root.visible = false;
        this.root.add(this.colossi[seat].root);
        this.modelFrames[seat] = frame;
      }
      this.robots[seat].setTeam(color);
      this.colossi[seat].setTeam(color);
      this.bulwarkMaterials[seat].uniforms.uEdge.value.copy(color);
      this.bulwarkMaterials[seat].uniforms.uFill.value.copy(color).multiplyScalar(BULWARK_FILL_TINT);
      this.glowMaterials[seat].color.copy(color);
      this.coreRingMaterials[seat].color.copy(color);
      this.energyArcBackMaterials[seat].color.copy(color);
      this.readyAuraMaterials[seat].uniforms.uEdge.value.copy(color);
      this.guardMaterials[seat].uniforms.uEdge.value.copy(color);
      this.guardMaterials[seat].uniforms.uFill.value.copy(color).multiplyScalar(BULWARK_FILL_TINT);
    }
  }

  update(previous: WorldSnapshot, current: WorldSnapshot, frame: FrameContext): void {
    const { alpha, dt, focusSeat, viewerTeam, time: timeSeconds, beat } = frame;
    this.setTeams(current);
    this.findRocketFists(current);
    for (let seat = 0; seat < current.seats; seat++) {
      this.firePulse[seat] = expStep(this.firePulse[seat], 0, FIRE_DECAY, dt);
      this.altPulse[seat] = expStep(this.altPulse[seat], 0, ALT_DECAY, dt);
      this.stance[seat] = this.easeStance(current, seat, dt);
    }
    for (let seat = 0; seat < current.seats; seat++) {
      const sample = this.sample(previous, current, seat, alpha);
      const robot = this.robots[seat];
      const mount = this.robotMounts[seat];
      const bulwark = this.bulwarks[seat];
      const colossus = this.colossi[seat];
      const marker = this.markers[seat];
      const markerMaterial = this.markerMaterials[seat];
      const energyArc = this.energyArcs[seat];
      const energyArcMaterial = this.energyArcMaterials[seat];
      const energyArcBack = this.energyArcBacks[seat];
      const energyArcBackMaterial = this.energyArcBackMaterials[seat];
      const backplate = this.backplates[seat];
      const glow = this.glows[seat];
      const coreDot = this.coreDots[seat];
      const coreRing = this.coreRings[seat];
      const frame = current.plFrame[seat];
      const form = current.plForm[seat];
      const flash = clamp01(current.plFlash[seat] / FLASH_TICKS);
      const shield = clamp01(current.plInvuln[seat] / INVULN_FADE_TICKS);
      const gauge = clamp01(current.plGauge[seat] / BOSS_MIN_GAUGE);
      const speedShare = sample.speed / toWorld(FRAME_STATS[frame].speed);
      const speed = clamp01(speedShare);
      const move = Math.abs(sample.vx) + Math.abs(sample.vy) > 0.0001 ? Math.atan2(sample.vy, sample.vx) : sample.aim;
      const morph = form === Form.Morph ? 1 - current.plTimer[seat] / MORPH_TICKS : 0;
      const robotPose: RobotPose = {
        time: timeSeconds,
        aim: this.facing(previous, current, seat, alpha, dt, sample),
        move,
        speed,
        fire: this.firePulse[seat],
        alt: this.altAmount(current, seat, timeSeconds, this.altPulse[seat]),
        special: this.specialAmount(previous, current, seat, alpha),
        side: this.sideOf(current, seat),
        hit: flash,
        charge: gauge,
        shield: smoothstep(0, 1, shield),
        morph,
      };
      const robotForm = sample.alive && (form === Form.Normal || form === Form.Morph);
      const hidden = hiddenFrom(current, seat, viewerTeam);
      const showRobot = robotForm && !hidden;
      mount.visible = showRobot;
      mount.position.set(sample.x, sample.y, 0);
      if (showRobot) robot.update(robotPose);
      this.updateShimmer(seat, robotForm && hidden ? smoothstep(SHIMMER_SPEED_START, SHIMMER_SPEED_FULL, speedShare) : 0, sample, timeSeconds);
      this.updateGuard(current, seat, showRobot && frame === Frame.Ronin && current.plParry[seat] > 0, sample, timeSeconds);

      const readyAura = this.readyAuras[seat];
      const readyAuraMaterial = this.readyAuraMaterials[seat];
      const ready = current.plGauge[seat] >= BOSS_MIN_GAUGE;
      readyAura.visible = showRobot && ready;
      if (readyAura.visible) {
        const auraPulse = 1 + beat.pulse * 0.16 + beat.barPulse * 0.1;
        readyAura.position.set(sample.x, sample.y, 0);
        readyAura.rotation.z = timeSeconds * 1.9 + seat * 0.31;
        readyAura.scale.setScalar(auraPulse);
        readyAuraMaterial.uniforms.uOpacity.value = 0.68 + beat.pulse * 0.22;
        readyAuraMaterial.uniforms.uPulse.value = 0.2 + beat.pulse * 0.35;
        readyAuraMaterial.uniforms.uTime.value = timeSeconds;
        readyAuraMaterial.uniforms.uFlow.value = READY_AURA_FLOW;
        readyAuraMaterial.uniforms.uReveal.value = 1;
      }

      const showBulwark = showRobot && frame === Frame.Juggernaut && current.plBulwark[seat] > 0;
      bulwark.visible = showBulwark;
      bulwark.position.set(sample.x, sample.y, bulwark.position.z);
      bulwark.rotation.z = sample.aim;
      this.bulwarkMaterials[seat].uniforms.uOpacity.value = robotPose.alt;
      this.bulwarkMaterials[seat].uniforms.uTime.value = timeSeconds;
      this.bulwarkMaterials[seat].uniforms.uFlow.value = robotPose.alt * 0.22;

      const showColossus = sample.alive && (form === Form.Boss || form === Form.Morph);
      colossus.root.visible = showColossus;
      colossus.root.position.set(sample.x, sample.y, 0);
      if (showColossus) colossus.update(this.colossusPose(previous, current, seat, alpha, timeSeconds, sample, morph));

      backplate.visible = showRobot || showColossus;
      backplate.position.set(sample.x, sample.y, -0.42);
      backplate.scale.setScalar(showColossus ? toWorld(FORMS[frame].reach) * BACKPLATE_BOSS_SCALE : toWorld(FRAME_STATS[frame].grazeR) * BACKPLATE_ROBOT_SCALE);
      this.backplateMaterials[seat].opacity = seat === focusSeat ? BACKPLATE_FOCUS_OPACITY : BACKPLATE_OPACITY;

      glow.visible = showRobot || showColossus;
      glow.position.set(sample.x, sample.y, -0.35);
      glow.scale.setScalar(showColossus ? toWorld(FORMS[frame].reach) * 0.78 : toWorld(FRAME_STATS[frame].bodyR) * (1.35 + ROBOT_VISUAL_SCALE * 0.18));
      this.glowMaterials[seat].opacity = showColossus ? (seat === focusSeat ? 0.045 : 0.032) : (seat === focusSeat ? 0.085 : 0.055);

      marker.visible = showRobot || showColossus;
      marker.position.set(sample.x, sample.y, 1.5);
      marker.scale.setScalar(showColossus ? BOSS_MARKER_SCALE : NORMAL_MARKER_SCALE);
      markerMaterial.uniforms.uOpacity.value = seat === focusSeat ? 0.18 : 0;
      markerMaterial.uniforms.uPulse.value = seat === focusSeat ? 0.04 + 0.03 * Math.sin(timeSeconds * 3.2) : 0;
      markerMaterial.uniforms.uFlash.value = 0;
      markerMaterial.uniforms.uTime.value = timeSeconds;
      markerMaterial.uniforms.uFlow.value = seat === focusSeat ? 0.05 : 0;

      const showEnergyArc = seat === focusSeat && showRobot;
      energyArc.visible = showEnergyArc;
      energyArcBack.visible = showEnergyArc;
      if (showEnergyArc) {
        const energy = clamp01(current.plEnergy[seat] / ENERGY_MAX);
        const shieldDown = current.plShield[seat] !== 1 || current.plShieldBreak[seat] > 0;
        const cannotPay = current.plEnergy[seat] < primaryCost(frame, current.plBeam[seat]);
        const pulse = cannotPay ? 0.68 + 0.32 * Math.sin(timeSeconds * ENERGY_ARC_PULSE_HZ) : 1;
        setEnergyArcGeometry(energyArc.geometry, energy, shieldDown);
        energyArc.position.set(sample.x, sample.y, ENERGY_ARC_Z);
        energyArcBack.position.set(sample.x, sample.y, ENERGY_ARC_Z - 0.02);
        energyArcMaterial.color.setHex(cannotPay ? ENERGY_ARC_RED : energy < ENERGY_ARC_WARNING ? ENERGY_ARC_AMBER : TEAM_COLORS[current.plTeam[seat] % TEAM_COLORS.length]).convertSRGBToLinear();
        energyArcMaterial.opacity = (shieldDown ? ENERGY_ARC_DOWN_OPACITY : ENERGY_ARC_HEALTHY_OPACITY) * pulse;
        energyArcBackMaterial.opacity = ENERGY_ARC_BACK_OPACITY;
      }

      const focusGain = seat === focusSeat ? FOCUS_CORE_GAIN : 1;
      const coreRadius = showColossus
        ? toWorld(FORMS[frame].coreR) * BOSS_CORE_SCALE * focusGain
        : Math.max(MIN_CORE_VISUAL_RADIUS, toWorld(FRAME_STATS[frame].hurtR) * NORMAL_CORE_SCALE) * focusGain;
      coreDot.visible = showRobot || showColossus;
      coreRing.visible = showRobot || showColossus;
      coreDot.position.set(sample.x, sample.y, 3.2);
      coreRing.position.set(sample.x, sample.y, 3.1);
      coreDot.scale.setScalar(coreRadius);
      coreRing.scale.setScalar(coreRadius);
      if (showColossus) {
        this.coreDotMaterials[seat].color.setHex(CORE_DOT_BOSS_COLOR);
      } else {
        this.coreDotMaterials[seat].color.copy(teamColor(current.plTeam[seat])).multiplyScalar(CORE_DOT_TEAM_GAIN);
      }
      this.coreDotMaterials[seat].opacity = showColossus ? CORE_DOT_BOSS_OPACITY : seat === focusSeat ? CORE_DOT_FOCUS_OPACITY : CORE_DOT_NORMAL_OPACITY;
      this.coreRingMaterials[seat].opacity = showColossus ? CORE_RING_BOSS_OPACITY : seat === focusSeat ? CORE_RING_FOCUS_OPACITY : CORE_RING_NORMAL_OPACITY;
    }
  }

  dispose(): void {
    for (const robot of this.robots) robot.dispose();
    for (const bulwark of this.bulwarks) bulwark.geometry.dispose();
    for (const material of this.bulwarkMaterials) material.dispose();
    for (const colossus of this.colossi) colossus.dispose();
    for (const marker of this.markers) marker.geometry.dispose();
    for (const material of this.markerMaterials) material.dispose();
    for (const arc of this.energyArcs) arc.geometry.dispose();
    for (const material of this.energyArcMaterials) material.dispose();
    for (const arc of this.energyArcBacks) arc.geometry.dispose();
    for (const material of this.energyArcBackMaterials) material.dispose();
    for (const backplate of this.backplates) backplate.geometry.dispose();
    for (const material of this.backplateMaterials) material.dispose();
    for (const glow of this.glows) glow.geometry.dispose();
    for (const material of this.glowMaterials) material.dispose();
    for (const dot of this.coreDots) dot.geometry.dispose();
    for (const material of this.coreDotMaterials) material.dispose();
    for (const ring of this.coreRings) ring.geometry.dispose();
    for (const material of this.coreRingMaterials) material.dispose();
    for (const aura of this.readyAuras) for (const child of aura.children) (child as THREE.Mesh).geometry.dispose();
    for (const material of this.readyAuraMaterials) material.dispose();
    for (const guard of this.guards) guard.geometry.dispose();
    for (const material of this.guardMaterials) material.dispose();
    for (const shimmer of this.shimmers) shimmer.geometry.dispose();
    for (const material of this.shimmerMaterials) material.dispose();
  }

  /** Which robots' rocket fists are in flight this frame: returning shots a robot threw itself (pPart 0, no pod). */
  private findRocketFists(current: WorldSnapshot): void {
    this.robotAway.fill(0);
    for (let p = 0; p < current.projectiles; p++) {
      if (current.pAlive[p] !== 1 || current.pOwner[p] < 0 || current.pPart[p] !== 0 || (SHOT_DEFS[current.pDef[p]].flags & ShotFlag.Return) === 0) continue;
      this.robotAway[current.pOwner[p]] = 1;
    }
  }

  private easeStance(current: WorldSnapshot, seat: number, dt: number): number {
    const value = this.stance[seat];
    switch (current.plFrame[seat]) {
      case Frame.Ronin: {
        const up = current.plParry[seat] > 0;
        return expStep(value, up ? 1 : 0, up ? PARRY_STANCE_IN : PARRY_STANCE_OUT, dt);
      }
      case Frame.Shade:
        return expStep(value, current.plCloak[seat] > 0 ? 1 : 0, CLOAK_FADE_RATE, dt);
      default:
        return 0;
    }
  }

  /** RobotPose.special, per robot (see its definition in view/models/types.ts). */
  private specialAmount(previous: WorldSnapshot, current: WorldSnapshot, seat: number, alpha: number): number {
    const t = seatBlend(previous, current, seat, alpha);
    switch (current.plFrame[seat]) {
      case Frame.Longbow:
        return clamp01(lerp(previous.plCharge[seat], current.plCharge[seat], t) / LONGBOW.rail.full);
      case Frame.Prism: {
        const beam = current.plBeam[seat];
        if (beam === 0) return 0;
        return beam > PRISM.beam.tell ? 1 : 0.5 * beam / PRISM.beam.tell;
      }
      case Frame.Hailstorm:
        return clamp01(lerp(previous.plSpin[seat], current.plSpin[seat], t) / HAILSTORM.cannon.spinMax);
      case Frame.Ronin:
      case Frame.Shade:
        return this.stance[seat];
      case Frame.Gauntlet:
        return this.robotAway[seat];
      default:
        return 0;
    }
  }

  /** RobotPose.side: plSide is the side the NEXT alternating shot leaves from (0 left), so the latest left from the other. */
  private sideOf(current: WorldSnapshot, seat: number): number {
    switch (current.plFrame[seat]) {
      case Frame.Hailstorm:
      case Frame.Ronin:
      case Frame.Gauntlet:
        return current.plSide[seat] === 1 ? 1 : -1;
      default:
        return 0;
    }
  }

  /** What opponents see of a cloaked robot: nothing, but a faint shimmer when it moves fast. */
  private updateShimmer(seat: number, amount: number, sample: ShipRenderSample, timeSeconds: number): void {
    const shimmer = this.shimmers[seat];
    shimmer.visible = amount > 0.01;
    if (!shimmer.visible) return;
    const material = this.shimmerMaterials[seat];
    shimmer.position.set(sample.x, sample.y, SHIMMER_Z);
    shimmer.scale.setScalar(toWorld(FRAME_STATS[Frame.Shade].bodyR) * ROBOT_VISUAL_SCALE * SHIMMER_RADIUS);
    material.uniforms.uTime.value = timeSeconds + seat * 1.7;
    material.uniforms.uOpacity.value = amount * SHIMMER_OPACITY * (0.8 + 0.2 * Math.sin(timeSeconds * 23 + seat));
  }

  private updateGuard(current: WorldSnapshot, seat: number, visible: boolean, sample: ShipRenderSample, timeSeconds: number): void {
    const guard = this.guards[seat];
    guard.visible = visible;
    if (!visible) return;
    const material = this.guardMaterials[seat];
    const fade = smoothstep(0, GUARD_FADE_TICKS, current.plParry[seat]);
    guard.position.set(sample.x, sample.y, guard.position.z);
    guard.rotation.z = sample.aim;
    material.uniforms.uOpacity.value = fade;
    material.uniforms.uPulse.value = 0.3 + 0.2 * Math.sin(timeSeconds * 30);
    material.uniforms.uTime.value = timeSeconds;
    material.uniforms.uFlow.value = 0.25;
  }

  /**
   * Where a robot model faces: its aim, but PRISM turns onto its beam (which lags the aim) or its locked lance while one runs,
   * so the lens stays where the beam starts, and turns back to the aim after.
   */
  private facing(previous: WorldSnapshot, current: WorldSnapshot, seat: number, alpha: number, dt: number, sample: ShipRenderSample): number {
    const prism = current.plFrame[seat] === Frame.Prism && current.plForm[seat] === Form.Normal && !sample.epochChanged;
    if (prism && current.plLance[seat] > 0) {
      this.beamFacing[seat] = wrapAngleRadians(binaryAngleToRadians(current.plLanceAng[seat]) - sample.aim);
    } else if (prism && current.plBeam[seat] > 0) {
      const beam = previous.plBeam[seat] > 0
        ? lerpRadiansBinary(previous.plBeamAng[seat], current.plBeamAng[seat], seatBlend(previous, current, seat, alpha))
        : binaryAngleToRadians(current.plBeamAng[seat]);
      this.beamFacing[seat] = wrapAngleRadians(beam - sample.aim);
    } else {
      this.beamFacing[seat] = sample.epochChanged ? 0 : expStep(this.beamFacing[seat], 0, BEAM_FACING_RETURN, dt);
    }
    return sample.aim + this.beamFacing[seat];
  }

  private sample(previous: WorldSnapshot, current: WorldSnapshot, seat: number, alpha: number): ShipRenderSample {
    const epochChanged = seatJumped(previous, current, seat);
    const snap = seatBlend(previous, current, seat, alpha);
    const x = lerp(toWorld(previous.plX[seat]), toWorld(current.plX[seat]), snap);
    const y = lerp(toWorld(previous.plY[seat]), toWorld(current.plY[seat]), snap);
    const vx = lerp(toWorld(previous.plVX[seat]), toWorld(current.plVX[seat]), snap);
    const vy = lerp(toWorld(previous.plVY[seat]), toWorld(current.plVY[seat]), snap);
    return {
      x,
      y,
      vx,
      vy,
      aim: lerpRadiansBinary(previous.plAim[seat], current.plAim[seat], snap),
      body: lerpRadiansBinary(previous.plBody[seat], current.plBody[seat], snap),
      orbit: lerpRadiansBinary(previous.plOrbit[seat], current.plOrbit[seat], snap),
      speed: Math.hypot(vx, vy),
      alive: current.plActive[seat] === 1 && current.plAlive[seat] === 1,
      epochChanged,
    };
  }

  private colossusPose(previous: WorldSnapshot, current: WorldSnapshot, seat: number, alpha: number, timeSeconds: number, sample: ShipRenderSample, morph: number): ColossusPose {
    const frame = current.plFrame[seat];
    const form = FORMS[frame];
    const base = seat * MAX_PARTS;
    const attack = current.plAtk[seat];
    const phase = current.plAtkPhase[seat];
    const progress = this.attackProgress(current, seat);
    const partPose = this.partPoses[seat];
    for (let k = 0; k < form.parts.length; k++) {
      const part = form.parts[k];
      const hp = clamp01(current.ptHp[base + k] / part.hp);
      const away = current.ptAway[base + k] === 1;
      // An away pod takes no part in the attack: it shows no tell.
      const charge = phase === AttackPhase.Windup && this.partCharges(attack, part.roles) && hp > 0 && !away ? progress : 0;
      partPose[k].hp = hp;
      partPose[k].facing = lerpRadiansBinary(previous.ptAng[base + k], current.ptAng[base + k], sample.epochChanged ? 1 : alpha);
      partPose[k].flash = clamp01(current.ptFlash[base + k] / FLASH_TICKS);
      partPose[k].heat = clamp01(current.ptHeat[base + k] / this.heatWindow(form, attack));
      partPose[k].charge = charge;
      partPose[k].away = away;
    }
    return {
      time: timeSeconds,
      body: sample.body,
      orbit: sample.orbit,
      assemble: current.plForm[seat] === Form.Boss ? 1 : easeOutCubic(morph),
      speed: clamp01(sample.speed / toWorld(form.speed)),
      attack,
      phase,
      progress,
      fuel: clamp01(current.plGauge[seat] / GAUGE_MAX),
      hit: clamp01(current.plFlash[seat] / FLASH_TICKS),
      parts: partPose,
    };
  }

  private attackProgress(current: WorldSnapshot, seat: number): number {
    const frame = current.plFrame[seat];
    const attack = current.plAtk[seat];
    if (attack === Attack.None) return 0;
    const form = FORMS[frame];
    const timer = current.plAtkTimer[seat];
    const phase = current.plAtkPhase[seat];
    const timing = attack === Attack.Salvo ? form.salvo : attack === Attack.Siege ? form.siege : form.ultima;
    if (phase === AttackPhase.Windup) return clamp01(1 - timer / timing.windup);
    if (phase === AttackPhase.Recovery) return clamp01(1 - timer / timing.recovery);
    // Only an ultima's barrage and a beam attack last through a release phase.
    if (phase === AttackPhase.Release && attack === Attack.Ultima) return clamp01(1 - timer / form.ultima.duration);
    if (phase === AttackPhase.Release && timing.pattern === Pattern.Beam) return clamp01(1 - timer / timing.duration);
    return 1;
  }

  private altAmount(current: WorldSnapshot, seat: number, timeSeconds: number, pulse: number): number {
    switch (current.plFrame[seat]) {
      case Frame.Gale:
        return current.plDash[seat] > 0 ? 0.45 + 0.55 * Math.sin(timeSeconds * 22) * 0.5 + 0.55 : 0;
      case Frame.Juggernaut:
        return smoothstep(0, 1, clamp01(current.plBulwark[seat] / 18));
      case Frame.Prism:
        return current.plLance[seat] > 0 ? 1 - current.plLance[seat] / PRISM.lance.tell : 0;
      default:
        return pulse;
    }
  }

  private heatWindow(form: (typeof FORMS)[number], attack: number): number {
    if (attack === Attack.Siege) return form.siege.recovery;
    if (attack === Attack.Ultima) return form.ultima.recovery;
    return form.salvo.recovery;
  }

  private partCharges(attack: number, roles: number): boolean {
    if (attack === Attack.Salvo) return (roles & Role.Salvo) !== 0;
    if (attack === Attack.Siege) return (roles & Role.Siege) !== 0;
    if (attack === Attack.Ultima) return (roles & Role.Ultima) !== 0;
    return false;
  }
}
