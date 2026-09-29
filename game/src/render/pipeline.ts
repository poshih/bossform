import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import type { Beat } from '../beat.ts';

export interface PipelineOptions {
  /** Cap on the device pixel ratio (rendering cost grows with its square). */
  readonly maxPixelRatio: number;
  readonly msaaSamples: number;
  readonly bloomStrength: number;
  readonly bloomRadius: number;
  readonly bloomThreshold: number;
}

/** What the frame's post-processing reacts to (built by the Stage each frame). */
export interface PostInput {
  /** 0..1 momentary impact from a big event near the camera (a punch instead of camera shake). */
  readonly punch: number;
  /** 0..1 an ultima is winding up: the arena darkens toward the threat. */
  readonly ultima: number;
  readonly beat: Beat;
  /** Presentation seconds (FrameContext.time). */
  readonly time: number;
}

const BLOOM_BEAT_LIFT = 0.025;
const BLOOM_PUNCH_LIFT = 0.045;
const POST_SHADER = {
  name: 'BossformFinishPass',
  uniforms: {
    tDiffuse: { value: null },
    uPunch: { value: 0 },
    uUltima: { value: 0 },
    uBeatPulse: { value: 0 },
    uBarPulse: { value: 0 },
    uTime: { value: 0 },
    uResolution: { value: new THREE.Vector2(4, 4) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uPunch;
    uniform float uUltima;
    uniform float uBeatPulse;
    uniform float uBarPulse;
    uniform float uTime;
    uniform vec2 uResolution;
    varying vec2 vUv;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
    }

    void main() {
      vec2 centre = vec2(0.5);
      vec2 fromCentre = vUv - centre;
      float radius = length(fromCentre);
      vec2 direction = fromCentre / max(radius, 0.001);
      float punch = clamp(uPunch, 0.0, 1.0);
      float chroma = (0.75 + radius * 1.8) * punch / max(uResolution.y, 1.0);
      vec2 split = direction * chroma * 2.2;
      vec4 base = texture2D(tDiffuse, vUv);
      vec3 color = base.rgb;
      // The punch costs four extra reads per pixel: only pay for them while a punch is on.
      if (punch > 0.0) {
        vec4 blurA = texture2D(tDiffuse, mix(vUv, centre, 0.010 * punch));
        vec4 blurB = texture2D(tDiffuse, mix(vUv, centre, 0.022 * punch));
        vec3 radialBlur = (base.rgb * 0.78 + blurA.rgb * 0.15 + blurB.rgb * 0.07);
        vec3 split3;
        split3.r = texture2D(tDiffuse, vUv + split).r;
        split3.g = radialBlur.g;
        split3.b = texture2D(tDiffuse, vUv - split).b;
        color = mix(base.rgb, split3, punch * 0.72);
      }
      float exposure = 1.0 + punch * 0.075 + uBeatPulse * 0.012 + uBarPulse * 0.008;
      color *= exposure;
      float vignette = smoothstep(0.22, 0.86, radius);
      float dim = uUltima * (0.20 + vignette * 0.33);
      float breathe = vignette * (0.025 + uBeatPulse * 0.025);
      color *= 1.0 - dim - breathe;
      float grain = hash(gl_FragCoord.xy + vec2(uTime * 37.0, uTime * 19.0)) - 0.5;
      color += grain * (0.006 + punch * 0.004);
      gl_FragColor = vec4(max(color, vec3(0.0)), base.a);
    }
  `,
} as const;

export const DEFAULT_PIPELINE: PipelineOptions = { maxPixelRatio: 2, msaaSamples: 4, bloomStrength: 0.50, bloomRadius: 0.30, bloomThreshold: 0.92 };

/**
 * Full-resolution rendering: an anti-aliased half-float target (so bright edges can exceed 1), a soft bloom, and a
 * final pass that maps to the screen. No low-resolution target, dithering or scanlines anywhere.
 */
export class Pipeline {
  readonly renderer: THREE.WebGLRenderer;
  private readonly composer: EffectComposer;
  private readonly bloom: UnrealBloomPass;
  private readonly finish: ShaderPass;
  private readonly options: PipelineOptions;
  private pixelRatio = 1;

  constructor(canvas: HTMLCanvasElement, options: PipelineOptions = DEFAULT_PIPELINE) {
    this.options = options;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance' });
    // Pure black: the arena floor draws its own deep colour, and anything else would be brightened by the output transform.
    this.renderer.setClearColor(0x000000, 1);
    const target = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: options.msaaSamples });
    this.composer = new EffectComposer(this.renderer, target);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(4, 4), options.bloomStrength, options.bloomRadius, options.bloomThreshold);
    this.finish = new ShaderPass(POST_SHADER);
    this.composer.addPass(new RenderPass(new THREE.Scene(), new THREE.PerspectiveCamera()));
    this.composer.addPass(this.bloom);
    this.composer.addPass(this.finish);
    this.composer.addPass(new OutputPass());
  }

  /** Sizes are CSS pixels. */
  resize(width: number, height: number, devicePixelRatio: number): void {
    this.pixelRatio = Math.min(devicePixelRatio, this.options.maxPixelRatio);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(width, height, false);
    this.composer.setPixelRatio(this.pixelRatio);
    this.composer.setSize(width, height);
    this.finish.uniforms.uResolution.value.set(width * this.pixelRatio, height * this.pixelRatio);
  }

  render(scene: THREE.Scene, camera: THREE.Camera, post: PostInput): void {
    const pass = this.composer.passes[0] as RenderPass;
    pass.scene = scene;
    pass.camera = camera;
    const pulse = post.beat.pulse;
    this.bloom.strength = this.options.bloomStrength * (1 + pulse * BLOOM_BEAT_LIFT + post.punch * BLOOM_PUNCH_LIFT);
    this.finish.uniforms.uPunch.value = post.punch;
    this.finish.uniforms.uUltima.value = post.ultima;
    this.finish.uniforms.uBeatPulse.value = pulse;
    this.finish.uniforms.uBarPulse.value = post.beat.barPulse;
    this.finish.uniforms.uTime.value = post.time;
    this.composer.render();
  }

  dispose(): void {
    this.composer.dispose();
    this.renderer.dispose();
  }
}
