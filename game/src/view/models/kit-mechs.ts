import * as THREE from 'three';
import { createVectorMaterial, vectorMesh, type VectorMaterial } from '../../render/vector.ts';
import { clamp01, lerp } from '../shared.ts';

export const HALF_PI = Math.PI * 0.5;

export interface OwnedMesh {
  readonly mesh: THREE.Mesh;
  readonly material: VectorMaterial;
}

export interface TeamMaterial {
  readonly material: VectorMaterial;
  readonly lightness: number;
  readonly saturation: number;
}

export interface MechKit {
  readonly geometries: THREE.BufferGeometry[];
  readonly materials: THREE.Material[];
  readonly teamMaterials: TeamMaterial[];
  readonly hullMaterials: VectorMaterial[];
  readonly accentMaterials: VectorMaterial[];
  own<T extends THREE.BufferGeometry>(geometry: T): T;
  teamMaterial(lightness: number, saturation: number, glow: number, fill: number, fillAlpha: number, edgeWidth?: number): VectorMaterial;
  accentMaterial(edge: number, fill: number, glow: number, fillAlpha: number, edgeWidth?: number): VectorMaterial;
  glassMaterial(edge: number, fill: number): VectorMaterial;
  mesh(parent: THREE.Object3D, geometry: THREE.BufferGeometry, material: VectorMaterial, x: number, y: number, z: number, crease?: number): THREE.Mesh;
  setTeam(color: THREE.Color): void;
  dispose(): void;
}

export function pulse(time: number, speed: number, amount: number): number {
  return 1 + Math.sin(time * speed) * amount;
}

export function shapeExtrude(points: ReadonlyArray<readonly [number, number]>, depth: number, bevel = 0.45): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  points.forEach(([x, y], index) => {
    if (index === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  });
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: bevel > 0,
    bevelSegments: bevel > 0 ? 1 : 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    curveSegments: 2,
  });
  geometry.translate(0, 0, -depth * 0.5);
  return geometry;
}

export function plateGeometry(length: number, width: number, depth: number, cut = 0.2): THREE.BufferGeometry {
  const cutX = length * cut;
  const cutY = width * cut;
  return shapeExtrude([
    [-length * 0.5 + cutX, -width * 0.5],
    [length * 0.5 - cutX, -width * 0.5],
    [length * 0.5, -width * 0.5 + cutY],
    [length * 0.5, width * 0.5 - cutY],
    [length * 0.5 - cutX, width * 0.5],
    [-length * 0.5 + cutX, width * 0.5],
    [-length * 0.5, width * 0.5 - cutY],
    [-length * 0.5, -width * 0.5 + cutY],
  ], depth, 0.42);
}

export function wedgeGeometry(length: number, width: number, depth: number, tail = 0.34): THREE.BufferGeometry {
  return shapeExtrude([
    [-length * tail, -width * 0.5],
    [length * 0.5, -width * 0.22],
    [length * 0.34, 0],
    [length * 0.5, width * 0.22],
    [-length * tail, width * 0.5],
    [-length * 0.5, 0],
  ], depth, 0.34);
}

export function finGeometry(length: number, width: number, depth: number): THREE.BufferGeometry {
  return shapeExtrude([
    [-length * 0.45, -width * 0.4],
    [length * 0.5, 0],
    [-length * 0.45, width * 0.4],
    [-length * 0.2, 0],
  ], depth, 0.18);
}

export function diamondGeometry(size: number, depth: number): THREE.BufferGeometry {
  return shapeExtrude([
    [0, -size],
    [size, 0],
    [0, size],
    [-size, 0],
  ], depth, 0.18);
}

export function barrelGeometry(length: number, radius: number, muzzle = radius * 1.18): THREE.BufferGeometry {
  const body = new THREE.CylinderGeometry(radius, radius * 0.92, length, 6, 1, false);
  body.rotateZ(HALF_PI);
  const collar = new THREE.CylinderGeometry(radius * 1.24, radius * 1.12, length * 0.22, 6, 1, false);
  collar.rotateZ(HALF_PI);
  collar.translate(-length * 0.12, 0, 0);
  const tip = new THREE.CylinderGeometry(muzzle, radius, length * 0.16, 6, 1, false);
  tip.rotateZ(HALF_PI);
  tip.translate(length * 0.42, 0, 0);
  return merge([body, collar, tip]);
}

export function nozzleGeometry(length: number, radius: number): THREE.BufferGeometry {
  const geometry = new THREE.CylinderGeometry(radius * 0.82, radius, length, 6, 1, false);
  geometry.rotateZ(HALF_PI);
  return geometry;
}

export function ringGeometry(radius: number, tube: number): THREE.BufferGeometry {
  return new THREE.TorusGeometry(radius, tube, 4, 20);
}

export function lineGeometry(length: number, width: number, depth: number): THREE.BufferGeometry {
  return new THREE.BoxGeometry(length, width, depth);
}

