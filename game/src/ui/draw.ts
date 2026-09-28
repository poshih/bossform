import type { Align, TextStyle } from './font.ts';
import { drawText, textWidth } from './font.ts';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function text(ctx: CanvasRenderingContext2D, str: string, x: number, y: number, scale: number, style: TextStyle, align: Align = 'left'): void {
  drawText(ctx, str, x, y, scale, style, align);
}

export function tw(str: string, scale: number): number {
  return textWidth(str, scale);
}

export function fillRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string): void {
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
}

export function strokeRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string): void {
  ctx.fillStyle = color;
  const [rx, ry, rw, rh] = [Math.round(x), Math.round(y), Math.round(w), Math.round(h)];
  ctx.fillRect(rx, ry, rw, 1);
  ctx.fillRect(rx, ry + rh - 1, rw, 1);
  ctx.fillRect(rx, ry, 1, rh);
  ctx.fillRect(rx + rw - 1, ry, 1, rh);
}

export function inside(r: Rect, x: number, y: number): boolean {
  return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
}

export function fmtScore(n: number, digits = 9): string {
  return String(Math.max(0, n)).padStart(digits, '0');
}

export function clock(ticks: number): string {
  const s = Math.floor(ticks / 60);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Segmented bar: `frac` of `segments` cells lit; `fill` and `back` are CSS colours. */
export function segmentBar(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, frac: number, segments: number, fill: string, back: string): void {
  const gap = 1;
  const cell = Math.max(1, Math.floor((w - gap * (segments - 1)) / segments));
  const lit = Math.ceil(Math.max(0, Math.min(1, frac)) * segments - 1e-6);
  for (let i = 0; i < segments; i++) fillRect(ctx, x + i * (cell + gap), y, cell, h, i < lit ? fill : back);
}

export function ease(t: number): number {
  return t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
}
