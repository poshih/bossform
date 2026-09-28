import * as THREE from 'three';
import type { Renderer } from '../render/renderer.ts';
import { PALETTE, PLAY_H, PLAY_W } from '../config.ts';

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

/** Arena floor: scrolling armour-plate grid inside a glowing frame, dim hazard hatching outside. */
const FRAG = /* glsl */ `
uniform float uTime;
uniform vec2 uRes;
uniform vec2 uView;
uniform vec2 uCam;
uniform vec2 uArena;
uniform vec3 uAccent;
uniform float uScroll;
uniform float uDanger;
uniform float uBossMode;
varying vec2 vUv;

float bayer(vec2 p) {
  vec2 q = mod(floor(p), 4.0);
  float v = q.x < 1.0 ? (q.y < 1.0 ? 0.0 : q.y < 2.0 ? 12.0 : q.y < 3.0 ? 3.0 : 15.0)
          : q.x < 2.0 ? (q.y < 1.0 ? 8.0 : q.y < 2.0 ? 4.0 : q.y < 3.0 ? 11.0 : 7.0)
          : q.x < 3.0 ? (q.y < 1.0 ? 2.0 : q.y < 2.0 ? 14.0 : q.y < 3.0 ? 1.0 : 13.0)
          : (q.y < 1.0 ? 10.0 : q.y < 2.0 ? 6.0 : q.y < 3.0 ? 9.0 : 5.0);
  return (v + 0.5) / 16.0;
}
float bands(float t, float n, vec2 px) { return floor(t * n + bayer(px)) / n; }

void main() {
  vec2 px = gl_FragCoord.xy;
  vec2 wp = (px / uRes - 0.5) * uView + uCam;
  vec2 edge = abs(wp) - uArena;
  float outside = max(edge.x, edge.y);

  vec3 accent = mix(uAccent, vec3(1.0, 0.18, 0.22), uDanger * 0.65);
  vec3 col;
  if (outside > 0.0) {
    // Beyond the wall: dark hatched plating fading with distance.
    float hatch = step(0.5, fract((wp.x + wp.y) / 14.0));
    float fade = exp(-outside / 90.0);
    col = mix(vec3(0.030, 0.040, 0.075), vec3(0.055, 0.075, 0.120), hatch) * (0.55 + 0.45 * fade);
    float wall = exp(-pow(outside / 2.6, 2.0));
    col += accent * wall * (0.85 + 0.25 * sin(uTime * 3.0 + wp.y * 0.05));
  } else {
    vec2 g = wp + vec2(0.0, uScroll);
    vec2 tile = g / 40.0;
    vec2 f = abs(fract(tile) - 0.5);
    float seam = smoothstep(0.455, 0.5, max(f.x, f.y));
    float plate = 0.5 + 0.5 * sin(floor(tile.x) * 7.3 + floor(tile.y) * 3.1);
    float depth = clamp((-outside) / 60.0, 0.0, 1.0);
    vec3 floorCol = mix(vec3(0.050, 0.068, 0.115), vec3(0.036, 0.050, 0.092), plate * 0.6);
    floorCol *= 0.7 + 0.3 * bands(depth, 4.0, px);
    col = floorCol + accent * seam * 0.075;
    // Centre emblem ring and lane marks give the eye a stable reference without competing with bullets.
    float r = length(wp);
    col += accent * exp(-pow((r - 92.0) / 1.4, 2.0)) * 0.05;
    col += accent * exp(-pow((r - 96.0) / 0.8, 2.0)) * 0.025;
    float tick = step(0.94, fract(atan(wp.y, wp.x) * 12.0 / 6.2831853));
    col += accent * tick * exp(-pow((r - 104.0) / 2.0, 2.0)) * 0.05;
    col += accent * exp(-pow(outside / 3.0, 2.0)) * 0.45;
    col = mix(col, col * vec3(1.15, 0.9, 0.7) + vec3(0.02, 0.0, 0.0), uBossMode * 0.35);
    col += vec3(0.05, 0.0, 0.0) * uDanger;
  }
  // Authored in display space; the composite pass expects linear light.
  gl_FragColor = vec4(pow(clamp(col, 0.0, 1.0), vec3(2.2)), 1.0);
}`;

export class ArenaBackground {
  readonly material: THREE.ShaderMaterial;

  constructor(renderer: Renderer) {
    const u = renderer.bgUniforms;
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uTime: u.uTime,
        uRes: u.uRes,
        uView: u.uView,
        uCam: u.uCam,
        uArena: { value: new THREE.Vector2(PLAY_W / 2, PLAY_H / 2) },
        uAccent: { value: new THREE.Color(PALETTE.cyan) },
        uScroll: { value: 0 },
        uDanger: { value: 0 },
        uBossMode: { value: 0 },
      },
    });
  }

  set accent(color: number) {
    (this.material.uniforms.uAccent.value as THREE.Color).set(color);
  }

  update(scroll: number, danger: number, bossMode: number): void {
    this.material.uniforms.uScroll.value = scroll;
    this.material.uniforms.uDanger.value = danger;
    this.material.uniforms.uBossMode.value = bossMode;
  }
}
