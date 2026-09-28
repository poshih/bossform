import * as THREE from 'three';
import { fx } from '@metronome/engine';
import { BULLET_RADIUS, MAX_BULLETS, MAX_ORBS, MAX_SHOTS } from '../sim/index.ts';
import type { World } from '../sim/index.ts';

/** Bullet colours: [halo, core tint] per BulletColor index. */
const BULLET_COLORS: readonly number[] = [0xff3b4e, 0xff2e88, 0xffa030, 0x27e1ff, 0x9d6bff, 0xf2f8ff];

/** Visual size of a bullet relative to its hit radius, and its shape id in the shader. */
const BULLET_SCALE: readonly number[] = [2.1, 2.0, 1.75, 4.6, 1.7];
const BULLET_SHAPE: readonly number[] = [0, 0, 0, 1, 2];
const NEEDLE_ASPECT = 3.4;

/** Player shot visuals: [length, width, shape id, colour]. */
const SHOT_LOOK: ReadonlyArray<readonly [number, number, number, number]> = [
  [11, 3.2, 0, 0x9fe8ff], // Rifle
  [13, 4.6, 1, 0xffffff], // Missile
  [13, 2.2, 0, 0xffffff], // Needle
  [46, 30, 3, 0xffb84d], // Slash
  [11, 11, 2, 0xffa030], // Shell
  [12, 8, 4, 0xfff1a8], // Spread
  [13, 13, 5, 0x6fe8ff], // Blade
  [15, 5, 1, 0xffd9a0], // Rocket
  [8, 3, 0, 0x6fe8ff], // Bit
];

const ORB_SIZE = 6.5;
/** Shot shape ids that are rotationally symmetric and so ignore the flight direction. */
const SHAPE_ORB = 2;
const SHAPE_STAR = 5;

const VERT = /* glsl */ `
attribute float aShape;
varying vec2 vP;
varying float vShape;
varying vec3 vColor;
void main() {
  vP = position.xy * 2.0;
  vShape = aShape;
  vColor = instanceColor;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}`;

/** Enemy bullets are opaque and high-contrast: white core, saturated halo, so lanes stay readable. */
const BULLET_FRAG = /* glsl */ `
varying vec2 vP;
varying float vShape;
varying vec3 vColor;
void main() {
  float d;
  if (vShape < 0.5) d = length(vP);
  else if (vShape < 1.5) { vec2 q = vec2(vP.x / 1.0, vP.y * 2.4); d = length(vec2(max(abs(q.x) - 0.55, 0.0), q.y)); }
  else d = length(vP);
  if (d > 1.0) discard;
  vec3 halo = mix(vColor * 0.5, vColor, smoothstep(1.0, 0.55, d));
  float coreR = vShape < 1.5 ? 0.42 : 0.5;
  vec3 col = mix(halo, vec3(1.0), smoothstep(coreR, coreR - 0.22, d));
  if (vShape > 1.5) col = mix(col, vColor * 0.7, smoothstep(0.55, 0.75, d) * step(0.5, fract(atan(vP.y, vP.x) * 1.9099)));
  col *= 1.0 - 0.45 * smoothstep(0.86, 1.0, d);
  gl_FragColor = vec4(col, 1.0);
}`;

