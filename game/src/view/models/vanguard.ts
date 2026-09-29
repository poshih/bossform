import * as THREE from 'three';
import type { VectorMaterial } from '../../render/vector.ts';
import { Attack, AttackPhase, FORMS, FRAME_STATS, Frame, PartKind } from '../../sim/index.ts';
import {
  applyColossusVectorState,
  applyRobotVectorState,
  barrelGeometry,
  createMechKit,
  diamondGeometry,
  easeOutCubic,
  finGeometry,
  lerp,
  lineGeometry,
  nozzleGeometry,
  plateGeometry,
  rawToUnits,
  ringGeometry,
  smooth01,
  wedgeGeometry,
  type MechKit,
} from './kit-mechs.ts';
import type { ColossusModel, ColossusPose, PartPose, RobotModel, RobotPose } from './types.ts';

const FORM = FORMS[Frame.Vanguard];
const ROBOT_RADIUS = rawToUnits(FRAME_STATS[Frame.Vanguard].bodyR);
const CORE_RADIUS = rawToUnits(FORM.coreR);
const HULL_Z = 2.6;
const BANK_TILT = 0.16;
const SHOULDER_OFFSET = 4.6;
const ARM_OFFSET = 2.95;
const ASSEMBLE_STEP = 0.09;

interface ArmorNode {
  readonly defIndex: number;
  readonly anchor: THREE.Group;
  readonly shells: readonly THREE.Mesh[];
  readonly strut: THREE.Mesh;
}

interface PodNode {
  readonly defIndex: number;
  readonly anchor: THREE.Group;
  readonly barrel: THREE.Group;
  readonly barrelMesh: THREE.Mesh;
  readonly muzzle: THREE.Mesh;
  readonly vent: THREE.Mesh;
  readonly strut: THREE.Mesh;
}

function staggered(value: number, start: number): number {
  return easeOutCubic((value - start) / (1 - start));
}

function buildShieldMesh(kit: MechKit, parent: THREE.Object3D, material: VectorMaterial, x: number, y: number, z: number): THREE.Mesh {
  return kit.mesh(parent, kit.own(wedgeGeometry(3.8, 2.8, 1.1, 0.82)), material, x, y, z, 56);
}

function armorCluster(kit: MechKit, parent: THREE.Object3D, hullA: VectorMaterial, hullB: VectorMaterial, radius: number): THREE.Mesh[] {
  return [
    kit.mesh(parent, kit.own(plateGeometry(radius * 1.72, radius * 1.32, radius * 0.5, 0.16)), hullA, 0, 0, radius * 0.34, 58),
    kit.mesh(parent, kit.own(plateGeometry(radius * 1.26, radius * 0.96, radius * 0.32, 0.14)), hullB, radius * 0.12, 0, radius * 0.98, 58),
  ];
}

