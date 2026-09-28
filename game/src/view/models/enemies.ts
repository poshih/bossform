import * as THREE from 'three';
import { EnemyType } from '../../sim/index.ts';
import { disposeObject, gearGeometry, glowMaterial, profileGeometry, toonMaterial, type GlowMaterial, type ToonMaterial } from '../../render/meshkit.ts';
import type { EnemyModel, EnemyPose } from './types.ts';

const TAU = Math.PI * 2;
const WHITE = new THREE.Color(0xffffff);

const FACTION_ARMOR = 0x39324d;
const FACTION_SHADE = 0x151222;
const FACTION_LIGHT = 0x655a86;
const FACTION_PLATE = 0x2b243b;
const FACTION_LINES = 0xff2b8c;
const FACTION_GLOW = 0xff2b8c;
const FACTION_RED = 0xff5b4d;
const BULWARK_GLOW = 0xffa43a;
const SERAPH_GLOW = 0x8ff4ff;
const OVERLORD_GLOW = 0xff455d;
const OVERLORD_VIOLET = 0x8d5cff;
const OVERLORD_GOLD = 0xd9a347;

/**
 * Against the dark arena floor the faction's near-black armour vanished, leaving only its glow lines. Every armour
 * colour is lifted here (one owner, in linear light so the display curve halves the effect) so plates read as solid
 * silhouettes while keeping their violet-gunmetal hue.
 */
const ARMOUR_LIFT = 6;
const SHADE_LIFT = 4.5;
const SHADE_FLOOR = 0x2c2c4c;

function liftValue(hex: number, factor: number = ARMOUR_LIFT): number {
  const lifted = new THREE.Color(hex);
  const floor = new THREE.Color(SHADE_FLOOR);
  lifted.r = Math.min(1, Math.max(lifted.r * factor, factor === SHADE_LIFT ? floor.r : 0));
  lifted.g = Math.min(1, Math.max(lifted.g * factor, factor === SHADE_LIFT ? floor.g : 0));
  lifted.b = Math.min(1, Math.max(lifted.b * factor, factor === SHADE_LIFT ? floor.b : 0));
  return lifted.getHex();
}

const ENEMY_RADII = [7, 9, 8, 11, 15, 34, 30, 38] as const;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function smooth(t: number): number {
  const k = clamp01(t);
  return k * k * (3 - 2 * k);
}

function pulse(time: number, speed: number, min = 0, max = 1): number {
  return mix(min, max, 0.5 + 0.5 * Math.sin(time * speed));
}

interface GlowRef {
  readonly mat: GlowMaterial;
  readonly baseIntensity: number;
  readonly baseColor: THREE.Color;
}

class ModelRig {
  readonly root = new THREE.Group();
  readonly frame = new THREE.Group();
  readonly body = new THREE.Group();
  readonly aim = new THREE.Group();
  readonly fx = new THREE.Group();
  readonly toons: ToonMaterial[] = [];
  readonly glows: GlowRef[] = [];
  readonly radius: number;
  private readonly materials = new Set<THREE.Material>();

  constructor(radius: number) {
    this.radius = radius;
    this.frame.add(this.body, this.aim, this.fx);
    this.root.add(this.frame);
  }

  toon(options: Parameters<typeof toonMaterial>[0]): ToonMaterial {
    const mat = toonMaterial({
      ...options,
      color: liftValue(options.color),
      shade: options.shade === undefined ? undefined : liftValue(options.shade, SHADE_LIFT),
      light: options.light === undefined ? undefined : liftValue(options.light),
    });
    this.materials.add(mat);
    this.toons.push(mat);
    return mat;
  }

  glow(color: number, intensity = 2, fresnel = 0, pulseAmt = 0): GlowRef {
    const mat = glowMaterial(color, intensity, fresnel, pulseAmt);
    this.materials.add(mat);
    const ref = { mat, baseIntensity: intensity, baseColor: new THREE.Color(color) };
    this.glows.push(ref);
    return ref;
  }

  mesh<T extends THREE.Material>(geometry: THREE.BufferGeometry, material: T, parent: THREE.Object3D = this.body): THREE.Mesh<THREE.BufferGeometry, T> {
    const mesh = new THREE.Mesh(geometry, material);
    parent.add(mesh);
    this.materials.add(material);
    return mesh;
  }

  add(obj: THREE.Object3D, parent: THREE.Object3D = this.body): void {
    parent.add(obj);
    obj.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      const material = mesh.material;
      if (Array.isArray(material)) {
        for (const mat of material) this.materials.add(mat);
      } else {
        this.materials.add(material);
      }
    });
  }

  dispose(): void {
    disposeObject(this.root);
    for (const material of this.materials) material.dispose();
  }
}

function beginUpdate(rig: ModelRig, pose: EnemyPose): void {
  for (const toon of rig.toons) {
    toon.uniforms.uFlash.value = pose.flash;
    toon.uniforms.uTime.value = pose.time;
  }
  for (const glow of rig.glows) glow.mat.uniforms.uTime.value = pose.time;
}

function setGlow(ref: GlowRef, intensity: number, whiteHot = 0): void {
  ref.mat.uniforms.uIntensity.value = ref.baseIntensity * Math.max(0, intensity);
  ref.mat.uniforms.uColor.value.copy(ref.baseColor).lerp(WHITE, clamp01(whiteHot));
}

function makeShield(rig: ModelRig, radius: number, color: number): { ring: THREE.Mesh; disc: THREE.Mesh; glow: GlowRef } {
  const glow = rig.glow(color, 1.7, 0.95, 0.75);
  glow.mat.side = THREE.DoubleSide;
  const ring = rig.mesh(new THREE.TorusGeometry(radius, Math.max(1.4, radius * 0.06), 4, 28), glow.mat, rig.fx);
  ring.rotation.x = 0.16;
  ring.renderOrder = 10;
  const disc = rig.mesh(new THREE.CircleGeometry(radius * 0.92, 24), glow.mat, rig.fx);
  disc.rotation.z = Math.PI / 10;
  disc.position.z = -1.5;
  disc.renderOrder = 9;
  return { ring, disc, glow };
}

function makeDamagePatches(rig: ModelRig, specs: ReadonlyArray<readonly [number, number, number, number, number]>): ToonMaterial[] {
  const mats: ToonMaterial[] = [];
  for (const [x, y, z, sx, sy] of specs) {
    const mat = rig.toon({ color: 0x08070d, shade: 0x000000, light: 0x18151f, rim: 0x201a28, rimAmt: 0.1 });
    mat.uniforms.uAlpha.value = 0;
    const patch = rig.mesh(new THREE.BoxGeometry(sx, sy, 0.8), mat);
    patch.position.set(x, y, z);
    patch.rotation.z = x * 0.03;
    mats.push(mat);
  }
  return mats;
}

function setDamage(patches: readonly ToonMaterial[], amount: number, flicker = 0): void {
  const alpha = clamp01(amount);
  for (let i = 0; i < patches.length; i++) {
    const wobble = 0.7 + 0.3 * Math.sin(flicker + i * 1.7);
    patches[i].uniforms.uAlpha.value = alpha * wobble;
  }
}

function finalizeEnemyModel(rig: ModelRig, updateModel: (pose: EnemyPose) => void): EnemyModel {
  return {
    root: rig.root,
    radius: rig.radius,
    update(pose: EnemyPose): void {
      beginUpdate(rig, pose);
      updateModel(pose);
    },
    dispose(): void {
      rig.dispose();
    },
  };
}

