import * as THREE from 'three';
import type { VectorMaterial } from '../../render/vector.ts';
import { Attack, AttackPhase, FORMS, FRAME_STATS, Frame, PartKind } from '../../sim/index.ts';
import type { FormDef, PartDef } from '../../sim/index.ts';
import {
  applyColossusVectorState,
  applyRobotVectorState,
  createMechKit,
  diamondGeometry,
  finGeometry,
  lineGeometry,
  plateGeometry,
  ringGeometry,
  shapeExtrude,
  type MechKit,
} from './kit-mechs.ts';
import { bodyHullGeometry } from './kit-hull.ts';
import { clamp01, easeOutCubic, lerp, smooth01, toWorld } from '../shared.ts';
import type { ColossusModel, ColossusPose, PartPose, RobotModel, RobotPose } from './types.ts';

/*
 * GAUNTLET, the super robot brawler, and ATLAS, its colossus (contract: view/models/types.ts).
 *
 * GAUNTLET: two oversized fists held up in a boxer's guard, a gold V-crest on a small head, a broad chest with a red breast
 * chevron and a gold emblem, shoulder pylons, stocky legs that stomp along the direction of travel. Each knuckle shot is a jab
 * of the arm it left from (`side`, `fire`); the rocket punch launches the LEFT fist (the `alt` pulse) and, while it is out
 * (`special`), the left arm stays thrust forward with an empty, glowing wrist port.
 *
 * ATLAS: a giant super robot bust charging forward: the V-crest head in front, a massive chest, shoulder pauldrons with
 * pylons, back armour with twin boosters, and two giant fists on its arms, every part exactly at its FORMS offset and radius.
 * The fists wind back and glow through a wind-up (the giga rocket punch lights their wrist rockets), punch out as a knuckle
 * barrage cools, and while a giga fist is in flight (`away`) its arm ends in an empty, glowing wrist.
 */

const GOLD = 0xffc247;
const GOLD_FILL = 0x1d1304;
const RED = 0xff4b38;
const RED_FILL = 0x1f0605;
const HOT = 0xff8a3d;
const HOT_FILL = 0x230a02;
const EYE = 0xffe28c;
const EYE_FILL = 0x160c02;

/** RobotPose.side of the left arm (+y, the rocket fist's) and of the right arm (-y). */
const LEFT = 1;
const RIGHT = -1;
const ARM_SIDES = [LEFT, RIGHT] as const;

// ---- GAUNTLET (model units; the ship view scales the whole robot) ------------------------------------------------------
const ROBOT_RADIUS = toWorld(FRAME_STATS[Frame.Gauntlet].bodyR);
const TORSO_Z = 4.4;
const HEAD_X = 1.7;
const HEAD_Z = TORSO_Z + 3.3;
const SHOULDER_X = 0.3;
const SHOULDER_Y = 6.7;
const ARM_X = 0.8;
const ARM_Y = 6.1;
const ARM_Z = 4.3;
/** The upper arm's length; where the fist sits along the arm, from the shoulder joint, and its size: bigger than the head. */
const UPPER_ARM_LENGTH = 3;
const FIST_X = 8.9;
const FIST_LENGTH = 4.6;
const FIST_WIDTH = 5;
const HIP_X = -3.2;
const HIP_Y = 3.9;
const HIP_Z = 2.4;
const BREATH_RATE = 2.6;
const BREATH_HEIGHT = 0.12;
const BANK_TILT = 0.12;
const MOVE_LEAN = 0.05;
/** The fists bob in the guard. */
const GUARD_BOB_RATE = 3.4;
const GUARD_BOB = 0.14;
/** Arms turn in toward the aim line: at rest, and more on a jab (a straight punch to the centre). */
const ARM_TOE_IN = 0.07;
const JAB_TOE_IN = 0.14;
/** A jab: how far the arm shoots forward, how long it stays out (fire is scaled by this before easing) and the torso twist. */
const JAB_REACH = 2.4;
const JAB_HOLD = 1.6;
const JAB_TWIST = 0.1;
/** The other arm pulls back as one jabs. */
const COUNTER_PULL = 0.6;
/** The left arm thrusts on the rocket punch's launch and stays forward, pointing, while its fist is out. */
const LAUNCH_THRUST = 1.4;
const AWAY_REACH = 1;
const AWAY_TOE_IN = 0.1;
/** Heavy steps: a steady cadence (radians per second), stride and lift scaled by speed, the body dipping on each stomp. */
const STRIDE_RATE = 9;
const STRIDE_LENGTH = 1.9;
const STRIDE_LIFT = 0.6;
const STOMP_DIP = 0.22;
const THRUSTER_IDLE = 1.4;
const THRUSTER_SPEED = 2.6;

// ---- ATLAS (world units, body space) -------------------------------------------------------------------------------------
const FORM = FORMS[Frame.Gauntlet];
const CORE_RADIUS = toWorld(FORM.coreR);
const ASSEMBLE_STEP = 0.07;
const ASSEMBLE_ARC_HEIGHT = 6;
const ASSEMBLE_ARC_SWAY = 0.14;
const ASSEMBLE_MIN_SCALE = 0.5;
const MASS_MARGIN = 3.2;
const MASS_DEPTH = 6.4;
const MASS_Z = 0.8;
const CORE_Z = 6.2;
const UPPER_ARM_Z = 4.6;
const FRAME_Z = 4.2;
const FRAME_HEIGHT = 3.6;
const FRAME_MIN_SCALE = 0.3;
const ARM_MIN_SCALE = 0.05;
const LINE_Z = 7.4;
/** Heights of the parts' anchors: the head and the fists ride highest, the back and the boosters lowest. */
const CREST_Z = 12.5;
const CHEST_Z = 9;
const FIST_Z = 9.4;
const SHOULDER_Z = 8.4;
const BACK_Z = 7;
const BOOSTER_Z = 6;
/** A fist winds back this share of its radius through a wind-up and punches out this share as a knuckle barrage cools. */
const FIST_WIND = 0.34;
const FIST_PUNCH = 0.42;
/** A giant fist's centre, and the elbow at the back of its forearm, as shares of its pod's radius from the pod's centre. */
const FIST_CENTER = 0.1;
const ELBOW_BACK = 1.3;
/** Shoulder pylons rise when the ultima unfolds the machine. */
const PYLON_PITCH = 0.5;
const PYLON_RAISE = 0.38;
/** The siege wind-up braces the body: it crouches and leans into the punch, then rocks back through the recovery. */
const SIEGE_CROUCH = 1.6;
const SIEGE_LEAN = 0.035;
const RECOIL_LEAN = 0.045;
/** Crease angles: big plates show their bevels, pods their main facets, small details only their outline. */
const SHELL_CREASE = 28;
const POD_CREASE = 36;
const DETAIL_CREASE = 40;
/** A part below this share of its health flickers. */
const WEAK_HP = 0.35;
const PART_FLASH = 0.42;

