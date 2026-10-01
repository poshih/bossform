import * as THREE from 'three';
import { edgeGeometry, type VectorMaterial } from '../../render/vector.ts';
import { Attack, AttackPhase, FORMS, Frame, PartKind, Role } from '../../sim/index.ts';
import type { PartDef } from '../../sim/index.ts';
import {
  applyColossusVectorState,
  applyRobotVectorState,
  createMechKit,
  diamondGeometry,
  finGeometry,
  lineGeometry,
  nozzleGeometry,
  plateGeometry,
  ringGeometry,
  shapeExtrude,
  type MechKit,
} from './kit-mechs.ts';
import { clamp01, easeOutCubic, lerp, smooth01, toWorld, TWO_PI } from '../shared.ts';
import type { ColossusModel, ColossusPose, RobotModel, RobotPose } from './types.ts';

/*
 * HAILSTORM, the walking arsenal: a broad, boxy gunner on a wide stance, bomb racks with cell grids on both shoulders, a
 * six-barrel rotary cannon on the right arm fed from the magazines on its back. Its colossus ARMADA is a flying battleship.
 * Contract: view/models/types.ts.
 */

const ACCENT = 0xffa23a;
const ACCENT_FILL = 0x1c1004;
/** The rotary cannon's barrels glow from amber (cold) toward near white (full spin). */
const BARREL_COLD = 0xff8a2e;
const BARREL_HOT = 0xffe6bf;
/**
 * Crease angles (render/vector.ts): the kit's plates have 45-degree bevels, so CRISP shows their outlines and SOFT hides them
 * (the volume still reads from its rim light). Outer armour is crisp, the volumes under it soft, so the top view stays clean.
 */
const CRISP = 44;
const SOFT = 50;
/** Small accent pieces (boxes, diamonds, rings): every edge shows. Round pieces: their facets hide, their rims show. */
const FINE = 30;
const ROUND = 36;

// ---- HAILSTORM -------------------------------------------------------------------------------------------------------
/** Hull faces take this share of the team colour (the edges carry it at full strength), so the big box reads as the team's. */
const TEAM_FILL_TINT = 0.13;
const TORSO_Z = 5.0;
const RACK_X = -0.9;
const RACK_Y = 7.0;
const RACK_Z = 7.7;
const RACK_LENGTH = 7.2;
const RACK_WIDTH = 4.6;
const RACK_COLUMNS = 3;
const RACK_ROWS = 2;
const RACK_WALL = 0.38;
const WARHEAD_Z = 1.1;
/** The racks pitch up (radians) and rise when the carpet bomb launches (RobotPose.alt), and their warheads pop out. */
const RACK_POP_PITCH = 0.42;
const RACK_POP_LIFT = 0.9;
const WARHEAD_POP = 1.0;
const CANNON_X = 1.3;
const CANNON_Y = -4.3;
const CANNON_Z = 4.6;
/** The cannon is held a little across the body, so its muzzle ends near the aim line the rounds fly along. */
const CANNON_TOE_IN = 0.075;
const BARREL_COUNT = 6;
const BARREL_LENGTH = 8.0;
const BARREL_RADIUS = 0.27;
const BARREL_RING = 0.86;
const BARRELS_X = 3.9;
const BARREL_TIP = BARRELS_X + BARREL_LENGTH;
/** Barrel-cluster turn rate at full spin (radians a second: 20 rounds a second from six barrels). */
const SPIN_RATE = 21;
const MAX_FRAME_SECONDS = 0.1;
const CANNON_RECOIL = 0.36;
const SPIN_SHAKE = 0.05;
const HIP_X = -0.7;
const HIP_Y = 3.6;
const FOOT_X = 1.8;
const FOOT_Y = 10.0;
const FOOT_Z = 0.55;
/** Gait: steps a second at any speed, stride length and foot lift at top speed, and the body's bob and lean. */
const GAIT_RATE = 7.2;
const STRIDE = 2.2;
const STEP_LIFT = 1.0;
const STEP_BOB = 0.24;
const LEAN = 0.09;
const BANK_TILT = 0.12;
const HIP_TWIST = 0.36;
const BREATH_RATE = 2.4;
const BREATH_HEIGHT = 0.1;
const SHELL_RADIUS = 11.8;

interface CellLayout {
  readonly cellX: number;
  readonly cellY: number;
  readonly centers: ReadonlyArray<readonly [number, number]>;
}

/** Square cells in a `columns` (along x) by `rows` (along y) grid inside a length x width plate with `wall` between them. */
function cellLayout(length: number, width: number, columns: number, rows: number, wall: number): CellLayout {
  const cellX = (length - wall * (columns + 1)) / columns;
  const cellY = (width - wall * (rows + 1)) / rows;
  const centers: Array<readonly [number, number]> = [];
  for (let c = 0; c < columns; c++) {
    for (let r = 0; r < rows; r++) centers.push([-length * 0.5 + wall + cellX * 0.5 + c * (cellX + wall), -width * 0.5 + wall + cellY * 0.5 + r * (cellY + wall)]);
  }
  return { cellX, cellY, centers };
}

/** A plate with the cells of `layout` cut through it: the lid of a bomb rack or a missile silo. */
function cellGridGeometry(length: number, width: number, depth: number, layout: CellLayout): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(-length * 0.5, -width * 0.5);
  shape.lineTo(length * 0.5, -width * 0.5);
  shape.lineTo(length * 0.5, width * 0.5);
  shape.lineTo(-length * 0.5, width * 0.5);
  shape.closePath();
  for (const [x, y] of layout.centers) {
    const hole = new THREE.Path();
    hole.moveTo(x - layout.cellX * 0.5, y - layout.cellY * 0.5);
    hole.lineTo(x - layout.cellX * 0.5, y + layout.cellY * 0.5);
    hole.lineTo(x + layout.cellX * 0.5, y + layout.cellY * 0.5);
    hole.lineTo(x + layout.cellX * 0.5, y - layout.cellY * 0.5);
    hole.closePath();
    shape.holes.push(hole);
  }
  const geometry = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 1 });
  geometry.translate(0, 0, -depth * 0.5);
  return geometry;
}

/** A cylinder lying along x (barrels, clamps, drums). */
function tubeGeometry(radius: number, length: number, sides: number): THREE.BufferGeometry {
  const geometry = new THREE.CylinderGeometry(radius, radius, length, sides, 1, false);
  geometry.rotateZ(Math.PI * 0.5);
  return geometry;
}

