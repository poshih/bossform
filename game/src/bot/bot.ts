import { fx } from '@metronome/engine';
import {
  Attack, Button, BOSS_MIN_GAUGE, Form, FORMS, FRAME_STATS, Frame, GALE, JUGGERNAUT, MOVE_MAX, NEUTRAL_DEFS, NEUTRAL_INPUT, PartKind, Phase, Role,
  SHOT_DEFS, ShotFlag, VANGUARD, W, attackFuel, canStartAttack, isFighting,
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
/** Energy kept on top of the transform threshold before transforming, so the boss form lasts long enough to matter. */
const TRANSFORM_RESERVE = 4000;
/** A pilot this low on health does not start a transformation (it would unfold, protected, and then be finished). */
const TRANSFORM_MIN_HP = 20;
/** Energy kept on top of a siege shot's fuel, so the colossus can still salvo afterwards. */
const SIEGE_RESERVE = 3000;
/** A dodge vector longer than this overrides every other movement goal. */
const DODGE_URGENT = 0.35;
const DODGE_GAIN = 1.6;
/** How much less a bullet matters per tick until its closest approach. */
const DODGE_TIME_FALLOFF = 0.12;
/** The reaction range grows from this share of SENSE_RANGE (skill 0) to all of it (skill 1). */
const SENSE_BASE_SHARE = 0.6;
/** Distance the preferred range may drift before the bot closes in or backs off. */
const RANGE_SLACK = 30;
/** How strongly the bot circles its target while holding its range. */
const STRAFE_WEIGHT = 0.8;
const SEEKER_RANGE = 300;
/** Chance per threatened tick that GALE dashes out. */
const DASH_CHANCE = 0.15;
/** JUGGERNAUT raises its bulwark when more hostile shots than this are within INCOMING_RADIUS. */
const BULWARK_THREAT = 4;
const INCOMING_RADIUS = 90;

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
    if (!isFighting(w, seat) || m.world[W.Phase] !== Phase.Battle) return NEUTRAL_INPUT;
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
    const urgent = Math.hypot(dodge.x, dodge.y) > DODGE_URGENT;
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
        const radial = range > wanted + RANGE_SLACK ? 1 : range < wanted - RANGE_SLACK ? -1 : 0;
        const side = toward + (Math.PI / 2) * this.strafe;
        mx = Math.cos(toward) * radial + Math.cos(side) * STRAFE_WEIGHT;
        my = Math.sin(toward) * radial + Math.sin(side) * STRAFE_WEIGHT;
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
    // Transform to fight a pilot, never for chores against neutral units.
    if (!boss && target !== null && target.ship && m.plGauge[seat] >= BOSS_MIN_GAUGE + TRANSFORM_RESERVE && range < TRANSFORM_RANGE && m.plHp[seat] > TRANSFORM_MIN_HP) {
      buttons |= Button.Boss;
    }

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
    const sense = SENSE_RANGE * (SENSE_BASE_SHARE + (1 - SENSE_BASE_SHARE) * this.skill);
    for (let p = 0; p < w.cap.projectiles; p++) {
      if (m.pAlive[p] !== 1 || m.pTeam[p] === m.plTeam[seat]) continue;
      const def = SHOT_DEFS[m.pDef[p]];
      // Inert fuses do not hurt (their burst does, and the shards are dodged when they exist); some do not move at all.
      if ((def.flags & ShotFlag.Inert) !== 0) continue;
      const rx = to(m.pX[p]) - me.x;
      const ry = to(m.pY[p]) - me.y;
      if (rx > sense || rx < -sense || ry > sense || ry < -sense) continue;
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
      const weight = ((need - d) / need) / (1 + t * DODGE_TIME_FALLOFF);
      if (d < 0.001) {
        out.x += -vy * weight;
        out.y += vx * weight;
      } else {
        out.x += (-cx / d) * weight;
        out.y += (-cy / d) * weight;
      }
    }
    out.x *= DODGE_GAIN;
    out.y *= DODGE_GAIN;
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
    if (frame === Frame.Vanguard && range < SEEKER_RANGE) buttons |= Button.Alt;
    if (frame === Frame.Gale && threatened && this.random() < DASH_CHANCE) buttons |= Button.Alt;
    if (frame === Frame.Juggernaut && (threatened || this.incoming(w) > BULWARK_THREAT)) buttons |= Button.Alt;
    return buttons;
  }

  private incoming(w: World): number {
    const { m } = w;
    const me: Point = { x: to(m.plX[this.seat]), y: to(m.plY[this.seat]) };
    let count = 0;
    for (let p = 0; p < w.cap.projectiles; p++) {
      if (m.pAlive[p] !== 1 || m.pTeam[p] === m.plTeam[this.seat] || (SHOT_DEFS[m.pDef[p]].flags & ShotFlag.Inert) !== 0) continue;
      if (Math.hypot(to(m.pX[p]) - me.x, to(m.pY[p]) - me.y) < INCOMING_RADIUS) count++;
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
    // The same eligibility the simulation applies (live pods, cooldown, fuel), so a bot never waits on an attack it cannot make.
    let buttons = 0;
    if (target.ship && range < ULTIMA_RANGE && canStartAttack(w, seat, Attack.Ultima)) buttons |= Button.Ultima;
    else if (range < SIEGE_RANGE && podOnTarget(Role.Siege, SIEGE_TOLERANCE) && canStartAttack(w, seat, Attack.Siege) && m.plGauge[seat] >= attackFuel(form, Attack.Siege) + SIEGE_RESERVE) {
      buttons |= Button.Alt;
    } else if (range < FIRE_RANGE && podOnTarget(Role.Salvo, AIM_TOLERANCE) && canStartAttack(w, seat, Attack.Salvo)) buttons |= Button.Fire;
    return buttons;
  }
}
