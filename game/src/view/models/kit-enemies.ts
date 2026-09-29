import * as THREE from 'three';
import { edgeGeometry, type VectorMaterial, createVectorMaterial } from '../../render/vector.ts';
import { TWO_PI, lerp } from '../shared.ts';


export function pulse(time: number, speed: number, min: number, max: number): number {
  return lerp(min, max, 0.5 + 0.5 * Math.sin(time * speed));
}

export interface TeamMaterialRef {
  readonly mat: VectorMaterial;
  readonly edgeScale: number;
  readonly fillScale: number;
}

export class ResourceTracker {
  private readonly geometries = new Set<THREE.BufferGeometry>();
  private readonly materials = new Set<THREE.Material>();

  ownMaterial<T extends THREE.Material>(material: T): T {
    this.materials.add(material);
    return material;
  }

  ownGeometry<T extends THREE.BufferGeometry>(geometry: T): T {
    this.geometries.add(geometry);
    return geometry;
  }

  mesh(rawGeometry: THREE.BufferGeometry, material: THREE.Material, creaseDegrees: number, parent: THREE.Object3D): THREE.Mesh {
    const geometry = edgeGeometry(rawGeometry, creaseDegrees);
    rawGeometry.dispose();
    this.geometries.add(geometry);
    const mesh = new THREE.Mesh(geometry, material);
    parent.add(mesh);
    return mesh;
  }

  cloneMesh(geometry: THREE.BufferGeometry, material: THREE.Material, parent: THREE.Object3D): THREE.Mesh {
    const mesh = new THREE.Mesh(geometry, material);
    parent.add(mesh);
    return mesh;
  }

  dispose(): void {
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
  }
}

export function createTeamMaterial(tracker: ResourceTracker, refs: TeamMaterialRef[], edgeScale: number, fillScale: number, glow: number, edgeWidth: number): VectorMaterial {
  const mat = tracker.ownMaterial(createVectorMaterial({ edge: 0xffffff, fill: 0x0a1017, fillAlpha: 0.34, glow, edgeWidth }));
  refs.push({ mat, edgeScale, fillScale });
  return mat;
}

export function createAccentMaterial(tracker: ResourceTracker, edge: THREE.ColorRepresentation, fill: THREE.ColorRepresentation, fillAlpha: number, glow: number, edgeWidth: number): VectorMaterial {
  return tracker.ownMaterial(createVectorMaterial({ edge, fill, fillAlpha, glow, edgeWidth }));
}

export function tintTeamMaterials(refs: readonly TeamMaterialRef[], color: THREE.Color): void {
  for (const ref of refs) {
    ref.mat.uniforms.uEdge.value.copy(color).multiplyScalar(ref.edgeScale);
    ref.mat.uniforms.uFill.value.copy(color).multiplyScalar(ref.fillScale);
  }
}

export function setFlash(materials: readonly VectorMaterial[], value: number): void {
  for (const material of materials) material.uniforms.uFlash.value = value;
}

export function setOpacity(materials: readonly VectorMaterial[], value: number): void {
  for (const material of materials) material.uniforms.uOpacity.value = value;
}

export function setPulse(material: VectorMaterial, value: number): void {
  material.uniforms.uPulse.value = value;
}

export function polygonGeometry(points: ReadonlyArray<readonly [number, number]>, depth: number): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  points.forEach(([x, y], index) => {
    if (index === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  });
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelSize: Math.max(0.18, depth * 0.18),
    bevelThickness: Math.max(0.18, depth * 0.18),
    bevelSegments: 1,
    curveSegments: 4,
  });
  geometry.translate(0, 0, -depth * 0.5);
  return geometry;
}

export function diamondGeometry(length: number, width: number, height: number): THREE.BufferGeometry {
  const geometry = new THREE.OctahedronGeometry(1, 0);
  geometry.scale(length * 0.5, width * 0.5, height * 0.5);
  geometry.rotateZ(Math.PI * 0.5);
  return geometry;
}

export function lineGeometry(length: number, width: number, depth: number): THREE.BufferGeometry {
  const geometry = new THREE.BoxGeometry(length, width, depth);
  geometry.translate(length * 0.5, 0, 0);
  return geometry;
}

export function ringGeometry(outerRadius: number, innerRadius: number, depth: number): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.absarc(0, 0, outerRadius, 0, TWO_PI, false);
  const hole = new THREE.Path();
  hole.absarc(0, 0, innerRadius, 0, TWO_PI, true);
  shape.holes.push(hole);
  const geometry = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 24 });
  geometry.translate(0, 0, -depth * 0.5);
  return geometry;
}
