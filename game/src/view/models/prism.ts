import * as THREE from 'three';
import { ROBOT_VISUAL_SCALE } from '../../config.ts';
import type { VectorMaterial } from '../../render/vector.ts';
import { Attack, AttackPhase, FORMS, Frame, FRAME_STATS, MUZZLE, PartKind, PRISM, Role, TICK_RATE } from '../../sim/index.ts';
import type { PartDef } from '../../sim/index.ts';
import {
  applyColossusVectorState,
  applyRobotVectorState,
  createMechKit,
  diamondGeometry,
  lineGeometry,
  merge,
  plateGeometry,
  ringGeometry,
  shapeExtrude,
  type MechKit,
} from './kit-mechs.ts';
import { clamp01, easeOutCubic, lerp, smooth01, toWorld, TWO_PI } from '../shared.ts';
import type { ColossusModel, ColossusPose, RobotModel, RobotPose } from './types.ts';

/*
 * PRISM, the beam specialist, and HELIOS, its colossus. PRISM is a tall, slender crystal lancer: a faceted gem head, narrow
 * pauldrons, a long beam rifle held two-handed along its centre line and ending in a prism lens exactly where the simulation's
 * beams and lance start (MUZZLE along the aim), and a fan of prism fins on its back. Its tells are in the model too: the lens
 * and fins wake through the beam's tell and blaze while it fires; the lance charges a focus up the barrel, ring by ring, and the
 * fins flare. HELIOS is a floating sun disk: a sunburst crown framing a forward solar cannon, halo-ring armour on either side, a
 * keel sail behind, and four crystal prisms orbiting high above the disk, every part drawn where FORMS puts its hitbox.
 */

// ---- PRISM ---------------------------------------------------------------------------------------------------------------

/** Where the beam, its tell, the lance tell and the rail start: MUZZLE along the aim, in model units (ships.ts scales models up). */
const LENS_X = toWorld(MUZZLE) / ROBOT_VISUAL_SCALE;
const RIFLE_Z = 2.75;
const CHEST_Z = 3.7;
const HEAD_Z = 5.35;
const HIP_Z = 2.2;
const FIN_ROOT = new THREE.Vector3(-1.05, 0, 4.35);
const HOVER_RATE = 2.3;
const HOVER_HEIGHT = 0.16;
const BANK_TILT = 0.15;
const LEAN = 0.05;
const RECOIL = 0.34;
const LEG_TRAIL = 0.42;
/** Fins: how far they open while the beam tells and fires, how far the lance's charge raises them, how far speed folds them back. */
const FIN_SPREAD = 0.26;
const FIN_LIFT = 0.62;
const FIN_SWEEP = 0.14;
const FOCUS_RINGS = [3.05, 3.8, 4.55] as const;
/** Seconds of lance tell: the lens pulses from LANCE_PULSE_START to LANCE_PULSE_END Hz across it, like the tell line. */
const LANCE_SECONDS = PRISM.lance.tell / TICK_RATE;
const LANCE_PULSE_START = 3;
const LANCE_PULSE_END = 16;
const SHELL_RADIUS = toWorld(FRAME_STATS[Frame.Prism].bodyR) * 0.62;
/** What is left of the accents' opacity when the robot has folded into its colossus. */
const MORPH_ACCENT_FADE = 0.22;

const GOLD = 0xffe3a0;
const CYAN = 0x86f4ff;
const MAGENTA = 0xff84e6;
const LENS_WHITE = 0xfff4d8;

type Point3 = readonly [number, number, number];

/**
 * A crystal: two pyramids joined at a diamond waist, `front` ahead of the waist along +x and `back` behind it. Every face is a
 * facet, so the vector look draws every crease.
 */
function crystalGeometry(front: number, back: number, halfWidth: number, halfHeight: number): THREE.BufferGeometry {
  const f = [front, 0, 0];
  const b = [-back, 0, 0];
  const l = [0, halfWidth, 0];
  const r = [0, -halfWidth, 0];
  const u = [0, 0, halfHeight];
  const d = [0, 0, -halfHeight];
  const faces = [f, l, u, f, u, r, f, r, d, f, d, l, b, u, l, b, r, u, b, d, r, b, l, d];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(faces.flat(), 3));
  geometry.computeVertexNormals();
  return geometry;
}

/** A hexagonal rod along +x, centred on the origin, `tip` its radius at the +x end. */
function rodGeometry(length: number, radius: number, tip = radius): THREE.BufferGeometry {
  const geometry = new THREE.CylinderGeometry(tip, radius, length, 6, 1, false);
  geometry.rotateZ(-Math.PI * 0.5);
  return geometry;
}

/** A flat four-pointed star in the floor plane (a glint), `depth` thick. */
function starGeometry(radius: number, waist: number, depth: number): THREE.BufferGeometry {
  const points: Array<[number, number]> = [];
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * TWO_PI;
    const reach = i % 2 === 0 ? radius : waist;
    points.push([Math.cos(angle) * reach, Math.sin(angle) * reach]);
  }
  return shapeExtrude(points, depth, 0);
}

function distance(from: Point3, to: Point3): number {
  return Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
}

/** Turns a mesh built along +x so that +x points from `from` to `to` (yaw, then pitch; never a roll). */
function orient(mesh: THREE.Object3D, from: Point3, to: Point3): void {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  mesh.rotation.order = 'ZYX';
  mesh.rotation.z = Math.atan2(dy, dx);
  mesh.rotation.y = -Math.atan2(to[2] - from[2], Math.hypot(dx, dy));
}

/** A crystal from `from` to `to`, its waist `waist` (0..1) of the way along. */
function crystalSpan(kit: MechKit, parent: THREE.Object3D, material: VectorMaterial, from: Point3, to: Point3, halfWidth: number, halfHeight: number, waist: number): THREE.Mesh {
  const length = distance(from, to);
  const mesh = kit.mesh(parent, kit.own(crystalGeometry(length * (1 - waist), length * waist, halfWidth, halfHeight)), material, lerp(from[0], to[0], waist), lerp(from[1], to[1], waist), lerp(from[2], to[2], waist), 36);
  orient(mesh, from, to);
  return mesh;
}

