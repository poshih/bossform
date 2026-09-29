import * as THREE from 'three';
import type { VectorMaterial } from '../../render/vector.ts';
import { Attack, AttackPhase, FORMS, FRAME_STATS, Frame, PartKind } from '../../sim/index.ts';
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
  wedgeGeometry,
  type MechKit,
} from './kit-mechs.ts';
import { bodyHullGeometry } from './kit-hull.ts';
import { clamp01, easeOutCubic, smooth01, toWorld } from '../shared.ts';
import type { ColossusModel, ColossusPose, PartPose, RobotModel, RobotPose } from './types.ts';

const FORM = FORMS[Frame.Gale];
const ROBOT_RADIUS = toWorld(FRAME_STATS[Frame.Gale].bodyR);
const CORE_RADIUS = toWorld(FORM.coreR);
const ASSEMBLE_STEP = 0.11;
const ASSEMBLE_ARC_HEIGHT = 3.1;
const ASSEMBLE_ARC_SWAY = 0.2;
const COLOSSUS_HULL_MARGIN = 2.1;
const COLOSSUS_HULL_DEPTH = 4.8;

interface PartNode {
  readonly defIndex: number;
  readonly anchor: THREE.Group;
  readonly shells: readonly THREE.Mesh[];
  readonly barrel: THREE.Group | null;
  readonly muzzle: THREE.Mesh | null;
  readonly strut: THREE.Mesh;
  readonly vent: THREE.Mesh | null;
}

function staggered(value: number, start: number): number {
  return easeOutCubic((value - start) / (1 - start));
}

function makeNeedle(kit: MechKit, parent: THREE.Object3D, material: VectorMaterial, x: number, y: number, z: number): THREE.Mesh {
  return kit.mesh(parent, kit.own(barrelGeometry(5.4, 0.16, 0.24)), material, x, y, z, 34);
}

function bitShells(kit: MechKit, parent: THREE.Object3D, hullA: VectorMaterial, hullB: VectorMaterial, radius: number): THREE.Mesh[] {
  return [
    kit.mesh(parent, kit.own(wedgeGeometry(radius * 1.3, radius * 0.84, radius * 0.28, 0.22)), hullA, 0, 0, radius * 0.26, 56),
    kit.mesh(parent, kit.own(plateGeometry(radius * 0.98, radius * 0.54, radius * 0.18, 0.08)), hullB, radius * 0.12, 0, radius * 0.74, 56),
  ];
}