function createDroneModel(): EnemyModel {
  const rig = new ModelRig(ENEMY_RADII[EnemyType.Drone]);
  const shellMat = rig.toon({ color: 0x332d47, shade: 0x120f1e, light: 0x665b87, rim: 0xff7ad8, lines: 0.14, lineColor: 0xff4ca4 });
  const finMat = rig.toon({ color: 0x262036, shade: 0x0b0910, light: 0x51446a, rim: 0xb27fff });
  const eyeGlow = rig.glow(0xff4ca4, 2.9, 0.3, 0.35);
  const thrusterGlow = rig.glow(0xff6a4e, 1.9, 0.2, 0.45);

  const hull = rig.mesh(new THREE.CylinderGeometry(4.8, 5.4, 3.6, 14), shellMat);
  hull.position.z = 1.8;
  const dome = rig.mesh(new THREE.SphereGeometry(3.7, 10, 8), shellMat);
  dome.position.set(0.3, 0, 3.5);
  dome.scale.set(1.18, 1.18, 0.72);
  const finL = rig.mesh(profileGeometry([[-2.8, -0.8], [0.6, 1.4], [4.5, 0], [0.6, -1.4]], 1.4, 0.4), finMat);
  finL.position.set(-1.8, 5.1, 2.6);
  finL.rotation.z = 0.18;
  const finR = rig.mesh(profileGeometry([[-2.8, -0.8], [0.6, 1.4], [4.5, 0], [0.6, -1.4]], 1.4, 0.4), finMat);
  finR.position.set(-1.8, -5.1, 2.6);
  finR.rotation.z = -0.18;
  const sensor = rig.mesh(new THREE.SphereGeometry(2.2, 10, 8), eyeGlow.mat);
  sensor.position.set(4.1, 0, 4.3);
  sensor.scale.set(1.15, 0.82, 0.75);
  const thruster = rig.mesh(new THREE.SphereGeometry(1.7, 8, 6), thrusterGlow.mat);
  thruster.position.set(-4.5, 0, 0.5);
  thruster.scale.set(1.3, 1, 0.6);
  const patches = makeDamagePatches(rig, [[-0.8, 2.5, 4.5, 2.8, 1.2], [-2.3, -2.2, 4.4, 3.2, 1.4]]);

  return finalizeEnemyModel(rig, (pose) => {
    const damage = 1 - pose.hp;
    rig.frame.position.set(0, 0, 2.1 + Math.sin(pose.time * 4.8) * 0.42);
    rig.body.rotation.z = pose.heading;
    const flutter = 0.16 + pose.speed * 0.22 + Math.sin(pose.time * 9) * 0.05;
    finL.rotation.z = 0.15 + flutter;
    finR.rotation.z = -(0.15 + flutter);
    sensor.scale.set(1.12 + pulse(pose.time, 8.5, 0, 0.1), 0.82, 0.75);
    setGlow(eyeGlow, 0.95 + pulse(pose.time, 9.5, 0, 0.22), 0);
    setGlow(thrusterGlow, 0.8 + pose.speed * 0.8 + pulse(pose.time, 13, 0.05, 0.35), 0);
    setDamage(patches, damage * 0.4, pose.time * 11);
  });
}

function createGunnerModel(): EnemyModel {
  const rig = new ModelRig(ENEMY_RADII[EnemyType.Gunner]);
  const hullMat = rig.toon({ color: 0x353047, shade: 0x120f1d, light: 0x6a6286, rim: 0xff7f79, lines: 0.14, lineColor: 0xff5a4e });
  const podMat = rig.toon({ color: 0x262035, shade: 0x0c0910, light: 0x564b6f, rim: 0xff9b7d });
  const gunMat = rig.toon({ color: 0x49425a, shade: 0x171320, light: 0x807694, rim: 0xffc1a2, lines: 0.08, lineColor: 0xff7a64 });
  const eyeGlow = rig.glow(0xff6a4e, 2.1, 0.18, 0.25);
  const thrusterGlow = rig.glow(0xff4d64, 1.7, 0.18, 0.35);
  const muzzleGlow = rig.glow(0xff6a4e, 2.2, 0.28, 0.45);

  const hull = rig.mesh(new THREE.BoxGeometry(8.8, 7.2, 4.2), hullMat);
  hull.position.z = 3;
  const cockpit = rig.mesh(profileGeometry([[-2.4, -2.1], [0.4, 2.4], [4.7, 1.8], [5.8, 0], [4.7, -1.8], [0.4, -2.4]], 2.4, 0.6), podMat);
  cockpit.position.set(2.6, 0, 5.6);
  const podL = rig.mesh(new THREE.BoxGeometry(4.6, 3.3, 3.2), podMat);
  podL.position.set(-1.2, 6.2, 2.2);
  const podR = rig.mesh(new THREE.BoxGeometry(4.6, 3.3, 3.2), podMat);
  podR.position.set(-1.2, -6.2, 2.2);
  const thrusterL = rig.mesh(new THREE.SphereGeometry(1.35, 8, 6), thrusterGlow.mat);
  thrusterL.position.set(-3.8, 6.2, 1.1);
  const thrusterR = rig.mesh(new THREE.SphereGeometry(1.35, 8, 6), thrusterGlow.mat);
  thrusterR.position.set(-3.8, -6.2, 1.1);
  const turret = new THREE.Group();
  turret.position.set(1.6, 0, 5.5);
  const mount = rig.mesh(new THREE.BoxGeometry(4.6, 2.8, 2.2), gunMat, turret);
  mount.position.x = 1.6;
  const barrel = rig.mesh(new THREE.BoxGeometry(10.6, 1.4, 1.4), gunMat, turret);
  barrel.position.x = 8.2;
  const muzzle = rig.mesh(new THREE.SphereGeometry(1.1, 8, 6), muzzleGlow.mat, turret);
  muzzle.position.set(13.6, 0, 0);
  rig.add(turret, rig.aim);
  const eye = rig.mesh(new THREE.SphereGeometry(1.35, 8, 6), eyeGlow.mat);
  eye.position.set(4.8, 0, 5.2);
  eye.scale.set(1.2, 0.8, 0.8);
  const patches = makeDamagePatches(rig, [[-1.2, 2.2, 5.3, 4.2, 1.5], [-2.1, -2.6, 5, 3.8, 1.6]]);

  return finalizeEnemyModel(rig, (pose) => {
    const damage = 1 - pose.hp;
    rig.frame.position.set(0, 0, 2.5 + Math.sin(pose.time * 3.5) * 0.45);
    rig.body.rotation.z = pose.heading;
    rig.aim.rotation.z = pose.aim;
    turret.position.x = 1.2 - pulse(pose.time, 10.5, 0, 0.3);
    setGlow(eyeGlow, 0.9 + pulse(pose.time, 8, 0, 0.18), 0);
    setGlow(thrusterGlow, 0.8 + pose.speed * 0.85 + pulse(pose.time, 14, 0.1, 0.32), 0);
    setGlow(muzzleGlow, 0.82 + pulse(pose.time, 11.5, 0, 0.32), 0);
    setDamage(patches, damage * 0.45, pose.time * 10);
  });
}