type Shape = ReadonlyArray<readonly [number, number]>;

/** Points of `shape` scaled by `s`. */
function scaled(shape: Shape, s: number): Array<[number, number]> {
  return shape.map(([x, y]) => [x * s, y * s]);
}

/** A fist's knuckles, and how deep the dips between them are (a share of its length). */
const KNUCKLES = 4;
const KNUCKLE_DIP = 0.12;

/**
 * A clenched fist seen from above (+x forward): a block whose front edge is four knuckles. Centred on the origin: `length`
 * along x, `width` across, `depth` tall.
 */
function fistGeometry(length: number, width: number, depth: number, bevel: number): THREE.BufferGeometry {
  const back = -length * 0.5;
  const front = length * 0.5;
  const half = width * 0.5;
  const knuckle = width / KNUCKLES;
  const dip = length * KNUCKLE_DIP;
  const corner = length * 0.14;
  const points: Array<[number, number]> = [[back, -half + corner], [back + corner, -half], [front - dip, -half]];
  for (let i = 0; i < KNUCKLES; i++) {
    const y = -half + knuckle * i;
    points.push([front, y + knuckle * 0.24], [front, y + knuckle * 0.76]);
    if (i < KNUCKLES - 1) points.push([front - dip * 0.55, y + knuckle]);
  }
  points.push([front - dip, half], [back + corner, half], [back, half - corner]);
  return shapeExtrude(points, depth, bevel);
}

/** A V seen from above, its point toward -x: `length` from the point to the tips, `span` between the tips, arms `bar` thick. */
function chevronGeometry(length: number, span: number, bar: number, depth: number): THREE.BufferGeometry {
  const half = span * 0.5;
  const tip = length * 0.5;
  return shapeExtrude([
    [-tip, 0], [tip, half], [tip + bar * 0.4, half - bar], [-tip + bar, 0], [tip + bar * 0.4, -half + bar], [tip, -half],
  ], depth, 0.12);
}

/** A blade seen from above, rooted at the origin and reaching `length` along +x: wide at the root, a raked point at the tip. */
function bladeGeometry(length: number, width: number, depth: number): THREE.BufferGeometry {
  return shapeExtrude([[0, -width * 0.5], [length * 0.7, -width * 0.3], [length, width * 0.1], [length * 0.62, width * 0.42], [0, width * 0.5]], depth, 0.1);
}

/** A blade rooted at (x, y, z) that points `yaw` from +x and rises `pitch` above the floor; returns the group that pitches it. */
function raisedBlade(
  kit: MechKit, parent: THREE.Object3D, material: VectorMaterial, length: number, width: number, depth: number,
  x: number, y: number, z: number, yaw: number, pitch: number,
): THREE.Group {
  const heading = new THREE.Group();
  heading.position.set(x, y, z);
  heading.rotation.z = yaw;
  parent.add(heading);
  const lift = new THREE.Group();
  lift.rotation.y = -pitch;
  heading.add(lift);
  kit.mesh(lift, kit.own(bladeGeometry(length, width, depth)), material, 0, 0, 0, 36);
  return lift;
}

/** A thruster bell pointing -x: wide mouth behind, narrow throat forward. */
function bellGeometry(length: number, mouth: number, throat: number): THREE.BufferGeometry {
  const geometry = new THREE.CylinderGeometry(mouth, throat, length, 8, 1, true);
  geometry.rotateZ(Math.PI * 0.5);
  return geometry;
}

interface ArmRig {
  readonly side: number;
  /** Pivots at the shoulder (turns the arm in). */
  readonly arm: THREE.Group;
  /** Stretches from the shoulder as the forearm shoots out. */
  readonly upperArm: THREE.Mesh;
  /** Forearm, cuff and fist: slides out along the arm on a jab. */
  readonly reach: THREE.Group;
  readonly fist: THREE.Group;
  readonly flash: THREE.Mesh;
}

/** GAUNTLET's arm on `side`, pivoting at the shoulder: upper arm, gauntlet forearm, red cuff and the oversized fist. */
function buildArm(kit: MechKit, parent: THREE.Object3D, side: number, frame: VectorMaterial, armor: VectorMaterial, plate: VectorMaterial, gold: VectorMaterial, red: VectorMaterial, hot: VectorMaterial): ArmRig {
  const arm = new THREE.Group();
  arm.position.set(ARM_X, side * ARM_Y, ARM_Z);
  parent.add(arm);
  const upperArm = kit.mesh(arm, kit.own(plateGeometry(UPPER_ARM_LENGTH, 2.1, 2.1, 0.16)), frame, UPPER_ARM_LENGTH * 0.5, 0, 0, 50);
  const reach = new THREE.Group();
  arm.add(reach);
  kit.mesh(reach, kit.own(shapeExtrude([[0, -1.05], [4, -1.4], [4, 1.4], [0, 1.05]], 2.3, 0.3)), armor, 2.8, 0, 0.2, 44);
  kit.mesh(reach, kit.own(plateGeometry(0.8, 3.4, 2.8, 0.12)), red, 6.9, 0, 0.2, 44);
  const fist = new THREE.Group();
  fist.position.set(FIST_X, 0, 0.35);
  reach.add(fist);
  kit.mesh(fist, kit.own(fistGeometry(FIST_LENGTH, FIST_WIDTH, 3.4, 0.3)), plate, 0, 0, 0, 40);
  kit.mesh(fist, kit.own(plateGeometry(0.9, FIST_WIDTH - 0.3, 0.45, 0.1)), gold, FIST_LENGTH * 0.3, 0, 1.85, 40);
  for (let k = 1; k < KNUCKLES; k++) kit.mesh(fist, kit.own(lineGeometry(1.7, 0.16, 0.2)), frame, -0.1, (k / KNUCKLES - 0.5) * FIST_WIDTH, 1.85, 30);
  kit.mesh(fist, kit.own(plateGeometry(2, 1.1, 1.4, 0.2)), armor, 0.5, -side * FIST_WIDTH * 0.56, -0.4, 44);
  const flash = kit.mesh(fist, kit.own(diamondGeometry(0.8, 0.3)), hot, FIST_LENGTH * 0.5 + 0.9, 0, 0.3, 30);
  flash.visible = false;
  return { side, arm, upperArm, reach, fist, flash };
}