export function createVanguard(): RobotModel {
  const kit = createMechKit();
  const root = new THREE.Group();
  const hull = new THREE.Group();
  const moveRig = new THREE.Group();
  const backpackRig = new THREE.Group();
  root.add(hull);
  hull.add(moveRig);
  hull.add(backpackRig);

  const hullA = kit.teamMaterial(0.46, 0.9, 1.2, 0x08131d, 0.42);
  const hullB = kit.teamMaterial(0.62, 0.68, 1.45, 0x0b1a28, 0.24, 1.35);
  const accent = kit.accentMaterial(0xc8f5ff, 0x0f1c28, 1.75, 0.1);
  const warm = kit.accentMaterial(0xffc765, 0x1c1204, 1.6, 0.12);
  const glass = kit.glassMaterial(0x82daff, 0x031018);

  const torso = kit.mesh(hull, kit.own(plateGeometry(10.6, 7.3, 2.8, 0.16)), hullA, 0.4, 0, HULL_Z, 58);
  torso.rotation.y = -0.08;
  const chest = kit.mesh(hull, kit.own(plateGeometry(6.5, 4.8, 1.9, 0.18)), hullB, 2.25, 0, HULL_Z + 1.28, 58);
  chest.rotation.y = -0.14;
  const chestGem = kit.mesh(hull, kit.own(diamondGeometry(0.94, 0.58)), warm, 3.7, 0, 5.3, 38);
  chestGem.rotation.x = 0.42;
  const dome = kit.mesh(hull, kit.own(new THREE.SphereGeometry(0.75, 7, 6)), glass, 3.55, 0, 5.5, 34);
  dome.scale.set(1.1, 0.9, 0.76);

  const head = new THREE.Group();
  head.position.set(4.1, 0, 5.2);
  hull.add(head);
  kit.mesh(head, kit.own(plateGeometry(1.3, 1.05, 0.72, 0.14)), hullB, 0, 0, 0, 52);
  kit.mesh(head, kit.own(diamondGeometry(0.32, 0.18)), accent, 0.44, 0, 0.18, 28).rotation.x = 0.42;
  for (const side of [-1, 1] as const) {
    const fin = kit.mesh(head, kit.own(finGeometry(2.45, 0.7, 0.2)), warm, -0.3, side * 0.52, 0.26, 42);
    fin.rotation.z = side * 0.94;
    fin.rotation.x = 0.38;
  }

  const shoulders: THREE.Mesh[] = [];
  const arms: THREE.Group[] = [];
  for (const side of [-1, 1] as const) {
    const shoulder = kit.mesh(hull, kit.own(wedgeGeometry(5.2, 3.35, 2.1, 0.66)), side < 0 ? hullB : hullA, 0.2, side * SHOULDER_OFFSET, HULL_Z + 1.05, 58);
    shoulder.rotation.z = side * 0.1;
    shoulder.rotation.y = side < 0 ? 0.06 : -0.06;
    shoulders.push(shoulder);

    const arm = new THREE.Group();
    arm.position.set(2.25, side * ARM_OFFSET, 2.15);
    hull.add(arm);
    kit.mesh(arm, kit.own(plateGeometry(2.4, 1, 1.48, 0.14)), hullA, 0, 0, 0.85, 56).rotation.y = -0.08;
    kit.mesh(arm, kit.own(plateGeometry(3.2, 1.1, 1.28, 0.12)), hullB, 2.08, 0, 0.66, 56).rotation.y = -0.18;
    arms.push(arm);
  }

  const rifle = new THREE.Group();
  rifle.position.set(3.3, -0.18, 0.75);
  arms[0].add(rifle);
  kit.mesh(rifle, kit.own(plateGeometry(4.1, 1.18, 1.18, 0.14)), hullB, 0.75, 0, 0.64, 56).rotation.y = -0.08;
  const barrels: THREE.Mesh[] = [];
  for (const side of [-1, 1] as const) {
    const barrel = kit.mesh(rifle, kit.own(barrelGeometry(4.9, 0.24, 0.36)), accent, 2.95, side * 0.32, 0.04, 36);
    barrel.rotation.y = -0.05;
    barrels.push(barrel);
  }
  const muzzleGlow = kit.mesh(rifle, kit.own(diamondGeometry(0.42, 0.18)), accent, 5.2, 0, 0.12, 34);
  muzzleGlow.rotation.x = 0.44;

  const shield = buildShieldMesh(kit, arms[1], hullB, 3.45, 0.74, 0.78);
  shield.rotation.y = -0.16;
  shield.rotation.z = 0.12;
  kit.mesh(arms[1], kit.own(lineGeometry(2.7, 0.22, 0.08)), warm, 3.42, 0.78, 1.3, 24).rotation.z = 0.16;

  const seekerDoors: THREE.Mesh[] = [];
  for (const side of [-1, 1] as const) {
    const pod = new THREE.Group();
    pod.position.set(-0.25, side * 2.75, HULL_Z + 1.18);
    hull.add(pod);
    const door = kit.mesh(pod, kit.own(plateGeometry(1.6, 0.86, 0.46, 0.12)), hullB, 0, 0, 0, 46);
    seekerDoors.push(door);
    const vent = kit.mesh(pod, kit.own(lineGeometry(1.15, 0.14, 0.06)), warm, 0.08, 0, 0.24, 24);
    vent.scale.x = 0.72;
  }

  const fins: THREE.Mesh[] = [];
  const thrusters: THREE.Mesh[] = [];
  for (const side of [-1, 1] as const) {
    const fin = kit.mesh(backpackRig, kit.own(finGeometry(4.8, 1.2, 0.3)), hullB, -5.1, side * 1.95, HULL_Z + 0.72, 46);
    fin.rotation.z = side * 0.62;
    fins.push(fin);
    kit.mesh(backpackRig, kit.own(nozzleGeometry(2.7, 0.42)), hullA, -5.95, side * 0.92, 1.2, 34).rotation.x = 0.12;
    const glow = kit.mesh(backpackRig, kit.own(diamondGeometry(0.42, 0.14)), accent, -6.95, side * 0.92, 1.2, 30);
    glow.scale.set(2, 0.9, 1);
    glow.rotation.y = Math.PI * 0.5;
    thrusters.push(glow);
  }

  const shellRing = kit.mesh(root, kit.own(ringGeometry(ROBOT_RADIUS * 1.05, 0.18)), glass, 0, 0, 0.75, 24);
  shellRing.visible = false;

  return {
    root,
    setTeam(color) {
      kit.setTeam(color);
    },
    update(pose: RobotPose) {
      const bank = Math.sin(pose.move - pose.aim) * pose.speed;
      const morph = smooth01(pose.morph);
      const breath = Math.sin(pose.time * 3.1) * 0.12;
      root.rotation.z = pose.aim;
      root.scale.set(1 - morph * 0.76, 1 - morph * 0.28, 1 - morph * 0.48);
      root.position.z = breath;
      hull.rotation.x = bank * BANK_TILT;
      hull.rotation.y = -Math.cos(pose.move - pose.aim) * pose.speed * 0.06;
      moveRig.rotation.z = (pose.move - pose.aim) * 0.18;
      backpackRig.position.x = -pose.speed * 0.72;

      const recoil = pose.fire * 0.46;
      rifle.position.x = 3.3 - recoil;
      muzzleGlow.visible = pose.fire > 0.02;
      muzzleGlow.scale.setScalar(0.8 + pose.fire * 0.9);
      for (let i = 0; i < barrels.length; i++) barrels[i].position.x = 2.95 - recoil * 0.4;
      for (let i = 0; i < arms.length; i++) {
        const side = i === 0 ? -1 : 1;
        arms[i].rotation.z = side * 0.04 + bank * side * 0.05;
      }
      shield.position.x = 3.45 + pose.shield * 0.22;
      shield.scale.set(1 + pose.shield * 0.06, 1, 1);
      for (let i = 0; i < seekerDoors.length; i++) {
        const side = i === 0 ? -1 : 1;
        seekerDoors[i].rotation.x = pose.alt * 0.68;
        seekerDoors[i].rotation.z = side * pose.alt * 0.05;
      }
      for (let i = 0; i < fins.length; i++) {
        const side = i === 0 ? -1 : 1;
        fins[i].rotation.z = side * (0.62 + pose.alt * 0.08 + pose.speed * 0.04);
        thrusters[i].scale.set(1.4 + pose.speed * 0.8, 0.72 + pose.speed * 0.34 + pose.alt * 0.18, 1);
      }

      shellRing.visible = pose.shield > 0.03;
      shellRing.scale.setScalar(1 + pose.shield * 0.08);
      shellRing.rotation.z = pose.time * 0.7;
      applyRobotVectorState(kit, pose.time, pose.hit, pose.charge, pose.shield);
      glass.uniforms.uOpacity.value = 0.14 + pose.shield * 0.2;
      accent.uniforms.uPulse.value += pose.fire * 0.3 + pose.alt * 0.08;
      warm.uniforms.uPulse.value += pose.alt * 0.14;
      accent.uniforms.uOpacity.value = lerp(0.72, 0.18, morph);
      warm.uniforms.uOpacity.value = lerp(0.72, 0.18, morph);
    },
    dispose() {
      kit.dispose();
    },
  };
}

