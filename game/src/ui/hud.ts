import { fx } from '@metronome/engine';
import {
  Banner, BOSS_MODE_TICKS, Ev, Frame, GALE, GAUGE_MAX, JUGGERNAUT, Phase, FRAME_STATS, STAGE_COUNT, VANGUARD, W,
} from '../sim/index.ts';
import type { World } from '../sim/index.ts';
import type { Renderer } from '../render/renderer.ts';
import { clock, ease, fillRect, fmtScore, segmentBar, strokeRect, text } from './draw.ts';
import type { Rect } from './draw.ts';
import { TEXT } from './font.ts';
import type { TextStyle } from './font.ts';
import { BOSS_NAMES, FRAME_META, STAGE_NAMES } from './meta.ts';

const WIDE_PANEL_MIN = 118;
const BANNER_TICKS: Readonly<Record<number, number>> = {
  [Banner.Stage]: 170, [Banner.Round]: 110, [Banner.Warning]: 190, [Banner.Clear]: 260, [Banner.GameOver]: 400, [Banner.Victory]: 600,
};

interface ActiveBanner {
  kind: number;
  number: number;
  detail: number;
  age: number;
  life: number;
}

const SEAT_STYLE: readonly TextStyle[] = [TEXT.cyan, TEXT.magenta];

/** Alt-weapon cooldown length per frame and form, for the cooldown bar. */
function altCooldownMax(frame: number, bossForm: boolean): number {
  if (frame === Frame.Vanguard) return bossForm ? 1 : VANGUARD.missileCooldown;
  if (frame === Frame.Gale) return bossForm ? GALE.stormCooldown : GALE.dashCooldown;
  return bossForm ? JUGGERNAUT.rocketCooldown : JUGGERNAUT.shieldCooldown;
}

function altName(frame: number, bossForm: boolean): string {
  const meta = FRAME_META[frame];
  return bossForm ? meta.bossAlt : meta.alt;
}

export interface HudInput {
  readonly world: World;
  readonly time: number;
  /** Mouse cursor in low-res UI pixels, or null when the pointer is not steering. */
  readonly cursor: { x: number; y: number } | null;
  /** Seats whose crosshair should be drawn, with the robot's UI position. */
  readonly local: ReadonlyArray<{ seat: number; ui: { x: number; y: number } | null }>;
  readonly padPrompts: boolean;
  readonly online: string | null;
}

export class Hud {
  private readonly renderer: Renderer;
  private banner: ActiveBanner | null = null;
  private round = 0;
  private bossWarningType = 0;

  constructor(renderer: Renderer) {
    this.renderer = renderer;
  }

  reset(): void {
    this.banner = null;
    this.round = 0;
  }

  onEvent(type: number, x: number, _y: number, a: number): void {
    if (type === Ev.Banner) {
      if (a === Banner.Round) this.round = x;
      if (a === Banner.Stage) this.round = 0;
      this.show(a, x, 0);
    } else if (type === Ev.BossWarning) {
      this.bossWarningType = a;
      this.show(Banner.Warning, 0, a);
    }
  }

  private show(kind: number, number: number, detail: number): void {
    this.banner = { kind, number, detail, age: 0, life: BANNER_TICKS[kind] ?? 120 };
  }

  tick(): void {
    if (this.banner && ++this.banner.age >= this.banner.life) this.banner = null;
  }

  draw(ctx: CanvasRenderingContext2D, input: HudInput): void {
    const { world } = input;
    const pf = this.renderer.playfieldUi();
    const { lowW } = this.renderer.metrics;
    const wide = pf.x >= WIDE_PANEL_MIN;
    const wv = world.m.world;

    if (wide) {
      const left: Rect = { x: 6, y: 6, w: pf.x - 12, h: pf.h };
      const right: Rect = { x: pf.x + pf.w + 6, y: 6, w: lowW - (pf.x + pf.w) - 12, h: pf.h };
      this.drawPlayer(ctx, world, 0, left, input.time, input.padPrompts);
      if (world.seats > 1) this.drawPlayer(ctx, world, 1, right, input.time, input.padPrompts);
      else this.drawInfoPanel(ctx, world, right, input);
      if (world.seats > 1) this.drawStageLine(ctx, world, pf.x + pf.w / 2, pf.y + 4);
      else this.drawStageLine(ctx, world, right.x + right.w / 2, right.y + right.h - 30);
    } else {
      const half = pf.w / 2;
      this.drawPlayer(ctx, world, 0, { x: pf.x + 3, y: pf.y + 3, w: (world.seats > 1 ? half : pf.w) - 6, h: 60 }, input.time, input.padPrompts);
      if (world.seats > 1) this.drawPlayer(ctx, world, 1, { x: pf.x + half + 3, y: pf.y + 3, w: half - 6, h: 60 }, input.time, input.padPrompts);
      this.drawStageLine(ctx, world, pf.x + pf.w / 2, pf.y + pf.h - 10);
    }
    this.drawBossBar(ctx, world, pf);
    this.drawAim(ctx, input);
    this.drawBanner(ctx, pf, input.time, world);
    if (wv[W.Phase] === Phase.Over || wv[W.Phase] === Phase.Win) return;
    for (let p = 0; p < world.seats; p++) if (world.m.plBoss[p] > 0) this.drawBossFrame(ctx, pf, input.time);
  }

