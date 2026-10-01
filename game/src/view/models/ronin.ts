import * as THREE from 'three';
import { Attack, AttackPhase, FORMS, Frame, FRAME_STATS, PartKind, Role } from '../../sim/index.ts';
import type { FormDef, PartDef } from '../../sim/index.ts';
import {
  applyColossusVectorState,
  applyRobotVectorState,
  createMechKit,
  diamondGeometry,
  finGeometry,
  lineGeometry,
  nozzleGeometry,
  ringGeometry,
  shapeExtrude,
  type MechKit,
} from './kit-mechs.ts';
import { bodyHullGeometry } from './kit-hull.ts';
import type { VectorMaterial } from '../../render/vector.ts';
import { clamp01, easeOutCubic, lerp, smooth01, toWorld } from '../shared.ts';
import type { ColossusModel, ColossusPose, PartPose, RobotModel, RobotPose } from './types.ts';

/*
 * RONIN, the samurai duelist: a lean armoured swordsman with wide sode shoulder plates, a kabuto helm under a large crescent
 * crest, a long katana held forward along the aim, the empty sheath at its left hip and crimson tassels streaming behind.
 * Team colour runs along the armour's edges; vermilion marks the crest, the cords and the guard; the blade is bright steel.
 */

type Point2 = readonly [number, number];

const ROBOT_RADIUS = toWorld(FRAME_STATS[Frame.Ronin].bodyR);
const ACCENT = 0xff4b3e;
const ACCENT_FILL = 0x1c0605;
const STEEL = 0xe9f3ff;
const STEEL_FILL = 0x0b1118;

const HULL_Z = 2.5;
/** Bevelled plates draw their bevels' creases (45 degrees): a crisp double outline. */
const PLATE_CREASE = 40;
const BANK_TILT = 0.16;
const LEAN = 0.07;
const BREATH_RATE = 2.6;
const BREATH_HEIGHT = 0.1;

/** The katana: its length, where the hands hold it (the swing's pivot swings on a circle around the chest), how it rests. */
const BLADE_LENGTH = 11;
const BLADE_WIDTH = 0.62;
const BLADE_CURVE = 0.045;
const HAND_CENTER_X = 1.5;
const HAND_RADIUS = 2.3;
/** At rest the hands sit a little right of the centreline (radians round the chest) and the blade points along the aim. */
const REST_HAND = -0.22;
const HAND_Z = HULL_Z + 0.55;
/** How far the hands travel round the chest for each radian the blade turns. */
const HAND_FOLLOW = 0.5;
const REST_YAW = 0.05;
const REST_PITCH = 0.12;
/** The left hand grips the hilt this far behind the guard. */
const GRIP_SPACING = 1.25;

/**
 * A cut (RobotPose.fire decays from 1 on the tick the katana fires): the blade starts on the swing's side, sweeps across the
 * front in the first SWEEP_SHARE of the decay, holds its follow-through (the next cut, in a flurry, starts from there), then
 * eases back to its forward guard.
 */
const SWING_START = 1.25;
const SWING_END = -1.1;
const SWEEP_SHARE = 0.42;
const HOLD_SHARE = 0.8;
const TORSO_TWIST = 0.22;
/**
 * The swoosh behind the blade: a band between these distances from the hands, in TRAIL_SEGMENTS pieces of TRAIL_STEP each
 * trailing behind the blade, each shown once the blade has swept past it and dimmer the farther behind it lies.
 */
const TRAIL_INNER = 7.2;
const TRAIL_OUTER = BLADE_LENGTH + 0.5;
const TRAIL_SEGMENTS = 4;
const TRAIL_STEP = 0.3;

/** The parry stance (RobotPose.special): hands to the right, the blade across the front, a crescent of light before it. */
const GUARD_YAW = 1.36;
const GUARD_HAND_ANGLE = -0.62;
const GUARD_PITCH = 0.02;
const GUARD_RADIUS = 8.6;
const GUARD_HALF_ARC = 1.3;
const GUARD_Z = HULL_Z - 0.2;

/** The helm's two tassels: chains of short cord links. */
const TASSEL_SEGMENTS = 5;
const TASSEL_LENGTH = 1.05;
/** The sheath hangs from the left hip, trailing back and out. */
const SAYA_LENGTH = 6.6;
const SAYA_YAW = Math.PI - 0.5;

/** Points of a polygon outline from a list (for shapeExtrude). */
function outline(points: readonly Point2[]): Array<[number, number]> {
  return points.map(([x, y]) => [x, y]);
}

/**
 * A crescent in the XY plane opening toward +y: the outer arc of `radius` spans `span` either side of straight down, the belly
 * is `thickness` deep and the horns meet in points.
 */
function crescentPoints(radius: number, span: number, thickness: number, segments: number): Array<[number, number]> {
  const w = radius * Math.sin(span);
  const h = radius - radius * Math.cos(span);
  const c = (w * w + h * h - thickness * thickness) / (2 * (h - thickness));
  const rho = c - thickness;
  const gamma = Math.atan2(w, c - h);
  const points: Array<[number, number]> = [];
  for (let i = 0; i <= segments; i++) {
    const a = -Math.PI / 2 - span + (2 * span * i) / segments;
    points.push([radius * Math.cos(a), radius + radius * Math.sin(a)]);
  }
  for (let i = segments - 1; i >= 1; i--) {
    const a = -Math.PI / 2 - gamma + (2 * gamma * i) / segments;
    points.push([rho * Math.cos(a), c + rho * Math.sin(a)]);
  }
  return points;
}

/** A katana blade along +x from 0 to `length`: a gentle curve toward +y, the edge on -y, a kissaki whose edge sweeps up to the point. */
function bladePoints(length: number, width: number, curve: number): Array<[number, number]> {
  const spine = (x: number): number => curve * length * (x / length) ** 2;
  const half = (x: number): number => width * 0.5 * (1 - 0.28 * (x / length));
  const edge: Array<[number, number]> = [];
  const back: Array<[number, number]> = [];
  const straight = 0.86 * length;
  const steps = 8;
  for (let i = 0; i <= steps; i++) {
    const x = (straight * i) / steps;
    edge.push([x, spine(x) - half(x)]);
    back.push([x, spine(x) + half(x)]);
  }
  const kissaki: Array<[number, number]> = [
    [0.92 * length, spine(0.92 * length) - half(0.92 * length) * 0.7],
    [0.97 * length, spine(0.97 * length) - half(0.97 * length) * 0.1],
    [length, spine(length) + half(length) * 0.55],
  ];
  back.push([0.95 * length, spine(0.95 * length) + half(0.95 * length)]);
  return [...edge, ...kissaki, ...back.reverse()];
}