export function createGauntlet(): RobotModel {
  const kit = createMechKit();
  const root = new THREE.Group();
  const body = new THREE.Group();
  const upper = new THREE.Group();
  const legRig = new THREE.Group();
  root.add(body);
  body.add(legRig, upper);

  const armor = kit.teamMaterial(0.46, 0.9, 1.22, 0x08131d, 0.6, 1.7);
  const plate = kit.teamMaterial(0.64, 0.68, 1.45, 0x0b1a28, 0.56, 1.65);
  const frame = kit.teamMaterial(0.34, 0.82, 0.95, 0x050b11, 0.62, 1.45);
  const gold = kit.accentMaterial(GOLD, GOLD_FILL, 1.75, 0.16);
  const red = kit.accentMaterial(RED, RED_FILL, 1.6, 0.18);
  const hot = kit.accentMaterial(HOT, HOT_FILL, 2.1, 0.2);
  const eyes = kit.glassMaterial(EYE, EYE_FILL);
  const shell = kit.glassMaterial(0xbfe9ff, 0x03101a);

  // Torso: a broad chest over a narrower waist, the chest plate, the red breast chevron with the gold emblem at its point.
  kit.mesh(upper, kit.own(shapeExtrude([[3.8, -2.9], [3.8, 2.9], [2.3, 5.5], [-1, 5.9], [-3.3, 3.2], [-3.3, -3.2], [-1, -5.9], [2.3, -5.5]], 3.2, 0.45)), armor, 0, 0, TORSO_Z, 50);
  kit.mesh(upper, kit.own(shapeExtrude([[3.5, -2.2], [3.5, 2.2], [2, 4.6], [-0.6, 4.8], [-2.2, 2.4], [-2.2, -2.4], [-0.6, -4.8], [2, -4.6]], 1, 0.3)), plate, 0, 0, TORSO_Z + 2.1, 50);
  kit.mesh(upper, kit.own(chevronGeometry(3.4, 9, 1.2, 0.5)), red, -0.9, 0, TORSO_Z + 2.8, 40);
  const emblem = kit.mesh(upper, kit.own(diamondGeometry(0.75, 0.3)), gold, -2.2, 0, TORSO_Z + 3.05, 30);
  emblem.scale.set(1, 0.8, 1);
  kit.mesh(body, kit.own(plateGeometry(3, 5.4, 2, 0.2)), frame, HIP_X + 0.4, 0, HIP_Z + 0.4, 50);

  // Head: helmet, faceplate, visor eyes, the red forehead jewel and the gold V-crest horns.
  const head = new THREE.Group();
  head.position.set(HEAD_X, 0, HEAD_Z);
  upper.add(head);
  kit.mesh(head, kit.own(shapeExtrude([[-1.3, -1.05], [0.5, -1.25], [1.35, -0.6], [1.35, 0.6], [0.5, 1.25], [-1.3, 1.05]], 1.6, 0.28)), armor, 0, 0, 0, 44);
  kit.mesh(head, kit.own(shapeExtrude([[-1, -0.55], [0.7, -0.7], [0.7, 0.7], [-1, 0.55]], 0.4, 0.15)), plate, -0.15, 0, 0.95, 44);
  kit.mesh(head, kit.own(plateGeometry(0.7, 1.3, 1, 0.2)), frame, 1.35, 0, -0.45, 44);
  kit.mesh(head, kit.own(lineGeometry(0.3, 1.6, 0.22)), eyes, 1.15, 0, 0.55, 30);
  kit.mesh(head, kit.own(diamondGeometry(0.42, 0.25)), red, 0.95, 0, 1, 30);
  for (const side of ARM_SIDES) raisedBlade(kit, head, gold, 3.4, 0.9, 0.26, 0.9, side * 0.3, 0.95, side * 0.62, 0.42);

  // Shoulders: pauldrons with red pylons swept up and out.
  for (const side of ARM_SIDES) {
    const pauldron = kit.mesh(upper, kit.own(plateGeometry(4.8, 4, 2.4, 0.2)), plate, SHOULDER_X, side * SHOULDER_Y, TORSO_Z + 1.6, 50);
    pauldron.rotation.z = side * 0.12;
    raisedBlade(kit, upper, red, 4.2, 2, 0.5, SHOULDER_X - 1, side * (SHOULDER_Y + 0.4), TORSO_Z + 2.7, side * (Math.PI * 0.5 + 0.35), 0.5);
  }

  const arms = ARM_SIDES.map((side) => buildArm(kit, upper, side, frame, armor, plate, gold, red, hot));
  const leftArm = arms[0];

  // The left wrist's port: shown while the rocket fist is out (and flaring as it launches).
  const port = new THREE.Group();
  port.position.set(7.7, 0, 0.3);
  leftArm.reach.add(port);
  const portRing = kit.mesh(port, kit.own(ringGeometry(1.2, 0.28)), hot, 0, 0, 0, 30);
  portRing.rotation.y = Math.PI * 0.32;
  kit.mesh(port, kit.own(diamondGeometry(0.9, 0.5)), hot, 0.3, 0, 0, 30);
  const launchFlame = kit.mesh(port, kit.own(finGeometry(4.2, 1.8, 0.3)), hot, 2.3, 0, 0.2, 30);

  // Stocky legs: thigh and boot, stepping along the direction of travel.
  const legs = ARM_SIDES.map((side) => {
    const hip = new THREE.Group();
    hip.position.set(HIP_X, side * HIP_Y, HIP_Z);
    legRig.add(hip);
    const leg = new THREE.Group();
    hip.add(leg);
    kit.mesh(leg, kit.own(plateGeometry(2.4, 2.2, 2.6, 0.16)), frame, 0, 0, 0, 50);
    kit.mesh(leg, kit.own(shapeExtrude([[-2, -1.35], [1.4, -1.5], [2.6, -0.9], [2.6, 0.9], [1.4, 1.5], [-2, 1.35]], 1.5, 0.25)), armor, 0.5, 0, -1.7, 44);
    return leg;
  });

  // Backpack with twin thrusters.
  kit.mesh(upper, kit.own(plateGeometry(2.8, 4.8, 3, 0.2)), plate, -3.6, 0, TORSO_Z + 1.4, 50);
  const flames = ARM_SIDES.map((side) => {
    kit.mesh(upper, kit.own(bellGeometry(2.2, 0.95, 0.7)), frame, -5, side * 1.5, TORSO_Z + 1, 36);
    return kit.mesh(upper, kit.own(diamondGeometry(0.55, 0.2)), hot, -6.6, side * 1.5, TORSO_Z + 1, 30);
  });

  const shellRing = kit.mesh(root, kit.own(ringGeometry(ROBOT_RADIUS * 1.02, 0.18)), shell, 0, 0, 0.75, 24);
  shellRing.visible = false;

  return {
    root,
    setTeam(color) {
      kit.setTeam(color);
    },
    update(pose: RobotPose) {
      const morph = smooth01(pose.morph);
      const relative = pose.move - pose.aim;
      const bank = Math.sin(relative) * pose.speed;
      const step = pose.time * STRIDE_RATE;
      const stomp = Math.abs(Math.sin(step)) * pose.speed;
      root.rotation.z = pose.aim;
      root.scale.set(1 - morph * 0.72, 1 - morph * 0.3, 1 - morph * 0.5);
      root.position.z = Math.sin(pose.time * BREATH_RATE) * BREATH_HEIGHT - stomp * STOMP_DIP;
      body.rotation.x = bank * BANK_TILT;
      body.rotation.y = -Math.cos(relative) * pose.speed * MOVE_LEAN;

      const strideX = Math.cos(relative) * STRIDE_LENGTH * pose.speed;
      const strideY = Math.sin(relative) * STRIDE_LENGTH * pose.speed;
      for (let i = 0; i < legs.length; i++) {
        const phase = step + i * Math.PI;
        const swing = Math.sin(phase);
        legs[i].position.set(strideX * swing, strideY * swing, Math.max(0, Math.cos(phase)) * STRIDE_LIFT * pose.speed);
      }

      const jab = smooth01(pose.fire * JAB_HOLD);
      const launch = clamp01(pose.alt);
      const away = pose.special > 0.5;
      upper.rotation.z = -pose.side * jab * JAB_TWIST;
      for (const rig of arms) {
        const punching = pose.side === rig.side ? jab : 0;
        const pulled = pose.side === -rig.side ? jab : 0;
        const rocket = rig.side === LEFT ? launch * LAUNCH_THRUST + (away ? AWAY_REACH : 0) : 0;
        const extend = punching * JAB_REACH - pulled * COUNTER_PULL + rocket;
        rig.reach.position.x = extend;
        rig.upperArm.scale.x = (UPPER_ARM_LENGTH + extend) / UPPER_ARM_LENGTH;
        rig.upperArm.position.x = (UPPER_ARM_LENGTH + extend) * 0.5;
        rig.arm.position.z = ARM_Z + Math.sin(pose.time * GUARD_BOB_RATE + rig.side) * GUARD_BOB;
        rig.arm.rotation.z = -rig.side * (ARM_TOE_IN + punching * JAB_TOE_IN + (rig.side === LEFT && away ? AWAY_TOE_IN : 0));
        rig.flash.visible = punching > 0.05;
        rig.flash.scale.setScalar(0.6 + punching * 0.9);
      }
      leftArm.fist.visible = !away;
      port.visible = away || launch > 0.02;
      launchFlame.visible = launch > 0.02;
      launchFlame.scale.set(0.4 + launch * 0.9, 0.6 + launch * 0.5, 1);
      for (const flame of flames) flame.scale.set(THRUSTER_IDLE + pose.speed * THRUSTER_SPEED, 0.8 + pose.speed * 0.3, 1);

      shellRing.visible = pose.shield > 0.03;
      shellRing.scale.setScalar(1 + pose.shield * 0.08);
      shellRing.rotation.z = pose.time * 0.7;
      applyRobotVectorState(kit, pose.time, pose.hit, pose.charge, pose.shield, morph);
      const fade = lerp(1, 0.2, morph);
      gold.uniforms.uPulse.value += jab * 0.2 + launch * 0.3;
      red.uniforms.uPulse.value += launch * 0.2;
      hot.uniforms.uPulse.value += (away ? 0.45 + 0.25 * Math.sin(pose.time * 16) : 0) + launch * 0.6 + jab * 0.3 + pose.speed * 0.15;
      gold.uniforms.uOpacity.value = fade;
      red.uniforms.uOpacity.value = fade;
      hot.uniforms.uOpacity.value = fade;
      eyes.uniforms.uOpacity.value = lerp(0.9, 0.2, morph);
      shell.uniforms.uOpacity.value = 0.14 + pose.shield * 0.2;
    },
    dispose() {
      kit.dispose();
    },
  };
}