  private drawPlayer(ctx: CanvasRenderingContext2D, world: World, seat: number, r: Rect, time: number, pad: boolean): void {
    const { m } = world;
    const frame = m.plFrame[seat];
    const meta = FRAME_META[frame];
    const stats = FRAME_STATS[frame];
    const boss = m.plBoss[seat] > 0;
    const transforming = m.plTransform[seat] > 0;
    const ready = !boss && m.plGauge[seat] >= GAUGE_MAX;
    let y = r.y;
    const x = r.x;
    const w = r.w;
    text(ctx, `P${seat + 1}`, x, y, 1, SEAT_STYLE[seat]);
    text(ctx, boss ? meta.bossForm : meta.name, x + 14, y, 1, boss ? TEXT.gold : TEXT.hud);
    y += 12;

    const hpFrac = Math.max(0, m.plHp[seat] / stats.maxHp);
    const hpColor = hpFrac > 0.5 ? '#38e089' : hpFrac > 0.25 ? '#ffc34d' : '#ff3b4e';
    text(ctx, 'ARMOR', x, y, 1, TEXT.hudDim);
    text(ctx, `${Math.max(0, m.plHp[seat])}`, x + w, y, 1, TEXT.hud, 'right');
    y += 10;
    fillRect(ctx, x - 1, y - 1, w + 2, 8, '#03060f');
    segmentBar(ctx, x, y, w, 6, hpFrac, 20, hpColor, '#142033');
    y += 12;

    let lives = '';
    for (let i = 0; i < Math.max(0, m.plLives[seat]); i++) lives += '♦ ';
    text(ctx, 'LIVES', x, y, 1, TEXT.hudDim);
    text(ctx, lives.trim() || '-', x + w, y, 1, TEXT.gold, 'right');
    y += 14;

    text(ctx, boss ? 'BOSS MODE' : 'BOSS GAUGE', x, y, 1, boss || ready ? TEXT.gold : TEXT.hudDim);
    if (boss) text(ctx, `${(m.plBoss[seat] / 60).toFixed(1)}S`, x + w, y, 1, TEXT.gold, 'right');
    else text(ctx, `${Math.floor((m.plGauge[seat] * 100) / GAUGE_MAX)}%`, x + w, y, 1, ready ? TEXT.gold : TEXT.hud, 'right');
    y += 10;
    const gaugeFrac = m.plGauge[seat] / GAUGE_MAX;
    const flash = (Math.floor(time * 6) & 1) === 0;
    fillRect(ctx, x - 1, y - 1, w + 2, 10, '#03060f');
    const gaugeColor = boss ? '#ffc34d' : ready ? (flash ? '#fff1a8' : '#ffb020') : '#27a8ff';
    fillRect(ctx, x, y, w, 8, '#142033');
    fillRect(ctx, x, y, Math.round(w * (boss ? Math.min(1, m.plBoss[seat] / BOSS_MODE_TICKS) : gaugeFrac)), 8, gaugeColor);
    for (let t = 1; t < 4; t++) fillRect(ctx, x + Math.round((w * t) / 4), y, 1, 8, 'rgba(3,6,15,0.7)');
    y += 12;
    if (ready) text(ctx, pad ? 'PRESS Y' : 'PRESS SPACE', x + w / 2, y - 1, 1, flash ? TEXT.gold : TEXT.white, 'center');
    else if (transforming) text(ctx, 'TRANSFORM!', x + w / 2, y - 1, 1, TEXT.white, 'center');
    y += 12;

    const max = altCooldownMax(frame, boss);
    const cd = m.plAltCd[seat];
    text(ctx, altName(frame, boss), x, y, 1, cd === 0 ? TEXT.cyan : TEXT.hudDim);
    y += 10;
    fillRect(ctx, x, y, w, 3, '#142033');
    if (max > 1) fillRect(ctx, x, y, Math.round(w * (1 - cd / max)), 3, cd === 0 ? '#27e1ff' : '#3a5a7a');
    y += 11;

    text(ctx, 'SCORE', x, y, 1, TEXT.hudDim);
    y += 10;
    text(ctx, fmtScore(m.plScore[seat]), x, y, 2, TEXT.white);
    y += 18;
    if (m.plChain[seat] > 1) text(ctx, `CHAIN x${(1 + Math.min(m.plChain[seat], 20) / 10).toFixed(1)}`, x, y, 1, TEXT.gold);
  }