/** A plate with cut corners, `length` along x and `width` along y, centred. */
function cutRect(length: number, width: number, cut: number): Array<[number, number]> {
  const x = length * 0.5;
  const y = width * 0.5;
  const c = Math.min(cut, x, y);
  return [[-x + c, -y], [x - c, -y], [x, -y + c], [x, y - c], [x - c, y], [-x + c, y], [-x, y - c], [-x, -y + c]];
}

/** A piece of a ring band in the XY plane from angle `from` to `to`, its inner edge running from `innerFrom` to `innerTo`. */
function bandPoints(outer: number, innerFrom: number, innerTo: number, from: number, to: number, segments: number): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  for (let i = 0; i <= segments; i++) {
    const a = lerp(from, to, i / segments);
    points.push([outer * Math.cos(a), outer * Math.sin(a)]);
  }
  for (let i = segments; i >= 0; i--) {
    const a = lerp(from, to, i / segments);
    const r = lerp(innerFrom, innerTo, i / segments);
    points.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  return points;
}

/** A flat ring band in the XY plane, `inner` to `outer`, spanning `halfArc` either side of +x. */
function arcBand(inner: number, outer: number, halfArc: number, segments: number): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  for (let i = 0; i <= segments; i++) {
    const a = -halfArc + (2 * halfArc * i) / segments;
    points.push([outer * Math.cos(a), outer * Math.sin(a)]);
  }
  for (let i = segments; i >= 0; i--) {
    const a = -halfArc + (2 * halfArc * i) / segments;
    points.push([inner * Math.cos(a), inner * Math.sin(a)]);
  }
  return points;
}

/** A helmet bowl: the upper half of a sphere, its dome toward +z. */
function domeGeometry(radius: number, sides: number, rings: number): THREE.BufferGeometry {
  const dome = new THREE.SphereGeometry(radius, sides, rings, 0, Math.PI * 2, 0, Math.PI / 2);
  dome.rotateX(Math.PI / 2);
  return dome;
}

/** A box `length` long that starts at the origin and runs along -x (a strip hanging back from its pivot). */
function stripBack(length: number, width: number, depth: number): THREE.BufferGeometry {
  const box = new THREE.BoxGeometry(length, width, depth);
  box.translate(-length * 0.5, 0, 0);
  return box;
}

function add(kit: MechKit, parent: THREE.Object3D, geometry: THREE.BufferGeometry, material: VectorMaterial, x: number, y: number, z: number, crease = 48): THREE.Mesh {
  return kit.mesh(parent, kit.own(geometry), material, x, y, z, crease);
}

/** Where the blade points (radians from the aim, positive toward the robot's left) through a cut; 0 at rest. */
function swingYaw(fire: number, side: number): number {
  if (fire <= 0.001) return 0;
  const phase = 1 - clamp01(fire);
  if (phase < SWEEP_SHARE) return side * lerp(SWING_START, SWING_END, easeOutCubic(phase / SWEEP_SHARE));
  if (phase < HOLD_SHARE) return side * SWING_END * (1 - 0.08 * (phase - SWEEP_SHARE) / (HOLD_SHARE - SWEEP_SHARE));
  return side * SWING_END * 0.92 * (1 - smooth01((phase - HOLD_SHARE) / (1 - HOLD_SHARE)));
}

/** Radians the blade has swept so far in a cut (all of the sweep once it is done; 0 at rest). */
function swingSwept(fire: number): number {
  if (fire <= 0.001) return 0;
  const phase = 1 - clamp01(fire);
  return (SWING_START - SWING_END) * easeOutCubic(Math.min(1, phase / SWEEP_SHARE));
}

/** 0..1: how bright the swoosh behind the blade is (the sweep itself, fading through the follow-through). */
function swingTrail(fire: number): number {
  if (fire <= 0.001) return 0;
  const phase = 1 - clamp01(fire);
  if (phase < SWEEP_SHARE) return 1 - 0.3 * (phase / SWEEP_SHARE);
  return 0.7 * (1 - smooth01((phase - SWEEP_SHARE) / (0.62 - SWEEP_SHARE)));
}

