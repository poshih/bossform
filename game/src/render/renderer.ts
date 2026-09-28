import * as THREE from 'three';
import { LOWRES_TARGET_H, MAX_DPR, PLAY_H, PLAY_W } from '../config.ts';

/** Post-processing controls, written by the game every frame (all "16-bit" raster effects live here). */
export interface PostParams {
  wave: number;
  waveFreq: number;
  waveSpeed: number;
  waveY0: number;
  waveY1: number;
  mosaic: number;
  vhs: number;
  mono: number;
  invert: number;
  tint: THREE.Color;
  tintAmt: number;
  flash: number;
  chroma: number;
  bloom: number;
  fade: number;
  glitch: number;
  levels: number;
  dither: number;
  crt: number;
  vignette: number;
  /** Time-stop sphere: centre in world units, radius in world units, inversion + edge refraction. */
  ringX: number;
  ringY: number;
  ringR: number;
  ringInvert: number;
  ringEdge: number;
  /** Radial zoom blur toward a world-space centre. */
  zoom: number;
  zoomX: number;
  zoomY: number;
}

export function defaultPost(): PostParams {
  return {
    wave: 0, waveFreq: 0.23, waveSpeed: 3, waveY0: 0, waveY1: 1,
    mosaic: 1, vhs: 0, mono: 0, invert: 0, tint: new THREE.Color(1, 1, 1), tintAmt: 0,
    flash: 0, chroma: 0.35, bloom: 0.9, fade: 0, glitch: 0, levels: 15, dither: 1, crt: 1, vignette: 0.35,
    ringX: 0, ringY: 0, ringR: 0, ringInvert: 0, ringEdge: 0, zoom: 0, zoomX: 0, zoomY: 0,
  };
}

const FULLSCREEN_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const BRIGHT_FRAG = /* glsl */ `
uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uThreshold;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tSrc, vUv + uTexel * vec2(-0.5, -0.5)).rgb + texture2D(tSrc, vUv + uTexel * vec2(0.5, -0.5)).rgb
         + texture2D(tSrc, vUv + uTexel * vec2(-0.5, 0.5)).rgb + texture2D(tSrc, vUv + uTexel * vec2(0.5, 0.5)).rgb;
  c *= 0.25;
  float l = max(c.r, max(c.g, c.b));
  gl_FragColor = vec4(c * smoothstep(uThreshold, uThreshold + 0.35, l), 1.0);
}`;

const BLUR_FRAG = /* glsl */ `
uniform sampler2D tSrc; uniform vec2 uDir;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tSrc, vUv).rgb * 0.2270270;
  c += texture2D(tSrc, vUv + uDir * 1.3846153).rgb * 0.3162162;
  c += texture2D(tSrc, vUv - uDir * 1.3846153).rgb * 0.3162162;
  c += texture2D(tSrc, vUv + uDir * 3.2307692).rgb * 0.0702702;
  c += texture2D(tSrc, vUv - uDir * 3.2307692).rgb * 0.0702702;
  gl_FragColor = vec4(c, 1.0);
}`;

