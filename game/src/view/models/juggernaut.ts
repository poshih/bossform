import * as THREE from 'three';
import { Attack, AttackPhase, FORMS, Frame, FRAME_STATS, JUGGERNAUT, PartKind } from '../../sim/index.ts';
import type { ColossusModel, ColossusPose, PartPose, RobotModel, RobotPose } from './types.ts';
import {
  ResourceTracker,
  createAccentMaterial,
  createTeamMaterial,
  diamondGeometry,
  easeOutCubic,
  lineGeometry,
  mix,
  polygonGeometry,
  pulse,
  ringGeometry,
  setFlash,
  setOpacity,
  smooth01,
  tintTeamMaterials,
  to,
  type TeamMaterialRef,
} from './kit-enemies.ts';
import type { VectorMaterial } from '../../render/vector.ts';

const BODY_RADIUS = to(FRAME_STATS[Frame.Juggernaut].bodyR);
const FORTRESS = FORMS[Frame.Juggernaut];
const MORTAR_INDEX = 6;
const TURRET_LEFT_INDEX = 7;
const TURRET_RIGHT_INDEX = 8;
const CORE_LIFT = 6.4;
const PART_HEIGHT = 3.2;
const PART_STACK = 1.9;
const ANCHOR_LIFT = -2.2;

interface RobotRig {
  readonly root: THREE.Group;
  readonly body: THREE.Group;
  readonly turret: THREE.Group;
  readonly shieldShell: THREE.Mesh;
  readonly muzzleFlash: THREE.Mesh;
  readonly engineLeft: THREE.Mesh;
  readonly engineRight: THREE.Mesh;
  readonly teamMaterials: TeamMaterialRef[];
  readonly materials: VectorMaterial[];
  readonly tracker: ResourceTracker;
}

interface PartRig {
  readonly def: (typeof FORTRESS.parts)[number];
  readonly group: THREE.Group;
  readonly hullMaterials: VectorMaterial[];
  readonly accentMaterials: VectorMaterial[];
  readonly barrel: THREE.Mesh | null;
  readonly muzzleDiamond: THREE.Mesh | null;
  readonly muzzleRing: THREE.Mesh | null;
  readonly vents: readonly THREE.Mesh[];
  readonly homeX: number;
  readonly homeY: number;
  readonly homeZ: number;
  readonly openDirX: number;
  readonly openDirY: number;
  readonly baseRotation: number;
}

interface ColossusRig {
  readonly root: THREE.Group;
  readonly body: THREE.Group;
  readonly tracker: ResourceTracker;
  readonly teamMaterials: TeamMaterialRef[];
  readonly hullMaterials: VectorMaterial[];
  readonly accentMaterials: VectorMaterial[];
  readonly parts: readonly PartRig[];
  readonly core: THREE.Mesh;
  readonly coreHalo: THREE.Mesh;
  readonly coreCollapse: THREE.Mesh;
  readonly reactorFrame: THREE.Mesh;
  readonly keelFront: THREE.Mesh;
  readonly keelBack: THREE.Mesh;
  readonly crossBeam: THREE.Mesh;
  readonly turretArms: readonly THREE.Mesh[];
  readonly plateGirders: readonly THREE.Mesh[];
  readonly head: THREE.Group;
  readonly headEye: THREE.Mesh;
  readonly energyLines: readonly THREE.Mesh[];
  readonly anchors: readonly THREE.Group[];
  readonly thrusters: readonly THREE.Mesh[];
}

function addVectorMesh(
  tracker: ResourceTracker,
  parent: THREE.Object3D,
  material: VectorMaterial,
  geometry: THREE.BufferGeometry,
  creaseDegrees: number,
): THREE.Mesh<THREE.BufferGeometry, VectorMaterial> {
  return tracker.mesh(geometry, material, creaseDegrees, parent) as THREE.Mesh<THREE.BufferGeometry, VectorMaterial>;
}

function makePodShape(radius: number, length: number, width: number): THREE.BufferGeometry {
  const tip = length * 0.52;
  const bodyHalf = width * 0.5;
  return polygonGeometry([
    [-radius * 0.44, -bodyHalf],
    [length * 0.2, -bodyHalf],
    [tip, -width * 0.18],
    [length * 0.5, bodyHalf],
    [-radius * 0.44, bodyHalf],
  ], PART_HEIGHT);
}

