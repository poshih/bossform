import { fx } from '@metronome/engine';
import * as THREE from 'three';

export const RAW_UNIT = 1 / fx.ONE;
export const TWO_PI = Math.PI * 2;
export const FLASH_TICKS = 8;

export function toWorld(raw: number): number {
  return raw * RAW_UNIT;
}

export function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function easeOutCubic(t: number): number {
  const x = 1 - clamp01(t);
  return 1 - x * x * x;
}

export function easeOutQuad(t: number): number {
  const x = clamp01(t);
  return 1 - (1 - x) * (1 - x);
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** Smoothstep over 0..1 (inputs outside are clamped). */
export function smooth01(value: number): number {
  return smoothstep(0, 1, value);
}

export function angleDiffBinary(from: number, to: number): number {
  return (((to - from + fx.ANGLE_HALF) & fx.ANGLE_MASK) - fx.ANGLE_HALF) | 0;
}

export function lerpBinaryAngle(from: number, to: number, alpha: number): number {
  return (from + angleDiffBinary(from, to) * alpha) & fx.ANGLE_MASK;
}

export function binaryAngleToRadians(raw: number): number {
  return fx.toRadians(raw);
}

export function lerpRadiansBinary(from: number, to: number, alpha: number): number {
  return binaryAngleToRadians(lerpBinaryAngle(from, to, alpha));
}

export function expStep(current: number, target: number, sharpness: number, dtSeconds: number): number {
  return lerp(current, target, 1 - Math.exp(-sharpness * dtSeconds));
}

export function wrapAngleRadians(angle: number): number {
  let out = angle;
  while (out <= -Math.PI) out += TWO_PI;
  while (out > Math.PI) out -= TWO_PI;
  return out;
}

export function lerpRadians(from: number, to: number, alpha: number): number {
  const diff = wrapAngleRadians(to - from);
  return from + diff * alpha;
}

export function colorIntoLinear(color: THREE.Color, hex: number): THREE.Color {
  return color.setHex(hex).convertSRGBToLinear();
}

export function hexToLinear(hex: number): THREE.Color {
  return new THREE.Color(hex).convertSRGBToLinear();
}