/** One vector-edge geometry drawn by many meshes (the kit converts per mesh; identical pieces share one here). */
function sharedEdges(kit: MechKit, source: THREE.BufferGeometry, crease: number): THREE.BufferGeometry {
  const geometry = kit.own(edgeGeometry(source, crease));
  source.dispose();
  return geometry;
}

function place(parent: THREE.Object3D, geometry: THREE.BufferGeometry, material: VectorMaterial, x: number, y: number, z: number): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(x, y, z);
  parent.add(mesh);
  return mesh;
}

interface Rack {
  readonly mount: THREE.Group;
  readonly warheads: readonly THREE.Mesh[];
}

function buildRack(kit: MechKit, parent: THREE.Object3D, side: number, box: VectorMaterial, lid: VectorMaterial, trim: VectorMaterial, warheadGeometry: THREE.BufferGeometry, warheadMat: VectorMaterial): Rack {
  const mount = new THREE.Group();
  mount.position.set(RACK_X, side * RACK_Y, RACK_Z);
  parent.add(mount);
  kit.mesh(mount, kit.own(plateGeometry(RACK_LENGTH, RACK_WIDTH, 2.6, 0.1)), box, 0, 0, 0, SOFT);
  const layout = cellLayout(RACK_LENGTH - 0.4, RACK_WIDTH - 0.4, RACK_COLUMNS, RACK_ROWS, RACK_WALL);
  kit.mesh(mount, kit.own(cellGridGeometry(RACK_LENGTH - 0.4, RACK_WIDTH - 0.4, 0.5, layout)), lid, 0, 0, 1.55, CRISP);
  const warheads = layout.centers.map(([x, y]) => place(mount, warheadGeometry, warheadMat, x, y, WARHEAD_Z));
  kit.mesh(mount, kit.own(lineGeometry(RACK_LENGTH - 1.4, 0.3, 0.9)), trim, 0, side * (RACK_WIDTH * 0.5 + 0.3), 0.1, FINE);
  kit.mesh(mount, kit.own(plateGeometry(1.2, RACK_WIDTH - 0.8, 1.5, 0.2)), box, RACK_LENGTH * 0.5 + 0.4, 0, -0.4, CRISP).rotation.y = 0.5;
  return { mount, warheads };
}

interface Leg {
  readonly thigh: THREE.Group;
  readonly foot: THREE.Group;
}

function buildLeg(kit: MechKit, parent: THREE.Object3D, side: number, upper: VectorMaterial, lower: VectorMaterial, trim: VectorMaterial): Leg {
  const thigh = new THREE.Group();
  thigh.position.set(HIP_X, side * HIP_Y, 2.7);
  parent.add(thigh);
  const thighPlate = kit.mesh(thigh, kit.own(plateGeometry(2.8, 2.3, 3.0, 0.2)), upper, 0.2, side * 1.7, -0.4, SOFT);
  thighPlate.rotation.x = side * 0.5;
  const foot = new THREE.Group();
  foot.position.set(FOOT_X, side * FOOT_Y, FOOT_Z);
  parent.add(foot);
  kit.mesh(foot, kit.own(plateGeometry(2.6, 2.4, 2.6, 0.2)), upper, -1.0, -side * 1.4, 1.3, CRISP).rotation.x = side * 0.4;
  const sole = kit.mesh(foot, kit.own(plateGeometry(5.8, 3.1, 1.1, 0.26)), lower, 0, 0, 0, CRISP);
  sole.rotation.z = side * 0.12;
  kit.mesh(foot, kit.own(lineGeometry(2.4, 0.32, 0.2)), trim, 1.1, side * 0.14, 0.68, FINE).rotation.z = side * 0.12;
  return { thigh, foot };
}