function makeArmorShape(name: string, radius: number): THREE.BufferGeometry {
  const front = radius * 0.98;
  const back = -radius * 0.78;
  const side = radius * 0.82;
  if (name === 'front') {
    return polygonGeometry([
      [back, -radius * 0.62],
      [radius * 0.12, -radius * 0.9],
      [front, 0],
      [radius * 0.12, radius * 0.9],
      [back, radius * 0.62],
    ], PART_HEIGHT);
  }
  if (name === 'back') {
    return polygonGeometry([
      [back, -radius * 0.58],
      [radius * 0.56, -radius * 0.52],
      [front * 0.7, 0],
      [radius * 0.56, radius * 0.52],
      [back, radius * 0.58],
    ], PART_HEIGHT);
  }
  const skew = name.endsWith('L') ? 1 : -1;
  return polygonGeometry([
    [back, -radius * 0.46],
    [radius * 0.06, -radius * 0.82],
    [front, -radius * 0.34 * skew],
    [front * 0.88, radius * 0.5 * skew],
    [-radius * 0.08, side],
    [back, radius * 0.54],
  ], PART_HEIGHT);
}

function createJuggernautRig(): RobotRig {
  const root = new THREE.Group();
  const body = new THREE.Group();
  const turret = new THREE.Group();
  const fx = new THREE.Group();
  root.add(body, fx);
  const tracker = new ResourceTracker();
  const teamMaterials: TeamMaterialRef[] = [];
  const materials: VectorMaterial[] = [];
  const hullMat = createTeamMaterial(tracker, teamMaterials, 0.82, 0.05, 1.55, 1.45);
  const trimMat = createTeamMaterial(tracker, teamMaterials, 0.64, 0.036, 1.3, 1.15);
  const shieldMat = createTeamMaterial(tracker, teamMaterials, 1.05, 0.015, 2.25, 1.2);
  const weaponMat = createAccentMaterial(tracker, 0xffd69a, 0x2a1407, 0.24, 2.3, 1.2);
  const engineMat = createAccentMaterial(tracker, 0xff9a58, 0x221108, 0.2, 2.0, 1.1);
  materials.push(hullMat, trimMat, shieldMat, weaponMat, engineMat);

  const hull = addVectorMesh(tracker, body, hullMat, new THREE.BoxGeometry(BODY_RADIUS * 1.82, BODY_RADIUS * 1.25, 5.2), 30);
  hull.position.z = 3.4;
  const prow = addVectorMesh(tracker, body, trimMat, polygonGeometry([
    [-BODY_RADIUS * 0.18, -BODY_RADIUS * 0.48],
    [BODY_RADIUS * 0.56, -BODY_RADIUS * 0.66],
    [BODY_RADIUS * 1.0, 0],
    [BODY_RADIUS * 0.56, BODY_RADIUS * 0.66],
    [-BODY_RADIUS * 0.18, BODY_RADIUS * 0.48],
  ], 4.4), 28);
  prow.position.set(BODY_RADIUS * 0.52, 0, 5.6);
  const spine = addVectorMesh(tracker, body, trimMat, new THREE.BoxGeometry(BODY_RADIUS * 1.08, BODY_RADIUS * 0.74, 3.2), 32);
  spine.position.set(-BODY_RADIUS * 0.08, 0, 7.1);
  const treadL = addVectorMesh(tracker, body, trimMat, new THREE.BoxGeometry(BODY_RADIUS * 1.1, BODY_RADIUS * 0.36, 3.8), 30);
  treadL.position.set(-BODY_RADIUS * 0.12, BODY_RADIUS * 0.85, 2.1);
  const treadR = addVectorMesh(tracker, body, trimMat, new THREE.BoxGeometry(BODY_RADIUS * 1.1, BODY_RADIUS * 0.36, 3.8), 30);
  treadR.position.set(-BODY_RADIUS * 0.12, -BODY_RADIUS * 0.85, 2.1);
  const generatorL = addVectorMesh(tracker, body, hullMat, new THREE.CylinderGeometry(BODY_RADIUS * 0.18, BODY_RADIUS * 0.24, BODY_RADIUS * 0.48, 6), 34);
  generatorL.rotation.x = Math.PI * 0.5;
  generatorL.position.set(-BODY_RADIUS * 0.05, BODY_RADIUS * 1.07, 5.4);
  const generatorR = addVectorMesh(tracker, body, hullMat, new THREE.CylinderGeometry(BODY_RADIUS * 0.18, BODY_RADIUS * 0.24, BODY_RADIUS * 0.48, 6), 34);
  generatorR.rotation.x = Math.PI * 0.5;
  generatorR.position.set(-BODY_RADIUS * 0.05, -BODY_RADIUS * 1.07, 5.4);

  const cannonHousing = addVectorMesh(tracker, turret, hullMat, polygonGeometry([
    [-BODY_RADIUS * 0.22, -BODY_RADIUS * 0.25],
    [BODY_RADIUS * 0.35, -BODY_RADIUS * 0.38],
    [BODY_RADIUS * 0.64, 0],
    [BODY_RADIUS * 0.35, BODY_RADIUS * 0.38],
    [-BODY_RADIUS * 0.22, BODY_RADIUS * 0.25],
  ], 3.8), 28);
  cannonHousing.position.set(BODY_RADIUS * 0.28, 0, 8.4);
  const barrel = addVectorMesh(tracker, turret, weaponMat, lineGeometry(to(JUGGERNAUT.mortar.shot.rad) * 1.9 + 6, 2.2, 2.2), 28);
  barrel.position.set(BODY_RADIUS * 0.9, 0, 8.7);
  const muzzleFlash = addVectorMesh(tracker, turret, weaponMat, diamondGeometry(6.4, 3.6, 3.6), 28);
  muzzleFlash.position.set(BODY_RADIUS * 1.55, 0, 8.8);
  turret.position.set(BODY_RADIUS * 0.15, 0, 0);
  body.add(turret);

  const shieldShell = addVectorMesh(tracker, fx, shieldMat, new THREE.OctahedronGeometry(BODY_RADIUS * 1.34, 0), 30);
  shieldShell.scale.set(1.4, 1.05, 0.85);
  shieldShell.position.z = 6.2;

  const engineLeft = addVectorMesh(tracker, body, engineMat, new THREE.CylinderGeometry(1.2, 1.8, 3.4, 6), 30);
  engineLeft.rotation.x = Math.PI * 0.5;
  engineLeft.position.set(-BODY_RADIUS * 0.86, BODY_RADIUS * 0.48, 1.5);
  const engineRight = addVectorMesh(tracker, body, engineMat, new THREE.CylinderGeometry(1.2, 1.8, 3.4, 6), 30);
  engineRight.rotation.x = Math.PI * 0.5;
  engineRight.position.set(-BODY_RADIUS * 0.86, -BODY_RADIUS * 0.48, 1.5);

  return { root, body, turret, shieldShell, muzzleFlash, engineLeft, engineRight, teamMaterials, materials, tracker };
}