const COMPOSITE_FRAG = /* glsl */ `
uniform sampler2D tScene; uniform sampler2D tBloom;
uniform vec2 uRes; uniform float uTime;
uniform float uWave, uWaveFreq, uWaveSpeed, uWaveY0, uWaveY1;
uniform float uMosaic, uVhs, uMono, uInvert, uFlash, uChroma, uBloom, uFade, uGlitch, uLevels, uDither, uVignette;
uniform vec3 uTint; uniform float uTintAmt;
uniform vec3 uRing; uniform float uRingInvert, uRingEdge;
uniform float uZoom; uniform vec2 uZoomC;
varying vec2 vUv;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float bayer4(vec2 p) {
  vec2 q = mod(p, 4.0);
  float x = q.x, y = q.y;
  float v = 0.0;
  if (y < 1.0) v = x < 1.0 ? 0.0 : x < 2.0 ? 8.0 : x < 3.0 ? 2.0 : 10.0;
  else if (y < 2.0) v = x < 1.0 ? 12.0 : x < 2.0 ? 4.0 : x < 3.0 ? 14.0 : 6.0;
  else if (y < 3.0) v = x < 1.0 ? 3.0 : x < 2.0 ? 11.0 : x < 3.0 ? 1.0 : 9.0;
  else v = x < 1.0 ? 15.0 : x < 2.0 ? 7.0 : x < 3.0 ? 13.0 : 5.0;
  return (v + 0.5) / 16.0;
}
vec3 toSRGB(vec3 c) { return pow(clamp(c, 0.0, 1.0), vec3(1.0 / 2.2)); }

void main() {
  vec2 px = vUv * uRes;
  if (uMosaic > 1.0) px = (floor(px / uMosaic) + 0.5) * uMosaic;
  float line = floor(px.y);
  // HDMA-style per-scanline horizontal offset.
  float region = step(uWaveY0 * uRes.y, px.y) * step(px.y, uWaveY1 * uRes.y);
  float off = uWave * region * sin(line * uWaveFreq + uTime * uWaveSpeed);
  // VHS rewind: tracking jitter, a rolling tear band and head-switch noise at the bottom.
  if (uVhs > 0.0) {
    float t = floor(uTime * 30.0);
    off += uVhs * (hash(vec2(line, t)) - 0.5) * 3.0;
    float bandY = fract(uTime * 0.37) * uRes.y * 1.3 - uRes.y * 0.15;
    float band = exp(-pow((px.y - bandY) / 6.0, 2.0));
    off += uVhs * band * (8.0 + 6.0 * hash(vec2(t, 3.0)));
    float head = step(px.y, uRes.y * 0.04);
    off += uVhs * head * (hash(vec2(line, t + 7.0)) * 14.0);
  }
  // Paradox glitch: displaced horizontal slabs.
  if (uGlitch > 0.0) {
    float slab = floor(px.y / 7.0);
    float g = hash(vec2(slab, floor(uTime * 24.0)));
    off += step(1.0 - uGlitch * 0.55, g) * (g - 0.5) * 60.0 * uGlitch;
  }
  px.x += off;
  // Time-stop sphere: refract the pixels around its edge.
  float ringD = distance(px, uRing.xy);
  if (uRing.z > 0.0) {
    float edge = exp(-pow((ringD - uRing.z) / 7.0, 2.0));
    px += normalize(px - uRing.xy + 0.001) * edge * uRingEdge;
  }
  vec2 uv = px / uRes;
  float ch = (uChroma + uVhs * 1.6 + uGlitch * 3.0) / uRes.x;
  vec3 col;
  col.r = texture2D(tScene, uv + vec2(ch, 0.0)).r;
  col.g = texture2D(tScene, uv).g;
  col.b = texture2D(tScene, uv - vec2(ch, 0.0)).b;
  if (uZoom > 0.0) {
    vec2 dir = (uv - uZoomC) * uZoom;
    vec3 acc = col;
    for (int i = 1; i < 7; i++) acc += texture2D(tScene, uv - dir * float(i) / 6.0).rgb;
    col = acc / 7.0;
  }
  col += texture2D(tBloom, uv).rgb * uBloom;
  float l = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(col, vec3(l), clamp(uMono, 0.0, 1.0));
  col = mix(col, col * uTint, uTintAmt);
  vec3 s = toSRGB(col);
  s = mix(s, 1.0 - s, uInvert);
  if (uRing.z > 0.0) {
    float inside = 1.0 - smoothstep(uRing.z - 1.0, uRing.z + 1.0, ringD);
    float ls = dot(s, vec3(0.299, 0.587, 0.114));
    vec3 negative = vec3(1.0 - ls) * vec3(0.55, 0.68, 0.82);
    s = mix(s, negative, inside * uRingInvert);
    s += vec3(0.5, 0.9, 1.0) * exp(-pow((ringD - uRing.z) / 2.0, 2.0)) * uRingInvert;
  }
  if (uVhs > 0.0) {
    float t = floor(uTime * 30.0);
    s += uVhs * (hash(px + t) - 0.5) * 0.16;
    s = mix(s, s * vec3(0.92, 1.02, 1.08), uVhs * 0.6);
  }
  vec2 q = vUv - 0.5;
  s *= 1.0 - uVignette * dot(q, q) * 1.6;
  s = mix(s, vec3(1.0), clamp(uFlash, 0.0, 1.0));
  s *= 1.0 - clamp(uFade, 0.0, 1.0);
  // Quantise to a limited-depth palette with ordered dithering.
  float d = (bayer4(floor(vUv * uRes)) - 0.5) * uDither;
  s = floor(clamp(s, 0.0, 1.0) * uLevels + 0.5 + d) / uLevels;
  gl_FragColor = vec4(clamp(s, 0.0, 1.0), 1.0);
}`;