function createLancerModel(): EnemyModel {
  const rig = new ModelRig(ENEMY_RADII[EnemyType.Lancer]);
  const hullMat = rig.toon({ color: 0x312b42, shade: 0x100d19, light: 0x675b84, rim: 0xffc26a, lines: 0.08, lineColor: 0xffaa42 });
  const wingMat = rig.toon({ color: 0x221d31, shade: 0x09070f, light: 0x54486c, rim: 0xff8a5d });
  const lanceMat = rig.toon({ color: 0x494159, shade: 0x17131f, light: 0x897e9b, rim: 0xffd184 });
  const visorGlow = rig.glow(0xffa53d, 1.8, 0.15, 0.25);
  const tipGlow = rig.glow(0xffcf68, 2.4, 0.32, 0.5);
  const ventGlow = rig.glow(0xff7a54, 1.7, 0.18, 0.4);

  const fuselage = rig.mesh(profileGeometry([[-8.5, -2.8], [-3.2, 3.2], [5.8, 2.1], [12.2, 0], [5.8, -2.1], [-3.2, -3.2]], 3.6, 0.8), hullMat);
  fuselage.position.z = 2.5;
  const dorsal = rig.mesh(profileGeometry([[-3.2, -1.2], [0.4, 1.5], [4.6, 1], [6.2, 0], [4.6, -1], [0.4, -1.5]], 2.2, 0.4), lanceMat);
  dorsal.position.set(0.6, 0, 4.3);
  const wingL = rig.mesh(profileGeometry([[-3.8, -0.8], [0.8, 1], [7.6, 0], [0.8, -1]], 1.4, 0.4), wingMat);
  wingL.position.set(-1.5, 5.2, 2.1);
  const wingR = rig.mesh(profileGeometry([[-3.8, -0.8], [0.8, 1], [7.6, 0], [0.8, -1]], 1.4, 0.4), wingMat);
  wingR.position.set(-1.5, -5.2, 2.1);
  const lance = new THREE.Group();
  const shaft = rig.mesh(new THREE.BoxGeometry(9.6, 1.1, 1.1), lanceMat, lance);
  shaft.position.x = 8.6;
  const blade = rig.mesh(profileGeometry([[-0.8, -1.1], [1.4, 1.3], [4.8, 0], [1.4, -1.3]], 1.2, 0.2), lanceMat, lance);
  blade.position.set(14.2, 0, 0);
  const tip = rig.mesh(new THREE.SphereGeometry(1.15, 8, 6), tipGlow.mat, lance);
  tip.position.set(15.6, 0, 0.2);
  rig.add(lance);
  const visor = rig.mesh(new THREE.SphereGeometry(1.1, 8, 6), visorGlow.mat);
  visor.position.set(2.7, 0, 4.7);
  const ventL = rig.mesh(new THREE.SphereGeometry(0.9, 8, 6), ventGlow.mat);
  ventL.position.set(-5.8, 1.5, 1);
  const ventR = rig.mesh(new THREE.SphereGeometry(0.9, 8, 6), ventGlow.mat);
  ventR.position.set(-5.8, -1.5, 1);
  const patches = makeDamagePatches(rig, [[-0.5, 2.2, 4.8, 4.1, 1.2], [-1.8, -2.1, 4.5, 3.8, 1.1]]);

  return finalizeEnemyModel(rig, (pose) => {
    const damage = 1 - pose.hp;
    const charge = smooth(pose.telegraph);
    rig.frame.position.set(0, 0, 2 + Math.sin(pose.time * 4) * 0.38);
    rig.body.rotation.z = pose.heading;
    rig.body.position.x = -charge * 2.8;
    wingL.rotation.z = 0.18 + charge * 0.5;
    wingR.rotation.z = -(0.18 + charge * 0.5);
    lance.position.x = charge * 1.2 + pose.speed * 0.6;
    lance.position.z = charge * 0.2;
    blade.scale.set(1 + charge * 0.1, 1 + charge * 0.08, 1);
    setGlow(visorGlow, 0.72 + charge * 0.7 + pulse(pose.time, 8.5, 0, 0.12), 0);
    setGlow(tipGlow, 0.9 + charge * 2.5 + pose.speed * 0.6, charge * 0.15);
    setGlow(ventGlow, 0.72 + charge * 1.4 + pulse(pose.time, 15, 0, 0.25), 0);
    setDamage(patches, damage * 0.45, pose.time * 12);
  });
}

function createSpinnerModel(): EnemyModel {
  const rig = new ModelRig(ENEMY_RADII[EnemyType.Spinner]);
  const baseMat = rig.toon({ color: FACTION_ARMOR, shade: FACTION_SHADE, light: FACTION_LIGHT, rim: 0xe085ff, lines: 0.16, lineColor: FACTION_LINES });
  const trimMat = rig.toon({ color: FACTION_PLATE, shade: 0x100c18, light: 0x56486e, rim: 0xff679f });
  const armMat = rig.toon({ color: 0x4b435f, shade: 0x171320, light: 0x7f7396, rim: 0xff94c4, lines: 0.12, lineColor: FACTION_RED });
  const eyeGlow = rig.glow(FACTION_GLOW, 2.2, 0.18, 0.35);
  const muzzleGlow = rig.glow(FACTION_RED, 1.9, 0.2, 0.4);
  const thrusterGlow = rig.glow(FACTION_GLOW, 1.4, 0.15, 0.4);

  const disc = rig.mesh(new THREE.CylinderGeometry(8.2, 9.2, 3.8, 12), baseMat);
  disc.position.z = 1.4;
  const rim = rig.mesh(gearGeometry(10.2, 12, 1.5, 5.8, 1.8), trimMat);
  rim.position.z = 3.8;
  const hub = rig.mesh(new THREE.CylinderGeometry(3.5, 4.2, 2.8, 8), armMat);
  hub.position.z = 5.4;
  const rotor = new THREE.Group();
  rotor.position.z = 6.8;
  for (let i = 0; i < 3; i++) {
    const armRoot = new THREE.Group();
    armRoot.rotation.z = (i * TAU) / 3;
    const arm = rig.mesh(new THREE.BoxGeometry(7.6, 1.8, 1.4), armMat, armRoot);
    arm.position.x = 4.6;
    const barrel = rig.mesh(new THREE.BoxGeometry(3.6, 1, 1), armMat, armRoot);
    barrel.position.set(9.6, 0, 0.2);
    const muzzle = rig.mesh(new THREE.SphereGeometry(0.95, 7, 5), muzzleGlow.mat, armRoot);
    muzzle.position.set(11.2, 0, 0.2);
    rig.add(armRoot, rotor);
  }
  rig.add(rotor);
  const core = rig.mesh(new THREE.SphereGeometry(2, 8, 6), eyeGlow.mat, rig.aim);
  core.position.set(0, 0, 7.7);
  const thrusters: THREE.Mesh[] = [];
  for (let i = 0; i < 3; i++) {
    const a = (i * TAU) / 3 + Math.PI / 3;
    const thruster = rig.mesh(new THREE.SphereGeometry(1.1, 7, 5), thrusterGlow.mat);
    thruster.position.set(Math.cos(a) * 5.8, Math.sin(a) * 5.8, 0.3);
    thruster.scale.set(1.15, 1.15, 0.8);
    thrusters.push(thruster);
  }
  const patches = makeDamagePatches(rig, [[1.2, 2.8, 6.4, 4.8, 1.3], [-1.6, -2.6, 6.2, 4.4, 1.3]]);

  return finalizeEnemyModel(rig, (pose) => {
    const damage = 1 - pose.hp;
    rig.frame.position.set(0, 0, 2.4 + Math.sin(pose.time * 3.4) * 0.44);
    rig.body.rotation.z = pose.heading * 0.2;
    rig.aim.rotation.z = pose.aim;
    rotor.rotation.z = pose.time * (TAU / 1.5);
    hub.rotation.z = -pose.time * 0.8;
    core.scale.setScalar(0.96 + pulse(pose.time, 11, 0, 0.18));
    setGlow(eyeGlow, 0.88 + pulse(pose.time, 8.5, 0.1, 0.26), 0);
    setGlow(muzzleGlow, 0.78 + pulse(pose.time, 14, 0, 0.4), 0);
    setGlow(thrusterGlow, 0.7 + pose.speed * 0.65 + pulse(pose.time, 15.5, 0, 0.24), 0);
    for (let i = 0; i < thrusters.length; i++) thrusters[i].scale.z = 0.65 + pose.speed * 0.35 + Math.sin(pose.time * 10 + i * 1.6) * 0.08;
    setDamage(patches, damage * 0.5, pose.time * 10);
  });
}

