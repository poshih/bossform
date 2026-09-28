import * as THREE from 'three';

const TOON_VERT = /* glsl */ `
varying vec3 vView;
varying vec3 vObj;
varying vec3 vInstColor;
void main() {
  vec4 p = vec4(position, 1.0);
#ifdef USE_INSTANCING
  p = instanceMatrix * p;
#endif
#ifdef USE_INSTANCING_COLOR
  vInstColor = instanceColor;
#else
  vInstColor = vec3(1.0);
#endif
  vObj = position;
  vec4 mv = modelViewMatrix * p;
  vView = mv.xyz;
  gl_Position = projectionMatrix * mv;
}`;

const TOON_FRAG = /* glsl */ `
uniform vec3 uColor, uShade, uLight, uRim, uEmissive;
uniform float uFlash, uDissolve, uAlpha, uRimAmt, uTime, uLines;
uniform vec3 uLineColor;
varying vec3 vView;
varying vec3 vObj;
varying vec3 vInstColor;
float bayer(vec2 p) {
  vec2 q = mod(floor(p), 4.0);
  float a = mod(q.x + q.y * 2.0, 4.0);
  return (mod(q.x * 3.0 + q.y * 7.0 + a * 5.0, 16.0) + 0.5) / 16.0;
}
float hash3(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
void main() {
  vec3 n = normalize(cross(dFdx(vView), dFdy(vView)));
  vec3 L = normalize(vec3(-0.45, 0.65, 0.62));
  float ndl = dot(n, L);
  vec3 col = ndl > 0.62 ? uLight : ndl > 0.08 ? uColor : uShade;
  col *= vInstColor;
  float facing = clamp(dot(n, normalize(-vView)), 0.0, 1.0);
  float rim = step(0.72, 1.0 - facing) * uRimAmt;
  col = mix(col, uRim, rim);
  // Emissive panel lines: thin bands in object space (reads as glowing hull seams).
  if (uLines > 0.0) {
    float band = abs(fract(vObj.x * uLines + vObj.y * uLines * 0.37) - 0.5);
    col += uLineColor * step(band, 0.035) * 1.6;
  }
  col += uEmissive;
  if (uDissolve > 0.0) {
    float d = hash3(floor(vObj * 0.22));
    if (d < uDissolve) discard;
    col += vec3(3.0, 1.6, 0.6) * step(d, uDissolve + 0.08);
  }
  if (uAlpha < 1.0 && bayer(gl_FragCoord.xy) > uAlpha) discard;
  col = mix(col, vec3(3.2, 3.2, 3.4), uFlash);
  gl_FragColor = vec4(col, 1.0);
}`;

export interface ToonOptions {
  color: number;
  shade?: number;
  light?: number;
  rim?: number;
  rimAmt?: number;
  emissive?: number;
  emissiveAmt?: number;
  lines?: number;
  lineColor?: number;
  side?: THREE.Side;
}

export type ToonMaterial = THREE.ShaderMaterial & {
  uniforms: {
    uColor: { value: THREE.Color }; uShade: { value: THREE.Color }; uLight: { value: THREE.Color };
    uRim: { value: THREE.Color }; uEmissive: { value: THREE.Color }; uLineColor: { value: THREE.Color };
    uFlash: { value: number }; uDissolve: { value: number }; uAlpha: { value: number };
    uRimAmt: { value: number }; uTime: { value: number }; uLines: { value: number };
  };
};