// ---- ATLAS -------------------------------------------------------------------------------------------------------------

/** What every part of ATLAS reacts to this frame, besides its own PartPose. */
interface AtlasFrame {
  readonly time: number;
  readonly body: number;
  readonly speed: number;
  /** The ultima: 0 -> 1 through its wind-up, 1 through the barrage (the machine opens up and lights). */
  readonly unfold: number;
  /** The giga rocket punch's wind-up, 0 -> 1 (the wrist rockets ignite). */
  readonly siege: number;
  /** The knuckle barrage is the attack in progress (its fists punch out as they cool). */
  readonly salvo: boolean;
}

interface AtlasPart {
  readonly index: number;
  readonly def: PartDef;
  readonly anchor: THREE.Group;
  /** The anchor's height once assembled. */
  readonly height: number;
  /** A fist pod's sliding forearm (the elbow at its back is where the upper arm meets it); null for every other part. */
  readonly slide: THREE.Group | null;
  /** This part's own hull materials (its hit flash and damage flicker). */
  readonly hull: readonly VectorMaterial[];
  animate(part: PartPose, frame: AtlasFrame): void;
}

interface PartKit {
  readonly kit: MechKit;
  readonly gold: VectorMaterial;
  readonly red: VectorMaterial;
  readonly eyes: VectorMaterial;
}

function staggered(value: number, start: number): number {
  return easeOutCubic((value - start) / (1 - start));
}

/** Which side of the body a part is on: 1 left (+y), -1 right. */
function sideOf(def: PartDef): number {
  return def.y > 0 ? LEFT : RIGHT;
}

function partHull(kit: MechKit): { hull: VectorMaterial; trim: VectorMaterial } {
  return {
    hull: kit.teamMaterial(0.5, 0.92, 1.3, 0x07131b, 0.5, 1.6),
    trim: kit.teamMaterial(0.66, 0.72, 1.5, 0x0b1621, 0.34, 1.45),
  };
}

