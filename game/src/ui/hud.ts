import { fx } from '@metronome/engine';
import { FORM_NAMES } from '../setup.ts';
import {
  Attack,
  AttackBlock,
  attackBlocker,
  attackFuel,
  canStartAttack,
  AttackPhase,
  Banner,
  BOSS_DRAIN_PER_TICK,
  BOSS_MIN_GAUGE,
  DEATHMATCH_TICKS,
  Ev,
  FORMS,
  FRAME_STATS,
  Form,
  GALE,
  GAUGE_MAX,
  GAUGE_SCALE,
  JUGGERNAUT,
  NO_SEAT,
  NO_WINNER,
  NeutralType,
  Phase,
  radial,
  Role,
  ROUNDS_TO_WIN,
  SHRINK_TICKS,
  SUDDEN_DEATH_TICKS,
  TICK_RATE,
  VANGUARD,
  W,
} from '../sim/index.ts';
import type { World } from '../sim/index.ts';
import type { Beat } from '../beat.ts';
import { clamp, drawChamferRect, easeOutCubic, fillCenteredText, formatClock, formatCompactSeconds, invLerp, lerp, pointOnScreen, pulse, strokeGlow } from './draw.ts';
import {
  UI_ACCENT,
  UI_CAPS_SPACING,
  UI_EDGE,
  UI_EDGE_SOFT,
  UI_FONT_STACK,
  UI_MUTED,
  UI_HUD_PANEL,
  UI_PANEL_STRONG,
  UI_SUCCESS,
  UI_TEXT,
  UI_TEXT_DIM,
  UI_WARNING,
  cssHex,
  neutralAccent,
  neutralEdge,
  rgba,
  teamColor,
} from './theme.ts';


const HUD_MARGIN = 18;
const PANEL_CUT = 12;
const PANEL_GLOW = 10;
const FEED_LIFETIME = 4.6;
const BANNER_LIFETIME = 2.4;
const BANNER_FADE = 0.35;
const DAMAGE_WINDOW_DECAY = 0.8;
const BLOCK_FLASH_SECONDS = 0.3;
const HIT_PULSE_SECONDS = 0.38;
const ULTIMA_ARROW_PAD = 56;
const RETICLE_OUTER = 16;
const RETICLE_INNER = 7;
const RADAR_BASE = 150;
const RADAR_SAMPLE_ORBS = 48;
const SCOREBOARD_MAX_ROWS = 10;
const NAME_TAG_PAD = 20;
const HEALTH_WARN_THRESHOLD = 0.25;
const OFFSCREEN_PAD = 26;
const VIGNETTE_ALPHA = 0.54;
const TEAM_ROW_GAP = 4;
const TELL_LABEL_FONT = 11;
const WINDOW_SEPARATOR_ALPHA = 0.24;
const LOW_HEALTH_RATE = 8.5;
const STORM_PULSE_RATE = 7;
const FEED_ROW_HEIGHT = 26;
const BOSS_ICON_SIZE = 11;
const INDICATOR_CHEVRON = 12;
const PART_MIN_ALPHA = 0.22;
const PART_SCHEMATIC_PAD = 12;
const SCOREBOARD_WIDTH = 250;
const FEED_WIDTH = 270;
const TIMER_WIDTH = 290;
const SAFE_ZONE_STROKE = 2;
const RADAR_VIEW_CORNERS = [[0, 0], [1, 0], [1, 1], [0, 1]] as const;
const RADAR_VIEW_STROKE = 'rgba(255,255,255,0.36)';
const LOCAL_PANEL_PAD = 14;
const LOCAL_PANEL_GAP = 10;
const LOCAL_BAR_HEIGHT = 12;
const LOCAL_MINOR_BAR_HEIGHT = 10;
const LOCAL_CHIP_HEIGHT = 34;
const LOCAL_COMPACT_CHIP_HEIGHT = 18;
const LOCAL_BOSS_DIAGRAM_HEIGHT = 82;
const LOCAL_SECTION_GAP = 8;
const LOCAL_ROW_GAP = 4;
const LOCAL_LABEL_SIZE = 10;
const LOCAL_TOP_LABEL_SIZE = 11;
const LOCAL_VALUE_SIZE = 11;
const LOCAL_TITLE_SIZE = 12;
const LOCAL_LABEL_TO_BAR = 4;
/** Threshold markers under the energy bar: how far below the bar's top their labels sit, and how tall those labels are. */
const LOCAL_MARKER_LABEL_DROP = 24;
const LOCAL_MARKER_LABEL_HEIGHT = 6;
const LOCAL_COMPACT_CHIP_PITCH = 22;
/** Tall chip rows, in pixels from the chip's top: key, name (and status), then the optional progress bar. */
/** Label tracking candidates, widest first, and the least space kept between a row's label and its value. */
const METRIC_TRACKINGS = [UI_CAPS_SPACING, '0.1em', '0em'] as const;
const METRIC_ROW_MIN_GAP = 6;
const COMPACT_CHIP_INSET = 7;
const COMPACT_CHIP_GAP = 4;
const COMPACT_HINT_SIZE = 8.5;
const COMPACT_TITLE_SIZE = 8.8;
/** The key column is at least this wide so the names of stacked compact chips line up. */
const COMPACT_HINT_COLUMN = 18;
/** The boss-form attack chips, in display order (left click, right click, ultima key). */
const BOSS_ATTACKS = [Attack.Salvo, Attack.Siege, Attack.Ultima] as const;
const CHIP_INSET = 9;
const CHIP_HINT_SIZE = 8.5;
const CHIP_TITLE_SIZE = 10;
const CHIP_STATUS_SIZE = 10.5;
const CHIP_HINT_BASELINE = 11;
const CHIP_TITLE_BASELINE = 22;
const CHIP_PROGRESS_TOP = 26;
const CHIP_PROGRESS_HEIGHT = 4;
const ATTACK_CHIP_COUNT = 3;
const ALERT_FRAME_INSET = 2;
const ALERT_FRAME_WIDTH = 2.5;
const SAFE_INDICATOR_GAP = 6;
/** Room one off-screen pointer needs along its edge: a chevron plus its label, stacked (vertical edges) or side by side. */
const INDICATOR_SLOT_VERTICAL = 40;
const INDICATOR_SLOT_HORIZONTAL = 64;
const METER_SMOOTH_RATE = 14;
const HP_GHOST_DELAY = 0.28;
const HP_GHOST_DRAIN_RATE = 0.42;
const ENERGY_SHIMMER_SECONDS = 0.62;
const ENERGY_SHIMMER_GAIN = GAUGE_SCALE * 4;
const CHIP_READY_POP_SECONDS = 0.34;
const SCORE_ROW_MOVE_SECONDS = 0.3;
const SCORE_ROW_SHIFT = 12;
const FEED_SLIDE_DISTANCE = 24;
const BANNER_REVEAL_SECONDS = 0.42;
const BANNER_PUNCH_SECONDS = 0.28;
const BANNER_GLITCH_SECONDS = 0.52;
const BANNER_SLICE_OFFSET = 10;
const BANNER_SWEEP_SECONDS = 0.58;
const COUNTDOWN_PUNCH_SCALE = 0.28;
const COUNTDOWN_ALPHA = 0.86;
const OFFSCREEN_BOB = 4;
const BEAT_ACCENT_BREATH = 0.1;
const SCRAMBLE_GLYPHS = 'B0S5F0RM-XV/\\<>[]';

const LABEL_FONT_WEIGHT = 600;
const BODY_FONT_WEIGHT = 500;
const TITLE_FONT_WEIGHT = 700;

const ATTACK_LABELS = ['—', 'SALVO', 'SIEGE', 'ULTIMA'] as const;
const PHASE_LABELS = ['READY', 'WIND-UP', 'RELEASING', 'RECOVERY'] as const;
const NORMAL_ALT_LABELS = ['SEEKERS', 'PHASE DASH', 'BULWARK'] as const;
const NORMAL_ALT_COOLDOWNS = [VANGUARD.seekers.cooldown, GALE.dash.cooldown, JUGGERNAUT.bulwark.cooldown] as const;

interface KillFeedItem {
  readonly kind: 'kill' | 'left';
  readonly at: number;
  readonly victim: number;
  readonly killer: number;
  readonly bossKill: boolean;
}

interface BannerItem {
  readonly title: string;
  readonly subtitle: string;
  readonly at: number;
  readonly duration: number;
  readonly color: string;
}

interface UltimaAlert {
  readonly seat: number;
  readonly untilTick: number;
}

interface DamageWindowState {
  amount: number;
  cap: number;
  closeTick: number;
  blockedUntil: number;
  hitUntil: number;
}

interface SeatMotionState {
  hpFill: number;
  hpGhost: number;
  hpGhostHoldUntil: number;
  lastHpFill: number;
  energyFill: number;
  lastGauge: number;
  energyShimmerUntil: number;
  altReady: boolean;
  altReadyAt: number;
  transformReady: boolean;
  transformReadyAt: number;
  attackReady: boolean[];
  attackReadyAt: number[];
}

interface ScoreRowMotion {
  rank: number;
  movedAt: number;
}

interface TeamGroup {
  readonly team: number;
  readonly rows: readonly number[];
  readonly solo: boolean;
}

/** A point on the inset screen edge; `vertical` is true on the left and right edges. */
interface EdgeSpot {
  x: number;
  y: number;
  vertical: boolean;
}

/** One off-screen pointer: its edge spot, the chevron and the label under it. */
interface EdgeMark extends EdgeSpot {
  readonly angle: number;
  readonly size: number;
  readonly color: string;
  readonly alpha: number;
  readonly label: string;
  readonly labelColor: string;
}

interface ChipSpec {
  readonly title: string;
  readonly hint: string;
  readonly status: string;
  /** Used instead of `status` when the chip is too narrow for both the name and the full status. */
  readonly shortStatus?: string;
  readonly color: string;
  readonly alpha: number;
  readonly progress?: ChipProgress;
}

interface ChipProgress {
  readonly fill: number;
  readonly color: string;
}

interface MeterMotion {
  readonly ghost?: number;
  readonly shimmer?: number;
  readonly flash?: number;
  readonly sheen?: number;
}

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Row positions of the local pilot's panel, in pixels from the panel's top-left (see measureLocalPanel). */
interface LocalPanelLayout {
  readonly boss: boolean;
  readonly height: number;
  readonly leftX: number;
  readonly leftWidth: number;
  readonly rightX: number;
  readonly rightWidth: number;
  readonly titleBaseline: number;
  readonly hpLabel: number;
  readonly hpBar: number;
  readonly windowLabel: number;
  readonly windowBar: number;
  readonly energyLabel: number;
  readonly energyBar: number;
  readonly formLine: number;
  readonly tellLine: number;
  readonly diagram: number;
  readonly diagramHeight: number;
  readonly attackChips: number;
  readonly cooldownChip: number;
  readonly transformChip: number;
}