export function createRonin(): RobotModel {
  const kit = createMechKit();
  const root = new THREE.Group();
  const hull = new THREE.Group();
  root.add(hull);

  const hullA = kit.teamMaterial(0.46, 0.9, 1.2, 0x08131d, 0.58, 1.7);
  const hullB = kit.teamMaterial(0.62, 0.7, 1.45, 0x0b1a28, 0.56, 1.65);
  const lacquer = kit.teamMaterial(0.3, 0.78, 0.95, 0x05080d, 0.62, 1.4);
  const accent = kit.accentMaterial(ACCENT, ACCENT_FILL, 1.8, 0.14);
  const steel = kit.accentMaterial(STEEL, STEEL_FILL, 1.85, 0.12, 1.4);
  const swooshes = Array.from({ length: TRAIL_SEGMENTS }, () => kit.accentMaterial(0xffb09a, 0x5a0f08, 2.2, 0.2, 1.2));
  const guardMat = kit.accentMaterial(ACCENT, 0x2a0805, 2.1, 0.16, 1.6);
  const glass = kit.glassMaterial(0xff8a6a, 0x1a0604);

  // Torso (dou) and chest plate.
  const torso = new THREE.Group();
  hull.add(torso);
  add(kit, torso, shapeExtrude(outline([[-2.0, -2.2], [1.5, -2.5], [2.8, -1.6], [3.1, 0], [2.8, 1.6], [1.5, 2.5], [-2.0, 2.2], [-2.6, 0]]), 1.9, 0.3), hullA, 0, 0, HULL_Z, PLATE_CREASE);
  add(kit, torso, shapeExtrude(outline([[-0.7, -1.7], [1.6, -1.95], [2.45, -1.05], [2.65, 0], [2.45, 1.05], [1.6, 1.95], [-0.7, 1.7]]), 0.5, 0.14), hullB, 0.1, 0, HULL_Z + 1.2, PLATE_CREASE);

  // Kusazuri: three lames of the armoured skirt, flaring behind the waist.
  for (let k = 0; k < 3; k++) {
    const front = 2.25 + 0.35 * k;
    const rear = front + 0.35;
    const x0 = -1.5 - 0.9 * k;
    const x1 = x0 - 1.35;
    add(kit, hull, shapeExtrude([[x1, -rear], [x0, -front], [x0, front], [x1, rear]], 0.3, 0.1), k === 1 ? hullB : hullA, 0, 0, HULL_Z - 0.35 - 0.38 * k, PLATE_CREASE);
  }

  // Sode: great shoulder plates, three lames each, sloping down and out, edged with a vermilion cord.
  const sodes: THREE.Group[] = [];
  for (const side of [-1, 1] as const) {
    const sode = new THREE.Group();
    sode.position.set(0.35, side * 2.75, HULL_Z + 1.45);
    sode.rotation.x = -side * 0.5;
    hull.add(sode);
    sodes.push(sode);
    for (let k = 0; k < 3; k++) {
      add(kit, sode, shapeExtrude(cutRect(4.9 - 0.25 * k, 1.5, 0.35), 0.28, 0.1), k === 0 ? hullB : hullA, -0.25 * k, side * (0.55 + 1.22 * k), -0.1 * k, PLATE_CREASE);
    }
    add(kit, sode, lineGeometry(4.1, 0.14, 0.1), accent, -0.55, side * 3.35, 0.05, 30);
  }

  // Kabuto: the bowl, a flared neck guard (shikoro), turned-back wings (fukigaeshi), the eye slit and the crescent crest.
  const helm = new THREE.Group();
  helm.position.set(2.0, 0, HULL_Z + 2.05);
  hull.add(helm);
  const bowl = add(kit, helm, domeGeometry(1.4, 10, 4), hullB, 0, 0, 0, 30);
  bowl.scale.set(1.15, 1, 0.82);
  const neckGuard = new THREE.CylinderGeometry(1.45, 2.35, 0.7, 10, 1, true, (5 * Math.PI) / 6, (4 * Math.PI) / 3);
  neckGuard.rotateX(Math.PI / 2);
  add(kit, helm, neckGuard, hullA, -0.1, 0, -0.35, 40);
  for (const side of [-1, 1] as const) {
    const wing = add(kit, helm, finGeometry(1.4, 0.9, 0.16), hullA, 0.75, side * 1.55, -0.1, 40);
    wing.rotation.z = side * 2.2;
    wing.rotation.x = side * 0.5;
  }
  add(kit, helm, lineGeometry(0.2, 1.05, 0.14), accent, 1.5, 0, -0.18, 28);
  const crestGeometry = shapeExtrude(crescentPoints(3.1, 0.98, 0.44, 14), 0.14, 0);
  crestGeometry.rotateX(Math.PI / 2);
  crestGeometry.rotateZ(Math.PI / 2);
  const crest = add(kit, helm, crestGeometry, accent, 1.25, 0, 0.3, 36);
  crest.rotation.y = 0.72;

  // Tassels: two crimson cords streaming from the back of the helm, each a chain of short strips ending in a tuft.
  const tassels: THREE.Group[][] = [];
  for (const side of [-1, 1] as const) {
    const chain: THREE.Group[] = [];
    let parent: THREE.Object3D = hull;
    for (let k = 0; k < TASSEL_SEGMENTS; k++) {
      const link = new THREE.Group();
      if (k === 0) link.position.set(0.5, side * 0.55, HULL_Z + 2.0);
      else link.position.set(-TASSEL_LENGTH, 0, 0);
      parent.add(link);
      add(kit, link, stripBack(TASSEL_LENGTH + 0.08, 0.3 - k * 0.025, 0.12), accent, 0, 0, 0, 30);
      chain.push(link);
      parent = link;
    }
    add(kit, chain[0], diamondGeometry(0.34, 0.16), accent, 0, 0, 0.05, 30);
    add(kit, parent, shapeExtrude([[0, -0.16], [-1.15, -0.42], [-1.3, 0], [-1.15, 0.42], [0, 0.16]], 0.1, 0), accent, -TASSEL_LENGTH, 0, 0, 30);
    tassels.push(chain);
  }

  // Saya: the empty sheath at the left hip, trailing back and out.
  const saya = new THREE.Group();
  saya.position.set(0.1, 2.3, HULL_Z - 0.55);
  hull.add(saya);
  add(kit, saya, shapeExtrude(bladePoints(SAYA_LENGTH, 0.74, 0.04).map(([x, y]) => [x, -y] as [number, number]), 0.34, 0.06), lacquer, 0, 0, 0, 36);
  add(kit, saya, lineGeometry(0.42, 0.92, 0.44), accent, 0.2, 0, 0.02, 30);
  add(kit, saya, lineGeometry(0.5, 0.7, 0.4), accent, SAYA_LENGTH - 0.3, -0.2, 0.02, 30);

  // Arms: forearm guards (kote) from the shoulders to the hands on the hilt, placed every frame.
  const armGeometry = kit.own(lineGeometry(1, 0.6, 0.5));
  const arms = [-1, 1].map(() => kit.mesh(hull, armGeometry, hullA, 0, 0, HAND_Z, 50));

  // The katana: hilt, guard, blade. Its group pivots at the leading hand.
  const sword = new THREE.Group();
  sword.rotation.order = 'ZYX';
  hull.add(sword);
  add(kit, sword, shapeExtrude(cutRect(2.2, 0.5, 0.12), 0.4, 0.06), lacquer, -1.3, 0, 0, 40);
  add(kit, sword, lineGeometry(0.28, 0.56, 0.46), accent, -2.45, 0, 0, 30);
  const tsuba = new THREE.CylinderGeometry(0.7, 0.7, 0.18, 8);
  tsuba.rotateZ(Math.PI / 2);
  add(kit, sword, tsuba, accent, -0.1, 0, 0, 40);
  add(kit, sword, shapeExtrude(bladePoints(BLADE_LENGTH, BLADE_WIDTH, BLADE_CURVE), 0.12, 0.03), steel, 0.05, 0, 0, 36);

  // The cut's swoosh (mirrored for a cut from the right) and the parry's crescent of light.
  const trail = new THREE.Group();
  trail.rotation.order = 'ZYX';
  hull.add(trail);
  const trailPieces = swooshes.map((material, k) => {
    // The band narrows to the outer rim at its far end.
    const innerFrom = lerp(TRAIL_INNER, TRAIL_OUTER - 0.3, (k / TRAIL_SEGMENTS) ** 0.8);
    const innerTo = lerp(TRAIL_INNER, TRAIL_OUTER - 0.3, ((k + 1) / TRAIL_SEGMENTS) ** 0.8);
    const piece = add(kit, trail, shapeExtrude(bandPoints(TRAIL_OUTER, innerFrom, innerTo, k * TRAIL_STEP, (k + 1) * TRAIL_STEP, 4), 0.08, 0), material, 0, 0, 0, 30);
    piece.visible = false;
    return piece;
  });
  const guard = add(kit, hull, shapeExtrude(arcBand(GUARD_RADIUS - 0.45, GUARD_RADIUS, GUARD_HALF_ARC, 20), 0.1, 0), guardMat, 0, 0, GUARD_Z, 30);
  const guardInner = add(kit, hull, shapeExtrude(arcBand(GUARD_RADIUS - 1.5, GUARD_RADIUS - 1.25, GUARD_HALF_ARC * 0.8, 16), 0.08, 0), guardMat, 0, 0, GUARD_Z, 30);
  guard.visible = false;
  guardInner.visible = false;

  // Thrusters under the skirt, and the protection shell.
  const flares: THREE.Mesh[] = [];
  for (const side of [-1, 1] as const) {
    add(kit, hull, nozzleGeometry(1.5, 0.42), lacquer, -3.3, side * 1.05, 1.1, 34);
    const flare = add(kit, hull, diamondGeometry(0.36, 0.12), glass, -4.4, side * 1.05, 1.1, 28);
    flare.rotation.y = Math.PI / 2;
    flares.push(flare);
  }
  const shellRing = add(kit, root, ringGeometry(ROBOT_RADIUS * 1.08, 0.16), glass, 0, 0, 0.8, 24);
  shellRing.visible = false;

  const leading = new THREE.Vector3();
  const trailing = new THREE.Vector3();
  const shoulder = new THREE.Vector3();

  const placeArm = (arm: THREE.Mesh, side: number, hand: THREE.Vector3): void => {
    shoulder.set(0.5, side * 2.35, HAND_Z);
    const dx = hand.x - shoulder.x;
    const dy = hand.y - shoulder.y;
    arm.position.set((hand.x + shoulder.x) * 0.5, (hand.y + shoulder.y) * 0.5, HAND_Z);
    arm.rotation.z = Math.atan2(dy, dx);
    arm.scale.x = Math.max(0.2, Math.hypot(dx, dy));
  };

  return {
    root,
    setTeam(color) {
      kit.setTeam(color);
    },
    update(pose: RobotPose) {
      const morph = smooth01(pose.morph);
      const stance = smooth01(pose.special);
      const side = pose.side < 0 ? -1 : 1;
      const relative = pose.move - pose.aim;
      const bank = Math.sin(relative) * pose.speed;
      root.rotation.z = pose.aim;
      root.scale.set(1 - morph * 0.76, 1 - morph * 0.28, 1 - morph * 0.48);
      root.position.z = Math.sin(pose.time * BREATH_RATE) * BREATH_HEIGHT;
      hull.rotation.x = bank * BANK_TILT;
      hull.rotation.y = -Math.cos(relative) * pose.speed * LEAN + stance * 0.05;

      // The blade: a cut sweeps it across the front, the parry turns it across as a guard.
      const cut = swingYaw(pose.fire, side);
      const yaw = lerp(cut, GUARD_YAW, stance);
      const handAngle = lerp(REST_HAND + cut * HAND_FOLLOW, GUARD_HAND_ANGLE, stance);
      leading.set(HAND_CENTER_X + HAND_RADIUS * Math.cos(handAngle), HAND_RADIUS * Math.sin(handAngle), HAND_Z);
      sword.position.copy(leading);
      sword.rotation.z = REST_YAW * (1 - stance) + yaw;
      sword.rotation.y = -lerp(REST_PITCH * (1 - Math.min(1, Math.abs(cut))), GUARD_PITCH, stance);
      trailing.set(leading.x - Math.cos(sword.rotation.z) * GRIP_SPACING, leading.y - Math.sin(sword.rotation.z) * GRIP_SPACING, HAND_Z);
      placeArm(arms[0], -1, leading);
      placeArm(arms[1], 1, trailing);
      torso.rotation.z = (cut / SWING_START) * TORSO_TWIST * (1 - stance) - stance * 0.12;
      for (let i = 0; i < sodes.length; i++) {
        const sodeSide = i === 0 ? -1 : 1;
        const lift = stance * 0.18 + Math.max(0, (cut * sodeSide) / SWING_START) * 0.12;
        sodes[i].rotation.x = -sodeSide * (0.5 - lift);
        sodes[i].rotation.z = sodeSide * pose.speed * 0.05;
      }

      const sweep = swingTrail(pose.fire) * (1 - stance);
      const swept = swingSwept(pose.fire);
      for (let k = 0; k < trailPieces.length; k++) trailPieces[k].visible = sweep > 0.02 && swept > (k + 0.5) * TRAIL_STEP;
      trail.position.copy(leading);
      trail.rotation.z = sword.rotation.z;
      trail.rotation.x = side > 0 ? 0 : Math.PI;

      guard.visible = stance > 0.02;
      guardInner.visible = guard.visible;
      guard.scale.setScalar(0.72 + stance * 0.28);
      guardInner.scale.setScalar(0.8 + stance * 0.2);

      // Tassels stream back, trail away from the direction of travel and ripple.
      const drift = -Math.sin(relative) * pose.speed * 0.3;
      for (let t = 0; t < tassels.length; t++) {
        const chain = tassels[t];
        const tasselSide = t === 0 ? -1 : 1;
        for (let k = 0; k < chain.length; k++) {
          const ripple = Math.sin(pose.time * (4.2 + pose.speed * 3) - k * 0.9 + t * 1.3) * (0.16 + 0.1 * (1 - pose.speed));
          chain[k].rotation.z = (k === 0 ? -tasselSide * (0.26 - pose.speed * 0.12) + drift : drift * 0.25) + ripple;
          chain[k].rotation.y = k === 0 ? -0.35 + pose.speed * 0.2 : 0.08 - pose.speed * 0.04;
        }
      }
      saya.rotation.z = SAYA_YAW + Math.sin(pose.time * 2.1) * 0.02 - bank * 0.08;
      for (const flare of flares) flare.scale.set(1.4 + pose.speed * 1.8, 0.8 + pose.speed * 0.4, 1);

      shellRing.visible = pose.shield > 0.03;
      shellRing.scale.setScalar(1 + pose.shield * 0.08);
      shellRing.rotation.z = pose.time * 0.7;

      applyRobotVectorState(kit, pose.time, pose.hit, pose.charge, pose.shield, morph);
      for (let k = 0; k < swooshes.length; k++) {
        swooshes[k].uniforms.uOpacity.value = sweep * 0.85 * (1 - k / TRAIL_SEGMENTS) * (1 - morph);
        swooshes[k].uniforms.uPulse.value += sweep * 0.4;
      }
      const shown = lerp(0.9, 0.18, morph);
      accent.uniforms.uOpacity.value = shown;
      accent.uniforms.uPulse.value += pose.alt * 0.3 + stance * 0.12;
      steel.uniforms.uOpacity.value = shown;
      steel.uniforms.uPulse.value += pose.fire * 0.35 + stance * 0.45;
      guardMat.uniforms.uOpacity.value = stance * (0.75 + 0.25 * Math.sin(pose.time * 24)) * (1 - morph);
      guardMat.uniforms.uPulse.value += 0.3 + pose.alt * 0.4;
      glass.uniforms.uOpacity.value = 0.2 + pose.speed * 0.45 + pose.shield * 0.2;
    },
    dispose() {
      kit.dispose();
    },
  };
}

