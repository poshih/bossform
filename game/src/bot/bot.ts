import { fx } from '@metronome/engine';
import {
  Button, BOSS_MIN_GAUGE, Form, FORMS, FRAME_STATS, Frame, GALE, JUGGERNAUT, MOVE_MAX, NEUTRAL_DEFS, NEUTRAL_INPUT, PartKind, Role, SHOT_DEFS,
  VANGUARD, W, isFighting,
} from '../sim/index.ts';
import type { GameInput, World } from '../sim/index.ts';

/**
 * A computer pilot: an ordinary input source, exactly like a keyboard. It reads the simulation through its public
 * surface, decides in floating point (bots never run inside the simulation), and emits a GameInput. Because only
 * the machine that owns the seat runs it, lockstep needs no special case for AI.
 */
const UNIT = 1 / fx.ONE;
const SENSE_RANGE = 120;
const SENSE_TICKS = 50;
const DODGE_MARGIN = 9;
const ORB_SEEK_RANGE = 170;
const NEUTRAL_SEEK_RANGE = 380;
const STORM_MARGIN = 40;
const FIRE_RANGE = 430;
const STRAFE_MIN_TICKS = 40;
const STRAFE_SPREAD_TICKS = 80;
const AIM_TOLERANCE = fx.deg(14);
const SIEGE_TOLERANCE = fx.deg(8);
const ULTIMA_RANGE = 480;
const SIEGE_RANGE = 520;
const TRANSFORM_RANGE = 650;
const BOSS_APPROACH_RANGE = 240;

/** Preferred fighting distance per frame: the fast striker brawls, the heavy bunker keeps its distance. */
const PREFERRED_RANGE: readonly number[] = [230, 170, 270];

interface Point {
  x: number;
  y: number;
}

const to = (a: number) => a * UNIT;

export class Bot {
  private readonly seat: number;
  private state: number;
  private strafe = 1;
  private strafeLeft = 0;
  /** 0..1: how sharply the bot reacts to bullets and how well it leads its aim. */
  private readonly skill: number;

  constructor(seat: number, seed: number, skill: number) {
    this.seat = seat;
    this.state = (seed ^ Math.imul(seat + 1, 0x9e3779b1)) >>> 0;
    this.skill = skill;
  }

  private random(): number {
    this.state = (Math.imul(this.state, 1664525) + 1013904223) >>> 0;
    return this.state / 4294967296;
  }

  think(w: World): GameInput {
    const { m } = w;
    const seat = this.seat;
    if (!isFighting(w, seat) || m.world[W.Phase] !== 1) return NEUTRAL_INPUT;
    const me: Point = { x: to(m.plX[seat]), y: to(m.plY[seat]) };
    const boss = m.plForm[seat] === Form.Boss;
    const frame = m.plFrame[seat];

    const target = this.pickTarget(w, me);
    let aim = m.plAim[seat];
    let range = Infinity;
    if (target !== null) {
      range = Math.hypot(target.x - me.x, target.y - me.y);
      aim = this.leadAim(w, me, target, range);
    }

    // movement: dodge first, then hold the preferred range while strafing, then chores (orbs, storm)
    const dodge = this.dodge(w, me);
    let mx = 0;
    let my = 0;
    const urgent = Math.hypot(dodge.x, dodge.y) > 0.35;
    if (urgent) {
      mx = dodge.x;
      my = dodge.y;
    } else {
      const chore = this.chore(w, me);
      if (chore !== null) {
        mx = chore.x;
        my = chore.y;
      } else if (target !== null) {
        const wanted = boss ? BOSS_APPROACH_RANGE : PREFERRED_RANGE[frame];
        const toward = Math.atan2(target.y - me.y, target.x - me.x);
        if (--this.strafeLeft <= 0) {
          this.strafe = this.random() < 0.5 ? -1 : 1;
          this.strafeLeft = STRAFE_MIN_TICKS + Math.floor(this.random() * STRAFE_SPREAD_TICKS);
        }
        const radial = range > wanted + 30 ? 1 : range < wanted - 30 ? -1 : 0;
        const side = toward + (Math.PI / 2) * this.strafe;
        mx = Math.cos(toward) * radial + Math.cos(side) * 0.8;
        my = Math.sin(toward) * radial + Math.sin(side) * 0.8;
      }
      mx += dodge.x;
      my += dodge.y;
    }
    const length = Math.hypot(mx, my);
    if (length > 1) {
      mx /= length;
      my /= length;
    }

    let buttons = 0;
    if (boss) buttons = this.bossButtons(w, target, range);
    else buttons = this.normalButtons(w, frame, target, range, urgent);
    if (!boss && m.plGauge[seat] >= BOSS_MIN_GAUGE + 4000 && range < TRANSFORM_RANGE && m.plHp[seat] > 20) buttons |= Button.Boss;

    return { moveX: Math.round(mx * MOVE_MAX), moveY: Math.round(my * MOVE_MAX), aim, buttons };
  }