const FINAL_FRAG = /* glsl */ `
uniform sampler2D tComp; uniform sampler2D tUI;
uniform vec2 uLowRes; uniform float uPixelScale; uniform float uCrt;
varying vec2 vUv;
void main() {
  vec2 uv = gl_FragCoord.xy / (uLowRes * uPixelScale);
  vec3 c = texture2D(tComp, uv).rgb;
  vec4 ui = texture2D(tUI, vec2(uv.x, 1.0 - uv.y));
  c = mix(c, ui.rgb, ui.a);
  if (uCrt > 0.0 && uPixelScale >= 2.0) {
    float row = fract(gl_FragCoord.y / uPixelScale);
    float dark = uPixelScale >= 3.0 ? step(row, 1.0 / uPixelScale) : step(row, 0.5);
    c *= 1.0 - uCrt * 0.24 * dark;
    float m = mod(gl_FragCoord.x, 3.0);
    vec3 mask = m < 1.0 ? vec3(1.0, 0.94, 0.94) : m < 2.0 ? vec3(0.94, 1.0, 0.94) : vec3(0.94, 0.94, 1.0);
    c *= mix(vec3(1.0), mask, uCrt * 0.6);
    c *= 1.0 + uCrt * 0.06;
  }
  gl_FragColor = vec4(c, 1.0);
}`;

function makeRT(w: number, h: number, type: THREE.TextureDataType, filter: THREE.MagnificationTextureFilter, depth: boolean) {
  const rt = new THREE.WebGLRenderTarget(w, h, {
    type,
    format: THREE.RGBAFormat,
    minFilter: filter,
    magFilter: filter,
    depthBuffer: depth,
    stencilBuffer: false,
    generateMipmaps: false,
  });
  rt.texture.colorSpace = THREE.NoColorSpace;
  return rt;
}

export interface ViewMetrics {
  cssW: number;
  cssH: number;
  devW: number;
  devH: number;
  dpr: number;
  pixelScale: number;
  lowW: number;
  lowH: number;
  /** Device pixels per world unit at the z=0 gameplay plane. */
  fit: number;
  /** World units per low-res pixel. */
  unitsPerPx: number;
  /** World units per CSS pixel (pointer motion → world). */
  unitsPerCss: number;
  /** Visible world extents at z=0. */
  viewW: number;
  viewH: number;
}

export const CAMERA_FOV = 32;

export class Renderer {
  readonly gl: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(CAMERA_FOV, 16 / 9, 20, 30000);
  readonly post: PostParams = defaultPost();
  readonly uiCanvas: HTMLCanvasElement;
  readonly ui: CanvasRenderingContext2D;
  readonly metrics: ViewMetrics = {
    cssW: 1, cssH: 1, devW: 1, devH: 1, dpr: 1, pixelScale: 1, lowW: 1, lowH: 1, fit: 1, unitsPerPx: 1, unitsPerCss: 1, viewW: PLAY_W, viewH: PLAY_H,
  };
  /** Background pass: a fullscreen material drawn before the 3D scene (null = clear only). */
  background: THREE.ShaderMaterial | null = null;
  readonly bgUniforms = {
    uTime: { value: 0 },
    uRes: { value: new THREE.Vector2(1, 1) },
    uView: { value: new THREE.Vector2(PLAY_W, PLAY_H) },
    uCam: { value: new THREE.Vector2(0, 0) },
  };
  shakeX = 0;
  shakeY = 0;
  private readonly tmpPt = { x: 0, y: 0 };