// ---- SHOGUN: the samurai duelist's colossus ------------------------------------------------------------

const FORM = FORMS[Frame.Ronin];
const CORE_RADIUS = toWorld(FORM.coreR);
const CORE_Z = 3.4;
const ASSEMBLE_STEP = 0.065;
const ASSEMBLE_ARC_HEIGHT = 4.4;
const ASSEMBLE_ARC_SWAY = 0.16;
const MASS_MARGIN = 2.6;
const MASS_DEPTH = 6;
const STRUT_Z = 2.3;
const PART_FLASH = 0.34;
const WEAK_HP = 0.35;
/** A pod's weapon rises this high and tips up this far (radians) through its tell, and its blade glows. */
const TELL_RISE = 3.2;
const TELL_TIP = 0.16;
/**
 * Banner flags lean out from the core this far from upright (radians), and FLAG_RAISE less as they stand up for the ultima; they
 * are this tall and this wide.
 */
const FLAG_LEAN = 1.12;
const FLAG_RAISE = 0.4;
const FLAG_HEIGHT = 16;
const FLAG_WIDTH = 5.6;
/** The helm's crest leans forward this far from upright, so it shows its crescent to a camera looking down. */
const CREST_LEAN = 1.2;

/** Everything drawn at one part (the array index equals the part's index in FORMS). */
interface PartRig {
  readonly def: PartDef;
  readonly anchor: THREE.Group;
  /** This part's own hull materials: it flashes on its own when struck. */
  readonly shells: readonly VectorMaterial[];
  readonly strut: THREE.Mesh;
  /** Pods: the weapon that turns with the pod's facing, its steel (brightening through the tell), its muzzle glint, its vent. */
  readonly gun: THREE.Group | null;
  /** How high the weapon rides when it is not telling. */
  readonly gunZ: number;
  readonly steel: VectorMaterial | null;
  readonly glint: THREE.Mesh | null;
  readonly vent: VectorMaterial | null;
  /** Moving plates: a sode's lames, a banner's flag. */
  readonly rig: THREE.Group | null;
}