function createBomberModel(): EnemyModel {
  const rig = new ModelRig(ENEMY_RADII[EnemyType.Bomber]);
  const hullMat = rig.toon({ color: 0x332c44, shade: 0x110e19, light: 0x6a5f86, rim: 0xff9f58, lines: 0.12, lineColor: 0xff8a48 });
  const deckMat = rig.toon({ color: 0x272133, shade: 0x0c0910, light: 0x564a6c, rim: 0xffcb78 });
  const gunMat = rig.toon({ color: 0x4a4358, shade: 0x17131f, light: 0x857b98, rim: 0xffc08d });
  const portMat = rig.toon({ color: 0x341f28, shade: 0x0b060c, light: 0x6d4352, rim: 0xffa356, emissive: 0x261106, emissiveAmt: 1.1 });
  const noseGlow = rig.glow(0xff8750, 2.3, 0.28, 0.45);
  const portGlow = rig.glow(0xffc05a, 1.7, 0.22, 0.35);
  const ventGlow = rig.glow(0xb86cff, 1.6, 0.18, 0.35);

  const hull = rig.mesh(new THREE.BoxGeometry(20, 15.2, 5.2), hullMat);
  hull.position.z = 2.8;
  const prow = rig.mesh(profileGeometry([[-3.2, -4.6], [1.8, 4.9], [6.8, 4.2], [10.4, 0], [6.8, -4.2], [1.8, -4.9]], 3.2, 0.8), deckMat);
  prow.position.set(6.2, 0, 5.6);
  const bridge = rig.mesh(new THREE.BoxGeometry(8.4, 7.6, 3.4), deckMat);
  bridge.position.set(-1.8, 0, 6.8);
  const skirtL = rig.mesh(new THREE.BoxGeometry(14.6, 3.4, 3.2), gunMat);
  skirtL.position.set(-1.8, 8.4, 2.8);
  const skirtR = rig.mesh(new THREE.BoxGeometry(14.6, 3.4, 3.2), gunMat);
  skirtR.position.set(-1.8, -8.4, 2.8);
  const cannon = new THREE.Group();
  cannon.position.set(7.6, 0, 7.5);
  const cradle = rig.mesh(new THREE.BoxGeometry(5.2, 3.2, 2.2), gunMat, cannon);
  cradle.position.x = 1.6;
  const barrel = rig.mesh(new THREE.BoxGeometry(5.8, 2.2, 1.8), gunMat, cannon);
  barrel.position.x = 5.8;
  const muzzle = rig.mesh(new THREE.SphereGeometry(1.3, 8, 6), noseGlow.mat, cannon);
  muzzle.position.set(8.9, 0, 0);
  rig.add(cannon, rig.aim);
  const eye = rig.mesh(new THREE.SphereGeometry(1.35, 8, 6), portGlow.mat);
  eye.position.set(6.4, 0, 6.8);
  eye.scale.set(1.2, 0.8, 0.8);
  const ports: THREE.Mesh[] = [];
  for (const [x, y] of [[2, 9.8], [7.5, 8.8], [2, -9.8], [7.5, -8.8], [-5.4, 8.2], [-5.4, -8.2]] as const) {
    const port = rig.mesh(new THREE.CylinderGeometry(1.15, 1.5, 2.6, 6), portMat);
    port.position.set(x, y, 5.5);
    port.rotation.z = y > 0 ? 0.2 : -0.2;
    ports.push(port);
    const core = rig.mesh(new THREE.SphereGeometry(0.7, 6, 4), portGlow.mat);
    core.position.set(x + 0.4, y, 5.8);
  }
  const ventL = rig.mesh(new THREE.SphereGeometry(1.45, 8, 6), ventGlow.mat);
  ventL.position.set(-8.6, 4.6, 1);
  ventL.scale.set(1.4, 1.1, 0.7);
  const ventR = rig.mesh(new THREE.SphereGeometry(1.45, 8, 6), ventGlow.mat);
  ventR.position.set(-8.6, -4.6, 1);
  ventR.scale.set(1.4, 1.1, 0.7);
  const patches = makeDamagePatches(rig, [[-3.2, 5.4, 6.2, 6.2, 1.8], [-1.4, -5.7, 6, 5.8, 1.8], [4.5, 0, 8.4, 4.6, 1.4]]);

  return finalizeEnemyModel(rig, (pose) => {
    const damage = 1 - pose.hp;
    rig.frame.position.set(0, 0, 2.2 + Math.sin(pose.time * 2.2) * 0.34);
    rig.body.rotation.z = pose.heading;
    rig.aim.rotation.z = pose.aim;
    cannon.position.x = 7.3 - pulse(pose.time, 7.5, 0, 0.25);
    setGlow(noseGlow, 0.92 + pulse(pose.time, 8, 0.05, 0.35), 0);
    setGlow(portGlow, 0.8 + pulse(pose.time, 10.5, 0, 0.22), 0);
    setGlow(ventGlow, 0.82 + pose.speed * 0.75 + pulse(pose.time, 12.5, 0.1, 0.28), 0);
    for (let i = 0; i < ports.length; i++) ports[i].rotation.y = Math.sin(pose.time * 3 + i) * 0.08;
    setDamage(patches, damage * 0.55, pose.time * 9);
  });
}

