import * as THREE from 'three';
import type { Beat } from '../beat.ts';

const STAR_COUNT = 720;
const STAR_FIELD_RADIUS = 2600;
const STAR_DEPTH = 820;
const TUNNEL_SEGMENTS = 96;
const TUNNEL_RINGS = 9;
const CORE_RING_SEGMENTS = 160;
const BACKDROP_BASE_Z = -330;
const BACKDROP_BEAT_OPACITY = 0.018;
const BACKDROP_PULSE_DECAY = 3.4;
const WIRE_BASE_OPACITY = 0.026;
const STAR_BASE_OPACITY = 0.13;
const PULSE_OPACITY = 0.035;
const TWO_PI = Math.PI * 2;
const STRUCTURE_SCALE = 360;
const RING_STEP = 150;
const RING_START = 520;
const LCG_A = 1664525;
const LCG_C = 1013904223;
const LCG_SCALE = 1 / 0x100000000;

function nextRand(state: { seed: number }): number {
  state.seed = (state.seed * LCG_A + LCG_C) >>> 0;
  return state.seed * LCG_SCALE;
}

function createStarGeometry(): THREE.BufferGeometry {
  const random = { seed: 0xB055F04D };
  const positions = new Float32Array(STAR_COUNT * 3);
  const colors = new Float32Array(STAR_COUNT * 3);
  for (let i = 0; i < STAR_COUNT; i++) {
    const radius = Math.sqrt(nextRand(random)) * STAR_FIELD_RADIUS;
    const angle = nextRand(random) * TWO_PI;
    const depth = -nextRand(random) * STAR_DEPTH;
    const j = i * 3;
    positions[j] = Math.cos(angle) * radius;
    positions[j + 1] = Math.sin(angle) * radius;
    positions[j + 2] = depth;
    const cool = 0.54 + nextRand(random) * 0.28;
    colors[j] = 0.22 * cool;
    colors[j + 1] = 0.72 * cool;
    colors[j + 2] = 1.0 * cool;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

function createRingTunnelGeometry(): THREE.BufferGeometry {
  const vertices = new Float32Array(TUNNEL_RINGS * CORE_RING_SEGMENTS * 2 * 3);
  let offset = 0;
  for (let ring = 0; ring < TUNNEL_RINGS; ring++) {
    const radius = RING_START + ring * RING_STEP;
    const z = -ring * 70;
    for (let segment = 0; segment < CORE_RING_SEGMENTS; segment++) {
      const a = (segment / CORE_RING_SEGMENTS) * TWO_PI;
      const b = ((segment + 1) / CORE_RING_SEGMENTS) * TWO_PI;
      vertices[offset++] = Math.cos(a) * radius;
      vertices[offset++] = Math.sin(a) * radius;
      vertices[offset++] = z;
      vertices[offset++] = Math.cos(b) * radius;
      vertices[offset++] = Math.sin(b) * radius;
      vertices[offset++] = z;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
  return geometry;
}

function createSpokeGeometry(): THREE.BufferGeometry {
  const vertices = new Float32Array(TUNNEL_SEGMENTS * 2 * 3);
  let offset = 0;
  for (let segment = 0; segment < TUNNEL_SEGMENTS; segment++) {
    const a = (segment / TUNNEL_SEGMENTS) * TWO_PI;
    const inner = RING_START * 0.58;
    const outer = RING_START + RING_STEP * (TUNNEL_RINGS - 1);
    vertices[offset++] = Math.cos(a) * inner;
    vertices[offset++] = Math.sin(a) * inner;
    vertices[offset++] = 0;
    vertices[offset++] = Math.cos(a) * outer;
    vertices[offset++] = Math.sin(a) * outer;
    vertices[offset++] = -STAR_DEPTH * 0.62;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
  return geometry;
}

export class DemoBackdrop {
  readonly root = new THREE.Group();
  private readonly structures = new THREE.Group();
  private readonly stars: THREE.Points;
  private readonly starMaterial: THREE.PointsMaterial;
  private readonly wireMaterials: readonly THREE.LineBasicMaterial[];
  private pulse = 0;

  constructor() {
    this.root.position.z = BACKDROP_BASE_Z;
    this.root.renderOrder = -50;

    this.starMaterial = new THREE.PointsMaterial({
      size: 5.2,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      opacity: STAR_BASE_OPACITY,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.stars = new THREE.Points(createStarGeometry(), this.starMaterial);
    this.stars.frustumCulled = false;
    this.root.add(this.stars);

    const cyan = new THREE.LineBasicMaterial({ color: 0x38ccff, transparent: true, opacity: WIRE_BASE_OPACITY, depthWrite: false, blending: THREE.AdditiveBlending });
    const magenta = new THREE.LineBasicMaterial({ color: 0xff4fd6, transparent: true, opacity: WIRE_BASE_OPACITY * 0.72, depthWrite: false, blending: THREE.AdditiveBlending });
    const amber = new THREE.LineBasicMaterial({ color: 0xffc45a, transparent: true, opacity: WIRE_BASE_OPACITY * 0.58, depthWrite: false, blending: THREE.AdditiveBlending });
    this.wireMaterials = [cyan, magenta, amber];

    const tunnel = new THREE.LineSegments(createRingTunnelGeometry(), cyan);
    tunnel.frustumCulled = false;
    this.structures.add(tunnel);
    const spokes = new THREE.LineSegments(createSpokeGeometry(), amber);
    spokes.frustumCulled = false;
    this.structures.add(spokes);

    const knotGeo = new THREE.WireframeGeometry(new THREE.TorusKnotGeometry(STRUCTURE_SCALE * 0.62, 18, 192, 8, 3, 5));
    const knot = new THREE.LineSegments(knotGeo, magenta);
    knot.position.set(-520, 360, -150);
    knot.rotation.set(0.8, 0.15, 0.4);
    knot.frustumCulled = false;
    this.structures.add(knot);

    const icoGeo = new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(STRUCTURE_SCALE, 2));
    const ico = new THREE.LineSegments(icoGeo, cyan);
    ico.position.set(620, -410, -260);
    ico.rotation.set(0.22, 0.48, 0.1);
    ico.frustumCulled = false;
    this.structures.add(ico);

    this.structures.frustumCulled = false;
    this.root.add(this.structures);
  }

  strike(strength: number): void {
    this.pulse = Math.min(1, this.pulse + strength);
  }

  update(timeSeconds: number, dtSeconds: number, beat: Beat): void {
    this.pulse = Math.max(0, this.pulse - dtSeconds * BACKDROP_PULSE_DECAY);
    const beatLift = beat.pulse * BACKDROP_BEAT_OPACITY;
    const eventLift = this.pulse * PULSE_OPACITY;
    this.root.rotation.z = timeSeconds * 0.012;
    this.stars.rotation.z = -timeSeconds * 0.018;
    this.stars.rotation.x = Math.sin(timeSeconds * 0.07) * 0.035;
    this.structures.rotation.z = timeSeconds * 0.026;
    this.structures.rotation.y = Math.sin(timeSeconds * 0.05) * 0.08;
    this.starMaterial.opacity = STAR_BASE_OPACITY + beatLift + eventLift * 0.55;
    for (let i = 0; i < this.wireMaterials.length; i++) {
      const material = this.wireMaterials[i];
      material.opacity = WIRE_BASE_OPACITY * (1 - i * 0.15) + beatLift * 0.7 + eventLift;
      material.color.setHSL(0.53 + i * 0.08 + Math.sin(timeSeconds * 0.035 + i) * 0.025, 0.92, 0.62);
    }
  }

  dispose(): void {
    this.root.traverse((object) => {
      const mesh = object as THREE.Object3D & { geometry?: THREE.BufferGeometry; material?: THREE.Material | THREE.Material[] };
      mesh.geometry?.dispose();
      if (Array.isArray(mesh.material)) {
        for (const material of mesh.material) material.dispose();
      } else {
        mesh.material?.dispose();
      }
    });
  }
}