function podAssembly(assemble: number, index: number, count: number): number {
  const start = 0.08 + (index / Math.max(1, count - 1)) * 0.28;
  return easeOutCubic((assemble - start) / 0.52);
}

function buildPartRig(tracker: ResourceTracker, teamMaterials: TeamMaterialRef[], hullMaterials: VectorMaterial[], accentMaterials: VectorMaterial[], def: (typeof FORTRESS.parts)[number]): PartRig {
  const group = new THREE.Group();
  const hullMat = createTeamMaterial(tracker, teamMaterials, 0.82, 0.05, 1.5, 1.35);
  const insetMat = createTeamMaterial(tracker, teamMaterials, 0.66, 0.032, 1.22, 1.05);
  const ventMat = createAccentMaterial(tracker, 0xffbf72, 0x1f1208, 0.2, 2.1, 1.05);
  hullMaterials.push(hullMat, insetMat);
  accentMaterials.push(ventMat);

  const radius = to(def.rad);
  const homeX = to(def.x);
  const homeY = to(def.y);
  const homeZ = def.kind === PartKind.Pod ? CORE_LIFT + 2.4 : CORE_LIFT + 1.2;
  const length = radius * (def.kind === PartKind.Pod ? 1.75 : 1.62);
  const width = radius * (def.kind === PartKind.Pod ? 1.05 : 1.45);
  const baseGeometry = def.kind === PartKind.Pod ? makePodShape(radius, length, width) : makeArmorShape(def.name, radius);
  const hull = addVectorMesh(tracker, group, hullMat, baseGeometry, 28);
  hull.position.z = 0;
  const inset = addVectorMesh(tracker, group, insetMat, def.kind === PartKind.Pod ? makePodShape(radius * 0.78, length * 0.7, width * 0.58) : makeArmorShape(def.name, radius * 0.68), 60);
  inset.position.z = PART_STACK;

  const vents: THREE.Mesh[] = [];
  const addVent = (x: number, y: number, z: number): THREE.Mesh => {
    const vent = addVectorMesh(tracker, group, ventMat, ringGeometry(radius * 0.18, radius * 0.09, 0.7), 28);
    vent.position.set(x, y, z);
    vents.push(vent);
    return vent;
  };
  addVent(-radius * 0.28, radius * 0.22, PART_STACK + 0.6);
  addVent(-radius * 0.28, -radius * 0.22, PART_STACK + 0.6);

  let barrel: THREE.Mesh | null = null;
  let muzzleDiamond: THREE.Mesh | null = null;
  let muzzleRing: THREE.Mesh | null = null;
  if (def.kind === PartKind.Pod) {
    barrel = addVectorMesh(tracker, group, ventMat, lineGeometry(to(def.muzzle), radius * 0.3, radius * 0.3), 28);
    barrel.position.set(radius * 0.22, 0, PART_STACK + 0.5);
    muzzleDiamond = addVectorMesh(tracker, group, ventMat, diamondGeometry(radius * 0.9, radius * 0.55, radius * 0.55), 28);
    muzzleDiamond.position.set(radius * 0.22 + to(def.muzzle), 0, PART_STACK + 0.5);
    muzzleRing = addVectorMesh(tracker, group, ventMat, ringGeometry(radius * 0.38, radius * 0.18, 0.5), 28);
    muzzleRing.position.set(radius * 0.22 + to(def.muzzle) + radius * 0.18, 0, PART_STACK + 0.5);
    muzzleRing.rotation.x = Math.PI * 0.5;
  }

  const openLength = Math.hypot(homeX, homeY) || 1;
  return {
    def,
    group,
    hullMaterials: [hullMat, insetMat],
    accentMaterials: [ventMat],
    barrel,
    muzzleDiamond,
    muzzleRing,
    vents,
    homeX,
    homeY,
    homeZ,
    openDirX: homeX / openLength,
    openDirY: homeY / openLength,
    baseRotation: def.kind === PartKind.Pod ? 0 : Math.atan2(homeY, homeX),
  };
}

