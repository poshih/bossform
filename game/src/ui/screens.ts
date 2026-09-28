import type { Renderer } from '../render/renderer.ts';
import type { Showcase } from '../view/showcase.ts';
import { fillRect, strokeRect, text } from './draw.ts';
import { TEXT } from './font.ts';
import type { Menu } from './menu.ts';
import { FRAME_META } from './meta.ts';

function logoScale(lowW: number): number {
  return lowW >= 560 ? 6 : lowW >= 420 ? 4 : 3;
}

function dim(ctx: CanvasRenderingContext2D, r: Renderer, alpha: number): void {
  const { lowW, lowH } = r.metrics;
  fillRect(ctx, 0, 0, lowW, lowH, `rgba(3,4,10,${alpha})`);
}

export interface TitleInfo {
  readonly menu: Menu;
  readonly time: number;
  readonly pad: boolean;
}

export function drawTitle(ctx: CanvasRenderingContext2D, r: Renderer, info: TitleInfo): void {
  const { lowW, lowH } = r.metrics;
  dim(ctx, r, 0.5);
  const scale = logoScale(lowW);
  const cx = lowW / 2;
  const top = Math.round(lowH * 0.12);
  const bob = Math.round(Math.sin(info.time * 2) * 1.5);
  text(ctx, 'BOSSFORM', cx, top + bob, scale, TEXT.logo, 'center');
  text(ctx, 'ARENA MECH COMBAT', cx, top + 7 * scale + 8, 1, TEXT.hudDim, 'center');
  text(ctx, 'BECOME THE BOSS', cx, top + 7 * scale + 22, 2, TEXT.gold, 'center');
  info.menu.draw(ctx, cx, Math.round(lowH * 0.5), 2, info.time);
  const hint = info.pad ? 'D-PAD / STICK  A CONFIRM' : 'ARROWS / MOUSE  ENTER OR CLICK';
  text(ctx, hint, cx, lowH - 22, 1, TEXT.hudDim, 'center');
  text(ctx, 'MOVE AND AIM SEPARATELY  -  FILL THE GAUGE  -  TRANSFORM', cx, lowH - 12, 1, TEXT.hudDim, 'center');
}

function ratingBar(ctx: CanvasRenderingContext2D, x: number, y: number, value: number, color: string): void {
  for (let i = 0; i < 5; i++) fillRect(ctx, x + i * 9, y, 7, 6, i < value ? color : '#182236');
}

export interface SelectInfo {
  readonly frame: number;
  readonly seat: number;
  readonly seats: number;
  readonly time: number;
  readonly showcase: Showcase;
  readonly pad: boolean;
}

/** Hit rectangles for the three pedestals (the app maps pointer clicks onto them). */
export function pedestalRects(r: Renderer, showcase: Showcase): Array<{ x: number; y: number; w: number; h: number }> {
  const out = { x: 0, y: 0 };
  return [0, 1, 2].map((frame) => {
    showcase.uiPosition(frame, out);
    const half = Math.round(34 / r.metrics.unitsPerPx * 1.6);
    return { x: out.x - half, y: out.y - half, w: half * 2, h: half * 2 };
  });
}

export function drawSelect(ctx: CanvasRenderingContext2D, r: Renderer, info: SelectInfo): void {
  const { lowW, lowH } = r.metrics;
  dim(ctx, r, 0.55);
  const cx = lowW / 2;
  const title = info.seats > 1 ? `PLAYER ${info.seat + 1}: SELECT FRAME` : 'SELECT YOUR FRAME';
  text(ctx, title, cx, 12, 2, TEXT.cyan, 'center');

  const out = { x: 0, y: 0 };
  FRAME_META.forEach((meta, i) => {
    info.showcase.uiPosition(i, out);
    const chosen = i === info.frame;
    const labelY = Math.round(out.y + 62 / r.metrics.unitsPerPx * 1.0);
    text(ctx, meta.name, out.x, labelY, chosen ? 2 : 1, chosen ? TEXT.white : TEXT.hudDim, 'center');
    if (chosen) {
      const rect = pedestalRects(r, info.showcase)[i];
      strokeRect(ctx, rect.x, rect.y, rect.w, rect.h, meta.color);
    }
  });

  const meta = FRAME_META[info.frame];
  const panelW = Math.min(lowW - 16, 420);
  const px = Math.round(cx - panelW / 2);
  const py = lowH - 128;
  fillRect(ctx, px, py, panelW, 116, 'rgba(6,12,28,0.88)');
  strokeRect(ctx, px, py, panelW, 116, meta.color);
  text(ctx, meta.name, px + 8, py + 8, 2, { fill: meta.color, outline: '#061022' });
  text(ctx, meta.role, px + panelW - 8, py + 10, 1, TEXT.hud, 'right');
  meta.blurb.forEach((line, i) => text(ctx, line, px + 8, py + 28 + i * 9, 1, TEXT.hudDim));
  const col = px + 8;
  text(ctx, 'SPEED', col, py + 60, 1, TEXT.hud);
  ratingBar(ctx, col + 44, py + 60, meta.speed, meta.color);
  text(ctx, 'POWER', col, py + 72, 1, TEXT.hud);
  ratingBar(ctx, col + 44, py + 72, meta.power, meta.color);
  text(ctx, 'ARMOR', col, py + 84, 1, TEXT.hud);
  ratingBar(ctx, col + 44, py + 84, meta.armor, meta.color);
  const wx = px + panelW / 2 + 4;
  text(ctx, 'WEAPONS', wx, py + 60, 1, TEXT.gold);
  text(ctx, `FIRE  ${meta.primary}`, wx, py + 72, 1, TEXT.hud);
  text(ctx, `ALT   ${meta.alt}`, wx, py + 82, 1, TEXT.hud);
  text(ctx, `BOSS FORM: ${meta.bossForm}`, wx, py + 94, 1, TEXT.gold);
  text(ctx, `${meta.bossPrimary} / ${meta.bossAlt}`, wx, py + 104, 1, TEXT.hudDim);
  const hint = info.pad ? 'D-PAD CHOOSE   A CONFIRM   B BACK' : 'LEFT / RIGHT CHOOSE   ENTER CONFIRM   ESC BACK';
  text(ctx, hint, cx, lowH - 10, 1, TEXT.hudDim, 'center');
}