export function createHailstorm(): RobotModel {
  const kit = createMechKit();
  const root = new THREE.Group();
  const legRig = new THREE.Group();
  const hull = new THREE.Group();
  root.add(legRig, hull);

  const hullA = kit.teamMaterial(0.52, 0.92, 1.3, 0x08131d, 0.6, 1.8);
  const hullB = kit.teamMaterial(0.6, 0.86, 1.45, 0x0b1a28, 0.56, 1.65);
  const hullDark = kit.teamMaterial(0.4, 0.86, 1.12, 0x060d14, 0.62, 1.55);
  const accent = kit.accentMaterial(ACCENT, ACCENT_FILL, 1.72, 0.12);
  const warheadMat = kit.accentMaterial(ACCENT, ACCENT_FILL, 1.6, 0.22, 1.3);
  const barrelMat = kit.accentMaterial(BARREL_COLD, 0x1a0b03, 1.5, 0.18, 1.35);
  const heatMat = kit.accentMaterial(BARREL_HOT, 0x241205, 2.0, 0.1, 1.2);
  const glass = kit.glassMaterial(0xffc27a, 0x140a02);
  const tinted = [hullA, hullB];

  // Body: a wide armoured box on a heavy pelvis, a prow-shaped chest plate, a squat helmet sunk between the racks.
  kit.mesh(hull, kit.own(plateGeometry(4.2, 6.4, 1.8, 0.2)), hullDark, -0.8, 0, 2.8, SOFT);
  kit.mesh(hull, kit.own(plateGeometry(8.8, 9.8, 3.2, 0.16)), hullA, -0.8, 0, TORSO_Z, SOFT);
  kit.mesh(hull, kit.own(shapeExtrude([[-3.4, -4.2], [2.0, -4.2], [4.3, -2.0], [4.3, 2.0], [2.0, 4.2], [-3.4, 4.2]], 1.5, 0.4)), hullB, 0.9, 0, 7.0, CRISP);
  kit.mesh(hull, kit.own(plateGeometry(3.0, 6.2, 1.4, 0.22)), hullA, -4.3, 0, 6.9, CRISP);
  const head = new THREE.Group();
  head.position.set(2.1, 0, 8.4);
  hull.add(head);
  kit.mesh(head, kit.own(plateGeometry(2.6, 3.8, 1.6, 0.28)), hullB, 0, 0, 0, CRISP);
  kit.mesh(head, kit.own(lineGeometry(0.5, 3.0, 0.5)), accent, 1.4, 0, 0.1, FINE);
  const eye = kit.mesh(head, kit.own(diamondGeometry(0.38, 0.16)), glass, 1.65, 0, 0.2, FINE);
  eye.rotation.x = 0.4;
  const crest = kit.mesh(head, kit.own(finGeometry(2.8, 0.7, 0.24)), hullA, -1.2, 0, 1.0, CRISP);
  crest.rotation.z = Math.PI;

  // Shoulder racks: the carpet bombs, six warheads in each grid.
  const warheadGeometry = sharedEdges(kit, new THREE.OctahedronGeometry(0.56, 0), FINE);
  const racks = [-1, 1].map((side) => buildRack(kit, hull, side, hullA, hullB, accent, warheadGeometry, warheadMat));

  // Backpack: two ammunition drums with their round counters, exhausts beneath them.
  const exhausts: THREE.Mesh[] = [];
  const drumGeometry = new THREE.CylinderGeometry(1.9, 1.9, 3.4, 8, 1, false);
  for (const side of [-1, 1] as const) {
    kit.mesh(hull, kit.own(drumGeometry.clone()), hullB, -6.3, side * 2.5, 5.6, CRISP);
    kit.mesh(hull, kit.own(lineGeometry(0.3, 2.6, 0.24)), accent, -6.3, side * 2.5, 7.62, FINE);
    kit.mesh(hull, kit.own(nozzleGeometry(2.0, 0.52)), hullDark, -7.4, side * 1.2, 3.0, ROUND).rotation.y = -0.12;
    exhausts.push(kit.mesh(hull, kit.own(diamondGeometry(0.46, 0.14)), accent, -8.7, side * 1.2, 3.0, FINE));
  }
  drumGeometry.dispose();
  // The feed belt from the right drum to the cannon.
  const linkGeometry = sharedEdges(kit, new THREE.BoxGeometry(0.66, 0.96, 0.44), FINE);
  for (let k = 0; k < 6; k++) {
    const t = k / 5;
    const link = place(hull, linkGeometry, hullDark, lerp(-5.0, -0.2, t), -4.0 - Math.sin(t * Math.PI) * 0.7, 4.6 + Math.sin(t * Math.PI) * 0.5);
    link.rotation.z = -0.1;
  }

  // Left arm: a heavy forearm ending in the bomb-sight.
  const leftArm = new THREE.Group();
  leftArm.position.set(1.3, 4.7, 4.2);
  hull.add(leftArm);
  kit.mesh(leftArm, kit.own(plateGeometry(2.4, 2.4, 2.2, 0.2)), hullA, -1.0, 0.4, 0.5, SOFT);
  kit.mesh(leftArm, kit.own(plateGeometry(4.8, 2.4, 2.4, 0.16)), hullB, 1.6, 0, 0, CRISP).rotation.y = -0.05;
  kit.mesh(leftArm, kit.own(plateGeometry(1.6, 1.9, 1.7, 0.2)), hullA, 4.3, -0.1, 0.1, CRISP);
  const sight = kit.mesh(leftArm, kit.own(diamondGeometry(0.4, 0.16)), glass, 5.3, -0.1, 0.4, FINE);
  sight.rotation.x = 0.4;

  // Right arm: the rotary cannon, a receiver, the barrel cluster in two clamps, a muzzle collar.
  const cannon = new THREE.Group();
  cannon.rotation.z = CANNON_TOE_IN;
  hull.add(cannon);
  kit.mesh(cannon, kit.own(plateGeometry(2.6, 2.4, 2.4, 0.2)), hullA, -1.7, -0.5, 0.6, SOFT);
  kit.mesh(cannon, kit.own(plateGeometry(5.0, 3.0, 2.9, 0.16)), hullA, 0.4, 0, 0, CRISP);
  kit.mesh(cannon, kit.own(tubeGeometry(1.5, 2.6, 8)), hullB, 3.0, 0, 0.15, CRISP);
  const barrels = new THREE.Group();
  barrels.position.set(BARRELS_X, 0, 0.15);
  cannon.add(barrels);
  const barrelGeometry = sharedEdges(kit, tubeGeometry(BARREL_RADIUS, BARREL_LENGTH, 6), CRISP);
  for (let k = 0; k < BARREL_COUNT; k++) {
    const angle = (k / BARREL_COUNT) * TWO_PI;
    place(barrels, barrelGeometry, barrelMat, BARREL_LENGTH * 0.5, Math.cos(angle) * BARREL_RING, Math.sin(angle) * BARREL_RING);
  }
  kit.mesh(barrels, kit.own(tubeGeometry(0.36, BARREL_LENGTH * 0.9, 6)), hullDark, BARREL_LENGTH * 0.45, 0, 0, CRISP);
  const clampGeometry = sharedEdges(kit, tubeGeometry(1.24, 0.46, 12), ROUND);
  place(cannon, clampGeometry, hullB, BARRELS_X + 1.9, 0, 0.15);
  place(cannon, clampGeometry, hullB, BARRELS_X + BARREL_LENGTH - 1.4, 0, 0.15);
  const blur = kit.mesh(cannon, kit.own(ringGeometry(1.12, 0.08)), heatMat, BARRELS_X + BARREL_LENGTH * 0.52, 0, 0.15, FINE);
  blur.rotation.y = Math.PI * 0.5;
  const heat = kit.mesh(cannon, kit.own(diamondGeometry(0.66, 0.3)), heatMat, BARREL_TIP + 0.1, 0, 0.15, FINE);
  const flash = kit.mesh(cannon, kit.own(diamondGeometry(0.66, 0.2)), heatMat, BARREL_TIP + 1.0, 0, 0.15, FINE);
  flash.rotation.x = 0.4;

  // Wide stance: the legs hang from the hips, the feet splay outward past the racks.
  const legs = [-1, 1].map((side) => buildLeg(kit, legRig, side, hullA, hullB, accent));

  const shellRing = kit.mesh(root, kit.own(ringGeometry(SHELL_RADIUS, 0.18)), glass, 0, 0, 0.8, FINE);
  shellRing.visible = false;

  const warheadCold = new THREE.Color(ACCENT);
  const barrelCold = new THREE.Color(BARREL_COLD);
  const barrelHot = new THREE.Color(BARREL_HOT);
  let lastTime = Number.NaN;
  let barrelAngle = 0;

  return {
    root,
    setTeam(color) {
      kit.setTeam(color);
      for (const material of tinted) material.uniforms.uFill.value.copy(color).multiplyScalar(TEAM_FILL_TINT);
    },
    update(pose: RobotPose) {
      const morph = smooth01(pose.morph);
      const spin = clamp01(pose.special);
      const pop = smooth01(pose.alt);
      const relative = pose.move - pose.aim;
      const along = Math.cos(relative) * pose.speed;
      const across = Math.sin(relative) * pose.speed;
      const gait = pose.time * GAIT_RATE;
      const elapsed = Number.isFinite(lastTime) ? Math.min(MAX_FRAME_SECONDS, Math.max(0, pose.time - lastTime)) : 0;
      lastTime = pose.time;

      root.rotation.z = pose.aim;
      root.scale.set(1 - morph * 0.7, 1 - morph * 0.34, 1 - morph * 0.5);
      hull.position.z = Math.sin(pose.time * BREATH_RATE) * BREATH_HEIGHT + Math.abs(Math.sin(gait)) * pose.speed * STEP_BOB;
      hull.rotation.x = across * BANK_TILT;
      hull.rotation.y = along * LEAN;
      // The hips turn a little toward a diagonal heading; straight ahead, sideways or backwards the feet just step that way.
      const twist = Math.sin(relative * 2) * pose.speed * HIP_TWIST;
      const heading = relative - twist;
      legRig.rotation.z = twist;
      for (let i = 0; i < legs.length; i++) {
        const side = i === 0 ? -1 : 1;
        const phase = gait + i * Math.PI;
        const swing = Math.sin(phase) * pose.speed * STRIDE;
        const lift = Math.max(0, Math.cos(phase)) * pose.speed * STEP_LIFT;
        legs[i].foot.position.set(FOOT_X + Math.cos(heading) * swing, side * FOOT_Y + Math.sin(heading) * swing, FOOT_Z + lift);
        legs[i].thigh.position.set(HIP_X + Math.cos(heading) * swing * 0.4, side * HIP_Y + Math.sin(heading) * swing * 0.4, 2.7 + lift * 0.3);
      }

      barrelAngle = (barrelAngle + elapsed * spin * SPIN_RATE) % TWO_PI;
      barrels.rotation.x = barrelAngle;
      cannon.position.set(CANNON_X - pose.fire * CANNON_RECOIL, CANNON_Y + Math.sin(pose.time * 61) * SPIN_SHAKE * spin, CANNON_Z);
      blur.visible = spin > 0.12;
      heat.visible = spin > 0.05;
      heat.scale.setScalar(0.5 + spin * 0.9);
      flash.visible = pose.fire > 0.04;
      flash.position.y = pose.side * BARREL_RING * 0.8;
      flash.scale.set(0.7 + pose.fire * 1.3, 0.7 + pose.fire * 0.6, 1);

      for (let i = 0; i < racks.length; i++) {
        const side = i === 0 ? -1 : 1;
        const rack = racks[i];
        rack.mount.rotation.y = -pop * RACK_POP_PITCH;
        rack.mount.rotation.x = side * pop * 0.08;
        rack.mount.position.z = RACK_Z + pop * RACK_POP_LIFT;
        for (let k = 0; k < rack.warheads.length; k++) {
          rack.warheads[k].position.z = WARHEAD_Z + pop * WARHEAD_POP;
          rack.warheads[k].scale.setScalar(1 + pop * 0.25);
        }
      }
      for (let i = 0; i < exhausts.length; i++) exhausts[i].scale.set(1.6 + pose.speed * 1.6, 0.8 + pose.speed * 0.3, 1);

      shellRing.visible = pose.shield > 0.03;
      shellRing.scale.setScalar(1 + pose.shield * 0.08);
      shellRing.rotation.z = pose.time * 0.7;
      applyRobotVectorState(kit, pose.time, pose.hit, pose.charge, pose.shield, morph);
      const fade = lerp(1, 0.2, morph);
      barrelMat.uniforms.uEdge.value.lerpColors(barrelCold, barrelHot, spin * spin);
      barrelMat.uniforms.uPulse.value += 0.05 + spin * 0.24 + pose.fire * 0.1;
      barrelMat.uniforms.uOpacity.value = fade;
      heatMat.uniforms.uPulse.value += spin * 0.3 + pose.fire * 0.3;
      heatMat.uniforms.uOpacity.value = fade * (0.35 + Math.max(spin, pose.fire) * 0.55);
      warheadMat.uniforms.uEdge.value.lerpColors(warheadCold, barrelHot, pop);
      warheadMat.uniforms.uPulse.value += 0.04 + pop * 1.4;
      warheadMat.uniforms.uOpacity.value = fade;
      accent.uniforms.uPulse.value += pop * 0.3 + spin * 0.08;
      accent.uniforms.uOpacity.value = lerp(0.8, 0.2, morph);
      glass.uniforms.uOpacity.value = 0.3 + pose.shield * 0.2;
    },
    dispose() {
      kit.dispose();
    },
  };
}

