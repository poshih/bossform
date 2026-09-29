import * as THREE from 'three';

/**
 * The vector-mesh look: faces are dark and translucent, edges are crisp glowing lines. Everything that is a
 * hull, a plate, a pod or a unit is drawn with this one material so the whole game reads as one language.
 *
 * Edges come from the geometry itself (barycentric coordinates, one draw call, anti-aliased by screen-space
 * derivatives), so they stay one steady thickness at any zoom and never shimmer. Edges between (nearly)
 * coplanar triangles are hidden, so only real creases and outlines glow, never the triangulation.
 */

export interface VectorStyle {
  /** Edge colour (linear). Values above 1 feed the bloom. */
  edge: THREE.ColorRepresentation;
  /** Face tint. */
  fill: THREE.ColorRepresentation;
  /** Face opacity, 0..1. */
  fillAlpha: number;
  /** Edge thickness in CSS pixels. */
  edgeWidth: number;
  /** Edge brightness multiplier (bloom input). */
  glow: number;
}

const DEFAULT_STYLE: VectorStyle = { edge: 0x5fe8ff, fill: 0x06131c, fillAlpha: 0.28, edgeWidth: 1.4, glow: 1.55 };

const VERTEX = /* glsl */ `
attribute vec3 bary;
attribute vec3 hide;
varying vec3 vBary;
varying vec3 vNormal;
varying vec3 vView;
varying vec3 vLocal;
void main() {
  // An edge whose flag is set is pushed far from zero so it can never be drawn.
  vBary = bary + hide * 16.0;
  // Normalised per fragment: a part scaled flat on one axis (an assembling girder, a zero-length strut) has a singular
  // normal matrix, so this can be the zero vector.
  vNormal = normalMatrix * normal;
  vLocal = position;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vView = mv.xyz;
  gl_Position = projectionMatrix * mv;
}`;

const FRAGMENT = /* glsl */ `
uniform vec3 uEdge;
uniform vec3 uFill;
uniform float uFillAlpha;
uniform float uEdgeWidth;
uniform float uGlow;
uniform float uFlash;
uniform float uOpacity;
uniform float uPulse;
uniform float uTime;
uniform float uFlow;
uniform float uReveal;
varying vec3 vBary;
varying vec3 vNormal;
varying vec3 vView;
varying vec3 vLocal;
void main() {
  vec3 fw = fwidth(vBary);
  vec3 k = smoothstep(vec3(0.0), fw * uEdgeWidth, vBary);
  float edge = 1.0 - min(min(k.x, k.y), k.z);
  float radial = clamp(length(vLocal.xy) / 56.0, 0.0, 1.0);
  float reveal = smoothstep(radial - 0.08, radial + 0.08, uReveal);
  // One NaN pixel in the half-float target is smeared over the whole screen by the bloom, so no NaN may leave here:
  // a flattened part has no normal (it faces the camera: no rim), |dot| of unit vectors can round past 1, and pow()
  // of a negative base is NaN on most GPUs.
  float normalLength2 = dot(vNormal, vNormal);
  float facing = normalLength2 > 0.0 ? clamp(abs(dot(vNormal * inversesqrt(normalLength2), normalize(-vView))), 0.0, 1.0) : 1.0;
  float rim = (1.0 - facing) * (1.0 - facing);
  vec3 face = uFill * (0.52 + 0.32 * facing) + uEdge * rim * 0.12;
  float wave = 0.5 + 0.5 * sin(dot(vLocal.xy, vec2(0.21, 0.37)) + uTime * 5.4);
  float wave2 = wave * wave;
  float flowWave = uFlow > 0.001 ? wave2 * wave2 * wave2 * wave2 : 0.0;
  vec3 line = uEdge * uGlow * (0.92 + 0.32 * uPulse + flowWave * uFlow);
  vec3 col = mix(face, line, edge);
  col = mix(col, vec3(1.8), uFlash * (0.22 + 0.78 * edge));
  float alpha = mix(uFillAlpha * (0.7 + 0.9 * rim), 1.0, edge) * uOpacity * reveal;
  gl_FragColor = vec4(col, alpha);
}`;

export type VectorMaterial = THREE.ShaderMaterial & {
  uniforms: {
    uEdge: { value: THREE.Color };
    uFill: { value: THREE.Color };
    uFillAlpha: { value: number };
    uEdgeWidth: { value: number };
    uGlow: { value: number };
    uFlash: { value: number };
    uOpacity: { value: number };
    uPulse: { value: number };
    uTime: { value: number };
    uFlow: { value: number };
    uReveal: { value: number };
  };
};