interface ShogunKit {
  readonly kit: MechKit;
  readonly accent: VectorMaterial;
  readonly glass: VectorMaterial;
}

type WeaponRig = Pick<PartRig, 'shells' | 'gun' | 'gunZ' | 'steel' | 'glint' | 'vent' | 'rig'>;

const ARM_BLADE_Z = 6.4;
const SPEAR_Z = 3.8;
const ODACHI_Z = 7.2;

/** The pod role taking part in an attack. */
function roleOf(attack: number): number {
  return attack === Attack.Salvo ? Role.Salvo : attack === Attack.Siege ? Role.Siege : attack === Attack.Ultima ? Role.Ultima : 0;
}

function staggered(value: number, start: number): number {
  return easeOutCubic((value - start) / (1 - start));
}

/** The side of the body a part sits on: 1 left (+y), -1 right. */
function sideOf(def: PartDef): number {
  return def.y >= 0 ? 1 : -1;
}

function partShells(kit: MechKit): [VectorMaterial, VectorMaterial] {
  return [kit.teamMaterial(0.5, 0.88, 1.25, 0x07131b, 0.5, 1.6), kit.teamMaterial(0.66, 0.7, 1.45, 0x0b1621, 0.38, 1.5)];
}

/** The helm: flared neck-guard lames, the bowl and its finial, a brow plate, turned-back wings, the mask's eyes and the great crescent crest. */
function buildKabuto(ctx: ShogunKit, anchor: THREE.Group, radius: number): VectorMaterial[] {
  const { kit, accent } = ctx;
  const [shell, trim] = partShells(kit);
  for (let k = 0; k < 3; k++) {
    const lame = new THREE.CylinderGeometry(radius * (0.5 + 0.14 * k), radius * (0.72 + 0.14 * k), 2.6 - 0.3 * k, 16, 1, true, (5 * Math.PI) / 6, (4 * Math.PI) / 3);
    lame.rotateX(Math.PI / 2);
    add(kit, anchor, lame, k === 1 ? trim : shell, -radius * 0.06, 0, 6.6 - 2.1 * k, 34);
  }
  const bowl = add(kit, anchor, domeGeometry(radius * 0.58, 12, 5), trim, radius * 0.02, 0, 7.2, 26);
  bowl.scale.set(1.1, 1, 0.74);
  add(kit, anchor, new THREE.CylinderGeometry(radius * 0.08, radius * 0.12, 1.2, 8), accent, radius * 0.04, 0, 7.2 + radius * 0.42, 30).rotation.x = Math.PI / 2;
  add(kit, anchor, shapeExtrude(arcBand(radius * 0.42, radius * 0.7, 0.95, 12), 0.7, 0.2), shell, 0, 0, 7.4, 40);
  for (const side of [-1, 1] as const) {
    const wing = add(kit, anchor, shapeExtrude([[0, -2.2], [radius * 0.42, -1.2], [radius * 0.48, 1.6], [0, 2.6]], 0.8, 0.25), shell, radius * 0.3, side * radius * 0.56, 8.2, PLATE_CREASE);
    wing.rotation.z = side * 2.25;
    wing.rotation.x = side * 0.45;
    add(kit, anchor, lineGeometry(radius * 0.16, 0.55, 0.4), accent, radius * 0.66, side * radius * 0.13, 5.6, 28).rotation.z = side * 0.22;
  }
  const crest = shapeExtrude(crescentPoints(radius * 1.02, 1.04, radius * 0.17, 20), 1.2, 0);
  crest.rotateX(Math.PI / 2);
  crest.rotateZ(Math.PI / 2);
  add(kit, anchor, crest, accent, radius * 0.3, 0, 11, 34).rotation.y = CREST_LEAN;
  return [shell, trim];
}

