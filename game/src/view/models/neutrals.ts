import * as THREE from 'three';
import { NEUTRAL_COLORS } from '../../config.ts';
import { NEUTRAL_DEFS, NeutralType } from '../../sim/index.ts';
import type { NeutralModel, NeutralPose } from './types.ts';
import {
  ResourceTracker,
  createAccentMaterial,
  diamondGeometry,
  lineGeometry,
  polygonGeometry,
  pulse,
  ringGeometry,
  setFlash,
  to,
} from './kit-enemies.ts';
import type { VectorMaterial } from '../../render/vector.ts';

const DRONE_RADIUS = to(NEUTRAL_DEFS[NeutralType.Drone].rad);
const SENTINEL_RADIUS = to(NEUTRAL_DEFS[NeutralType.Sentinel].rad);
const WARDEN_RADIUS = to(NEUTRAL_DEFS[NeutralType.Warden].rad);

interface NeutralRig {
  readonly root: THREE.Group;
  readonly body: THREE.Group;
  readonly tracker: ResourceTracker;
  readonly materials: readonly VectorMaterial[];
}

function addVectorMesh(tracker: ResourceTracker, parent: THREE.Object3D, material: VectorMaterial, geometry: THREE.BufferGeometry, creaseDegrees: number): THREE.Mesh<THREE.BufferGeometry, VectorMaterial> {
  return tracker.mesh(geometry, material, creaseDegrees, parent) as THREE.Mesh<THREE.BufferGeometry, VectorMaterial>;
}

function createNeutralRig(): NeutralRig {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  return { root, body, tracker: new ResourceTracker(), materials: [] };
}

function createNeutralMaterialSet(tracker: ResourceTracker): { hull: VectorMaterial; accent: VectorMaterial; hot: VectorMaterial; list: readonly VectorMaterial[] } {
  const hull = tracker.ownMaterial(createAccentMaterial(tracker, NEUTRAL_COLORS.edge, 0x0a0f14, 0.3, 1.18, 1.15));
  const accent = tracker.ownMaterial(createAccentMaterial(tracker, NEUTRAL_COLORS.accent, 0x210607, 0.2, 2.0, 1.05));
  const hot = tracker.ownMaterial(createAccentMaterial(tracker, 0xffb0b0, 0x1d0808, 0.14, 2.25, 0.95));
  return { hull, accent, hot, list: [hull, accent, hot] };
}

function updateNeutralOpacity(materials: readonly VectorMaterial[], hp: number, telegraph: number): void {
  const hullOpacity = 0.48 + hp * 0.36;
  materials[0].uniforms.uOpacity.value = hullOpacity;
  materials[0].uniforms.uPulse.value = (1 - hp) * 0.06;
  materials[1].uniforms.uOpacity.value = 0.35 + telegraph * 0.28;
  materials[1].uniforms.uPulse.value = telegraph * 0.35;
  materials[2].uniforms.uOpacity.value = telegraph * 0.82;
  materials[2].uniforms.uPulse.value = telegraph * 0.55;
}