function shadeOf(hex: number, k: number, hueShift: number): THREE.Color {
  const c = new THREE.Color(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  // Pixel-art shading: shadows drift toward blue/violet, highlights toward warm.
  c.setHSL((hsl.h + hueShift + 1) % 1, Math.min(1, hsl.s * (k < 1 ? 1.1 : 0.85)), Math.min(1, hsl.l * k));
  return c;
}

export function toonMaterial(o: ToonOptions): ToonMaterial {
  const em = new THREE.Color(o.emissive ?? 0x000000).multiplyScalar(o.emissiveAmt ?? 1);
  const m = new THREE.ShaderMaterial({
    vertexShader: TOON_VERT,
    fragmentShader: TOON_FRAG,
    side: o.side ?? THREE.FrontSide,
    uniforms: {
      uColor: { value: new THREE.Color(o.color) },
      uShade: { value: o.shade !== undefined ? new THREE.Color(o.shade) : shadeOf(o.color, 0.42, 0.06) },
      uLight: { value: o.light !== undefined ? new THREE.Color(o.light) : shadeOf(o.color, 1.35, -0.02) },
      uRim: { value: new THREE.Color(o.rim ?? 0x9fe8ff) },
      uEmissive: { value: em },
      uLineColor: { value: new THREE.Color(o.lineColor ?? 0x27e1ff) },
      uFlash: { value: 0 },
      uDissolve: { value: 0 },
      uAlpha: { value: 1 },
      uRimAmt: { value: o.rimAmt ?? 0.85 },
      uTime: { value: 0 },
      uLines: { value: o.lines ?? 0 },
    },
  });
  return m as ToonMaterial;
}

const GLOW_VERT = /* glsl */ `
varying vec3 vView;
varying vec3 vN;
varying vec3 vInstColor;
void main() {
  vec4 p = vec4(position, 1.0);
  vec3 nn = normal;
#ifdef USE_INSTANCING
  p = instanceMatrix * p;
  nn = mat3(instanceMatrix) * nn;
#endif
#ifdef USE_INSTANCING_COLOR
  vInstColor = instanceColor;
#else
  vInstColor = vec3(1.0);
#endif
  vec4 mv = modelViewMatrix * p;
  vView = mv.xyz;
  vN = normalize(normalMatrix * nn);
  gl_Position = projectionMatrix * mv;
}`;

const GLOW_FRAG = /* glsl */ `
uniform vec3 uColor; uniform float uIntensity, uFresnel, uTime, uPulse;
varying vec3 vView; varying vec3 vN; varying vec3 vInstColor;
void main() {
  float f = 1.0 - abs(dot(normalize(vN), normalize(-vView)));
  float k = mix(1.0, pow(f, 1.5) * 2.0, uFresnel);
  float pulse = 1.0 + uPulse * sin(uTime * 6.0 + vView.y * 0.05);
  gl_FragColor = vec4(uColor * vInstColor * uIntensity * k * pulse, 1.0);
}`;

export type GlowMaterial = THREE.ShaderMaterial & {
  uniforms: { uColor: { value: THREE.Color }; uIntensity: { value: number }; uFresnel: { value: number }; uTime: { value: number }; uPulse: { value: number } };
};

/** Additive emissive material (engines, energy tubes, eyes). */
export function glowMaterial(color: number, intensity = 2, fresnel = 0, pulse = 0): GlowMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: GLOW_VERT,
    fragmentShader: GLOW_FRAG,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uIntensity: { value: intensity },
      uFresnel: { value: fresnel },
      uTime: { value: 0 },
      uPulse: { value: pulse },
    },
  }) as GlowMaterial;
}

/** A spur gear outline with an optional axle hole, extruded along Z and centred. */
export function gearGeometry(outerR: number, teeth: number, toothDepth: number, holeR: number, depth: number, spokes = 0): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  const rootR = outerR - toothDepth;
  const steps = teeth * 4;
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const phase = i % 4;
    const r = phase === 1 || phase === 2 ? outerR : rootR;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  if (holeR > 0) {
    if (spokes > 0) {
      // Cut windows between spokes instead of one big hole.
      const inner = holeR;
      const outer = rootR * 0.78;
      for (let s = 0; s < spokes; s++) {
        const a0 = (s / spokes) * Math.PI * 2 + 0.16;
        const a1 = ((s + 1) / spokes) * Math.PI * 2 - 0.16;
        const hole = new THREE.Path();
        const seg = 8;
        for (let k = 0; k <= seg; k++) {
          const a = a0 + ((a1 - a0) * k) / seg;
          const x = Math.cos(a) * outer;
          const y = Math.sin(a) * outer;
          if (k === 0) hole.moveTo(x, y);
          else hole.lineTo(x, y);
        }
        for (let k = seg; k >= 0; k--) {
          const a = a0 + ((a1 - a0) * k) / seg;
          hole.lineTo(Math.cos(a) * inner, Math.sin(a) * inner);
        }
        shape.holes.push(hole);
      }
    } else {
      const hole = new THREE.Path();
      hole.absarc(0, 0, holeR, 0, Math.PI * 2, true);
      shape.holes.push(hole);
    }
  }
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 6 });
  g.translate(0, 0, -depth / 2);
  return g;
}

/** Side-profile silhouette extruded with a bevel: the backbone of the player/enemy craft. */
export function profileGeometry(points: ReadonlyArray<readonly [number, number]>, depth: number, bevel = 2): THREE.BufferGeometry {
  const s = new THREE.Shape();
  points.forEach(([x, y], i) => (i === 0 ? s.moveTo(x, y) : s.lineTo(x, y)));
  const g = new THREE.ExtrudeGeometry(s, {
    depth, bevelEnabled: bevel > 0, bevelSize: bevel, bevelThickness: bevel, bevelSegments: 1, curveSegments: 4,
  });
  g.translate(0, 0, -depth / 2);
  return g;
}

export function disposeObject(o: THREE.Object3D): void {
  o.traverse((c) => {
    const mesh = c as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
  });
}