function createFortressRig(): ColossusRig {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const tracker = new ResourceTracker();
  const teamMaterials: TeamMaterialRef[] = [];
  const hullMaterials: VectorMaterial[] = [];
  const accentMaterials: VectorMaterial[] = [];

  const coreMat = createAccentMaterial(tracker, 0xffd7a6, 0x241109, 0.18, 2.5, 1.25);
  const haloMat = createAccentMaterial(tracker, 0xffc063, 0x1a0d05, 0.08, 1.95, 1.0);
  const lineMat = createAccentMaterial(tracker, 0xffd591, 0x1c1006, 0.14, 2.05, 0.95);
  const anchorMat = createTeamMaterial(tracker, teamMaterials, 0.62, 0.03, 1.15, 1.0);
  hullMaterials.push(anchorMat);
  accentMaterials.push(coreMat, haloMat, lineMat);

  const core = addVectorMesh(tracker, body, coreMat, diamondGeometry(to(FORTRESS.coreR) * 1.1, to(FORTRESS.coreR) * 0.86, to(FORTRESS.coreR) * 0.86), 28);
  core.position.z = CORE_LIFT;
  const coreHalo = addVectorMesh(tracker, body, haloMat, ringGeometry(to(FORTRESS.coreR) * 1.55, to(FORTRESS.coreR) * 1.18, 0.9), 28);
  coreHalo.position.z = CORE_LIFT - 0.4;
  const coreCollapse = addVectorMesh(tracker, body, coreMat, ringGeometry(to(FORTRESS.coreR) * 2.8, to(FORTRESS.coreR) * 2.2, 0.7), 28);
  coreCollapse.position.z = CORE_LIFT - 1.4;
  const reactorFrame = addVectorMesh(tracker, body, anchorMat, ringGeometry(to(FORTRESS.coreR) * 3.15, to(FORTRESS.coreR) * 2.55, 1.2), 60);
  reactorFrame.position.z = CORE_LIFT + 0.2;
  const keelFront = addVectorMesh(tracker, body, anchorMat, lineGeometry(to(FORTRESS.parts[MORTAR_INDEX].x) - to(FORTRESS.coreR) * 1.8, 2.6, 1.3), 55);
  keelFront.position.set(to(FORTRESS.coreR) * 1.8, 0, CORE_LIFT + 0.1);
  const keelBack = addVectorMesh(tracker, body, anchorMat, lineGeometry(Math.abs(to(FORTRESS.parts[5].x)) - to(FORTRESS.coreR) * 1.1, 2.2, 1.1), 55);
  keelBack.position.set(-Math.abs(to(FORTRESS.parts[5].x)) + 5, 0, CORE_LIFT - 0.2);
  keelBack.rotation.z = Math.PI;
  const crossBeam = addVectorMesh(tracker, body, anchorMat, lineGeometry(to(FORTRESS.parts[TURRET_LEFT_INDEX].y) * 2 - 24, 2.2, 1.1), 55);
  crossBeam.position.set(-2, -to(FORTRESS.parts[TURRET_LEFT_INDEX].y) + 12, CORE_LIFT - 0.25);
  crossBeam.rotation.z = Math.PI * 0.5;

  const head = new THREE.Group();
  const headHull = addVectorMesh(tracker, head, createTeamMaterial(tracker, teamMaterials, 0.74, 0.05, 1.45, 1.2), polygonGeometry([
    [-4.2, -3.2],
    [1.2, -3.8],
    [7.4, 0],
    [1.2, 3.8],
    [-4.2, 3.2],
  ], 2.8), 28);
  headHull.position.z = 0;
  const headEye = addVectorMesh(tracker, head, lineMat, ringGeometry(1.8, 0.7, 0.6), 28);
  headEye.position.set(2.6, 0, 1.2);
  headEye.rotation.x = Math.PI * 0.5;
  head.position.set(12.4, 0, CORE_LIFT + 5.1);
  body.add(head);

  const parts = FORTRESS.parts.map((def) => {
    const part = buildPartRig(tracker, teamMaterials, hullMaterials, accentMaterials, def);
    body.add(part.group);
    return part;
  });

  const plateGirders = parts.map((part) => {
    const length = Math.max(4, Math.hypot(part.homeX, part.homeY) - to(part.def.rad) * 0.82);
    const girder = addVectorMesh(tracker, body, anchorMat, lineGeometry(length, 1.55, 0.95), 60);
    girder.position.set(0, 0, CORE_LIFT - 0.35);
    girder.rotation.z = Math.atan2(part.homeY, part.homeX);
    return girder;
  });

  const turretArms = [TURRET_LEFT_INDEX, TURRET_RIGHT_INDEX].map((index) => {
    const part = parts[index];
    const arm = addVectorMesh(tracker, body, anchorMat, lineGeometry(Math.hypot(part.homeX, part.homeY) - to(part.def.rad) * 0.95, 2.1, 1.1), 60);
    arm.position.set(0, 0, CORE_LIFT + 0.5);
    arm.rotation.z = Math.atan2(part.homeY, part.homeX);
    return arm;
  });

  const energyLines = parts.filter((part) => part.def.kind === PartKind.Pod).map((part) => {
    const length = Math.hypot(part.homeX, part.homeY) - to(part.def.rad) * 0.52;
    const line = addVectorMesh(tracker, body, lineMat, lineGeometry(length, 0.9, 0.5), 28);
    line.position.set(0, 0, CORE_LIFT - 0.2);
    line.rotation.z = Math.atan2(part.homeY, part.homeX);
    line.visible = false;
    return line;
  });

  const anchors = [
    [-18, 18],
    [-18, -18],
    [12, 15],
    [12, -15],
  ].map(([x, y]) => {
    const group = new THREE.Group();
    const foot = addVectorMesh(tracker, group, anchorMat, new THREE.BoxGeometry(8.6, 4, 2.2), 28);
    foot.position.z = ANCHOR_LIFT;
    group.position.set(x, y, 2.2);
    body.add(group);
    return group;
  });

  const thrusters = [
    addVectorMesh(tracker, body, lineMat, new THREE.CylinderGeometry(1.2, 1.9, 3.2, 6), 28),
    addVectorMesh(tracker, body, lineMat, new THREE.CylinderGeometry(1.2, 1.9, 3.2, 6), 28),
  ];
  thrusters[0].rotation.x = Math.PI * 0.5;
  thrusters[1].rotation.x = Math.PI * 0.5;
  thrusters[0].position.set(-30, 11, 2.4);
  thrusters[1].position.set(-30, -11, 2.4);

  return {
    root, body, tracker, teamMaterials, hullMaterials, accentMaterials, parts, core, coreHalo, coreCollapse,
    reactorFrame, keelFront, keelBack, crossBeam, turretArms, plateGirders, head, headEye, energyLines, anchors, thrusters,
  };
}