function chestPart(p: PartKit, anchor: THREE.Group, r: number): (part: PartPose, frame: AtlasFrame) => void {
  const { kit } = p;
  const { hull, trim } = partHull(kit);
  kit.mesh(anchor, kit.own(shapeExtrude(scaled([[0.84, -0.52], [0.84, 0.52], [0.32, 0.95], [-0.66, 0.84], [-0.92, 0.34], [-0.92, -0.34], [-0.66, -0.84], [0.32, -0.95]], r), r * 0.3, 0.9)), hull, 0, 0, 0, SHELL_CREASE);
  const pecs = ARM_SIDES.map((side) => {
    const pec = new THREE.Group();
    anchor.add(pec);
    kit.mesh(pec, kit.own(shapeExtrude(scaled([[0.64, 0.07 * side], [0.64, 0.58 * side], [0.18, 0.8 * side], [-0.42, 0.6 * side], [-0.42, 0.07 * side]], r), r * 0.1, 0.5)), trim, 0, 0, r * 0.22, SHELL_CREASE);
    return pec;
  });
  kit.mesh(anchor, kit.own(plateGeometry(r * 0.16, r * 0.56, r * 0.1, 0.2)), trim, r * 0.76, 0, r * 0.2, DETAIL_CREASE);
  kit.mesh(anchor, kit.own(chevronGeometry(r * 0.8, r * 1.5, r * 0.22, r * 0.06)), p.red, -r * 0.16, 0, r * 0.34, DETAIL_CREASE);
  const emblem = kit.mesh(anchor, kit.own(diamondGeometry(r * 0.15, r * 0.05)), p.gold, -r * 0.6, 0, r * 0.38, 30);
  return (_part, frame) => {
    for (let i = 0; i < pecs.length; i++) pecs[i].position.y = ARM_SIDES[i] * frame.unfold * r * 0.07;
    emblem.scale.setScalar(1 + frame.unfold * (0.3 + 0.2 * Math.sin(frame.time * 8)));
  };
}

function crestPart(p: PartKit, anchor: THREE.Group, r: number): (part: PartPose, frame: AtlasFrame) => void {
  const { kit } = p;
  const { hull, trim } = partHull(kit);
  kit.mesh(anchor, kit.own(shapeExtrude(scaled([[-0.78, -0.66], [0.3, -0.74], [0.88, -0.34], [0.88, 0.34], [0.3, 0.74], [-0.78, 0.66]], r), r * 0.46, 0.5)), hull, 0, 0, 0, SHELL_CREASE);
  kit.mesh(anchor, kit.own(shapeExtrude(scaled([[-0.6, -0.4], [0.4, -0.46], [0.4, 0.46], [-0.6, 0.4]], r), r * 0.12, 0.3)), trim, -r * 0.1, 0, r * 0.3, DETAIL_CREASE);
  kit.mesh(anchor, kit.own(plateGeometry(r * 0.3, r * 0.8, r * 0.3, 0.2)), trim, r * 0.74, 0, -r * 0.12, DETAIL_CREASE);
  const visor = kit.mesh(anchor, kit.own(lineGeometry(r * 0.14, r * 0.92, r * 0.1)), p.eyes, r * 0.6, 0, r * 0.22, 30);
  kit.mesh(anchor, kit.own(diamondGeometry(r * 0.16, r * 0.08)), p.red, r * 0.3, 0, r * 0.42, 30);
  for (const side of ARM_SIDES) raisedBlade(kit, anchor, p.gold, r * 1.02, r * 0.38, r * 0.08, r * 0.12, side * r * 0.08, r * 0.4, side * 0.66, 0.42);
  return (_part, frame) => {
    visor.scale.set(1, 1 + frame.unfold * 0.12, 1 + frame.unfold * 0.5);
  };
}

/** A pauldron seen from above, for the left shoulder (+y outward): flat against the body, rounded outside. */
const PAULDRON: Shape = [[0.62, -0.74], [0.86, -0.3], [0.9, 0.12], [0.72, 0.56], [0.34, 0.86], [-0.14, 0.94], [-0.58, 0.8], [-0.86, 0.42], [-0.9, -0.1], [-0.74, -0.74]];

function shoulderPart(p: PartKit, anchor: THREE.Group, r: number, side: number): (part: PartPose, frame: AtlasFrame) => void {
  const { kit } = p;
  const { hull, trim } = partHull(kit);
  const outline = PAULDRON.map(([x, y]) => [x, y * side] as const);
  kit.mesh(anchor, kit.own(shapeExtrude(scaled(outline, r), r * 0.34, 0.9)), hull, 0, 0, 0, SHELL_CREASE);
  kit.mesh(anchor, kit.own(shapeExtrude(scaled(outline, r * 0.64), r * 0.1, 0.5)), trim, -r * 0.04, side * r * 0.06, r * 0.24, SHELL_CREASE);
  const pylon = raisedBlade(kit, anchor, p.red, r * 0.74, r * 0.5, r * 0.12, -r * 0.12, side * r * 0.28, r * 0.36, side * (Math.PI * 0.5 + 0.35), PYLON_PITCH);
  kit.mesh(pylon, kit.own(lineGeometry(r * 0.5, r * 0.06, r * 0.06)), p.gold, r * 0.3, -r * 0.08, r * 0.1, 30);
  return (_part, frame) => {
    pylon.rotation.y = -(PYLON_PITCH + frame.unfold * PYLON_RAISE);
  };
}

function backPart(p: PartKit, anchor: THREE.Group, r: number): (part: PartPose, frame: AtlasFrame) => void {
  const { kit } = p;
  const { hull, trim } = partHull(kit);
  kit.mesh(anchor, kit.own(shapeExtrude(scaled([[0.62, -0.72], [0.62, 0.72], [-0.36, 0.9], [-0.9, 0.52], [-0.9, -0.52], [-0.36, -0.9]], r), r * 0.3, 0.9)), hull, 0, 0, 0, SHELL_CREASE);
  const ribs = [-1, 0, 1].map((k) => kit.mesh(anchor, kit.own(plateGeometry(r * (k === 0 ? 1.2 : 0.9), r * 0.12, r * 0.14, 0.1)), trim, -r * 0.14, k * r * 0.38, r * 0.2, DETAIL_CREASE));
  for (const k of [-1, 1]) kit.mesh(anchor, kit.own(plateGeometry(r * 0.08, r * 0.46, r * 0.05, 0.1)), p.gold, -r * 0.62, k * r * 0.2, r * 0.2, 30);
  return (_part, frame) => {
    for (const rib of ribs) rib.position.z = r * (0.2 + frame.unfold * 0.08);
  };
}

interface FistPod {
  /** Slides along the pod's facing: back through a wind-up, out as a knuckle barrage cools. */
  readonly slide: THREE.Group;
  animate(part: PartPose, frame: AtlasFrame): void;
}