// ---- ARMADA -----------------------------------------------------------------------------------------------------------
const ARMADA_FORM = FORMS[Frame.Hailstorm];
const ARMADA_CORE_R = toWorld(ARMADA_FORM.coreR);
/** The keel: a long hull from ram to stern under every part (a picture of mass, not a hitbox: dim, never glowing). */
const KEEL_OUTLINE: ReadonlyArray<readonly [number, number]> = [
  [80, 0], [56, 12], [30, 20], [0, 24], [-40, 24], [-68, 20], [-80, 12], [-80, -12], [-68, -20], [-40, -24], [0, -24], [30, -20], [56, -12],
];
/** Cross-beams under the side hulls and gatlings, in keel space: centre x, |y|, length, width, turn toward +y (radians). */
const CROSS_BEAMS: ReadonlyArray<readonly [number, number, number, number, number]> = [
  [-30, 30, 26, 8, Math.PI * 0.5],
  [2, 26, 20, 7, Math.PI * 0.5],
  [22, 30, 26, 6, 1.18],
];
const KEEL_Z = 3.2;
const KEEL_DEPTH = 4.4;
const CORE_Z = 6.4;
const ARMOR_Z = 6.2;
const POD_Z = 7.6;
const CONDUIT_Z = 8.2;
/** The core-to-pod conduits stay lit at this strength through the ultima's barrage. */
const CONDUIT_BARRAGE = 0.5;
const ASSEMBLE_STEP = 0.07;
const ASSEMBLE_ARC_HEIGHT = 5.4;
const ASSEMBLE_ARC_SWAY = 0.14;
const ASSEMBLE_DROP = 6;
const WEAK_HP = 0.35;
/** Silo hatch lids flip this far open (radians) through a wind-up, and stay open while their missiles are hot. */
const HATCH_OPEN = 1.85;
const SILO_COLUMNS = 3;
const SILO_ROWS = 3;
const GATLING_BARRELS = 6;
/** Gatling barrel-cluster turn rate, radians a second, fully spun up. */
const GATLING_SPIN_RATE = 18;
const RADAR_RATE = 0.9;
const SIEGE_SQUAT = 1.3;
/** Through the ultima's wind-up and barrage the whole hull lights up and its armour rises (a share of its height). */
const ULTIMA_HULL_GLOW = 0.16;
const ULTIMA_PLATE_RISE = 0.2;
const RECOIL_PITCH = 0.035;