export function createJuggernaut(): RobotModel {
  const rig = createJuggernautRig();
  let currentTeam = new THREE.Color(0x5fe8ff);
  tintTeamMaterials(rig.teamMaterials, currentTeam);

  return {
    root: rig.root,
    setTeam(color: THREE.Color): void {
      currentTeam.copy(color);
      tintTeamMaterials(rig.teamMaterials, currentTeam);
    },
    update(pose: RobotPose): void {
      const alt = smooth01(pose.alt);
      const morph = smooth01(pose.morph);
      const recoil = smooth01(pose.fire);
      const moveDelta = Math.atan2(Math.sin(pose.move - pose.aim), Math.cos(pose.move - pose.aim));
      rig.root.rotation.z = pose.aim;
      rig.body.position.z = Math.sin(pose.time * 2.2) * 0.45;
      rig.body.rotation.x = -moveDelta * 0.08 * (0.2 + pose.speed);
      rig.body.rotation.y = pose.speed * 0.08;
      rig.body.scale.set(1 - morph * 0.55, 1 - morph * 0.55, 1 - morph * 0.65);
      rig.turret.position.x = BODY_RADIUS * 0.15 - recoil * 1.4;
      rig.muzzleFlash.scale.setScalar(0.1 + recoil * 1.2);
      rig.muzzleFlash.visible = recoil > 0.01;
      rig.engineLeft.scale.z = 0.5 + pose.speed * 0.9;
      rig.engineRight.scale.z = 0.5 + pose.speed * 0.9;
      rig.shieldShell.visible = pose.shield > 0.01;
      rig.shieldShell.scale.set(1.38 + pose.shield * 0.22, 1.04 + pose.shield * 0.18, 0.9 + pose.shield * 0.1);
      rig.shieldShell.position.z = 6.2 + Math.sin(pose.time * 4.2) * 0.35;

      const hullOpacity = 1 - morph;
      setOpacity(rig.materials, hullOpacity);
      setFlash(rig.materials, pose.hit);
      for (const material of rig.materials) material.uniforms.uPulse.value = 0;
      rig.materials[2].uniforms.uPulse.value = alt * (0.2 + recoil * 0.4);
      rig.materials[3].uniforms.uPulse.value = recoil * 0.6 + pose.charge * 0.18;
      rig.materials[4].uniforms.uPulse.value = pose.speed * 0.4 + pulse(pose.time, 10, 0, 0.18);
      (rig.shieldShell.material as VectorMaterial).uniforms.uOpacity.value = pose.shield * (1 - morph) * 0.7;
    },
    dispose(): void {
      rig.tracker.dispose();
    },
  };
}