export function createPaladin(): ColossusModel {
  const kit = createMechKit();
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  const hullA = kit.teamMaterial(0.46, 0.92, 1.22, 0x07131b, 0.42);
  const hullB = kit.teamMaterial(0.62, 0.68, 1.44, 0x0b1621, 0.24, 1.3);
  const accent = kit.accentMaterial(0xd8f8ff, 0x101218, 1.8, 0.1);
  const warm = kit.accentMaterial(0xffcd72, 0x1e1204, 1.65, 0.12);
  const glass = kit.glassMaterial(0x88e5ff, 0x031117);

  const core = kit.mesh(body, kit.own(new THREE.OctahedronGeometry(CORE_RADIUS, 0)), accent, 0, 0, 2.5, 28);
  const coreHalo = kit.mesh(body, kit.own(ringGeometry(CORE_RADIUS * 1.55, 0.14)), glass, 0, 0, 2.95, 30);
  const keel = kit.mesh(body, kit.own(wedgeGeometry(rawToUnits(FORM.parts[6].x) + rawToUnits(FORM.parts[3].rad) * 1.2, rawToUnits(FORM.parts[0].rad) * 0.66, rawToUnits(FORM.parts[0].rad) * 0.18, 0.16)), hullB, 8.7, 0, 1.45, 60);
  keel.rotation.y = -0.08;
  const bracePads: THREE.Mesh[] = [];
  for (const side of [-1, 1] as const) {
    bracePads.push(kit.mesh(body, kit.own(plateGeometry(5.6, 1.2, 0.36, 0.08)), hullB, -4.3, side * 9.1, 0.18, 42));
  }

  const armorNodes: ArmorNode[] = [];
  const podNodes: PodNode[] = [];
  FORM.parts.forEach((part, index) => {
    const anchor = new THREE.Group();
    body.add(anchor);
    const radius = rawToUnits(part.rad);
    if (part.kind === PartKind.Armor) {
      const shells = armorCluster(kit, anchor, hullA, hullB, radius);
      if (part.name === 'chest') {
        const shieldPlate = kit.mesh(anchor, kit.own(wedgeGeometry(radius * 1.52, radius * 1.26, radius * 0.34, 0.58)), hullA, radius * 0.18, 0, radius * 1.18, 60);
        shieldPlate.rotation.y = -0.1;
        shells.push(shieldPlate);
      } else if (part.name === 'wingL' || part.name === 'wingR') {
        const side = part.name === 'wingL' ? 1 : -1;
        const wingPlate = kit.mesh(anchor, kit.own(wedgeGeometry(radius * 1.92, radius * 0.98, radius * 0.3, 0.14)), hullB, -radius * 0.26, side * radius * 0.12, radius * 1.1, 60);
        wingPlate.rotation.z = side * 0.42;
        shells.push(wingPlate);
      } else if (part.name === 'back') {
        const cowl = kit.mesh(anchor, kit.own(wedgeGeometry(radius * 1.24, radius * 0.9, radius * 0.28, 0.24)), hullB, -radius * 0.28, 0, radius * 1.02, 60);
        cowl.rotation.y = 0.24;
        shells.push(cowl);
      }
      const strut = kit.mesh(body, kit.own(lineGeometry(1, 0.38, 0.18)), glass, 0, 0, 1.8, 58);
      armorNodes.push({ defIndex: index, anchor, shells, strut });
      return;
    }
    const shells = armorCluster(kit, anchor, hullA, hullB, radius);
    const barrel = new THREE.Group();
    barrel.position.z = radius * 0.7;
    anchor.add(barrel);
    const barrelMesh = kit.mesh(barrel, kit.own(barrelGeometry(rawToUnits(part.muzzle), radius * 0.24, radius * 0.38)), part.name === 'prow' ? warm : accent, rawToUnits(part.muzzle) * 0.45, 0, 0, 42);
    const muzzle = kit.mesh(barrel, kit.own(diamondGeometry(radius * 0.24, radius * 0.14)), part.name === 'prow' ? warm : accent, rawToUnits(part.muzzle) * 0.94, 0, 0.12, 36);
    muzzle.rotation.x = 0.4;
    const vent = kit.mesh(anchor, kit.own(lineGeometry(radius * 0.9, radius * 0.22, 0.12)), warm, -radius * 0.22, 0, radius * 1.12, 28);
    const strut = kit.mesh(body, kit.own(lineGeometry(1, 0.44, 0.18)), glass, 0, 0, 1.95, 58);
    if (part.name === 'prow') {
      const housing = kit.mesh(anchor, kit.own(wedgeGeometry(radius * 1.1, radius * 0.84, radius * 0.28, 0.42)), hullB, -radius * 0.02, 0, radius * 0.95, 60);
      housing.rotation.y = -0.08;
      shells.push(housing);
    }
    shells.push(barrelMesh);
    podNodes.push({ defIndex: index, anchor, barrel, barrelMesh, muzzle, vent, strut });
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
      const recovery = pose.phase === AttackPhase.Recovery ? pose.progress : 0;
      const heavyOpen = Math.max(ultimaWindup, pose.attack === Attack.Ultima && pose.phase === AttackPhase.Release ? 1 : 0);
      body.rotation.z = pose.body;
      body.position.z = Math.sin(pose.time * 1.1) * 0.15 - siegeBrace * 1.15;
      body.scale.set(1, 1 - siegeBrace * 0.05, 1 + heavyOpen * 0.14);
      core.scale.setScalar(0.46 + assemble * (0.32 + pose.fuel * 0.26));
      core.rotation.z = pose.time * 0.45;
      coreHalo.visible = assemble > 0.08;
      coreHalo.rotation.z = pose.time * 0.14;
      coreHalo.scale.setScalar(0.78 + assemble * 0.28);
      (coreHalo.material as VectorMaterial).uniforms.uOpacity.value = 0.14 + (1 - pose.fuel) * 0.08 + heavyOpen * 0.04;
      keel.scale.set(1 + heavyOpen * 0.05, 1, 1 + heavyOpen * 0.18);
      for (let i = 0; i < bracePads.length; i++) bracePads[i].scale.x = 0.18 + siegeBrace * 1.4;

      for (let i = 0; i < armorNodes.length; i++) {
        const node = armorNodes[i];
        const def = FORM.parts[node.defIndex];
        const partPose = pose.parts[node.defIndex];
        const partEase = staggered(assemble, node.defIndex * ASSEMBLE_STEP);
        node.anchor.visible = partPose.hp > 0 && partEase > 0.02;
        node.strut.visible = node.anchor.visible;
        if (!node.anchor.visible) continue;
        node.anchor.position.set(rawToUnits(def.x) * partEase, rawToUnits(def.y) * partEase, (1 - partEase) * 4.4);
        const wingSide = def.name === 'wingL' ? 1 : def.name === 'wingR' ? -1 : 0;
        node.anchor.rotation.z = wingSide === 0 ? 0 : wingSide * (0.16 + heavyOpen * 0.28);
        node.strut.position.set(node.anchor.position.x * 0.5, node.anchor.position.y * 0.5, 1.8);
        node.strut.scale.x = Math.hypot(node.anchor.position.x, node.anchor.position.y);
        node.strut.rotation.z = Math.atan2(node.anchor.position.y, node.anchor.position.x);
        (node.strut.material as VectorMaterial).uniforms.uOpacity.value = 0.16 + heavyOpen * 0.08;
        for (let k = 0; k < node.shells.length; k++) {
          (node.shells[k].material as VectorMaterial).uniforms.uFlash.value = partPose.flash * 0.34;
          node.shells[k].scale.z = 1 + heavyOpen * 0.12;
        }
      }

      for (let i = 0; i < podNodes.length; i++) {
        const node = podNodes[i];
        const def = FORM.parts[node.defIndex];
        const partPose: PartPose = pose.parts[node.defIndex];
        const partEase = staggered(assemble, node.defIndex * ASSEMBLE_STEP);
        node.anchor.visible = partPose.hp > 0 && partEase > 0.02;
        node.strut.visible = node.anchor.visible;
        if (!node.anchor.visible) continue;
        node.anchor.position.set(rawToUnits(def.x) * partEase, rawToUnits(def.y) * partEase, (1 - partEase) * 3.8);
        node.anchor.rotation.z = partPose.facing - pose.body;
        node.barrel.position.x = partPose.charge * rawToUnits(def.muzzle) * 0.14;
        node.barrel.position.z = rawToUnits(def.rad) * (0.74 + heavyOpen * 0.18);
        node.barrel.rotation.z = pose.phase === AttackPhase.Release ? pose.time * 0.24 : 0;
        node.barrelMesh.scale.x = 1 + partPose.charge * 0.48 + heavyOpen * 0.12;
        node.muzzle.visible = partPose.charge > 0.01 || pose.phase === AttackPhase.Release;
        node.muzzle.scale.setScalar(0.86 + partPose.charge * 1.9 + (pose.phase === AttackPhase.Release ? 0.45 : 0));
        (node.vent.material as VectorMaterial).uniforms.uPulse.value = partPose.heat * 0.55 + recovery * 0.12;
        (node.vent.material as VectorMaterial).uniforms.uFlash.value = partPose.flash * 0.36;
        node.strut.position.set(node.anchor.position.x * 0.5, node.anchor.position.y * 0.5, 1.95);
        node.strut.scale.x = Math.hypot(node.anchor.position.x, node.anchor.position.y);
        node.strut.rotation.z = Math.atan2(node.anchor.position.y, node.anchor.position.x);
        (node.strut.material as VectorMaterial).uniforms.uOpacity.value = 0.12 + partPose.charge * 0.24 + heavyOpen * 0.1;
        (node.strut.material as VectorMaterial).uniforms.uPulse.value = 0.04 + partPose.charge * 0.22 + heavyOpen * 0.1;
      }

      applyColossusVectorState(kit, pose.time, pose.hit, pose.fuel);
      accent.uniforms.uPulse.value += heavyOpen * 0.18 + recovery * 0.05;
      warm.uniforms.uPulse.value += siegeBrace * 0.16 + heavyOpen * 0.16;
      glass.uniforms.uOpacity.value = 0.12 + (1 - pose.fuel) * 0.05;
      warm.uniforms.uOpacity.value = 0.64;
    },
    dispose() {
      kit.dispose();
    },
  };
}
