import * as THREE from 'three';
import { createVectorMaterial, vectorMesh } from '../../render/vector.ts';
import type { VectorMaterial } from '../../render/vector.ts';
import { FORMS, PartKind } from '../../sim/index.ts';
import type { ColossusModel, ColossusPose, NeutralModel, NeutralPose, RobotModel, RobotPose } from './types.ts';

/**
 * Plain stand-ins that already obey the model contract, so the views, the viewer and the tools work before the
 * designed models exist. The colossus stand-in is drawn straight from the simulation's part table.
 */
const to = (raw: number): number => raw / 65536;

export function placeholderRobot(radius: number): RobotModel {
  const root = new THREE.Group();
  const material = createVectorMaterial({ edge: 0x5fe8ff });
  const hull = vectorMesh(new THREE.ConeGeometry(radius, radius * 2.4, 5), material);
  hull.rotation.z = -Math.PI / 2;
  root.add(hull);
  return {
    root,
    setTeam: (color) => material.uniforms.uEdge.value.copy(color),
    update: (pose: RobotPose) => {
      root.rotation.z = pose.aim;
      root.scale.setScalar(1 - pose.morph);
      material.uniforms.uFlash.value = pose.hit;
    },
    dispose: () => {
      material.dispose();
      hull.geometry.dispose();
    },
  };
}

export function placeholderColossus(frame: number): ColossusModel {
  const form = FORMS[frame];
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const material: VectorMaterial = createVectorMaterial({ edge: 0x5fe8ff });
  const podMaterial: VectorMaterial = createVectorMaterial({ edge: 0xffd23f, fill: 0x1a1404 });
  const owned: THREE.BufferGeometry[] = [];
  const core = vectorMesh(new THREE.OctahedronGeometry(to(form.coreR)), material);
  body.add(core);
  const nodes = form.parts.map((part) => {
    const node = new THREE.Group();
    const disc = vectorMesh(new THREE.CylinderGeometry(to(part.rad), to(part.rad), part.kind === PartKind.Pod ? 10 : 6, 8), part.kind === PartKind.Pod ? podMaterial : material);
    disc.rotation.x = Math.PI / 2;
    node.add(disc);
    let barrel: THREE.Mesh | null = null;
    if (part.kind === PartKind.Pod) {
      barrel = vectorMesh(new THREE.BoxGeometry(to(part.muzzle), 3, 3), podMaterial);
      barrel.position.x = to(part.muzzle) / 2;
      node.add(barrel);
    }
    body.add(node);
    owned.push(disc.geometry);
    if (barrel) owned.push(barrel.geometry);
    return { node, part, barrel };
  });
  return {
    root,
    setTeam: (color) => material.uniforms.uEdge.value.copy(color),
    update: (pose: ColossusPose) => {
      body.rotation.z = pose.body;
      core.scale.setScalar(0.4 + 0.6 * pose.assemble);
      material.uniforms.uFlash.value = pose.hit;
      nodes.forEach(({ node, part, barrel }, k) => {
        const p = pose.parts[k];
        node.visible = p.hp > 0;
        const angle = part.orbit ? pose.orbit - pose.body : 0;
        const x = to(part.x) * pose.assemble;
        const y = to(part.y) * pose.assemble;
        node.position.set(x * Math.cos(angle) - y * Math.sin(angle), x * Math.sin(angle) + y * Math.cos(angle), 0);
        node.rotation.z = part.kind === PartKind.Pod ? p.facing - pose.body : 0;
        if (barrel) barrel.scale.x = 1 + p.charge * 0.5;
      });
    },
    dispose: () => {
      material.dispose();
      podMaterial.dispose();
      core.geometry.dispose();
      owned.forEach((g) => g.dispose());
    },
  };
}

export function placeholderNeutral(radius: number): NeutralModel {
  const root = new THREE.Group();
  const material = createVectorMaterial({ edge: 0xff9a3d, fill: 0x1a0d04 });
  const shell = vectorMesh(new THREE.IcosahedronGeometry(radius, 0), material);
  root.add(shell);
  return {
    root,
    update: (pose: NeutralPose) => {
      root.rotation.z = pose.heading;
      material.uniforms.uFlash.value = pose.flash;
    },
    dispose: () => {
      material.dispose();
      shell.geometry.dispose();
    },
  };
}