function fistPod(p: PartKit, anchor: THREE.Group, r: number, side: number): FistPod {
  const { kit } = p;
  const { hull, trim } = partHull(kit);
  const knuckles = kit.accentMaterial(GOLD, GOLD_FILL, 1.8, 0.16);
  const heat = kit.accentMaterial(HOT, HOT_FILL, 2.1, 0.2);
  const turret = new THREE.Group();
  anchor.add(turret);
  const slide = new THREE.Group();
  turret.add(slide);
  // The forearm reaches back past the pod to the elbow; the fist fills the pod.
  kit.mesh(slide, kit.own(shapeExtrude(scaled([[-ELBOW_BACK, -0.34], [-0.5, -0.44], [-0.5, 0.44], [-ELBOW_BACK, 0.34]], r), r * 0.6, 0.6)), hull, 0, 0, 0, POD_CREASE);
  for (const k of [-1, 1]) kit.mesh(slide, kit.own(plateGeometry(r * 0.46, r * 0.06, r * 0.05, 0.1)), heat, -r * 0.94, k * r * 0.18, r * 0.34, 30);
  kit.mesh(slide, kit.own(plateGeometry(r * 0.14, r * 1.02, r * 0.72, 0.2)), p.red, -r * 0.52, 0, 0, POD_CREASE);
  kit.mesh(slide, kit.own(plateGeometry(r * 0.34, r * 0.86, r * 0.74, 0.2)), trim, -ELBOW_BACK * r, 0, -r * 0.04, POD_CREASE);
  const fist = new THREE.Group();
  fist.position.set(FIST_CENTER * r, 0, r * 0.04);
  slide.add(fist);
  const length = r * 1.3;
  const width = r * 1.6;
  kit.mesh(fist, kit.own(fistGeometry(length, width, r, 0.8)), trim, 0, 0, 0, POD_CREASE);
  kit.mesh(fist, kit.own(plateGeometry(r * 0.22, width - r * 0.1, r * 0.1, 0.2)), knuckles, length * 0.32, 0, r * 0.52, 36);
  for (let k = 1; k < KNUCKLES; k++) kit.mesh(fist, kit.own(lineGeometry(r * 0.46, r * 0.05, r * 0.05)), hull, -r * 0.04, (k / KNUCKLES - 0.5) * width, r * 0.52, 30);
  kit.mesh(fist, kit.own(plateGeometry(r * 0.5, r * 0.3, r * 0.36, 0.2)), hull, r * 0.06, -side * width * 0.55, -r * 0.1, POD_CREASE);
  // Wrist rockets: lit through the giga rocket punch's wind-up.
  const rockets = [-1, 1].map((k) => {
    const heading = new THREE.Group();
    heading.position.set(-length * 0.42, k * width * 0.44, r * 0.3);
    heading.rotation.z = Math.PI + k * 0.42;
    fist.add(heading);
    kit.mesh(heading, kit.own(bladeGeometry(r * 0.9, r * 0.34, r * 0.04)), heat, 0, 0, 0, 30);
    return heading;
  });
  // The empty wrist while the fist is out: a glowing socket and the cradle it docks back into.
  const port = new THREE.Group();
  port.position.set(-r * 0.42, 0, r * 0.04);
  slide.add(port);
  const socket = kit.mesh(port, kit.own(ringGeometry(r * 0.3, r * 0.07)), heat, 0, 0, 0, 30);
  socket.rotation.y = Math.PI * 0.32;
  kit.mesh(port, kit.own(diamondGeometry(r * 0.22, r * 0.12)), heat, r * 0.06, 0, 0, 30);
  const cradle = kit.mesh(port, kit.own(ringGeometry(r * 0.72, r * 0.035)), heat, r * 0.42 + FIST_CENTER * r, 0, -r * 0.2, 30);
  const animate = (part: PartPose, frame: AtlasFrame): void => {
    turret.rotation.z = part.facing - frame.body;
    const charge = smooth01(part.charge);
    const punch = frame.salvo ? part.heat * part.heat : 0;
    slide.position.x = -charge * FIST_WIND * r + punch * FIST_PUNCH * r;
    fist.visible = !part.away;
    port.visible = part.away;
    const ignition = part.away ? 0 : frame.siege * charge;
    for (const rocket of rockets) {
      rocket.visible = ignition > 0.02;
      rocket.scale.set(0.3 + ignition * 1.1, 0.6 + ignition * 0.5, 1);
    }
    knuckles.uniforms.uPulse.value += charge * 0.7 + punch * 0.4 + frame.unfold * 0.25;
    heat.uniforms.uPulse.value += part.heat * 0.6 + ignition * 0.6 + (part.away ? 0.45 + 0.25 * Math.sin(frame.time * 14 + side) : 0);
    socket.scale.setScalar(1 + (part.away ? 0.08 * Math.sin(frame.time * 9) : 0));
    cradle.rotation.z = frame.time * 0.8;
  };
  return { slide, animate };
}

function boosterPod(p: PartKit, anchor: THREE.Group, def: PartDef, r: number, side: number): (part: PartPose, frame: AtlasFrame) => void {
  const { kit } = p;
  const { hull, trim } = partHull(kit);
  const heat = kit.accentMaterial(HOT, HOT_FILL, 2.1, 0.2);
  const turret = new THREE.Group();
  anchor.add(turret);
  kit.mesh(turret, kit.own(shapeExtrude(scaled([[0.72, -0.36], [0.92, 0], [0.72, 0.36], [-0.56, 0.58], [-0.88, 0.3], [-0.88, -0.3], [-0.56, -0.58]], r), r * 0.62, 0.5)), hull, 0, 0, 0, POD_CREASE);
  kit.mesh(turret, kit.own(plateGeometry(r * 0.9, r * 0.56, r * 0.12, 0.2)), trim, -r * 0.1, 0, r * 0.36, POD_CREASE);
  kit.mesh(turret, kit.own(plateGeometry(r * 0.5, r * 0.07, r * 0.05, 0.1)), heat, -r * 0.12, side * r * 0.22, r * 0.46, 30);
  const flames = [-1, 1].map((k) => {
    kit.mesh(turret, kit.own(bellGeometry(r * 0.5, r * 0.3, r * 0.2)), trim, -r * 1.02, k * r * 0.28, 0, 36);
    return kit.mesh(turret, kit.own(diamondGeometry(r * 0.22, r * 0.08)), heat, -r * 1.5, k * r * 0.28, 0, 30);
  });
  const emitter = kit.mesh(turret, kit.own(ringGeometry(r * 0.2, r * 0.05)), heat, toWorld(def.muzzle) * 0.8, 0, r * 0.1, 30);
  return (part, frame) => {
    turret.rotation.z = part.facing - frame.body;
    const charge = smooth01(part.charge);
    const thrust = 0.5 + frame.speed * 1.2 + frame.unfold * 1.1 + charge * 0.5;
    for (const flame of flames) flame.scale.set(1 + thrust * 1.4, 0.8 + thrust * 0.25, 1);
    emitter.visible = charge > 0.02 || frame.unfold >= 1;
    emitter.scale.setScalar(0.7 + charge * 0.8 + (frame.unfold >= 1 ? 0.3 : 0));
    heat.uniforms.uPulse.value += part.heat * 0.6 + charge * 0.5 + frame.unfold * 0.35 + frame.speed * 0.2;
  };
}