function createBulwarkModel(): EnemyModel {
  const rig = new ModelRig(ENEMY_RADII[EnemyType.Bulwark]);
  const hullMat = rig.toon({ color: 0x3a334a, shade: 0x14111d, light: 0x6d6287, rim: 0xffb34e, lines: 0.05, lineColor: BULWARK_GLOW });
  const plateMat = rig.toon({ color: 0x2a2337, shade: 0x0b0910, light: 0x57496f, rim: 0xffcf7f });
  const armMat = rig.toon({ color: 0x4c445d, shade: 0x191520, light: 0x867b9a, rim: 0xffba66 });
  const coreGlow = rig.glow(BULWARK_GLOW, 2.8, 0.25, 0.5);
  const sensorGlow = rig.glow(0xffd674, 2.1, 0.22, 0.3);
  const ventGlow = rig.glow(BULWARK_GLOW, 1.9, 0.15, 0.45);
  const muzzleGlow = rig.glow(BULWARK_GLOW, 2.1, 0.3, 0.5);
  const shield = makeShield(rig, 36, BULWARK_GLOW);

  const base = rig.mesh(new THREE.BoxGeometry(28, 25, 7.5), hullMat);
  base.position.z = 3.8;
  const chest = rig.mesh(new THREE.BoxGeometry(20, 18, 6.5), plateMat);
  chest.position.set(-2.2, 0, 10.6);
  const upper = rig.mesh(new THREE.BoxGeometry(14, 12, 4.2), plateMat);
  upper.position.set(-1.2, 0, 15.6);
  const head = new THREE.Group();
  rig.mesh(new THREE.BoxGeometry(6.4, 5.2, 3.4), armMat, head).position.x = 1.4;
  const brow = rig.mesh(profileGeometry([[-1.6, -2.1], [0.4, 2.4], [3.6, 1.7], [4.7, 0], [3.6, -1.7], [0.4, -2.4]], 1.8, 0.3), plateMat, head);
  brow.position.set(4.2, 0, 1.8);
  const eye = rig.mesh(new THREE.SphereGeometry(1.4, 8, 6), sensorGlow.mat, head);
  eye.position.set(5.4, 0, 1.6);
  eye.scale.set(1.3, 0.75, 0.8);
  head.position.set(10.5, 0, 16.5);
  rig.add(head, rig.aim);

  const coreWell = rig.mesh(new THREE.CylinderGeometry(5.6, 7.4, 3.5, 8), rig.toon({ color: 0x1b121f, shade: 0x050306, light: 0x412838, rim: BULWARK_GLOW }));
  coreWell.position.set(-0.8, 0, 15);
  const core = rig.mesh(new THREE.SphereGeometry(4.8, 10, 8), coreGlow.mat);
  core.position.set(-0.4, 0, 16.1);

  const frontPlate = new THREE.Group();
  rig.mesh(new THREE.BoxGeometry(8.4, 14.2, 2.8), plateMat, frontPlate).rotation.z = 0.02;
  frontPlate.position.set(4.8, 0, 15.4);
  const leftPlate = new THREE.Group();
  rig.mesh(new THREE.BoxGeometry(11.6, 6.2, 2.8), plateMat, leftPlate).rotation.z = 0.08;
  leftPlate.position.set(-0.8, 8.8, 15.2);
  const rightPlate = new THREE.Group();
  rig.mesh(new THREE.BoxGeometry(11.6, 6.2, 2.8), plateMat, rightPlate).rotation.z = -0.08;
  rightPlate.position.set(-0.8, -8.8, 15.2);
  rig.add(frontPlate);
  rig.add(leftPlate);
  rig.add(rightPlate);

  const treadL = rig.mesh(new THREE.BoxGeometry(17.5, 5.4, 4.6), hullMat);
  treadL.position.set(-5.2, 15.2, 3.2);
  const treadR = rig.mesh(new THREE.BoxGeometry(17.5, 5.4, 4.6), hullMat);
  treadR.position.set(-5.2, -15.2, 3.2);
  const footL = rig.mesh(new THREE.BoxGeometry(8.4, 4.6, 2.8), armMat);
  footL.position.set(8.2, 13.4, 1.6);
  const footR = rig.mesh(new THREE.BoxGeometry(8.4, 4.6, 2.8), armMat);
  footR.position.set(8.2, -13.4, 1.6);

  const leftArm = new THREE.Group();
  rig.mesh(new THREE.BoxGeometry(7.4, 6.2, 4.2), armMat, leftArm).position.x = 1.8;
  const leftBarrel = rig.mesh(new THREE.BoxGeometry(11.4, 2.3, 2.3), armMat, leftArm);
  leftBarrel.position.x = 8.4;
  rig.mesh(new THREE.SphereGeometry(1.4, 8, 6), muzzleGlow.mat, leftArm).position.set(14.2, 0, 0);
  leftArm.position.set(6.4, 16.5, 12.4);
  const rightArm = new THREE.Group();
  rig.mesh(new THREE.BoxGeometry(7.4, 6.2, 4.2), armMat, rightArm).position.x = 1.8;
  const rightBarrel = rig.mesh(new THREE.BoxGeometry(11.4, 2.3, 2.3), armMat, rightArm);
  rightBarrel.position.x = 8.4;
  rig.mesh(new THREE.SphereGeometry(1.4, 8, 6), muzzleGlow.mat, rightArm).position.set(14.2, 0, 0);
  rightArm.position.set(6.4, -16.5, 12.4);
  rig.add(leftArm, rig.aim);
  rig.add(rightArm, rig.aim);

  const vents = [
    rig.mesh(new THREE.SphereGeometry(1.2, 8, 6), ventGlow.mat),
    rig.mesh(new THREE.SphereGeometry(1.2, 8, 6), ventGlow.mat),
    rig.mesh(new THREE.SphereGeometry(1.2, 8, 6), ventGlow.mat),
    rig.mesh(new THREE.SphereGeometry(1.2, 8, 6), ventGlow.mat),
  ];
  [[-8, 10], [-8, -10], [9, 7], [9, -7]].forEach(([x, y], i) => vents[i].position.set(x, y, 11.5));
  const patches = makeDamagePatches(rig, [[-3.6, 10.2, 16.3, 7.4, 2], [-3.6, -10.2, 16.3, 7.4, 2], [6.2, 0, 17.2, 4.6, 2.6]]);

  return finalizeEnemyModel(rig, (pose) => {
    const damage = 1 - pose.hp;
    const phaseOpen = [0.08, 0.52, 1][pose.phase] ?? 1;
    const telegraph = smooth(pose.telegraph);
    const dying = clamp01(pose.dying);
    const explode = dying * dying * 13;
    rig.root.position.set(Math.sin(pose.time * 38) * dying * 1.2, Math.cos(pose.time * 31) * dying * 1.2, 0);
    rig.root.scale.setScalar(1 - dying * dying * 0.3);
    rig.frame.position.set(0, 0, 3 + Math.sin(pose.time * 1.8) * 0.45);
    rig.body.rotation.z = pose.heading;
    rig.aim.rotation.z = pose.aim;

    frontPlate.position.set(4.8 + phaseOpen * 4 + explode * 0.8, 0, 15.4 + phaseOpen * 1.4);
    leftPlate.position.set(-0.8 - phaseOpen * 0.4 - explode * 0.2, 8.8 + phaseOpen * 6.2 + explode * 0.8, 15.2 + phaseOpen * 0.9);
    rightPlate.position.set(-0.8 - phaseOpen * 0.4 - explode * 0.2, -8.8 - phaseOpen * 6.2 - explode * 0.8, 15.2 + phaseOpen * 0.9);
    leftPlate.rotation.z = 0.08 + phaseOpen * 0.42 + explode * 0.04;
    rightPlate.rotation.z = -(0.08 + phaseOpen * 0.42 + explode * 0.04);
    core.scale.setScalar(0.82 + phaseOpen * 0.4 + telegraph * 0.08 + pulse(pose.time, 5.5, 0, 0.1));
    head.position.set(10.5 + telegraph * 0.7 + explode * 0.6, 0, 16.5 + telegraph * 0.3);
    leftArm.position.set(6.4 + telegraph * 1.4 + explode * 0.6, 16.5 + telegraph * 1.6 + explode * 0.7, 12.4 + phaseOpen * 1.4);
    rightArm.position.set(6.4 + telegraph * 1.4 + explode * 0.6, -16.5 - telegraph * 1.6 - explode * 0.7, 12.4 + phaseOpen * 1.4);
    leftArm.rotation.z = 0.16 + telegraph * 0.22;
    rightArm.rotation.z = -(0.16 + telegraph * 0.22);
    leftBarrel.position.x = 8.4 - telegraph * 1.2;
    rightBarrel.position.x = 8.4 - telegraph * 1.2;
    treadL.position.y = 15.2 + explode * 0.4;
    treadR.position.y = -15.2 - explode * 0.4;
    footL.position.x = 8.2 + explode * 0.5;
    footR.position.x = 8.2 + explode * 0.5;
    eye.scale.set(1.3 + telegraph * 0.1, 0.75, 0.8);

    shield.ring.visible = pose.invulnerable;
    shield.disc.visible = pose.invulnerable;
    shield.ring.rotation.z = pose.time * 0.8;
    shield.disc.rotation.z = -pose.time * 0.55;
    shield.ring.scale.setScalar(1 + pulse(pose.time, 7.5, 0.02, 0.08));
    shield.disc.scale.setScalar(1 + pulse(pose.time, 5.5, 0.02, 0.05));
    setGlow(coreGlow, 0.95 + phaseOpen * 1.3 + telegraph * 1.4 + dying * 2.1, dying * 0.8);
    setGlow(sensorGlow, 0.82 + telegraph * 0.9 + pulse(pose.time, 9, 0, 0.2), dying * 0.4);
    setGlow(ventGlow, 0.76 + phaseOpen * 0.6 + telegraph * 0.9 + pulse(pose.time, 10, 0, 0.3), dying * 0.45);
    setGlow(muzzleGlow, 0.82 + telegraph * 1.8 + phaseOpen * 0.35, dying * 0.55);
    setGlow(shield.glow, pose.invulnerable ? 0.95 + pulse(pose.time, 9, 0, 0.3) : 0, 0.2 + dying * 0.6);
    for (let i = 0; i < vents.length; i++) vents[i].scale.setScalar(0.9 + Math.sin(pose.time * 8 + i * 1.7) * 0.08 + phaseOpen * 0.12);
    for (const toon of rig.toons) toon.uniforms.uDissolve.value = Math.max(0, dying - 0.72) / 0.28;
    setDamage(patches, damage * 0.7, pose.time * 12);
  });
}