/** Player shots are additive light: they glow over everything and never hide enemy bullets. */
const SHOT_FRAG = /* glsl */ `
uniform float uTime;
varying vec2 vP;
varying float vShape;
varying vec3 vColor;
void main() {
  vec2 p = vP;
  float a = 0.0;
  vec3 hot = vec3(1.0);
  if (vShape < 0.5) {
    a = smoothstep(1.0, 0.0, abs(p.y) * 1.4) * smoothstep(1.0, 0.65, abs(p.x));
    a = pow(a, 1.4);
  } else if (vShape < 1.5) {
    float body = smoothstep(0.42, 0.28, abs(p.y)) * smoothstep(1.0, 0.75, p.x) * step(-0.3, p.x);
    float flame = smoothstep(0.7, 0.0, abs(p.y) * 1.6) * smoothstep(-1.0, -0.3, p.x) * step(p.x, -0.2);
    a = max(body, flame * 0.9);
    hot = mix(vec3(1.0, 0.55, 0.2), vec3(1.0), step(-0.3, p.x));
  } else if (vShape < 2.5) {
    float d = length(p);
    a = smoothstep(1.0, 0.2, d);
    hot = mix(vColor, vec3(1.0), smoothstep(0.6, 0.1, d));
  } else if (vShape < 3.5) {
    // Crescent: a disc with a bite taken out of its trailing side.
    float d1 = length(p * vec2(0.75, 1.0));
    float d2 = length((p - vec2(-0.42, 0.0)) * vec2(0.75, 1.0));
    a = smoothstep(1.0, 0.85, d1) * smoothstep(0.78, 0.92, d2);
    a *= 0.55 + 0.45 * smoothstep(0.2, 1.0, p.x);
    hot = mix(vColor, vec3(1.0), 0.6);
  } else if (vShape < 4.5) {
    float chev = abs(p.y) * 1.2 + p.x * 0.9;
    a = smoothstep(0.35, 0.05, abs(chev)) * smoothstep(1.0, 0.7, abs(p.x)) * smoothstep(1.0, 0.6, abs(p.y));
  } else {
    float ang = atan(p.y, p.x) + uTime * 14.0;
    float r = length(p);
    float star = 0.55 + 0.45 * cos(ang * 4.0);
    a = smoothstep(star, star - 0.25, r) * smoothstep(1.0, 0.2, r);
    hot = mix(vColor, vec3(1.0), smoothstep(0.7, 0.0, r));
  }
  if (a < 0.02) discard;
  gl_FragColor = vec4(mix(vColor, hot, 0.65) * a * 1.6, a);
}`;

const ORB_FRAG = /* glsl */ `
uniform float uTime;
varying vec2 vP;
varying float vShape;
varying vec3 vColor;
void main() {
  float d = abs(vP.x) + abs(vP.y);
  float pulse = 0.85 + 0.15 * sin(uTime * 9.0 + vShape * 6.283);
  float a = smoothstep(1.05, 0.15, d) * pulse;
  vec3 col = mix(vColor, vec3(1.0), smoothstep(0.55, 0.0, d));
  if (a < 0.02) discard;
  gl_FragColor = vec4(col * a * 1.5, a);
}`;

function makeMesh(capacity: number, frag: string, blending: THREE.Blending, extra?: Record<string, THREE.IUniform>): THREE.InstancedMesh {
  const geo = new THREE.PlaneGeometry(1, 1);
  const shape = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
  shape.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aShape', shape);
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: frag,
    transparent: blending !== THREE.NoBlending,
    blending,
    depthTest: false,
    depthWrite: false,
    uniforms: { uTime: { value: 0 }, ...extra },
  });
  const mesh = new THREE.InstancedMesh(geo, mat, capacity);
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
  mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.count = 0;
  return mesh;
}

const BULLET_Z = 4;
const SHOT_Z = 3;
const ORB_Z = 2.5;

/** Draws enemy bullets, player shots and energy orbs as three instanced batches read straight from the world. */
export class BulletsView {
  readonly group = new THREE.Group();
  private readonly bullets = makeMesh(MAX_BULLETS, BULLET_FRAG, THREE.NormalBlending);
  private readonly shots = makeMesh(MAX_SHOTS, SHOT_FRAG, THREE.AdditiveBlending);
  private readonly orbs = makeMesh(MAX_ORBS, ORB_FRAG, THREE.AdditiveBlending);
  private readonly dummy = new THREE.Object3D();
  private readonly palette = BULLET_COLORS.map((c) => new THREE.Color(c));
  private readonly shotColors = SHOT_LOOK.map((s) => new THREE.Color(s[3]));
  private readonly orbColor = new THREE.Color(0x6fe8ff);