export function createGale(): RobotModel {
  const kit = createMechKit();
  const root = new THREE.Group();
  const hull = new THREE.Group();
  const moveRig = new THREE.Group();
  const dashRig = new THREE.Group();
  root.add(dashRig);
  root.add(hull);
  hull.add(moveRig);

  const hullA = kit.teamMaterial(0.42, 0.98, 1.22, 0x0a1118, 0.58, 1.7);
  const hullB = kit.teamMaterial(0.58, 0.82, 1.48, 0x0f1319, 0.56, 1.65);
  const accent = kit.accentMaterial(0xffd59c, 0x160d05, 1.72, 0.12);
  const warm = kit.accentMaterial(0xff9951, 0x180803, 1.55, 0.12);
  const glass = kit.glassMaterial(0xffc29f, 0x13050a);

  const fuselage = kit.mesh(hull, kit.own(wedgeGeometry(12.4, 4.25, 1.95, 0.18)), hullA, 0.4, 0, 2.3, 60);
  fuselage.rotation.y = -0.22;
  const spine = kit.mesh(hull, kit.own(plateGeometry(7.2, 1.25, 1.02, 0.12)), hullB, 1.4, 0, 3.56, 60);
  spine.rotation.y = -0.28;
  const core = kit.mesh(hull, kit.own(diamondGeometry(0.88, 0.32)), accent, 3.45, 0, 4.18, 34);
  core.rotation.x = 0.46;

  const head = new THREE.Group();
  head.position.set(4.1, 0, 4.26);
  hull.add(head);
  kit.mesh(head, kit.own(plateGeometry(1.2, 0.9, 0.7, 0.12)), hullB, 0, 0, 0, 56);
  kit.mesh(head, kit.own(diamondGeometry(0.26, 0.14)), glass, 0.36, 0, 0.16, 28).rotation.x = 0.4;
  for (const side of [-1, 1] as const) {
    const horn = kit.mesh(head, kit.own(finGeometry(2.2, 0.42, 0.16)), side > 0 ? accent : warm, -0.08, side * 0.5, 0.28, 40);
    horn.rotation.z = side * 1.04;
    horn.rotation.x = 0.4;
  }

  const wings: THREE.Mesh[] = [];
  const bladeTips: THREE.Mesh[] = [];
  for (const side of [-1, 1] as const) {
    const wing = kit.mesh(hull, kit.own(wedgeGeometry(8.4, 1.7, 0.72, 0.14)), side > 0 ? hullB : hullA, -0.9, side * 2.8, 2.8, 60);
    wing.rotation.z = side * -1.02;
    wings.push(wing);
    const tip = kit.mesh(hull, kit.own(finGeometry(4.4, 0.26, 0.1)), warm, -3.8, side * 3.65, 3.15, 36);
    tip.rotation.z = side * -1.12;
    bladeTips.push(tip);
  }

  const boosters: THREE.Group[] = [];
  const flares: THREE.Mesh[] = [];
  const trails: THREE.Mesh[] = [];
  for (const side of [-1, 1] as const) {
    const booster = new THREE.Group();
    booster.position.set(-5.1, side * 1.62, 1.16);
    moveRig.add(booster);
    boosters.push(booster);
    kit.mesh(booster, kit.own(nozzleGeometry(3.5, 0.5)), hullB, 0, 0, 0, 40).rotation.x = 0.12;
    kit.mesh(booster, kit.own(wedgeGeometry(2.9, 0.8, 0.44, 0.18)), hullA, 1.1, 0, 0.46, 40).rotation.z = side * -0.14;
    const flare = kit.mesh(booster, kit.own(diamondGeometry(0.34, 0.12)), warm, -1.9, 0, 0, 28);
    flare.scale.set(3.6, 1.1, 1);
    flare.rotation.y = Math.PI * 0.5;
    flares.push(flare);
    const trail = kit.mesh(dashRig, kit.own(wedgeGeometry(12.5, 1.35, 0.34, 0.16)), accent, -8.2, side * 1.64, 1.24, 30);
    trail.rotation.z = side * -0.06;
    trail.visible = false;
    trails.push(trail);
  }

  const guns: THREE.Group[] = [];
  const muzzleGlows: THREE.Mesh[] = [];
  for (const side of [-1, 1] as const) {
    const gun = new THREE.Group();
    gun.position.set(2.8, side * 1.14, 1.96);
    hull.add(gun);
    guns.push(gun);
    makeNeedle(kit, gun, accent, 2.25, 0, 0).rotation.y = -0.08;
    kit.mesh(gun, kit.own(plateGeometry(1.26, 0.42, 0.44, 0.08)), hullB, 0.22, 0, 0.22, 34).rotation.y = -0.12;
    const glow = kit.mesh(gun, kit.own(diamondGeometry(0.18, 0.1)), warm, 4.95, 0, 0.02, 28);
    glow.rotation.x = 0.4;
    muzzleGlows.push(glow);
  }

  const shellRing = kit.mesh(root, kit.own(ringGeometry(ROBOT_RADIUS * 1.16, 0.14)), glass, 0, 0, 0.85, 26);
  shellRing.visible = false;

  return {
    root,
    setTeam(color) {
      kit.setTeam(color);
    },
    update(pose: RobotPose) {
      const morph = smooth01(pose.morph);
      const bank = Math.sin(pose.move - pose.aim) * pose.speed;
      const dash = clamp01(pose.alt);
      const breath = Math.sin(pose.time * 5.1) * 0.1;
      root.rotation.z = pose.aim;
      root.position.z = breath;
      root.scale.set(1 + dash * 0.12 - morph * 0.72, 1 - dash * 0.1 - morph * 0.16, 1 - morph * 0.42);
      hull.rotation.x = bank * 0.18 + dash * 0.06;
      hull.rotation.y = -Math.cos(pose.move - pose.aim) * pose.speed * 0.08;
      moveRig.rotation.z = (pose.move - pose.aim) * 0.26;
      dashRig.rotation.z = (pose.move - pose.aim) * 0.12;
      fuselage.position.x = 0.4 - pose.fire * 0.32;
      spine.position.x = 1.4 + dash * 0.22;
      core.scale.setScalar(1 + pose.fire * 0.16 + dash * 0.1);
      for (let i = 0; i < wings.length; i++) {
        const side = i === 0 ? -1 : 1;
        wings[i].rotation.z = side * (-1.02 - dash * 0.12 - pose.speed * 0.04);
        bladeTips[i].rotation.z = side * (-1.12 - dash * 0.1);
        boosters[i].rotation.z = side * (0.06 + dash * 0.2);
        flares[i].scale.set(2.2 + pose.speed * 1.2 + dash * 2.2, 0.76 + dash * 0.42, 1);
        trails[i].visible = dash > 0.04;
        trails[i].scale.set(1 + dash * 1.1, 0.9 + dash * 0.3, 1);
      }
      for (let i = 0; i < guns.length; i++) {
        const side = i === 0 ? -1 : 1;
        guns[i].rotation.z = side * (0.03 + bank * 0.03);
        guns[i].position.x = 2.8 - pose.fire * 0.36;
        muzzleGlows[i].visible = pose.fire > 0.03;
        muzzleGlows[i].scale.setScalar(0.72 + pose.fire * 0.64);
      }

      shellRing.visible = dash > 0.03 || pose.shield > 0.03;
      shellRing.scale.setScalar(1 + dash * 0.07 + pose.shield * 0.06);
      shellRing.rotation.z = pose.time * 1.2;
      applyRobotVectorState(kit, pose.time, pose.hit, pose.charge, pose.shield, morph);
      accent.uniforms.uPulse.value += pose.fire * 0.18 + dash * 0.1;
      warm.uniforms.uPulse.value += dash * 0.18;
      glass.uniforms.uOpacity.value = 0.12 + dash * 0.12 + pose.shield * 0.14;
      accent.uniforms.uOpacity.value = 1 - morph * 0.72;
      warm.uniforms.uOpacity.value = 1 - morph * 0.72;
    },
    dispose() {
      kit.dispose();
    },
  };
}