/** The same crystal as geometry already placed in its parent's space, to be merged with others of one material. */
function crystalSpanGeometry(from: Point3, to: Point3, halfWidth: number, halfHeight: number, waist: number): THREE.BufferGeometry {
  const length = distance(from, to);
  const placed = new THREE.Object3D();
  placed.position.set(lerp(from[0], to[0], waist), lerp(from[1], to[1], waist), lerp(from[2], to[2], waist));
  orient(placed, from, to);
  placed.updateMatrix();
  return crystalGeometry(length * (1 - waist), length * waist, halfWidth, halfHeight).applyMatrix4(placed.matrix);
}

/** Longest frame step a spin integrates (a hidden tab or a stalled frame must not fling it round). */
const SPIN_MAX_STEP = 0.1;

/**
 * An angle that turns at a rate that may change from frame to frame: integrated, so a changing rate changes the speed and never
 * makes the angle jump (time * rate would, and ever harder as the match clock grows).
 */
function spinner(): (time: number, rate: number) => number {
  let last = Number.NaN;
  let angle = 0;
  return (time, rate) => {
    const step = Number.isNaN(last) ? 0 : Math.min(SPIN_MAX_STEP, Math.max(0, time - last));
    last = time;
    angle = (angle + step * rate) % TWO_PI;
    return angle;
  };
}

/** A square strut from `from` to `to`. */
function strutSpan(kit: MechKit, parent: THREE.Object3D, material: VectorMaterial, from: Point3, to: Point3, width: number, height: number): THREE.Mesh {
  const mesh = kit.mesh(parent, kit.own(lineGeometry(distance(from, to), width, height)), material, (from[0] + to[0]) * 0.5, (from[1] + to[1]) * 0.5, (from[2] + to[2]) * 0.5, 40);
  orient(mesh, from, to);
  return mesh;
}

interface Fin {
  readonly pivot: THREE.Group;
  /** +1 left, -1 right. */
  readonly side: number;
  /** Angle away from straight back, radians. */
  readonly spread: number;
  readonly lift: number;
}

