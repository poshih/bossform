import type { Rect } from './draw.ts';
import { fillRect, inside, strokeRect, text, tw } from './draw.ts';
import { TEXT } from './font.ts';

/** A vertical list of selectable rows with keyboard/pad/pointer navigation and hit-testing. */
export class Menu {
  items: string[];
  index = 0;
  private rects: Rect[] = [];

  constructor(items: string[]) {
    this.items = items;
  }

  move(delta: number): void {
    this.index = (this.index + delta + this.items.length) % this.items.length;
  }

  /** Index under a low-res UI point, or -1. */
  hit(x: number, y: number): number {
    return this.rects.findIndex((r) => inside(r, x, y));
  }

  draw(ctx: CanvasRenderingContext2D, cx: number, y: number, scale: number, time: number, enabled?: (i: number) => boolean): void {
    const rowH = 7 * scale + 7;
    this.rects = [];
    this.items.forEach((label, i) => {
      const selected = i === this.index;
      const off = enabled ? !enabled(i) : false;
      const w = Math.max(tw(label, scale) + 30, 120);
      const rowY = y + i * rowH;
      const rect = { x: cx - w / 2, y: rowY - 3, w, h: 7 * scale + 6 };
      this.rects.push(rect);
      if (selected) {
        const pulse = 0.55 + 0.25 * Math.sin(time * 8);
        fillRect(ctx, rect.x, rect.y, rect.w, rect.h, `rgba(39,225,255,${(0.16 + pulse * 0.1).toFixed(2)})`);
        strokeRect(ctx, rect.x, rect.y, rect.w, rect.h, '#27e1ff');
        text(ctx, '>', rect.x + 8 + Math.round(Math.sin(time * 10) * 1.2), rowY, scale, TEXT.gold);
        text(ctx, '<', rect.x + rect.w - 8 - 5 * scale, rowY, scale, TEXT.gold);
      }
      text(ctx, label, cx, rowY, scale, off ? TEXT.hudDim : selected ? TEXT.white : TEXT.cyan, 'center');
    });
  }
}