export function createDrone(): NeutralModel {
  const { root, body, tracker } = createNeutralRig();
  const { hull, accent, hot, list } = createNeutralMaterialSet(tracker);
  const shell = addVectorMesh(tracker, body, hull, polygonGeometry([
    [-DRONE_RADIUS * 0.6, -DRONE_RADIUS * 0.3],
    [DRONE_RADIUS * 0.2, -DRONE_RADIUS * 0.72],
    [DRONE_RADIUS * 0.92, 0],
    [DRONE_RADIUS * 0.2, DRONE_RADIUS * 0.72],
    [-DRONE_RADIUS * 0.6, DRONE_RADIUS * 0.3],
  ], 2.8), 28);
  shell.position.z = 2.2;
  const finL = addVectorMesh(tracker, body, hull, polygonGeometry([
    [-DRONE_RADIUS * 0.45, -0.8],
    [DRONE_RADIUS * 0.3, -0.4],
    [DRONE_RADIUS * 0.7, 0],
    [DRONE_RADIUS * 0.3, 0.4],
    [-DRONE_RADIUS * 0.45, 0.8],
  ], 1.1), 28);
  finL.position.set(-DRONE_RADIUS * 0.18, DRONE_RADIUS * 0.56, 2.6);
  finL.rotation.z = 0.18;
  const finR = addVectorMesh(tracker, body, hull, polygonGeometry([
    [-DRONE_RADIUS * 0.45, -0.8],
    [DRONE_RADIUS * 0.3, -0.4],
    [DRONE_RADIUS * 0.7, 0],
    [DRONE_RADIUS * 0.3, 0.4],
    [-DRONE_RADIUS * 0.45, 0.8],
  ], 1.1), 28);
  finR.position.set(-DRONE_RADIUS * 0.18, -DRONE_RADIUS * 0.56, 2.6);
  finR.rotation.z = -0.18;
  const eye = addVectorMesh(tracker, body, accent, ringGeometry(DRONE_RADIUS * 0.34, DRONE_RADIUS * 0.14, 0.6), 28);
  eye.position.set(DRONE_RADIUS * 0.5, 0, 3.4);
  eye.rotation.x = Math.PI * 0.5;
  const gunL = addVectorMesh(tracker, body, hot, lineGeometry(DRONE_RADIUS * 0.34, 0.7, 0.7), 28);
  gunL.position.set(DRONE_RADIUS * 0.1, DRONE_RADIUS * 0.34, 2.2);
  const gunR = addVectorMesh(tracker, body, hot, lineGeometry(DRONE_RADIUS * 0.34, 0.7, 0.7), 28);
  gunR.position.set(DRONE_RADIUS * 0.1, -DRONE_RADIUS * 0.34, 2.2);

  return {
    root,
    update(pose: NeutralPose): void {
      root.rotation.z = pose.heading;
      body.position.set(Math.sin(pose.time * 13) * 0.45, Math.cos(pose.time * 11.5) * 0.35, 1.4 + Math.sin(pose.time * 6.5) * 0.28);
      body.rotation.x = Math.sin(pose.time * 14) * 0.05;
      finL.rotation.z = 0.14 + Math.sin(pose.time * 16) * 0.08;
      finR.rotation.z = -0.14 - Math.sin(pose.time * 15) * 0.08;
      eye.scale.setScalar(1 + pose.telegraph * 0.25 + pulse(pose.time, 9, 0, 0.08));
      updateNeutralOpacity(list, pose.hp, pose.telegraph);
      setFlash(list, pose.flash);
    },
    dispose(): void {
      tracker.dispose();
    },
  };
}

export function createSentinel(): NeutralModel {
  const { root, body, tracker } = createNeutralRig();
  const { hull, accent, hot, list } = createNeutralMaterialSet(tracker);
  const ring = addVectorMesh(tracker, body, hull, ringGeometry(SENTINEL_RADIUS * 0.74, SENTINEL_RADIUS * 0.42, 1.6), 28);
  ring.position.z = 2.2;
  ring.rotation.x = Math.PI * 0.5;
  const core = addVectorMesh(tracker, body, accent, ringGeometry(SENTINEL_RADIUS * 0.24, SENTINEL_RADIUS * 0.08, 0.7), 28);
  core.position.z = 3.1;
  core.rotation.x = Math.PI * 0.5;
  const rotor = new THREE.Group();
  body.add(rotor);
  const armTips: THREE.Mesh[] = [];
  for (let i = 0; i < 3; i++) {
    const arm = new THREE.Group();
    arm.rotation.z = (i / 3) * Math.PI * 2;
    addVectorMesh(tracker, arm, hull, lineGeometry(SENTINEL_RADIUS * 0.72, 1.6, 1.2), 28).position.z = 2.8;
    const blade = addVectorMesh(tracker, arm, hull, polygonGeometry([
      [-1.2, -1.2],
      [SENTINEL_RADIUS * 0.22, -1.2],
      [SENTINEL_RADIUS * 0.42, 0],
      [SENTINEL_RADIUS * 0.22, 1.2],
      [-1.2, 1.2],
    ], 1.1), 28);
    blade.position.set(SENTINEL_RADIUS * 0.72, 0, 3.2);
    const tip = addVectorMesh(tracker, arm, hot, diamondGeometry(SENTINEL_RADIUS * 0.42, 1.6, 1.6), 28);
    tip.position.set(SENTINEL_RADIUS * 1.08, 0, 3.2);
    armTips.push(tip);
    rotor.add(arm);
  }

  return {
    root,
    update(pose: NeutralPose): void {
      root.rotation.z = pose.heading;
      body.position.z = 1.6 + Math.sin(pose.time * 4.4) * 0.36;
      rotor.rotation.z = pose.time * 0.28;
      ring.rotation.z = -pose.time * 0.45;
      core.scale.setScalar(1 + pose.telegraph * 0.18 + pulse(pose.time, 7, 0, 0.06));
      for (let i = 0; i < armTips.length; i++) armTips[i].scale.setScalar(1 + pose.telegraph * 0.35 + Math.sin(pose.time * 8 + i * 1.6) * 0.04);
      updateNeutralOpacity(list, pose.hp, pose.telegraph);
      setFlash(list, pose.flash);
    },
    dispose(): void {
      tracker.dispose();
    },
  };
}