export function createPrism(): RobotModel {
  const kit = createMechKit();
  const root = new THREE.Group();
  const hull = new THREE.Group();
  const legRig = new THREE.Group();
  const finRig = new THREE.Group();
  const rifle = new THREE.Group();
  root.add(hull);
  hull.add(legRig, finRig, rifle);
  legRig.position.set(-0.2, 0, HIP_Z);
  finRig.position.copy(FIN_ROOT);
  rifle.position.set(0, 0, RIFLE_Z);

  const plate = kit.teamMaterial(0.46, 0.92, 1.22, 0x08131d, 0.58, 1.7);
  const facet = kit.teamMaterial(0.58, 0.84, 1.46, 0x0b1a28, 0.5, 1.6);
  const crystal = kit.teamMaterial(0.62, 0.95, 1.75, 0x0c1e2e, 0.34, 1.45);
  const gold = kit.accentMaterial(GOLD, 0x1c1406, 1.75, 0.14);
  const cyan = kit.accentMaterial(CYAN, 0x04161c, 1.7, 0.12, 1.3);
  const magenta = kit.accentMaterial(MAGENTA, 0x1a0418, 1.7, 0.12, 1.3);
  const lensGlass = kit.glassMaterial(LENS_WHITE, 0x161206);
  const flareMat = kit.accentMaterial(LENS_WHITE, 0x1c1406, 2.2, 0.2);
  const shellMat = kit.glassMaterial(0xfff0c8, 0x031018);
  const hoverMat = kit.glassMaterial(CYAN, 0x03141a);
  const ringMats = FOCUS_RINGS.map(() => kit.accentMaterial(GOLD, 0x1c1406, 1.8, 0.12, 1.4));

  // Body: a faceted chest over a narrow waist, crystal hover legs beneath.
  kit.mesh(hull, kit.own(crystalGeometry(0.9, 0.95, 0.78, 0.62)), plate, -0.25, 0, HIP_Z, 40);
  kit.mesh(hull, kit.own(crystalGeometry(2.15, 1.75, 1.42, 1.0)), plate, 0.1, 0, CHEST_Z, 40);
  kit.mesh(hull, kit.own(plateGeometry(2.5, 1.95, 0.42, 0.26)), facet, 0.2, 0, CHEST_Z + 0.86, 52).rotation.y = -0.12;
  const chestGem = kit.mesh(hull, kit.own(crystalGeometry(0.42, 0.3, 0.3, 0.26)), gold, 1.55, 0, CHEST_Z + 0.32, 30);
  chestGem.rotation.y = 0.35;

  const hovers: THREE.Mesh[] = [];
  for (const side of [-1, 1] as const) {
    const knee: Point3 = [0.42, side * 0.78, -1.05];
    crystalSpan(kit, legRig, facet, [0, side * 0.55, -0.1], knee, 0.3, 0.22, 0.5);
    crystalSpan(kit, legRig, plate, knee, [-0.3, side * 0.72, -2.0], 0.26, 0.2, 0.3);
    const hover = kit.mesh(legRig, kit.own(diamondGeometry(0.2, 0.06)), hoverMat, -0.3, side * 0.72, -2.02, 30);
    hover.rotation.x = Math.PI * 0.5;
    hovers.push(hover);
  }

  // Head: a cut gem with a gold visor and two crystal crest shards swept back.
  const head = new THREE.Group();
  head.position.set(0.5, 0, HEAD_Z);
  hull.add(head);
  kit.mesh(head, kit.own(crystalGeometry(0.78, 0.62, 0.5, 0.52)), facet, 0, 0, 0, 36);
  const visor = kit.mesh(head, kit.own(crystalGeometry(0.2, 0.08, 0.34, 0.08)), gold, 0.5, 0, 0.08, 30);
  visor.rotation.y = -0.4;
  kit.mesh(hull, kit.own(rodGeometry(0.62, 0.2)), plate, 0.38, 0, HEAD_Z - 0.62, 40).rotation.y = -Math.PI * 0.5;
  for (const side of [-1, 1] as const) crystalSpan(kit, head, crystal, [-0.25, side * 0.18, 0.34], [-1.2, side * 0.42, 1.0], 0.12, 0.08, 0.12);

  // Shoulders and arms: narrow faceted pauldrons, both arms converging on the rifle.
  for (const side of [-1, 1] as const) {
    const pauldron = kit.mesh(hull, kit.own(crystalGeometry(1.5, 1.2, 0.6, 0.36)), facet, -0.1, side * 1.85, CHEST_Z + 0.5, 38);
    pauldron.rotation.z = side * 0.26;
    pauldron.rotation.x = side * -0.34;
    const shoulder: Point3 = [0.05, side * 1.75, CHEST_Z + 0.1];
    const elbow: Point3 = [1.05, side * 1.5, CHEST_Z - 0.62];
    const grip: Point3 = side > 0 ? [2.35, 0.26, RIFLE_Z + 0.05] : [1.15, -0.26, RIFLE_Z];
    strutSpan(kit, hull, plate, shoulder, elbow, 0.4, 0.4);
    strutSpan(kit, hull, facet, elbow, grip, 0.36, 0.34);
  }

  // Rifle: stock, a hexagonal receiver with prismatic cells, a gold barrel ringed by the lance's focus coils, a fork and the lens.
  kit.mesh(rifle, kit.own(crystalGeometry(0.85, 1.25, 0.34, 0.46)), plate, -1.15, 0, -0.05, 40);
  kit.mesh(rifle, kit.own(rodGeometry(3.0, 0.46)), facet, 0.9, 0, 0, 40);
  kit.mesh(rifle, kit.own(lineGeometry(2.3, 0.16, 0.12)), gold, -0.25, 0, 0.47, 24);
  const cellL = kit.mesh(rifle, kit.own(crystalGeometry(0.42, 0.42, 0.14, 0.22)), cyan, 0.55, 0.5, 0.02, 30);
  const cellR = kit.mesh(rifle, kit.own(crystalGeometry(0.42, 0.42, 0.14, 0.22)), magenta, 0.55, -0.5, 0.02, 30);
  kit.mesh(rifle, kit.own(rodGeometry(3.1, 0.24, 0.2)), gold, 3.9, 0, 0, 34);
  const focusRings = FOCUS_RINGS.map((x, i) => {
    const ring = kit.mesh(rifle, kit.own(ringGeometry(0.42, 0.075)), ringMats[i], x, 0, 0, 30);
    ring.rotation.y = Math.PI * 0.5;
    return ring;
  });
  for (const side of [-1, 1] as const) crystalSpan(kit, rifle, facet, [4.7, side * 0.2, 0], [LENS_X - 0.05, side * 0.46, 0.02], 0.12, 0.16, 0.55);
  const lens = kit.mesh(rifle, kit.own(new THREE.OctahedronGeometry(0.4, 0)), lensGlass, LENS_X, 0, 0, 28);
  const bezel = kit.mesh(rifle, kit.own(ringGeometry(0.58, 0.06)), gold, LENS_X, 0, 0, 24);
  bezel.rotation.y = Math.PI * 0.5;
  const flare = kit.mesh(rifle, kit.own(starGeometry(0.95, 0.16, 0.06)), flareMat, LENS_X, 0, 0.1, 24);

  // Prism fins: a fan of flat crystal blades rising behind the shoulders, their tips prismatic, a short spine between them.
  const finDefs = [
    { side: 1, spread: 0.48, lift: 0.4, length: 5.2, width: 0.86, tip: cyan },
    { side: 1, spread: 1.12, lift: 0.28, length: 4.3, width: 0.72, tip: magenta },
    { side: -1, spread: 0.48, lift: 0.4, length: 5.2, width: 0.86, tip: cyan },
    { side: -1, spread: 1.12, lift: 0.28, length: 4.3, width: 0.72, tip: magenta },
  ] as const;
  const fins: Fin[] = finDefs.map((def) => {
    const pivot = new THREE.Group();
    pivot.rotation.order = 'ZYX';
    finRig.add(pivot);
    kit.mesh(pivot, kit.own(crystalGeometry(def.length * 0.62, def.length * 0.3, def.width, 0.09)), crystal, def.length * 0.3, 0, 0, 30);
    kit.mesh(pivot, kit.own(crystalGeometry(0.42, 0.24, 0.17, 0.14)), def.tip, def.length * 0.95, 0, 0, 28);
    return { pivot, side: def.side, spread: def.spread, lift: def.lift };
  });
  const spine = kit.mesh(finRig, kit.own(crystalGeometry(0.5, 1.9, 0.36, 0.3)), facet, 0.1, 0, 0, 36);
  spine.rotation.y = -0.5;

  const shell = kit.mesh(root, kit.own(ringGeometry(SHELL_RADIUS, 0.14)), shellMat, 0, 0, 0.8, 24);
  shell.visible = false;
  const lensSpin = spinner();
  const ringSpins = FOCUS_RINGS.map(() => spinner());

  return {
    root,
    setTeam(color) {
      kit.setTeam(color);
    },
    update(pose: RobotPose) {
      const morph = smooth01(pose.morph);
      const relative = pose.move - pose.aim;
      const bank = Math.sin(relative) * pose.speed;
      const drag = Math.cos(relative) * pose.speed;
      const beam = clamp01(pose.special);
      const tell = clamp01(beam * 2);
      const firing = beam >= 1 ? 1 : 0;
      const lance = clamp01(pose.alt);
      const open = smooth01(Math.max(beam, lance * 0.6));
      const raise = smooth01(lance);
      const flare01 = Math.max(open, raise);
      const t = pose.time;

      root.rotation.z = pose.aim;
      root.scale.set(1 - morph * 0.72, 1 - morph * 0.4, 1 - morph * 0.62);
      root.position.z = Math.sin(t * HOVER_RATE) * HOVER_HEIGHT;
      hull.rotation.x = bank * BANK_TILT;
      hull.rotation.y = -drag * LEAN + firing * 0.04;
      legRig.rotation.y = drag * LEG_TRAIL;
      legRig.rotation.x = -bank * LEG_TRAIL;
      for (const hover of hovers) hover.scale.setScalar(0.8 + pose.speed * 0.4);

      rifle.position.x = -pose.fire * RECOIL;
      // The lance's focus climbs the barrel one coil at a time, stock to lens.
      const coilLit = (i: number): number => clamp01(lance * FOCUS_RINGS.length - i);
      focusRings.forEach((ring, i) => {
        ring.scale.setScalar(1 + coilLit(i) * 0.34 + firing * 0.12);
        ring.rotation.x = ringSpins[i](t, 1.2 + firing * 5 + coilLit(i) * 3);
      });
      const lancePhase = TWO_PI * LANCE_SECONDS * (LANCE_PULSE_START * lance + (LANCE_PULSE_END - LANCE_PULSE_START) * 0.5 * lance * lance);
      const lancePulse = lance > 0 ? 0.5 + 0.5 * Math.sin(lancePhase) : 0;
      lens.rotation.x = lensSpin(t, 0.9 + tell * 3 + firing * 6 + lance * 4);
      lens.rotation.z = t * 0.6;
      lens.scale.setScalar(1 + tell * 0.3 + firing * 0.35 + lance * 0.3 + pose.fire * 0.35);
      const glow = Math.max(tell * 0.55, firing, lance * (0.55 + 0.45 * lancePulse), pose.fire);
      flare.visible = glow > 0.02;
      flare.scale.setScalar(0.45 + glow * 0.9);
      flare.rotation.z = t * 1.3;
      bezel.scale.setScalar(1 + glow * 0.25);
      cellL.scale.setScalar(1 + tell * 0.2 + firing * 0.2);
      cellR.scale.setScalar(1 + tell * 0.2 + firing * 0.2);

      for (const fin of fins) {
        const spread = fin.spread + open * FIN_SPREAD - pose.speed * FIN_SWEEP + Math.sin(t * 1.6 + fin.spread * 5) * 0.025;
        fin.pivot.rotation.z = Math.PI - fin.side * spread;
        fin.pivot.rotation.y = -(fin.lift + raise * FIN_LIFT + tell * 0.08);
      }

      shell.visible = pose.shield > 0.03;
      shell.scale.setScalar(1 + pose.shield * 0.08);
      shell.rotation.z = t * 0.7;

      // The shared state first (it resets every material's pulse and flow), then this robot's glows on top.
      applyRobotVectorState(kit, t, pose.hit, pose.charge, pose.shield, morph);
      const fade = lerp(1, MORPH_ACCENT_FADE, morph);
      crystal.uniforms.uPulse.value += flare01 * 0.3;
      crystal.uniforms.uFlow.value += flare01 * 0.12;
      gold.uniforms.uPulse.value += pose.fire * 0.3 + tell * 0.14 + firing * 0.3 + lance * 0.3;
      cyan.uniforms.uPulse.value += flare01 * 0.45;
      magenta.uniforms.uPulse.value += flare01 * 0.45;
      for (const material of [gold, cyan, magenta]) material.uniforms.uOpacity.value = fade;
      lensGlass.uniforms.uPulse.value += glow * 0.8;
      lensGlass.uniforms.uOpacity.value = lerp(0.55, 1, glow) * fade;
      flareMat.uniforms.uPulse.value += glow * 0.6;
      flareMat.uniforms.uOpacity.value = glow * fade;
      ringMats.forEach((material, i) => {
        material.uniforms.uPulse.value += coilLit(i) * 0.9 + tell * 0.12 + firing * 0.35;
        material.uniforms.uOpacity.value = lerp(0.5, 1, Math.max(coilLit(i), tell * 0.4, firing)) * fade;
      });
      hoverMat.uniforms.uOpacity.value = (0.2 + pose.speed * 0.6) * fade;
      shellMat.uniforms.uOpacity.value = 0.14 + pose.shield * 0.2;
    },
    dispose() {
      kit.dispose();
    },
  };
}