  private sceneRT: THREE.WebGLRenderTarget;
  private bloomA: THREE.WebGLRenderTarget;
  private bloomB: THREE.WebGLRenderTarget;
  private compRT: THREE.WebGLRenderTarget;
  private readonly uiTexture: THREE.CanvasTexture;
  private readonly quadScene = new THREE.Scene();
  private readonly quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly quad: THREE.Mesh;
  private readonly bgQuad: THREE.Mesh;
  private readonly bgScene = new THREE.Scene();
  private readonly brightMat: THREE.ShaderMaterial;
  private readonly blurMat: THREE.ShaderMaterial;
  private readonly compMat: THREE.ShaderMaterial;
  private readonly finalMat: THREE.ShaderMaterial;
  private readonly clearColor = new THREE.Color(0x03040a);

  constructor(canvas: HTMLCanvasElement) {
    this.gl = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance', stencil: false });
    this.gl.setPixelRatio(1);
    this.gl.autoClear = false;
    this.gl.toneMapping = THREE.NoToneMapping;
    this.gl.outputColorSpace = THREE.LinearSRGBColorSpace;

    this.sceneRT = makeRT(4, 4, THREE.HalfFloatType, THREE.NearestFilter, true);
    this.bloomA = makeRT(2, 2, THREE.HalfFloatType, THREE.LinearFilter, false);
    this.bloomB = makeRT(2, 2, THREE.HalfFloatType, THREE.LinearFilter, false);
    this.compRT = makeRT(4, 4, THREE.UnsignedByteType, THREE.NearestFilter, false);

    this.uiCanvas = document.createElement('canvas');
    this.uiCanvas.width = 4;
    this.uiCanvas.height = 4;
    this.ui = this.uiCanvas.getContext('2d')!;
    this.uiTexture = new THREE.CanvasTexture(this.uiCanvas);
    this.uiTexture.colorSpace = THREE.NoColorSpace;
    this.uiTexture.minFilter = THREE.NearestFilter;
    this.uiTexture.magFilter = THREE.NearestFilter;
    this.uiTexture.generateMipmaps = false;
    this.uiTexture.flipY = false;

    const tri = new THREE.BufferGeometry();
    tri.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    tri.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));

    this.brightMat = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT, fragmentShader: BRIGHT_FRAG, depthTest: false, depthWrite: false,
      uniforms: { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uThreshold: { value: 0.78 } },
    });
    this.blurMat = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT, fragmentShader: BLUR_FRAG, depthTest: false, depthWrite: false,
      uniforms: { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } },
    });
    this.compMat = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT, fragmentShader: COMPOSITE_FRAG, depthTest: false, depthWrite: false,
      uniforms: {
        tScene: { value: null }, tBloom: { value: null }, uRes: { value: new THREE.Vector2() }, uTime: { value: 0 },
        uWave: { value: 0 }, uWaveFreq: { value: 0 }, uWaveSpeed: { value: 0 }, uWaveY0: { value: 0 }, uWaveY1: { value: 1 },
        uMosaic: { value: 1 }, uVhs: { value: 0 }, uMono: { value: 0 }, uInvert: { value: 0 }, uFlash: { value: 0 },
        uChroma: { value: 0 }, uBloom: { value: 1 }, uFade: { value: 0 }, uGlitch: { value: 0 }, uLevels: { value: 15 },
        uDither: { value: 1 }, uVignette: { value: 0.3 }, uTint: { value: new THREE.Color(1, 1, 1) }, uTintAmt: { value: 0 },
        uRing: { value: new THREE.Vector3() }, uRingInvert: { value: 0 }, uRingEdge: { value: 0 },
        uZoom: { value: 0 }, uZoomC: { value: new THREE.Vector2(0.5, 0.5) },
      },
    });
    this.finalMat = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT, fragmentShader: FINAL_FRAG, depthTest: false, depthWrite: false,
      uniforms: {
        tComp: { value: null }, tUI: { value: this.uiTexture }, uLowRes: { value: new THREE.Vector2() },
        uPixelScale: { value: 1 }, uCrt: { value: 1 },
      },
    });
    this.quad = new THREE.Mesh(tri, this.brightMat);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
    this.bgQuad = new THREE.Mesh(tri, this.brightMat);
    this.bgQuad.frustumCulled = false;
    this.bgScene.add(this.bgQuad);
    this.scene.background = null;
  }

  /** Recomputes every size-derived buffer from the container's current CSS size (never reloads assets). */
  resize(cssW: number, cssH: number): void {
    const m = this.metrics;
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const devW = Math.max(2, Math.round(cssW * dpr));
    const devH = Math.max(2, Math.round(cssH * dpr));
    const fit = Math.min(devW / PLAY_W, devH / PLAY_H);
    const pixelScale = Math.max(1, Math.round((PLAY_H * fit) / LOWRES_TARGET_H));
    const lowW = Math.ceil(devW / pixelScale);
    const lowH = Math.ceil(devH / pixelScale);
    Object.assign(m, {
      cssW, cssH, devW, devH, dpr, pixelScale, lowW, lowH, fit,
      unitsPerPx: pixelScale / fit, unitsPerCss: dpr / fit, viewW: (lowW * pixelScale) / fit, viewH: (lowH * pixelScale) / fit,
    });
    this.gl.setSize(devW, devH, false);
    const canvas = this.gl.domElement;
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    this.sceneRT.setSize(lowW, lowH);
    this.compRT.setSize(lowW, lowH);
    const bw = Math.max(1, Math.ceil(lowW / 2));
    const bh = Math.max(1, Math.ceil(lowH / 2));
    this.bloomA.setSize(bw, bh);
    this.bloomB.setSize(bw, bh);
    this.uiCanvas.width = lowW;
    this.uiCanvas.height = lowH;
    this.ui.imageSmoothingEnabled = false;
    this.uiTexture.dispose();
    this.uiTexture.needsUpdate = true;

    this.camera.aspect = lowW / lowH;
    this.camera.fov = CAMERA_FOV;
    this.camera.updateProjectionMatrix();
    this.bgUniforms.uRes.value.set(lowW, lowH);
    this.bgUniforms.uView.value.set(m.viewW, m.viewH);
  }

  /** Camera distance so the z=0 plane shows exactly viewH world units. */
  cameraDistance(): number {
    return this.metrics.viewH / 2 / Math.tan(THREE.MathUtils.degToRad(CAMERA_FOV / 2));
  }

  /** World (z=0) → low-res UI pixel (y down). */
  worldToUi(x: number, y: number, out: { x: number; y: number }): { x: number; y: number } {
    const m = this.metrics;
    out.x = m.lowW / 2 + (x - this.shakeX) / m.unitsPerPx;
    out.y = m.lowH / 2 - (y - this.shakeY) / m.unitsPerPx;
    return out;
  }

  /** The playfield rectangle in low-res UI pixels. */
  playfieldUi(): { x: number; y: number; w: number; h: number } {
    const m = this.metrics;
    const w = PLAY_W / m.unitsPerPx;
    const h = PLAY_H / m.unitsPerPx;
    return { x: Math.round((m.lowW - w) / 2), y: Math.round((m.lowH - h) / 2), w: Math.round(w), h: Math.round(h) };
  }

  /** CSS client coordinates → low-res UI pixel (y down), matching the final upscale pass exactly. */
  clientToUi(cx: number, cy: number, rect: DOMRect): { x: number; y: number } {
    const m = this.metrics;
    const dx = (cx - rect.left) * m.dpr;
    const dyFromBottom = m.devH - (cy - rect.top) * m.dpr;
    return { x: dx / m.pixelScale, y: m.lowH - dyFromBottom / m.pixelScale };
  }

  /** Compiles a fullscreen background material ahead of its first use. */
  compileBackground(mat: THREE.ShaderMaterial): void {
    this.bgQuad.material = mat;
    this.gl.compile(this.bgScene, this.quadCam);
  }

  markUiDirty(): void {
    this.uiTexture.needsUpdate = true;
  }

  render(timeSec: number): void {
    const gl = this.gl;
    const m = this.metrics;
    const p = this.post;
    const dist = this.cameraDistance();
    this.camera.position.set(this.shakeX, this.shakeY, dist);
    this.camera.lookAt(this.shakeX, this.shakeY, 0);
    this.bgUniforms.uTime.value = timeSec;
    this.bgUniforms.uCam.value.set(this.shakeX, this.shakeY);

    // 1) background + scene into the low-res target
    gl.setRenderTarget(this.sceneRT);
    gl.setClearColor(this.clearColor, 1);
    gl.clear(true, true, false);
    if (this.background) {
      this.bgQuad.material = this.background;
      gl.render(this.bgScene, this.quadCam);
    }
    gl.render(this.scene, this.camera);

    // 2) bloom: bright pass at half resolution, then separable blur twice
    const bw = this.bloomA.width;
    const bh = this.bloomA.height;
    this.quad.material = this.brightMat;
    this.brightMat.uniforms.tSrc.value = this.sceneRT.texture;
    this.brightMat.uniforms.uTexel.value.set(1 / m.lowW, 1 / m.lowH);
    gl.setRenderTarget(this.bloomA);
    gl.render(this.quadScene, this.quadCam);
    this.quad.material = this.blurMat;
    for (let i = 0; i < 2; i++) {
      this.blurMat.uniforms.tSrc.value = this.bloomA.texture;
      this.blurMat.uniforms.uDir.value.set((0.6 + i * 0.5) / bw, 0);
      gl.setRenderTarget(this.bloomB);
      gl.render(this.quadScene, this.quadCam);
      this.blurMat.uniforms.tSrc.value = this.bloomB.texture;
      this.blurMat.uniforms.uDir.value.set(0, (0.6 + i * 0.5) / bh);
      gl.setRenderTarget(this.bloomA);
      gl.render(this.quadScene, this.quadCam);
    }

    // 3) raster effects + palette quantisation at low resolution
    const u = this.compMat.uniforms;
    u.tScene.value = this.sceneRT.texture;
    u.tBloom.value = this.bloomA.texture;
    u.uRes.value.set(m.lowW, m.lowH);
    u.uTime.value = timeSec;
    u.uWave.value = p.wave;
    u.uWaveFreq.value = p.waveFreq;
    u.uWaveSpeed.value = p.waveSpeed;
    u.uWaveY0.value = p.waveY0;
    u.uWaveY1.value = p.waveY1;
    u.uMosaic.value = Math.max(1, Math.round(p.mosaic));
    u.uVhs.value = p.vhs;
    u.uMono.value = p.mono;
    u.uInvert.value = p.invert;
    u.uFlash.value = p.flash;
    u.uChroma.value = p.chroma;
    u.uBloom.value = p.bloom;
    u.uFade.value = p.fade;
    u.uGlitch.value = p.glitch;
    u.uLevels.value = p.levels;
    u.uDither.value = p.dither;
    u.uVignette.value = p.vignette;
    (u.uTint.value as THREE.Color).copy(p.tint);
    u.uTintAmt.value = p.tintAmt;
    const rc = this.worldToUi(p.ringX, p.ringY, this.tmpPt);
    (u.uRing.value as THREE.Vector3).set(rc.x, m.lowH - rc.y, p.ringR / m.unitsPerPx);
    u.uRingInvert.value = p.ringInvert;
    u.uRingEdge.value = p.ringEdge;
    u.uZoom.value = p.zoom;
    const zc = this.worldToUi(p.zoomX, p.zoomY, this.tmpPt);
    (u.uZoomC.value as THREE.Vector2).set(zc.x / m.lowW, 1 - zc.y / m.lowH);
    this.quad.material = this.compMat;
    gl.setRenderTarget(this.compRT);
    gl.render(this.quadScene, this.quadCam);

    // 4) nearest-neighbour upscale + UI + CRT to the canvas
    const f = this.finalMat.uniforms;
    f.tComp.value = this.compRT.texture;
    f.uLowRes.value.set(m.lowW, m.lowH);
    f.uPixelScale.value = m.pixelScale;
    f.uCrt.value = p.crt;
    this.quad.material = this.finalMat;
    gl.setRenderTarget(null);
    gl.setViewport(0, 0, m.devW, m.devH);
    gl.render(this.quadScene, this.quadCam);
  }
}