/** A great shoulder plate: four lames sloping down and out, a family crest (mon) on the second. */
function buildSode(ctx: ShogunKit, anchor: THREE.Group, radius: number, side: number): { shells: VectorMaterial[]; rig: THREE.Group } {
  const { kit, accent } = ctx;
  const [shell, trim] = partShells(kit);
  const rig = new THREE.Group();
  rig.position.z = 7.2;
  anchor.add(rig);
  for (let k = 0; k < 4; k++) {
    add(kit, rig, shapeExtrude(cutRect(radius * 1.44 - k * 1.4, radius * 0.42, 2.6), 1.4, 0.45), k < 2 ? trim : shell, -k * 1.0, side * (-radius * 0.6 + k * radius * 0.4), -k * 0.95, PLATE_CREASE);
  }
  add(kit, rig, lineGeometry(radius * 1.1, 0.6, 0.4), accent, -3.6, side * (radius * 0.6 + radius * 0.2), -2.4, 30);
  const monY = side * (-radius * 0.6 + radius * 0.4);
  add(kit, rig, ringGeometry(radius * 0.16, 0.36), accent, radius * 0.16, monY, 1.2, 30);
  const mon = add(kit, rig, shapeExtrude(crescentPoints(radius * 0.12, 1.1, radius * 0.05, 10), 0.3, 0), accent, radius * 0.16, monY - radius * 0.07, 1.25, 30);
  mon.rotation.z = side > 0 ? 0 : Math.PI;
  return { shells: [shell, trim], rig };
}

/** The cuirass's back: a broad plate with lames across it, flaring skirt plates, the agemaki bow and two thrusters. */
function buildDou(ctx: ShogunKit, anchor: THREE.Group, radius: number, flares: THREE.Mesh[]): VectorMaterial[] {
  const { kit, accent, glass } = ctx;
  const [shell, trim] = partShells(kit);
  add(kit, anchor, shapeExtrude(outline([[radius * 0.62, -radius * 0.62], [radius * 0.72, 0], [radius * 0.62, radius * 0.62], [-radius * 0.35, radius * 0.8], [-radius * 0.78, radius * 0.42], [-radius * 0.86, 0], [-radius * 0.78, -radius * 0.42], [-radius * 0.35, -radius * 0.8]]), 2.2, 0.5), shell, 0, 0, 3.6, PLATE_CREASE);
  for (let k = 0; k < 3; k++) {
    add(kit, anchor, shapeExtrude(cutRect(radius * 0.26, radius * (1.24 - 0.14 * k), 1.2), 0.6, 0.2), trim, radius * (0.28 - 0.34 * k), 0, 5.4 - 0.2 * k, PLATE_CREASE);
  }
  for (const side of [-1, 0, 1] as const) {
    const skirt = add(kit, anchor, shapeExtrude(cutRect(radius * 0.36, radius * 0.4, 1.4), 0.6, 0.2), shell, -radius * 0.9, side * radius * 0.4, 2.4, PLATE_CREASE);
    skirt.rotation.z = side * 0.35;
  }
  add(kit, anchor, diamondGeometry(1.6, 0.7), accent, -radius * 0.36, 0, 6.5, 30);
  for (const side of [-1, 1] as const) {
    const bow = add(kit, anchor, finGeometry(4.2, 2.2, 0.5), accent, -radius * 0.36, side * 2.2, 6.4, 30);
    bow.rotation.z = side * 1.9;
    add(kit, anchor, nozzleGeometry(4.2, 1.5), shell, -radius * 0.82, side * radius * 0.3, 1.8, 34);
    const flare = add(kit, anchor, diamondGeometry(1.3, 0.4), glass, -radius * 1.05, side * radius * 0.3, 1.8, 28);
    flare.rotation.y = Math.PI / 2;
    flares.push(flare);
  }
  return [shell, trim];
}

/** An arm blade: the forearm guard stays with the body; the long blade swings with the pod's facing. */
function buildArmBlade(ctx: ShogunKit, anchor: THREE.Group, def: PartDef): WeaponRig {
  const { kit, accent } = ctx;
  const radius = toWorld(def.rad);
  const muzzle = toWorld(def.muzzle);
  const [shell, trim] = partShells(kit);
  const steel = kit.accentMaterial(STEEL, STEEL_FILL, 1.7, 0.14, 1.4);
  const vent = kit.accentMaterial(ACCENT, ACCENT_FILL, 1.4, 0.12);
  add(kit, anchor, shapeExtrude(cutRect(radius * 1.5, radius * 1.1, radius * 0.3), 1.4, 0.4), shell, -radius * 0.1, 0, 3.4, PLATE_CREASE);
  add(kit, anchor, shapeExtrude(cutRect(radius * 1.1, radius * 0.5, radius * 0.16), 0.8, 0.25), trim, -radius * 0.2, 0, 5.0, PLATE_CREASE);
  add(kit, anchor, lineGeometry(radius * 0.8, 0.5, 0.3), vent, -radius * 0.25, 0, 5.8, 28);
  const gun = new THREE.Group();
  gun.rotation.order = 'ZYX';
  gun.position.z = ARM_BLADE_Z;
  anchor.add(gun);
  add(kit, gun, shapeExtrude(cutRect(radius * 0.6, 1.6, 0.4), 1.1, 0.2), trim, -radius * 0.34, 0, 0, 40);
  const tsuba = ringGeometry(radius * 0.36, 0.42);
  tsuba.rotateY(Math.PI / 2);
  add(kit, gun, tsuba, accent, 0, 0, 0, 30);
  add(kit, gun, shapeExtrude(bladePoints(muzzle + 6, 3.6, 0.05), 0.5, 0.1), steel, 0.6, 0, 0, 34);
  const glint = add(kit, gun, diamondGeometry(1.6, 0.5), steel, muzzle, 0, 0.3, 28);
  glint.rotation.x = 0.4;
  return { shells: [shell, trim], gun, gunZ: ARM_BLADE_Z, steel, glint, vent, rig: null };
}