export function drawPause(ctx: CanvasRenderingContext2D, r: Renderer, menu: Menu, time: number): void {
  const { lowW, lowH } = r.metrics;
  dim(ctx, r, 0.6);
  text(ctx, 'PAUSED', lowW / 2, Math.round(lowH * 0.28), 4, TEXT.cyan, 'center');
  menu.draw(ctx, lowW / 2, Math.round(lowH * 0.46), 2, time);
}

export interface ResultsInfo {
  readonly victory: boolean;
  readonly lines: ReadonlyArray<readonly [string, string]>;
  readonly menu: Menu;
  readonly time: number;
}

export function drawResults(ctx: CanvasRenderingContext2D, r: Renderer, info: ResultsInfo): void {
  const { lowW, lowH } = r.metrics;
  dim(ctx, r, 0.68);
  const cx = lowW / 2;
  text(ctx, info.victory ? 'MISSION COMPLETE' : 'MISSION FAILED', cx, Math.round(lowH * 0.14), 3, info.victory ? TEXT.gold : TEXT.red, 'center');
  const w = Math.min(lowW - 24, 260);
  let y = Math.round(lowH * 0.3);
  for (const [label, value] of info.lines) {
    text(ctx, label, cx - w / 2, y, 1, TEXT.hudDim);
    text(ctx, value, cx + w / 2, y, 1, TEXT.white, 'right');
    y += 13;
  }
  info.menu.draw(ctx, cx, y + 20, 2, info.time);
}

const HELP_PAGES: ReadonlyArray<{ title: string; lines: readonly string[] }> = [
  {
    title: 'CONTROLS',
    lines: [
      'WASD ............ MOVE',
      'MOUSE ........... AIM (INDEPENDENT OF MOVE)',
      'ARROW KEYS ...... AIM WITH THE KEYBOARD',
      'CLICK / J / Z ... FIRE',
      'RIGHT CLICK / K . ALT WEAPON',
      'SPACE / E ....... BOSS FORM (WHEN READY)',
      'ESC / P ......... PAUSE      M ... MUTE',
      '',
      'GAMEPAD: L STICK MOVE, R STICK AIM,',
      'A/RT FIRE, B/LT ALT, Y BOSS FORM, START PAUSE',
    ],
  },
  {
    title: 'BOSS FORM',
    lines: [
      'GRAZE BULLETS, HIT ENEMIES AND COLLECT',
      'ENERGY ORBS TO FILL THE BOSS GAUGE.',
      '',
      'WHEN IT READS 100% PRESS THE BOSS BUTTON:',
      'YOUR FRAME TRANSFORMS INTO ITS BOSS FORM.',
      '',
      '- BULLETS THAT TOUCH YOU ARE ABSORBED',
      '  (EACH ONE BURNS A LITTLE OF THE TIMER)',
      '- CRUSH SMALL ENEMIES BY RAMMING THEM',
      '- NEW WEAPONS.  KILLS EXTEND THE TIMER',
    ],
  },
  {
    title: 'TIPS',
    lines: [
      'YOUR HITBOX IS THE SMALL CORE, NOT THE BODY.',
      'GRAZING BULLETS IS THE FASTEST WAY TO CHARGE.',
      'CHAINED KILLS RAISE YOUR SCORE MULTIPLIER',
      'AND DOUBLE IN BOSS FORM.',
      '',
      'A STAGE WITHOUT BEING HIT DOUBLES THE CLEAR BONUS.',
      'BOSSES CHANGE PATTERNS AT 66% AND 33% HEALTH.',
    ],
  },
];

export const HELP_PAGE_COUNT = HELP_PAGES.length;

export function drawHelp(ctx: CanvasRenderingContext2D, r: Renderer, page: number, time: number): void {
  const { lowW, lowH } = r.metrics;
  dim(ctx, r, 0.82);
  const cx = lowW / 2;
  const p = HELP_PAGES[page];
  text(ctx, `HOW TO PLAY  ${page + 1}/${HELP_PAGES.length}`, cx, 14, 2, TEXT.cyan, 'center');
  text(ctx, p.title, cx, 36, 2, TEXT.gold, 'center');
  const left = Math.max(10, Math.round(cx - 150));
  p.lines.forEach((line, i) => text(ctx, line, left, 64 + i * 12, 1, TEXT.hud));
  const blink = (Math.floor(time * 2) & 1) === 0;
  text(ctx, blink ? '< >  NEXT PAGE      ESC  BACK' : '< >  NEXT PAGE      ESC  BACK', cx, lowH - 14, 1, TEXT.hudDim, 'center');
}