  private drawInfoPanel(ctx: CanvasRenderingContext2D, world: World, r: Rect, input: HudInput): void {
    const wv = world.m.world;
    let y = r.y;
    text(ctx, 'BOSSFORM', r.x + r.w / 2, y, 2, TEXT.logo, 'center');
    y += 22;
    const lines = input.padPrompts
      ? ['L STICK  MOVE', 'R STICK  AIM', 'A/RT  FIRE', 'B/LT  ALT', 'Y  BOSS FORM', 'START  PAUSE']
      : ['WASD  MOVE', 'MOUSE  AIM', 'CLICK  FIRE', 'R-CLICK  ALT', 'SPACE  BOSS FORM', 'ESC  PAUSE'];
    for (const line of lines) {
      text(ctx, line, r.x, y, 1, TEXT.hudDim);
      y += 10;
    }
    y += 10;
    text(ctx, 'TIME', r.x, y, 1, TEXT.hudDim);
    text(ctx, clock(wv[W.Tick]), r.x + r.w, y, 1, TEXT.hud, 'right');
    y += 12;
    if (input.online) text(ctx, input.online, r.x, y, 1, TEXT.gold);
  }

  private drawStageLine(ctx: CanvasRenderingContext2D, world: World, cx: number, y: number): void {
    const stage = world.m.world[W.Stage];
    const round = this.round > 0 ? `  ROUND ${this.round}` : '';
    text(ctx, `STAGE ${stage + 1}/${STAGE_COUNT}${round}`, cx, y, 1, TEXT.hud, 'center');
    text(ctx, STAGE_NAMES[stage] ?? '', cx, y + 10, 1, TEXT.hudDim, 'center');
  }

  private drawBossBar(ctx: CanvasRenderingContext2D, world: World, pf: Rect): void {
    const { m } = world;
    const slot = m.world[W.BossSlot];
    if (slot < 0 || m.eAlive[slot] !== 1) return;
    const w = pf.w - 24;
    const x = pf.x + 12;
    const y = pf.y + 8;
    const frac = Math.max(0, m.eHp[slot] / m.eMaxHp[slot]);
    text(ctx, BOSS_NAMES[m.eType[slot]] ?? 'BOSS', x, y, 1, TEXT.red);
    fillRect(ctx, x - 1, y + 9, w + 2, 7, '#03060f');
    fillRect(ctx, x, y + 10, w, 5, '#2a0a12');
    fillRect(ctx, x, y + 10, Math.round(w * frac), 5, m.ePhase[slot] === 2 ? '#ff3b4e' : m.ePhase[slot] === 1 ? '#ff8a2a' : '#ffc34d');
    for (const t of [0.33, 0.66]) fillRect(ctx, x + Math.round(w * t), y + 9, 1, 7, '#03060f');
    for (let p = 0; p < 3; p++) fillRect(ctx, x + w - 3 * 6 + p * 6, y + 1, 4, 4, p >= m.ePhase[slot] ? '#ff3b4e' : '#3a1218');
  }

