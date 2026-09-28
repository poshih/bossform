import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { gearGeometry, glowMaterial, profileGeometry, toonMaterial, type GlowMaterial, type ToonMaterial } from '../../render/meshkit.ts';

export interface GlowTrack {
  readonly material: GlowMaterial;
  readonly baseIntensity: number;
}

export interface EmissiveTrack {
  readonly color: THREE.Color;
  readonly base: THREE.Color;
  readonly scale: number;
}

export interface PartRegistry {
  readonly geometries: Set<THREE.BufferGeometry>;
  readonly materials: Set<THREE.Material>;
  readonly toons: ToonMaterial[];
  readonly glows: GlowTrack[];
  readonly emissives: EmissiveTrack[];
  ownGeometry<T extends THREE.BufferGeometry>(geometry: T): T;
  ownMaterial<T extends THREE.Material>(material: T): T;
  makeToon(options: Parameters<typeof toonMaterial>[0]): ToonMaterial;
  makeGlow(color: number, intensity?: number, fresnel?: number, pulse?: number): GlowMaterial;
  trackEmissive(material: ToonMaterial, base: number, scale?: number): void;
  dispose(): void;
}

export function createPartRegistry(): PartRegistry {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const toons: ToonMaterial[] = [];
  const glows: GlowTrack[] = [];
  const emissives: EmissiveTrack[] = [];
  return {
    geometries,
    materials,
    toons,
    glows,
    emissives,
    ownGeometry<T extends THREE.BufferGeometry>(geometry: T): T {
      geometries.add(geometry);
      return geometry;
    },
    ownMaterial<T extends THREE.Material>(material: T): T {
      materials.add(material);
      return material;
    },
    makeToon(options) {
      const material = toonMaterial(options);
      materials.add(material);
      toons.push(material);
      return material;
    },
    makeGlow(color, intensity = 2, fresnel = 0, pulse = 0) {
      const material = glowMaterial(color, intensity, fresnel, pulse);
      materials.add(material);
      glows.push({ material, baseIntensity: intensity });
      return material;
    },
    trackEmissive(material, base, scale = 1) {
      emissives.push({ color: material.uniforms.uEmissive.value, base: new THREE.Color(base), scale });
    },
    dispose() {
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
    },
  };
}

export function arcGeometry(innerR: number, outerR: number, depth: number, start: number, length: number): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  const segments = Math.max(12, Math.ceil(Math.abs(length) * 12));
  for (let i = 0; i <= segments; i++) {
    const angle = start + (length * i) / segments;
    const x = Math.cos(angle) * outerR;
    const y = Math.sin(angle) * outerR;
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  for (let i = segments; i >= 0; i--) {
    const angle = start + (length * i) / segments;
    shape.lineTo(Math.cos(angle) * innerR, Math.sin(angle) * innerR);
  }
  const geometry = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 4 });
  geometry.translate(0, 0, -depth / 2);
  return geometry;
}

export function plateGeometry(width: number, height: number, depth: number, bevel = 0.8): THREE.BufferGeometry {
  return profileGeometry([
    [-width * 0.5, -height * 0.5],
    [width * 0.5, -height * 0.5],
    [width * 0.5, height * 0.5],
    [-width * 0.5, height * 0.5],
  ], depth, bevel);
}

export function octagonGeometry(width: number, height: number, depth: number, cut = 0.24, bevel = 0.9): THREE.BufferGeometry {
  const cutX = width * cut;
  const cutY = height * cut;
  return profileGeometry([
    [-width * 0.5 + cutX, -height * 0.5],
    [width * 0.5 - cutX, -height * 0.5],
    [width * 0.5, -height * 0.5 + cutY],
    [width * 0.5, height * 0.5 - cutY],
    [width * 0.5 - cutX, height * 0.5],
    [-width * 0.5 + cutX, height * 0.5],
    [-width * 0.5, height * 0.5 - cutY],
    [-width * 0.5, -height * 0.5 + cutY],
  ], depth, bevel);
}

export function wingPanelGeometry(length: number, width: number, depth: number, taper = 0.4): THREE.BufferGeometry {
  return profileGeometry([
    [-length * 0.42, -width * 0.5],
    [length * 0.5, -width * taper],
    [length * 0.34, 0],
    [length * 0.5, width * taper],
    [-length * 0.42, width * 0.5],
    [-length * 0.28, 0],
  ], depth, 0.9);
}

export function spikeGeometry(length: number, width: number, depth: number): THREE.BufferGeometry {
  return profileGeometry([
    [-length * 0.45, 0],
    [length * 0.3, -width * 0.42],
    [length * 0.5, 0],
    [length * 0.3, width * 0.42],
  ], depth, 0.6);
}

export function thrusterNozzleGeometry(radius: number, length: number): THREE.BufferGeometry {
  const geometry = new THREE.CylinderGeometry(radius * 0.8, radius, length, 6, 1, false);
  geometry.rotateZ(Math.PI * 0.5);
  return geometry;
}

export function cannonGeometry(length: number, radius: number, muzzleRadius = radius * 1.18): THREE.BufferGeometry {
  const body = new THREE.CylinderGeometry(radius, radius * 0.92, length, 6, 1, false);
  body.rotateZ(Math.PI * 0.5);
  const brace = new THREE.CylinderGeometry(radius * 1.32, radius * 1.1, length * 0.28, 6, 1, false);
  brace.rotateZ(Math.PI * 0.5);
  brace.translate(-length * 0.12, 0, 0);
  const muzzle = new THREE.CylinderGeometry(muzzleRadius, radius, length * 0.18, 6, 1, false);
  muzzle.rotateZ(Math.PI * 0.5);
  muzzle.translate(length * 0.42, 0, 0);
  return mergeGeometries([body, brace, muzzle], false) ?? body;
}

export function shoulderArmorGeometry(width: number, height: number, depth: number): THREE.BufferGeometry {
  return profileGeometry([
    [-width * 0.45, -height * 0.35],
    [width * 0.1, -height * 0.55],
    [width * 0.48, -height * 0.18],
    [width * 0.38, height * 0.45],
    [-width * 0.36, height * 0.5],
    [-width * 0.5, 0],
  ], depth, 1.1);
}

export function haloGeometry(radius: number, tube: number): THREE.BufferGeometry {
  return new THREE.TorusGeometry(radius, tube, 4, 18);
}

export function simpleGearGeometry(radius: number, teeth: number, depth: number): THREE.BufferGeometry {
  return gearGeometry(radius, teeth, Math.max(0.6, radius * 0.16), radius * 0.34, depth, 0);
}

export function applyStandardPose(
  registry: PartRegistry,
  poseTime: number,
  hit: number,
  charge: number,
  transformGlow: number,
): void {
  const ready = Math.max(0, (charge - 0.8) / 0.2);
  const readyPulse = ready > 0 ? (0.35 + 0.65 * (0.5 + 0.5 * Math.sin(poseTime * 8))) * ready : 0;
  for (const material of registry.toons) {
    material.uniforms.uFlash.value = hit * 0.55;
    material.uniforms.uTime.value = poseTime;
  }
  for (const glow of registry.glows) {
    glow.material.uniforms.uTime.value = poseTime;
    glow.material.uniforms.uIntensity.value = glow.baseIntensity * (1 + readyPulse * 0.35 + transformGlow * 0.45);
  }
  for (const emissive of registry.emissives) {
    emissive.color.copy(emissive.base).multiplyScalar(emissive.scale * (0.14 + readyPulse * 0.95 + transformGlow * 1.45));
  }
}
