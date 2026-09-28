import * as THREE from 'three';
import { fx } from '@metronome/engine';
import { Ev } from '../sim/index.ts';
import type { PostParams } from '../render/renderer.ts';

const MAX_PARTICLES = 2600;
const MAX_RINGS = 40;
const PARTICLE_Z = 6;
const RING_Z = 5.5;
const RAW = 1 / fx.ONE;

const PARTICLE_VERT = /* glsl */ `
attribute float aAlpha;
varying vec2 vP;
varying float vAlpha;
varying vec3 vColor;
void main() {
  vP = position.xy * 2.0;
  vAlpha = aAlpha;
  vColor = instanceColor;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}`;

const PARTICLE_FRAG = /* glsl */ `
varying vec2 vP;
varying float vAlpha;
varying vec3 vColor;
void main() {
  float d = length(vP);
  float a = smoothstep(1.0, 0.0, d) * vAlpha;
  if (a < 0.02) discard;
  gl_FragColor = vec4(mix(vColor, vec3(1.0), smoothstep(0.5, 0.0, d) * 0.6) * a * 1.4, a);
}`;

const RING_FRAG = /* glsl */ `
varying vec2 vP;
varying float vAlpha;
varying vec3 vColor;
void main() {
  float d = length(vP);
  float band = smoothstep(0.0, 0.08, d - 0.86 + 0.14 * (1.0 - vAlpha)) * smoothstep(1.0, 0.9, d);
  float a = band * vAlpha;
  if (a < 0.02) discard;
  gl_FragColor = vec4(vColor * a * 1.7, a);
}`;