interface ArmadaNode {
  readonly index: number;
  readonly def: PartDef;
  readonly anchor: THREE.Group;
  /** This part's own materials: its flash, damage flicker, charge and heat never light another part. */
  readonly plates: readonly VectorMaterial[];
  readonly glow: VectorMaterial;
  readonly conduit: THREE.Mesh | null;
  readonly hatches: readonly THREE.Group[];
  readonly tips: readonly THREE.Mesh[];
  readonly barrels: THREE.Group | null;
  readonly blur: THREE.Mesh | null;
  readonly muzzle: THREE.Mesh | null;
  readonly vents: readonly THREE.Mesh[];
}

interface ArmadaParts {
  readonly plates: VectorMaterial[];
  readonly glow: VectorMaterial;
  readonly hatches: THREE.Group[];
  readonly tips: THREE.Mesh[];
  readonly vents: THREE.Mesh[];
  barrels: THREE.Group | null;
  blur: THREE.Mesh | null;
  muzzle: THREE.Mesh | null;
}

/** A disc lying on the deck (turntables, collars). */
function discGeometry(radius: number, bottom: number, height: number, sides: number): THREE.BufferGeometry {
  const geometry = new THREE.CylinderGeometry(radius, bottom, height, sides, 1, false);
  geometry.rotateX(Math.PI * 0.5);
  return geometry;
}

/** The armoured prow: layered plates narrowing to a ram, running lights along its edges. */
function buildBow(kit: MechKit, anchor: THREE.Group, radius: number, parts: ArmadaParts): void {
  const [lower, upper] = parts.plates;
  const r = radius;
  kit.mesh(anchor, kit.own(shapeExtrude([[-r * 0.86, -r * 0.8], [r * 0.1, -r * 0.84], [r, -r * 0.12], [r, r * 0.12], [r * 0.1, r * 0.84], [-r * 0.86, r * 0.8], [-r * 0.98, 0]], 3.4, 0.5)), lower, 0, 0, 0, CRISP);
  kit.mesh(anchor, kit.own(shapeExtrude([[-r * 0.6, -r * 0.5], [r * 0.1, -r * 0.52], [r * 0.74, -r * 0.08], [r * 0.74, r * 0.08], [r * 0.1, r * 0.52], [-r * 0.6, r * 0.5]], 1.8, 0.4)), upper, -r * 0.06, 0, 2.7, CRISP);
  for (const side of [-1, 1] as const) {
    const light = kit.mesh(anchor, kit.own(lineGeometry(r * 0.86, 0.5, 0.5)), parts.glow, r * 0.52, side * r * 0.47, 2.0, FINE);
    light.rotation.z = -side * 0.72;
  }
  kit.mesh(anchor, kit.own(plateGeometry(r * 0.5, r * 0.22, 1.2, 0.2)), upper, -r * 0.42, 0, 4.1, CRISP);
  kit.mesh(anchor, kit.own(finGeometry(r * 1.2, r * 0.16, 1.0)), upper, r * 0.12, 0, 4.0, CRISP);
}

/** The bridge tower over the reactor: a stepped superstructure, the command windows, a mast with a turning radar. */
function buildBridge(kit: MechKit, anchor: THREE.Group, radius: number, parts: ArmadaParts, glass: VectorMaterial): THREE.Mesh {
  const [lower, upper] = parts.plates;
  const r = radius;
  kit.mesh(anchor, kit.own(plateGeometry(r * 1.8, r * 1.56, 2.2, 0.3)), lower, -r * 0.06, 0, 1.2, CRISP);
  kit.mesh(anchor, kit.own(plateGeometry(r * 0.94, r * 0.9, 3.6, 0.24)), upper, r * 0.04, 0, 4.2, CRISP);
  kit.mesh(anchor, kit.own(plateGeometry(r * 0.6, r * 0.66, 2.8, 0.3)), lower, r * 0.14, 0, 7.4, CRISP);
  kit.mesh(anchor, kit.own(lineGeometry(1.1, r * 0.58, 1.0)), glass, r * 0.46, 0, 7.8, FINE);
  kit.mesh(anchor, kit.own(plateGeometry(r * 0.3, r * 0.36, 1.6, 0.3)), upper, -r * 0.02, 0, 9.6, CRISP);
  const mast = new THREE.CylinderGeometry(0.55, 0.8, 5.2, 6, 1, false);
  mast.rotateX(Math.PI * 0.5);
  kit.mesh(anchor, kit.own(mast), upper, -r * 0.08, 0, 12.4, CRISP);
  const radar = kit.mesh(anchor, kit.own(lineGeometry(r * 0.56, 1.0, 0.5)), parts.glow, -r * 0.08, 0, 15.2, FINE);
  for (const side of [-1, 1] as const) kit.mesh(anchor, kit.own(lineGeometry(r * 0.5, 0.45, 0.4)), parts.glow, -r * 0.3, side * r * 0.36, 3.0, FINE);
  return radar;
}

/**
 * A side hull: a long armoured sponson shaped to the ship's outline (it carries the gatling turret ahead of it), with its
 * belt armour, a raised deck, running lights along the belt and a stabiliser fin aft, all inside its hit circle. `side` +1 is
 * the left (outboard +y).
 */