function createSeraphModel(): EnemyModel {
  const rig = new ModelRig(ENEMY_RADII[EnemyType.Seraph]);
  const bodyMat = rig.toon({ color: FACTION_ARMOR, shade: FACTION_SHADE, light: 0x8b84a4, rim: SERAPH_GLOW, lines: 0.08, lineColor: SERAPH_GLOW });
  const bladeMat = rig.toon({ color: 0xdddff4, shade: 0x4c4967, light: 0xffffff, rim: SERAPH_GLOW, lines: 0.05, lineColor: SERAPH_GLOW });
  const trimMat = rig.toon({ color: 0x5d5875, shade: 0x1d1a29, light: 0x9894af, rim: 0xffffff });
  const coreGlow = rig.glow(SERAPH_GLOW, 2.3, 0.26, 0.45);
  const haloGlow = rig.glow(0xffffff, 1.4, 0.9, 0.6);
  const bladeGlow = rig.glow(SERAPH_GLOW, 1.7, 0.25, 0.4);
  const shield = makeShield(rig, 33, SERAPH_GLOW);

  const torso = rig.mesh(profileGeometry([[-9.5, -4.4], [-4.4, 5], [4.8, 3.6], [9.8, 0], [4.8, -3.6], [-4.4, -5]], 5, 1.2), bodyMat);
  torso.position.z = 3.6;
  const abdomen = rig.mesh(profileGeometry([[-6.6, -2.8], [-3, 3.2], [3.8, 2.3], [6.2, 0], [3.8, -2.3], [-3, -3.2]], 4, 1), trimMat);
  abdomen.position.set(-3.2, 0, 1.6);
  const helm = rig.mesh(profileGeometry([[-2.8, -1.6], [-0.8, 2.4], [3.4, 1.8], [5, 0], [3.4, -1.8], [-0.8, -2.4]], 3, 0.8), bladeMat, rig.aim);
  helm.position.set(6.3, 0, 7.1);
  const visor = rig.mesh(new THREE.SphereGeometry(1.25, 8, 6), coreGlow.mat, rig.aim);
  visor.position.set(8.4, 0, 7.5);
  const haloA = rig.mesh(new THREE.TorusGeometry(10.5, 1.4, 4, 26), haloGlow.mat);
  haloA.position.set(-1.5, 0, 13.4);
  haloA.rotation.x = 0.35;
  const haloB = rig.mesh(new THREE.TorusGeometry(15.8, 1.1, 4, 30), haloGlow.mat);
  haloB.position.set(-2.8, 0, 10.6);
  haloB.rotation.x = -0.25;

  const wingRoots: Array<{ group: THREE.Group; blade: THREE.Mesh; glow: THREE.Mesh; side: number; index: number }> = [];
  const wingXs = [-4.5, -0.5, 4.4] as const;
  const wingYs = [7.2, 10.1, 12.6] as const;
  for (let i = 0; i < wingXs.length; i++) {
    for (const side of [-1, 1] as const) {
      const group = new THREE.Group();
      group.position.set(wingXs[i], wingYs[i] * side, 6.4 + i * 0.8);
      const blade = rig.mesh(profileGeometry([[-2.2, -1], [2.5, 1.3], [14.2, 0], [2.5, -1.3]], 1.8, 0.5), bladeMat, group);
      blade.position.x = 5.4;
      const edge = rig.mesh(new THREE.SphereGeometry(1.05, 6, 4), bladeGlow.mat, group);
      edge.position.set(13.5, 0, 0.4);
      rig.add(group);
      wingRoots.push({ group, blade, glow: edge, side, index: i });
    }
  }

  const feathers: Array<{ group: THREE.Group; offset: number; dir: number }> = [];
  for (let i = 0; i < 4; i++) {
    const group = new THREE.Group();
    const blade = rig.mesh(profileGeometry([[-1.2, -0.6], [1.8, 0.9], [7, 0], [1.8, -0.9]], 1.2, 0.3), bladeMat, group);
    blade.position.x = 2.8;
    rig.add(group, rig.fx);
    feathers.push({ group, offset: (i / 4) * TAU, dir: i % 2 === 0 ? 1 : -1 });
  }
  const patches = makeDamagePatches(rig, [[-0.2, 2.3, 7.2, 3.4, 1.1], [-1.4, -2.2, 5.5, 3.8, 1.2]]);

  return finalizeEnemyModel(rig, (pose) => {
    const damage = 1 - pose.hp;
    const phaseFan = [0.26, 0.68, 1][pose.phase] ?? 1;
    const telegraph = smooth(pose.telegraph);
    const dying = clamp01(pose.dying);
    const explode = dying * dying * 14;
    rig.root.position.set(Math.sin(pose.time * 44) * dying * 1, Math.cos(pose.time * 36) * dying * 1, 0);
    rig.root.scale.setScalar(1 - dying * dying * 0.38);
    rig.frame.position.set(0, 0, 3.8 + Math.sin(pose.time * 2.8) * 0.6);
    rig.body.rotation.z = pose.heading;
    rig.aim.rotation.z = pose.aim;

    torso.scale.set(1, 1 - telegraph * 0.04, 1 + telegraph * 0.06);
    haloA.rotation.z = pose.time * 1.8;
    haloB.rotation.z = -pose.time * 2.5;
    haloB.visible = pose.phase >= 1 || dying > 0;
    haloB.scale.setScalar(pose.phase >= 1 ? 1 : Math.max(0, dying * 2));
    visor.scale.setScalar(0.9 + pulse(pose.time, 8.5, 0, 0.18) + telegraph * 0.08);

    for (const wing of wingRoots) {
      const spread = (0.22 + wing.index * 0.16) + phaseFan * (0.24 + wing.index * 0.09) + telegraph * 0.08;
      wing.group.position.set(
        wing.index === 0 ? -4.5 - explode * 0.08 : wing.index === 1 ? -0.5 : 4.4 + explode * 0.06,
        wing.side * (wingYs[wing.index] + phaseFan * (2.4 + wing.index * 1.2) + explode * 0.6),
        6.4 + wing.index * 0.8 + telegraph * 0.4 + explode * 0.3,
      );
      wing.group.rotation.z = wing.side * spread + explode * wing.side * 0.04;
      wing.group.rotation.x = wing.side * 0.05 + telegraph * 0.06;
      wing.blade.scale.set(1 + telegraph * 0.08, 1, 1);
    }

    for (let i = 0; i < feathers.length; i++) {
      const feather = feathers[i];
      const orbit = 10 + phaseFan * 5 + i * 1.4 + explode * 0.4;
      const ang = pose.time * (0.75 + i * 0.08) * feather.dir + feather.offset;
      feather.group.position.set(Math.cos(ang) * orbit, Math.sin(ang) * (orbit * 0.55), 8 + Math.sin(ang * 2) * 1.2 + i + explode * 0.3);
      feather.group.rotation.z = ang + feather.dir * 0.9;
      feather.group.rotation.x = Math.sin(ang * 1.6) * 0.15;
    }

    shield.ring.visible = pose.invulnerable;
    shield.disc.visible = pose.invulnerable;
    shield.ring.rotation.z = pose.time * 1.2;
    shield.disc.rotation.z = -pose.time * 0.9;
    shield.ring.scale.setScalar(1 + pulse(pose.time, 10, 0.02, 0.06));
    shield.disc.scale.setScalar(1 + pulse(pose.time, 7.5, 0.02, 0.05));

    setGlow(coreGlow, 0.92 + telegraph * 1.2 + phaseFan * 0.7 + dying * 2.1, dying * 0.75);
    setGlow(haloGlow, 0.72 + phaseFan * 0.55 + telegraph * 0.95, dying * 0.55);
    setGlow(bladeGlow, 0.78 + phaseFan * 0.4 + telegraph * 1.2, dying * 0.45);
    setGlow(shield.glow, pose.invulnerable ? 0.9 + pulse(pose.time, 10.5, 0, 0.22) : 0, 0.3 + dying * 0.5);
    for (const toon of rig.toons) toon.uniforms.uDissolve.value = Math.max(0, dying - 0.74) / 0.26;
    setDamage(patches, damage * 0.55, pose.time * 11);
  });
}