  constructor() {
    this.bullets.renderOrder = 30;
    this.shots.renderOrder = 20;
    this.orbs.renderOrder = 25;
    this.group.add(this.shots, this.orbs, this.bullets);
  }

  update(world: World, alpha: number, timeSec: number): void {
    const { m } = world;
    const back = alpha - 1;
    const scale = 1 / fx.ONE;
    const d = this.dummy;

    // Enemy bullets
    let n = 0;
    const bShape = this.bullets.geometry.getAttribute('aShape') as THREE.InstancedBufferAttribute;
    for (let b = 0; b < MAX_BULLETS; b++) {
      if (m.bAlive[b] !== 1) continue;
      const kind = m.bKind[b];
      const vx = m.bVX[b] * scale;
      const vy = m.bVY[b] * scale;
      const radius = fx.toFloat(BULLET_RADIUS[kind]) * BULLET_SCALE[kind];
      d.position.set(m.bX[b] * scale + vx * back, m.bY[b] * scale + vy * back, BULLET_Z);
      d.rotation.z = BULLET_SHAPE[kind] === 1 ? Math.atan2(vy, vx) : 0;
      const shape = BULLET_SHAPE[kind];
      d.scale.set(shape === 1 ? radius * NEEDLE_ASPECT : radius * 2, radius * 2, 1);
      d.updateMatrix();
      this.bullets.setMatrixAt(n, d.matrix);
      this.bullets.setColorAt(n, this.palette[m.bColor[b]]);
      bShape.setX(n, shape);
      n++;
    }
    this.finish(this.bullets, bShape, n);

    // Player shots
    n = 0;
    const sShape = this.shots.geometry.getAttribute('aShape') as THREE.InstancedBufferAttribute;
    for (let s = 0; s < MAX_SHOTS; s++) {
      if (m.sAlive[s] !== 1) continue;
      const look = SHOT_LOOK[m.sKind[s]];
      const vx = m.sVX[s] * scale;
      const vy = m.sVY[s] * scale;
      d.position.set(m.sX[s] * scale + vx * back, m.sY[s] * scale + vy * back, SHOT_Z);
      d.rotation.z = look[2] === SHAPE_ORB || look[2] === SHAPE_STAR ? 0 : Math.atan2(vy, vx);
      d.scale.set(look[0], look[1], 1);
      d.updateMatrix();
      this.shots.setMatrixAt(n, d.matrix);
      this.shots.setColorAt(n, this.shotColors[m.sKind[s]]);
      sShape.setX(n, look[2]);
      n++;
    }
    this.finish(this.shots, sShape, n);
    (this.shots.material as THREE.ShaderMaterial).uniforms.uTime.value = timeSec;

    // Energy orbs
    n = 0;
    const oShape = this.orbs.geometry.getAttribute('aShape') as THREE.InstancedBufferAttribute;
    for (let o = 0; o < MAX_ORBS; o++) {
      if (m.oAlive[o] !== 1) continue;
      d.position.set(m.oX[o] * scale + m.oVX[o] * scale * back, m.oY[o] * scale + m.oVY[o] * scale * back, ORB_Z);
      d.rotation.z = 0;
      d.scale.set(ORB_SIZE, ORB_SIZE, 1);
      d.updateMatrix();
      this.orbs.setMatrixAt(n, d.matrix);
      this.orbs.setColorAt(n, this.orbColor);
      oShape.setX(n, o % 8);
      n++;
    }
    this.finish(this.orbs, oShape, n);
    (this.orbs.material as THREE.ShaderMaterial).uniforms.uTime.value = timeSec;
  }

  private finish(mesh: THREE.InstancedMesh, shape: THREE.InstancedBufferAttribute, count: number): void {
    mesh.count = count;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    shape.needsUpdate = true;
  }

  dispose(): void {
    for (const mesh of [this.bullets, this.shots, this.orbs]) {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      mesh.dispose();
    }
  }
}
