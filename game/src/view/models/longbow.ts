import * as THREE from 'three';
import type { VectorMaterial } from '../../render/vector.ts';
import { Attack, AttackPhase, FORMS, FRAME_STATS, Frame, LONGBOW, PartKind, Pattern } from '../../sim/index.ts';
import type { PartDef } from '../../sim/index.ts';
import {
  applyColossusVectorState,
  applyRobotVectorState,
  barrelGeometry,
  createMechKit,
  diamondGeometry,
  finGeometry,
  lineGeometry,
  nozzleGeometry,
  plateGeometry,
  ringGeometry,
  shapeExtrude,
  wedgeGeometry,
  type MechKit,
} from './kit-mechs.ts';
import { binaryAngleToRadians, clamp01, easeOutCubic, lerp, smooth01, toWorld } from '../shared.ts';
import type { ColossusModel, ColossusPose, RobotModel, RobotPose } from './types.ts';

/*
 * LONGBOW, the sniper, and BALLISTA, its siege-bow colossus (contract: view/models/types.ts).
 *
 * LONGBOW is a long-legged tripod marksman: a narrow chassis carried high on three splayed stabiliser legs, a mono-eye scope
 * head raised on a mast, tattered cloak panels over its back, and a rail rifle about twice its body's length along the aim.
 * Its charge (RobotPose.special) lights the rifle's coils one after another from the breech to the muzzle (the larger coils
 * are the tiers: SNAP, HALF, FULL), plants the tripod wider and lower, stares the eye brighter, and puts a glint on the muzzle
 * at FULL.
 *
 * BALLISTA is a great siege bow seen from above: a long rail spine from the stock to the rail cannon, huge bow limbs swept
 * back to the lens pods at their tips, the bowstring drawn back to a nock on the stock, and twin flechette guns on the riser.
 * Every part is drawn where FORMS says it is and about as large. The siege draws the string and runs the rail's coils up; the
 * ultima bends the bow and fills the limbs and the string with light.
 */

const ICE = 0xe4fbff;
const CYAN = 0x6fe4ff;
const HEAT = 0xffbd78;
const DEEP = 0x05141d;
const UP = new THREE.Vector3(0, 0, 1);

type Point = readonly [number, number];

/** Scratch space for the per-frame maths (models update one at a time). */
const scratchA = new THREE.Vector3();
const scratchB = new THREE.Vector3();
const scratchC = new THREE.Vector3();
const scratchBasis = new THREE.Matrix4();

/**
 * Lays `object` from `from` toward `to`: its +x along the segment and its +y level with the floor, so a plate built along +x
 * from its origin shows its face to the camera above. A zero-length segment keeps the previous orientation.
 */
function lay(object: THREE.Object3D, from: THREE.Vector3, to: THREE.Vector3): number {
  scratchA.subVectors(to, from);
  const length = scratchA.length();
  object.position.copy(from);
  if (length < 1e-5) return 0;
  scratchA.divideScalar(length);
  scratchB.crossVectors(UP, scratchA);
  if (scratchB.lengthSq() < 1e-8) scratchB.set(0, 1, 0);
  else scratchB.normalize();
  scratchC.crossVectors(scratchA, scratchB);
  scratchBasis.makeBasis(scratchA, scratchB, scratchC);
  object.quaternion.setFromRotationMatrix(scratchBasis);
  return length;
}

/**
 * The knee of a two-bone leg from `hip` to `foot`, bent upward in the leg's vertical plane like a strider's (the reach is
 * clamped, so the maths never leaves its domain).
 */
function knee(hip: THREE.Vector3, foot: THREE.Vector3, upper: number, lower: number, out: THREE.Vector3): THREE.Vector3 {
  scratchA.subVectors(foot, hip);
  const reach = Math.min(upper + lower - 1e-3, Math.max(Math.abs(upper - lower) + 1e-3, scratchA.length()));
  scratchA.normalize();
  scratchB.copy(UP).addScaledVector(scratchA, -UP.dot(scratchA));
  if (scratchB.lengthSq() < 1e-8) scratchB.set(1, 0, 0);
  else scratchB.normalize();
  const cos = (upper * upper + reach * reach - lower * lower) / (2 * upper * reach);
  const sin = Math.sqrt(Math.max(0, 1 - cos * cos));
  return out.copy(hip).addScaledVector(scratchA, upper * cos).addScaledVector(scratchB, upper * sin);
}

/** A plate built along +x from its origin (for `lay`), with the kit's chamfered outline. */
function bar(length: number, width: number, depth: number, cut = 0.2): THREE.BufferGeometry {
  return plateGeometry(length, width, depth, cut).translate(length * 0.5, 0, 0);
}

/** A tapering limb segment built along +x from its origin (for `lay`): wide near its root, narrow at its end. */
function strut(length: number, root: number, end: number, depth: number): THREE.BufferGeometry {
  return shapeExtrude([
    [0, -root * 0.5],
    [length * 0.45, -root * 0.62],
    [length, -end * 0.5],
    [length, end * 0.5],
    [length * 0.45, root * 0.62],
    [0, root * 0.5],
  ], depth, 0.12);
}

/** A hexagonal collar around the x axis (a rail coil). */
function collar(radius: number, thickness: number): THREE.BufferGeometry {
  const geometry = new THREE.CylinderGeometry(radius, radius, thickness, 6, 1, true);
  geometry.rotateZ(Math.PI * 0.5);
  return geometry;
}

/** A flat hexagonal disc lying on the floor plane (a mine, a pad). */
function hexDisc(radius: number, depth: number): THREE.BufferGeometry {
  const geometry = new THREE.CylinderGeometry(radius, radius, depth, 6);
  geometry.rotateX(Math.PI * 0.5);
  return geometry;
}

/** A vertical prism (a turret base or a joint) standing on the floor plane. */
function prism(radius: number, height: number, sides: number): THREE.BufferGeometry {
  const geometry = new THREE.CylinderGeometry(radius * 0.9, radius, height, sides);
  geometry.rotateX(Math.PI * 0.5);
  return geometry;
}