  /** Nearest opposing ship, or a neutral unit when no ship is close (they pay in energy). */
  private pickTarget(w: World, me: Point): (Point & { vx: number; vy: number; ship: boolean }) | null {
    const { m } = w;
    let best: (Point & { vx: number; vy: number; ship: boolean }) | null = null;
    let bestD = Infinity;
    for (let s = 0; s < w.seats; s++) {
      if (s === this.seat || !isFighting(w, s) || m.plTeam[s] === m.plTeam[this.seat]) continue;
      const d = Math.hypot(to(m.plX[s]) - me.x, to(m.plY[s]) - me.y);
      if (d < bestD) {
        bestD = d;
        best = { x: to(m.plX[s]), y: to(m.plY[s]), vx: to(m.plVX[s]), vy: to(m.plVY[s]), ship: true };
      }
    }
    if (best !== null && bestD < NEUTRAL_SEEK_RANGE) return best;
    for (let n = 0; n < w.cap.neutrals; n++) {
      if (m.nAlive[n] !== 1) continue;
      const d = Math.hypot(to(m.nX[n]) - me.x, to(m.nY[n]) - me.y) - to(NEUTRAL_DEFS[m.nType[n]].rad);
      if (d < bestD && d < NEUTRAL_SEEK_RANGE) {
        bestD = d;
        best = { x: to(m.nX[n]), y: to(m.nY[n]), vx: to(m.nVX[n]), vy: to(m.nVY[n]), ship: false };
      }
    }
    return best;
  }

  private leadAim(w: World, me: Point, target: Point & { vx: number; vy: number }, range: number): number {
    const frame = w.m.plFrame[this.seat];
    const speed = to(this.projectileSpeed(w, frame));
    const t = (range / speed) * this.skill;
    const ax = target.x + target.vx * t - me.x;
    const ay = target.y + target.vy * t - me.y;
    return fx.fromRadians(Math.atan2(ay, ax));
  }

  private projectileSpeed(w: World, frame: number): number {
    if (w.m.plForm[this.seat] === Form.Boss) return FORMS[frame].salvo.shot.spd;
    return [VANGUARD.rifle.shot.spd, GALE.darts.shot.spd, JUGGERNAUT.mortar.shot.spd][frame];
  }

  /** Steers away from the closest approach of every hostile projectile that would touch the core. */
  private dodge(w: World, me: Point): Point {
    const { m } = w;
    const seat = this.seat;
    const boss = m.plForm[seat] === Form.Boss;
    const frame = m.plFrame[seat];
    const coreR = to(boss ? FORMS[frame].coreR : FRAME_STATS[frame].hurtR);
    const out: Point = { x: 0, y: 0 };
    const sense = SENSE_RANGE * (0.6 + 0.4 * this.skill);
    for (let p = 0; p < w.cap.projectiles; p++) {
      if (m.pAlive[p] !== 1 || m.pTeam[p] === m.plTeam[seat]) continue;
      const rx = to(m.pX[p]) - me.x;
      const ry = to(m.pY[p]) - me.y;
      if (rx > sense || rx < -sense || ry > sense || ry < -sense) continue;
      const def = SHOT_DEFS[m.pDef[p]];
      const angle = fx.toRadians(m.pAng[p]);
      const speed = to(m.pSpd[p]);
      const vx = Math.cos(angle) * speed;
      const vy = Math.sin(angle) * speed;
      const t = -(rx * vx + ry * vy) / (speed * speed);
      if (t < 0 || t > SENSE_TICKS) continue;
      const cx = rx + vx * t;
      const cy = ry + vy * t;
      const d = Math.hypot(cx, cy);
      const need = coreR + to(def.rad) + DODGE_MARGIN;
      if (d >= need) continue;
      const weight = ((need - d) / need) / (1 + t * 0.12);
      if (d < 0.001) {
        out.x += -vy * weight;
        out.y += vx * weight;
      } else {
        out.x += (-cx / d) * weight;
        out.y += (-cy / d) * weight;
      }
    }
    out.x *= 1.6;
    out.y *= 1.6;
    return out;
  }