/** A sashimono banner: a mon disc, a pole, a blade-tipped flag leaning out from the core, a spear head that turns with the pod. */
function buildBanner(ctx: ShogunKit, anchor: THREE.Group, def: PartDef): WeaponRig {
  const { kit, accent } = ctx;
  const radius = toWorld(def.rad);
  const muzzle = toWorld(def.muzzle);
  const [shell, trim] = partShells(kit);
  const steel = kit.accentMaterial(STEEL, STEEL_FILL, 1.6, 0.14, 1.3);
  const vent = kit.accentMaterial(ACCENT, ACCENT_FILL, 1.4, 0.12);
  const disc = new THREE.CylinderGeometry(radius * 0.7, radius * 0.8, 1.2, 8);
  disc.rotateX(Math.PI / 2);
  add(kit, anchor, disc, shell, 0, 0, 2.4, 40);
  add(kit, anchor, ringGeometry(radius * 0.45, 0.3), vent, 0, 0, 3.1, 28);
  // The flag leans out from the core (the mast's x), its width across, its height up the mast's z.
  const outward = new THREE.Group();
  outward.position.z = 3.2;
  outward.rotation.z = Math.atan2(toWorld(def.y), toWorld(def.x));
  anchor.add(outward);
  const rig = new THREE.Group();
  rig.rotation.y = FLAG_LEAN;
  outward.add(rig);
  const half = FLAG_WIDTH * 0.5;
  const flag = shapeExtrude([[-half, 0], [half, 0], [half, FLAG_HEIGHT - 4.4], [0, FLAG_HEIGHT], [-half, FLAG_HEIGHT - 4.4]], 0.35, 0);
  flag.rotateX(Math.PI / 2);
  flag.rotateZ(Math.PI / 2);
  add(kit, rig, flag, trim, 0, 0, 0, 30);
  const stripe = new THREE.BoxGeometry(0.5, 0.5, FLAG_HEIGHT - 4.6);
  stripe.translate(0, 0, (FLAG_HEIGHT - 4.6) * 0.5);
  add(kit, rig, stripe, accent, 0, 0, 0.2, 30);
  const gun = new THREE.Group();
  gun.rotation.order = 'ZYX';
  gun.position.z = SPEAR_Z;
  anchor.add(gun);
  add(kit, gun, shapeExtrude([[0, -0.9], [muzzle * 0.5, -1.4], [muzzle, 0], [muzzle * 0.5, 1.4], [0, 0.9]], 0.45, 0.1), steel, 0, 0, 0, 34);
  const glint = add(kit, gun, diamondGeometry(1.2, 0.4), steel, muzzle, 0, 0.3, 28);
  glint.rotation.x = 0.4;
  return { shells: [shell, trim], gun, gunZ: SPEAR_Z, steel, glint, vent, rig };
}

/** The great sword: a guard plate stays with the body; the hilt, guard and long blade turn with the pod's facing. */
function buildOdachi(ctx: ShogunKit, anchor: THREE.Group, def: PartDef): WeaponRig {
  const { kit, accent } = ctx;
  const radius = toWorld(def.rad);
  const muzzle = toWorld(def.muzzle);
  const [shell, trim] = partShells(kit);
  const steel = kit.accentMaterial(STEEL, STEEL_FILL, 1.75, 0.14, 1.5);
  const vent = kit.accentMaterial(ACCENT, ACCENT_FILL, 1.5, 0.12);
  const guardPlate = new THREE.CylinderGeometry(radius * 0.74, radius * 0.82, 1.2, 8);
  guardPlate.rotateX(Math.PI / 2);
  add(kit, anchor, guardPlate, shell, 0, 0, 3.8, 40);
  const gun = new THREE.Group();
  gun.rotation.order = 'ZYX';
  gun.position.z = ODACHI_Z;
  anchor.add(gun);
  add(kit, gun, shapeExtrude(cutRect(radius * 1.05, 2.3, 0.6), 1.5, 0.25), trim, -radius * 0.62, 0, 0, 40);
  add(kit, gun, lineGeometry(1.2, 2.9, 1.8), accent, -radius * 1.18, 0, 0, 30);
  const tsuba = ringGeometry(radius * 0.46, 0.7);
  tsuba.rotateY(Math.PI / 2);
  add(kit, gun, tsuba, accent, 0, 0, 0, 30);
  add(kit, gun, lineGeometry(1.4, 3.0, 1.6), vent, 1.0, 0, 0, 30);
  add(kit, gun, shapeExtrude(bladePoints(muzzle + 6, 5.0, 0.035), 0.8, 0.14), steel, 1.6, 0, 0, 34);
  add(kit, gun, shapeExtrude(bladePoints(muzzle + 2.5, 1.5, 0.035), 0.2, 0), vent, 3.0, -0.8, 0.6, 30);
  const glint = add(kit, gun, diamondGeometry(2.2, 0.6), steel, muzzle, 0, 0.5, 28);
  glint.rotation.x = 0.4;
  return { shells: [shell, trim], gun, gunZ: ODACHI_Z, steel, glint, vent, rig: null };
}