export function createAtlas(): ColossusModel {
  const kit = createMechKit();
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  const massMat = kit.teamMaterial(0.34, 0.72, 0.42, 0x04090d, 0.42, 1.55);
  const armMat = kit.teamMaterial(0.5, 0.86, 1.1, 0x050b11, 0.52, 1.5);
  const frameMat = kit.teamMaterial(0.4, 0.84, 0.85, 0x050b11, 0.55, 1.45);
  const coreMat = kit.accentMaterial(0xfff0c8, 0x161008, 1.9, 0.12);
  const halo = kit.glassMaterial(GOLD, 0x120b02);
  const line = kit.accentMaterial(GOLD, GOLD_FILL, 2, 0.14);
  const p: PartKit = {
    kit,
    gold: kit.accentMaterial(GOLD, GOLD_FILL, 1.8, 0.16),
    red: kit.accentMaterial(RED, RED_FILL, 1.65, 0.18),
    eyes: kit.glassMaterial(EYE, EYE_FILL),
  };

  const indexOf = (name: string): number => {
    const k = FORM.parts.findIndex((def) => def.name === name);
    if (k < 0) throw new RangeError(`ATLAS has no part ${name}`);
    return k;
  };
  // The torso's mass: everything but the fists, which hang out front on their arms.
  const torso: FormDef = { ...FORM, parts: FORM.parts.filter((part) => !part.name.startsWith('fist')) };
  kit.mesh(body, kit.own(bodyHullGeometry(torso, MASS_MARGIN, MASS_DEPTH)), massMat, 0, 0, MASS_Z, 78);
  // The inner frame the armour hangs on (not a hitbox): a spine from the back to the head, a yoke across the shoulders and
  // struts out to the boosters. It unfolds with the parts.
  const frameRig = new THREE.Group();
  body.add(frameRig);
  const span = (a: PartDef, b: PartDef, width: number, height: number, z: number): void => {
    const ax = toWorld(a.x);
    const ay = toWorld(a.y);
    const dx = toWorld(b.x) - ax;
    const dy = toWorld(b.y) - ay;
    const beam = kit.mesh(frameRig, kit.own(plateGeometry(Math.hypot(dx, dy), width, height, 0.1)), frameMat, ax + dx * 0.5, ay + dy * 0.5, z, SHELL_CREASE);
    beam.rotation.z = Math.atan2(dy, dx);
  };
  const named = (name: string): PartDef => FORM.parts[indexOf(name)];
  span(named('back'), named('crest'), CORE_RADIUS * 1.1, FRAME_HEIGHT, FRAME_Z);
  span(named('shoulderR'), named('shoulderL'), CORE_RADIUS * 1.5, FRAME_HEIGHT, FRAME_Z + 0.4);
  for (const suffix of ['L', 'R']) span(named('back'), named(`booster${suffix}`), CORE_RADIUS * 0.6, FRAME_HEIGHT * 0.8, FRAME_Z - 0.4);
  const core = kit.mesh(body, kit.own(new THREE.OctahedronGeometry(CORE_RADIUS * 0.78, 0)), coreMat, 0, 0, CORE_Z, 28);
  const coreHalo = kit.mesh(body, kit.own(ringGeometry(CORE_RADIUS * 1.3, 0.16)), halo, 0, 0, CORE_Z + 0.4, 30);
  const collapse = kit.mesh(body, kit.own(ringGeometry(CORE_RADIUS * 2.6, 0.2)), line, 0, 0, CORE_Z + 0.8, 30);

  const parts: AtlasPart[] = FORM.parts.map((def, index) => {
    const anchor = new THREE.Group();
    body.add(anchor);
    const r = toWorld(def.rad);
    const before = kit.hullMaterials.length;
    let animate: (part: PartPose, frame: AtlasFrame) => void;
    let height: number;
    let slide: THREE.Group | null = null;
    switch (def.name) {
      case 'chest':
        animate = chestPart(p, anchor, r);
        height = CHEST_Z;
        break;
      case 'crest':
        animate = crestPart(p, anchor, r);
        height = CREST_Z;
        break;
      case 'shoulderL':
      case 'shoulderR':
        animate = shoulderPart(p, anchor, r, sideOf(def));
        height = SHOULDER_Z;
        break;
      case 'back':
        animate = backPart(p, anchor, r);
        height = BACK_Z;
        break;
      case 'fistL':
      case 'fistR': {
        const fist = fistPod(p, anchor, r, sideOf(def));
        slide = fist.slide;
        animate = fist.animate;
        height = FIST_Z;
        break;
      }
      case 'boosterL':
      case 'boosterR':
        animate = boosterPod(p, anchor, def, r, sideOf(def));
        height = BOOSTER_Z;
        break;
      default:
        throw new RangeError(`ATLAS has no model for part ${def.name}`);
    }
    return { index, def, anchor, height, slide, hull: kit.hullMaterials.slice(before), animate };
  });

  // Upper arms: from each shoulder to the elbow at the back of its fist's forearm (which turns with the pod).
  const upperArms = ARM_SIDES.map((side) => {
    const suffix = side === LEFT ? 'L' : 'R';
    const fist = parts[indexOf(`fist${suffix}`)];
    const shoulder = indexOf(`shoulder${suffix}`);
    const slide = fist.slide;
    if (slide === null) throw new RangeError(`ATLAS part ${fist.def.name} has no forearm`);
    const r = toWorld(fist.def.rad);
    const length = Math.hypot(toWorld(fist.def.x) - ELBOW_BACK * r - toWorld(FORM.parts[shoulder].x), toWorld(fist.def.y - FORM.parts[shoulder].y));
    const mesh = kit.mesh(body, kit.own(plateGeometry(length, r * 0.74, r * 0.56, 0.12)), armMat, 0, 0, UPPER_ARM_Z, SHELL_CREASE);
    const elbow = new THREE.CylinderGeometry(r * 0.4, r * 0.4, r * 0.3, 8);
    elbow.rotateX(Math.PI * 0.5);
    const joint = kit.mesh(body, kit.own(elbow), armMat, 0, 0, UPPER_ARM_Z + 0.6, 40);
    return { fist, shoulder, slide, r, length, mesh, joint };
  });
  // Energy lines from the core to every live pod while its attack winds up (the ultima lights them all).
  const energyLines = parts.filter((part) => part.def.kind === PartKind.Pod).map((part) => {
    const mesh = kit.mesh(body, kit.own(lineGeometry(1, 1.1, 0.6)), line, 0, 0, LINE_Z, 28);
    mesh.visible = false;
    return { part, mesh };
  });
  const placed = FORM.parts.map(() => new THREE.Vector3());

  return {
    root,
    setTeam(color) {
      kit.setTeam(color);
    },
    update(pose: ColossusPose) {
      const assemble = smooth01(pose.assemble);
      const windup = pose.phase === AttackPhase.Windup;
      const ultima = pose.attack === Attack.Ultima;
      const unfold = ultima ? (windup ? smooth01(pose.progress) : pose.phase === AttackPhase.Release ? 1 : 0) : 0;
      const siege = pose.attack === Attack.Siege && windup ? smooth01(pose.progress) : 0;
      const recoil = pose.attack === Attack.Siege && pose.phase === AttackPhase.Recovery ? 1 - smooth01(pose.progress) : 0;
      const frame: AtlasFrame = { time: pose.time, body: pose.body, speed: pose.speed, unfold, siege, salvo: pose.attack === Attack.Salvo };
      body.rotation.z = pose.body;
      body.position.z = Math.sin(pose.time * 1.1) * 0.2 - siege * SIEGE_CROUCH;
      body.rotation.y = siege * SIEGE_LEAN - recoil * RECOIL_LEAN;

      applyColossusVectorState(kit, pose.time, pose.hit, pose.fuel, assemble);
      frameRig.scale.setScalar(lerp(FRAME_MIN_SCALE, 1, assemble));
      for (const part of parts) {
        const partPose = pose.parts[part.index];
        const ease = staggered(assemble, part.index * ASSEMBLE_STEP);
        const homeX = toWorld(part.def.x);
        const homeY = toWorld(part.def.y);
        const arc = Math.sin(ease * Math.PI);
        placed[part.index].set(
          homeX * ease - homeY * ASSEMBLE_ARC_SWAY * arc,
          homeY * ease + homeX * ASSEMBLE_ARC_SWAY * arc,
          part.height + (1 - ease) * 3 + arc * ASSEMBLE_ARC_HEIGHT,
        );
        part.anchor.visible = partPose.hp > 0 && ease > 0.02;
        if (!part.anchor.visible) continue;
        part.anchor.position.copy(placed[part.index]);
        part.anchor.scale.setScalar(lerp(ASSEMBLE_MIN_SCALE, 1, ease));
        const weak = partPose.hp < WEAK_HP ? 0.12 + 0.08 * Math.sin(pose.time * 13 + part.index) : 0;
        for (const material of part.hull) {
          material.uniforms.uFlash.value = Math.max(pose.hit * 0.28, partPose.flash * PART_FLASH);
          material.uniforms.uPulse.value += weak + unfold * 0.05;
        }
        part.animate(partPose, frame);
      }

      for (const arm of upperArms) {
        const visible = arm.fist.anchor.visible;
        arm.mesh.visible = visible;
        arm.joint.visible = visible;
        if (!visible) continue;
        const from = placed[arm.shoulder];
        const pivot = arm.fist.anchor.position;
        const turn = pose.parts[arm.fist.index].facing - pose.body;
        const back = (arm.slide.position.x - ELBOW_BACK * arm.r) * arm.fist.anchor.scale.x;
        const elbowX = pivot.x + Math.cos(turn) * back;
        const elbowY = pivot.y + Math.sin(turn) * back;
        const dx = elbowX - from.x;
        const dy = elbowY - from.y;
        arm.mesh.position.set((from.x + elbowX) * 0.5, (from.y + elbowY) * 0.5, UPPER_ARM_Z);
        arm.mesh.rotation.z = Math.atan2(dy, dx);
        arm.mesh.scale.x = Math.max(ARM_MIN_SCALE, Math.hypot(dx, dy) / arm.length);
        arm.joint.position.set(elbowX, elbowY, UPPER_ARM_Z + 0.6);
      }

      for (const energy of energyLines) {
        const partPose = pose.parts[energy.part.index];
        const power = Math.max(smooth01(partPose.charge) * 0.8, unfold * 0.75);
        const to = placed[energy.part.index];
        const span = Math.hypot(to.x, to.y);
        energy.mesh.visible = energy.part.anchor.visible && !partPose.away && power > 0.02 && span > 1;
        if (!energy.mesh.visible) continue;
        energy.mesh.position.set(to.x * 0.5, to.y * 0.5, LINE_Z);
        energy.mesh.rotation.z = Math.atan2(to.y, to.x);
        energy.mesh.scale.set(span, 0.4 + power * 0.8, 1);
      }

      core.scale.setScalar(0.46 + assemble * (0.32 + pose.fuel * 0.26));
      core.rotation.z = pose.time * 0.45;
      coreHalo.visible = assemble > 0.08;
      coreHalo.rotation.z = pose.time * 0.14;
      coreHalo.scale.setScalar(0.78 + assemble * 0.28 + unfold * 0.12);
      collapse.visible = ultima && windup;
      collapse.scale.setScalar(lerp(1.3, 0.6, unfold));
      collapse.rotation.z = -pose.time * 0.6;

      massMat.uniforms.uFlash.value = pose.hit * 0.12;
      massMat.uniforms.uOpacity.value = 0.46;
      massMat.uniforms.uPulse.value = 0;
      armMat.uniforms.uOpacity.value = 0.8;
      frameMat.uniforms.uOpacity.value = 0.7;
      coreMat.uniforms.uPulse.value += unfold * 0.3 + siege * 0.15;
      p.gold.uniforms.uPulse.value += unfold * 0.25 + siege * 0.1;
      p.red.uniforms.uPulse.value += unfold * 0.3;
      p.eyes.uniforms.uOpacity.value = 0.7 + unfold * 0.3;
      halo.uniforms.uOpacity.value = 0.14 + (1 - pose.fuel) * 0.06 + unfold * 0.1;
      line.uniforms.uPulse.value += 0.2 + unfold * 0.3;
      line.uniforms.uOpacity.value = 0.5 + unfold * 0.4;
    },
    dispose() {
      kit.dispose();
    },
  };
}