  /** Storm avoidance and orb collection. */
  private chore(w: World, me: Point): Point | null {
    const { m } = w;
    const safe = to(m.world[W.SafeR]);
    const away = Math.hypot(me.x, me.y);
    if (away > safe - STORM_MARGIN) return { x: -me.x / away, y: -me.y / away };
    let best: Point | null = null;
    let bestD = ORB_SEEK_RANGE;
    for (let o = 0; o < w.cap.orbs; o++) {
      if (m.oAlive[o] !== 1) continue;
      const d = Math.hypot(to(m.oX[o]) - me.x, to(m.oY[o]) - me.y);
      if (d < bestD) {
        bestD = d;
        best = { x: (to(m.oX[o]) - me.x) / d, y: (to(m.oY[o]) - me.y) / d };
      }
    }
    return best;
  }

  private normalButtons(w: World, frame: number, target: (Point & { ship: boolean }) | null, range: number, threatened: boolean): number {
    let buttons = 0;
    if (target === null) return buttons;
    if (range < FIRE_RANGE) buttons |= Button.Fire;
    if (frame === Frame.Vanguard && range < 300) buttons |= Button.Alt;
    if (frame === Frame.Gale && threatened && this.random() < 0.15) buttons |= Button.Alt;
    if (frame === Frame.Juggernaut && (threatened || this.incoming(w) > 4)) buttons |= Button.Alt;
    return buttons;
  }

  private incoming(w: World): number {
    const { m } = w;
    const me: Point = { x: to(m.plX[this.seat]), y: to(m.plY[this.seat]) };
    let count = 0;
    for (let p = 0; p < w.cap.projectiles; p++) {
      if (m.pAlive[p] !== 1 || m.pTeam[p] === m.plTeam[this.seat]) continue;
      if (Math.hypot(to(m.pX[p]) - me.x, to(m.pY[p]) - me.y) < 90) count++;
    }
    return count;
  }

  /** Boss form: wait for the pods to swing onto the target (the tell works both ways), then use the attacks by priority. */
  private bossButtons(w: World, target: (Point & { ship: boolean }) | null, range: number): number {
    const { m } = w;
    if (target === null) return 0;
    const seat = this.seat;
    const form = FORMS[m.plFrame[seat]];
    const base = w.partBase(seat);
    const toTarget = fx.fromRadians(Math.atan2(target.y - to(m.plY[seat]), target.x - to(m.plX[seat])));
    const podOnTarget = (role: number, tolerance: number): boolean =>
      form.parts.some((part, k) => part.kind === PartKind.Pod && (part.roles & role) !== 0 && m.ptHp[base + k] > 0 &&
        Math.abs(fx.angleDiff(m.ptAng[base + k], toTarget)) <= tolerance);
    let buttons = 0;
    if (m.plUltCd[seat] === 0 && m.plGauge[seat] > form.ultima.cost + 6000 && range < ULTIMA_RANGE && target.ship) buttons |= Button.Ultima;
    else if (range < SIEGE_RANGE && podOnTarget(Role.Siege, SIEGE_TOLERANCE) && m.plGauge[seat] > form.siege.cost + 3000) buttons |= Button.Alt;
    else if (range < FIRE_RANGE && podOnTarget(Role.Salvo, AIM_TOLERANCE)) buttons |= Button.Fire;
    return buttons;
  }
}