export function createShogun(): ColossusModel {
  const kit = createMechKit();
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  const accent = kit.accentMaterial(ACCENT, ACCENT_FILL, 1.8, 0.12);
  const glass = kit.glassMaterial(0xff9a7a, 0x170504);
  const cord = kit.accentMaterial(0xff7a60, 0x120403, 0.9, 0.06, 1.1);
  const coreMat = kit.accentMaterial(0xffd2c4, 0x2a0906, 2.1, 0.14);
  const massMat = kit.teamMaterial(0.34, 0.72, 0.42, 0x04090d, 0.42, 1.55);
  const ctx: ShogunKit = { kit, accent, glass };

  // The armoured mass under the body's plates; the great sword and the banners stand clear of it.
  const bodyParts: FormDef = { ...FORM, parts: FORM.parts.filter((part) => part.kind === PartKind.Armor || part.name.startsWith('blade')) };
  add(kit, body, bodyHullGeometry(bodyParts, MASS_MARGIN, MASS_DEPTH), massMat, 0, 0, 0.5, 78);
  const core = add(kit, body, new THREE.OctahedronGeometry(CORE_RADIUS * 0.62, 0), coreMat, 0, 0, CORE_Z, 28);
  const halo = add(kit, body, ringGeometry(CORE_RADIUS * 1.05, 0.22), glass, 0, 0, CORE_Z - 0.4, 28);
  const collapse = add(kit, body, ringGeometry(CORE_RADIUS * 3.2, 0.4), accent, 0, 0, CORE_Z + 1.2, 28);

  const flares: THREE.Mesh[] = [];
  const strutGeometry = kit.own(lineGeometry(1, 0.46, 0.2));
  const lineGeometryUnit = kit.own(lineGeometry(1, 1.1, 0.4));
  const parts: PartRig[] = FORM.parts.map((def) => {
    const anchor = new THREE.Group();
    body.add(anchor);
    const radius = toWorld(def.rad);
    const strut = kit.mesh(body, strutGeometry, cord, 0, 0, STRUT_Z, 58);
    const none = { gun: null, gunZ: 0, steel: null, glint: null, vent: null, rig: null };
    if (def.name === 'kabuto') return { def, anchor, strut, ...none, shells: buildKabuto(ctx, anchor, radius) };
    if (def.name === 'sodeL' || def.name === 'sodeR') {
      const sode = buildSode(ctx, anchor, radius, sideOf(def));
      return { def, anchor, strut, ...none, shells: sode.shells, rig: sode.rig };
    }
    if (def.name === 'dou') return { def, anchor, strut, ...none, shells: buildDou(ctx, anchor, radius, flares) };
    if (def.name === 'bladeL' || def.name === 'bladeR') return { def, anchor, strut, ...buildArmBlade(ctx, anchor, def) };
    if (def.name.startsWith('banner')) return { def, anchor, strut, ...buildBanner(ctx, anchor, def) };
    if (def.name === 'odachi') return { def, anchor, strut, ...buildOdachi(ctx, anchor, def) };
    throw new RangeError(`SHOGUN's model has no drawing for part ${def.name}`);
  });
  const ultimaLines = FORM.ultimaPods.map((k) => {
    const line = kit.mesh(body, lineGeometryUnit, accent, 0, 0, CORE_Z + 0.6, 40);
    line.rotation.z = Math.atan2(toWorld(FORM.parts[k].y), toWorld(FORM.parts[k].x));
    line.visible = false;
    return line;
  });

  return {
    root,
    setTeam(color) {
      kit.setTeam(color);
    },
    update(pose: ColossusPose) {
      const assemble = smooth01(pose.assemble);
      const windup = pose.phase === AttackPhase.Windup;
      const release = pose.phase === AttackPhase.Release;
      const siegeBrace = pose.attack === Attack.Siege && windup ? smooth01(pose.progress) : 0;
      const ultimaWindup = pose.attack === Attack.Ultima && windup ? smooth01(pose.progress) : 0;
      const ultimaRelease = pose.attack === Attack.Ultima && release ? 1 : 0;
      const unfurl = Math.max(ultimaWindup, ultimaRelease);
      const recovery = pose.phase === AttackPhase.Recovery ? 1 - pose.progress : 0;
      const firingRole = release ? roleOf(pose.attack) : 0;
      body.rotation.z = pose.body;
      body.position.z = Math.sin(pose.time * 1.1) * 0.18 - siegeBrace * 1.3;
      core.scale.setScalar(0.5 + assemble * (0.3 + pose.fuel * 0.28));
      core.rotation.z = pose.time * 0.5;
      halo.visible = assemble > 0.08;
      halo.scale.setScalar(0.8 + assemble * 0.25 + unfurl * 0.2);
      halo.rotation.z = -pose.time * 0.3;
      collapse.visible = ultimaWindup > 0.01;
      collapse.scale.setScalar(lerp(1.25, 0.45, ultimaWindup));
      collapse.rotation.z = pose.time * 0.6;

      applyColossusVectorState(kit, pose.time, pose.hit, pose.fuel, assemble);
      massMat.uniforms.uOpacity.value = 0.44;
      massMat.uniforms.uFlash.value = pose.hit * 0.1;
      massMat.uniforms.uPulse.value = 0;

      for (let k = 0; k < parts.length; k++) {
        const part = parts[k];
        const partPose: PartPose = pose.parts[k];
        const ease = staggered(assemble, k * ASSEMBLE_STEP);
        const shown = partPose.hp > 0 && ease > 0.02;
        part.anchor.visible = shown;
        part.strut.visible = shown;
        if (!shown) continue;
        const homeX = toWorld(part.def.x);
        const homeY = toWorld(part.def.y);
        const arc = Math.sin(ease * Math.PI);
        const x = homeX * ease - homeY * ASSEMBLE_ARC_SWAY * arc;
        const y = homeY * ease + homeX * ASSEMBLE_ARC_SWAY * arc;
        part.anchor.position.set(x, y, (1 - ease) * 4 + arc * ASSEMBLE_ARC_HEIGHT);
        part.strut.position.set(x * 0.5, y * 0.5, STRUT_Z);
        part.strut.scale.x = Math.max(0.01, Math.hypot(x, y));
        part.strut.rotation.z = Math.atan2(y, x);
        const weak = partPose.hp < WEAK_HP ? 0.12 + 0.08 * Math.sin(pose.time * 13 + k) : 0;
        for (const shell of part.shells) {
          shell.uniforms.uFlash.value = Math.max(partPose.flash * PART_FLASH, pose.hit * 0.28);
          shell.uniforms.uPulse.value += weak;
        }
        if (part.rig !== null && part.def.kind === PartKind.Armor) {
          const side = sideOf(part.def);
          part.rig.rotation.x = -side * (0.36 + siegeBrace * 0.1 - unfurl * 0.12);
          part.rig.position.x = siegeBrace * 1.2;
        }
        if (part.gun === null || part.steel === null || part.glint === null || part.vent === null) continue;
        // Through its release a firing pod's weapon stays raised and blazing (a beam's sweep, the ultima's barrage).
        const firing = (part.def.roles & firingRole) !== 0 ? 1 : 0;
        const charge = Math.max(smooth01(partPose.charge), firing);
        part.gun.rotation.z = partPose.facing - pose.body;
        part.gun.rotation.y = -charge * TELL_TIP;
        part.gun.position.z = part.gunZ + charge * TELL_RISE;
        part.glint.visible = charge > 0.02;
        part.glint.scale.setScalar(0.6 + charge * 1.6 + firing * 0.5 * (0.5 + 0.5 * Math.sin(pose.time * 40)));
        part.steel.uniforms.uPulse.value += charge * 0.9 + firing * 0.5 + partPose.heat * 0.3;
        part.steel.uniforms.uOpacity.value = 0.9;
        part.vent.uniforms.uPulse.value += partPose.heat * 0.8 + recovery * 0.1 + charge * 0.3;
        part.vent.uniforms.uOpacity.value = 0.35 + partPose.heat * 0.6 + charge * 0.4;
        part.vent.uniforms.uFlash.value = partPose.flash * PART_FLASH;
        if (part.rig !== null) part.rig.rotation.y = FLAG_LEAN - unfurl * FLAG_RAISE;
      }
      for (let i = 0; i < ultimaLines.length; i++) {
        const k = FORM.ultimaPods[i];
        const line = ultimaLines[i];
        line.visible = ultimaWindup > 0.02 && pose.parts[k].hp > 0;
        line.scale.x = Math.max(0.01, Math.hypot(toWorld(FORM.parts[k].x), toWorld(FORM.parts[k].y)) * ultimaWindup);
        line.position.set(Math.cos(line.rotation.z) * line.scale.x * 0.5, Math.sin(line.rotation.z) * line.scale.x * 0.5, CORE_Z + 0.6);
      }
      for (const flare of flares) flare.scale.set(1.2 + pose.speed * 1.6, 0.8 + pose.speed * 0.4, 1);
      accent.uniforms.uOpacity.value = 0.9;
      accent.uniforms.uPulse.value += unfurl * 0.3 + siegeBrace * 0.1;
      coreMat.uniforms.uPulse.value += 0.1 + (1 - pose.fuel) * 0.2 + unfurl * 0.3;
      glass.uniforms.uOpacity.value = 0.16 + pose.speed * 0.3 + unfurl * 0.2;
      cord.uniforms.uOpacity.value = 0.14 + unfurl * 0.22;
    },
    dispose() {
      kit.dispose();
    },
  };
}