export function merge(geometries: readonly THREE.BufferGeometry[]): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  for (const geometry of geometries) {
    const nonIndexed = geometry.index === null ? geometry : geometry.toNonIndexed();
    const pos = nonIndexed.getAttribute('position');
    const normal = nonIndexed.getAttribute('normal');
    const uv = nonIndexed.getAttribute('uv');
    for (let i = 0; i < pos.count; i++) {
      positions.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      normals.push(normal.getX(i), normal.getY(i), normal.getZ(i));
      if (uv) uvs.push(uv.getX(i), uv.getY(i));
      else uvs.push(0, 0);
    }
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  merged.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  return merged;
}

export function createMechKit(): MechKit {
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const teamMaterials: TeamMaterial[] = [];
  const hullMaterials: VectorMaterial[] = [];
  const accentMaterials: VectorMaterial[] = [];
  return {
    geometries,
    materials,
    teamMaterials,
    hullMaterials,
    accentMaterials,
    own<T extends THREE.BufferGeometry>(geometry: T): T {
      geometries.push(geometry);
      return geometry;
    },
    teamMaterial(lightness, saturation, glow, fill, fillAlpha, edgeWidth = 1.6) {
      const material = createVectorMaterial({ edge: 0xffffff, fill, fillAlpha, edgeWidth, glow });
      materials.push(material);
      teamMaterials.push({ material, lightness, saturation });
      hullMaterials.push(material);
      return material;
    },
    accentMaterial(edge, fill, glow, fillAlpha, edgeWidth = 1.5) {
      const material = createVectorMaterial({ edge, fill, fillAlpha, edgeWidth, glow });
      materials.push(material);
      accentMaterials.push(material);
      return material;
    },
    glassMaterial(edge, fill) {
      const material = createVectorMaterial({ edge, fill, fillAlpha: 0.18, glow: 2.8, edgeWidth: 1.3 });
      materials.push(material);
      accentMaterials.push(material);
      return material;
    },
    mesh(parent, geometry, material, x, y, z, crease = 48) {
      const mesh = vectorMesh(geometry, material, crease);
      mesh.position.set(x, y, z);
      if (mesh.geometry !== geometry) geometries.push(mesh.geometry);
      parent.add(mesh);
      return mesh;
    },
    setTeam(color) {
      const hsl = { h: 0, s: 0, l: 0 };
      color.getHSL(hsl);
      for (const team of teamMaterials) {
        team.material.uniforms.uEdge.value.setHSL(hsl.h, Math.min(1, Math.max(0.18, hsl.s * team.saturation)), clamp01(team.lightness));
      }
    },
    dispose() {
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
    },
  };
}

export function applyRobotVectorState(
  kit: MechKit,
  time: number,
  hit: number,
  charge: number,
  shield: number,
  morph: number,
): void {
  const ready = Math.max(0, (charge - 0.75) / 0.25);
  const readyPulse = ready > 0 ? (0.2 + 0.8 * (0.5 + 0.5 * Math.sin(time * 7.5))) * ready : 0;
  const reveal = clamp01(1 - morph - shield * 0.62);
  for (const material of kit.hullMaterials) {
    material.uniforms.uFlash.value = hit * 0.42;
    material.uniforms.uPulse.value = readyPulse * 0.04;
    material.uniforms.uOpacity.value = lerp(1, 0.15, shield * 0.12);
    material.uniforms.uTime.value = time;
    material.uniforms.uFlow.value = readyPulse > 0.01 || shield > 0.01 ? 0.035 + readyPulse * 0.08 + shield * 0.05 : 0;
    material.uniforms.uReveal.value = reveal;
  }
  for (const material of kit.accentMaterials) {
    material.uniforms.uFlash.value = hit * 0.3;
    material.uniforms.uPulse.value = readyPulse * 0.18 + shield * 0.06;
    material.uniforms.uTime.value = time;
    material.uniforms.uFlow.value = 0.08 + readyPulse * 0.16 + shield * 0.12;
    material.uniforms.uReveal.value = reveal;
  }
}

export function applyColossusVectorState(
  kit: MechKit,
  time: number,
  hit: number,
  fuel: number,
  assemble: number,
): void {
  const heavyPulse = 0.5 + 0.5 * Math.sin(time * 5.8);
  for (const material of kit.hullMaterials) {
    material.uniforms.uFlash.value = hit * 0.28;
    material.uniforms.uOpacity.value = 0.92;
    material.uniforms.uPulse.value = 0.01 + heavyPulse * 0.03 + (1 - fuel) * 0.03 * (0.5 + 0.5 * Math.sin(time * 4));
    material.uniforms.uTime.value = time;
    material.uniforms.uFlow.value = heavyPulse > 0.7 ? heavyPulse * 0.035 : 0;
    material.uniforms.uReveal.value = assemble;
  }
  for (const material of kit.accentMaterials) {
    material.uniforms.uFlash.value = hit * 0.24;
    material.uniforms.uPulse.value = heavyPulse * 0.08 + (0.05 + (1 - fuel) * 0.08) * (0.5 + 0.5 * Math.sin(time * 5));
    material.uniforms.uTime.value = time;
    material.uniforms.uFlow.value = 0.14 + heavyPulse * 0.08 + (1 - fuel) * 0.08;
    material.uniforms.uReveal.value = assemble;
  }
}