function createOverlordModel(): EnemyModel {
  const rig = new ModelRig(ENEMY_RADII[EnemyType.Overlord]);
  const throneMat = rig.toon({ color: 0x392746, shade: 0x120914, light: 0x72588b, rim: OVERLORD_GOLD, lines: 0.08, lineColor: OVERLORD_VIOLET });
  const plateMat = rig.toon({ color: 0x24192f, shade: 0x08050d, light: 0x55386c, rim: OVERLORD_GLOW });
  const goldMat = rig.toon({ color: OVERLORD_GOLD, shade: 0x5a3112, light: 0xffe6aa, rim: 0xffffff });
  const armMat = rig.toon({ color: 0x4f3759, shade: 0x170d19, light: 0xa17bb3, rim: OVERLORD_VIOLET, lines: 0.07, lineColor: OVERLORD_GLOW });
  const coreGlow = rig.glow(OVERLORD_GLOW, 2.7, 0.3, 0.55);
  const eyeGlow = rig.glow(OVERLORD_VIOLET, 2, 0.22, 0.3);
  const ringGlow = rig.glow(OVERLORD_VIOLET, 1.8, 0.95, 0.45);
  const muzzleGlow = rig.glow(OVERLORD_GLOW, 2.1, 0.3, 0.45);
  const goldGlow = rig.glow(OVERLORD_GOLD, 1.25, 0.3, 0.35);
  const shield = makeShield(rig, 40, OVERLORD_VIOLET);

  const dais = rig.mesh(new THREE.BoxGeometry(30, 26, 7.4), throneMat);
  dais.position.z = 3.8;
  const throne = rig.mesh(new THREE.BoxGeometry(18, 17, 7.4), plateMat);
  throne.position.set(-3.2, 0, 11.6);
  const backrest = rig.mesh(new THREE.BoxGeometry(10.4, 22, 12), throneMat);
  backrest.position.set(-13.8, 0, 20.4);
  const sideGuardL = rig.mesh(new THREE.BoxGeometry(10.5, 4.2, 6), plateMat);
  sideGuardL.position.set(1.5, 12.2, 10.8);
  const sideGuardR = rig.mesh(new THREE.BoxGeometry(10.5, 4.2, 6), plateMat);
  sideGuardR.position.set(1.5, -12.2, 10.8);
  const head = new THREE.Group();
  rig.mesh(new THREE.BoxGeometry(6.2, 5, 3.2), armMat, head).position.x = 1.2;
  const brow = rig.mesh(profileGeometry([[-1.8, -2], [0.4, 2.2], [4, 1.6], [5.1, 0], [4, -1.6], [0.4, -2.2]], 1.6, 0.3), goldMat, head);
  brow.position.set(4.1, 0, 1.8);
  const eye = rig.mesh(new THREE.SphereGeometry(1.25, 8, 6), eyeGlow.mat, head);
  eye.position.set(5.2, 0, 1.4);
  eye.scale.set(1.3, 0.78, 0.8);
  head.position.set(10.6, 0, 18.8);
  rig.add(head, rig.aim);

  const crest = new THREE.Group();
  for (const [x, y, rot, sx] of [[0, 0, 0, 1], [-2.3, 4.6, 0.45, 0.9], [-2.3, -4.6, -0.45, 0.9], [-4.1, 0, 0, 0.75]] as const) {
    const prong = rig.mesh(profileGeometry([[-1.1, -1.1], [0.4, 1.2], [5.8, 0], [0.4, -1.2]], 1.5, 0.2), goldMat, crest);
    prong.position.set(x, y, 0);
    prong.rotation.z = rot;
    prong.scale.set(sx, sx, 1);
  }
  crest.position.set(13.8, 0, 22.8);
  rig.add(crest);
  const coreWell = rig.mesh(new THREE.CylinderGeometry(6.6, 8.4, 3.4, 8), rig.toon({ color: 0x170d19, shade: 0x040205, light: 0x40233f, rim: OVERLORD_GOLD }));
  coreWell.position.set(2.2, 0, 16.4);
  const core = rig.mesh(new THREE.SphereGeometry(5.8, 10, 8), coreGlow.mat);
  core.position.set(2.6, 0, 17.5);

  const rings = [
    rig.mesh(new THREE.TorusGeometry(14, 1.1, 4, 26), ringGlow.mat, rig.fx),
    rig.mesh(new THREE.TorusGeometry(20, 1.2, 4, 32), ringGlow.mat, rig.fx),
    rig.mesh(new THREE.TorusGeometry(27, 1.35, 4, 38), goldGlow.mat, rig.fx),
  ];
  rings[0].position.z = 16.8;
  rings[0].rotation.x = 0.48;
  rings[1].position.z = 14.6;
  rings[1].rotation.x = -0.62;
  rings[2].position.z = 18.2;
  rings[2].rotation.y = 0.55;

  const armSets: Array<{ group: THREE.Group; phase: number; side: number; y0: number; z0: number; extend: number; barrel: THREE.Mesh }> = [];
  for (const [phase, y0, z0, extend] of [[0, 15, 14, 14], [1, 0, 12.8, 17], [2, 23, 17, 12]] as const) {
    for (const side of [-1, 1] as const) {
      const group = new THREE.Group();
      rig.mesh(new THREE.BoxGeometry(6.8, 4.8, 3.2), armMat, group).position.x = 1.4;
      rig.mesh(new THREE.BoxGeometry(6.2, 2.1, 1.8), armMat, group).position.x = 6.8;
      const barrel = rig.mesh(new THREE.BoxGeometry(6.2, 1.5, 1.5), armMat, group);
      barrel.position.x = 11.2;
      rig.mesh(new THREE.SphereGeometry(1.05, 8, 6), muzzleGlow.mat, group).position.set(14.3, 0, 0.1);
      rig.add(group, rig.aim);
      armSets.push({ group, phase, side, y0, z0, extend, barrel });
    }
  }

  const floatBits: Array<{ obj: THREE.Object3D; offset: number; radius: number; lift: number }> = [];
  for (let i = 0; i < 4; i++) {
    const bit = new THREE.Group();
    const shard = rig.mesh(profileGeometry([[-1.4, -0.8], [1.6, 1], [6.4, 0], [1.6, -1]], 1.6, 0.4), goldMat, bit);
    shard.position.x = 2.8;
    rig.add(bit, rig.fx);
    floatBits.push({ obj: bit, offset: (i / 4) * TAU, radius: 17 + i * 2.6, lift: 14 + i * 1.2 });
  }
  const patches = makeDamagePatches(rig, [[-7, 8.2, 18.8, 6.2, 2], [-7, -8.2, 18.8, 6.2, 2], [6.2, 0, 19.4, 4.8, 2.8]]);

  return finalizeEnemyModel(rig, (pose) => {
    const damage = 1 - pose.hp;
    const phaseAmt = [0.28, 0.7, 1][pose.phase] ?? 1;
    const telegraph = smooth(pose.telegraph);
    const dying = clamp01(pose.dying);
    const explode = dying * dying * 15;
    rig.root.position.set(Math.sin(pose.time * 40) * dying * 1.3, Math.cos(pose.time * 34) * dying * 1.3, 0);
    rig.root.scale.setScalar(1 - dying * dying * 0.38);
    rig.frame.position.set(0, 0, 3.4 + Math.sin(pose.time * 2) * 0.55);
    rig.body.rotation.z = pose.heading;
    rig.aim.rotation.z = pose.aim;

    backrest.position.set(-13.8 - explode * 0.5, 0, 20.4 + explode * 0.3);
    throne.position.x = -3.2 - telegraph * 0.7;
    crest.position.set(13.8 + phaseAmt * 2.2 + explode * 0.7, 0, 22.8 + telegraph * 0.5);
    crest.rotation.z = telegraph * 0.08;
    head.position.set(10.6 + telegraph * 0.9 + explode * 0.6, 0, 18.8 + telegraph * 0.4);
    eye.scale.set(1.3 + telegraph * 0.14, 0.78, 0.8);
    core.scale.setScalar(0.86 + phaseAmt * 0.34 + telegraph * 0.12 + pulse(pose.time, 5.8, 0, 0.12));

    rings[0].rotation.z = pose.time * 1.9;
    rings[1].rotation.z = -pose.time * 1.25;
    rings[2].rotation.z = pose.time * 1.05;
    rings[1].visible = pose.phase >= 1 || dying > 0;
    rings[2].visible = pose.phase >= 2 || dying > 0;
    rings[1].scale.setScalar(pose.phase >= 1 ? 1 : Math.max(0, dying * 2));
    rings[2].scale.setScalar(pose.phase >= 2 ? 1 : Math.max(0, dying * 2));

    for (const arm of armSets) {
      const deploy = pose.phase > arm.phase ? 1 : pose.phase === arm.phase ? 0.72 : 0.16;
      const show = deploy > 0.2 || dying > 0;
      arm.group.visible = show;
      if (!show) continue;
      arm.group.position.set(3 + deploy * arm.extend + telegraph * 0.6 + explode * 0.6, arm.side * (arm.y0 + deploy * 4.8 + explode * 0.8), arm.z0 + deploy * 1.8);
      arm.group.rotation.z = arm.side * (0.12 + deploy * 0.12 + explode * 0.03);
      arm.group.rotation.x = telegraph * 0.04;
      arm.barrel.position.x = 11.2 - telegraph * 0.9;
    }

    for (let i = 0; i < floatBits.length; i++) {
      const bit = floatBits[i];
      const orbit = bit.radius + phaseAmt * 8 + explode * 0.6;
      const ang = pose.time * (0.6 + i * 0.11) * (i % 2 === 0 ? 1 : -1) + bit.offset;
      bit.obj.position.set(Math.cos(ang) * orbit, Math.sin(ang) * orbit * 0.65, bit.lift + Math.sin(ang * 2) * 1.5 + explode * 0.4);
      bit.obj.rotation.z = ang + Math.PI / 2;
      bit.obj.rotation.x = Math.sin(ang * 1.7) * 0.18;
    }

    shield.ring.visible = pose.invulnerable;
    shield.disc.visible = pose.invulnerable;
    shield.ring.rotation.z = pose.time * 0.95;
    shield.disc.rotation.z = -pose.time * 0.7;
    shield.ring.scale.setScalar(1 + pulse(pose.time, 10.5, 0.02, 0.06));
    shield.disc.scale.setScalar(1 + pulse(pose.time, 8.5, 0.02, 0.04));

    setGlow(coreGlow, 0.98 + phaseAmt * 1.25 + telegraph * 1.35 + dying * 2.4, dying * 0.9);
    setGlow(eyeGlow, 0.78 + telegraph * 0.95 + phaseAmt * 0.4, dying * 0.45);
    setGlow(ringGlow, 0.82 + phaseAmt * 0.75 + telegraph * 0.7, dying * 0.45);
    setGlow(muzzleGlow, 0.84 + telegraph * 1.6 + phaseAmt * 0.5, dying * 0.55);
    setGlow(goldGlow, 0.72 + phaseAmt * 0.45 + telegraph * 0.35, dying * 0.35);
    setGlow(shield.glow, pose.invulnerable ? 0.95 + pulse(pose.time, 9.5, 0, 0.25) : 0, 0.28 + dying * 0.55);
    for (const toon of rig.toons) toon.uniforms.uDissolve.value = Math.max(0, dying - 0.72) / 0.28;
    setDamage(patches, damage * 0.68, pose.time * 13);
  });
}

export function createEnemyModel(type: number): EnemyModel {
  switch (type) {
    case EnemyType.Drone: return createDroneModel();
    case EnemyType.Gunner: return createGunnerModel();
    case EnemyType.Lancer: return createLancerModel();
    case EnemyType.Spinner: return createSpinnerModel();
    case EnemyType.Bomber: return createBomberModel();
    case EnemyType.Bulwark: return createBulwarkModel();
    case EnemyType.Seraph: return createSeraphModel();
    case EnemyType.Overlord: return createOverlordModel();
    default: return createDroneModel();
  }
}
