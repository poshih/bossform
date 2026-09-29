import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
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

export const DEFAULT_PIPELINE: PipelineOptions = { maxPixelRatio: 2, msaaSamples: 4, bloomStrength: 0.52, bloomRadius: 0.42, bloomThreshold: 0.92 };

/**
 * Full-resolution rendering: an anti-aliased half-float target (so bright edges can exceed 1), a soft bloom, and a
 * final pass that maps to the screen. No low-resolution target, dithering or scanlines anywhere.
 */
export class Pipeline {
  readonly renderer: THREE.WebGLRenderer;
  private readonly composer: EffectComposer;
  private readonly bloom: UnrealBloomPass;
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
    this.composer.addPass(new RenderPass(new THREE.Scene(), new THREE.PerspectiveCamera()));
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
  }

  /** Sizes are CSS pixels. */
  resize(width: number, height: number, devicePixelRatio: number): void {
    this.pixelRatio = Math.min(devicePixelRatio, this.options.maxPixelRatio);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(width, height, false);
    this.composer.setPixelRatio(this.pixelRatio);
    this.composer.setSize(width, height);
  }

  render(scene: THREE.Scene, camera: THREE.Camera, _post: PostInput): void {
    const pass = this.composer.passes[0] as RenderPass;
    pass.scene = scene;
    pass.camera = camera;
    this.composer.render();
  }

  dispose(): void {
    this.composer.dispose();
    this.renderer.dispose();
  }
}