// ---- HELIOS --------------------------------------------------------------------------------------------------------------

const FORM = FORMS[Frame.Prism];

function partNamed(name: string): PartDef {
  const part = FORM.parts.find((candidate) => candidate.name === name);
  if (part === undefined) throw new RangeError(`HELIOS has no part named ${name}`);
  return part;
}

const CORE_RADIUS = toWorld(FORM.coreR);
/** The halo: the ring its two armour arcs ride on, through their centres. */
const HALO_RADIUS = Math.hypot(toWorld(partNamed('ringL').x), toWorld(partNamed('ringL').y));
/** The prisms' orbit, through their centres. */
const ORBIT_RADIUS = Math.hypot(toWorld(partNamed('prism1').x), toWorld(partNamed('prism1').y));
const DISK_RADIUS = HALO_RADIUS * 0.8;
const DISK_Z = 1.3;
const DAIS_Z = 3.1;
const ARMOR_Z = 3.9;
const FOCUS_Z = 5.2;
const CORE_Z = 7.4;
/** The prisms float above everything they orbit over (the crown, the cannon, the halo armour). */
const PRISM_Z = 12.5;
const FOOTPRINT_Z = 0.5;
const ASSEMBLE_STEP = 0.07;
const ASSEMBLE_LIFT = 4.2;
const ASSEMBLE_SWAY = 0.18;
const SIEGE_SINK = 1.4;
/** The solar cannon's barrel rests this far short of its muzzle and slides out to it through the siege's wind-up. */
const BARREL_REST = 4;
const BARREL_LENGTH = 12;
/** How early in the ultima's wind-up the prisms have turned outward to the wheel's spokes (share of the wind-up). */
const WHEEL_TURN_SHARE = 0.35;
/** The solar cannon's aperture petals: closed over the lens at rest, open through the siege's wind-up (radians). */
const PETAL_CLOSED = -0.45;
const PETAL_OPEN = 1.05;
const PETAL_RING = 3.4;
/** Share of a recovery over which the cannon's barrel slides back and the prisms turn back from the wheel. */
const SETTLE_SHARE = 0.35;
const PART_FLASH = 0.36;
const WEAK_HP = 0.35;
const RAY_COUNT = 8;
const CORONA_COUNT = 12;
const SECTOR_STEPS = 8;
/** The crown's band, either side of straight ahead, and its rays: angle off the axis, reach from the core, height of the tip. */
const CROWN_HALF_ARC = 0.72;
/** The halo armour arcs: radial half-depth and half-length along the halo, in part radii. */
const RING_DEPTH = 0.62;
const RING_SPAN = 0.8;
const CROWN_RAYS = [[0.21, 42, 4.6], [0.5, 38, 5.6]] as const;