export function createWarden(): NeutralModel {
  const { root, body, tracker } = createNeutralRig();
  const { hull, accent, hot, list } = createNeutralMaterialSet(tracker);
  const halo = addVectorMesh(tracker, body, hull, ringGeometry(WARDEN_RADIUS * 0.95, WARDEN_RADIUS * 0.56, 2.2), 28);
  halo.position.z = 2.6;
  halo.rotation.x = Math.PI * 0.5;
  const inner = addVectorMesh(tracker, body, hull, ringGeometry(WARDEN_RADIUS * 0.52, WARDEN_RADIUS * 0.38, 1.3), 28);
  inner.position.z = 4.2;
  inner.rotation.x = Math.PI * 0.5;
  const core = addVectorMesh(tracker, body, accent, diamondGeometry(WARDEN_RADIUS * 0.78, WARDEN_RADIUS * 0.52, WARDEN_RADIUS * 0.52), 28);
  core.position.z = 5.1;
  const orbitGroup = new THREE.Group();
  body.add(orbitGroup);
  const shards: THREE.Mesh[] = [];
  for (let i = 0; i < 4; i++) {
    const shard = addVectorMesh(tracker, orbitGroup, hull, polygonGeometry([
      [-2.4, -1.4],
      [2.8, -1.6],
      [6.2, 0],
      [2.8, 1.6],
      [-2.4, 1.4],
    ], 1.6), 28);
    shard.position.set(Math.cos((i / 4) * Math.PI * 2) * WARDEN_RADIUS * 0.82, Math.sin((i / 4) * Math.PI * 2) * WARDEN_RADIUS * 0.82, 4.6);
    shard.rotation.z = (i / 4) * Math.PI * 2;
    shards.push(shard);
  }
  const glare = addVectorMesh(tracker, body, hot, ringGeometry(WARDEN_RADIUS * 0.34, WARDEN_RADIUS * 0.1, 0.8), 28);
  glare.position.z = 5.5;
  glare.rotation.x = Math.PI * 0.5;

  return {
    root,
    update(pose: NeutralPose): void {
      root.rotation.z = pose.heading * 0.45;
      body.position.z = 2.2 + Math.sin(pose.time * 2.8) * 0.42;
      orbitGroup.rotation.z = -pose.time * 0.35;
      halo.scale.setScalar(1 + pose.telegraph * 0.12 + pulse(pose.time, 3.4, 0, 0.04));
      inner.rotation.z = pose.time * 0.7;
      core.scale.setScalar(1 + pose.telegraph * 0.22 + pulse(pose.time, 5.5, 0, 0.08));
      glare.scale.setScalar(1 + pose.telegraph * 0.4);
      for (let i = 0; i < shards.length; i++) {
        const ang = pose.time * 0.6 + i * (Math.PI * 0.5);
        shards[i].position.set(Math.cos(ang) * WARDEN_RADIUS * 0.82, Math.sin(ang) * WARDEN_RADIUS * 0.82, 4.6 + Math.sin(ang * 2) * 0.35);
        shards[i].rotation.z = ang + Math.PI * 0.5;
      }
      updateNeutralOpacity(list, pose.hp, pose.telegraph);
      list[0].uniforms.uPulse.value += pose.telegraph * 0.18;
      list[1].uniforms.uPulse.value += pose.telegraph * 0.18;
      setFlash(list, pose.flash);
    },
    dispose(): void {
      tracker.dispose();
    },
  };
}