export function createVectorMaterial(style: Partial<VectorStyle> = {}): VectorMaterial {
  const s = { ...DEFAULT_STYLE, ...style };
  const material = new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    uniforms: {
      uEdge: { value: new THREE.Color(s.edge) },
      uFill: { value: new THREE.Color(s.fill) },
      uFillAlpha: { value: s.fillAlpha },
      uEdgeWidth: { value: s.edgeWidth },
      uGlow: { value: s.glow },
      uFlash: { value: 0 },
      uOpacity: { value: 1 },
      uPulse: { value: 0 },
      uTime: { value: 0 },
      uFlow: { value: 0 },
      uReveal: { value: 1 },
    },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  return material as VectorMaterial;
}

/** Quantised position key so vertices that coincide in space (but not in the index buffer) are recognised as one. */
function keyOf(a: THREE.Vector3): string {
  return `${Math.round(a.x * 1000)},${Math.round(a.y * 1000)},${Math.round(a.z * 1000)}`;
}

/**
 * Turns any geometry into edge-ready geometry: flat-shaded, non-indexed, with barycentric coordinates and the
 * per-edge hide flags. Edges shared by two triangles whose normals differ by less than `creaseDegrees` are hidden;
 * boundary edges and sharp creases are kept.
 */
export function edgeGeometry(source: THREE.BufferGeometry, creaseDegrees = 32): THREE.BufferGeometry {
  const flat = source.index === null ? source : source.toNonIndexed();
  const positions = flat.getAttribute('position');
  const triangles = positions.count / 3;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const normals: THREE.Vector3[] = [];
  const edgeUsers = new Map<string, number[]>();
  const edgeKey = (p: THREE.Vector3, q: THREE.Vector3): string => {
    const kp = keyOf(p);
    const kq = keyOf(q);
    return kp < kq ? `${kp}|${kq}` : `${kq}|${kp}`;
  };
  const corner = (triangle: number, index: number, out: THREE.Vector3): THREE.Vector3 => out.fromBufferAttribute(positions, triangle * 3 + index);
  for (let t = 0; t < triangles; t++) {
    corner(t, 0, a);
    corner(t, 1, b);
    corner(t, 2, c);
    normals.push(new THREE.Vector3().subVectors(c, b).cross(new THREE.Vector3().subVectors(a, b)).normalize());
    for (const [p, q] of [[b, c], [a, c], [a, b]] as const) {
      const key = edgeKey(p, q);
      const users = edgeUsers.get(key);
      if (users) users.push(t);
      else edgeUsers.set(key, [t]);
    }
  }
  const limit = Math.cos((creaseDegrees * Math.PI) / 180);
  const out = new THREE.BufferGeometry();
  const position = new Float32Array(triangles * 9);
  const normal = new Float32Array(triangles * 9);
  const bary = new Float32Array(triangles * 9);
  const hide = new Float32Array(triangles * 9);
  const other = new THREE.Vector3();
  for (let t = 0; t < triangles; t++) {
    corner(t, 0, a);
    corner(t, 1, b);
    corner(t, 2, c);
    // Edge i is the one opposite corner i.
    const edges = [[b, c], [a, c], [a, b]] as const;
    const flags = edges.map(([p, q]) => {
      const users = edgeUsers.get(edgeKey(p, q))!;
      if (users.length !== 2) return 0;
      const mate = users[0] === t ? users[1] : users[0];
      other.copy(normals[mate]);
      return normals[t].dot(other) >= limit ? 1 : 0;
    });
    for (let v = 0; v < 3; v++) {
      const at = (t * 3 + v) * 3;
      corner(t, v, a.set(0, 0, 0));
      position.set([a.x, a.y, a.z], at);
      normal.set([normals[t].x, normals[t].y, normals[t].z], at);
      bary.set([v === 0 ? 1 : 0, v === 1 ? 1 : 0, v === 2 ? 1 : 0], at);
      hide.set(flags, at);
    }
  }
  out.setAttribute('position', new THREE.BufferAttribute(position, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  out.setAttribute('bary', new THREE.BufferAttribute(bary, 3));
  out.setAttribute('hide', new THREE.BufferAttribute(hide, 3));
  return out;
}

/** A mesh drawn in the vector look. The geometry is converted once here; the material may be shared. */
export function vectorMesh(geometry: THREE.BufferGeometry, material: VectorMaterial, creaseDegrees = 32): THREE.Mesh {
  return new THREE.Mesh(edgeGeometry(geometry, creaseDegrees), material);
}
