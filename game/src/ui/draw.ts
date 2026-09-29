export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function invLerp(a: number, b: number, value: number): number {
  if (a === b) return 0;
  return clamp((value - a) / (b - a), 0, 1);
}

export function easeOutCubic(t: number): number {
  const x = 1 - clamp(t, 0, 1);
  return 1 - x * x * x;
}

export function pulse(time: number, rate: number, floor: number, ceil: number): number {
  return lerp(floor, ceil, 0.5 + Math.sin(time * rate) * 0.5);
}

export function formatClock(totalSeconds: number): string {
  const safe = Math.max(0, Math.ceil(totalSeconds));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export function formatCompactSeconds(totalSeconds: number): string {
  return `${Math.max(0, Math.ceil(totalSeconds))}S`;
}

export function drawChamferRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, cut: number): void {
  const c = Math.min(cut, width * 0.5, height * 0.5);
  ctx.beginPath();
  ctx.moveTo(x + c, y);
  ctx.lineTo(x + width - c, y);
  ctx.lineTo(x + width, y + c);
  ctx.lineTo(x + width, y + height - c);
  ctx.lineTo(x + width - c, y + height);
  ctx.lineTo(x + c, y + height);
  ctx.lineTo(x, y + height - c);
  ctx.lineTo(x, y + c);
  ctx.closePath();
}

export function strokeGlow(ctx: CanvasRenderingContext2D, color: string, blur: number, width: number, draw: () => void): void {
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = blur;
  ctx.lineWidth = width;
  draw();
  ctx.stroke();
  ctx.restore();
}

export function fillCenteredText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number): void {
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y);
}

export function pointOnScreen(x: number, y: number, width: number, height: number, padding: number): boolean {
  return x >= -padding && y >= -padding && x <= width + padding && y <= height + padding;
}
