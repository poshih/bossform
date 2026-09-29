import { fx } from '@metronome/engine';
import { FORM_NAMES } from '../setup.ts';
import {
  Attack,
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
import { clamp, drawChamferRect, easeOutCubic, fillCenteredText, formatClock, formatCompactSeconds, invLerp, lerp, pointOnScreen, pulse, strokeGlow } from './draw.ts';
import {
  UI_ACCENT,
  UI_CAPS_SPACING,
  UI_EDGE,
  UI_EDGE_SOFT,
  UI_FONT_STACK,
  UI_MUTED,
  UI_PANEL,
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
const RADAR_CAMERA_WORLD = 100;

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

interface TeamGroup {
  readonly team: number;
  readonly rows: readonly number[];
  readonly solo: boolean;
}

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface HudView {
  readonly world: World;
  readonly seat: number;
  readonly names: readonly string[];
  readonly width: number;
  readonly height: number;
  readonly project: (x: number, y: number, out: { x: number; y: number }) => void;
  readonly time: number;
  readonly cursor: { x: number; y: number } | null;
}

export class Hud {
  private readonly previousForms: number[] = [];
  private readonly killFeed: KillFeedItem[] = [];
  private readonly banners: BannerItem[] = [];
  private readonly ultimaAlerts: UltimaAlert[] = [];
  private readonly windows: DamageWindowState[] = [];
  private scale = 1;
  private occluders: Rect[] = [];

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
        this.killFeed.unshift({ kind: 'kill', at: now, victim: a, killer: b, bossKill: this.previousForms[a] === Form.Boss });
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
    for (let seat = 0; seat < world.seats; seat++) this.previousForms[seat] = world.m.plForm[seat];
  }

  draw(ctx: CanvasRenderingContext2D, view: HudView): void {
    const { world, width, height, time } = view;
    this.syncSeatState(world);
    this.updateDamageWindowState(world);
    this.scale = clamp(Math.min(width / 1280, height / 720), 0.65, 1.4);
    const margin = this.s(HUD_MARGIN);
    const scoreboardRect = this.rect(margin, margin, this.s(SCOREBOARD_WIDTH), 0);
    const feedRect = this.rect(width - this.s(FEED_WIDTH) - margin, margin, this.s(FEED_WIDTH), 0);
    const timerRect = this.rect(width * 0.5 - this.s(TIMER_WIDTH) * 0.5, margin, this.s(TIMER_WIDTH), 0);
    const radarSize = this.s(RADAR_BASE);
    const radarRect = this.rect(margin, height - margin - radarSize, radarSize, radarSize);
    const localWidth = clamp(width * (this.scale < 0.85 ? 0.28 : 0.33), this.s(300), this.s(440));
    const localHeight = this.s(world.m.plForm[view.seat] === Form.Boss ? 156 : 124);
    const localRect = this.rect(width * 0.5 - localWidth * 0.5, height - margin - localHeight, localWidth, localHeight);
    this.occluders = [scoreboardRect, feedRect, radarRect, localRect];
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    this.drawNameTags(ctx, view);
    this.drawScoreboard(ctx, view, scoreboardRect.x, scoreboardRect.y, scoreboardRect.width);
    this.drawKillFeed(ctx, view, feedRect.x, feedRect.y, feedRect.width);
    this.drawTimer(ctx, view, timerRect.x, timerRect.y, timerRect.width);
    this.drawRadar(ctx, view, radarRect.x, radarRect.y, radarRect.width);
    this.drawLocalPanel(ctx, view, localRect.x, localRect.y, localRect.width, localRect.height);
    this.drawOffscreenIndicators(ctx, view);
    this.drawUltimaAlert(ctx, view);
    this.drawCenterBanners(ctx, view);
    this.drawStateWarnings(ctx, view, time);
    this.drawReticle(ctx, view);
    ctx.restore();
  }

  private s(value: number): number {
    return value * this.scale;
  }

  private rect(x: number, y: number, width: number, height: number): Rect {
    return { x, y, width, height };
  }

  private syncSeatState(world: World): void {
    while (this.windows.length < world.seats) {
      this.windows.push({ amount: 0, cap: 1, closeTick: 0, blockedUntil: 0, hitUntil: 0 });
      this.previousForms.push(Form.Normal);
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
    ctx.fillStyle = UI_PANEL;
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

  private drawMeter(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, fill: number, color: string, back = 'rgba(255,255,255,0.08)'): void {
    const amount = clamp(fill, 0, 1);
    const cut = Math.min(this.s(6), height * 0.5);
    ctx.save();
    ctx.fillStyle = back;
    drawChamferRect(ctx, x, y, width, height, cut);
    ctx.fill();
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
        const alive = world.m.plAlive[rowSeat] === 1;
        const local = rowSeat === seat;
        const boss = world.m.plForm[rowSeat] === Form.Boss;
        const teamTint = cssHex(teamColor(group.team));
        ctx.save();
        if (local) {
          ctx.fillStyle = rgba(teamColor(group.team), 0.16);
          drawChamferRect(ctx, x + this.s(10), cy, width - this.s(20), rowHeight, this.s(8));
          ctx.fill();
        }
        ctx.strokeStyle = rgba(teamColor(group.team), 0.26);
        ctx.lineWidth = this.s(1);
        drawChamferRect(ctx, x + this.s(10), cy, width - this.s(20), rowHeight, this.s(8));
        ctx.stroke();
        ctx.font = `${BODY_FONT_WEIGHT} ${this.s(11.5)}px ${UI_FONT_STACK}`;
        ctx.fillStyle = alive ? teamTint : 'rgba(206,227,245,0.34)';
        ctx.textBaseline = 'middle';
        if (group.solo) {
          ctx.beginPath();
          ctx.arc(x + this.s(18), cy + rowHeight * 0.5, this.s(3), 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillText(names[rowSeat] ?? `P${rowSeat + 1}`, x + this.s(group.solo ? 28 : 18), cy + rowHeight * 0.5);
        ctx.fillStyle = UI_TEXT;
        ctx.textAlign = 'right';
        const suffix = world.isDeathmatch ? `${world.m.plKills[rowSeat]} / ${world.m.plDeaths[rowSeat]}` : `${world.m.plKills[rowSeat]}K ${world.m.plDeaths[rowSeat]}D`;
        ctx.fillText(suffix, x + width - this.s(20), cy + rowHeight * 0.5);
        ctx.textAlign = 'left';
        if (boss) this.drawBossBadge(ctx, x + width - this.s(54), cy + rowHeight * 0.5, cssHex(teamColor(group.team)), 1);
        if (!alive) {
          ctx.fillStyle = 'rgba(255,255,255,0.38)';
          ctx.fillText('☠', x + width - this.s(32), cy + rowHeight * 0.5);
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
      const rowY = y + this.s(30) + index * rowHeight;
      ctx.save();
      ctx.globalAlpha = fade;
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

  private drawLocalPanel(ctx: CanvasRenderingContext2D, view: HudView, x: number, y: number, width: number, height: number): void {
    const { world, seat, time } = view;
    const { m } = world;
    const frame = m.plFrame[seat];
    const stats = FRAME_STATS[frame];
    const team = m.plTeam[seat];
    const accent = cssHex(teamColor(team));
    const alive = m.plAlive[seat] === 1;
    this.drawPanel(ctx, x, y, width, height, accent);
    const pad = this.s(14);
    const gap = this.s(10);
    const leftWidth = width * (m.plForm[seat] === Form.Boss ? 0.54 : 0.58) - pad;
    const rightWidth = width - pad * 2 - gap - leftWidth;
    const leftX = x + pad;
    const rightX = leftX + leftWidth + gap;
    this.drawSectionLabel(ctx, alive ? 'LOCAL PILOT' : 'SPECTATOR', leftX, y + this.s(18), UI_TEXT_DIM);
    this.drawMetricHeader(ctx, `HP ${Math.max(0, m.plHp[seat])} / ${stats.hp}`, leftX, y + this.s(32), accent);
    this.drawMeter(ctx, leftX, y + this.s(38), leftWidth, this.s(12), invLerp(0, stats.hp, m.plHp[seat]), accent);
    const segments = Math.max(1, Math.ceil(stats.hp / stats.windowCap));
    for (let i = 1; i < segments; i++) {
      const sx = leftX + (leftWidth * i) / segments;
      ctx.save();
      ctx.strokeStyle = `rgba(255,255,255,${WINDOW_SEPARATOR_ALPHA})`;
      ctx.lineWidth = this.s(1);
      ctx.beginPath();
      ctx.moveTo(sx, y + this.s(39));
      ctx.lineTo(sx, y + this.s(49));
      ctx.stroke();
      ctx.restore();
    }

    const windowRatio = this.damageWindowRatio(world, seat, time);
    const blockedFlash = this.windows[seat].blockedUntil > time ? pulse(time, 18, 0.35, 1) : 0;
    this.drawMetricHeader(ctx, 'DAMAGE WINDOW', leftX, y + this.s(58), blockedFlash > 0 ? UI_WARNING : UI_TEXT_DIM);
    this.drawMeter(ctx, leftX, y + this.s(64), leftWidth, this.s(10), windowRatio, blockedFlash > 0 ? UI_WARNING : '#ffcf69');
    ctx.save();
    ctx.font = `${BODY_FONT_WEIGHT} ${this.s(11)}px ${UI_FONT_STACK}`;
    ctx.fillStyle = blockedFlash > 0 ? UI_WARNING : UI_TEXT_DIM;
    ctx.textAlign = 'right';
    ctx.fillText(`${Math.round(this.windows[seat].amount)} / ${stats.windowCap}`, leftX + leftWidth - this.s(2), y + this.s(82));
    ctx.textAlign = 'left';
    ctx.restore();

    this.drawMetricHeader(ctx, 'ENERGY', leftX, y + this.s(92), UI_TEXT_DIM);
    this.drawMeter(ctx, leftX, y + this.s(98), leftWidth, this.s(12), m.plGauge[seat] / GAUGE_MAX, '#7ae4ff');
    this.drawGaugeMarkers(ctx, leftX, y + this.s(98), leftWidth, frame, m.plForm[seat]);
    ctx.save();
    ctx.font = `${BODY_FONT_WEIGHT} ${this.s(11)}px ${UI_FONT_STACK}`;
    ctx.fillStyle = UI_TEXT;
    ctx.fillText(`${Math.floor(m.plGauge[seat] / 100)} / ${GAUGE_MAX / 100}`, leftX, y + this.s(116));
    ctx.restore();

    if (m.plForm[seat] === Form.Boss) {
      const seconds = m.plGauge[seat] / BOSS_DRAIN_PER_TICK / TICK_RATE;
      this.drawMetricHeader(ctx, FORM_NAMES[frame], leftX, y + this.s(128), accent);
      ctx.save();
      ctx.font = `${TITLE_FONT_WEIGHT} ${this.s(12)}px ${UI_FONT_STACK}`;
      ctx.fillStyle = UI_TEXT;
      ctx.fillText(`FUEL ${formatClock(seconds)}`, leftX, y + this.s(142));
      ctx.restore();
      this.drawPartIntegrity(ctx, rightX, y + this.s(28), rightWidth, this.s(52), world, seat);
      this.drawAttackReadiness(ctx, rightX, y + this.s(88), rightWidth, frame, world, seat, time);
      this.drawAttackTell(ctx, leftX, y + this.s(128), world, seat);
    } else {
      const ready = m.plGauge[seat] >= BOSS_MIN_GAUGE;
      this.drawNormalCooldown(ctx, rightX, y + this.s(28), rightWidth, world, seat);
      this.drawAbilityChip(
        ctx,
        rightX,
        y + this.s(68),
        rightWidth,
        this.s(40),
        'TRANSFORM',
        'SPACE',
        ready ? 'READY' : `${Math.ceil((BOSS_MIN_GAUGE - m.plGauge[seat]) / 100)} MORE`,
        ready ? accent : UI_TEXT_DIM,
        ready ? pulse(time, 7, 0.74, 1) : 0.62,
      );
    }
  }

  private drawMetricHeader(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string): void {
    ctx.save();
    ctx.font = `${LABEL_FONT_WEIGHT} ${this.s(10)}px ${UI_FONT_STACK}`;
    ctx.letterSpacing = UI_CAPS_SPACING;
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  private drawAbilityChip(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
    title: string,
    hint: string,
    status: string,
    color: string,
    alpha: number,
  ): void {
    const compact = height <= this.s(24);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = this.s(1.1);
    drawChamferRect(ctx, x, y, width, height, this.s(8));
    ctx.stroke();
    if (compact) {
      ctx.font = `${LABEL_FONT_WEIGHT} ${this.s(8.5)}px ${UI_FONT_STACK}`;
      ctx.fillStyle = color;
      ctx.fillText(hint, x + this.s(7), y + height * 0.62);
      ctx.font = `${LABEL_FONT_WEIGHT} ${this.s(8.8)}px ${UI_FONT_STACK}`;
      ctx.fillStyle = UI_TEXT;
      ctx.fillText(title, x + this.s(30), y + height * 0.62);
      ctx.textAlign = 'right';
      ctx.fillText(status, x + width - this.s(8), y + height * 0.62);
    } else {
      ctx.font = `${LABEL_FONT_WEIGHT} ${this.s(9)}px ${UI_FONT_STACK}`;
      ctx.fillStyle = color;
      ctx.fillText(hint, x + this.s(8), y + this.s(13));
      ctx.font = `${LABEL_FONT_WEIGHT} ${this.s(10)}px ${UI_FONT_STACK}`;
      ctx.fillText(title, x + this.s(8), y + this.s(23));
      ctx.font = `${TITLE_FONT_WEIGHT} ${this.s(10.5)}px ${UI_FONT_STACK}`;
      ctx.textAlign = 'right';
      ctx.fillStyle = UI_TEXT;
      ctx.fillText(status, x + width - this.s(10), y + height - this.s(8));
    }
    ctx.restore();
    ctx.textAlign = 'left';
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

  private drawGaugeMarkers(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, frame: number, form: number): void {
    const drawMarker = (value: number, label: string, color: string) => {
      const mx = x + width * clamp(value / GAUGE_MAX, 0, 1);
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = this.s(1.2);
      ctx.beginPath();
      ctx.moveTo(mx, y - this.s(3));
      ctx.lineTo(mx, y + this.s(15));
      ctx.stroke();
      ctx.font = `${LABEL_FONT_WEIGHT} ${this.s(9)}px ${UI_FONT_STACK}`;
      ctx.fillStyle = color;
      ctx.textAlign = 'center';
      ctx.fillText(label, mx, y - this.s(7));
      ctx.restore();
    };
    drawMarker(BOSS_MIN_GAUGE, 'B', UI_TEXT_DIM);
    if (form === Form.Boss) {
      drawMarker(FORMS[frame].salvo.cost, 'L', UI_ACCENT);
      drawMarker(FORMS[frame].siege.cost, 'R', '#ffc76f');
      drawMarker(FORMS[frame].ultima.cost, 'E', UI_WARNING);
    }
  }

  private drawAttackReadiness(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, frame: number, world: World, seat: number, time: number): void {
    const { m } = world;
    const attacks = [FORMS[frame].salvo.cost, FORMS[frame].siege.cost, FORMS[frame].ultima.cost] as const;
    const labels = ['SALVO', 'SIEGE', 'ULTIMA'] as const;
    const hints = ['LMB', 'RMB', 'E'] as const;
    const colors = [UI_ACCENT, '#ffc76f', UI_WARNING] as const;
    attacks.forEach((cost, index) => {
      const cy = y + index * this.s(22);
      const ready = m.plGauge[seat] >= cost && (index !== 2 || m.plUltCd[seat] === 0);
      const alpha = ready ? pulse(time + index, 6, 0.72, 1) : 0.38;
      this.drawAbilityChip(ctx, x, cy, width, this.s(18), labels[index], hints[index], ready ? 'READY' : `${Math.ceil((cost - m.plGauge[seat]) / 100)} MORE`, colors[index], alpha);
    });
  }

  private drawAttackTell(ctx: CanvasRenderingContext2D, x: number, y: number, world: World, seat: number): void {
    const attack = world.m.plAtk[seat];
    const phase = world.m.plAtkPhase[seat];
    const text = attack === Attack.None ? 'STABLE' : `${ATTACK_LABELS[attack]} ${PHASE_LABELS[phase]}`;
    ctx.save();
    ctx.font = `${TITLE_FONT_WEIGHT} ${this.s(TELL_LABEL_FONT)}px ${UI_FONT_STACK}`;
    ctx.fillStyle = phase === AttackPhase.Windup ? UI_WARNING : phase === AttackPhase.Recovery ? '#ffc76f' : UI_TEXT;
    ctx.fillText(`TELL: ${text}`, x, y + this.s(14));
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
    const scale = Math.min((width - PART_SCHEMATIC_PAD * 2) / fx.toFloat(maxX - minX), (height - PART_SCHEMATIC_PAD * 2) / fx.toFloat(maxY - minY));
    const cx = x + width * 0.5;
    const cy = y + height * 0.5;
    this.drawMetricHeader(ctx, 'ARMOUR', x, y + height + 12, UI_TEXT_DIM);
    ctx.save();
    form.parts.forEach((part, index) => {
      const hp = world.m.ptHp[base + index];
      const fraction = clamp(hp / part.hp, 0, 1);
      const px = cx + (fx.toFloat(part.x) - fx.toFloat((minX + maxX) * 0.5)) * scale;
      const py = cy + (fx.toFloat(part.y) - fx.toFloat((minY + maxY) * 0.5)) * scale;
      const radius = Math.max(4, fx.toFloat(part.rad) * scale);
      ctx.globalAlpha = lerp(PART_MIN_ALPHA, 1, fraction);
      ctx.strokeStyle = hp <= 0 ? UI_MUTED : fraction > 0.66 ? UI_SUCCESS : fraction > 0.33 ? '#ffc76f' : UI_WARNING;
      ctx.lineWidth = part.roles & Role.Siege ? 2 : 1.2;
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
    ctx.arc(cx, cy, Math.max(4, fx.toFloat(form.coreR) * scale), 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  private drawNormalCooldown(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, world: World, seat: number): void {
    const frame = world.m.plFrame[seat];
    const remaining = world.m.plAltCd[seat];
    const total = NORMAL_ALT_COOLDOWNS[frame];
    const ready = remaining === 0;
    this.drawAbilityChip(ctx, x, y, width, this.s(34), NORMAL_ALT_LABELS[frame], 'RMB', ready ? 'READY' : formatCompactSeconds(remaining / TICK_RATE), ready ? UI_SUCCESS : UI_ACCENT, 1);
    this.drawMeter(ctx, x + this.s(8), y + this.s(22), width - this.s(16), this.s(6), 1 - remaining / total, ready ? UI_SUCCESS : UI_ACCENT, 'rgba(255,255,255,0.05)');
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

    const mapPoint = (wx: number, wy: number): { x: number; y: number } => ({ x: cx + (fx.toFloat(wx) / arena) * radius, y: cy - (fx.toFloat(wy) / arena) * radius });
    const safe = fx.toFloat(world.m.world[W.SafeR]) / arena;
    ctx.beginPath();
    ctx.arc(cx, cy, radius * safe, 0, Math.PI * 2);
    ctx.strokeStyle = neutralAccent(0.45);
    ctx.lineWidth = this.s(SAFE_ZONE_STROKE);
    ctx.stroke();

    const localPoint = mapPoint(world.m.plX[seat], world.m.plY[seat]);
    const viewRect = this.estimateCameraRect(view, localPoint, radius, arena);
    if (viewRect !== null) {
      ctx.strokeStyle = 'rgba(255,255,255,0.36)';
      ctx.lineWidth = this.s(1);
      ctx.strokeRect(viewRect.x, viewRect.y, viewRect.w, viewRect.h);
    }

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

  private estimateCameraRect(view: HudView, local: { x: number; y: number }, radius: number, arena: number): { x: number; y: number; w: number; h: number } | null {
    const { world, seat, width, height, project } = view;
    const here = { x: 0, y: 0 };
    const dx = { x: 0, y: 0 };
    const dy = { x: 0, y: 0 };
    project(world.m.plX[seat], world.m.plY[seat], here);
    project(world.m.plX[seat] + fx.fromInt(RADAR_CAMERA_WORLD), world.m.plY[seat], dx);
    project(world.m.plX[seat], world.m.plY[seat] + fx.fromInt(RADAR_CAMERA_WORLD), dy);
    const scaleX = Math.abs(dx.x - here.x);
    const scaleY = Math.abs(dy.y - here.y);
    if (scaleX < 0.001 || scaleY < 0.001) return null;
    const worldW = (width / scaleX) * RADAR_CAMERA_WORLD;
    const worldH = (height / scaleY) * RADAR_CAMERA_WORLD;
    return {
      x: local.x - (worldW / arena) * radius * 0.5,
      y: local.y - (worldH / arena) * radius * 0.5,
      w: (worldW / arena) * radius,
      h: (worldH / arena) * radius,
    };
  }

  private drawOffscreenIndicators(ctx: CanvasRenderingContext2D, view: HudView): void {
    const { world, seat, width, height, project, time } = view;
    const centerX = width * 0.5;
    const centerY = height * 0.5;
    const localX = world.m.plX[seat];
    const localY = world.m.plY[seat];
    const point = { x: 0, y: 0 };
    for (let other = 0; other < world.seats; other++) {
      if (other === seat || world.m.plAlive[other] !== 1 || world.m.plTeam[other] === world.m.plTeam[seat]) continue;
      project(world.m.plX[other], world.m.plY[other], point);
      if (pointOnScreen(point.x, point.y, width, height, 20)) continue;
      const dx = point.x - centerX;
      const dy = point.y - centerY;
      const angle = Math.atan2(dy, dx);
      const bound = this.edgeClamp(angle, width, height, this.s(OFFSCREEN_PAD));
      const boss = world.m.plForm[other] === Form.Boss;
      const size = boss ? this.s(pulse(time + other, 9, 14, 18)) : this.s(INDICATOR_CHEVRON);
      const color = cssHex(teamColor(world.m.plTeam[other]));
      const distance = Math.hypot(fx.toFloat(world.m.plX[other] - localX), fx.toFloat(world.m.plY[other] - localY));
      this.drawChevron(ctx, bound.x, bound.y, angle, size, color, boss ? pulse(time, 14, 0.68, 1) : 0.72);
      ctx.save();
      ctx.font = `${LABEL_FONT_WEIGHT} ${this.s(10)}px ${UI_FONT_STACK}`;
      ctx.fillStyle = color;
      ctx.textAlign = 'center';
      ctx.fillText(`${Math.round(distance / 10) * 10}U`, bound.x, bound.y + size + this.s(12));
      ctx.restore();
    }
    for (let n = 0; n < world.cap.neutrals; n++) {
      if (world.m.nAlive[n] !== 1 || world.m.nType[n] !== NeutralType.Warden) continue;
      project(world.m.nX[n], world.m.nY[n], point);
      if (pointOnScreen(point.x, point.y, width, height, 20)) continue;
      const dx = point.x - centerX;
      const dy = point.y - centerY;
      const angle = Math.atan2(dy, dx);
      const bound = this.edgeClamp(angle, width, height, this.s(OFFSCREEN_PAD));
      this.drawChevron(ctx, bound.x, bound.y, angle, this.s(INDICATOR_CHEVRON + 3), neutralAccent(1), 0.82);
      ctx.save();
      ctx.font = `${LABEL_FONT_WEIGHT} ${this.s(10)}px ${UI_FONT_STACK}`;
      ctx.fillStyle = neutralEdge(1);
      ctx.textAlign = 'center';
      ctx.fillText('WARDEN', bound.x, bound.y + this.s(24));
      ctx.restore();
    }
  }

  private edgeClamp(angle: number, width: number, height: number, pad: number): { x: number; y: number } {
    const cx = width * 0.5;
    const cy = height * 0.5;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    const tx = dx > 0 ? (width - pad - cx) / dx : (pad - cx) / dx;
    const ty = dy > 0 ? (height - pad - cy) / dy : (pad - cy) / dy;
    const t = Math.min(Math.abs(tx), Math.abs(ty));
    const point = { x: cx + dx * t, y: cy + dy * t };
    return this.avoidOccluders(point, pad);
  }

  private avoidOccluders(point: { x: number; y: number }, pad: number): { x: number; y: number } {
    let out = { ...point };
    for (const rect of this.occluders) {
      const rx = rect.x - pad;
      const ry = rect.y - pad;
      const rw = rect.width + pad * 2;
      const rh = rect.height + pad * 2;
      if (out.x < rx || out.x > rx + rw || out.y < ry || out.y > ry + rh) continue;
      const left = Math.abs(out.x - rx);
      const right = Math.abs(out.x - (rx + rw));
      const top = Math.abs(out.y - ry);
      const bottom = Math.abs(out.y - (ry + rh));
      const min = Math.min(left, right, top, bottom);
      if (min === left) out.x = rx;
      else if (min === right) out.x = rx + rw;
      else if (min === top) out.y = ry;
      else out.y = ry + rh;
    }
    return out;
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

  private drawUltimaAlert(ctx: CanvasRenderingContext2D, view: HudView): void {
    if (this.ultimaAlerts.length === 0) return;
    const alert = this.ultimaAlerts[this.ultimaAlerts.length - 1];
    const { world, width, project } = view;
    const seat = alert.seat;
    const point = { x: 0, y: 0 };
    project(world.m.plX[seat], world.m.plY[seat], point);
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
    const angle = Math.atan2(point.y - (y + this.s(52)), point.x - width * 0.5);
    const edge = this.edgeClamp(angle, width, view.height, this.s(ULTIMA_ARROW_PAD));
    this.drawChevron(ctx, edge.x, edge.y, angle, this.s(18), UI_WARNING, pulse(view.time, 15, 0.65, 1));
  }

  private drawCenterBanners(ctx: CanvasRenderingContext2D, view: HudView): void {
    const item = this.banners[this.banners.length - 1];
    if (!item) return;
    const age = view.time - item.at;
    const fadeIn = clamp(age / 0.18, 0, 1);
    const fadeOut = 1 - clamp((age - (item.duration - BANNER_FADE)) / BANNER_FADE, 0, 1);
    const alpha = Math.min(fadeIn, fadeOut);
    const scale = lerp(1.08, 1, easeOutCubic(clamp(age / 0.24, 0, 1)));
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
    fillCenteredText(ctx, item.title, 0, 0);
    if (item.subtitle) {
      ctx.shadowBlur = 10;
      ctx.font = `${LABEL_FONT_WEIGHT} ${this.s(13)}px ${UI_FONT_STACK}`;
      ctx.fillStyle = UI_TEXT;
      fillCenteredText(ctx, item.subtitle, 0, this.s(28));
    }
    ctx.restore();
  }

  private drawStateWarnings(ctx: CanvasRenderingContext2D, view: HudView, time: number): void {
    const { world, seat, width, height } = view;
    const hpFraction = world.m.plHp[seat] / FRAME_STATS[world.m.plFrame[seat]].hp;
    const outside = world.m.plAlive[seat] === 1 && radial(world.m.plX[seat], world.m.plY[seat]) > world.m.world[W.SafeR];
    if (outside) {
      const alpha = pulse(time, STORM_PULSE_RATE, 0.08, 0.18);
      const gradient = ctx.createRadialGradient(width * 0.5, height * 0.5, Math.min(width, height) * 0.32, width * 0.5, height * 0.5, Math.max(width, height) * 0.65);
      gradient.addColorStop(0, 'rgba(255,0,0,0)');
      gradient.addColorStop(1, `rgba(255, 80, 100, ${alpha})`);
      ctx.save();
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, width, height);
      ctx.restore();
    }
    const hitAlpha = clamp((this.windows[seat].hitUntil - time) / HIT_PULSE_SECONDS, 0, 1) * 0.16;
    if (hitAlpha > 0) {
      ctx.save();
      ctx.fillStyle = `rgba(255, 110, 130, ${hitAlpha})`;
      ctx.fillRect(0, 0, width, height);
      ctx.restore();
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
    const { world, seat, project, names, width, height } = view;
    const point = { x: 0, y: 0 };
    for (let other = 0; other < world.seats; other++) {
      if (other === seat || world.m.plAlive[other] !== 1 || world.m.plTeam[other] === world.m.plTeam[seat]) continue;
      project(world.m.plX[other], world.m.plY[other], point);
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