/** A flat annulus sector around the core (radians, counter-clockwise), expressed around a part centred at (cx, cy). */
function sectorGeometry(inner: number, outer: number, from: number, to: number, depth: number, cx: number, cy: number): THREE.BufferGeometry {
  const points: Array<[number, number]> = [];
  for (let i = 0; i <= SECTOR_STEPS; i++) {
    const angle = lerp(from, to, i / SECTOR_STEPS);
    points.push([Math.cos(angle) * outer - cx, Math.sin(angle) * outer - cy]);
  }
  for (let i = SECTOR_STEPS; i >= 0; i--) {
    const angle = lerp(from, to, i / SECTOR_STEPS);
    points.push([Math.cos(angle) * inner - cx, Math.sin(angle) * inner - cy]);
  }
  return shapeExtrude(points, depth, 0.5);
}

function staggered(value: number, start: number): number {
  return easeOutCubic((value - start) / (1 - start));
}

/** Shortest turn from `from` to `to`, radians. */
function turnBetween(from: number, to: number): number {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

interface HeliosPart {
  readonly def: PartDef;
  readonly index: number;
  readonly anchor: THREE.Group;
  /** Its own team materials, so a hit flashes this part alone. */
  readonly shells: readonly VectorMaterial[];
  /** Pods: the swivelling weapon (a prism's crystal also turns about its own axis in `spin`), its accent and its muzzle glint. */
  readonly gun: THREE.Group | null;
  readonly spin: THREE.Group | null;
  readonly glow: VectorMaterial | null;
  readonly glint: THREE.Mesh | null;
  /** The solar cannon's sliding barrel and aperture; the prisms' tethers to the core and their hitbox rings on the floor. */
  readonly barrel: THREE.Group | null;
  readonly petals: readonly THREE.Mesh[];
  readonly tether: THREE.Mesh | null;
  readonly footprint: THREE.Mesh | null;
}

function roleOf(attack: number): number {
  return attack === Attack.Salvo ? Role.Salvo : attack === Attack.Siege ? Role.Siege : attack === Attack.Ultima ? Role.Ultima : 0;
}

export function createHelios(): ColossusModel {
  const kit = createMechKit();
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  const massMat = kit.teamMaterial(0.36, 0.8, 0.62, 0x061019, 0.56, 1.5);
  const liftMat = kit.glassMaterial(GOLD, 0x120d04);
  const thrustMat = kit.glassMaterial(LENS_WHITE, 0x161206);
  const daisMat = kit.teamMaterial(0.5, 0.9, 1.05, 0x0a1822, 0.46, 1.4);
  const coreMat = kit.accentMaterial(0xfff0c4, 0x201708, 2.1, 0.16);
  const coronaMat = kit.accentMaterial(GOLD, 0x1c1406, 1.6, 0.1, 1.3);
  const haloMat = kit.accentMaterial(GOLD, 0x1c1406, 1.25, 0.06, 1.3);
  const rayMat = kit.accentMaterial(GOLD, 0x160f04, 0.9, 0.08, 1.1);
  const orbitMat = kit.glassMaterial(GOLD, 0x120d04);
  const footprintMat = kit.glassMaterial(GOLD, 0x120d04);
  const collapseMat = kit.accentMaterial(LENS_WHITE, 0x1c1406, 1.9, 0.1, 1.4);

  const disk = kit.mesh(body, kit.own(new THREE.CylinderGeometry(DISK_RADIUS, DISK_RADIUS * 0.9, 2.6, 16).rotateX(Math.PI * 0.5)), massMat, 0, 0, DISK_Z, 20);
  const dais = kit.mesh(body, kit.own(new THREE.CylinderGeometry(DISK_RADIUS * 0.56, DISK_RADIUS * 0.66, 1.6, 12).rotateX(Math.PI * 0.5)), daisMat, 0, 0, DAIS_Z, 20);
  const rayPieces = Array.from({ length: RAY_COUNT }, (_, i) =>
    shapeExtrude([[DISK_RADIUS * 0.56, -2.2], [DISK_RADIUS * 1.12, 0], [DISK_RADIUS * 0.56, 2.2]], 0.5, 0).rotateZ(((i + 0.5) / RAY_COUNT) * TWO_PI));
  const rays = kit.mesh(body, kit.own(merge(rayPieces)), rayMat, 0, 0, DAIS_Z - 0.3, 30);
  for (const piece of rayPieces) piece.dispose();
  const halo = kit.mesh(body, kit.own(ringGeometry(HALO_RADIUS, 0.55)), haloMat, 0, 0, ARMOR_Z + 0.2, 20);
  // It floats: a faint levitation ring under the disk, brighter as it moves.
  const levitation = kit.mesh(body, kit.own(ringGeometry(DISK_RADIUS * 0.84, 0.3)), liftMat, 0, 0, 0.3, 20);
  const orbitTrack = kit.mesh(body, kit.own(ringGeometry(ORBIT_RADIUS, 0.16)), orbitMat, 0, 0, PRISM_Z - 1.6, 20);
  const collapse = kit.mesh(body, kit.own(ringGeometry(ORBIT_RADIUS * 1.3, 0.24)), collapseMat, 0, 0, CORE_Z - 1, 20);
  const core = kit.mesh(body, kit.own(new THREE.OctahedronGeometry(CORE_RADIUS, 0)), coreMat, 0, 0, CORE_Z, 28);
  const coreRing = kit.mesh(body, kit.own(ringGeometry(CORE_RADIUS * 1.35, 0.18)), orbitMat, 0, 0, CORE_Z - 1.2, 24);
  const spikes = Array.from({ length: CORONA_COUNT }, (_, i) => {
    const angle = (i / CORONA_COUNT) * TWO_PI;
    const inner = CORE_RADIUS * 1.15;
    const outer = CORE_RADIUS * (i % 2 === 0 ? 1.75 : 1.5);
    return crystalSpanGeometry([Math.cos(angle) * inner, Math.sin(angle) * inner, 0], [Math.cos(angle) * outer, Math.sin(angle) * outer, 0.9], 0.7, 0.35, 0.2);
  });
  const corona = kit.mesh(body, kit.own(merge(spikes)), coronaMat, 0, 0, CORE_Z - 1.6, 36);
  for (const spike of spikes) spike.dispose();

  const thrusters: THREE.Mesh[] = [];
  const nodes: HeliosPart[] = FORM.parts.map((def, index) => {
    const anchor = new THREE.Group();
    body.add(anchor);
    const x = toWorld(def.x);
    const y = toWorld(def.y);
    const radius = toWorld(def.rad);
    const shell = kit.teamMaterial(0.46, 0.92, 1.2, 0x07131b, 0.46, 1.55);
    const trim = kit.teamMaterial(0.6, 0.84, 1.42, 0x0b1621, 0.3, 1.35);
    const base = { def, index, anchor, shells: [shell, trim], gun: null, spin: null, glow: null, glint: null, barrel: null, petals: [], tether: null, footprint: null };
    if (def.kind === PartKind.Armor) {
      anchor.position.z = ARMOR_Z;
      if (def.name === 'crown') {
        // A sunburst tiara: a crescent band with a gold rim, four tall rays rising from it, a jewel over the cannon's root.
        const inner = CORE_RADIUS * 1.85;
        const outer = x + 2;
        kit.mesh(anchor, kit.own(sectorGeometry(inner, outer, -CROWN_HALF_ARC, CROWN_HALF_ARC, 2.4, x, y)), shell, 0, 0, 0, 40);
        kit.mesh(anchor, kit.own(sectorGeometry(outer - 1.2, outer + 0.4, -CROWN_HALF_ARC * 0.96, CROWN_HALF_ARC * 0.96, 0.8, x, y)), coronaMat, 0, 0, 1.6, 40);
        const crownRays = CROWN_RAYS.flatMap(([angle, reach, rise]) => [-1, 1].map((side) => {
          const a = side * angle;
          return crystalSpanGeometry([Math.cos(a) * (outer - 3) - x, Math.sin(a) * (outer - 3), 1.2], [Math.cos(a) * reach - x, Math.sin(a) * reach, rise], 2.1, 0.8, 0.22);
        }));
        kit.mesh(anchor, kit.own(merge(crownRays)), trim, 0, 0, 0, 36);
        for (const ray of crownRays) ray.dispose();
        kit.mesh(anchor, kit.own(crystalGeometry(3.4, 2.0, 2.0, 1.7)), coronaMat, outer + 1.5 - x, 0, 2.4, 30);
      } else if (def.name === 'ringL' || def.name === 'ringR') {
        const at = Math.atan2(y, x);
        const reachOut = HALO_RADIUS + radius * RING_DEPTH;
        const reachIn = HALO_RADIUS - radius * RING_DEPTH;
        const half = (radius * RING_SPAN) / HALO_RADIUS;
        kit.mesh(anchor, kit.own(sectorGeometry(reachIn, reachOut, at - half, at + half, 3.2, x, y)), shell, 0, 0, 0, 40);
        kit.mesh(anchor, kit.own(sectorGeometry(reachIn + 4, reachOut - 4, at - half * 0.62, at + half * 0.62, 1.4, x, y)), trim, 0, 0, 2.2, 40);
        const studs = [-1, 0, 1].map((k) => {
          const a = at + k * half * 0.66;
          return crystalGeometry(1.6, 1.6, 1.1, 1.0).rotateZ(a).translate(Math.cos(a) * HALO_RADIUS - x, Math.sin(a) * HALO_RADIUS - y, 0);
        });
        kit.mesh(anchor, kit.own(merge(studs)), coronaMat, 0, 0, 3.3, 28);
        for (const stud of studs) stud.dispose();
      } else if (def.name === 'keel') {
        kit.mesh(anchor, kit.own(shapeExtrude([[radius * 0.85, 0], [radius * 0.45, radius * 0.48], [-radius * 0.55, radius * 0.36], [-radius * 0.98, 0], [-radius * 0.55, -radius * 0.36], [radius * 0.45, -radius * 0.48]], 3, 0.5)), shell, 0, 0, 0, 40);
        kit.mesh(anchor, kit.own(shapeExtrude([[radius * 0.72, 0], [-radius * 0.9, 0], [-radius * 0.72, radius * 0.38], [radius * 0.1, radius * 0.16]], 1.1, 0.3).rotateX(Math.PI * 0.5)), trim, 0, 0, 1.6, 40);
        for (const side of [-1, 1] as const) {
          crystalSpan(kit, anchor, trim, [-radius * 0.3, side * radius * 0.3, 1.2], [-radius * 0.92, side * radius * 0.72, 2.4], 1.2, 0.35, 0.3);
          const flame = kit.mesh(anchor, kit.own(crystalGeometry(1, 0.2, 0.7, 0.5)), thrustMat, -radius * 0.78, side * radius * 0.2, 0.6, 30);
          flame.rotation.z = Math.PI;
          thrusters.push(flame);
        }
      } else {
        throw new RangeError(`HELIOS model has no armour called ${def.name}`);
      }
      return base;
    }
    const glow = kit.accentMaterial(GOLD, 0x1c1406, 1.8, 0.14, 1.45);
    const muzzle = toWorld(def.muzzle);
    const gun = new THREE.Group();
    anchor.add(gun);
    if (def.name === 'focus') {
      anchor.position.z = FOCUS_Z;
      kit.mesh(anchor, kit.own(new THREE.CylinderGeometry(radius * 0.72, radius * 0.9, 2.6, 8).rotateX(Math.PI * 0.5)), shell, 0, 0, -1.6, 30);
      kit.mesh(gun, kit.own(shapeExtrude([[-radius * 0.74, 0], [-radius * 0.44, radius * 0.5], [radius * 0.56, radius * 0.44], [radius * 0.86, 0], [radius * 0.56, -radius * 0.44], [-radius * 0.44, -radius * 0.5]], 3.6, 0.5)), shell, 0, 0, 0, 40);
      kit.mesh(gun, kit.own(rodGeometry(muzzle * 0.45, 3.4, 3.0)), trim, radius * 0.3 + muzzle * 0.225, 0, 1.4, 30);
      for (const side of [-1, 1] as const) kit.mesh(gun, kit.own(lineGeometry(radius * 0.7, 0.5, 0.3)), glow, -radius * 0.2, side * radius * 0.28, 2.1, 24);
      const barrel = new THREE.Group();
      barrel.position.set(muzzle - BARREL_REST, 0, 1.4);
      gun.add(barrel);
      kit.mesh(barrel, kit.own(rodGeometry(BARREL_LENGTH, 2.4, 2.1)), glow, -BARREL_LENGTH * 0.5, 0, 0, 30);
      const aperture = kit.mesh(barrel, kit.own(ringGeometry(3.3, 0.45)), glow, 0, 0, 0, 24);
      aperture.rotation.y = Math.PI * 0.5;
      const petals = [0, 1, 2, 3].map((k) => {
        const around = (k / 4) * TWO_PI + Math.PI * 0.25;
        const petal = kit.mesh(barrel, kit.own(crystalGeometry(2.6, 0.6, 0.9, 0.3)), trim, 0, Math.cos(around) * PETAL_RING, Math.sin(around) * PETAL_RING, 30);
        // Turned about the barrel to its slot, then splayed out from it (+y is outward before the turn).
        petal.rotation.order = 'XZY';
        petal.rotation.x = around;
        return petal;
      });
      const glint = kit.mesh(barrel, kit.own(starGeometry(4.2, 0.8, 0.3)), glow, 0.4, 0, 0.6, 24);
      return { ...base, gun, glow, glint, barrel, petals };
    }
    if (!def.name.startsWith('prism')) throw new RangeError(`HELIOS model has no pod called ${def.name}`);
    anchor.position.z = PRISM_Z;
    // The crystal turns slowly about its own long axis; its emitter tip and glint do not.
    const spin = new THREE.Group();
    gun.add(spin);
    kit.mesh(spin, kit.own(crystalGeometry(radius * 0.95, radius * 0.8, radius * 0.48, radius * 0.36)), shell, 0, 0, 0, 30);
    kit.mesh(spin, kit.own(crystalGeometry(radius * 0.55, radius * 0.45, radius * 0.2, radius * 0.56)), trim, radius * 0.1, 0, 0, 30);
    const band = kit.mesh(spin, kit.own(ringGeometry(radius * 0.46, 0.22)), trim, -radius * 0.05, 0, 0, 24);
    band.rotation.y = Math.PI * 0.5;
    kit.mesh(gun, kit.own(crystalGeometry(1.4, 0.9, 0.9, 0.9)), glow, radius * 0.92, 0, 0, 28);
    const glint = kit.mesh(gun, kit.own(starGeometry(2.6, 0.5, 0.2)), glow, muzzle, 0, 0.3, 24);
    const tether = kit.mesh(body, kit.own(lineGeometry(1, 0.34, 0.2)), orbitMat, 0, 0, 0, 40);
    const footprint = kit.mesh(anchor, kit.own(ringGeometry(radius, 0.14)), footprintMat, 0, 0, 0, 20);
    return { ...base, gun, spin, glow, glint, tether, footprint };
  });

  const haloSpin = spinner();
  const coronaSpin = spinner();
  return {
    root,
    setTeam(color) {
      kit.setTeam(color);
    },
    update(pose: ColossusPose) {
      const t = pose.time;
      const assemble = smooth01(pose.assemble);
      const windup = pose.phase === AttackPhase.Windup ? pose.progress : 0;
      const release = pose.phase === AttackPhase.Release ? 1 : 0;
      const ultimaWindup = pose.attack === Attack.Ultima ? windup : 0;
      const ultimaRelease = pose.attack === Attack.Ultima ? release : 0;
      const ultima = Math.max(ultimaWindup, ultimaRelease);
      const siegeBrace = pose.attack === Attack.Siege ? Math.max(windup, release) : 0;
      const settle = pose.phase === AttackPhase.Recovery ? 1 - smooth01(pose.progress / SETTLE_SHARE) : 0;
      const siegeSettle = pose.attack === Attack.Siege ? settle : 0;
      const wheel = pose.attack !== Attack.Ultima ? 0
        : pose.phase === AttackPhase.Windup ? smooth01(pose.progress / WHEEL_TURN_SHARE)
          : pose.phase === AttackPhase.Release ? 1 : settle;
      const firingRole = release > 0 ? roleOf(pose.attack) : 0;

      body.rotation.z = pose.body;
      body.position.z = Math.sin(t * 1.2) * 0.35 - siegeBrace * SIEGE_SINK;
      const grow = 0.35 + 0.65 * assemble;
      disk.scale.set(grow, grow, 1);
      dais.scale.set(grow, grow, 1);
      rays.scale.set(grow * (1 + ultima * 0.12), grow * (1 + ultima * 0.12), 1);
      rays.rotation.z = t * 0.05;
      halo.visible = assemble > 0.2;
      halo.scale.setScalar(grow);
      halo.rotation.z = haloSpin(t, 0.1 + ultima * 1.4);
      orbitTrack.visible = assemble > 0.3;
      orbitTrack.rotation.z = pose.orbit - pose.body;
      collapse.visible = ultimaWindup > 0.02;
      collapse.scale.setScalar(lerp(1, HALO_RADIUS / (ORBIT_RADIUS * 1.3), smooth01(ultimaWindup)));
      collapse.rotation.z = -t * 0.8;
      core.scale.setScalar(0.46 + assemble * (0.32 + pose.fuel * 0.26));
      core.rotation.z = t * 0.5;
      levitation.visible = assemble > 0.2;
      levitation.scale.setScalar(grow * (1 + Math.sin(t * 2.2) * 0.03));
      for (const flame of thrusters) flame.scale.set(1.2 + pose.speed * 3.2, 1, 1);
      coreRing.rotation.z = -t * 0.3;
      corona.rotation.z = coronaSpin(t, 0.18 + ultima * 0.9);
      corona.scale.setScalar(grow * (1 + ultima * 0.35 + siegeBrace * 0.1));

      applyColossusVectorState(kit, t, pose.hit, pose.fuel, assemble);
      for (const node of nodes) {
        const part = pose.parts[node.index];
        const ease = staggered(assemble, node.index * ASSEMBLE_STEP);
        node.anchor.visible = part.hp > 0 && ease > 0.02;
        if (node.tether !== null) node.tether.visible = node.anchor.visible;
        for (const shell of node.shells) {
          shell.uniforms.uFlash.value = Math.max(part.flash * PART_FLASH, pose.hit * 0.28);
          shell.uniforms.uPulse.value += part.hp < WEAK_HP ? 0.12 + 0.08 * Math.sin(t * 13 + node.index) : 0;
        }
        if (!node.anchor.visible) continue;
        const arc = Math.sin(ease * Math.PI);
        const px = toWorld(node.def.x) * ease;
        const py = toWorld(node.def.y) * ease;
        const sx = px - py * ASSEMBLE_SWAY * arc;
        const sy = py + px * ASSEMBLE_SWAY * arc;
        const spin = node.def.orbit ? pose.orbit - pose.body : 0;
        const x = sx * Math.cos(spin) - sy * Math.sin(spin);
        const y = sx * Math.sin(spin) + sy * Math.cos(spin);
        const lift = (1 - ease) * ASSEMBLE_LIFT + arc * ASSEMBLE_LIFT;
        const z = node.def.kind === PartKind.Armor ? ARMOR_Z : node.def.name === 'focus' ? FOCUS_Z : PRISM_Z + Math.sin(t * 1.9 + node.index * 1.7) * 0.5;
        node.anchor.position.set(x, y, z + lift);
        if (node.footprint !== null) node.footprint.position.z = FOOTPRINT_Z - (z + lift);
        if (node.gun === null || node.glow === null || node.glint === null) continue;
        const firing = (node.def.roles & firingRole) !== 0 ? 1 : 0;
        const energy = Math.max(part.charge, firing);
        node.glow.uniforms.uPulse.value += part.charge * 0.7 + firing * 0.5 + part.heat * 0.6 + ultimaWindup * 0.2;
        node.glow.uniforms.uFlash.value = part.flash * PART_FLASH;
        node.glint.visible = energy > 0.02 || part.heat > 0.05;
        node.glint.scale.setScalar(0.4 + energy * 0.9 + part.heat * 0.2);
        node.glint.rotation.z = t * 2.2;
        if (node.barrel !== null) {
          const out = smooth01(Math.max(part.charge, firing, siegeSettle));
          node.gun.rotation.z = part.facing - pose.body;
          node.barrel.position.x = toWorld(node.def.muzzle) - BARREL_REST * (1 - out);
          for (const petal of node.petals) petal.rotation.z = PETAL_CLOSED + out * PETAL_OPEN;
          continue;
        }
        const facing = part.facing - pose.body;
        const radial = Math.atan2(y, x);
        node.gun.rotation.z = facing + turnBetween(facing, radial) * wheel;
        if (node.spin !== null) node.spin.rotation.x = t * 0.7 + node.index;
        if (node.tether !== null) {
          const from: Point3 = [0, 0, CORE_Z];
          const to: Point3 = [x, y, z + lift];
          node.tether.position.set(x * 0.5, y * 0.5, (CORE_Z + z + lift) * 0.5);
          node.tether.scale.x = distance(from, to);
          orient(node.tether, from, to);
        }
      }

      massMat.uniforms.uOpacity.value = 0.72;
      liftMat.uniforms.uOpacity.value = 0.1 + pose.speed * 0.22;
      thrustMat.uniforms.uOpacity.value = 0.2 + pose.speed * 0.7;
      massMat.uniforms.uPulse.value = 0;
      massMat.uniforms.uFlash.value = pose.hit * 0.1;
      coreMat.uniforms.uPulse.value += (1 - pose.fuel) * 0.2 + ultima * 0.3;
      coronaMat.uniforms.uPulse.value += ultima * 0.4 + siegeBrace * 0.2;
      haloMat.uniforms.uPulse.value += ultima * 0.5;
      haloMat.uniforms.uOpacity.value = 0.62 + ultima * 0.38;
      rayMat.uniforms.uOpacity.value = 0.5 + ultima * 0.5;
      orbitMat.uniforms.uOpacity.value = 0.07 + ultimaWindup * 0.35 + ultimaRelease * 0.25;
      orbitMat.uniforms.uPulse.value += ultima * 0.5;
      footprintMat.uniforms.uOpacity.value = 0.1 + ultima * 0.1;
      collapseMat.uniforms.uOpacity.value = smooth01(ultimaWindup * 3) * 0.9;
    },
    dispose() {
      kit.dispose();
    },
  };
}