export interface HudView {
  readonly world: World;
  readonly seat: number;
  readonly names: readonly string[];
  readonly width: number;
  readonly height: number;
  /** World units to CSS pixels on the overlay (Stage.project). */
  readonly project: (x: number, y: number, out: { x: number; y: number }) => void;
  /** CSS pixels on the overlay to the floor point under them, in world units (Stage.ground). */
  readonly ground: (cssX: number, cssY: number, out: { x: number; y: number }) => void;
  /** Where a pilot is DRAWN this frame, in CSS pixels (interpolated like the ship itself; Stage.seatScreen). */
  readonly seatScreen: (seat: number, out: { x: number; y: number }) => void;
  /** The music's beat, for accents that pulse in time. */
  readonly beat: Beat;
  readonly time: number;
  readonly cursor: { x: number; y: number } | null;
}

export class Hud {
  private readonly killFeed: KillFeedItem[] = [];
  private readonly banners: BannerItem[] = [];
  private readonly ultimaAlerts: UltimaAlert[] = [];
  private readonly windows: DamageWindowState[] = [];
  private readonly seatMotion: SeatMotionState[] = [];
  private readonly scoreMotion = new Map<number, ScoreRowMotion>();
  private scale = 1;
  private occluders: Rect[] = [];
  private lastDrawTime = 0;

  handleEvents(world: World): void {
    const now = world.m.world[W.Tick] / TICK_RATE;
    this.syncSeatState(world);
    const { m } = world;
    for (let i = 0; i < world.events.count; i++) {
      const type = world.events.type[i];
      const a = world.events.a[i];
      const b = world.events.b[i];
      if (type === Ev.Blocked && a >= 0) {
        this.windows[a].blockedUntil = now + BLOCK_FLASH_SECONDS;
      } else if ((type === Ev.Hit || type === Ev.StormHit) && a >= 0) {
        this.windows[a].hitUntil = now + HIT_PULSE_SECONDS;
      } else if (type === Ev.Death && a >= 0) {
        this.killFeed.unshift({ kind: 'kill', at: now, victim: a, killer: b, bossKill: world.events.c[i] === 1 });
      } else if (type === Ev.Left && a >= 0) {
        this.killFeed.unshift({ kind: 'left', at: now, victim: a, killer: NO_SEAT, bossKill: false });
      } else if (type === Ev.Windup && b === Attack.Ultima && a >= 0) {
        const windup = FORMS[m.plFrame[a]].ultima.windup;
        this.ultimaAlerts.push({ seat: a, untilTick: m.world[W.Tick] + windup });
      } else if (type === Ev.Banner) {
        this.pushBanner(this.bannerFromEvent(a, b, world, now));
      } else if (type === Ev.RoundEnd) {
        this.pushBanner(this.bannerFromRoundEnd(a, b, world, now));
      } else if (type === Ev.StormStart) {
        this.pushBanner({ title: 'SUDDEN DEATH', subtitle: 'SAFE ZONE COLLAPSING', at: now, duration: BANNER_LIFETIME + 0.6, color: UI_WARNING });
      }
    }
    this.trimTransient(world, now);
  }

  draw(ctx: CanvasRenderingContext2D, view: HudView): void {
    const { world, width, height, time } = view;
    this.syncSeatState(world);
    this.updateDamageWindowState(world);
    const dt = this.lastDrawTime === 0 ? 0 : clamp(time - this.lastDrawTime, 0, 1 / 12);
    this.lastDrawTime = time;
    this.updateSeatMotion(world, time, dt);
    this.scale = clamp(Math.min(width / 1280, height / 720), 0.65, 1.4);
    const margin = this.s(HUD_MARGIN);
    const scoreboardRect = this.rect(margin, margin, this.s(SCOREBOARD_WIDTH), 0);
    const feedRect = this.rect(width - this.s(FEED_WIDTH) - margin, margin, this.s(FEED_WIDTH), 0);
    const timerRect = this.rect(width * 0.5 - this.s(TIMER_WIDTH) * 0.5, margin, this.s(TIMER_WIDTH), 0);
    const radarSize = this.s(RADAR_BASE);
    const radarRect = this.rect(margin, height - margin - radarSize, radarSize, radarSize);
    const localWidth = clamp(width * (this.scale < 0.85 ? 0.28 : 0.33), this.s(300), this.s(440));
    const localLayout = this.measureLocalPanel(ctx, world, view.seat, localWidth);
    const localRect = this.rect(width * 0.5 - localWidth * 0.5, height - margin - localLayout.height, localWidth, localLayout.height);
    this.occluders = [scoreboardRect, feedRect, radarRect, localRect];
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    this.drawNameTags(ctx, view);
    this.drawScoreboard(ctx, view, scoreboardRect.x, scoreboardRect.y, scoreboardRect.width);
    this.drawKillFeed(ctx, view, feedRect.x, feedRect.y, feedRect.width);
    this.drawTimer(ctx, view, timerRect.x, timerRect.y, timerRect.width);
    this.drawRadar(ctx, view, radarRect.x, radarRect.y, radarRect.width);
    this.drawLocalPanel(ctx, view, localRect, localLayout);
    this.drawOffscreenIndicators(ctx, view);
    this.drawUltimaAlert(ctx, view);
    this.drawCenterBanners(ctx, view);
    this.drawCountdownPulse(ctx, view);
    this.drawStateWarnings(ctx, view, time);
    this.drawReticle(ctx, view);
    ctx.restore();
  }

  private s(value: number): number {
    return value * this.scale;
  }

  /** Screen position of a simulation coordinate pair (fixed point): the Stage projects world units. */
  private screenOf(view: HudView, rawX: number, rawY: number, out: { x: number; y: number }): void {
    view.project(fx.toFloat(rawX), fx.toFloat(rawY), out);
  }

  private rect(x: number, y: number, width: number, height: number): Rect {
    return { x, y, width, height };
  }

  private syncSeatState(world: World): void {
    while (this.windows.length < world.seats) {
      this.windows.push({ amount: 0, cap: 1, closeTick: 0, blockedUntil: 0, hitUntil: 0 });
    }
    while (this.seatMotion.length < world.seats) {
      this.seatMotion.push({
        hpFill: 1,
        hpGhost: 1,
        hpGhostHoldUntil: 0,
        lastHpFill: 1,
        energyFill: 0,
        lastGauge: 0,
        energyShimmerUntil: 0,
        altReady: false,
        altReadyAt: 0,
        transformReady: false,
        transformReadyAt: 0,
        attackReady: Array.from({ length: ATTACK_CHIP_COUNT }, () => false),
        attackReadyAt: Array.from({ length: ATTACK_CHIP_COUNT }, () => 0),
      });
    }
  }

  private smoothStep(current: number, target: number, dt: number, rate: number): number {
    const amount = 1 - Math.exp(-rate * dt);
    return lerp(current, target, amount);
  }

  private updateSeatMotion(world: World, time: number, dt: number): void {
    const { m } = world;
    for (let seat = 0; seat < world.seats; seat++) {
      const state = this.seatMotion[seat];
      const stats = FRAME_STATS[m.plFrame[seat]];
      const hpTarget = invLerp(0, stats.hp, m.plHp[seat]);
      if (hpTarget < state.lastHpFill) state.hpGhostHoldUntil = time + HP_GHOST_DELAY;
      state.hpFill = dt === 0 ? hpTarget : this.smoothStep(state.hpFill, hpTarget, dt, METER_SMOOTH_RATE);
      if (hpTarget >= state.hpGhost) state.hpGhost = hpTarget;
      else if (time > state.hpGhostHoldUntil) state.hpGhost = Math.max(hpTarget, state.hpGhost - HP_GHOST_DRAIN_RATE * dt);
      state.lastHpFill = hpTarget;

      const gauge = m.plGauge[seat];
      const energyTarget = clamp(gauge / GAUGE_MAX, 0, 1);
      state.energyFill = dt === 0 ? energyTarget : this.smoothStep(state.energyFill, energyTarget, dt, METER_SMOOTH_RATE);
      if (gauge - state.lastGauge >= ENERGY_SHIMMER_GAIN) state.energyShimmerUntil = time + ENERGY_SHIMMER_SECONDS;
      state.lastGauge = gauge;

      const altReady = m.plAltCd[seat] === 0;
      if (altReady && !state.altReady) state.altReadyAt = time;
      state.altReady = altReady;
      const transformReady = gauge >= BOSS_MIN_GAUGE;
      if (transformReady && !state.transformReady) state.transformReadyAt = time;
      state.transformReady = transformReady;
      BOSS_ATTACKS.forEach((attack, index) => {
        const ready = m.plForm[seat] === Form.Boss && canStartAttack(world, seat, attack);
        if (ready && !state.attackReady[index]) state.attackReadyAt[index] = time;
        state.attackReady[index] = ready;
      });
    }
  }

  private trimTransient(world: World, now: number): void {
    this.killFeed.splice(6);
    for (let i = this.killFeed.length - 1; i >= 0; i--) if (now - this.killFeed[i].at > FEED_LIFETIME) this.killFeed.splice(i, 1);
    for (let i = this.banners.length - 1; i >= 0; i--) if (now - this.banners[i].at > this.banners[i].duration) this.banners.splice(i, 1);
    for (let i = this.ultimaAlerts.length - 1; i >= 0; i--) if (this.ultimaAlerts[i].untilTick <= world.m.world[W.Tick]) this.ultimaAlerts.splice(i, 1);
  }

  private updateDamageWindowState(world: World): void {
    const { m } = world;
    const tick = m.world[W.Tick];
    for (let seat = 0; seat < world.seats; seat++) {
      const state = this.windows[seat];
      const stats = FRAME_STATS[m.plFrame[seat]];
      state.cap = stats.windowCap;
      if (m.plWinEnd[seat] > tick) {
        state.amount = m.plWinDmg[seat];
        state.closeTick = m.plWinEnd[seat];
      }
    }
  }

  private bannerFromEvent(id: number, value: number, world: World, now: number): BannerItem {
    switch (id) {
      case Banner.Round:
        return { title: `ROUND ${value}`, subtitle: world.isDeathmatch ? 'DEATHMATCH' : 'ELIMINATION', at: now, duration: BANNER_LIFETIME, color: UI_ACCENT };
      case Banner.Fight:
        return { title: 'FIGHT', subtitle: 'ENGAGE', at: now, duration: 1.8, color: UI_SUCCESS };
      case Banner.RoundWon:
        return { title: 'ROUND WON', subtitle: '', at: now, duration: BANNER_LIFETIME, color: UI_SUCCESS };
      case Banner.Draw:
        return { title: 'DRAW', subtitle: '', at: now, duration: BANNER_LIFETIME, color: UI_WARNING };
      case Banner.MatchWon:
        return { title: 'MATCH WON', subtitle: '', at: now, duration: BANNER_LIFETIME + 0.5, color: UI_SUCCESS };
      case Banner.TimeUp:
        return { title: 'TIME UP', subtitle: '', at: now, duration: BANNER_LIFETIME, color: UI_WARNING };
      default:
        throw new RangeError(`unknown banner id ${id}`);
    }
  }