  private drawAim(ctx: CanvasRenderingContext2D, input: HudInput): void {
    const { world } = input;
    for (const local of input.local) {
      if (!local.ui || !world.isPlaying(local.seat)) continue;
      const aim = fx.toRadians(world.m.plAim[local.seat]);
      const reach = 34;
      const scale = 1 / this.renderer.metrics.unitsPerPx;
      const ax = local.ui.x + Math.cos(aim) * reach * scale;
      const ay = local.ui.y - Math.sin(aim) * reach * scale;
      for (let i = 1; i <= 3; i++) {
        const t = (i * 0.25 + 0.2) * reach * scale;
        fillRect(ctx, local.ui.x + Math.cos(aim) * t, local.ui.y - Math.sin(aim) * t, 1, 1, i === 3 ? '#ffffff' : 'rgba(126,196,255,0.7)');
      }
      if (local.seat === 0 && input.cursor) this.crosshair(ctx, input.cursor.x, input.cursor.y, input.time);
      else this.crosshair(ctx, ax, ay, input.time);
    }
  }

  private crosshair(ctx: CanvasRenderingContext2D, x: number, y: number, time: number): void {
    const cx = Math.round(x);
    const cy = Math.round(y);
    const spin = Math.floor(time * 8) & 1;
    const color = '#ffffff';
    fillRect(ctx, cx - 5 - spin, cy, 3, 1, color);
    fillRect(ctx, cx + 3 + spin, cy, 3, 1, color);
    fillRect(ctx, cx, cy - 5 - spin, 1, 3, color);
    fillRect(ctx, cx, cy + 3 + spin, 1, 3, color);
    fillRect(ctx, cx, cy, 1, 1, '#27e1ff');
  }

  private drawBossFrame(ctx: CanvasRenderingContext2D, pf: Rect, time: number): void {
    const pulse = 0.5 + 0.5 * Math.sin(time * 9);
    strokeRect(ctx, pf.x, pf.y, pf.w, pf.h, `rgba(255,195,77,${(0.35 + pulse * 0.4).toFixed(2)})`);
    strokeRect(ctx, pf.x + 2, pf.y + 2, pf.w - 4, pf.h - 4, `rgba(255,120,40,${(0.15 + pulse * 0.2).toFixed(2)})`);
  }

  private drawBanner(ctx: CanvasRenderingContext2D, pf: Rect, time: number, world: World): void {
    const b = this.banner;
    if (!b) return;
    const cx = pf.x + pf.w / 2;
    const cy = pf.y + pf.h * 0.36;
    const fadeIn = ease(Math.min(1, b.age / 14));
    const fadeOut = ease(Math.min(1, (b.life - b.age) / 20));
    const a = Math.min(fadeIn, fadeOut);
    ctx.save();
    ctx.globalAlpha = a;
    const slide = Math.round((1 - fadeIn) * 24);
    switch (b.kind) {
      case Banner.Stage:
        text(ctx, `STAGE ${b.number}`, cx + slide, cy, 4, TEXT.logo, 'center');
        text(ctx, STAGE_NAMES[b.number - 1] ?? '', cx - slide, cy + 36, 2, TEXT.gold, 'center');
        break;
      case Banner.Round:
        text(ctx, `ROUND ${b.number}`, cx + slide, cy, 3, TEXT.cyan, 'center');
        break;
      case Banner.Warning: {
        const blink = (Math.floor(time * 5) & 1) === 0;
        text(ctx, 'WARNING', cx, cy, 4, blink ? TEXT.red : TEXT.white, 'center');
        text(ctx, 'HOSTILE BOSS APPROACHING', cx, cy + 34, 1, TEXT.hud, 'center');
        text(ctx, BOSS_NAMES[this.bossWarningType] ?? '', cx, cy + 46, 2, TEXT.gold, 'center');
        fillRect(ctx, pf.x, pf.y + pf.h * 0.36 - 12, pf.w, 2, `rgba(255,59,78,${blink ? 0.9 : 0.4})`);
        fillRect(ctx, pf.x, pf.y + pf.h * 0.36 + 62, pf.w, 2, `rgba(255,59,78,${blink ? 0.9 : 0.4})`);
        break;
      }
      case Banner.Clear:
        text(ctx, 'STAGE CLEAR', cx, cy, 3, TEXT.gold, 'center');
        if (world.m.world[W.StageHits] === 0) text(ctx, 'NO DAMAGE BONUS x2', cx, cy + 30, 1, TEXT.cyan, 'center');
        break;
      case Banner.GameOver:
        text(ctx, 'GAME OVER', cx, cy, 4, TEXT.red, 'center');
        break;
      case Banner.Victory:
        text(ctx, 'VICTORY', cx, cy, 4, TEXT.gold, 'center');
        text(ctx, 'ALL BOSSES DEFEATED', cx, cy + 36, 1, TEXT.hud, 'center');
        break;
      default:
        break;
    }
    ctx.restore();
  }
}