function buildSponson(kit: MechKit, anchor: THREE.Group, radius: number, side: number, parts: ArmadaParts): void {
  const [lower, upper] = parts.plates;
  const r = radius;
  const outline: Array<[number, number]> = [
    [-r * 0.92, -r * 0.4], [r * 0.6, -r * 0.55], [r, -r * 0.1], [r * 0.74, r * 0.42], [r * 0.1, r * 0.8], [-r * 0.7, r * 0.7], [-r, r * 0.12],
  ];
  kit.mesh(anchor, kit.own(shapeExtrude(outline.map(([x, y]) => [x, side * y] as const), 3.4, 0.5)), lower, 0, 0, 0, CRISP);
  const belt = kit.mesh(anchor, kit.own(plateGeometry(r * 1.34, r * 0.22, 2.0, 0.2)), upper, -r * 0.2, side * r * 0.55, 2.1, CRISP);
  belt.rotation.z = side * 0.1;
  kit.mesh(anchor, kit.own(plateGeometry(r * 1.1, r * 0.46, 1.4, 0.16)), upper, -r * 0.08, side * r * 0.04, 2.6, CRISP);
  for (let k = 0; k < 4; k++) {
    parts.vents.push(kit.mesh(anchor, kit.own(diamondGeometry(0.8, 0.4)), parts.glow, -r * 0.72 + k * r * 0.36, side * (r * 0.5 + k * r * 0.036), 3.3, FINE));
  }
  const fin = kit.mesh(anchor, kit.own(finGeometry(r * 0.62, r * 0.24, 0.9)), upper, -r * 0.66, side * r * 0.42, 3.2, CRISP);
  fin.rotation.z = Math.PI - side * 0.28;
}

/** The engine block: a heavy stern, three nozzles and their flames, radiator fins on top. */
function buildStern(kit: MechKit, anchor: THREE.Group, radius: number, parts: ArmadaParts, flames: THREE.Mesh[]): void {
  const [lower, upper] = parts.plates;
  const r = radius;
  kit.mesh(anchor, kit.own(plateGeometry(r * 1.44, r * 1.58, 4.6, 0.2)), lower, r * 0.06, 0, 0.6, CRISP);
  kit.mesh(anchor, kit.own(plateGeometry(r * 0.96, r * 1.1, 1.4, 0.18)), upper, r * 0.14, 0, 3.6, CRISP);
  for (let k = -1; k <= 1; k++) {
    const nozzle = kit.mesh(anchor, kit.own(nozzleGeometry(r * 0.34, r * 0.2)), upper, -r * 0.8, k * r * 0.46, 0.2, ROUND);
    nozzle.rotation.z = Math.PI;
    flames.push(kit.mesh(anchor, kit.own(diamondGeometry(r * 0.16, 0.5)), parts.glow, -r * 1.08, k * r * 0.46, 0.2, FINE));
  }
  for (let k = -1; k <= 1; k++) kit.mesh(anchor, kit.own(lineGeometry(r * 0.72, 0.6, 1.6)), upper, r * 0.1, k * r * 0.3, 4.9, FINE);
  parts.vents.push(kit.mesh(anchor, kit.own(lineGeometry(0.6, r * 1.2, 0.5)), parts.glow, -r * 0.6, 0, 3.4, FINE));
}

/** A trainable vertical-launch silo: a turntable, the launcher with its grid of cells, one hatch lid and missile per cell. */
function buildSilo(kit: MechKit, anchor: THREE.Group, def: PartDef, parts: ArmadaParts, tipGeometry: THREE.BufferGeometry): void {
  const [lower, upper] = parts.plates;
  const r = toWorld(def.rad);
  const box = r * 1.24;
  kit.mesh(anchor, kit.own(discGeometry(r * 0.88, r * 0.96, 2.2, 10)), lower, 0, 0, 0, CRISP);
  kit.mesh(anchor, kit.own(plateGeometry(box, box, 3.0, 0.12)), upper, 0, 0, 2.4, CRISP);
  const lid = box - 0.8;
  const layout = cellLayout(lid, lid, SILO_COLUMNS, SILO_ROWS, 0.5);
  kit.mesh(anchor, kit.own(cellGridGeometry(lid, lid, 0.6, layout)), lower, 0, 0, 4.3, CRISP);
  const hatchGeometry = sharedEdges(kit, new THREE.BoxGeometry(layout.cellX * 0.94, layout.cellY * 0.94, 0.34), FINE);
  for (const [x, y] of layout.centers) {
    parts.tips.push(place(anchor, tipGeometry, parts.glow, x, y, 3.8));
    const hinge = new THREE.Group();
    hinge.position.set(x - layout.cellX * 0.5, y, 4.75);
    anchor.add(hinge);
    place(hinge, hatchGeometry, upper, layout.cellX * 0.5, 0, 0);
    parts.hatches.push(hinge);
  }
  const chevron = kit.mesh(anchor, kit.own(finGeometry(r * 0.5, r * 0.36, 0.5)), parts.glow, box * 0.5 + 1.4, 0, 2.6, FINE);
  chevron.rotation.x = 0.2;
  parts.muzzle = kit.mesh(anchor, kit.own(diamondGeometry(r * 0.2, 0.6)), parts.glow, toWorld(def.muzzle), 0, 3.4, FINE);
  for (const side of [-1, 1] as const) parts.vents.push(kit.mesh(anchor, kit.own(lineGeometry(box * 0.7, 0.5, 0.6)), parts.glow, -0.4, side * (box * 0.5 + 0.35), 2.4, FINE));
}

/** A broadside gatling turret: a turntable, the housing, six barrels in two clamps out to the muzzle. */
function buildGatling(kit: MechKit, anchor: THREE.Group, def: PartDef, parts: ArmadaParts, barrelGeometry: THREE.BufferGeometry, clampGeometry: THREE.BufferGeometry): void {
  const [lower, upper] = parts.plates;
  const r = toWorld(def.rad);
  const reach = toWorld(def.muzzle);
  kit.mesh(anchor, kit.own(discGeometry(r * 0.86, r * 0.96, 2.2, 10)), lower, 0, 0, 0, CRISP);
  kit.mesh(anchor, kit.own(shapeExtrude([[-r * 0.62, -r * 0.5], [r * 0.3, -r * 0.5], [r * 0.56, -r * 0.24], [r * 0.56, r * 0.24], [r * 0.3, r * 0.5], [-r * 0.62, r * 0.5], [-r * 0.74, 0]], 3.6, 0.45)), upper, 0, 0, 2.6, CRISP);
  const start = r * 0.4;
  const length = reach - start;
  const barrels = new THREE.Group();
  barrels.position.set(start, 0, 3.0);
  anchor.add(barrels);
  const ring = r * 0.15;
  for (let k = 0; k < GATLING_BARRELS; k++) {
    const angle = (k / GATLING_BARRELS) * TWO_PI;
    const barrel = place(barrels, barrelGeometry, parts.glow, length * 0.5, Math.cos(angle) * ring, Math.sin(angle) * ring);
    barrel.scale.x = length;
  }
  place(anchor, clampGeometry, upper, start + length * 0.22, 0, 3.0);
  place(anchor, clampGeometry, upper, start + length * 0.8, 0, 3.0);
  const blur = kit.mesh(anchor, kit.own(ringGeometry(ring * 1.6, 0.18)), parts.glow, start + length * 0.52, 0, 3.0, FINE);
  blur.rotation.y = Math.PI * 0.5;
  parts.barrels = barrels;
  parts.blur = blur;
  parts.muzzle = kit.mesh(anchor, kit.own(diamondGeometry(r * 0.22, 0.7)), parts.glow, reach + 0.6, 0, 3.0, FINE);
  for (const side of [-1, 1] as const) parts.vents.push(kit.mesh(anchor, kit.own(lineGeometry(r * 0.44, 0.5, 0.5)), parts.glow, -r * 0.38, side * r * 0.3, 4.6, FINE));
}