/** Deterministic 0..1 noise for the cloak's ragged hems. */
function hash(value: number): number {
  const x = Math.sin(value * 12.9898 + 4.1414) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * A tattered cloth panel, hinged along x = 0 and hanging along +x: `teeth` ragged points along its hem and one rip in a side.
 */
function tatterGeometry(length: number, width: number, teeth: number, seed: number): THREE.BufferGeometry {
  const half = width * 0.5;
  const rip = 0.35 + hash(seed + 0.5) * 0.3;
  const points: [number, number][] = [
    [0, -half * 0.78],
    [length * rip, -half * 0.94],
    [length * (rip + 0.06), -half * 0.62],
    [length * (rip + 0.14), -half],
  ];
  for (let k = 0; k < teeth; k++) {
    const tip = -half + (width * (k + 0.5)) / teeth;
    points.push([length * (0.92 + hash(seed + k) * 0.1), tip]);
    if (k < teeth - 1) points.push([length * (0.8 + hash(seed + k + 7.3) * 0.08), -half + (width * (k + 1)) / teeth]);
  }
  points.push([length * 0.8, half], [0, half * 0.78]);
  return shapeExtrude(points, 0.12, 0);
}

// ---------------------------------------------------------------------------------------------------------------------
// LONGBOW
// ---------------------------------------------------------------------------------------------------------------------

const ROBOT_RADIUS = toWorld(FRAME_STATS[Frame.Longbow].bodyR);
const RAIL = LONGBOW.rail;
/** The shares of a full charge at which the rail's tiers are reached (SNAP, HALF, FULL). */
const TIER_SHARES = RAIL.tiers.map((tier) => tier.charge / RAIL.full);

const CHASSIS_Z = 5.75;
const PELVIS_Z = 5.1;
const THIGH = 5.2;
const SHIN = 7.6;
/** The tripod: hip on the chassis, foot at rest on the floor (both x, y), and the leg's share of the gait cycle. */
const LEGS: ReadonlyArray<{ readonly hip: Point; readonly foot: Point; readonly phase: number }> = [
  { hip: [1.0, 1.25], foot: [5.0, 7.9], phase: 0 },
  { hip: [1.0, -1.25], foot: [5.0, -7.9], phase: 1 / 3 },
  { hip: [-2.9, 0], foot: [-10.0, 0], phase: 2 / 3 },
];
/** How much wider the feet plant and how much lower the chassis sits once the rail is charging. */
const BRACE_SPREAD = 0.1;
const BRACE_DROP = 0.8;
/** The brace is complete at this share of the charge. */
const BRACE_SHARE = 0.55;
const STRIDE = 1.7;
const STEP_LIFT = 1.5;
/** Share of the gait cycle a foot stays planted. */
const STANCE = 0.62;
const GAIT_HZ = 1.1;
const GAIT_SPEED_HZ = 1.7;
const BANK_TILT = 0.12;

/** The rail rifle, held on the right: coils along its barrel light with the charge, one share of it each. */
const RIFLE_Y = -1.95;
const RIFLE_Z = 6.25;
const COIL_COUNT = 10;
const COIL_START = 3.9;
const COIL_STEP = 1.05;
/**
 * The drawn muzzle, along the aim from the robot's centre in model units (times the robot's visual scale in view/ships.ts for
 * world units): where the charge line and the full-charge glint belong, well past the simulation's shared MUZZLE.
 */
export const LONGBOW_MUZZLE_X = 16.1;
const MUZZLE_X = LONGBOW_MUZZLE_X;
const RECOIL = 1.1;
/** How far a shot shoves the whole chassis back on its legs. */
const KICK_SHOVE = 0.35;
const COIL_DIM_GLOW = 0.32;
const COIL_LIT_GLOW = 2.5;
const COIL_DIM_OPACITY = 0.42;
/**
 * ships.ts pulses both `fire` and `alt` when the tripmine drops (an Ev.Fire in the alt slot), decaying fire at 8/s and alt at
 * 5/s: a fire pulse no stronger than alt^(8/5) came with a mine, not from the rifle, and must not kick it.
 */
const MINE_FIRE_EXPONENT = 8 / 5;
const MINE_FIRE_MARGIN = 0.02;

/**
 * Cloak panels, hung from the back half of the chassis and trailing behind it: where each hangs from (radians around the
 * chassis from the aim), which way it falls, its length and width, and how far it droops below level.
 */
const CLOAK: ReadonlyArray<{ readonly anchor: number; readonly heading: number; readonly length: number; readonly width: number; readonly droop: number }> = [
  { anchor: 1.62, heading: 2.2, length: 3.9, width: 3.0, droop: 0.74 },
  { anchor: -1.62, heading: -2.2, length: 3.9, width: 3.0, droop: 0.74 },
  { anchor: 2.2, heading: 2.62, length: 4.6, width: 3.2, droop: 0.56 },
  { anchor: -2.2, heading: -2.62, length: 4.6, width: 3.2, droop: 0.56 },
  { anchor: 2.75, heading: 2.95, length: 5.0, width: 3.0, droop: 0.46 },
  { anchor: -2.75, heading: -2.95, length: 5.0, width: 3.0, droop: 0.46 },
  { anchor: Math.PI, heading: Math.PI, length: 5.4, width: 2.8, droop: 0.42 },
];
/**
 * Crease angles: CRISP keeps a bevelled plate's outline (its 45-degree bevel edges) for the pieces that make the silhouette
 * (chassis, legs, rifle, cloak); SOFT hides them, so the pieces on top read by their rim light and do not clutter it.
 */
const CRISP = 40;
const SOFT = 56;
const CLOAK_RX = 3.3;
const CLOAK_RY = 1.75;
const CLOAK_Z = CHASSIS_Z + 1.05;

interface LegRig {
  readonly hip: THREE.Vector2;
  readonly rest: THREE.Vector2;
  readonly phase: number;
  readonly joint: THREE.Mesh;
  readonly thigh: THREE.Mesh;
  readonly shin: THREE.Mesh;
  readonly kneeCap: THREE.Mesh;
  readonly foot: THREE.Group;
  readonly pad: THREE.Mesh;
}

interface CloakPanel {
  readonly pivot: THREE.Group;
  readonly hinge: THREE.Group;
  readonly heading: number;
  readonly droop: number;
}

export function createLongbow(): RobotModel {
  const kit = createMechKit();
  const root = new THREE.Group();
  // The chassis rides on `lift` (recoil, crouch) and banks on `tilt`, which pivots at the pelvis so the hips stay on the legs.
  const lift = new THREE.Group();
  const tilt = new THREE.Group();
  const hull = new THREE.Group();
  const legRig = new THREE.Group();
  root.add(lift, legRig);
  lift.add(tilt);
  tilt.position.z = PELVIS_Z;
  tilt.add(hull);
  hull.position.z = -PELVIS_Z;

  const hullA = kit.teamMaterial(0.46, 0.92, 1.25, 0x07121b, 0.6, 1.7);
  const hullB = kit.teamMaterial(0.64, 0.7, 1.45, 0x0a1824, 0.56, 1.6);
  const cloth = kit.teamMaterial(0.36, 0.78, 1.05, 0x040b11, 0.5, 1.35);
  const accent = kit.accentMaterial(ICE, 0x0d1c26, 1.7, 0.12);
  const conduit = kit.accentMaterial(CYAN, DEEP, 1.2, 0.1, 1.3);
  const eyeMat = kit.accentMaterial(ICE, 0x0b2230, 2.2, 0.35, 1.4);
  const glint = kit.accentMaterial(ICE, 0x16323d, 2.5, 0.4, 1.4);
  const pads = kit.accentMaterial(CYAN, DEEP, 1.1, 0.16, 1.2);
  const glass = kit.glassMaterial(CYAN, 0x031018);

  // Chassis: a narrow, pointed hull, the deck above it and the conduit that fills with the charge.
  kit.mesh(hull, kit.own(shapeExtrude([
    [-4.1, 0], [-3.3, -1.35], [-1.0, -1.85], [2.3, -1.45], [3.7, 0], [2.3, 1.45], [-1.0, 1.85], [-3.3, 1.35],
  ], 1.6, 0.34)), hullA, 0, 0, CHASSIS_Z, CRISP);
  const deck = kit.mesh(hull, kit.own(plateGeometry(4.6, 2.3, 0.9, 0.2)), hullB, 0.3, 0, CHASSIS_Z + 1.15, SOFT);
  deck.rotation.y = -0.1;
  kit.mesh(hull, kit.own(lineGeometry(3.4, 0.16, 0.08)), conduit, 0.25, 0, CHASSIS_Z + 1.66, 24);
  const cowl = kit.mesh(hull, kit.own(wedgeGeometry(2.6, 2.8, 0.8, 0.3)), hullB, -3.1, 0, CHASSIS_Z + 0.95, SOFT);
  cowl.rotation.z = Math.PI;
  const bay = kit.mesh(hull, kit.own(hexDisc(0.95, 0.34)), conduit, -1.2, 0, CHASSIS_Z - 1.05, 30);

  // The mono-eye scope head, raised on its mast.
  const head = new THREE.Group();
  head.position.set(1.25, 0, CHASSIS_Z + 1.2);
  hull.add(head);
  const mast = kit.mesh(head, kit.own(new THREE.CylinderGeometry(0.26, 0.34, 2.4, 6)), hullA, 0.1, 0, 1.2, 40);
  mast.rotation.x = Math.PI * 0.5;
  const scope = new THREE.Group();
  scope.position.set(0.4, 0, 2.55);
  head.add(scope);
  kit.mesh(scope, kit.own(nozzleGeometry(3.6, 0.62)), hullB, 0.6, 0, 0, 40);
  kit.mesh(scope, kit.own(plateGeometry(2.8, 1.5, 0.2, 0.25)), hullA, 1.2, 0, 0.72, 50);
  kit.mesh(scope, kit.own(ringGeometry(0.62, 0.12)), conduit, 2.45, 0, 0, 30).rotation.y = Math.PI * 0.5;
  kit.mesh(scope, kit.own(ringGeometry(0.46, 0.1)), hullB, -1.2, 0, 0, 30).rotation.y = Math.PI * 0.5;
  const eye = kit.mesh(scope, kit.own(new THREE.OctahedronGeometry(0.46, 0)), eyeMat, 2.55, 0, 0, 30);
  eye.scale.set(1.2, 0.9, 0.9);
  for (const side of [-1, 1] as const) {
    const fin = kit.mesh(scope, kit.own(finGeometry(2.2, 0.36, 0.12)), hullB, -1.0, side * 0.45, 0.5, 40);
    fin.rotation.z = Math.PI - side * 0.35;
    fin.rotation.x = side * 0.3;
  }

  // Shoulders and the arms that hold the rifle: the right hand on the grip, the left reaching across to the fore-end.
  for (const side of [-1, 1] as const) {
    const pauldron = kit.mesh(hull, kit.own(wedgeGeometry(2.4, 1.7, 0.9, 0.5)), hullB, -0.1, side * 2.0, CHASSIS_Z + 0.95, SOFT);
    pauldron.rotation.z = side * 0.2;
  }
  const armJoints: ReadonlyArray<readonly [Point, number, Point, number, Point, number]> = [
    [[-0.2, -2.2], 6.5, [0.3, -2.8], 5.6, [1.5, -2.0], 6.0],
    [[-0.2, 2.2], 6.5, [1.9, 1.7], 5.7, [4.2, -1.55], 6.05],
  ];
  const from = new THREE.Vector3();
  const to = new THREE.Vector3();
  for (const [shoulder, shoulderZ, elbow, elbowZ, hand, handZ] of armJoints) {
    from.set(shoulder[0], shoulder[1], shoulderZ);
    to.set(elbow[0], elbow[1], elbowZ);
    const upper = kit.mesh(hull, kit.own(bar(from.distanceTo(to), 0.56, 0.56)), hullA, 0, 0, 0, SOFT);
    lay(upper, from, to);
    from.copy(to);
    to.set(hand[0], hand[1], handZ);
    const fore = kit.mesh(hull, kit.own(bar(from.distanceTo(to), 0.66, 0.6)), hullB, 0, 0, 0, SOFT);
    lay(fore, from, to);
  }

  // The rail rifle.
  const rifle = new THREE.Group();
  rifle.position.set(0, RIFLE_Y, RIFLE_Z);
  hull.add(rifle);
  kit.mesh(rifle, kit.own(shapeExtrude([
    [-4.8, -0.35], [-4.6, -0.7], [-2.2, -0.55], [-1.2, -0.4], [-1.2, 0.4], [-2.2, 0.55], [-4.6, 0.7], [-4.8, 0.35],
  ], 0.9, 0.16)), hullB, 0, 0, 0, 50);
  kit.mesh(rifle, kit.own(plateGeometry(4.4, 1.25, 1.2, 0.18)), hullA, 0.9, 0, 0, 52);
  kit.mesh(rifle, kit.own(lineGeometry(3.0, 0.18, 0.1)), conduit, 0.9, 0, 0.66, 24);
  for (const side of [-1, 1] as const) kit.mesh(rifle, kit.own(lineGeometry(11.6, 0.26, 0.4)), hullB, 8.9, side * 0.34, 0.05, 40);
  const channel = kit.mesh(rifle, kit.own(lineGeometry(11.0, 0.12, 0.12)), accent, 8.7, 0, -0.1, 24);
  const coils: VectorMaterial[] = [];
  const tierCoils = new Set(TIER_SHARES.map((share) => Math.round(share * COIL_COUNT) - 1));
  for (let k = 0; k < COIL_COUNT; k++) {
    const tier = tierCoils.has(k);
    const material = kit.accentMaterial(CYAN, DEEP, COIL_DIM_GLOW, 0.14, tier ? 1.5 : 1.25);
    coils.push(material);
    kit.mesh(rifle, kit.own(collar(tier ? 0.8 : 0.6, tier ? 0.36 : 0.24)), material, COIL_START + k * COIL_STEP, 0, 0, 30);
  }
  kit.mesh(rifle, kit.own(plateGeometry(1.1, 1.35, 0.75, 0.25)), hullA, 14.3, 0, 0, 52);
  for (const side of [-1, 1] as const) {
    const prong = kit.mesh(rifle, kit.own(finGeometry(1.7, 0.4, 0.2)), accent, 15.3, side * 0.36, 0, 36);
    prong.rotation.z = -side * 0.08;
  }
  const star = new THREE.Group();
  star.position.set(MUZZLE_X, 0, 0.1);
  rifle.add(star);
  for (const turn of [0, Math.PI * 0.5]) {
    const ray = kit.mesh(star, kit.own(diamondGeometry(1, 0.08)), glint, 0, 0, 0, 30);
    ray.scale.set(1.9, 0.2, 1);
    ray.rotation.z = turn;
  }
  kit.mesh(star, kit.own(new THREE.OctahedronGeometry(0.34, 0)), glint, 0, 0, 0, 30);
  const flash = kit.mesh(rifle, kit.own(diamondGeometry(1, 0.1)), glint, MUZZLE_X + 1.6, 0, 0.1, 30);
  flash.scale.set(3.6, 0.5, 1);

  // The tripod.
  const legs: LegRig[] = LEGS.map((spec) => {
    const hip = new THREE.Vector2(spec.hip[0], spec.hip[1]);
    const rest = new THREE.Vector2(spec.foot[0], spec.foot[1]);
    const joint = kit.mesh(legRig, kit.own(prism(0.62, 0.9, 6)), hullB, 0, 0, 0, 40);
    const thigh = kit.mesh(legRig, kit.own(strut(THIGH, 1.15, 0.8, 0.62)), hullA, 0, 0, 0, 44);
    const shin = kit.mesh(legRig, kit.own(strut(SHIN, 0.95, 0.28, 0.5)), hullB, 0, 0, 0, 44);
    const kneeCap = kit.mesh(legRig, kit.own(new THREE.OctahedronGeometry(0.62, 0)), hullB, 0, 0, 0, 30);
    kneeCap.scale.set(1, 1, 0.8);
    const foot = new THREE.Group();
    foot.rotation.z = Math.atan2(rest.y - hip.y, rest.x - hip.x);
    legRig.add(foot);
    kit.mesh(foot, kit.own(shapeExtrude([[-0.7, 0], [0.2, -0.75], [1.5, 0], [0.2, 0.75]], 0.24, 0.08)), hullA, 0, 0, 0.12, 40);
    const pad = kit.mesh(foot, kit.own(hexDisc(0.42, 0.12)), pads, 0.15, 0, 0.36, 24);
    return { hip, rest, phase: spec.phase, joint, thigh, shin, kneeCap, foot, pad };
  });

  // The cloak: ragged panels over the back and the flanks, split behind for the rear leg.
  const cloak: CloakPanel[] = CLOAK.map((spec, index) => {
    const pivot = new THREE.Group();
    pivot.position.set(Math.cos(spec.anchor) * CLOAK_RX, Math.sin(spec.anchor) * CLOAK_RY, CLOAK_Z - index * 0.04);
    pivot.rotation.z = spec.heading;
    hull.add(pivot);
    const hinge = new THREE.Group();
    pivot.add(hinge);
    kit.mesh(hinge, kit.own(tatterGeometry(spec.length, spec.width, 3, index * 3.1)), cloth, 0, 0, 0, CRISP);
    return { pivot, hinge, heading: spec.heading, droop: spec.droop };
  });

  const mine = kit.mesh(root, kit.own(hexDisc(0.95, 0.36)), glint, -1.2, 0, 0.3, 30);
  mine.visible = false;
  const shellRing = kit.mesh(root, kit.own(ringGeometry(ROBOT_RADIUS * 1.12, 0.16)), glass, 0, 0, 5.2, 24);
  shellRing.visible = false;

  const hipAt = new THREE.Vector3();
  const footAt = new THREE.Vector3();
  const kneeAt = new THREE.Vector3();
  let lastTime = Number.NaN;
  let gait = 0;

  return {
    root,
    setTeam(color) {
      kit.setTeam(color);
    },
    update(pose: RobotPose) {
      const dt = Number.isNaN(lastTime) ? 0 : Math.min(0.1, Math.max(0, pose.time - lastTime));
      lastTime = pose.time;
      const morph = smooth01(pose.morph);
      const charge = clamp01(pose.special);
      const brace = smooth01(charge / BRACE_SHARE) * (1 - morph);
      const full = charge >= 1 ? 1 : 0;
      const kick = pose.fire > Math.pow(pose.alt, MINE_FIRE_EXPONENT) + MINE_FIRE_MARGIN ? pose.fire : 0;
      const travel = pose.move - pose.aim;
      const bank = Math.sin(travel) * pose.speed;
      gait = (gait + dt * (GAIT_HZ + GAIT_SPEED_HZ * pose.speed)) % 1;

      root.rotation.z = pose.aim;
      root.scale.set(1 - morph * 0.72, 1 - morph * 0.5, 1 - morph * 0.55);
      const bob = Math.sin(gait * Math.PI * 6) * 0.14 * pose.speed + Math.sin(pose.time * 2.4) * 0.08;
      const drop = brace * BRACE_DROP + morph * 1.6 - bob;
      const shove = kick * KICK_SHOVE;
      lift.position.set(-shove, 0, -drop);
      tilt.rotation.x = bank * BANK_TILT;
      tilt.rotation.y = -Math.cos(travel) * pose.speed * 0.05 + kick * 0.04;

      // Legs: planted feet that step along the travel, spread by the brace and folded in by the morph.
      const stride = STRIDE * pose.speed * (1 - brace * 0.6);
      const step = STEP_LIFT * Math.min(1, pose.speed * 1.4);
      const travelX = Math.cos(travel);
      const travelY = Math.sin(travel);
      for (const leg of legs) {
        const cycle = (gait + leg.phase) % 1;
        let offset: number;
        let up = 0;
        if (cycle < STANCE) offset = lerp(1, -1, cycle / STANCE);
        else {
          const swing = (cycle - STANCE) / (1 - STANCE);
          offset = lerp(-1, 1, smooth01(swing));
          up = Math.sin(swing * Math.PI) * step;
        }
        const spread = 1 + brace * BRACE_SPREAD;
        const fold = morph * 0.75;
        hipAt.set(leg.hip.x - shove, leg.hip.y, PELVIS_Z - drop);
        footAt.set(
          lerp(leg.rest.x * spread, leg.hip.x, fold) + travelX * offset * stride,
          lerp(leg.rest.y * spread, leg.hip.y, fold) + travelY * offset * stride,
          up + morph * 2.4,
        );
        knee(hipAt, footAt, THIGH, SHIN, kneeAt);
        leg.joint.position.copy(hipAt);
        lay(leg.thigh, hipAt, kneeAt);
        lay(leg.shin, kneeAt, footAt);
        leg.kneeCap.position.copy(kneeAt);
        leg.foot.position.copy(footAt);
        leg.pad.scale.setScalar(1 + brace * 0.5);
      }

      // Rifle: recoil, the coils filling from the breech, the glint at FULL; folded away by the morph.
      rifle.position.x = -kick * RECOIL - morph * 4;
      rifle.scale.set(1 - morph * 0.65, 1, 1);
      for (let k = 0; k < COIL_COUNT; k++) {
        const lit = clamp01(charge * COIL_COUNT - k);
        const hum = full > 0 ? 0.82 + 0.3 * Math.sin(pose.time * 16 - k * 0.7) : 1;
        coils[k].uniforms.uGlow.value = lerp(COIL_DIM_GLOW, COIL_LIT_GLOW, lit) * hum;
        coils[k].uniforms.uOpacity.value = lerp(COIL_DIM_OPACITY, 1, lit) * (1 - morph * 0.8);
      }
      star.visible = full > 0 && morph < 0.5;
      star.rotation.z = pose.time * 1.3;
      star.scale.setScalar(0.85 + 0.35 * Math.sin(pose.time * 9.5));
      flash.visible = kick > 0.03;
      flash.scale.set(3.6 * (0.6 + kick), 0.5 * (0.5 + kick), 1);
      channel.scale.set(1, 1 + charge * 0.8, 1 + charge * 0.8);

      // The mine drops from the belly bay to the floor.
      mine.visible = pose.alt > 0.05 && morph < 0.5;
      mine.position.z = lerp(0.3, CHASSIS_Z - 1.1 - drop, pose.alt * pose.alt);
      bay.scale.setScalar(1 + pose.alt * 0.3);

      // Cloak: a slow flutter, lifted and swept back by travel, jolted by hits.
      for (let i = 0; i < cloak.length; i++) {
        const panel = cloak[i];
        const trailing = Math.max(0, -Math.cos(panel.heading - travel)) * pose.speed;
        const flutter = Math.sin(pose.time * 3.1 + i * 1.7) * (0.05 + pose.speed * 0.06) + Math.sin(pose.time * 23 + i) * pose.hit * 0.08;
        panel.hinge.rotation.y = (panel.droop - trailing * 0.4 + flutter + brace * 0.12) * (1 - morph) - morph * 0.9;
        panel.pivot.rotation.z = panel.heading - Math.sin(panel.heading - travel) * pose.speed * 0.22;
      }

      shellRing.visible = pose.shield > 0.03;
      shellRing.scale.setScalar(1 + pose.shield * 0.06);
      shellRing.rotation.z = pose.time * 0.7;

      applyRobotVectorState(kit, pose.time, pose.hit, pose.charge, pose.shield, morph);
      const fade = lerp(1, 0.2, morph);
      accent.uniforms.uOpacity.value = 0.85 * fade;
      accent.uniforms.uPulse.value += charge * 0.25 + kick * 0.3;
      conduit.uniforms.uGlow.value = 0.9 + charge * 1.9;
      conduit.uniforms.uOpacity.value = (0.55 + charge * 0.45) * fade;
      conduit.uniforms.uPulse.value += pose.alt * 0.4;
      eyeMat.uniforms.uGlow.value = 2.1 + charge * 1.4 + full * 0.5 * Math.sin(pose.time * 11);
      eyeMat.uniforms.uOpacity.value = fade;
      glint.uniforms.uOpacity.value = fade;
      glint.uniforms.uPulse.value += full * 0.4 + kick * 0.6;
      pads.uniforms.uGlow.value = 0.9 + brace * 1.6;
      pads.uniforms.uOpacity.value = 0.6 * fade;
      glass.uniforms.uOpacity.value = 0.18 + pose.shield * 0.2;
    },
    dispose() {
      kit.dispose();
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// BALLISTA
// ---------------------------------------------------------------------------------------------------------------------

const FORM = FORMS[Frame.Longbow];
const CORE_RADIUS = toWorld(FORM.coreR);

function partIndex(name: string): number {
  const index = FORM.parts.findIndex((part) => part.name === name);
  if (index < 0) throw new RangeError(`BALLISTA has no part "${name}"`);
  return index;
}

const SHROUD = partIndex('shroud');
const LIMB_L = partIndex('limbL');
const LIMB_R = partIndex('limbR');
const STOCK = partIndex('stock');
const RAIL_POD = partIndex('rail');
const GUN_L = partIndex('gunL');
const GUN_R = partIndex('gunR');
const LENS_L = partIndex('lensL');
const LENS_R = partIndex('lensR');

const ULTIMA = FORM.ultima;
if (ULTIMA.pattern !== Pattern.Bombard) throw new RangeError('BALLISTA\'s model times its lens flashes to a bombardment ultima');
/** Ticks between the arrow-rain volleys, and the ticks the barrage lasts: the lenses flash on every volley. */
const VOLLEY_EVERY = ULTIMA.every;
const BARRAGE_TICKS = ULTIMA.duration;
const SALVO_SPREAD = FORM.salvo.pattern === Pattern.Volley ? FORM.salvo.spread : 0;
const FLECHETTES = FORM.salvo.pattern === Pattern.Volley ? FORM.salvo.count : 1;

const CORE_Z = 5.8;
const SPINE_Z = 2.4;
const STRING_Z = 4.6;
/** Where the bowstring's nock rests on the stock (x, body space), how far back the siege draws it, how deep the ultima bends it. */
const NOCK_X = -30;
const SIEGE_DRAW = 13;
const ULTIMA_DRAW = 7;
const LENSES = [LENS_L, LENS_R] as const;
const RAIL_COILS = 9;
/** Tells and recoil, world units and radians: the rail slides out and is thrown back, the flechette guns likewise. */
const RAIL_EXTEND = 4;
const RAIL_KICK = 5;
const GUN_EXTEND = 2.2;
const GUN_KICK = 1.8;
const LENS_OPEN = 0.22;
const LIMB_BEND = 0.06;
const LIMB_DRAW = 0.035;
const LIMB_QUIVER = 0.03;
const STRING_QUIVER = 2.4;
/** Length of a thruster flare at full speed. */
const THRUST_LENGTH = 3.2;
/** How fast a lens's flash fades after each arrow-rain volley (per tick). */
const VOLLEY_FADE = 0.3;
const ASSEMBLE_STEP = 0.07;
const ASSEMBLE_LIFT = 5;
const ASSEMBLE_ARC = 4.2;
const ASSEMBLE_SWAY = 0.16;
const PART_FLASH = 0.36;
const WEAK_HP = 0.35;
/** Crease angle that keeps a bevelled plate's outline (its 45-degree bevel edges): the silhouette pieces read crisp. */
const SHARP = 40;

interface BallistaPart {
  readonly index: number;
  readonly def: PartDef;
  readonly home: THREE.Vector3;
  readonly anchor: THREE.Group;
  /** Pods: the turret that follows PartPose.facing, and its weapon (hidden while `away`). */
  readonly turret: THREE.Group | null;
  readonly weapon: THREE.Group | null;
  readonly hull: readonly VectorMaterial[];
  /** The part's own light: coils, lens, energy line (the tell). */
  readonly glow: VectorMaterial;
  /** Pods only: heat vents, glowing while the pod is hot (and vulnerable) after firing. Armour never fires, so never heats. */
  readonly vent: VectorMaterial | null;
  readonly strut: THREE.Mesh;
  readonly strutMat: VectorMaterial;
  /** The rail pod's coils, lit one after another by its tell (empty for every other part). */
  readonly coils: readonly VectorMaterial[];
}

function stagger(assemble: number, index: number): number {
  const start = index * ASSEMBLE_STEP;
  return easeOutCubic((assemble - start) / (1 - start));
}

/** Samples a quadratic Bezier limb centreline into a tapering outline (root width to tip width), relative to `center`. */
function limbOutline(p0: Point, p1: Point, p2: Point, root: number, tip: number, center: Point, side: number): Point[] {
  const steps = 10;
  const left: Point[] = [];
  const right: Point[] = [];
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const u = 1 - t;
    const x = u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0];
    const y = u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1];
    const tx = 2 * u * (p1[0] - p0[0]) + 2 * t * (p2[0] - p1[0]);
    const ty = 2 * u * (p1[1] - p0[1]) + 2 * t * (p2[1] - p1[1]);
    const length = Math.hypot(tx, ty);
    const nx = -ty / length;
    const ny = tx / length;
    const half = lerp(root, tip, t) * 0.5;
    left.push([x + nx * half - center[0], (y + ny * half) * side - center[1] * side]);
    right.push([x - nx * half - center[0], (y - ny * half) * side - center[1] * side]);
  }
  return [...left, ...right.reverse()];
}

export function createBallista(): ColossusModel {
  const kit = createMechKit();
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  const massMat = kit.teamMaterial(0.3, 0.72, 0.42, 0x03080c, 0.4, 1.45);
  const frameMat = kit.teamMaterial(0.44, 0.8, 0.85, 0x061019, 0.3, 1.35);
  const coreMat = kit.accentMaterial(ICE, 0x10222c, 1.4, 0.16, 1.4);
  const haloMat = kit.glassMaterial(CYAN, 0x031117);
  const stringMat = kit.accentMaterial(ICE, 0x0b1c24, 1.6, 0.3, 1.3);
  const engineMat = kit.accentMaterial(CYAN, DEEP, 1.2, 0.16, 1.3);
  const collapseMat = kit.accentMaterial(CYAN, DEEP, 1.6, 0.06, 1.2);

  // The frame under the parts: a keel along the spine, the riser across it, the spine's twin rails and their ties.
  kit.mesh(body, kit.own(shapeExtrude([
    [-58, -7], [-40, -12], [-10, -12], [6, -30], [14, -28], [16, -10], [46, -7], [52, 0], [46, 7], [16, 10], [14, 28], [6, 30], [-10, 12], [-40, 12], [-58, 7],
  ], 2.6, 0.5)), massMat, 0, 0, 0.6, 70);
  for (const side of [-1, 1] as const) kit.mesh(body, kit.own(lineGeometry(104, 1.2, 1.1)), frameMat, -4, side * 2.6, SPINE_Z, 50);
  // Built in place (not moved there) so the assembly's radial reveal lays them out from the core with the rails.
  for (let x = -50; x <= 42; x += 11.5) kit.mesh(body, kit.own(lineGeometry(1.1, 7.2, 0.7).translate(x, 0, 0)), frameMat, 0, 0, SPINE_Z + 0.3, 50);
  kit.mesh(body, kit.own(plateGeometry(7, 58, 1.2, 0.1)), frameMat, 8, 0, SPINE_Z + 0.4, 50);

  const core = kit.mesh(body, kit.own(new THREE.OctahedronGeometry(CORE_RADIUS * 0.9, 0)), coreMat, 0, 0, CORE_Z, 28);
  const cradle = kit.mesh(body, kit.own(ringGeometry(CORE_RADIUS * 1.35, 0.5)), frameMat, 0, 0, CORE_Z - 1.4, 40);
  const halo = kit.mesh(body, kit.own(ringGeometry(CORE_RADIUS * 1.6, 0.16)), haloMat, 0, 0, CORE_Z + 0.4, 28);
  const collapse = kit.mesh(body, kit.own(ringGeometry(CORE_RADIUS * 2.6, 0.22)), collapseMat, 0, 0, CORE_Z + 0.6, 28);
  collapse.visible = false;

  // The bowstring: from each lens pod to the nock.
  const strings = [LENS_L, LENS_R].map(() => kit.mesh(body, kit.own(lineGeometry(1, 0.55, 0.4).translate(0.5, 0, 0)), stringMat, 0, 0, STRING_Z, 30));
  const nock = kit.mesh(body, kit.own(diamondGeometry(1.6, 0.8)), stringMat, NOCK_X, 0, STRING_Z + 0.2, 30);

  let flares: readonly THREE.Mesh[] = [];
  const parts: BallistaPart[] = FORM.parts.map((def, index) => {
    const anchor = new THREE.Group();
    body.add(anchor);
    const radius = toWorld(def.rad);
    const hullA = kit.teamMaterial(0.46, 0.9, 1.2, 0x07121b, 0.44);
    const hullB = kit.teamMaterial(0.62, 0.7, 1.4, 0x0a1722, 0.3, 1.35);
    const glow = kit.accentMaterial(CYAN, DEEP, 1.1, 0.14, 1.35);
    const vent = def.kind === PartKind.Pod ? kit.accentMaterial(HEAT, 0x1d1004, 0.9, 0.12, 1.2) : null;
    const strutMat = kit.glassMaterial(CYAN, 0x031117);
    const strutMesh = kit.mesh(body, kit.own(lineGeometry(1, 0.5, 0.2).translate(0.5, 0, 0)), strutMat, 0, 0, SPINE_Z + 1.2, 56);
    strutMesh.visible = false;
    const home = new THREE.Vector3(toWorld(def.x), toWorld(def.y), def.kind === PartKind.Pod ? 5.2 : 3.2);
    let turret: THREE.Group | null = null;
    let weapon: THREE.Group | null = null;
    const coils: VectorMaterial[] = [];
    switch (index) {
      case SHROUD:
        buildShroud(kit, anchor, hullA, hullB, glow);
        break;
      case LIMB_L:
      case LIMB_R:
        buildLimb(kit, anchor, def, hullA, hullB, glow, index === LIMB_L ? 1 : -1);
        break;
      case STOCK:
        flares = buildStock(kit, anchor, hullA, hullB, glow, engineMat);
        break;
      default: {
        if (vent === null) throw new RangeError(`BALLISTA part ${def.name} is drawn as a pod but is not one`);
        turret = new THREE.Group();
        anchor.add(turret);
        weapon = new THREE.Group();
        turret.add(weapon);
        if (index === RAIL_POD) buildRail(kit, turret, weapon, def, hullA, hullB, glow, vent, coils);
        else if (index === GUN_L || index === GUN_R) buildGun(kit, turret, weapon, def, hullA, hullB, glow, vent);
        else buildLens(kit, turret, weapon, def, hullA, hullB, glow, vent);
      }
    }
    if (radius <= 0) throw new RangeError(`BALLISTA part ${def.name} has no radius`);
    return { index, def, home, anchor, turret, weapon, hull: [hullA, hullB], glow, vent, strut: strutMesh, strutMat, coils };
  });

  const nockAt = new THREE.Vector3();
  const tipAt = new THREE.Vector3();

  return {
    root,
    setTeam(color) {
      kit.setTeam(color);
    },
    update(pose: ColossusPose) {
      const assemble = smooth01(pose.assemble);
      const windup = pose.phase === AttackPhase.Windup;
      const recovery = pose.phase === AttackPhase.Recovery;
      const siegeDraw = pose.attack === Attack.Siege && windup ? smooth01(pose.progress) : 0;
      const siegeSnap = pose.attack === Attack.Siege && recovery ? 1 - pose.progress : 0;
      const ultimaWindup = pose.attack === Attack.Ultima && windup ? smooth01(pose.progress) : 0;
      const barrage = pose.attack === Attack.Ultima && pose.phase === AttackPhase.Release ? 1 : 0;
      const relax = pose.attack === Attack.Ultima && recovery ? 1 - smooth01(pose.progress) : 0;
      const bend = Math.max(ultimaWindup, barrage, relax);
      // The barrage's tick count so far (the simulation fires a volley on its first tick and every VOLLEY_EVERY after).
      const since = (Math.round(pose.progress * BARRAGE_TICKS) + VOLLEY_EVERY - 1) % VOLLEY_EVERY;
      const volley = barrage > 0 ? Math.exp(-since * VOLLEY_FADE) : 0;

      body.rotation.z = pose.body;
      body.position.z = Math.sin(pose.time * 1.05) * 0.18 - siegeDraw * 1.2 - bend * 0.6;
      applyColossusVectorState(kit, pose.time, pose.hit, pose.fuel, assemble);

      const coreScale = 0.42 + assemble * (0.3 + pose.fuel * 0.28);
      core.scale.set(coreScale, coreScale, coreScale * 0.62);
      core.rotation.z = pose.time * 0.5;
      cradle.scale.setScalar(0.7 + assemble * 0.3);
      halo.visible = assemble > 0.08;
      halo.rotation.z = -pose.time * 0.2;
      halo.scale.setScalar(0.8 + assemble * 0.2 + bend * 0.12);
      collapse.visible = ultimaWindup > 0.01;
      collapse.scale.setScalar(lerp(2.2, 0.9, ultimaWindup));
      collapse.rotation.z = pose.time * 0.6;

      for (const part of parts) {
        const partPose = pose.parts[part.index];
        const ease = stagger(assemble, part.index);
        const shown = partPose.hp > 0 && ease > 0.02;
        const tell = partPose.charge;
        const energy = Math.max(tell, part.def.kind === PartKind.Pod ? bend : 0);
        part.anchor.visible = shown;
        part.strut.visible = shown && energy > 0.01;
        if (!shown) continue;
        const arc = Math.sin(ease * Math.PI);
        const x = part.home.x * ease - part.home.y * ASSEMBLE_SWAY * arc;
        const y = part.home.y * ease + part.home.x * ASSEMBLE_SWAY * arc;
        part.anchor.position.set(x, y, lerp(ASSEMBLE_LIFT, part.home.z, ease) + arc * ASSEMBLE_ARC);
        part.anchor.scale.setScalar(0.4 + ease * 0.6);
        part.strut.scale.set(Math.max(0.01, Math.hypot(x, y)), 1, 1);
        part.strut.rotation.z = Math.atan2(y, x);
        part.strutMat.uniforms.uOpacity.value = energy * 0.6;
        part.strutMat.uniforms.uPulse.value = energy * 0.5;

        const flash = Math.max(partPose.flash * PART_FLASH, pose.hit * 0.2);
        const weak = partPose.hp < WEAK_HP ? 0.12 + 0.08 * Math.sin(pose.time * 13 + part.index) : 0;
        for (const material of part.hull) {
          material.uniforms.uFlash.value = flash;
          material.uniforms.uPulse.value += weak;
        }
        if (part.vent !== null) {
          part.vent.uniforms.uGlow.value = 0.5 + partPose.heat * 2.6;
          part.vent.uniforms.uOpacity.value = 0.3 + partPose.heat * 0.7;
          part.vent.uniforms.uFlash.value = flash;
        }
        part.glow.uniforms.uGlow.value = 1.1 + tell * 2 + volley * 1.6;
        part.glow.uniforms.uFlash.value = flash;

        if (part.turret !== null && part.weapon !== null) {
          part.turret.rotation.z = partPose.facing - pose.body;
          part.weapon.visible = !partPose.away;
        }
        switch (part.index) {
          case RAIL_POD:
            part.weapon!.position.x = tell * RAIL_EXTEND - siegeSnap * RAIL_KICK;
            for (let k = 0; k < part.coils.length; k++) {
              const lit = clamp01(tell * part.coils.length - k);
              part.coils[k].uniforms.uGlow.value = lerp(0.3, 2.8, lit) + barrage * 0.8 * (0.5 + 0.5 * Math.sin(pose.time * 12 - k));
              part.coils[k].uniforms.uOpacity.value = lerp(0.4, 1, lit);
              part.coils[k].uniforms.uFlash.value = flash;
            }
            break;
          case LIMB_L:
          case LIMB_R: {
            const side = part.index === LIMB_L ? 1 : -1;
            part.anchor.rotation.z = side * (bend * LIMB_BEND + siegeDraw * LIMB_DRAW - siegeSnap * LIMB_QUIVER * Math.sin(pose.progress * 18));
            part.glow.uniforms.uGlow.value = 0.8 + bend * 2.2 + siegeDraw * 0.6 + volley * 1.2;
            break;
          }
          case LENS_L:
          case LENS_R:
            part.weapon!.scale.setScalar(1 + Math.max(tell, barrage * (0.75 + volley * 0.25)) * LENS_OPEN);
            break;
          case GUN_L:
          case GUN_R:
            part.weapon!.position.x = tell * GUN_EXTEND - partPose.heat * partPose.heat * GUN_KICK;
            break;
          default:
        }
      }

      // The string, from each live lens pod to the nock: drawn back by the siege (and quivering after the shot), bent deeper
      // by the ultima.
      const quiver = siegeSnap * siegeSnap * Math.sin(pose.progress * 22) * STRING_QUIVER;
      nockAt.set(lerp(0, NOCK_X - siegeDraw * SIEGE_DRAW - bend * ULTIMA_DRAW + quiver, assemble), 0, STRING_Z);
      nock.position.copy(nockAt);
      nock.visible = assemble > 0.2 && pose.parts[STOCK].hp > 0;
      for (let i = 0; i < LENSES.length; i++) {
        const lens = parts[LENSES[i]];
        const string = strings[i];
        string.visible = lens.anchor.visible && assemble > 0.2;
        if (!string.visible) continue;
        tipAt.set(lens.anchor.position.x, lens.anchor.position.y, STRING_Z);
        string.position.copy(nockAt);
        string.scale.set(Math.max(0.01, nockAt.distanceTo(tipAt)), 1 + bend * 0.4, 1);
        string.rotation.z = Math.atan2(tipAt.y - nockAt.y, tipAt.x - nockAt.x);
      }

      for (const flare of flares) {
        flare.visible = pose.speed > 0.02;
        flare.scale.set(THRUST_LENGTH * (0.4 + pose.speed), 1.4, 1);
      }
      engineMat.uniforms.uGlow.value = 0.8 + pose.speed * 2;
      massMat.uniforms.uOpacity.value = 0.5;
      massMat.uniforms.uPulse.value = 0;
      massMat.uniforms.uFlash.value = pose.hit * 0.1;
      frameMat.uniforms.uOpacity.value = 0.7;
      coreMat.uniforms.uGlow.value = 0.9 + pose.fuel * 0.7 + bend * 0.8;
      coreMat.uniforms.uFlash.value = pose.hit;
      haloMat.uniforms.uOpacity.value = 0.14 + (1 - pose.fuel) * 0.08 + bend * 0.1;
      stringMat.uniforms.uGlow.value = 1.2 + siegeDraw * 1.4 + bend * 1.6 + volley * 0.8;
      stringMat.uniforms.uPulse.value += siegeDraw * 0.3 + bend * 0.3;
      collapseMat.uniforms.uOpacity.value = ultimaWindup * 0.7;
    },
    dispose() {
      kit.dispose();
    },
  };
}

function buildShroud(kit: MechKit, anchor: THREE.Group, hullA: VectorMaterial, hullB: VectorMaterial, glow: VectorMaterial): void {
  kit.mesh(anchor, kit.own(shapeExtrude([
    [-16, -9], [-6, -14], [10, -12], [17, -5], [18, 0], [17, 5], [10, 12], [-6, 14], [-16, 9],
  ], 3, 0.6)), hullA, 0, 0, 0, SHARP);
  kit.mesh(anchor, kit.own(shapeExtrude([[-12, -5], [-3, -8.5], [9, -7], [14, 0], [9, 7], [-3, 8.5], [-12, 5]], 1.6, 0.4)), hullB, 0, 0, 2.2, SHARP);
  for (const side of [-1, 1] as const) kit.mesh(anchor, kit.own(lineGeometry(20, 0.5, 0.3)), glow, 0, side * 2.2, 3.3, 24);
}

function buildLimb(kit: MechKit, anchor: THREE.Group, def: PartDef, hullA: VectorMaterial, hullB: VectorMaterial, glow: VectorMaterial, side: number): void {
  // The limb's centreline, as the left limb (+y) in body space: from the riser beside the gun pod, bowed forward and swept
  // back to the lens pod at its tip, through the middle of the part's circle.
  const center: Point = [toWorld(def.x), Math.abs(toWorld(def.y))];
  const p0: Point = [4, 27];
  const p1: Point = [-1, 51];
  const p2: Point = [-15, 59];
  kit.mesh(anchor, kit.own(shapeExtrude(limbOutline(p0, p1, p2, 17, 7.5, center, side), 2.4, 0.5)), hullA, 0, 0, 0, SHARP);
  kit.mesh(anchor, kit.own(shapeExtrude(limbOutline(p0, p1, p2, 8, 3.2, center, side), 1.2, 0.3)), hullB, 0, 0, 1.9, SHARP);
  kit.mesh(anchor, kit.own(shapeExtrude(limbOutline(p0, p1, p2, 1.1, 0.5, center, side), 0.4, 0)), glow, 0, 0, 2.9, 30);
}

/** The stock, with the thrusters at its heel; returns their flares (they stretch with speed). */
function buildStock(kit: MechKit, anchor: THREE.Group, hullA: VectorMaterial, hullB: VectorMaterial, glow: VectorMaterial, engine: VectorMaterial): THREE.Mesh[] {
  kit.mesh(anchor, kit.own(shapeExtrude([
    [-20, -8], [-15, -13], [10, -10], [17, -5], [17, 5], [10, 10], [-15, 13], [-20, 8],
  ], 3.2, 0.6)), hullA, 0, 0, 0, SHARP);
  kit.mesh(anchor, kit.own(shapeExtrude([[-15, -6], [-11, -9], [7, -7], [12, -3], [12, 3], [7, 7], [-11, 9], [-15, 6]], 1.4, 0.4)), hullB, 0, 0, 2.3, SHARP);
  kit.mesh(anchor, kit.own(plateGeometry(6, 6, 1.6, 0.3)), hullB, 13, 0, 2.9, SHARP);
  kit.mesh(anchor, kit.own(lineGeometry(16, 0.5, 0.3)), glow, -2, 0, 3.2, 24);
  const flares: THREE.Mesh[] = [];
  for (const side of [-1, 1] as const) {
    kit.mesh(anchor, kit.own(nozzleGeometry(5, 2.2)), hullB, -21, side * 5, 0.6, 40).rotation.z = Math.PI;
    for (const k of [0, 1, 2]) kit.mesh(anchor, kit.own(lineGeometry(0.6, 4.2, 0.3)), glow, -8 + k * 3, side * 6.5, 2.7, 24);
    const flare = kit.mesh(anchor, kit.own(diamondGeometry(1, 0.4).translate(-1, 0, 0)), engine, -23.5, side * 5, 0.6, 30);
    flare.scale.set(3, 1.4, 1);
    flares.push(flare);
  }
  return flares;
}

function buildRail(kit: MechKit, turret: THREE.Group, weapon: THREE.Group, def: PartDef, hullA: VectorMaterial, hullB: VectorMaterial, glow: VectorMaterial, vent: VectorMaterial, coils: VectorMaterial[]): void {
  const radius = toWorld(def.rad);
  const reach = toWorld(def.muzzle);
  kit.mesh(turret, kit.own(prism(radius * 0.86, 2.6, 8)), hullA, 0, 0, 0, 48);
  kit.mesh(turret, kit.own(plateGeometry(radius * 1.5, radius * 0.95, 1.6, 0.22)), hullB, -1, 0, 1.8, 56);
  for (const side of [-1, 1] as const) kit.mesh(turret, kit.own(lineGeometry(5, 0.7, 0.3)), vent, -5, side * 4.4, 2.8, 24);
  const length = reach - 4;
  for (const side of [-1, 1] as const) kit.mesh(weapon, kit.own(lineGeometry(length, 1.4, 1.6)), hullB, 4 + length * 0.5, side * 2.3, 2.4, 44);
  kit.mesh(weapon, kit.own(lineGeometry(length - 2, 0.5, 0.5)), glow, 4 + length * 0.5, 0, 2.1, 24);
  for (let k = 0; k < RAIL_COILS; k++) {
    const material = kit.accentMaterial(CYAN, DEEP, 0.3, 0.14, 1.35);
    coils.push(material);
    kit.mesh(weapon, kit.own(collar(4.1, 1.2)), material, 9 + (k * (reach - 12)) / (RAIL_COILS - 1), 0, 2.4, 30);
  }
  for (const side of [-1, 1] as const) {
    const prong = kit.mesh(weapon, kit.own(finGeometry(6, 1.8, 0.8)), glow, reach + 1.5, side * 2.4, 2.4, 36);
    prong.rotation.z = -side * 0.06;
  }
}

function buildGun(kit: MechKit, turret: THREE.Group, weapon: THREE.Group, def: PartDef, hullA: VectorMaterial, hullB: VectorMaterial, glow: VectorMaterial, vent: VectorMaterial): void {
  const radius = toWorld(def.rad);
  const reach = toWorld(def.muzzle);
  kit.mesh(turret, kit.own(prism(radius * 0.78, 2.4, 6)), hullA, 0, 0, 0, 48);
  kit.mesh(turret, kit.own(wedgeGeometry(radius * 1.2, radius * 0.9, 1.6, 0.3)), hullB, 0.5, 0, 1.8, 56);
  kit.mesh(turret, kit.own(lineGeometry(4, 0.6, 0.3)), vent, -4.5, 0, 2.8, 24);
  const half = (FLECHETTES - 1) * 0.5;
  for (let k = 0; k < FLECHETTES; k++) {
    const angle = FLECHETTES > 1 ? binaryAngleToRadians(SALVO_SPREAD) * ((k - half) / (2 * half)) : 0;
    const mount = new THREE.Group();
    mount.rotation.z = angle;
    weapon.add(mount);
    kit.mesh(mount, kit.own(barrelGeometry(reach - 3, 0.75, 1.0)), hullB, 3 + (reach - 3) * 0.5, 0, 2.6, 40);
    const tip = kit.mesh(mount, kit.own(diamondGeometry(1.1, 0.5)), glow, reach, 0, 2.7, 30);
    tip.scale.set(1.6, 0.8, 1);
  }
}

function buildLens(kit: MechKit, turret: THREE.Group, weapon: THREE.Group, def: PartDef, hullA: VectorMaterial, hullB: VectorMaterial, glow: VectorMaterial, vent: VectorMaterial): void {
  const radius = toWorld(def.rad);
  const reach = toWorld(def.muzzle);
  kit.mesh(turret, kit.own(prism(radius * 0.62, 2, 8)), hullA, 0, 0, 0, 48);
  kit.mesh(turret, kit.own(lineGeometry(3.6, 0.6, 0.3)), vent, -radius * 0.55, 0, 1.6, 24).rotation.z = Math.PI * 0.5;
  kit.mesh(weapon, kit.own(new THREE.TorusGeometry(radius * 0.72, 1.4, 4, 8)), hullB, 0, 0, 2.2, 40);
  const lens = kit.mesh(weapon, kit.own(new THREE.OctahedronGeometry(radius * 0.5, 0)), glow, 0, 0, 2.4, 30);
  lens.scale.set(1, 1, 0.4);
  kit.mesh(weapon, kit.own(nozzleGeometry(reach - radius * 0.6, 1.8)), hullB, radius * 0.6 + (reach - radius * 0.6) * 0.5, 0, 2.4, 40);
  for (const turn of [0.785, 2.356, 3.927, 5.498]) {
    const vane = kit.mesh(weapon, kit.own(plateGeometry(radius * 0.42, radius * 0.3, 0.9, 0.3)), hullA, Math.cos(turn) * radius * 0.86, Math.sin(turn) * radius * 0.86, 2.2, SHARP);
    vane.rotation.z = turn;
  }
}