export function createFortress(): ColossusModel {
  const rig = createFortressRig();
  let currentTeam = new THREE.Color(0x5fe8ff);
  tintTeamMaterials(rig.teamMaterials, currentTeam);

  return {
    root: rig.root,
    setTeam(color: THREE.Color): void {
      currentTeam.copy(color);
      tintTeamMaterials(rig.teamMaterials, currentTeam);
    },
    update(pose: ColossusPose): void {
      const siegeWindup = pose.attack === Attack.Siege && pose.phase === AttackPhase.Windup ? smooth01(pose.progress) : 0;
      const ultimaWindup = pose.attack === Attack.Ultima && pose.phase === AttackPhase.Windup ? smooth01(pose.progress) : 0;
      const ultimaRelease = pose.attack === Attack.Ultima && pose.phase === AttackPhase.Release ? smooth01(pose.progress) : 0;
      const recovery = pose.phase === AttackPhase.Recovery ? smooth01(pose.progress) : 0;
      const openAmount = Math.max(ultimaWindup, ultimaRelease * 0.85);
      const brace = siegeWindup;
      rig.root.rotation.z = pose.body;
      rig.body.position.z = Math.sin(pose.time * 1.3) * 0.45 - brace * 1.2;
      rig.body.scale.set(1 + brace * 0.05, 1 - brace * 0.04, 1 + brace * 0.02);
      rig.head.position.set(12.4 + brace * 1.4, 0, CORE_LIFT + 5.1 + openAmount * 0.4);
      rig.head.rotation.z = Math.sin(pose.time * 0.9) * 0.03;
      rig.headEye.scale.set(1 + ultimaWindup * 0.22, 1 + ultimaWindup * 0.22, 1);
      rig.reactorFrame.scale.setScalar(1 + openAmount * 0.06 + pulse(pose.time, 1.8, 0, 0.03));
      rig.keelFront.scale.x = 1 + brace * 0.12;
      rig.crossBeam.scale.y = 1 + openAmount * 0.08;

      const assembleCore = easeOutCubic(pose.assemble);
      rig.core.scale.setScalar((0.25 + assembleCore * 0.95) * mix(0.4, 1.1, pose.fuel));
      rig.coreHalo.scale.setScalar(0.9 + pulse(pose.time, 2.2, 0, 0.08) + pose.hit * 0.15);
      rig.coreCollapse.visible = ultimaWindup > 0.001;
      rig.coreCollapse.scale.setScalar(mix(2.4, 0.9, ultimaWindup));
      rig.coreCollapse.position.z = CORE_LIFT - 1.4;

      const coreFlash = pose.hit;
      (rig.core.material as VectorMaterial).uniforms.uFlash.value = coreFlash;
      (rig.coreHalo.material as VectorMaterial).uniforms.uFlash.value = coreFlash * 0.4;
      (rig.core.material as VectorMaterial).uniforms.uOpacity.value = 0.85;
      (rig.coreHalo.material as VectorMaterial).uniforms.uOpacity.value = 0.55 + pose.fuel * 0.25;
      (rig.coreCollapse.material as VectorMaterial).uniforms.uOpacity.value = ultimaWindup * 0.85;
      (rig.core.material as VectorMaterial).uniforms.uPulse.value = 0.25 + (1 - pose.fuel) * 0.12 + pulse(pose.time, 4.2, 0, 0.12);
      (rig.coreHalo.material as VectorMaterial).uniforms.uPulse.value = 0.12 + openAmount * 0.25;
      (rig.coreCollapse.material as VectorMaterial).uniforms.uPulse.value = ultimaWindup * 0.4;

      let podLine = 0;
      for (let i = 0; i < rig.parts.length; i++) {
        const part = rig.parts[i];
        const partPose: PartPose = pose.parts[i];
        const alive = partPose.hp > 0;
        const assemble = podAssembly(pose.assemble, i, rig.parts.length);
        part.group.visible = alive && assemble > 0.001;
        if (!part.group.visible) {
          setFlash(part.hullMaterials, 0);
          setFlash(part.accentMaterials, 0);
          rig.plateGirders[i].visible = false;
          if (part.def.kind === PartKind.Pod) {
            rig.energyLines[podLine].visible = false;
            podLine++;
          }
          continue;
        }
        rig.plateGirders[i].visible = true;
        const openPush = openAmount * to(part.def.rad) * 0.18;
        part.group.position.set(
          part.homeX * assemble + part.openDirX * openPush,
          part.homeY * assemble + part.openDirY * openPush,
          part.homeZ + openAmount * 0.6,
        );
        part.group.rotation.z = part.def.kind === PartKind.Pod ? partPose.facing - pose.body : part.baseRotation + openAmount * 0.08 * Math.sign(part.homeY || 1);
        part.group.rotation.x = brace * 0.03;
        part.group.scale.setScalar(assemble);
        setFlash(part.hullMaterials, partPose.flash);
        setFlash(part.accentMaterials, partPose.flash * 0.65);

        const damage = 1 - partPose.hp;
        for (const material of part.hullMaterials) {
          material.uniforms.uOpacity.value = 0.88;
          material.uniforms.uPulse.value = damage * 0.06;
        }
        for (const material of part.accentMaterials) {
          material.uniforms.uOpacity.value = 0.45 + partPose.heat * 0.2;
          material.uniforms.uPulse.value = partPose.heat * 0.45 + partPose.charge * 0.35 + recovery * 0.18;
        }
        for (let v = 0; v < part.vents.length; v++) {
          part.vents[v].scale.setScalar(0.85 + partPose.heat * 0.4 + Math.sin(pose.time * 7 + i + v) * 0.05);
        }
        if (part.barrel && part.muzzleDiamond && part.muzzleRing) {
          const charge = smooth01(partPose.charge);
          const recoil = recovery * 0.55;
          part.barrel.scale.x = 1 + charge * 0.35 - recoil * 0.18;
          part.muzzleDiamond.scale.setScalar(0.5 + charge * 1.05 + (pose.attack === Attack.Siege && i === MORTAR_INDEX ? brace * 0.3 : 0));
          part.muzzleDiamond.visible = charge > 0.01 || recovery > 0.01;
          part.muzzleRing.scale.setScalar(0.65 + charge * 1.25);
          part.muzzleRing.visible = charge > 0.01;
          (part.muzzleRing.material as VectorMaterial).uniforms.uOpacity.value = charge * 0.9;
          (part.muzzleRing.material as VectorMaterial).uniforms.uPulse.value = charge * 0.45;
          const line = rig.energyLines[podLine];
          const linePower = Math.max(charge * 0.85, pose.attack === Attack.Ultima && pose.phase === AttackPhase.Windup ? ultimaWindup * 0.75 : 0);
          line.visible = linePower > 0.01;
          line.scale.x = linePower;
          (line.material as VectorMaterial).uniforms.uOpacity.value = linePower * 0.9;
          (line.material as VectorMaterial).uniforms.uPulse.value = linePower * 0.35;
          podLine++;
        }
        const girder = rig.plateGirders[i];
        girder.scale.x = assemble;
        girder.scale.y = 1 + partPose.charge * 0.18;
      }

      while (podLine < rig.energyLines.length) {
        rig.energyLines[podLine].visible = false;
        podLine++;
      }

      const mortar = rig.parts[MORTAR_INDEX];
      if (mortar.group.visible) {
        mortar.group.position.x += brace * 2.6;
        mortar.group.position.z += brace * 1.8;
      }
      rig.parts[TURRET_LEFT_INDEX].group.position.y += openAmount * 2.2;
      rig.parts[TURRET_RIGHT_INDEX].group.position.y -= openAmount * 2.2;
      rig.turretArms[0].visible = rig.parts[TURRET_LEFT_INDEX].group.visible;
      rig.turretArms[1].visible = rig.parts[TURRET_RIGHT_INDEX].group.visible;
      rig.turretArms[0].scale.y = 1 + pose.parts[TURRET_LEFT_INDEX].charge * 0.22;
      rig.turretArms[1].scale.y = 1 + pose.parts[TURRET_RIGHT_INDEX].charge * 0.22;

      for (let i = 0; i < rig.anchors.length; i++) {
        const anchor = rig.anchors[i];
        const drive = Math.max(brace, ultimaWindup * 0.6);
        anchor.position.z = 2.2 - drive * 1.6;
        anchor.position.x = (i < 2 ? -18 : 12) + drive * (i < 2 ? -1.4 : 0.9);
        anchor.scale.set(1 + drive * 0.1, 1 + drive * 0.05, 1 + drive * 0.12);
      }

      rig.thrusters[0].scale.z = 0.45 + pose.speed * 0.9;
      rig.thrusters[1].scale.z = 0.45 + pose.speed * 0.9;
      (rig.thrusters[0].material as VectorMaterial).uniforms.uOpacity.value = 0.28 + pose.speed * 0.2;
      (rig.thrusters[1].material as VectorMaterial).uniforms.uOpacity.value = 0.28 + pose.speed * 0.2;
      (rig.thrusters[0].material as VectorMaterial).uniforms.uPulse.value = pose.speed * 0.35;
      (rig.thrusters[1].material as VectorMaterial).uniforms.uPulse.value = pose.speed * 0.35;
    },
    dispose(): void {
      rig.tracker.dispose();
    },
  };
}