  private bannerFromRoundEnd(winner: number, ended: number, world: World, now: number): BannerItem {
    const title = winner === NO_WINNER ? (world.isDeathmatch ? 'TIME UP' : 'DRAW') : ended === 1 ? 'MATCH WON' : 'ROUND WON';
    const subtitle = winner === NO_WINNER ? '' : `TEAM ${winner + 1}`;
    return { title, subtitle, at: now, duration: BANNER_LIFETIME + (ended === 1 ? 0.4 : 0), color: winner === NO_WINNER ? UI_WARNING : cssHex(teamColor(winner)) };
  }

  private pushBanner(item: BannerItem): void {
    this.banners.push(item);
    if (this.banners.length > 5) this.banners.shift();
  }

  private drawPanel(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, accent: string): void {
    ctx.save();
    const cut = this.s(PANEL_CUT);
    drawChamferRect(ctx, x, y, width, height, cut);
    ctx.fillStyle = UI_HUD_PANEL;
    ctx.fill();
    ctx.strokeStyle = UI_EDGE_SOFT;
    strokeGlow(ctx, accent, this.s(PANEL_GLOW), this.s(1.25), () => drawChamferRect(ctx, x, y, width, height, cut));
    ctx.strokeStyle = accent;
    ctx.lineWidth = this.s(1.05);
    drawChamferRect(ctx, x, y, width, height, cut);
    ctx.stroke();
    ctx.restore();
  }

