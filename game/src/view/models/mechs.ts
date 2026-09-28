import * as THREE from 'three';
import {
  applyStandardPose,
  arcGeometry,
  cannonGeometry,
  createPartRegistry,
  haloGeometry,
  octagonGeometry,
  plateGeometry,
  shoulderArmorGeometry,
  spikeGeometry,
  thrusterNozzleGeometry,
  wingPanelGeometry,
  type PartRegistry,
} from './mechParts.ts';
import type { MechModel, MechPose } from './types.ts';

const FRAME_RADIUS = [10, 8, 14] as const;
const FRAME_BOSS_RADIUS = [23, 18, 31] as const;
const TURN = Math.PI * 2;
const HALF_PI = Math.PI * 0.5;

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function smooth01(value: number): number {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function bell(value: number, center: number, width: number): number {
  const d = Math.abs(value - center);
  if (d >= width) return 0;
  const x = 1 - d / width;
  return x * x;
}

function mirror(side: number, value: number): number {
  return side * value;
}

interface CoreRig {
  readonly root: THREE.Group;
  readonly model: THREE.Group;
  readonly lower: THREE.Group;
  readonly upper: THREE.Group;
  readonly aura: THREE.Mesh;
  readonly auraMaterial: THREE.ShaderMaterial;
  readonly registry: PartRegistry;
  readonly radius: number;
  readonly bossRadius: number;
}

function createCoreRig(radius: number, bossRadius: number, auraColor: number): CoreRig {
  const registry = createPartRegistry();
  const root = new THREE.Group();
  const model = new THREE.Group();
  const lower = new THREE.Group();
  const upper = new THREE.Group();
  upper.position.z = 1.7;
  model.add(lower, upper);
  root.add(model);

  const aura = new THREE.Mesh(
    registry.ownGeometry(arcGeometry(radius * 0.2, radius * 0.34, 0.3, 0, TURN)),
    registry.makeGlow(auraColor, 0.8, 0.08, 0.25),
  );
  aura.position.z = 1.2;
  aura.visible = false;
  model.add(aura);

  return {
    root,
    model,
    lower,
    upper,
    aura,
    auraMaterial: aura.material as THREE.ShaderMaterial,
    registry,
    radius,
    bossRadius,
  };
}

function applyCoreUpdate(rig: CoreRig, pose: MechPose, breathSpeed: number, leanScale: number): { transform: number; breath: number; transformGlow: number } {
  const transform = smooth01(pose.transform);
  const scale = lerp(1, rig.bossRadius / rig.radius, transform);
  const breath = Math.sin(pose.time * breathSpeed) * (0.18 + transform * 0.18);
  const lean = pose.speed * leanScale;
  rig.model.scale.setScalar(scale);
  rig.model.rotation.x = Math.sin(pose.moveAngle) * lean;
  rig.model.rotation.y = -Math.cos(pose.moveAngle) * lean;
  rig.lower.rotation.z = pose.moveAngle;
  rig.upper.rotation.z = pose.aimAngle;
  const transformGlow = bell(transform, 0.5, 0.33) * (0.5 + 0.5 * Math.sin(pose.time * 20) ** 2);
  rig.aura.visible = transformGlow > 0.05;
  rig.aura.scale.setScalar(1 + transform * 0.2 + transformGlow * 0.35);
  rig.auraMaterial.uniforms.uIntensity.value = transformGlow * 2.1;
  rig.auraMaterial.uniforms.uTime.value = pose.time;
  applyStandardPose(rig.registry, pose.time, pose.hit, pose.charge, transformGlow);
  return { transform, breath, transformGlow };
}

function createMesh(parent: THREE.Object3D, geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(x, y, z);
  parent.add(mesh);
  return mesh;
}

function createVanguard(): MechModel {
  const rig = createCoreRig(FRAME_RADIUS[0], FRAME_BOSS_RADIUS[0], 0xffd56a);
  const { registry, lower, upper, model, root } = rig;

  const shell = registry.makeToon({ color: 0xb9c7d7, shade: 0x5a6b82, light: 0xd8e3ee, rim: 0xbce3ff, lines: 0.12, lineColor: 0x7fd6ff });
  const blue = registry.makeToon({ color: 0x4c72aa, shade: 0x203a69, light: 0x7f9fd0, rim: 0xb6e6ff, lines: 0.14, lineColor: 0x91e0ff });
  const red = registry.makeToon({ color: 0xbd4d58, shade: 0x581b24, light: 0xe6888f, rim: 0xffbdc0 });
  const gold = registry.makeToon({ color: 0xd2b04a, shade: 0x775813, light: 0xe8d689, rim: 0xffefba, emissive: 0xffd86f, emissiveAmt: 0.05 });
  const steel = registry.makeToon({ color: 0x647287, shade: 0x283040, light: 0x93a2b8, rim: 0xc7ecff });
  registry.trackEmissive(gold, 0xffd86f, 0.3);

  const pelvis = createMesh(lower, registry.ownGeometry(octagonGeometry(4.8, 4, 2.1, 0.2, 0.55)), blue, -0.7, 0, 2.2);
  pelvis.rotation.y = 0.18;
  const skirt = createMesh(lower, registry.ownGeometry(plateGeometry(2.4, 4.6, 1.2, 0.2)), shell, 0.5, 0, 2.8);
  skirt.rotation.y = -0.2;

  const chest = createMesh(upper, registry.ownGeometry(octagonGeometry(7.6, 6, 3.6, 0.22, 0.85)), shell, 0.4, 0, 4.2);
  chest.rotation.y = -0.14;
  const chestBlue = createMesh(upper, registry.ownGeometry(octagonGeometry(5.1, 3.6, 1.4, 0.18, 0.4)), blue, 1.7, 0, 5.2);
  chestBlue.rotation.y = -0.18;
  const core = createMesh(upper, registry.ownGeometry(spikeGeometry(2.4, 1.7, 0.7)), gold, 2.45, 0, 5.9);
  core.rotation.x = 0.46;
  const backpack = createMesh(upper, registry.ownGeometry(octagonGeometry(3.6, 4.8, 2.4, 0.18, 0.5)), steel, -3.8, 0, 3.2);
  backpack.rotation.y = 0.24;

  const thrusterGlows: THREE.ShaderMaterial[] = [];
  for (const side of [-1, 1] as const) {
    createMesh(upper, registry.ownGeometry(thrusterNozzleGeometry(0.95, 3.1)), steel, -5.3, mirror(side, 1.9), 2.7).rotation.x = 0.16;
    const glow = createMesh(upper, registry.ownGeometry(new THREE.SphereGeometry(0.72, 6, 5)), registry.makeGlow(0x80ddff, 2.1, 0.2, 0.22), -6.55, mirror(side, 1.9), 2.7);
    glow.scale.set(1.6, 0.68, 0.68);
    thrusterGlows.push(glow.material as THREE.ShaderMaterial);
  }

  const legs: THREE.Group[] = [];
  const feet: THREE.Mesh[] = [];
  for (const side of [-1, 1] as const) {
    const leg = new THREE.Group();
    leg.position.set(-0.9, mirror(side, 1.9), 0.45);
    lower.add(leg);
    createMesh(leg, registry.ownGeometry(plateGeometry(1.8, 1.3, 3.6, 0.35)), shell, 0, 0, 1.8).rotation.y = 0.06;
    createMesh(leg, registry.ownGeometry(plateGeometry(1.4, 1.1, 2.2, 0.25)), blue, 1.65, 0, 0.95).rotation.y = -0.18;
    const foot = createMesh(leg, registry.ownGeometry(wingPanelGeometry(3, 1.5, 0.9, 0.55)), steel, 3, 0, 0.25);
    foot.rotation.y = -0.32;
    feet.push(foot);
    legs.push(leg);
  }

  const head = new THREE.Group();
  head.position.set(3, 0, 6.2);
  upper.add(head);
  createMesh(head, registry.ownGeometry(octagonGeometry(1.7, 1.6, 1.5, 0.18, 0.25)), shell, 0, 0, 0).rotation.y = -0.14;
  const visor = createMesh(head, registry.ownGeometry(plateGeometry(0.75, 0.42, 0.55, 0.12)), registry.makeGlow(0x99efff, 2.4, 0.12, 0.15), 0.6, 0, 0.2);
  visor.scale.set(1.1, 1, 1);
  for (const side of [-1, 1] as const) {
    const fin = createMesh(head, registry.ownGeometry(spikeGeometry(2.6, 0.8, 0.45)), gold, 0.3, mirror(side, 0.85), 0.8);
    fin.rotation.z = mirror(side, 0.84);
    fin.rotation.x = 0.42;
  }
  createMesh(head, registry.ownGeometry(spikeGeometry(1.05, 0.45, 0.28)), red, -0.35, 0, 0.7).rotation.x = 0.5;

  const shoulders: THREE.Mesh[] = [];
  const arms: THREE.Group[] = [];
  for (const side of [-1, 1] as const) {
    const shoulder = createMesh(upper, registry.ownGeometry(shoulderArmorGeometry(3.6, 2.4, 2.4)), side > 0 ? red : shell, 0.7, mirror(side, 3.8), 4.8);
    shoulder.rotation.z = mirror(side, 0.08);
    shoulder.rotation.y = side > 0 ? 0.04 : 0.18;
    shoulders.push(shoulder);

    const arm = new THREE.Group();
    arm.position.set(1.3, mirror(side, 3.3), 3.6);
    upper.add(arm);
    createMesh(arm, registry.ownGeometry(plateGeometry(1.8, 1, 2.5, 0.22)), blue, 0.1, 0, 1.4).rotation.y = -0.06;
    createMesh(arm, registry.ownGeometry(plateGeometry(2.1, 1.05, 1.8, 0.2)), shell, 2.1, 0, 1).rotation.y = -0.22;
    arms.push(arm);
  }

  const rifle = new THREE.Group();
  rifle.position.set(3.6, -0.25, 0.95);
  arms[0].add(rifle);
  createMesh(rifle, registry.ownGeometry(cannonGeometry(5.8, 0.34, 0.54)), steel, 1.8, 0, 0).rotation.y = -0.12;
  createMesh(rifle, registry.ownGeometry(plateGeometry(2.1, 0.84, 1.05, 0.12)), blue, 0.3, 0, 0.65).rotation.y = -0.18;
  createMesh(rifle, registry.ownGeometry(plateGeometry(0.55, 0.65, 0.72, 0.12)), gold, 2.2, 0, 0.85).rotation.y = -0.1;
  const rifleFlash = createMesh(rifle, registry.ownGeometry(new THREE.SphereGeometry(0.5, 6, 5)), registry.makeGlow(0x9aeaff, 2.8, 0.14, 0), 4.8, 0, 0.08);
  rifleFlash.visible = false;

  const shield = createMesh(arms[1], registry.ownGeometry(wingPanelGeometry(3.3, 2.6, 1.1, 0.8)), blue, 3.3, 0.7, 0.9);
  shield.rotation.y = -0.22;
  shield.rotation.z = 0.12;
  createMesh(arms[1], registry.ownGeometry(plateGeometry(2.2, 0.7, 0.28, 0.08)), gold, 3.6, 0.74, 1.55).rotation.z = 0.1;

  const wingRoots: THREE.Group[] = [];
  const wingPanels: THREE.Mesh[][] = [];
  for (const side of [-1, 1] as const) {
    const rootWing = new THREE.Group();
    rootWing.position.set(-3.8, mirror(side, 2.8), 4.5);
    upper.add(rootWing);
    wingRoots.push(rootWing);
    const pair: THREE.Mesh[] = [];
    const rear = createMesh(rootWing, registry.ownGeometry(wingPanelGeometry(6.4, 1.7, 0.7, 0.24)), shell, -2.5, 0, 0.5);
    const fore = createMesh(rootWing, registry.ownGeometry(wingPanelGeometry(4.8, 1.25, 0.65, 0.24)), blue, -1.3, 0, 0.82);
    createMesh(rootWing, registry.ownGeometry(plateGeometry(4.6, 0.35, 0.18, 0.08)), gold, -1.9, 0, 1.05).rotation.z = 0.04;
    pair.push(rear, fore);
    wingPanels.push(pair);
    rootWing.visible = false;
  }

  const halo = createMesh(upper, registry.ownGeometry(haloGeometry(1.55, 0.16)), registry.makeGlow(0xffde7b, 2.2, 0.18, 0.2), 1.5, 0, 6.5);
  halo.visible = false;

  const armCannons: THREE.Group[] = [];
  const armCannonFlash: THREE.Mesh[] = [];
  for (const side of [-1, 1] as const) {
    const cannon = new THREE.Group();
    cannon.position.set(3.1, 0, 0.7);
    arms[side > 0 ? 1 : 0].add(cannon);
    createMesh(cannon, registry.ownGeometry(cannonGeometry(side > 0 ? 4.8 : 5.6, side > 0 ? 0.56 : 0.66, side > 0 ? 0.8 : 1.02)), side > 0 ? gold : steel, 1.55, 0, 0).rotation.y = -0.13;
    createMesh(cannon, registry.ownGeometry(plateGeometry(1.8, 0.9, 1.1, 0.12)), shell, -0.25, 0, 0.7).rotation.y = -0.16;
    const flash = createMesh(cannon, registry.ownGeometry(new THREE.SphereGeometry(0.62, 6, 5)), registry.makeGlow(side > 0 ? 0xffdf8a : 0xa3ecff, 2.9, 0.14, 0), side > 0 ? 4.1 : 4.8, 0, 0.1);
    flash.visible = false;
    cannon.visible = false;
    armCannons.push(cannon);
    armCannonFlash.push(flash);
  }

  const chestGlow = createMesh(upper, registry.ownGeometry(new THREE.SphereGeometry(0.45, 6, 5)), registry.makeGlow(0xffd975, 1.6, 0.1, 0.15), 2.6, 0, 6.05);

  return {
    root,
    radius: rig.radius,
    bossRadius: rig.bossRadius,
    update(pose: MechPose) {
      const { transform, breath, transformGlow } = applyCoreUpdate(rig, pose, 3.2, 0.12);
      const stride = pose.speed * Math.sin(pose.time * 8.2);
      model.position.z = breath * 0.22;
      upper.position.x = breath * 0.08;
      upper.position.z = 1.7 + breath * 0.18;
      pelvis.position.x = -0.85 - pose.speed * 0.24;
      chest.position.x = 0.5 + transform * 0.25;
      backpack.position.x = -3.8 - pose.speed * 0.3;
      for (let i = 0; i < legs.length; i++) {
        const side = i === 0 ? -1 : 1;
        legs[i].rotation.z = mirror(side, 0.08 + stride * 0.09);
        legs[i].position.x = -0.9 - pose.speed * 0.28;
        feet[i].position.x = 3 + pose.speed * 0.45;
      }
      for (let i = 0; i < arms.length; i++) {
        const side = i === 0 ? -1 : 1;
        arms[i].rotation.z = mirror(side, 0.06 + stride * 0.03);
        arms[i].position.x = 1.3 + transform * 0.2;
      }
      shoulders[0].position.y = -3.8 - transform * 0.35;
      shoulders[1].position.y = 3.8 + transform * 0.35;
      const thrustPulse = 1 + pose.speed * 0.9 + pose.fire * 0.2 + 0.12 * Math.sin(pose.time * 24);
      for (const thruster of thrusterGlows) thruster.uniforms.uIntensity.value *= thrustPulse;
      chestGlow.scale.setScalar(1 + pose.fire * 0.25 + transformGlow * 0.35);

      rifle.visible = transform < 0.72;
      rifle.position.x = 3.6 - pose.fire * 0.85 - transform * 1.2;
      rifleFlash.visible = pose.fire > 0.04 && transform < 0.78;
      rifleFlash.scale.setScalar(0.8 + pose.fire * 0.9);
      shield.position.x = 3.3 + transform * 0.25;

      const bossVisible = transform > 0.04;
      halo.visible = bossVisible;
      halo.scale.setScalar(0.9 + transform * 0.42);
      halo.position.x = 1.45 - transform * 0.3;
      (halo.material as THREE.ShaderMaterial).uniforms.uIntensity.value *= 1 + transform * 0.55;
      for (let i = 0; i < wingRoots.length; i++) {
        const side = i === 0 ? -1 : 1;
        const rootWing = wingRoots[i];
        rootWing.visible = bossVisible;
        rootWing.position.set(-3.8 - transform * 1.7, mirror(side, 2.9 + transform * 2.2), 4.7 + transform * 0.6);
        rootWing.rotation.z = mirror(side, lerp(0.34, 1.12, transform));
        rootWing.rotation.x = 0.06 + transform * 0.18;
        wingPanels[i][0].scale.set(1 + transform * 0.8, 1 + transform * 0.06, 1);
        wingPanels[i][1].scale.set(1 + transform * 0.55, 1 + transform * 0.05, 1);
        wingPanels[i][1].position.x = -1.3 - transform * 0.8;
      }
      for (let i = 0; i < armCannons.length; i++) {
        armCannons[i].visible = bossVisible;
        armCannons[i].position.x = 3.1 + transform * 1.1 - pose.fire * 0.55;
        armCannons[i].scale.setScalar(0.62 + transform * 0.55);
        armCannonFlash[i].visible = pose.fire > 0.04 && bossVisible;
        armCannonFlash[i].scale.setScalar(0.76 + pose.fire * 1.1);
      }
    },
    dispose() {
      rig.registry.dispose();
    },
  };
}

function createGale(): MechModel {
  const rig = createCoreRig(FRAME_RADIUS[1], FRAME_BOSS_RADIUS[1], 0xff5b6b);
  const { registry, lower, upper, model, root } = rig;

  const red = registry.makeToon({ color: 0xb32b3b, shade: 0x4b1117, light: 0xdf6271, rim: 0xffc7cd, lines: 0.14, lineColor: 0xff8b72 });
  const crimson = registry.makeToon({ color: 0xd3464b, shade: 0x6b161b, light: 0xec7b7f, rim: 0xffd0c8, lines: 0.18, lineColor: 0xffb45b });
  const black = registry.makeToon({ color: 0x232733, shade: 0x080b12, light: 0x566170, rim: 0xff6878, lines: 0.12, lineColor: 0xff6d70 });
  const gold = registry.makeToon({ color: 0xcf9b36, shade: 0x704a09, light: 0xeac973, rim: 0xffecaa, emissive: 0xffad53, emissiveAmt: 0.08 });
  registry.trackEmissive(gold, 0xffad53, 0.36);

  const pelvis = createMesh(lower, registry.ownGeometry(octagonGeometry(3.5, 2.9, 1.5, 0.2, 0.35)), red, -0.8, 0, 1.7);
  pelvis.rotation.y = 0.16;
  const chest = createMesh(upper, registry.ownGeometry(octagonGeometry(5.2, 3.8, 2.5, 0.22, 0.48)), black, 0.7, 0, 3.8);
  chest.rotation.y = -0.22;
  const chestBlade = createMesh(upper, registry.ownGeometry(spikeGeometry(2.9, 1.9, 0.85)), crimson, 2.25, 0, 4.9);
  chestBlade.rotation.x = 0.34;
  const chestGold = createMesh(upper, registry.ownGeometry(spikeGeometry(1.7, 1.15, 0.55)), gold, 2.5, 0, 5.5);
  chestGold.rotation.x = 0.5;

  const head = new THREE.Group();
  head.position.set(2.6, 0, 5.2);
  upper.add(head);
  createMesh(head, registry.ownGeometry(octagonGeometry(1.45, 1.35, 1.15, 0.18, 0.2)), black, 0, 0, 0);
  createMesh(head, registry.ownGeometry(plateGeometry(0.55, 0.32, 0.42, 0.08)), registry.makeGlow(0xffcb61, 2, 0.12, 0.12), 0.48, 0, 0.2);
  for (const side of [-1, 1] as const) {
    const horn = createMesh(head, registry.ownGeometry(spikeGeometry(2.25, 0.7, 0.32)), side > 0 ? gold : crimson, 0.2, mirror(side, 0.7), 0.7);
    horn.rotation.z = mirror(side, 0.96);
    horn.rotation.x = 0.44;
  }

  const wingRoots: THREE.Group[] = [];
  const wingBlades: THREE.Mesh[] = [];
  for (const side of [-1, 1] as const) {
    const rootWing = new THREE.Group();
    rootWing.position.set(-2.5, mirror(side, 3.3), 3.2);
    upper.add(rootWing);
    wingRoots.push(rootWing);
    const blade = createMesh(rootWing, registry.ownGeometry(wingPanelGeometry(side > 0 ? 7.1 : 6.4, 1.55, 0.72, 0.18)), side > 0 ? crimson : red, -2.25, 0, 0.45);
    blade.rotation.y = -0.36;
    blade.rotation.z = mirror(side, -0.98);
    wingBlades.push(blade);
    createMesh(rootWing, registry.ownGeometry(spikeGeometry(3.3, 0.62, 0.25)), gold, -4.35, mirror(side, 0.42), 0.82).rotation.z = mirror(side, -1.18);
  }

  const boosterGlows: THREE.ShaderMaterial[] = [];
  const dashStreaks: THREE.Mesh[] = [];
  const boosterPods: THREE.Group[] = [];
  for (const side of [-1, 1] as const) {
    const booster = new THREE.Group();
    booster.position.set(-5, mirror(side, 2.4), 2.2);
    lower.add(booster);
    boosterPods.push(booster);
    createMesh(booster, registry.ownGeometry(thrusterNozzleGeometry(1.2, 4.4)), black, 0, 0, 0).rotation.x = 0.12;
    createMesh(booster, registry.ownGeometry(wingPanelGeometry(3.4, 1.2, 0.85, 0.24)), red, 1.1, 0, 0.62).rotation.z = mirror(side, -0.22);
    const glow = createMesh(booster, registry.ownGeometry(new THREE.SphereGeometry(0.9, 6, 5)), registry.makeGlow(0xff8a52, 2.4, 0.16, 0.25), -1.85, 0, 0);
    glow.scale.set(2, 0.7, 0.7);
    boosterGlows.push(glow.material as THREE.ShaderMaterial);
    const streak = createMesh(booster, registry.ownGeometry(wingPanelGeometry(5.4, 0.7, 0.26, 0.18)), registry.makeGlow(0xff7448, 1.9, 0.06, 0), -4.4, 0, -0.1);
    streak.visible = false;
    dashStreaks.push(streak);
  }

  const legs: THREE.Group[] = [];
  for (const side of [-1, 1] as const) {
    const leg = new THREE.Group();
    leg.position.set(-0.8, mirror(side, 1.35), 0.38);
    lower.add(leg);
    createMesh(leg, registry.ownGeometry(plateGeometry(1.2, 0.8, 2.7, 0.16)), black, 0, 0, 1.35).rotation.y = 0.05;
    createMesh(leg, registry.ownGeometry(wingPanelGeometry(2.5, 0.95, 0.6, 0.3)), crimson, 1.7, 0, 0.18).rotation.y = -0.26;
    legs.push(leg);
  }

  const guns: THREE.Group[] = [];
  const gunFlash: THREE.Mesh[] = [];
  for (const side of [-1, 1] as const) {
    const gun = new THREE.Group();
    gun.position.set(1.55, mirror(side, 1.95), 2.9);
    upper.add(gun);
    guns.push(gun);
    createMesh(gun, registry.ownGeometry(cannonGeometry(5.9, 0.22, 0.34)), side > 0 ? gold : black, 2.25, 0, 0).rotation.y = -0.08;
    createMesh(gun, registry.ownGeometry(plateGeometry(1.2, 0.46, 0.52, 0.08)), crimson, 0.1, 0, 0.35).rotation.y = -0.12;
    const flash = createMesh(gun, registry.ownGeometry(new THREE.SphereGeometry(0.35, 6, 5)), registry.makeGlow(0xffd37b, 2.3, 0.12, 0), 4.8, 0, 0);
    flash.visible = false;
    gunFlash.push(flash);
  }

  const bossFanRoots: THREE.Group[] = [];
  for (const side of [-1, 1] as const) {
    const fan = new THREE.Group();
    fan.position.set(-1.6, mirror(side, 4.1), 4.7);
    upper.add(fan);
    createMesh(fan, registry.ownGeometry(wingPanelGeometry(5.1, 1.3, 0.48, 0.14)), crimson, -1.9, 0, 0.35).rotation.z = mirror(side, -0.2);
    createMesh(fan, registry.ownGeometry(wingPanelGeometry(4.2, 1.05, 0.42, 0.14)), gold, -1.2, 0, 0.8).rotation.z = mirror(side, 0.12);
    fan.visible = false;
    bossFanRoots.push(fan);
  }

  const orbitRing = createMesh(model, registry.ownGeometry(haloGeometry(8.4, 0.14)), registry.makeGlow(0xff6a5a, 1.6, 0.06, 0.18), 0, 0, 4.1);
  orbitRing.visible = false;
  const bits: THREE.Group[] = [];
  const bitGlows: THREE.ShaderMaterial[] = [];
  for (let i = 0; i < 4; i++) {
    const bit = new THREE.Group();
    model.add(bit);
    createMesh(bit, registry.ownGeometry(wingPanelGeometry(1.9, 0.92, 0.48, 0.16)), i % 2 === 0 ? crimson : red, 0, 0, 0).rotation.y = -0.22;
    createMesh(bit, registry.ownGeometry(spikeGeometry(1.4, 0.42, 0.18)), gold, 0.2, 0, 0.42).rotation.x = 0.46;
    const glow = createMesh(bit, registry.ownGeometry(new THREE.SphereGeometry(0.22, 5, 4)), registry.makeGlow(0xffcb62, 1.7, 0.1, 0.12), -0.28, 0, 0.08);
    bit.visible = false;
    bits.push(bit);
    bitGlows.push(glow.material as THREE.ShaderMaterial);
  }

  return {
    root,
    radius: rig.radius,
    bossRadius: rig.bossRadius,
    update(pose: MechPose) {
      const { transform, breath, transformGlow } = applyCoreUpdate(rig, pose, 5.1, 0.18 + pose.alt * 0.05);
      const stride = pose.speed * Math.sin(pose.time * 12.8);
      model.position.z = breath * 0.28;
      upper.position.x = breath * 0.12;
      upper.position.z = 1.7 + breath * 0.24;
      pelvis.position.x = -0.9 - pose.speed * 0.28;
      chest.position.x = 0.75 + transform * 0.15;
      for (let i = 0; i < legs.length; i++) {
        const side = i === 0 ? -1 : 1;
        legs[i].rotation.z = mirror(side, 0.12 + stride * 0.08);
        legs[i].position.x = -0.8 - pose.speed * 0.42;
      }
      wingRoots[0].rotation.z = -lerp(1.02, 1.34, transform);
      wingRoots[1].rotation.z = lerp(1.02, 1.34, transform);
      wingRoots[0].rotation.x = 0.06 + transform * 0.08;
      wingRoots[1].rotation.x = 0.06 + transform * 0.08;

      const boosterPulse = 1 + pose.speed * 1.4 + pose.alt * 1.9 + 0.18 * Math.sin(pose.time * 30);
      for (let i = 0; i < boosterPods.length; i++) {
        const side = i === 0 ? -1 : 1;
        boosterPods[i].rotation.z = mirror(side, 0.08 + pose.alt * 0.26 + stride * 0.04);
        boosterPods[i].position.x = -5 - pose.alt * 0.8;
        boosterGlows[i].uniforms.uIntensity.value *= boosterPulse;
        dashStreaks[i].visible = pose.alt > 0.06;
        dashStreaks[i].scale.set(1 + pose.alt * 1.8, 1 + pose.alt * 0.5, 1);
      }

      for (let i = 0; i < guns.length; i++) {
        const side = i === 0 ? -1 : 1;
        guns[i].rotation.z = mirror(side, 0.05 + pose.fire * 0.03);
        guns[i].position.x = 1.6 + transform * 0.2 - pose.fire * 0.45;
        gunFlash[i].visible = pose.fire > 0.04;
        gunFlash[i].scale.setScalar(0.75 + pose.fire * 0.8);
      }

      const bossVisible = transform > 0.06;
      orbitRing.visible = bossVisible;
      orbitRing.scale.setScalar(0.45 + transform * 0.55);
      (orbitRing.material as THREE.ShaderMaterial).uniforms.uIntensity.value *= 1 + transform * 0.5;
      for (let i = 0; i < bossFanRoots.length; i++) {
        const side = i === 0 ? -1 : 1;
        bossFanRoots[i].visible = bossVisible;
        bossFanRoots[i].rotation.z = mirror(side, lerp(-0.1, 0.78, transform));
        bossFanRoots[i].position.set(-1.7 - transform * 0.75, mirror(side, 4.2 + transform * 1.4), 4.7 + transform * 0.25);
      }
      const orbitRadius = 8.4 * transform;
      for (let i = 0; i < bits.length; i++) {
        const angle = pose.time * TURN + i * HALF_PI;
        bits[i].visible = bossVisible;
        bits[i].position.set(Math.cos(angle) * orbitRadius, Math.sin(angle) * orbitRadius, 4.2 + Math.sin(angle * 2) * 0.22);
        bits[i].rotation.z = angle + HALF_PI;
        bitGlows[i].uniforms.uIntensity.value *= 1 + pose.alt * 0.4 + transformGlow * 0.3;
      }
    },
    dispose() {
      rig.registry.dispose();
    },
  };
}

function createJuggernaut(): MechModel {
  const rig = createCoreRig(FRAME_RADIUS[2], FRAME_BOSS_RADIUS[2], 0xffa24c);
  const { registry, lower, upper, model, root } = rig;

  const olive = registry.makeToon({ color: 0x687a4d, shade: 0x2b341d, light: 0x92a872, rim: 0xd8e8b0, lines: 0.08, lineColor: 0xd3dd8a });
  const gunmetal = registry.makeToon({ color: 0x5d6671, shade: 0x1f252c, light: 0x8e99a5, rim: 0xc7d8e9, lines: 0.14, lineColor: 0xdce7ff });
  const hazard = registry.makeToon({ color: 0xc88538, shade: 0x693c08, light: 0xeab26c, rim: 0xffd8a8, emissive: 0xffa14c, emissiveAmt: 0.08 });
  const coreMat = registry.makeToon({ color: 0x9e5d28, shade: 0x4d260c, light: 0xe89152, rim: 0xffce98, emissive: 0xff8640, emissiveAmt: 0.1 });
  registry.trackEmissive(hazard, 0xffa14c, 0.32);
  registry.trackEmissive(coreMat, 0xff8640, 0.42);

  const base = createMesh(lower, registry.ownGeometry(octagonGeometry(8.8, 6.6, 3.1, 0.16, 0.65)), gunmetal, -1.1, 0, 2);
  base.rotation.y = 0.12;
  const chest = createMesh(upper, registry.ownGeometry(octagonGeometry(8.1, 5.7, 2.9, 0.18, 0.58)), olive, 0.2, 0, 4.2);
  chest.rotation.y = -0.08;
  const frontPlate = createMesh(upper, registry.ownGeometry(plateGeometry(3.3, 2.1, 1.1, 0.16)), gunmetal, 3.2, 0, 5.1);
  frontPlate.rotation.y = -0.12;
  const reactor = createMesh(upper, registry.ownGeometry(octagonGeometry(2.25, 1.7, 0.85, 0.16, 0.16)), coreMat, 2.75, 0, 5.9);
  reactor.rotation.y = -0.16;

  const treadPods: THREE.Group[] = [];
  const treadFeet: THREE.Mesh[] = [];
  for (const side of [-1, 1] as const) {
    const pod = new THREE.Group();
    pod.position.set(-1.8, mirror(side, 4.7), 0.4);
    lower.add(pod);
    createMesh(pod, registry.ownGeometry(octagonGeometry(6.2, 2.8, 3.2, 0.12, 0.45)), olive, 0, 0, 1.2).rotation.y = 0.06;
    createMesh(pod, registry.ownGeometry(plateGeometry(4.8, 0.72, 0.3, 0.06)), hazard, 1.05, 0, 2.95).rotation.z = 0.12;
    const foot = createMesh(pod, registry.ownGeometry(plateGeometry(2.4, 1.15, 0.7, 0.08)), gunmetal, 2.6, 0, -0.12);
    treadPods.push(pod);
    treadFeet.push(foot);
  }

  const head = new THREE.Group();
  head.position.set(3.2, 0, 6.25);
  upper.add(head);
  createMesh(head, registry.ownGeometry(octagonGeometry(1.45, 1.2, 1.05, 0.16, 0.12)), olive, 0, 0, 0);
  createMesh(head, registry.ownGeometry(plateGeometry(0.5, 0.26, 0.32, 0.08)), registry.makeGlow(0xffbf69, 1.8, 0.1, 0.08), 0.45, 0, 0.16);

  const shoulderCannons: THREE.Group[] = [];
  const shoulderFlash: THREE.Mesh[] = [];
  for (const side of [-1, 1] as const) {
    const mount = new THREE.Group();
    mount.position.set(0.8, mirror(side, 4.7), 5.3);
    upper.add(mount);
    shoulderCannons.push(mount);
    createMesh(mount, registry.ownGeometry(octagonGeometry(2.8, 2.1, 2.1, 0.16, 0.24)), olive, 0, 0, 0);
    createMesh(mount, registry.ownGeometry(cannonGeometry(7.1, 0.82, 1.08)), side > 0 ? hazard : gunmetal, 3.2, 0, 0).rotation.y = -0.08;
    const flash = createMesh(mount, registry.ownGeometry(new THREE.SphereGeometry(0.72, 6, 5)), registry.makeGlow(side > 0 ? 0xffbe72 : 0xff8d55, 2.5, 0.12, 0), 6.2, 0, 0);
    flash.visible = false;
    shoulderFlash.push(flash);
  }

  const armShield = new THREE.Group();
  armShield.position.set(2.3, 4.9, 3.2);
  upper.add(armShield);
  createMesh(armShield, registry.ownGeometry(plateGeometry(1.8, 1.6, 1.7, 0.1)), gunmetal, 0, 0, 0.9);
  const shieldSlab = createMesh(armShield, registry.ownGeometry(wingPanelGeometry(5.2, 3.7, 1.2, 0.9)), gunmetal, 2.9, 0.45, 1.1);
  shieldSlab.rotation.y = -0.14;
  shieldSlab.rotation.z = 0.1;
  createMesh(armShield, registry.ownGeometry(plateGeometry(4.3, 0.55, 0.22, 0.06)), hazard, 3.15, 0.52, 1.88).rotation.z = 0.15;
  const shieldArc = createMesh(upper, registry.ownGeometry(arcGeometry(7.8, 9.6, 0.22, -0.82, 1.64)), registry.makeGlow(0x95e9ff, 1.25, 0.04, 0.18), 7.8, 0, 2.3);
  shieldArc.visible = false;

  const exhaustGlows: THREE.ShaderMaterial[] = [];
  const exhaustStacks: THREE.Mesh[] = [];
  for (const side of [-1, 1] as const) {
    createMesh(lower, registry.ownGeometry(thrusterNozzleGeometry(0.8, 2.9)), gunmetal, -6.2, mirror(side, 2), 2.8).rotation.x = 0.1;
    const glow = createMesh(lower, registry.ownGeometry(new THREE.SphereGeometry(0.55, 6, 5)), registry.makeGlow(0xff9951, 1.9, 0.1, 0.14), -7.25, mirror(side, 2), 2.8);
    glow.scale.set(1.6, 0.65, 0.65);
    exhaustGlows.push(glow.material as THREE.ShaderMaterial);
    const stack = createMesh(upper, registry.ownGeometry(plateGeometry(1.15, 0.92, 3.4, 0.08)), olive, -4.3, mirror(side, 1.9), 5.85);
    exhaustStacks.push(stack);
  }

  const sideArmor: THREE.Mesh[] = [];
  for (const side of [-1, 1] as const) {
    const plate = createMesh(upper, registry.ownGeometry(plateGeometry(3.1, 1.25, 1.3, 0.08)), olive, -0.5, mirror(side, 4.1), 4.6);
    plate.rotation.z = mirror(side, 0.08);
    sideArmor.push(plate);
  }

  const fortressCannons: THREE.Group[] = [];
  const fortressFlash: THREE.Mesh[] = [];
  for (const side of [-1, 1] as const) {
    const cannon = new THREE.Group();
    cannon.position.set(3.9, mirror(side, 1.65), 6.2);
    upper.add(cannon);
    createMesh(cannon, registry.ownGeometry(cannonGeometry(8.8, 0.95, 1.24)), hazard, 3.2, 0, 0).rotation.y = -0.08;
    createMesh(cannon, registry.ownGeometry(octagonGeometry(2.7, 1.4, 1.5, 0.12, 0.12)), olive, 0, 0, 0.62).rotation.y = -0.12;
    const flash = createMesh(cannon, registry.ownGeometry(new THREE.SphereGeometry(0.84, 6, 5)), registry.makeGlow(0xffbf75, 2.6, 0.12, 0), 7.4, 0, 0);
    flash.visible = false;
    cannon.visible = false;
    fortressCannons.push(cannon);
    fortressFlash.push(flash);
  }

  const missileRacks: THREE.Group[] = [];
  const missileDoors: THREE.Group[] = [];
  for (const side of [-1, 1] as const) {
    const rack = new THREE.Group();
    rack.position.set(-0.8, mirror(side, 6.6), 5.35);
    upper.add(rack);
    createMesh(rack, registry.ownGeometry(octagonGeometry(4.2, 2.2, 1.8, 0.12, 0.16)), olive, 0, 0, 0);
    for (let row = -1; row <= 1; row++) {
      for (let col = 0; col < 2; col++) {
        createMesh(rack, registry.ownGeometry(plateGeometry(0.45, 0.45, 0.55, 0.04)), hazard, 0.85 + col * 0.85, row * 0.62, 0.92);
      }
    }
    const door = new THREE.Group();
    rack.add(door);
    createMesh(door, registry.ownGeometry(plateGeometry(3.9, 0.58, 0.14, 0.04)), gunmetal, 0, 0.95, 0.72);
    createMesh(door, registry.ownGeometry(plateGeometry(3.9, 0.58, 0.14, 0.04)), gunmetal, 0, -0.95, 0.72);
    rack.visible = false;
    missileRacks.push(rack);
    missileDoors.push(door);
  }

  const reactorGlow = createMesh(upper, registry.ownGeometry(new THREE.SphereGeometry(0.6, 6, 5)), registry.makeGlow(0xff9348, 1.9, 0.12, 0.16), 2.8, 0, 6.25);

  return {
    root,
    radius: rig.radius,
    bossRadius: rig.bossRadius,
    update(pose: MechPose) {
      const { transform, breath, transformGlow } = applyCoreUpdate(rig, pose, 2.4, 0.08);
      const stride = pose.speed * Math.sin(pose.time * 6.2);
      model.position.z = breath * 0.18;
      upper.position.z = 1.7 + breath * 0.14;
      base.position.x = -1.2 - pose.speed * 0.18;
      chest.position.x = 0.25 + transform * 0.25;
      reactor.scale.setScalar(1 + transformGlow * 0.35 + pose.alt * 0.12);
      reactorGlow.scale.setScalar(1 + transformGlow * 0.45);
      for (let i = 0; i < treadPods.length; i++) {
        const side = i === 0 ? -1 : 1;
        treadPods[i].rotation.z = mirror(side, 0.04 + stride * 0.03);
        treadPods[i].position.x = -1.8 - pose.speed * 0.35;
        treadFeet[i].position.x = 2.6 + pose.speed * 0.18;
      }
      const exhaustPulse = 1 + pose.speed * 0.75 + 0.12 * Math.sin(pose.time * 21);
      for (const glow of exhaustGlows) glow.uniforms.uIntensity.value *= exhaustPulse;

      for (let i = 0; i < shoulderCannons.length; i++) {
        const side = i === 0 ? -1 : 1;
        shoulderCannons[i].rotation.z = mirror(side, 0.02 + pose.fire * 0.03);
        shoulderCannons[i].position.x = 0.8 - pose.fire * 0.55;
        shoulderFlash[i].visible = pose.fire > 0.04;
        shoulderFlash[i].scale.setScalar(0.8 + pose.fire * 0.9);
      }

      armShield.position.x = 2.3 + pose.alt * 2.4;
      armShield.position.y = 4.9 - pose.alt * 1.3;
      shieldSlab.position.x = 2.9 + pose.alt * 1.9;
      shieldSlab.rotation.z = 0.1 + pose.alt * 0.22;
      shieldArc.visible = pose.alt > 0.04;
      shieldArc.position.x = 7.8 + pose.alt * 3.7;
      shieldArc.scale.set(1 + pose.alt * 0.18, 1 + pose.alt * 0.28, 1);
      (shieldArc.material as THREE.ShaderMaterial).uniforms.uIntensity.value *= 1 + pose.alt * 0.7;

      const bossVisible = transform > 0.05;
      for (let i = 0; i < sideArmor.length; i++) {
        const side = i === 0 ? -1 : 1;
        sideArmor[i].position.y = mirror(side, 4.1 + transform * 1.6);
        sideArmor[i].position.x = -0.5 - transform * 1.35;
        sideArmor[i].rotation.z = mirror(side, 0.08 + transform * 0.15);
      }
      for (let i = 0; i < fortressCannons.length; i++) {
        fortressCannons[i].visible = bossVisible;
        fortressCannons[i].position.x = 3.9 + transform * 1.9 - pose.fire * 0.7;
        fortressCannons[i].scale.setScalar(0.68 + transform * 0.52);
        fortressFlash[i].visible = pose.fire > 0.04 && bossVisible;
        fortressFlash[i].scale.setScalar(0.84 + pose.fire * 1.05);
      }
      for (let i = 0; i < missileRacks.length; i++) {
        const side = i === 0 ? -1 : 1;
        missileRacks[i].visible = bossVisible;
        missileRacks[i].position.set(-0.9 - transform * 1.4, mirror(side, 6.7 + transform * 2.2), 5.35 + transform * 0.35);
        missileRacks[i].rotation.z = mirror(side, 0.08 + transform * 0.34);
        missileDoors[i].rotation.x = transform * 1.02;
      }
      for (let i = 0; i < exhaustStacks.length; i++) {
        exhaustStacks[i].visible = bossVisible;
        exhaustStacks[i].position.x = -4.3 - transform * 1.7;
        exhaustStacks[i].scale.set(1 + transform * 0.15, 1, 1 + transform * 0.42);
      }
    },
    dispose() {
      rig.registry.dispose();
    },
  };
}

export function createPlayerMech(frame: number): MechModel {
  switch (frame) {
    case 0:
      return createVanguard();
    case 1:
      return createGale();
    case 2:
      return createJuggernaut();
    default:
      return createVanguard();
  }
}