function additiveQuads(capacity: number, fragment: string): THREE.InstancedMesh {
  const geo = new THREE.PlaneGeometry(1, 1);
  const alpha = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
  alpha.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aAlpha', alpha);
  const mat = new THREE.ShaderMaterial({
    vertexShader: PARTICLE_VERT,
    fragmentShader: fragment,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, capacity);
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
  mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.count = 0;
  return mesh;
}

interface BurstSpec {
  readonly count: number;
  readonly speed: number;
  readonly life: number;
  readonly size: number;
  readonly from: THREE.Color;
  readonly to: THREE.Color;
  readonly drag?: number;
  readonly stretch?: number;
  readonly spread?: number;
}

const c = (hex: number) => new THREE.Color(hex);
const HOT = c(0xfff2c0);
const EMBER = c(0x70140a);
const SPARK = c(0xbff4ff);
const CYAN = c(0x27e1ff);
const WHITE = c(0xffffff);
const RED = c(0xff3b4e);
const BLUE_DEEP = c(0x0a2a80);
const AMBER = c(0xffc34d);

/** Explosion look per size class (0 small .. 3 huge). */
const EXPLOSIONS: readonly BurstSpec[] = [
  { count: 12, speed: 1.6, life: 0.45, size: 5, from: HOT, to: EMBER, drag: 0.92 },
  { count: 22, speed: 2.4, life: 0.6, size: 7, from: HOT, to: EMBER, drag: 0.93 },
  { count: 40, speed: 3.2, life: 0.8, size: 10, from: HOT, to: EMBER, drag: 0.94 },
  { count: 90, speed: 4.6, life: 1.1, size: 16, from: HOT, to: EMBER, drag: 0.95 },
];
const EXPLOSION_RING: readonly number[] = [0, 18, 34, 64];
const EXPLOSION_SHAKE: readonly number[] = [0.4, 1.2, 2.6, 6];

const SHAKE_DECAY = 7;
const FLASH_DECAY = 4.5;
const GLITCH_DECAY = 3.2;
/** A hit twitches the picture rather than tearing it: the shader displaces slabs by up to 30px * glitch. */
const PLAYER_HIT_GLITCH = 0.22;
const RING_SPEED = 260;
const RING_LIFE = 0.9;

interface Ring {
  x: number;
  y: number;
  radius: number;
  maxRadius: number;
  age: number;
  life: number;
  color: THREE.Color;
}

/** Pooled particles, shockwave rings, screen shake and post-processing pulses, all driven by simulation events. */
export class FxSystem {
  readonly group = new THREE.Group();
  private readonly particles = additiveQuads(MAX_PARTICLES, PARTICLE_FRAG);
  private readonly ringMesh = additiveQuads(MAX_RINGS, RING_FRAG);
  private readonly px = new Float32Array(MAX_PARTICLES);
  private readonly py = new Float32Array(MAX_PARTICLES);
  private readonly vx = new Float32Array(MAX_PARTICLES);
  private readonly vy = new Float32Array(MAX_PARTICLES);
  private readonly life = new Float32Array(MAX_PARTICLES);
  private readonly maxLife = new Float32Array(MAX_PARTICLES);
  private readonly size = new Float32Array(MAX_PARTICLES);
  private readonly drag = new Float32Array(MAX_PARTICLES);
  private readonly stretch = new Float32Array(MAX_PARTICLES);
  private readonly fromR = new Float32Array(MAX_PARTICLES * 3);
  private readonly toR = new Float32Array(MAX_PARTICLES * 3);
  private cursor = 0;
  private readonly rings: Ring[] = [];
  private readonly dummy = new THREE.Object3D();
  private readonly tmp = new THREE.Color();

  shake = 0;
  private flash = 0;
  private glitch = 0;
  private zoom = 0;
  private zoomX = 0;
  private zoomY = 0;
  private sphereRadius = 0;
  private sphereX = 0;
  private sphereY = 0;
  private sphereActive = false;
  private wave = 0;
  private lastGraze = 0;
  private lastSpark = 0;
  bossTint = 0;

  constructor() {
    this.particles.renderOrder = 40;
    this.ringMesh.renderOrder = 38;
    this.group.add(this.ringMesh, this.particles);
  }

  // ---- spawning -------------------------------------------------------------------------------------

  burst(x: number, y: number, spec: BurstSpec): void {
    const spread = spec.spread ?? Math.PI * 2;
    for (let i = 0; i < spec.count; i++) {
      const p = this.cursor;
      this.cursor = (this.cursor + 1) % MAX_PARTICLES;
      const ang = Math.random() * spread;
      const spd = spec.speed * (0.25 + Math.random() * 0.9);
      this.px[p] = x;
      this.py[p] = y;
      this.vx[p] = Math.cos(ang) * spd;
      this.vy[p] = Math.sin(ang) * spd;
      this.maxLife[p] = this.life[p] = spec.life * (0.6 + Math.random() * 0.6);
      this.size[p] = spec.size * (0.5 + Math.random() * 0.7);
      this.drag[p] = spec.drag ?? 0.95;
      this.stretch[p] = spec.stretch ?? 0;
      this.fromR.set([spec.from.r, spec.from.g, spec.from.b], p * 3);
      this.toR.set([spec.to.r, spec.to.g, spec.to.b], p * 3);
    }
  }

  ring(x: number, y: number, maxRadius: number, color: THREE.Color, life = RING_LIFE): void {
    if (this.rings.length >= MAX_RINGS) this.rings.shift();
    this.rings.push({ x, y, radius: 0, maxRadius, age: 0, life, color });
  }

  addShake(amount: number): void {
    this.shake = Math.min(9, this.shake + amount);
  }

  // ---- event mapping --------------------------------------------------------------------------------

  handle(type: number, rawX: number, rawY: number, a: number): void {
    const x = rawX * RAW;
    const y = rawY * RAW;
    switch (type) {
      case Ev.EnemyHit:
      case Ev.BossHit:
        if (this.lastSpark++ % 2 === 0) this.burst(x, y, { count: 2, speed: 2.6, life: 0.22, size: 2.4, from: SPARK, to: BLUE_DEEP, drag: 0.9 });
        break;
      case Ev.EnemyKilled:
        this.burst(x, y, EXPLOSIONS[a]);
        if (EXPLOSION_RING[a] > 0) this.ring(x, y, EXPLOSION_RING[a], AMBER, 0.5);
        this.addShake(EXPLOSION_SHAKE[a]);
        break;
      case Ev.Explosion:
        this.burst(x, y, EXPLOSIONS[a]);
        this.ring(x, y, EXPLOSION_RING[a], AMBER, 0.6);
        this.addShake(EXPLOSION_SHAKE[a]);
        if (a === 3) this.flash = Math.max(this.flash, 0.9);
        break;
      case Ev.BossDefeated:
        this.flash = 1;
        this.addShake(8);
        break;
      case Ev.PlayerHit:
        this.burst(x, y, { count: 16, speed: 3, life: 0.4, size: 4, from: WHITE, to: RED, drag: 0.92 });
        this.glitch = Math.max(this.glitch, PLAYER_HIT_GLITCH);
        this.flash = Math.max(this.flash, 0.22);
        this.addShake(3);
        break;
      case Ev.PlayerDeath:
        this.burst(x, y, EXPLOSIONS[2]);
        this.ring(x, y, 70, RED, 0.8);
        this.flash = 0.8;
        this.addShake(7);
        break;
      case Ev.PlayerRespawn:
        this.ring(x, y, 60, CYAN, 0.7);
        break;
      case Ev.Graze:
        if (performance.now() - this.lastGraze > 30) {
          this.lastGraze = performance.now();
          this.burst(x, y, { count: 2, speed: 1.4, life: 0.25, size: 1.8, from: CYAN, to: BLUE_DEEP, drag: 0.9 });
        }
        break;
      case Ev.OrbPickup:
        this.burst(x, y, { count: 3, speed: 1.6, life: 0.3, size: 2.4, from: SPARK, to: CYAN, drag: 0.9 });
        break;
      case Ev.Absorb:
        this.burst(x, y, { count: 3, speed: 1.2, life: 0.28, size: 2.2, from: WHITE, to: AMBER, drag: 0.9 });
        break;
      case Ev.TransformStart:
        this.zoomX = x;
        this.zoomY = y;
        this.zoom = 0.02;
        this.ring(x, y, 46, CYAN, 0.7);
        this.addShake(1.5);
        break;
      case Ev.TransformDone:
        this.sphereActive = true;
        this.sphereRadius = 8;
        this.sphereX = x;
        this.sphereY = y;
        this.flash = 1;
        this.addShake(7);
        this.ring(x, y, 170, WHITE, 0.9);
        this.ring(x, y, 120, AMBER, 0.7);
        this.burst(x, y, { count: 70, speed: 5.5, life: 0.9, size: 5, from: WHITE, to: AMBER, drag: 0.94 });
        break;
      case Ev.BossModeEnd:
        this.ring(x, y, 120, CYAN, 0.6);
        this.flash = Math.max(this.flash, 0.5);
        this.addShake(3);
        break;
      case Ev.BulletsCleared:
        if (a > 0 && a < fx.fromInt(400)) this.ring(x, y, a * RAW, WHITE, 0.45);
        else this.flash = Math.max(this.flash, 0.6);
        break;
      case Ev.ShellBurst:
        this.burst(x, y, { count: 14, speed: 2.8, life: 0.4, size: 5, from: HOT, to: EMBER, drag: 0.92 });
        this.ring(x, y, a * RAW, AMBER, 0.35);
        this.addShake(0.8);
        break;
      case Ev.BladeStorm:
        this.ring(x, y, 90, CYAN, 0.5);
        this.burst(x, y, { count: 24, speed: 4, life: 0.4, size: 3, from: SPARK, to: CYAN, drag: 0.92 });
        break;
      case Ev.Dash:
        this.burst(x, y, { count: 12, speed: 2, life: 0.3, size: 3, from: RED, to: EMBER, drag: 0.9 });
        break;
      case Ev.ShieldUp:
        this.ring(x, y, 40, AMBER, 0.4);
        break;
      case Ev.MissileLaunch:
        this.burst(x, y, { count: 8, speed: 1.6, life: 0.4, size: 4, from: WHITE, to: EMBER, drag: 0.92 });
        break;
      case Ev.BossPhase:
        this.wave = 1;
        this.flash = Math.max(this.flash, 0.7);
        this.addShake(5);
        this.ring(x, y, 200, RED, 0.9);
        break;
      case Ev.GaugeFull:
        this.ring(x, y, 34, AMBER, 0.6);
        this.burst(x, y, { count: 14, speed: 2.4, life: 0.5, size: 3, from: WHITE, to: AMBER, drag: 0.92 });
        break;
      case Ev.GameOver:
        this.glitch = 0.6;
        this.addShake(4);
        break;
      default:
        break;
    }
  }

  // ---- per-frame update -----------------------------------------------------------------------------

  update(dt: number, transforming: boolean): void {
    const step = dt * 60;
    const d = this.dummy;
    const color = this.tmp;
    const alpha = this.particles.geometry.getAttribute('aAlpha') as THREE.InstancedBufferAttribute;
    let n = 0;
    for (let p = 0; p < MAX_PARTICLES; p++) {
      if (this.life[p] <= 0) continue;
      this.life[p] -= dt;
      if (this.life[p] <= 0) continue;
      const drag = Math.pow(this.drag[p], step);
      this.vx[p] *= drag;
      this.vy[p] *= drag;
      this.px[p] += this.vx[p] * step;
      this.py[p] += this.vy[p] * step;
      const t = 1 - this.life[p] / this.maxLife[p];
      const speed = Math.hypot(this.vx[p], this.vy[p]);
      const s = this.size[p] * (1 - t * 0.5);
      d.position.set(this.px[p], this.py[p], PARTICLE_Z);
      d.rotation.z = Math.atan2(this.vy[p], this.vx[p]);
      d.scale.set(s * (1 + this.stretch[p] * speed), s, 1);
      d.updateMatrix();
      this.particles.setMatrixAt(n, d.matrix);
      color.setRGB(
        this.fromR[p * 3] + (this.toR[p * 3] - this.fromR[p * 3]) * t,
        this.fromR[p * 3 + 1] + (this.toR[p * 3 + 1] - this.fromR[p * 3 + 1]) * t,
        this.fromR[p * 3 + 2] + (this.toR[p * 3 + 2] - this.fromR[p * 3 + 2]) * t,
      );
      this.particles.setColorAt(n, color);
      alpha.setX(n, 1 - t * t);
      n++;
    }
    this.particles.count = n;
    this.particles.instanceMatrix.needsUpdate = true;
    if (this.particles.instanceColor) this.particles.instanceColor.needsUpdate = true;
    alpha.needsUpdate = true;

    const ringAlpha = this.ringMesh.geometry.getAttribute('aAlpha') as THREE.InstancedBufferAttribute;
    let r = 0;
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const ring = this.rings[i];
      ring.age += dt;
      if (ring.age >= ring.life) {
        this.rings.splice(i, 1);
        continue;
      }
    }
    for (const ring of this.rings) {
      const t = ring.age / ring.life;
      const eased = 1 - (1 - t) * (1 - t);
      ring.radius = ring.maxRadius * eased;
      d.position.set(ring.x, ring.y, RING_Z);
      d.rotation.z = 0;
      d.scale.set(ring.radius * 2 + 2, ring.radius * 2 + 2, 1);
      d.updateMatrix();
      this.ringMesh.setMatrixAt(r, d.matrix);
      this.ringMesh.setColorAt(r, ring.color);
      ringAlpha.setX(r, 1 - t);
      r++;
    }
    this.ringMesh.count = r;
    this.ringMesh.instanceMatrix.needsUpdate = true;
    if (this.ringMesh.instanceColor) this.ringMesh.instanceColor.needsUpdate = true;
    ringAlpha.needsUpdate = true;

    this.shake *= Math.exp(-SHAKE_DECAY * dt);
    this.flash = Math.max(0, this.flash - FLASH_DECAY * dt);
    this.glitch = Math.max(0, this.glitch - GLITCH_DECAY * dt);
    this.wave = Math.max(0, this.wave - 1.4 * dt);
    if (transforming) this.zoom = Math.min(0.09, this.zoom + 0.09 * dt);
    else this.zoom = Math.max(0, this.zoom - 0.5 * dt);
    if (this.sphereActive) {
      this.sphereRadius += RING_SPEED * dt;
      if (this.sphereRadius > 430) this.sphereActive = false;
    }
  }

  /** Writes this frame's screen effects into the renderer's post-processing parameters. */
  applyPost(post: PostParams, shakeOut: { x: number; y: number }): void {
    post.flash = this.flash;
    post.glitch = this.glitch;
    post.zoom = this.zoom;
    post.zoomX = this.zoomX;
    post.zoomY = this.zoomY;
    post.wave = this.wave * 5;
    post.waveFreq = 0.35;
    post.waveSpeed = 9;
    post.waveY0 = 0;
    post.waveY1 = 1;
    post.chroma = 0.35 + this.glitch * 1.2 + this.flash * 0.6;
    post.ringR = this.sphereActive ? this.sphereRadius : 0;
    post.ringX = this.sphereX;
    post.ringY = this.sphereY;
    post.ringInvert = this.sphereActive ? Math.max(0, 1 - this.sphereRadius / 430) * 0.85 : 0;
    post.ringEdge = this.sphereActive ? 10 : 0;
    post.tintAmt = this.bossTint * 0.22;
    post.tint.setRGB(1.0, 0.82, 0.62);
    const amp = this.shake;
    shakeOut.x = (Math.random() * 2 - 1) * amp;
    shakeOut.y = (Math.random() * 2 - 1) * amp;
  }

  dispose(): void {
    for (const mesh of [this.particles, this.ringMesh]) {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      mesh.dispose();
    }
  }
}