  private drawSectionLabel(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string): void {
    ctx.save();
    ctx.font = `${LABEL_FONT_WEIGHT} ${this.s(11)}px ${UI_FONT_STACK}`;
    ctx.letterSpacing = UI_CAPS_SPACING;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  private drawMeter(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, fill: number, color: string, back = 'rgba(255,255,255,0.08)', motion?: MeterMotion): void {
    const amount = clamp(fill, 0, 1);
    const cut = Math.min(this.s(6), height * 0.5);
    ctx.save();
    ctx.fillStyle = back;
    drawChamferRect(ctx, x, y, width, height, cut);
    ctx.fill();
    const ghost = motion?.ghost === undefined ? 0 : clamp(motion.ghost, 0, 1);
    if (ghost > amount) {
      const ghostWidth = Math.max(height, width * ghost);
      ctx.fillStyle = 'rgba(255,255,255,0.16)';
      drawChamferRect(ctx, x, y, ghostWidth, height, cut);
      ctx.fill();
    }
    if (amount > 0) {
      const fillWidth = Math.max(height, width * amount);
      const gradient = ctx.createLinearGradient(x, y, x + fillWidth, y);
      gradient.addColorStop(0, rgba(0xffffff, 0.06));
      gradient.addColorStop(0.1, color);
      gradient.addColorStop(1, rgba(0xffffff, 0.14));
      ctx.fillStyle = gradient;
      drawChamferRect(ctx, x, y, fillWidth, height, cut);
      ctx.fill();
      ctx.shadowColor = color;
      ctx.shadowBlur = this.s(12);
      ctx.strokeStyle = color;
      ctx.lineWidth = this.s(1);
      drawChamferRect(ctx, x, y, fillWidth, height, cut);
      ctx.stroke();
      const sheen = motion?.sheen ?? 0;
      if (sheen > 0) {
        const sweepWidth = Math.max(height * 2.4, width * 0.18);
        const offset = (sheen % 1) * (fillWidth + sweepWidth) - sweepWidth;
        const sheenGradient = ctx.createLinearGradient(x + offset, y, x + offset + sweepWidth, y);
        sheenGradient.addColorStop(0, 'rgba(255,255,255,0)');
        sheenGradient.addColorStop(0.5, 'rgba(255,255,255,0.34)');
        sheenGradient.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.save();
        drawChamferRect(ctx, x, y, fillWidth, height, cut);
        ctx.clip();
        ctx.fillStyle = sheenGradient;
        ctx.fillRect(x + offset, y, sweepWidth, height);
        ctx.restore();
      }
      const shimmer = motion?.shimmer ?? 0;
      if (shimmer > 0) {
        ctx.globalAlpha = shimmer * 0.45;
        ctx.fillStyle = color;
        ctx.fillRect(x, y - this.s(2), fillWidth, this.s(1));
        ctx.fillRect(x, y + height + this.s(1), fillWidth, this.s(1));
      }
    }
    const flash = motion?.flash ?? 0;
    if (flash > 0) {
      ctx.globalAlpha = flash;
      ctx.strokeStyle = UI_WARNING;
      ctx.lineWidth = this.s(2);
      drawChamferRect(ctx, x - this.s(1), y - this.s(1), width + this.s(2), height + this.s(2), cut);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawScoreboard(ctx: CanvasRenderingContext2D, view: HudView, x: number, y: number, width: number): void {
    const { world, seat, names } = view;
    const groups = this.groupTeams(world);
    const rowHeight = this.s(20);
    const rowGap = this.s(TEAM_ROW_GAP);
    const rows: Array<{ team: number; seat: number }> = [];
    groups.forEach((group) => group.rows.forEach((rowSeat) => rows.push({ team: group.team, seat: rowSeat })));
    const visible = rows.slice(0, SCOREBOARD_MAX_ROWS);
    visible.forEach((row, rank) => {
      const previous = this.scoreMotion.get(row.seat);
      if (previous === undefined) this.scoreMotion.set(row.seat, { rank, movedAt: view.time - SCORE_ROW_MOVE_SECONDS });
      else if (previous.rank !== rank) this.scoreMotion.set(row.seat, { rank, movedAt: view.time });
    });
    const extra = Math.max(0, rows.length - visible.length);
    const headerCount = groups.filter((group) => !group.solo).length;
    const height = this.s(32) + visible.length * (rowHeight + rowGap) + headerCount * this.s(14) + (extra > 0 ? this.s(18) : 0) + this.s(10);
    this.drawPanel(ctx, x, y, width, height, UI_EDGE);
    this.drawSectionLabel(ctx, world.isDeathmatch ? 'SCOREBOARD' : 'PILOTS', x + this.s(14), y + this.s(18), UI_TEXT_DIM);
    let cy = y + this.s(30);
    for (const group of groups) {
      if (!group.solo) {
        ctx.save();
        ctx.font = `${LABEL_FONT_WEIGHT} ${this.s(10)}px ${UI_FONT_STACK}`;
        ctx.letterSpacing = UI_CAPS_SPACING;
        ctx.fillStyle = cssHex(teamColor(group.team));
        const header = world.isDeathmatch ? `TEAM ${group.team + 1}  ${world.m.teamScore[group.team]}` : `TEAM ${group.team + 1}`;
        ctx.fillText(header, x + this.s(14), cy);
        if (!world.isDeathmatch) this.drawHeaderPips(ctx, x + width - this.s(16), cy - this.s(3), group.team, world);
        ctx.restore();
        cy += this.s(10);
      }
      for (const rowSeat of group.rows) {
        if (!visible.some((row) => row.seat === rowSeat)) continue;
        const rowMotion = this.scoreMotion.get(rowSeat);
        const moveAge = rowMotion === undefined ? SCORE_ROW_MOVE_SECONDS : view.time - rowMotion.movedAt;
        const moveT = easeOutCubic(clamp(moveAge / SCORE_ROW_MOVE_SECONDS, 0, 1));
        const animatedCy = cy + (1 - moveT) * this.s(SCORE_ROW_SHIFT);
        const alive = world.m.plAlive[rowSeat] === 1;
        const local = rowSeat === seat;
        const boss = world.m.plForm[rowSeat] === Form.Boss;
        const teamTint = cssHex(teamColor(group.team));
        ctx.save();
        ctx.globalAlpha = lerp(0.72, 1, moveT);
        if (local) {
          ctx.fillStyle = rgba(teamColor(group.team), 0.16);
          drawChamferRect(ctx, x + this.s(10), animatedCy, width - this.s(20), rowHeight, this.s(8));
          ctx.fill();
        }
        ctx.strokeStyle = rgba(teamColor(group.team), 0.26);
        ctx.lineWidth = this.s(1);
        drawChamferRect(ctx, x + this.s(10), animatedCy, width - this.s(20), rowHeight, this.s(8));
        ctx.stroke();
        ctx.font = `${BODY_FONT_WEIGHT} ${this.s(11.5)}px ${UI_FONT_STACK}`;
        ctx.fillStyle = alive ? teamTint : 'rgba(206,227,245,0.34)';
        ctx.textBaseline = 'middle';
        if (group.solo) {
          ctx.beginPath();
          ctx.arc(x + this.s(18), animatedCy + rowHeight * 0.5, this.s(3), 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillText(names[rowSeat] ?? `P${rowSeat + 1}`, x + this.s(group.solo ? 28 : 18), animatedCy + rowHeight * 0.5);
        ctx.fillStyle = UI_TEXT;
        ctx.textAlign = 'right';
        const suffix = world.isDeathmatch ? `${world.m.plKills[rowSeat]} / ${world.m.plDeaths[rowSeat]}` : `${world.m.plKills[rowSeat]}K ${world.m.plDeaths[rowSeat]}D`;
        ctx.fillText(suffix, x + width - this.s(20), animatedCy + rowHeight * 0.5);
        ctx.textAlign = 'left';
        if (boss) this.drawBossBadge(ctx, x + width - this.s(54), animatedCy + rowHeight * 0.5, cssHex(teamColor(group.team)), 1);
        if (!alive) {
          ctx.fillStyle = 'rgba(255,255,255,0.38)';
          ctx.fillText('☠', x + width - this.s(32), animatedCy + rowHeight * 0.5);
        }
        ctx.restore();
        cy += rowHeight + rowGap;
      }
      cy += group.solo ? 0 : this.s(6);
    }
    if (extra > 0) {
      ctx.save();
      ctx.font = `${BODY_FONT_WEIGHT} ${this.s(12)}px ${UI_FONT_STACK}`;
      ctx.fillStyle = UI_TEXT_DIM;
      ctx.fillText(`+${extra} MORE`, x + this.s(14), y + height - this.s(10));
      ctx.restore();
    }
  }

  private groupTeams(world: World): TeamGroup[] {
    const seen: number[] = [];
    for (let seat = 0; seat < world.seats; seat++) if (!seen.includes(world.m.plTeam[seat])) seen.push(world.m.plTeam[seat]);
    const groups = seen.map((team) => {
      const rows = Array.from({ length: world.seats }, (_, seat) => seat).filter((seat) => world.m.plTeam[seat] === team)
        .sort((a, b) => (world.m.plAlive[b] - world.m.plAlive[a]) || (world.m.plKills[b] - world.m.plKills[a]) || (a - b));
      return { team, rows, solo: rows.length === 1 };
    });
    return groups.sort((a, b) => {
      const scoreA = world.isDeathmatch ? world.m.teamScore[a.team] : world.m.teamWins[a.team];
      const scoreB = world.isDeathmatch ? world.m.teamScore[b.team] : world.m.teamWins[b.team];
      const killsA = a.rows.reduce((sum, seat) => sum + world.m.plKills[seat], 0);
      const killsB = b.rows.reduce((sum, seat) => sum + world.m.plKills[seat], 0);
      return (scoreB - scoreA) || (killsB - killsA) || (a.team - b.team);
    });
  }

  private drawHeaderPips(ctx: CanvasRenderingContext2D, x: number, y: number, team: number, world: World): void {
    for (let pip = 0; pip < ROUNDS_TO_WIN; pip++) {
      ctx.beginPath();
      ctx.arc(x - pip * this.s(12), y, this.s(3), 0, Math.PI * 2);
      ctx.fillStyle = pip < world.m.teamWins[team] ? cssHex(teamColor(team)) : 'rgba(255,255,255,0.14)';
      ctx.fill();
    }
  }

  private drawBossBadge(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, alpha: number): void {
    ctx.save();
    ctx.translate(x, y);
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    const size = this.s(BOSS_ICON_SIZE);
    ctx.lineWidth = this.s(1.2);
    ctx.beginPath();
    ctx.moveTo(0, -size);
    ctx.lineTo(size * 0.8, 0);
    ctx.lineTo(0, size);
    ctx.lineTo(-size * 0.8, 0);
    ctx.closePath();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-this.s(5), 0);
    ctx.lineTo(this.s(5), 0);
    ctx.stroke();
    ctx.restore();
  }

  private drawKillFeed(ctx: CanvasRenderingContext2D, view: HudView, x: number, y: number, width: number): void {
    const { names, time, world } = view;
    const rowHeight = this.s(FEED_ROW_HEIGHT);
    const height = this.s(30) + Math.max(1, this.killFeed.length) * rowHeight;
    this.drawPanel(ctx, x, y, width, height, UI_EDGE);
    this.drawSectionLabel(ctx, 'FEED', x + this.s(14), y + this.s(18), UI_TEXT_DIM);
    this.killFeed.forEach((item, index) => {
      const age = time - item.at;
      const fade = 1 - easeOutCubic(clamp(age / FEED_LIFETIME, 0, 1));
      const enter = easeOutCubic(clamp(age / 0.22, 0, 1));
      const rowY = y + this.s(30) + index * rowHeight;
      ctx.save();
      ctx.globalAlpha = fade;
      ctx.translate((1 - enter) * this.s(FEED_SLIDE_DISTANCE), 0);
      ctx.font = `${BODY_FONT_WEIGHT} ${this.s(12)}px ${UI_FONT_STACK}`;
      ctx.textBaseline = 'middle';
      if (item.kind === 'left') {
        ctx.fillStyle = UI_TEXT_DIM;
        ctx.fillText(`${names[item.victim] ?? `P${item.victim + 1}`} LEFT`, x + this.s(14), rowY + rowHeight * 0.5);
      } else {
        const killerTeam = item.killer >= 0 ? world.m.plTeam[item.killer] : -1;
        const victimTeam = world.m.plTeam[item.victim];
        const killerName = item.killer >= 0 ? (names[item.killer] ?? `P${item.killer + 1}`) : 'STORM';
        const victimName = names[item.victim] ?? `P${item.victim + 1}`;
        if (item.bossKill) {
          ctx.fillStyle = rgba(0xff6a80, 0.1 + (1 - enter) * 0.16);
          drawChamferRect(ctx, x + this.s(9), rowY + this.s(2), width - this.s(18), rowHeight - this.s(4), this.s(7));
          ctx.fill();
        }
        ctx.fillStyle = item.killer >= 0 ? cssHex(teamColor(killerTeam)) : UI_WARNING;
        ctx.fillText(killerName, x + this.s(14), rowY + rowHeight * 0.5);
        const killerWidth = ctx.measureText(killerName).width;
        ctx.fillStyle = UI_TEXT_DIM;
        ctx.fillText(item.bossKill ? '  >  ' : '  ›  ', x + this.s(14) + killerWidth, rowY + rowHeight * 0.5);
        ctx.fillStyle = cssHex(teamColor(victimTeam));
        ctx.fillText(victimName, x + this.s(48) + killerWidth, rowY + rowHeight * 0.5);
        if (item.bossKill) {
          ctx.fillStyle = UI_WARNING;
          ctx.textAlign = 'right';
          ctx.fillText('BOSS', x + width - this.s(14), rowY + rowHeight * 0.5);
          ctx.textAlign = 'left';
        }
      }
      ctx.restore();
    });
  }

  private drawTimer(ctx: CanvasRenderingContext2D, view: HudView, x: number, y: number, width: number): void {
    const { world } = view;
    const phase = world.m.world[W.Phase];
    const roundTick = world.m.world[W.RoundTick];
    const height = world.isDeathmatch ? this.s(70) : this.s(88);
    this.drawPanel(ctx, x, y, width, height, UI_ACCENT);
    this.drawSectionLabel(ctx, world.isDeathmatch ? 'DEATHMATCH' : `ROUND ${world.m.world[W.Round]}`, x + this.s(14), y + this.s(18), UI_TEXT_DIM);
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = UI_TEXT;
    ctx.font = `${TITLE_FONT_WEIGHT} ${this.s(28)}px ${UI_FONT_STACK}`;
    const topLabel = phase === Phase.Countdown ? formatCompactSeconds(world.m.world[W.PhaseTimer] / TICK_RATE) : world.isDeathmatch ? formatClock((DEATHMATCH_TICKS - roundTick) / TICK_RATE) : formatClock(Math.max(0, (SUDDEN_DEATH_TICKS - roundTick) / TICK_RATE));
    ctx.fillText(topLabel, x + width * 0.5, y + this.s(38));
    ctx.restore();
    if (world.isDeathmatch) return;
    this.drawTeamWins(ctx, world, x + this.s(14), y + this.s(54), width - this.s(28));
    if (roundTick >= SUDDEN_DEATH_TICKS) {
      const remaining = Math.max(0, (SHRINK_TICKS - (roundTick - SUDDEN_DEATH_TICKS)) / TICK_RATE);
      ctx.save();
      ctx.font = `${LABEL_FONT_WEIGHT} ${this.s(11)}px ${UI_FONT_STACK}`;
      ctx.fillStyle = UI_WARNING;
      ctx.textAlign = 'center';
      ctx.fillText(`SUDDEN DEATH  ${formatClock(remaining)}`, x + width * 0.5, y + height - this.s(12));
      ctx.restore();
    }
  }

  private drawTeamWins(ctx: CanvasRenderingContext2D, world: World, x: number, y: number, width: number): void {
    const teams = this.groupTeams(world);
    const step = width / Math.max(teams.length, 1);
    teams.forEach((group, index) => {
      const cx = x + step * index + step * 0.5;
      ctx.save();
      ctx.font = `${LABEL_FONT_WEIGHT} ${this.s(10)}px ${UI_FONT_STACK}`;
      ctx.fillStyle = cssHex(teamColor(group.team));
      ctx.textAlign = 'center';
      ctx.fillText(`T${group.team + 1}`, cx, y);
      for (let pip = 0; pip < ROUNDS_TO_WIN; pip++) {
        ctx.beginPath();
        ctx.arc(cx - this.s(8) + pip * this.s(16), y + this.s(16), this.s(4), 0, Math.PI * 2);
        ctx.fillStyle = pip < world.m.teamWins[group.team] ? cssHex(teamColor(group.team)) : 'rgba(255,255,255,0.14)';
        ctx.fill();
      }
      ctx.restore();
    });
  }

  /**
   * Every row of the local pilot's panel, measured once from the fonts that draw it. Offsets are from the panel's top-left, so
   * the caller can anchor the panel to the bottom of the screen after learning how tall it must be: content never overflows.
   */
  private measureLocalPanel(ctx: CanvasRenderingContext2D, world: World, seat: number, width: number): LocalPanelLayout {
    const boss = world.m.plForm[seat] === Form.Boss;
    const pad = this.s(LOCAL_PANEL_PAD);
    const gap = this.s(LOCAL_PANEL_GAP);
    const sectionGap = this.s(LOCAL_SECTION_GAP);
    const labelLine = this.lineHeight(ctx, LABEL_FONT_WEIGHT, this.s(LOCAL_LABEL_SIZE));
    const topLine = this.lineHeight(ctx, LABEL_FONT_WEIGHT, this.s(LOCAL_TOP_LABEL_SIZE));
    const titleLine = this.lineHeight(ctx, TITLE_FONT_WEIGHT, this.s(LOCAL_TITLE_SIZE));
    const barHeight = this.s(LOCAL_BAR_HEIGHT);
    const minorBarHeight = this.s(LOCAL_MINOR_BAR_HEIGHT);
    const leftWidth = width * (boss ? 0.56 : 0.58) - pad;
    const rightWidth = width - pad * 2 - gap - leftWidth;

    const titleBaseline = pad + topLine;
    const hpLabel = titleBaseline + sectionGap + labelLine;
    const hpBar = hpLabel + this.s(LOCAL_LABEL_TO_BAR);
    const windowLabel = hpBar + barHeight + sectionGap + labelLine;
    const windowBar = windowLabel + this.s(LOCAL_LABEL_TO_BAR);
    const energyLabel = windowBar + minorBarHeight + sectionGap + labelLine;
    const energyBar = energyLabel + this.s(LOCAL_LABEL_TO_BAR);
    const markerBottom = energyBar + this.s(LOCAL_MARKER_LABEL_DROP) + this.s(LOCAL_MARKER_LABEL_HEIGHT);

    const formLine = markerBottom + sectionGap + titleLine;
    const tellLine = formLine + this.s(LOCAL_ROW_GAP) + titleLine;
    const diagramLabel = pad + labelLine;
    const diagramHeight = Math.max(this.s(LOCAL_BOSS_DIAGRAM_HEIGHT), rightWidth * 0.62);
    const diagram = diagramLabel + this.s(LOCAL_LABEL_TO_BAR) + this.s(2);
    const attackChips = diagram + diagramHeight + sectionGap;
    const attackChipsBottom = attackChips + this.s(LOCAL_COMPACT_CHIP_PITCH) * (ATTACK_CHIP_COUNT - 1) + this.s(LOCAL_COMPACT_CHIP_HEIGHT);
    const cooldownChip = titleBaseline + sectionGap;
    const transformChip = cooldownChip + this.s(LOCAL_CHIP_HEIGHT) + sectionGap;
    const normalChipsBottom = transformChip + this.s(LOCAL_CHIP_HEIGHT);

    const leftBottom = boss ? tellLine : markerBottom;
    const rightBottom = boss ? attackChipsBottom : normalChipsBottom;
    return {
      boss, height: Math.max(leftBottom, rightBottom) + pad,
      leftX: pad, leftWidth, rightX: pad + leftWidth + gap, rightWidth,
      titleBaseline, hpLabel, hpBar, windowLabel, windowBar, energyLabel, energyBar,
      formLine, tellLine, diagram, diagramHeight, attackChips, cooldownChip, transformChip,
    };
  }

  private drawLocalPanel(ctx: CanvasRenderingContext2D, view: HudView, rect: Rect, layout: LocalPanelLayout): void {
    const { world, seat, time } = view;
    const { m } = world;
    const frame = m.plFrame[seat];
    const stats = FRAME_STATS[frame];
    const accent = cssHex(teamColor(m.plTeam[seat]));
    const alive = m.plAlive[seat] === 1;
    const { x, y } = rect;
    const barHeight = this.s(LOCAL_BAR_HEIGHT);
    const minorBarHeight = this.s(LOCAL_MINOR_BAR_HEIGHT);
    const leftX = x + layout.leftX;
    const rightX = x + layout.rightX;
    const leftWidth = layout.leftWidth;
    const hpBarY = y + layout.hpBar;
    const motion = this.seatMotion[seat];
    const beatPulse = 1 + view.beat.pulse * BEAT_ACCENT_BREATH;

    this.drawPanel(ctx, x, y, rect.width, rect.height, accent);
    this.drawSectionLabel(ctx, alive ? 'LOCAL PILOT' : 'SPECTATOR', leftX, y + layout.titleBaseline, UI_TEXT_DIM);
    this.drawMetricRow(ctx, 'HP', `${Math.max(0, m.plHp[seat])} / ${stats.hp}`, leftX, y + layout.hpLabel, leftWidth, accent, accent);
    this.drawMeter(ctx, leftX, hpBarY, leftWidth, barHeight, motion.hpFill, accent, 'rgba(255,255,255,0.08)', { ghost: motion.hpGhost });
    const segments = Math.max(1, Math.ceil(stats.hp / stats.windowCap));
    for (let i = 1; i < segments; i++) {
      const sx = leftX + (leftWidth * i) / segments;
      ctx.save();
      ctx.strokeStyle = `rgba(255,255,255,${WINDOW_SEPARATOR_ALPHA})`;
      ctx.lineWidth = this.s(1);
      ctx.beginPath();
      ctx.moveTo(sx, hpBarY + this.s(1));
      ctx.lineTo(sx, hpBarY + barHeight - this.s(1));
      ctx.stroke();
      ctx.restore();
    }

    const windowRatio = this.damageWindowRatio(world, seat, time);
    const blocked = this.windows[seat].blockedUntil > time;
    const blockFlash = blocked ? clamp((this.windows[seat].blockedUntil - time) / BLOCK_FLASH_SECONDS, 0, 1) : 0;
    const windowColor = blocked ? UI_WARNING : UI_TEXT_DIM;
    this.drawMetricRow(ctx, 'DAMAGE WINDOW', `${Math.round(this.windows[seat].amount)} / ${stats.windowCap}`, leftX, y + layout.windowLabel, leftWidth, windowColor, windowColor);
    this.drawMeter(ctx, leftX, y + layout.windowBar, leftWidth, minorBarHeight, windowRatio, blocked ? UI_WARNING : '#ffcf69', 'rgba(255,255,255,0.08)', { flash: blockFlash });

    this.drawMetricRow(ctx, 'ENERGY', `${Math.floor(m.plGauge[seat] / GAUGE_SCALE)} / ${GAUGE_MAX / GAUGE_SCALE}`, leftX, y + layout.energyLabel, leftWidth, UI_TEXT_DIM, UI_TEXT);
    this.drawMeter(ctx, leftX, y + layout.energyBar, leftWidth, barHeight, motion.energyFill, '#7ae4ff', 'rgba(255,255,255,0.08)', {
      shimmer: clamp((motion.energyShimmerUntil - time) / ENERGY_SHIMMER_SECONDS, 0, 1),
      sheen: (time * 0.28 + view.beat.phase * 0.18) % 1,
    });
    this.drawGaugeMarkers(ctx, leftX, y + layout.energyBar, leftWidth, frame, m.plForm[seat], motion.transformReady, view.beat.pulse);

    if (layout.boss) {
      const seconds = m.plGauge[seat] / BOSS_DRAIN_PER_TICK / TICK_RATE;
      this.drawMetricHeader(ctx, FORM_NAMES[frame], leftX, y + layout.formLine, accent);
      ctx.save();
      ctx.font = `${TITLE_FONT_WEIGHT} ${this.s(LOCAL_TITLE_SIZE)}px ${UI_FONT_STACK}`;
      ctx.fillStyle = UI_TEXT;
      ctx.textAlign = 'right';
      ctx.fillText(`FUEL ${formatClock(seconds)}`, leftX + leftWidth, y + layout.formLine);
      ctx.restore();
      this.drawAttackTell(ctx, leftX, y + layout.tellLine, world, seat);
      this.drawPartIntegrity(ctx, rightX, y + layout.diagram, layout.rightWidth, layout.diagramHeight, world, seat);
      this.drawAttackReadiness(ctx, rightX, y + layout.attackChips, layout.rightWidth, frame, world, seat, time, view.beat.pulse);
    } else {
      const ready = m.plGauge[seat] >= BOSS_MIN_GAUGE;
      this.drawNormalCooldown(ctx, rightX, y + layout.cooldownChip, layout.rightWidth, world, seat, time);
      const missing = Math.ceil((BOSS_MIN_GAUGE - m.plGauge[seat]) / GAUGE_SCALE);
      const pop = this.readyPop(time, motion.transformReadyAt);
      this.drawAbilityChip(ctx, rightX, y + layout.transformChip, layout.rightWidth, this.s(LOCAL_CHIP_HEIGHT), {
        title: 'TRANSFORM',
        hint: 'SPACE',
        status: ready ? 'READY' : `${missing} MORE`,
        color: ready ? accent : UI_TEXT_DIM,
        alpha: ready ? clamp(0.78 + view.beat.pulse * 0.22, 0, 1) : 0.62,
      }, pop * beatPulse);
    }
  }

  private drawMetricHeader(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string): void {
    ctx.save();
    ctx.font = `${LABEL_FONT_WEIGHT} ${this.s(LOCAL_LABEL_SIZE)}px ${UI_FONT_STACK}`;
    ctx.letterSpacing = UI_CAPS_SPACING;
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  /**
   * One row of a meter block: a tracked caps label at the left and a value at the right. Both are measured with the fonts that
   * draw them; when they do not fit side by side the label's tracking is tightened step by step until they do.
   */
  private drawMetricRow(ctx: CanvasRenderingContext2D, label: string, value: string, x: number, baseline: number, width: number, labelColor: string, valueColor: string): void {
    ctx.save();
    ctx.font = `${BODY_FONT_WEIGHT} ${this.s(LOCAL_VALUE_SIZE)}px ${UI_FONT_STACK}`;
    const valueWidth = ctx.measureText(value).width;
    ctx.font = `${LABEL_FONT_WEIGHT} ${this.s(LOCAL_LABEL_SIZE)}px ${UI_FONT_STACK}`;
    let tracking = METRIC_TRACKINGS.find((candidate) => {
      ctx.letterSpacing = candidate;
      return ctx.measureText(label).width + valueWidth + this.s(METRIC_ROW_MIN_GAP) <= width;
    });
    if (tracking === undefined) tracking = METRIC_TRACKINGS[METRIC_TRACKINGS.length - 1];
    ctx.letterSpacing = tracking;
    ctx.fillStyle = labelColor;
    ctx.fillText(label, x, baseline);
    ctx.letterSpacing = '0px';
    ctx.font = `${BODY_FONT_WEIGHT} ${this.s(LOCAL_VALUE_SIZE)}px ${UI_FONT_STACK}`;
    ctx.fillStyle = valueColor;
    ctx.textAlign = 'right';
    ctx.fillText(value, x + width, baseline);
    ctx.restore();
  }

  private lineHeight(ctx: CanvasRenderingContext2D, weight: number, size: number): number {
    ctx.save();
    ctx.font = `${weight} ${size}px ${UI_FONT_STACK}`;
    const metrics = ctx.measureText('Hg');
    ctx.restore();
    const measured = metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent;
    return measured > 0 ? measured : size;
  }

  /**
   * A readout chip. Compact chips (one row) show key, name and status side by side; when they do not fit, the short status is
   * used. Tall chips stack the key over the name, put the status on the name's row when both fit (else on the key's row) and
   * keep an optional progress bar on a row of its own, so nothing shares a row.
   */
  private drawAbilityChip(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, chip: ChipSpec, popScale = 1): void {
    const compact = height <= this.s(LOCAL_COMPACT_CHIP_HEIGHT + 6);
    const { title, hint, color, progress } = chip;
    ctx.save();
    if (popScale !== 1) {
      ctx.translate(x + width * 0.5, y + height * 0.5);
      ctx.scale(popScale, popScale);
      ctx.translate(-(x + width * 0.5), -(y + height * 0.5));
    }
    ctx.globalAlpha = chip.alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = this.s(1.1);
    drawChamferRect(ctx, x, y, width, height, this.s(8));
    ctx.stroke();
    if (compact) {
      const baseline = y + height * 0.62;
      const inset = this.s(COMPACT_CHIP_INSET);
      ctx.font = `${LABEL_FONT_WEIGHT} ${this.s(COMPACT_HINT_SIZE)}px ${UI_FONT_STACK}`;
      const hintWidth = ctx.measureText(hint).width;
      ctx.font = `${LABEL_FONT_WEIGHT} ${this.s(COMPACT_TITLE_SIZE)}px ${UI_FONT_STACK}`;
      const titleX = x + inset + Math.max(hintWidth, this.s(COMPACT_HINT_COLUMN)) + this.s(COMPACT_CHIP_GAP);
      const room = x + width - inset - titleX - ctx.measureText(title).width - this.s(COMPACT_CHIP_GAP);
      const status = ctx.measureText(chip.status).width <= room || chip.shortStatus === undefined ? chip.status : chip.shortStatus;
      ctx.fillStyle = UI_TEXT;
      ctx.fillText(title, titleX, baseline);
      ctx.textAlign = 'right';
      ctx.fillText(status, x + width - inset, baseline);
      ctx.textAlign = 'left';
      ctx.font = `${LABEL_FONT_WEIGHT} ${this.s(COMPACT_HINT_SIZE)}px ${UI_FONT_STACK}`;
      ctx.fillStyle = color;
      ctx.fillText(hint, x + inset, baseline);
    } else {
      const inset = this.s(CHIP_INSET);
      const titleBaseline = y + this.s(CHIP_TITLE_BASELINE);
      ctx.font = `${LABEL_FONT_WEIGHT} ${this.s(CHIP_TITLE_SIZE)}px ${UI_FONT_STACK}`;
      const titleWidth = ctx.measureText(title).width;
      ctx.font = `${TITLE_FONT_WEIGHT} ${this.s(CHIP_STATUS_SIZE)}px ${UI_FONT_STACK}`;
      const statusWidth = ctx.measureText(chip.status).width;
      const sameRow = titleWidth + statusWidth + this.s(METRIC_ROW_MIN_GAP) <= width - inset * 2;
      ctx.font = `${LABEL_FONT_WEIGHT} ${this.s(CHIP_HINT_SIZE)}px ${UI_FONT_STACK}`;
      ctx.fillStyle = color;
      ctx.fillText(hint, x + inset, y + this.s(CHIP_HINT_BASELINE));
      ctx.font = `${LABEL_FONT_WEIGHT} ${this.s(CHIP_TITLE_SIZE)}px ${UI_FONT_STACK}`;
      ctx.fillText(title, x + inset, titleBaseline);
      ctx.font = `${TITLE_FONT_WEIGHT} ${this.s(sameRow ? CHIP_STATUS_SIZE : CHIP_HINT_SIZE)}px ${UI_FONT_STACK}`;
      ctx.textAlign = 'right';
      ctx.fillStyle = UI_TEXT;
      ctx.fillText(chip.status, x + width - inset, sameRow ? titleBaseline : y + this.s(CHIP_HINT_BASELINE));
    }
    ctx.restore();
    if (progress !== undefined) {
      const inset = this.s(CHIP_INSET);
      this.drawMeter(ctx, x + inset, y + this.s(CHIP_PROGRESS_TOP), width - inset * 2, this.s(CHIP_PROGRESS_HEIGHT), progress.fill, progress.color, 'rgba(255,255,255,0.05)', { sheen: 0.35 });
    }
  }

  private readyPop(time: number, readyAt: number): number {
    const age = time - readyAt;
    if (readyAt <= 0 || age < 0 || age > CHIP_READY_POP_SECONDS) return 1;
    const t = clamp(age / CHIP_READY_POP_SECONDS, 0, 1);
    return 1 + Math.sin(t * Math.PI) * 0.12;
  }

  private damageWindowRatio(world: World, seat: number, time: number): number {
    const state = this.windows[seat];
    if (state.amount <= 0) return 0;
    const nowTick = world.m.world[W.Tick];
    if (state.closeTick > nowTick) return clamp(state.amount / state.cap, 0, 1);
    const elapsed = time - state.closeTick / TICK_RATE;
    if (elapsed >= DAMAGE_WINDOW_DECAY) {
      state.amount = 0;
      return 0;
    }
    return clamp((state.amount / state.cap) * (1 - elapsed / DAMAGE_WINDOW_DECAY), 0, 1);
  }

  private drawGaugeMarkers(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, frame: number, form: number, transformReady: boolean, beatPulse: number): void {
    const drawMarker = (value: number, label: string, color: string) => {
      const mx = x + width * clamp(value / GAUGE_MAX, 0, 1);
      ctx.save();
      const markerPulse = label === 'B' && transformReady ? 1 + beatPulse * 0.18 : 1;
      ctx.translate(mx, y + this.s(7));
      ctx.scale(markerPulse, markerPulse);
      ctx.translate(-mx, -(y + this.s(7)));
      ctx.strokeStyle = color;
      ctx.lineWidth = this.s(1.2);
      ctx.beginPath();
      ctx.moveTo(mx, y - this.s(2));
      ctx.lineTo(mx, y + this.s(16));
      ctx.stroke();
      ctx.font = `${LABEL_FONT_WEIGHT} ${this.s(9)}px ${UI_FONT_STACK}`;
      ctx.fillStyle = color;
      ctx.textAlign = 'center';
      ctx.fillText(label, mx, y + this.s(24));
      ctx.restore();
    };
    drawMarker(BOSS_MIN_GAUGE, 'B', UI_TEXT_DIM);
    if (form === Form.Boss) {
      drawMarker(attackFuel(FORMS[frame], Attack.Salvo), 'L', UI_ACCENT);
      drawMarker(attackFuel(FORMS[frame], Attack.Siege), 'R', '#ffc76f');
      drawMarker(attackFuel(FORMS[frame], Attack.Ultima), 'E', UI_WARNING);
    }
  }

  private drawAttackReadiness(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, frame: number, world: World, seat: number, time: number, beatPulse: number): void {
    const { m } = world;
    const labels = ['SALVO', 'SIEGE', 'ULTIMA'] as const;
    const hints = ['LMB', 'RMB', 'E'] as const;
    const colors = [UI_ACCENT, '#ffc76f', UI_WARNING] as const;
    BOSS_ATTACKS.forEach((attack, index) => {
      const gauge = m.plGauge[seat];
      const need = attackFuel(FORMS[frame], attack);
      const block = attackBlocker(world, seat, attack);
      const ready = block === AttackBlock.None;
      const missing = Math.ceil((need - gauge) / GAUGE_SCALE);
      const status = this.attackStatus(block, missing, m.plUltCd[seat]);
      this.drawAbilityChip(ctx, x, y + index * this.s(LOCAL_COMPACT_CHIP_PITCH), width, this.s(LOCAL_COMPACT_CHIP_HEIGHT), {
        title: labels[index],
        hint: hints[index],
        status,
        shortStatus: block === AttackBlock.Fuel ? `+${missing}` : status,
        color: colors[index],
        alpha: ready ? clamp(0.74 + beatPulse * 0.24, 0, 1) : 0.38,
      }, this.readyPop(time, this.seatMotion[seat].attackReadyAt[index]));
    });
  }

  /** The chip text for an attack: why it cannot start (see sim attackBlocker), or READY. */
  private attackStatus(block: number, missing: number, ultimaCooldown: number): string {
    switch (block) {
      case AttackBlock.None:
        return 'READY';
      case AttackBlock.Fuel:
        return `${missing} MORE`;
      case AttackBlock.Cooldown:
        return formatCompactSeconds(ultimaCooldown / TICK_RATE);
      case AttackBlock.NoPod:
        return 'NO GUNS';
      case AttackBlock.Busy:
        return 'FIRING';
      default:
        throw new RangeError(`no chip text for attack block ${block}`);
    }
  }

  private drawAttackTell(ctx: CanvasRenderingContext2D, x: number, y: number, world: World, seat: number): void {
    const attack = world.m.plAtk[seat];
    const phase = world.m.plAtkPhase[seat];
    const text = attack === Attack.None ? 'STABLE' : `${ATTACK_LABELS[attack]} ${PHASE_LABELS[phase]}`;
    ctx.save();
    ctx.font = `${TITLE_FONT_WEIGHT} ${this.s(TELL_LABEL_FONT)}px ${UI_FONT_STACK}`;
    ctx.fillStyle = phase === AttackPhase.Windup ? UI_WARNING : phase === AttackPhase.Recovery ? '#ffc76f' : UI_TEXT;
    ctx.fillText(`TELL: ${text}`, x, y);
    ctx.restore();
  }

  private drawPartIntegrity(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, world: World, seat: number): void {
    const form = FORMS[world.m.plFrame[seat]];
    const base = world.partBase(seat);
    let minX = -form.coreR;
    let minY = -form.coreR;
    let maxX = form.coreR;
    let maxY = form.coreR;
    form.parts.forEach((part) => {
      minX = Math.min(minX, part.x - part.rad);
      minY = Math.min(minY, part.y - part.rad);
      maxX = Math.max(maxX, part.x + part.rad);
      maxY = Math.max(maxY, part.y + part.rad);
    });
    const scale = Math.min((width - this.s(PART_SCHEMATIC_PAD) * 2) / fx.toFloat(maxX - minX), (height - this.s(PART_SCHEMATIC_PAD) * 2) / fx.toFloat(maxY - minY));
    const cx = x + width * 0.5;
    const cy = y + height * 0.5;
    this.drawMetricHeader(ctx, 'ARMOUR', x, y - this.s(4), UI_TEXT_DIM);
    ctx.save();
    form.parts.forEach((part, index) => {
      const hp = world.m.ptHp[base + index];
      const fraction = clamp(hp / part.hp, 0, 1);
      const px = cx + (fx.toFloat(part.x) - fx.toFloat((minX + maxX) * 0.5)) * scale;
      const py = cy + (fx.toFloat(part.y) - fx.toFloat((minY + maxY) * 0.5)) * scale;
      const radius = Math.max(this.s(4), fx.toFloat(part.rad) * scale);
      ctx.globalAlpha = lerp(PART_MIN_ALPHA, 1, fraction);
      ctx.strokeStyle = hp <= 0 ? UI_MUTED : fraction > 0.66 ? UI_SUCCESS : fraction > 0.33 ? '#ffc76f' : UI_WARNING;
      ctx.lineWidth = part.roles & Role.Siege ? this.s(2) : this.s(1.2);
      ctx.beginPath();
      ctx.arc(px, py, radius, 0, Math.PI * 2);
      ctx.stroke();
      if (hp > 0) {
        ctx.fillStyle = rgba(0xffffff, 0.02 + fraction * 0.08);
        ctx.fill();
      }
    });
    ctx.strokeStyle = UI_EDGE_SOFT;
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(this.s(4), fx.toFloat(form.coreR) * scale), 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  private drawNormalCooldown(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, world: World, seat: number, time: number): void {
    const frame = world.m.plFrame[seat];
    const remaining = world.m.plAltCd[seat];
    const total = NORMAL_ALT_COOLDOWNS[frame];
    const ready = remaining === 0;
    const color = ready ? UI_SUCCESS : UI_ACCENT;
    this.drawAbilityChip(ctx, x, y, width, this.s(LOCAL_CHIP_HEIGHT), {
      title: NORMAL_ALT_LABELS[frame],
      hint: 'RMB',
      status: ready ? 'READY' : formatCompactSeconds(remaining / TICK_RATE),
      color,
      alpha: 1,
      progress: { fill: 1 - remaining / total, color },
    }, this.readyPop(time, this.seatMotion[seat].altReadyAt));
  }

  private drawRadar(ctx: CanvasRenderingContext2D, view: HudView, x: number, y: number, size: number): void {
    const { world, seat } = view;
    const radius = size * 0.5;
    const cx = x + radius;
    const cy = y + radius;
    const arena = fx.toFloat(world.arenaR);
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = UI_PANEL_STRONG;
    ctx.fill();
    ctx.strokeStyle = UI_EDGE_SOFT;
    ctx.lineWidth = this.s(1);
    ctx.stroke();
    this.drawSectionLabel(ctx, 'RADAR', x, y - this.s(8), UI_TEXT_DIM);

    const mapUnits = (wx: number, wy: number): { x: number; y: number } => ({ x: cx + (wx / arena) * radius, y: cy - (wy / arena) * radius });
    const mapPoint = (rawX: number, rawY: number): { x: number; y: number } => mapUnits(fx.toFloat(rawX), fx.toFloat(rawY));
    const safe = fx.toFloat(world.m.world[W.SafeR]) / arena;
    ctx.beginPath();
    ctx.arc(cx, cy, radius * safe, 0, Math.PI * 2);
    ctx.strokeStyle = neutralAccent(0.45);
    ctx.lineWidth = this.s(SAFE_ZONE_STROKE);
    ctx.stroke();

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.clip();
    ctx.beginPath();
    const corner = { x: 0, y: 0 };
    RADAR_VIEW_CORNERS.forEach(([fractionX, fractionY], index) => {
      view.ground(fractionX * view.width, fractionY * view.height, corner);
      const at = mapUnits(corner.x, corner.y);
      if (index === 0) ctx.moveTo(at.x, at.y);
      else ctx.lineTo(at.x, at.y);
    });
    ctx.closePath();
    ctx.strokeStyle = RADAR_VIEW_STROKE;
    ctx.lineWidth = this.s(1);
    ctx.stroke();
    ctx.restore();

    for (let pilot = 0; pilot < world.seats; pilot++) {
      if (world.m.plAlive[pilot] !== 1) continue;
      const p = mapPoint(world.m.plX[pilot], world.m.plY[pilot]);
      const boss = world.m.plForm[pilot] === Form.Boss;
      const dot = boss ? this.s(pulse(view.time + pilot, 8, 3.8, 5.8)) : this.s(2.5);
      ctx.beginPath();
      ctx.arc(p.x, p.y, dot, 0, Math.PI * 2);
      ctx.fillStyle = cssHex(teamColor(world.m.plTeam[pilot]));
      ctx.fill();
      if (pilot === seat) {
        const heading = fx.toRadians(world.m.plAim[pilot]);
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(-heading);
        ctx.strokeStyle = UI_TEXT;
        ctx.lineWidth = this.s(1.1);
        ctx.beginPath();
        ctx.moveTo(this.s(8), 0);
        ctx.lineTo(-this.s(5), -this.s(4));
        ctx.lineTo(-this.s(2), 0);
        ctx.lineTo(-this.s(5), this.s(4));
        ctx.closePath();
        ctx.stroke();
        ctx.restore();
      }
    }

    for (let n = 0; n < world.cap.neutrals; n++) {
      if (world.m.nAlive[n] !== 1) continue;
      const p = mapPoint(world.m.nX[n], world.m.nY[n]);
      const sizeDot = world.m.nType[n] === NeutralType.Warden ? this.s(4.5) : this.s(2.2);
      ctx.beginPath();
      ctx.arc(p.x, p.y, sizeDot, 0, Math.PI * 2);
      ctx.fillStyle = world.m.nType[n] === NeutralType.Warden ? neutralAccent(1) : neutralEdge(0.78);
      ctx.fill();
    }

    const sampleStride = Math.max(1, Math.floor(world.cap.orbs / RADAR_SAMPLE_ORBS));
    for (let o = 0; o < world.cap.orbs; o += sampleStride) {
      if (world.m.oAlive[o] !== 1) continue;
      const p = mapPoint(world.m.oX[o], world.m.oY[o]);
      ctx.fillStyle = 'rgba(122, 228, 255, 0.45)';
      ctx.fillRect(p.x, p.y, this.s(1.5), this.s(1.5));
    }
    ctx.restore();
  }

  private drawOffscreenIndicators(ctx: CanvasRenderingContext2D, view: HudView): void {
    const { world, seat, width, height, time } = view;
    const centerX = width * 0.5;
    const centerY = height * 0.5;
    const localX = world.m.plX[seat];
    const localY = world.m.plY[seat];
    const point = { x: 0, y: 0 };
    const marks: EdgeMark[] = [];
    const place = (angle: number, size: number, color: string, alpha: number, label: string, labelColor: string): void => {
      marks.push({ ...this.edgeSpot(angle, width, height, this.s(OFFSCREEN_PAD)), angle, size, color, alpha, label, labelColor });
    };
    for (let other = 0; other < world.seats; other++) {
      if (other === seat || world.m.plAlive[other] !== 1 || world.m.plTeam[other] === world.m.plTeam[seat]) continue;
      view.seatScreen(other, point);
      if (pointOnScreen(point.x, point.y, width, height, 20)) continue;
      const boss = world.m.plForm[other] === Form.Boss;
      const color = cssHex(teamColor(world.m.plTeam[other]));
      const distance = Math.hypot(fx.toFloat(world.m.plX[other] - localX), fx.toFloat(world.m.plY[other] - localY));
      place(
        Math.atan2(point.y - centerY, point.x - centerX),
        boss ? this.s(pulse(time + other, 9, 14, 18)) : this.s(INDICATOR_CHEVRON),
        color,
        boss ? pulse(time, 14, 0.68, 1) : 0.72,
        `${Math.round(distance / 10) * 10}U`,
        color,
      );
    }
    for (let n = 0; n < world.cap.neutrals; n++) {
      if (world.m.nAlive[n] !== 1 || world.m.nType[n] !== NeutralType.Warden) continue;
      this.screenOf(view, world.m.nX[n], world.m.nY[n], point);
      if (pointOnScreen(point.x, point.y, width, height, 20)) continue;
      place(Math.atan2(point.y - centerY, point.x - centerX), this.s(INDICATOR_CHEVRON + 3), neutralAccent(1), 0.82, 'WARDEN', neutralEdge(1));
    }
    this.placeAlongEdges(marks, width, height);
    marks.forEach((mark, index) => {
      const bob = Math.sin(time * 2.4 + index * 0.9) * this.s(OFFSCREEN_BOB);
      const bobX = mark.vertical ? bob : 0;
      const bobY = mark.vertical ? 0 : bob;
      this.drawChevron(ctx, mark.x + bobX, mark.y + bobY, mark.angle, mark.size, mark.color, mark.alpha);
      ctx.save();
      ctx.font = `${LABEL_FONT_WEIGHT} ${this.s(10)}px ${UI_FONT_STACK}`;
      ctx.fillStyle = mark.labelColor;
      ctx.textAlign = 'center';
      ctx.fillText(mark.label, mark.x + bobX, mark.y + bobY + mark.size + this.s(12));
      ctx.restore();
    });
  }

  /** Where a ray from the screen centre at `angle` meets the inset screen edge. `vertical` marks a left or right edge. */
  private edgeSpot(angle: number, width: number, height: number, pad: number): EdgeSpot {
    const cx = width * 0.5;
    const cy = height * 0.5;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    const tx = dx > 0 ? (width - pad - cx) / dx : (pad - cx) / dx;
    const ty = dy > 0 ? (height - pad - cy) / dy : (pad - cy) / dy;
    if (Math.abs(tx) < Math.abs(ty)) return { x: dx > 0 ? width - pad : pad, y: cy + dy * Math.abs(tx), vertical: true };
    return { x: cx + dx * Math.abs(ty), y: dy > 0 ? height - pad : pad, vertical: false };
  }

  /** An edge point slid along its edge to the nearest stretch that no HUD panel covers. */
  private edgeClamp(angle: number, width: number, height: number, pad: number): { x: number; y: number } {
    const spot = this.edgeSpot(angle, width, height, pad);
    this.packAlongEdge([spot], width, height, pad, 0);
    return spot;
  }

  /**
   * Off-screen pointers, grouped by the edge they sit on: each is slid along its edge to the free stretch nearest its true
   * direction, and pointers that would crowd each other are kept `gap` apart, so nothing overlaps a panel or another pointer.
   */
  private placeAlongEdges(marks: EdgeMark[], width: number, height: number): void {
    const pad = this.s(OFFSCREEN_PAD);
    const groups = new Map<string, EdgeMark[]>();
    for (const mark of marks) {
      const key = mark.vertical ? (mark.x > width * 0.5 ? 'right' : 'left') : (mark.y > height * 0.5 ? 'bottom' : 'top');
      const group = groups.get(key);
      if (group === undefined) groups.set(key, [mark]);
      else group.push(mark);
    }
    for (const group of groups.values()) {
      this.packAlongEdge(group, width, height, pad, this.s(group[0].vertical ? INDICATOR_SLOT_VERTICAL : INDICATOR_SLOT_HORIZONTAL));
    }
  }

  /** Moves marks that share one edge (they must all be vertical or all horizontal) along it; see placeAlongEdges. */
  private packAlongEdge(marks: EdgeSpot[], width: number, height: number, pad: number, gap: number): void {
    const vertical = marks[0].vertical;
    const axis = vertical ? 'y' : 'x';
    const stretches = this.freeStretches(vertical ? 'vertical' : 'horizontal', vertical ? marks[0].x : marks[0].y, vertical ? height : width, pad);
    marks.sort((a, b) => a[axis] - b[axis]);
    let lastStretch = 0;
    let lastPosition = -Infinity;
    for (const mark of marks) {
      const desired = mark[axis];
      let bestStretch = -1;
      let bestPosition = desired;
      let bestDistance = Infinity;
      for (let k = lastStretch; k < stretches.length; k++) {
        const [start, end] = stretches[k];
        const from = k === lastStretch ? Math.max(start, lastPosition + gap) : start;
        if (from > end) continue;
        const position = clamp(desired, from, end);
        if (Math.abs(position - desired) < bestDistance) {
          bestStretch = k;
          bestPosition = position;
          bestDistance = Math.abs(position - desired);
        }
      }
      if (bestStretch < 0) {
        bestStretch = stretches.length - 1;
        bestPosition = stretches[bestStretch][1];
      }
      mark[axis] = bestPosition;
      lastStretch = bestStretch;
      lastPosition = bestPosition;
    }
  }

  /**
   * The stretches of one screen edge that no HUD panel reaches. `axis` is the direction along the edge, `edgeAt` the edge's own
   * coordinate: only panels near that line block it. The whole edge is returned when panels cover all of it.
   */
  private freeStretches(axis: 'horizontal' | 'vertical', edgeAt: number, span: number, pad: number): Array<[number, number]> {
    const margin = pad + this.s(SAFE_INDICATOR_GAP);
    const alongX = axis === 'horizontal';
    const covered = this.occluders
      .filter((rect) => (alongX ? rect.y - margin <= edgeAt && edgeAt <= rect.y + rect.height + margin : rect.x - margin <= edgeAt && edgeAt <= rect.x + rect.width + margin))
      .map((rect): [number, number] => (alongX ? [rect.x - margin, rect.x + rect.width + margin] : [rect.y - margin, rect.y + rect.height + margin]))
      .sort((a, b) => a[0] - b[0]);
    const free: Array<[number, number]> = [];
    let cursor = pad;
    for (const [start, end] of covered) {
      const from = clamp(start, pad, span - pad);
      const to = clamp(end, pad, span - pad);
      if (to <= cursor) continue;
      if (from > cursor) free.push([cursor, from]);
      cursor = Math.max(cursor, to);
    }
    if (cursor < span - pad) free.push([cursor, span - pad]);
    return free.length > 0 ? free : [[pad, span - pad]];
  }

  private drawChevron(ctx: CanvasRenderingContext2D, x: number, y: number, angle: number, size: number, color: string, alpha: number): void {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = this.s(1.4);
    ctx.beginPath();
    ctx.moveTo(size, 0);
    ctx.lineTo(-size * 0.4, -size * 0.58);
    ctx.lineTo(-size * 0.08, 0);
    ctx.lineTo(-size * 0.4, size * 0.58);
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }

  private drawEdgeFrame(ctx: CanvasRenderingContext2D, width: number, height: number, color: string, alpha: number): void {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = this.s(ALERT_FRAME_WIDTH);
    ctx.strokeRect(this.s(ALERT_FRAME_INSET), this.s(ALERT_FRAME_INSET), width - this.s(ALERT_FRAME_INSET) * 2, height - this.s(ALERT_FRAME_INSET) * 2);
    ctx.restore();
  }

  private drawUltimaAlert(ctx: CanvasRenderingContext2D, view: HudView): void {
    if (this.ultimaAlerts.length === 0) return;
    const alert = this.ultimaAlerts[this.ultimaAlerts.length - 1];
    const { world, width, height } = view;
    const seat = alert.seat;
    const point = { x: 0, y: 0 };
    view.seatScreen(seat, point);
    this.drawEdgeFrame(ctx, width, height, UI_WARNING, pulse(view.time, 10, 0.45, 0.82));
    const bannerWidth = this.s(320);
    const x = width * 0.5 - bannerWidth * 0.5;
    const y = this.s(90);
    this.drawPanel(ctx, x, y, bannerWidth, this.s(42), UI_WARNING);
    ctx.save();
    ctx.font = `${TITLE_FONT_WEIGHT} ${this.s(15)}px ${UI_FONT_STACK}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = UI_WARNING;
    ctx.fillText(`ULTIMA — ${FORM_NAMES[world.m.plFrame[seat]]}`, x + bannerWidth * 0.5, y + this.s(22));
    ctx.restore();
    if (!pointOnScreen(point.x, point.y, width, height, this.s(16))) {
      const angle = Math.atan2(point.y - (y + this.s(52)), point.x - width * 0.5);
      const edge = this.edgeClamp(angle, width, height, this.s(ULTIMA_ARROW_PAD));
      this.drawChevron(ctx, edge.x, edge.y, angle, this.s(18), UI_WARNING, pulse(view.time, 15, 0.65, 1));
    }
  }

  private drawCenterBanners(ctx: CanvasRenderingContext2D, view: HudView): void {
    const item = this.banners[this.banners.length - 1];
    if (!item) return;
    const age = view.time - item.at;
    const fadeIn = clamp(age / 0.18, 0, 1);
    const fadeOut = 1 - clamp((age - (item.duration - BANNER_FADE)) / BANNER_FADE, 0, 1);
    const alpha = Math.min(fadeIn, fadeOut);
    const punch = Math.sin(clamp(age / BANNER_PUNCH_SECONDS, 0, 1) * Math.PI);
    const scale = lerp(1.1, 1, easeOutCubic(clamp(age / BANNER_PUNCH_SECONDS, 0, 1))) + punch * 0.04;
    const reveal = easeOutCubic(clamp(age / BANNER_REVEAL_SECONDS, 0, 1));
    const text = this.scrambleText(item.title, reveal);
    ctx.save();
    ctx.translate(view.width * 0.5, view.height * 0.29);
    ctx.scale(scale, scale);
    ctx.globalAlpha = alpha;
    ctx.font = `${TITLE_FONT_WEIGHT} ${this.s(34)}px ${UI_FONT_STACK}`;
    ctx.fillStyle = item.color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = item.color;
    ctx.shadowBlur = 18;
    const titleWidth = ctx.measureText(item.title).width;
    const sweep = clamp(age / BANNER_SWEEP_SECONDS, 0, 1);
    ctx.strokeStyle = item.color;
    ctx.lineWidth = this.s(1.3);
    ctx.beginPath();
    ctx.moveTo(-titleWidth * 0.62, -this.s(25));
    ctx.lineTo(lerp(-titleWidth * 0.62, titleWidth * 0.62, sweep), -this.s(25));
    ctx.moveTo(titleWidth * 0.62, this.s(25));
    ctx.lineTo(lerp(titleWidth * 0.62, -titleWidth * 0.62, sweep), this.s(25));
    ctx.stroke();
    fillCenteredText(ctx, text, 0, 0);
    if (age < BANNER_GLITCH_SECONDS) {
      const sliceAlpha = (1 - age / BANNER_GLITCH_SECONDS) * 0.5;
      ctx.globalAlpha = alpha * sliceAlpha;
      ctx.fillStyle = UI_TEXT;
      ctx.save();
      ctx.beginPath();
      ctx.rect(-titleWidth, -this.s(9), titleWidth * 2, this.s(8));
      ctx.clip();
      fillCenteredText(ctx, text, Math.sin(age * 90) * this.s(BANNER_SLICE_OFFSET), 0);
      ctx.restore();
      ctx.save();
      ctx.beginPath();
      ctx.rect(-titleWidth, this.s(4), titleWidth * 2, this.s(7));
      ctx.clip();
      fillCenteredText(ctx, text, -Math.sin(age * 70) * this.s(BANNER_SLICE_OFFSET), 0);
      ctx.restore();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = item.color;
    }
    if (item.subtitle) {
      ctx.shadowBlur = 10;
      ctx.font = `${LABEL_FONT_WEIGHT} ${this.s(13)}px ${UI_FONT_STACK}`;
      ctx.fillStyle = UI_TEXT;
      fillCenteredText(ctx, item.subtitle, 0, this.s(28));
    }
    ctx.restore();
  }

  private scrambleText(text: string, reveal: number): string {
    const shown = Math.floor(text.length * clamp(reveal, 0, 1));
    let out = '';
    for (let i = 0; i < text.length; i++) {
      const source = text.charAt(i);
      if (source === ' ' || i < shown) out += source;
      else out += SCRAMBLE_GLYPHS.charAt((i * 7 + shown * 3) % SCRAMBLE_GLYPHS.length);
    }
    return out;
  }

  private drawCountdownPulse(ctx: CanvasRenderingContext2D, view: HudView): void {
    const { world } = view;
    if (world.m.world[W.Phase] !== Phase.Countdown) return;
    const seconds = Math.ceil(world.m.world[W.PhaseTimer] / TICK_RATE);
    if (seconds <= 0) return;
    const beatScale = 1 + view.beat.pulse * COUNTDOWN_PUNCH_SCALE;
    ctx.save();
    ctx.translate(view.width * 0.5, view.height * 0.43);
    ctx.scale(beatScale, beatScale);
    ctx.globalAlpha = COUNTDOWN_ALPHA;
    ctx.font = `${TITLE_FONT_WEIGHT} ${this.s(92)}px ${UI_FONT_STACK}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = UI_ACCENT;
    ctx.shadowBlur = this.s(30);
    ctx.fillStyle = UI_TEXT;
    ctx.fillText(String(seconds), 0, 0);
    ctx.strokeStyle = UI_ACCENT;
    ctx.lineWidth = this.s(1.6);
    ctx.strokeText(String(seconds), 0, 0);
    ctx.restore();
  }

  private drawStateWarnings(ctx: CanvasRenderingContext2D, view: HudView, time: number): void {
    const { world, seat, width, height } = view;
    const hpFraction = world.m.plHp[seat] / FRAME_STATS[world.m.plFrame[seat]].hp;
    const outside = world.m.plAlive[seat] === 1 && radial(world.m.plX[seat], world.m.plY[seat]) > world.m.world[W.SafeR];
    if (outside) {
      this.drawEdgeFrame(ctx, width, height, UI_WARNING, pulse(time, STORM_PULSE_RATE, 0.32, 0.62));
    }
    const hitAlpha = clamp((this.windows[seat].hitUntil - time) / HIT_PULSE_SECONDS, 0, 1) * 0.16;
    if (hitAlpha > 0) {
      this.drawEdgeFrame(ctx, width, height, UI_WARNING, hitAlpha * 3.5);
    }
    if (hpFraction > 0 && hpFraction <= HEALTH_WARN_THRESHOLD) {
      ctx.save();
      const alpha = pulse(time, LOW_HEALTH_RATE, 0.12, 0.24);
      ctx.fillStyle = `rgba(255, 40, 70, ${alpha * VIGNETTE_ALPHA})`;
      ctx.fillRect(0, height - this.s(64), width, this.s(64));
      ctx.font = `${TITLE_FONT_WEIGHT} ${this.s(16)}px ${UI_FONT_STACK}`;
      ctx.textAlign = 'center';
      ctx.fillStyle = UI_WARNING;
      ctx.fillText('CORE CRITICAL', width * 0.5, height - this.s(18));
      ctx.restore();
    }
    if (world.m.plAlive[seat] === 0) {
      const elimination = !world.isDeathmatch;
      const text = elimination ? 'SPECTATING' : `RESPAWN ${formatCompactSeconds(world.m.plRespawn[seat] / TICK_RATE)}`;
      const subtitle = elimination ? 'YOUR TEAM IS STILL FIGHTING' : 'YOU DIED';
      ctx.save();
      ctx.fillStyle = 'rgba(0, 0, 0, 0.34)';
      ctx.fillRect(0, 0, width, height);
      ctx.font = `${TITLE_FONT_WEIGHT} ${this.s(26)}px ${UI_FONT_STACK}`;
      ctx.textAlign = 'center';
      ctx.fillStyle = UI_TEXT;
      ctx.fillText(text, width * 0.5, height * 0.42);
      ctx.font = `${LABEL_FONT_WEIGHT} ${this.s(13)}px ${UI_FONT_STACK}`;
      ctx.fillStyle = UI_TEXT_DIM;
      ctx.fillText(subtitle, width * 0.5, height * 0.42 + this.s(24));
      ctx.restore();
    }
  }

  private drawNameTags(ctx: CanvasRenderingContext2D, view: HudView): void {
    const { world, seat, names, width, height } = view;
    const point = { x: 0, y: 0 };
    for (let other = 0; other < world.seats; other++) {
      if (other === seat || world.m.plAlive[other] !== 1 || world.m.plTeam[other] === world.m.plTeam[seat]) continue;
      view.seatScreen(other, point);
      if (!pointOnScreen(point.x, point.y, width, height, 40)) continue;
      ctx.save();
      ctx.font = `${LABEL_FONT_WEIGHT} ${this.s(10)}px ${UI_FONT_STACK}`;
      ctx.textAlign = 'center';
      ctx.fillStyle = cssHex(teamColor(world.m.plTeam[other]));
      ctx.fillText(names[other] ?? `P${other + 1}`, point.x, point.y - this.s(NAME_TAG_PAD));
      ctx.restore();
    }
  }

  private drawReticle(ctx: CanvasRenderingContext2D, view: HudView): void {
    if (view.cursor === null) return;
    const { x, y } = view.cursor;
    ctx.save();
    ctx.translate(x, y);
    ctx.strokeStyle = UI_TEXT;
    ctx.lineWidth = this.s(1);
    ctx.beginPath();
    ctx.arc(0, 0, this.s(RETICLE_INNER), 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-this.s(RETICLE_OUTER), 0);
    ctx.lineTo(-this.s(RETICLE_INNER + 4), 0);
    ctx.moveTo(this.s(RETICLE_INNER + 4), 0);
    ctx.lineTo(this.s(RETICLE_OUTER), 0);
    ctx.moveTo(0, -this.s(RETICLE_OUTER));
    ctx.lineTo(0, -this.s(RETICLE_INNER + 4));
    ctx.moveTo(0, this.s(RETICLE_INNER + 4));
    ctx.lineTo(0, this.s(RETICLE_OUTER));
    ctx.stroke();
    ctx.restore();
  }
}