export function createTempest(): ColossusModel {
  const kit = createMechKit();
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  const hullA = kit.teamMaterial(0.42, 0.98, 1.2, 0x091118, 0.42);
  const hullB = kit.teamMaterial(0.58, 0.84, 1.42, 0x0e1219, 0.2, 1.3);
  const accent = kit.accentMaterial(0xffdaa8, 0x180b04, 1.78, 0.12);
  const warm = kit.accentMaterial(0xffa15a, 0x180803, 1.55, 0.12);
  const glass = kit.glassMaterial(0xffc1a9, 0x14070b);
  const massMat = kit.teamMaterial(0.32, 0.76, 0.38, 0x05080d, 0.4, 1.45);

  const bitOrbit = toWorld(FORM.parts[2].x);
  const massHull = kit.mesh(body, kit.own(bodyHullGeometry(FORM, COLOSSUS_HULL_MARGIN, COLOSSUS_HULL_DEPTH)), massMat, 0, 0, 0.42, 80);
  const core = kit.mesh(body, kit.own(new THREE.OctahedronGeometry(CORE_RADIUS, 0)), accent, 0, 0, 2.25, 30);
  const orbitRing = kit.mesh(body, kit.own(ringGeometry(bitOrbit, 0.12)), glass, 0, 0, 1.75, 28);
  const collapseRing = kit.mesh(body, kit.own(ringGeometry(CORE_RADIUS * 2.4, 0.12)), warm, 0, 0, 2.85, 28);
  const fuselage = kit.mesh(body, kit.own(wedgeGeometry(bitOrbit * 1.15, CORE_RADIUS * 1.2, CORE_RADIUS * 0.32, 0.18)), hullA, 0.6, 0, 1.8, 60);
  fuselage.rotation.y = -0.24;
  const spine = kit.mesh(body, kit.own(plateGeometry(bitOrbit * 1.02, CORE_RADIUS * 0.42, CORE_RADIUS * 0.12, 0.08)), hullB, 0.3, 0, 2.75, 60);
  const wingL = kit.mesh(body, kit.own(finGeometry(bitOrbit * 0.92, CORE_RADIUS * 0.3, CORE_RADIUS * 0.1)), hullB, -bitOrbit * 0.18, bitOrbit * 0.24, 2.4, 44);
  wingL.rotation.z = -0.98;
  const wingR = kit.mesh(body, kit.own(finGeometry(bitOrbit * 0.92, CORE_RADIUS * 0.3, CORE_RADIUS * 0.1)), hullB, -bitOrbit * 0.18, -bitOrbit * 0.24, 2.4, 44);
  wingR.rotation.z = 0.98;
  const prow = kit.mesh(body, kit.own(finGeometry(CORE_RADIUS * 2.1, CORE_RADIUS * 0.28, CORE_RADIUS * 0.1)), warm, CORE_RADIUS * 0.88, 0, 3.05, 36);
  prow.rotation.x = 0.38;

  const nodes: PartNode[] = [];
  FORM.parts.forEach((part, index) => {
    const anchor = new THREE.Group();
    body.add(anchor);
    const radius = toWorld(part.rad);
    const shells = bitShells(kit, anchor, hullA, hullB, radius);
    const strut = kit.mesh(body, kit.own(lineGeometry(1, 0.34, 0.16)), glass, 0, 0, 1.6, 56);
    if (part.kind === PartKind.Armor) {
      if (part.name === 'shield') {
        const plate = kit.mesh(anchor, kit.own(wedgeGeometry(radius * 1.6, radius * 1.2, radius * 0.34, 0.58)), hullA, radius * 0.16, 0, radius * 1.04, 60);
        plate.rotation.y = -0.1;
        shells.push(plate);
      } else if (part.name === 'back') {
        const cowl = kit.mesh(anchor, kit.own(wedgeGeometry(radius * 1.36, radius * 0.84, radius * 0.26, 0.22)), hullB, -radius * 0.34, 0, radius * 0.92, 60);
        cowl.rotation.y = 0.28;
        shells.push(cowl);
      }
      nodes.push({ defIndex: index, anchor, shells, barrel: null, muzzle: null, strut, vent: null });
      return;
    }
    const barrel = new THREE.Group();
    barrel.position.z = radius * 0.56;
    anchor.add(barrel);
    kit.mesh(barrel, kit.own(barrelGeometry(toWorld(part.muzzle), radius * 0.14, radius * 0.22)), accent, toWorld(part.muzzle) * 0.42, 0, 0, 40);
    const muzzle = kit.mesh(barrel, kit.own(diamondGeometry(radius * 0.16, radius * 0.08)), warm, toWorld(part.muzzle) * 0.88, 0, 0.06, 32);
    muzzle.rotation.x = 0.4;
    const vent = kit.mesh(anchor, kit.own(lineGeometry(radius * 0.48, radius * 0.16, 0.08)), warm, -radius * 0.12, 0, radius * 0.78, 24);
    nodes.push({ defIndex: index, anchor, shells, barrel, muzzle, strut, vent });
  });

  return {
    root,
    setTeam(color) {
      kit.setTeam(color);
    },
    update(pose: ColossusPose) {
      const assemble = smooth01(pose.assemble);
      const siegeBrace = pose.attack === Attack.Siege && pose.phase === AttackPhase.Windup ? pose.progress : 0;
      const ultimaWindup = pose.attack === Attack.Ultima && pose.phase === AttackPhase.Windup ? pose.progress : 0;
      const ultimaRelease = pose.attack === Attack.Ultima && pose.phase === AttackPhase.Release ? 1 : 0;
      body.rotation.z = pose.body;
      body.position.z = Math.sin(pose.time * 1.5) * 0.12 - siegeBrace * 0.56;
      body.scale.set(1, 1 - siegeBrace * 0.03, 1 + ultimaWindup * 0.08);
      massHull.scale.set(1, 1 - siegeBrace * 0.02, 1 + ultimaWindup * 0.05);
      core.scale.setScalar(0.42 + assemble * (0.34 + pose.fuel * 0.28));
      core.rotation.z = pose.time * 0.6;
      orbitRing.visible = assemble > 0.08;
      orbitRing.rotation.z = pose.orbit - pose.body;
      (orbitRing.material as VectorMaterial).uniforms.uOpacity.value = 0.12 + ultimaWindup * 0.08;
      collapseRing.visible = ultimaWindup > 0.02 || ultimaRelease > 0;
      collapseRing.scale.setScalar(1.2 - ultimaWindup * 0.52);
      collapseRing.rotation.z = -pose.time * 0.55;
      spine.position.x = 0.3 + ultimaWindup * 0.24;
      wingL.rotation.z = -0.98 - ultimaWindup * 0.12;
      wingR.rotation.z = 0.98 + ultimaWindup * 0.12;
      prow.scale.setScalar(1 + ultimaWindup * 0.18);

      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        const def = FORM.parts[node.defIndex];
        const partPose: PartPose = pose.parts[node.defIndex];
        const partEase = staggered(assemble, node.defIndex * ASSEMBLE_STEP);
        const orbitAngle = def.orbit ? pose.orbit - pose.body : 0;
        const px = toWorld(def.x) * partEase;
        const py = toWorld(def.y) * partEase;
        node.anchor.visible = partPose.hp > 0 && partEase > 0.02;
        node.strut.visible = node.anchor.visible;
        if (!node.anchor.visible) continue;
        const arc = Math.sin(partEase * Math.PI);
        const arcedX = px - py * ASSEMBLE_ARC_SWAY * arc;
        const arcedY = py + px * ASSEMBLE_ARC_SWAY * arc;
        node.anchor.position.set(arcedX * Math.cos(orbitAngle) - arcedY * Math.sin(orbitAngle), arcedX * Math.sin(orbitAngle) + arcedY * Math.cos(orbitAngle), (1 - partEase) * 3.2 + arc * ASSEMBLE_ARC_HEIGHT);
        node.strut.position.set(node.anchor.position.x * 0.5, node.anchor.position.y * 0.5, 1.62);
        node.strut.scale.x = Math.hypot(node.anchor.position.x, node.anchor.position.y);
        node.strut.rotation.z = Math.atan2(node.anchor.position.y, node.anchor.position.x);
        (node.strut.material as VectorMaterial).uniforms.uOpacity.value = 0.12 + (def.orbit ? 0.06 : 0) + ultimaWindup * 0.08;
        for (let k = 0; k < node.shells.length; k++) {
          (node.shells[k].material as VectorMaterial).uniforms.uFlash.value = partPose.flash * 0.32;
          (node.shells[k].material as VectorMaterial).uniforms.uPulse.value = partPose.hp < 0.35 ? 0.1 + 0.07 * Math.sin(pose.time * 14 + k) : 0;
          node.shells[k].scale.z = 1 + ultimaWindup * 0.08;
        }
        if (node.barrel && node.muzzle && node.vent) {
          const flare = partPose.charge + ultimaWindup * 0.42 + ultimaRelease * 0.22;
          node.anchor.rotation.z = def.orbit ? partPose.facing - pose.orbit + (ultimaRelease > 0 ? pose.time * 0.9 : 0) : partPose.facing - pose.body;
          node.barrel.position.x = partPose.charge * toWorld(def.muzzle) * 0.11;
          node.barrel.scale.x = 1 + partPose.charge * 0.34;
          node.muzzle.visible = flare > 0.02;
          node.muzzle.scale.setScalar(0.72 + flare * 1.2);
          (node.vent.material as VectorMaterial).uniforms.uPulse.value = partPose.heat * 0.46 + ultimaRelease * 0.1;
          (node.strut.material as VectorMaterial).uniforms.uPulse.value = 0.03 + flare * 0.18;
          (node.strut.material as VectorMaterial).uniforms.uOpacity.value = 0.12 + flare * 0.18;
        } else if (def.name === 'shield') {
          node.anchor.rotation.z = -0.06 - ultimaWindup * 0.14;
        } else if (def.name === 'back') {
          node.anchor.rotation.z = 0.06 + ultimaWindup * 0.12;
        }
      }

      applyColossusVectorState(kit, pose.time, pose.hit, pose.fuel, assemble);
      massMat.uniforms.uFlash.value = pose.hit * 0.1;
      massMat.uniforms.uOpacity.value = 0.42;
      massMat.uniforms.uPulse.value = 0;
      accent.uniforms.uPulse.value += ultimaWindup * 0.15 + ultimaRelease * 0.08;
      warm.uniforms.uPulse.value += siegeBrace * 0.12 + ultimaWindup * 0.16;
      glass.uniforms.uOpacity.value = 0.12 + (1 - pose.fuel) * 0.04;
    },
    dispose() {
      kit.dispose();
    },
  };
}