export function createArmada(): ColossusModel {
  const kit = createMechKit();
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  const massMat = kit.teamMaterial(0.4, 0.74, 0.6, 0x04090d, 0.46, 1.5);
  const coreMat = kit.accentMaterial(0xffd9a0, 0x241105, 2.2, 0.16, 1.3);
  const haloMat = kit.glassMaterial(ACCENT, 0x140a02);
  const glass = kit.glassMaterial(0xffc27a, 0x140a02);
  const tipGeometry = sharedEdges(kit, new THREE.OctahedronGeometry(1.1, 0), FINE);
  const barrelGeometry = sharedEdges(kit, tubeGeometry(0.62, 1, 6), CRISP);
  const clampGeometry = sharedEdges(kit, tubeGeometry(3.0, 1.1, 12), ROUND);

  const keel = kit.mesh(body, kit.own(shapeExtrude(KEEL_OUTLINE, KEEL_DEPTH, 0.6)), massMat, 0, 0, KEEL_Z, CRISP);
  kit.mesh(keel, kit.own(plateGeometry(34, 9, 1.0, 0.2)), massMat, -22, 0, KEEL_DEPTH * 0.5 + 0.9, CRISP);
  // Cross-beams carry the side hulls and the gatling outriggers: one trimaran hull, not loose pieces.
  for (const side of [-1, 1] as const) {
    for (const [x, y, length, width, angle] of CROSS_BEAMS) {
      const beam = kit.mesh(keel, kit.own(plateGeometry(length, width, 1.4, 0.2)), massMat, x, side * y, 0.2, CRISP);
      beam.rotation.z = side * angle;
    }
  }
  const reactor = kit.mesh(body, kit.own(ringGeometry(ARMADA_CORE_R * 1.3, 0.5)), haloMat, 0, 0, CORE_Z - 0.6, FINE);
  const core = kit.mesh(body, kit.own(new THREE.OctahedronGeometry(ARMADA_CORE_R * 0.7, 0)), coreMat, 0, 0, CORE_Z, FINE);
  const collapse = kit.mesh(body, kit.own(ringGeometry(ARMADA_FORM.reach * 0.62, 0.34)), haloMat, 0, 0, CORE_Z + 2, FINE);

  const flames: THREE.Mesh[] = [];
  let radar: THREE.Mesh | null = null;
  const nodes: ArmadaNode[] = ARMADA_FORM.parts.map((def, index) => {
    const anchor = new THREE.Group();
    body.add(anchor);
    const radius = toWorld(def.rad);
    const pod = def.kind === PartKind.Pod;
    const parts: ArmadaParts = {
      plates: [kit.teamMaterial(0.48, 0.9, 1.24, 0x07131b, 0.5, 1.7), kit.teamMaterial(0.62, 0.8, 1.42, 0x0b1621, 0.4, 1.45)],
      glow: kit.accentMaterial(ACCENT, ACCENT_FILL, 1.7, 0.16, 1.35),
      hatches: [],
      tips: [],
      vents: [],
      barrels: null,
      blur: null,
      muzzle: null,
    };
    const name = def.name;
    if (name === 'bow') buildBow(kit, anchor, radius, parts);
    else if (name === 'bridge') radar = buildBridge(kit, anchor, radius, parts, glass);
    else if (name === 'hullL' || name === 'hullR') buildSponson(kit, anchor, radius, name === 'hullL' ? 1 : -1, parts);
    else if (name === 'stern') buildStern(kit, anchor, radius, parts, flames);
    else if (name === 'vlsL' || name === 'vlsR') buildSilo(kit, anchor, def, parts, tipGeometry);
    else if (name === 'gatlingL' || name === 'gatlingR') buildGatling(kit, anchor, def, parts, barrelGeometry, clampGeometry);
    else throw new RangeError(`ARMADA has no model for part ${name}`);
    let conduit: THREE.Mesh | null = null;
    if (pod) {
      conduit = kit.mesh(body, kit.own(lineGeometry(1, 0.9, 0.5)), parts.glow, 0, 0, CONDUIT_Z, FINE);
      conduit.visible = false;
    }
    return {
      index, def, anchor, plates: parts.plates, glow: parts.glow, conduit, hatches: parts.hatches, tips: parts.tips,
      barrels: parts.barrels, blur: parts.blur, muzzle: parts.muzzle, vents: parts.vents,
    };
  });
  if (radar === null) throw new RangeError('ARMADA needs its bridge');
  const bridgeRadar: THREE.Mesh = radar;
  const spinAngles = nodes.map(() => 0);
  let lastTime = Number.NaN;

  return {
    root,
    setTeam(color) {
      kit.setTeam(color);
      for (const node of nodes) node.plates[0].uniforms.uFill.value.copy(color).multiplyScalar(TEAM_FILL_TINT);
    },
    update(pose: ColossusPose) {
      const assemble = smooth01(pose.assemble);
      const windup = pose.phase === AttackPhase.Windup ? smooth01(pose.progress) : 0;
      const siegeBrace = pose.attack === Attack.Siege && pose.phase === AttackPhase.Windup ? windup : 0;
      const ultimaWindup = pose.attack === Attack.Ultima && pose.phase === AttackPhase.Windup ? windup : 0;
      const barrage = pose.attack === Attack.Ultima && pose.phase === AttackPhase.Release ? 1 : 0;
      const recovery = pose.phase === AttackPhase.Recovery ? 1 - pose.progress : 0;
      const kick = pose.attack === Attack.Siege && pose.phase === AttackPhase.Recovery ? recovery * recovery : 0;
      const firingRole = pose.phase === AttackPhase.Release ? roleOf(pose.attack) : 0;
      const open = Math.max(ultimaWindup, barrage);
      const elapsed = Number.isFinite(lastTime) ? Math.min(MAX_FRAME_SECONDS, Math.max(0, pose.time - lastTime)) : 0;
      lastTime = pose.time;

      body.rotation.z = pose.body;
      // Braced for the siege the bow dips; the launch kicks it up and it settles through the recovery.
      body.rotation.y = siegeBrace * RECOIL_PITCH * 0.5 - kick * RECOIL_PITCH;
      body.position.z = Math.sin(pose.time * 0.9) * 0.4 - siegeBrace * SIEGE_SQUAT - barrage * SIEGE_SQUAT * 0.6;
      keel.scale.set(1, 1, 1 + open * 0.1);
      core.scale.setScalar(0.5 + assemble * (0.28 + pose.fuel * 0.3) + open * 0.12);
      core.rotation.z = pose.time * 0.5;
      reactor.rotation.z = -pose.time * 0.2;
      reactor.scale.setScalar(0.9 + open * 0.12 + Math.sin(pose.time * 3) * 0.02);
      collapse.visible = ultimaWindup > 0.01;
      collapse.scale.setScalar(Math.max(0.05, lerp(1.7, 0.45, ultimaWindup)));
      collapse.rotation.z = pose.time * 0.4;
      bridgeRadar.rotation.z = pose.time * RADAR_RATE * (1 + open * 3);
      for (let i = 0; i < flames.length; i++) flames[i].scale.set(1 + pose.speed * 2.2 + open * 0.6, 1, 0.8 + pose.speed * 0.5);

      applyColossusVectorState(kit, pose.time, pose.hit, pose.fuel, assemble);
      massMat.uniforms.uOpacity.value = 0.5;
      massMat.uniforms.uPulse.value = 0;
      massMat.uniforms.uFlash.value = pose.hit * 0.1;
      coreMat.uniforms.uFlash.value = pose.hit;
      coreMat.uniforms.uPulse.value += 0.1 + open * 0.3 + (1 - pose.fuel) * 0.1;
      haloMat.uniforms.uOpacity.value = 0.18 + open * 0.2 + (1 - pose.fuel) * 0.06;

      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        const part = pose.parts[node.index];
        const ease = easeOutCubic((assemble - node.index * ASSEMBLE_STEP) / (1 - node.index * ASSEMBLE_STEP));
        const alive = part.hp > 0 && ease > 0.02;
        node.anchor.visible = alive;
        if (node.conduit !== null) node.conduit.visible = false;
        if (!alive) continue;
        const pod = node.def.kind === PartKind.Pod;
        const homeX = toWorld(node.def.x);
        const homeY = toWorld(node.def.y);
        const arc = Math.sin(ease * Math.PI);
        const x = homeX * ease - homeY * ASSEMBLE_ARC_SWAY * arc;
        const y = homeY * ease + homeX * ASSEMBLE_ARC_SWAY * arc;
        node.anchor.position.set(x, y, (pod ? POD_Z : ARMOR_Z) + (1 - ease) * ASSEMBLE_DROP + arc * ASSEMBLE_ARC_HEIGHT);
        node.anchor.rotation.z = pod ? part.facing - pose.body : 0;
        const weak = part.hp < WEAK_HP ? 0.12 + 0.08 * Math.sin(pose.time * 13 + i) : 0;
        for (const plate of node.plates) {
          plate.uniforms.uFlash.value = Math.max(part.flash * 0.36, pose.hit * 0.16);
          plate.uniforms.uPulse.value += weak + open * ULTIMA_HULL_GLOW;
        }
        if (!pod) node.anchor.scale.z = 1 + open * ULTIMA_PLATE_RISE;
        const firing = (node.def.roles & firingRole) !== 0 ? 1 : 0;
        const charge = smooth01(part.charge);
        const live = Math.max(charge, firing, part.heat * 0.7);
        node.glow.uniforms.uFlash.value = part.flash * 0.3;
        node.glow.uniforms.uPulse.value += charge * 0.7 + part.heat * 0.5 + firing * 0.3 + open * 0.12;
        for (let k = 0; k < node.vents.length; k++) node.vents[k].scale.setScalar(0.8 + part.heat * 0.5 + Math.sin(pose.time * 7 + i + k) * 0.04);
        if (!pod) continue;
        // A silo's lids open through its wind-up and stay open while its missiles are away and hot.
        const lids = Math.max(charge, firing, part.heat);
        for (let k = 0; k < node.hatches.length; k++) node.hatches[k].rotation.y = -lids * HATCH_OPEN * (0.86 + 0.14 * ((k * 7) % 3) / 2);
        for (let k = 0; k < node.tips.length; k++) node.tips[k].position.z = 3.8 + lids * 1.1;
        if (node.barrels !== null && node.blur !== null) {
          spinAngles[i] = (spinAngles[i] + elapsed * live * GATLING_SPIN_RATE) % TWO_PI;
          node.barrels.rotation.x = spinAngles[i];
          node.blur.visible = live > 0.15;
        }
        if (node.muzzle !== null) {
          node.muzzle.visible = charge > 0.02 || firing > 0;
          node.muzzle.scale.setScalar(0.6 + charge * 1.4 + firing * 0.5);
        }
        if (node.conduit !== null) {
          // The tell: energy runs from the core to every pod that is about to fire, and keeps feeding the ultima's pods.
          const ultimaPod = (node.def.roles & Role.Ultima) !== 0 ? 1 : 0;
          const power = Math.max(charge * 0.9, ultimaPod * Math.max(ultimaWindup * 0.8, barrage * CONDUIT_BARRAGE));
          node.conduit.visible = power > 0.02;
          const reach = Math.hypot(x, y);
          node.conduit.position.set(x * 0.5, y * 0.5, CONDUIT_Z);
          node.conduit.scale.x = Math.max(0.001, reach);
          node.conduit.rotation.z = Math.atan2(y, x);
        }
      }
    },
    dispose() {
      kit.dispose();
    },
  };
}

function roleOf(attack: number): number {
  return attack === Attack.Salvo ? Role.Salvo : attack === Attack.Siege ? Role.Siege : attack === Attack.Ultima ? Role.Ultima : 0;
}
