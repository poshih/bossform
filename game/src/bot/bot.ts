import { fx } from '@metronome/engine';
import {
  ARTILLERY_CONE, Attack, Button, BOSS_MIN_GAUGE, Form, FORMS, FRAME_STATS, Frame, MOVE_MAX, NEUTRAL_DEFS, NEUTRAL_INPUT, PartKind, Pattern, Phase, Role,
  PRIMARY_WEAPONS, SHOT_DEFS, ShotFlag, W, attackFuel, canBoost, canStartAttack, isFighting, podReady,
} from '../sim/index.ts';
import type { GameInput, SalvoDef, SiegeDef, UltimaDef, World } from '../sim/index.ts';
import { createGaleTactics } from './gale.ts';
import { createGauntletTactics } from './gauntlet.ts';
import { createHailstormTactics } from './hailstorm.ts';
import { avoidHazards } from './hazards.ts';
import { createJuggernautTactics } from './juggernaut.ts';
import { createLongbowTactics } from './longbow.ts';
import { createPrismTactics } from './prism.ts';
import { createRoninTactics } from './ronin.ts';
import { createShadeTactics } from './shade.ts';
import { FIRE_RANGE, to, type BotSense, type Point, type RobotTactics, type Target } from './tactics.ts';
import { createVanguardTactics } from './vanguard.ts';

/**
 * A computer pilot: an ordinary input source, exactly like a keyboard. It reads the simulation through its public
 * surface, decides in floating point (bots never run inside the simulation), and emits a GameInput. Because only
 * the machine that owns the seat runs it, lockstep needs no special case for AI. What differs per robot (its fighting
 * distance and how it uses its weapons) lives in bot/<robot>.ts behind the RobotTactics contract (bot/tactics.ts).
 */
const SENSE_RANGE = 120;
const SENSE_TICKS = 50;
const DODGE_MARGIN = 9;
const ORB_SEEK_RANGE = 170;
const NEUTRAL_SEEK_RANGE = 380;
const STORM_MARGIN = 40;
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
/**
 * Fairness: a cloaked pilot is invisible to the other side except as a faint shimmer, so a bot notices one only this close
 * (world units).
 */
const CLOAK_SIGHT = 90;
/** Boss beam attacks and wheels are started on a target within this share of the beams' length. */
const BEAM_RANGE_SHARE = 0.9;
/** A carpet is laid on a target from this share of its first bomb's distance to half a gap past its last. */
const CARPET_NEAR_SHARE = 0.8;
/**
 * Energy discipline (energy powers both the guns and the shield): a bot stops firing when its pool runs low and starts again
 * once it has refilled this far, so it is not left without a shield for long. A target whose shield just shattered is fired
 * on regardless.
 */
const FIRE_STOP_ENERGY = 60;
const FIRE_RESUME_ENERGY = 260;
/** Chances per tick (scaled by skill for dodging) of boosting out of a shot about to land, at a far target, or away when nearly destroyed. */
const BOOST_DODGE_CHANCE = 0.1;
const BOOST_CLOSE_CHANCE = 0.03;
const BOOST_ESCAPE_CHANCE = 0.1;
/** Boost at a target this much farther away than the preferred range. */
const BOOST_CLOSE_EXTRA = 160;
/** Boost away from a pilot this close while below this share of health. */
const ESCAPE_RANGE = 170;
const ESCAPE_HP_SHARE = 0.3;

/** The tactics of each robot, by frame. */
function tacticsFor(frame: number): RobotTactics {
  switch (frame) {
    case Frame.Vanguard:
      return createVanguardTactics();
    case Frame.Gale:
      return createGaleTactics();
    case Frame.Juggernaut:
      return createJuggernautTactics();
    case Frame.Longbow:
      return createLongbowTactics();
    case Frame.Prism:
      return createPrismTactics();
    case Frame.Hailstorm:
      return createHailstormTactics();
    case Frame.Ronin:
      return createRoninTactics();
    case Frame.Shade:
      return createShadeTactics();
    case Frame.Gauntlet:
      return createGauntletTactics();
    default:
      throw new RangeError(`no bot tactics for frame ${frame}`);
  }
}

export class Bot {
  private readonly seat: number;
  private state: number;
  private strafe = 1;
  private strafeLeft = 0;
  /** Holding fire until the energy pool refills (see FIRE_STOP_ENERGY). */
  private conserving = false;
  /** 0..1: how sharply the bot reacts to bullets and how well it leads its aim. */
  private readonly skill: number;
  /** Its robot's tactics, made on the first tick it flies that robot (a bot is built before it knows its frame). */
  private tactics: RobotTactics | null = null;
  private tacticsFrame = -1;
  private readonly randomStream = (): number => this.random();

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
    const tactics = this.tacticsOf(frame);

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
    if (!boss) this.keepDiscipline(m.plEnergy[seat]);
    const sense = !boss && target !== null ? this.senseOf(w, me, target, range, aim, urgent, dodge.soonest) : null;
    if (urgent) {
      mx = dodge.x;
      my = dodge.y;
    } else {
      const goal = this.goal(w, me, tactics, sense);
      if (goal !== null) {
        mx = goal.x;
        my = goal.y;
      } else if (target !== null) {
        const wanted = boss ? BOSS_APPROACH_RANGE : tactics.range;
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
    let buttons = 0;
    if (!boss) {
      const burst = this.boostDirection(w, me, target, range, dodge, urgent, tactics.range);
      if (burst !== null) {
        mx = burst.x;
        my = burst.y;
        buttons |= Button.Boost;
      }
    }
    const length = Math.hypot(mx, my);
    if (length > 1) {
      mx /= length;
      my /= length;
    }

    if (boss) buttons |= this.bossButtons(w, target, range);
    else if (sense !== null) {
      buttons |= tactics.buttons(sense);
      aim = tactics.aim(sense);
    }
    // Transform to fight a pilot, never for chores against neutral units.
    if (!boss && target !== null && target.ship && m.plGauge[seat] >= BOSS_MIN_GAUGE + TRANSFORM_RESERVE && range < TRANSFORM_RANGE && m.plHp[seat] > TRANSFORM_MIN_HP) {
      buttons |= Button.Boss;
    }

    return { moveX: Math.round(mx * MOVE_MAX), moveY: Math.round(my * MOVE_MAX), aim, buttons };
  }

  /** Where to head instead of the shared approach-and-strafe: chores (storm, orbs) first, then the robot's own movement goal. */
  private goal(w: World, me: Point, tactics: RobotTactics, sense: BotSense | null): Point | null {
    const chore = this.chore(w, me);
    if (chore !== null || sense === null) return chore;
    return tactics.move(sense);
  }

  private tacticsOf(frame: number): RobotTactics {
    if (this.tactics === null || this.tacticsFrame !== frame) {
      this.tactics = tacticsFor(frame);
      this.tacticsFrame = frame;
    }
    return this.tactics;
  }

  /** Energy discipline, the same for every robot: energy powers both the guns and the shield (see FIRE_STOP_ENERGY). */
  private keepDiscipline(energy: number): void {
    if (this.conserving && energy >= FIRE_RESUME_ENERGY) this.conserving = false;
    else if (!this.conserving && energy < FIRE_STOP_ENERGY) this.conserving = true;
  }

  /** What a normal-form robot's tactics read this tick. */
  private senseOf(w: World, me: Point, target: Target, range: number, aim: number, threatened: boolean, soonest: number): BotSense {
    const { m } = w;
    return {
      w,
      seat: this.seat,
      me,
      target,
      range,
      aim,
      threatened,
      soonest,
      conserving: this.conserving,
      exposed: target.ship && m.plShieldBreak[target.seat] > 0,
      skill: this.skill,
      random: this.randomStream,
    };
  }

  /** Nearest opposing ship, or a neutral unit when no ship is close (they pay into the boss gauge). */
  private pickTarget(w: World, me: Point): Target | null {
    const { m } = w;
    let best: Target | null = null;
    let bestD = Infinity;
    for (let s = 0; s < w.seats; s++) {
      if (s === this.seat || !isFighting(w, s) || m.plTeam[s] === m.plTeam[this.seat]) continue;
      const d = Math.hypot(to(m.plX[s]) - me.x, to(m.plY[s]) - me.y);
      if (m.plCloak[s] > 0 && d > CLOAK_SIGHT) continue;
      if (d < bestD) {
        bestD = d;
        best = { x: to(m.plX[s]), y: to(m.plY[s]), vx: to(m.plVX[s]), vy: to(m.plVY[s]), ship: true, seat: s };
      }
    }
    if (best !== null && bestD < NEUTRAL_SEEK_RANGE) return best;
    for (let n = 0; n < w.cap.neutrals; n++) {
      if (m.nAlive[n] !== 1) continue;
      const d = Math.hypot(to(m.nX[n]) - me.x, to(m.nY[n]) - me.y) - to(NEUTRAL_DEFS[m.nType[n]].rad);
      if (d < bestD && d < NEUTRAL_SEEK_RANGE) {
        bestD = d;
        best = { x: to(m.nX[n]), y: to(m.nY[n]), vx: to(m.nVX[n]), vy: to(m.nVY[n]), ship: false, seat: -1 };
      }
    }
    return best;
  }

  /** A unit direction to boost in this tick, or null: out of an urgent dodge, at a far pilot, or away when nearly destroyed. */
  private boostDirection(w: World, me: Point, target: Target | null, range: number, dodge: Point & { soonest: number }, urgent: boolean, preferred: number): Point | null {
    const { m } = w;
    const seat = this.seat;
    if (!canBoost(w, seat)) return null;
    // Like a person: a boost out of the way at the last moment, when a shot is about to land, not whenever one is coming.
    if (urgent && dodge.soonest <= FRAME_STATS[m.plFrame[seat]].boost.dodge && this.random() < BOOST_DODGE_CHANCE * this.skill) {
      const length = Math.hypot(dodge.x, dodge.y);
      return { x: dodge.x / length, y: dodge.y / length };
    }
    if (target === null || !target.ship || range < 1) return null;
    const toward = { x: (target.x - me.x) / range, y: (target.y - me.y) / range };
    if (range > preferred + BOOST_CLOSE_EXTRA && this.random() < BOOST_CLOSE_CHANCE) return toward;
    const low = m.plHp[seat] < FRAME_STATS[m.plFrame[seat]].hp * ESCAPE_HP_SHARE;
    if (low && range < ESCAPE_RANGE && this.random() < BOOST_ESCAPE_CHANCE) return { x: -toward.x, y: -toward.y };
    return null;
  }

  /** Leads the target for the shot about to be fired; beams and lobbed shells (speed 0 here) are aimed straight at it. */
  private leadAim(w: World, me: Point, target: Point & { vx: number; vy: number }, range: number): number {
    const frame = w.m.plFrame[this.seat];
    const speed = to(this.projectileSpeed(w, frame));
    const t = speed > 0 ? (range / speed) * this.skill : 0;
    const ax = target.x + target.vx * t - me.x;
    const ay = target.y + target.vy * t - me.y;
    return fx.fromRadians(Math.atan2(ay, ax));
  }

  /** Fixed-point speed of the shot the bot leads for: its primary's, or its boss form's salvo volley (0: nothing to lead). */
  private projectileSpeed(w: World, frame: number): number {
    if (w.m.plForm[this.seat] === Form.Boss) {
      const salvo = FORMS[frame].salvo;
      return salvo.pattern === Pattern.Volley ? salvo.shot.spd : 0;
    }
    return PRIMARY_WEAPONS[frame].speed;
  }

  /**
   * Steers away from the closest approach of every hostile projectile that would touch the core. `soonest` is the fewest
   * ticks until one of them arrives (Infinity when none threatens).
   */
  private dodge(w: World, me: Point): Point & { soonest: number } {
    const { m } = w;
    const seat = this.seat;
    const boss = m.plForm[seat] === Form.Boss;
    const frame = m.plFrame[seat];
    const coreR = to(boss ? FORMS[frame].coreR : FRAME_STATS[frame].hurtR);
    const out = { x: 0, y: 0, soonest: Infinity };
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
      out.soonest = Math.min(out.soonest, t);
      if (d < 0.001) {
        out.x += -vy * weight;
        out.y += vx * weight;
      } else {
        out.x += (-cx / d) * weight;
        out.y += (-cy / d) * weight;
      }
    }
    avoidHazards(w, seat, me, coreR, to(boss ? FORMS[frame].reach : FRAME_STATS[frame].bodyR), out);
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

  /**
   * Boss form: wait for the pods to swing onto the target (the tell works both ways), then use the attacks by priority. Each
   * attack is started only where its pattern reaches: a volley within its range, a beam within its length, artillery on a
   * pilot inside a pod's cone, a carpet on one along its line.
   */
  private bossButtons(w: World, target: Target | null, range: number): number {
    const { m } = w;
    if (target === null) return 0;
    const seat = this.seat;
    const form = FORMS[m.plFrame[seat]];
    const base = w.partBase(seat);
    const toTarget = fx.fromRadians(Math.atan2(target.y - to(m.plY[seat]), target.x - to(m.plX[seat])));
    const podOnTarget = (role: number, tolerance: number): boolean =>
      form.parts.some((part, k) => part.kind === PartKind.Pod && (part.roles & role) !== 0 && podReady(w, seat, k) &&
        Math.abs(fx.angleDiff(m.ptAng[base + k], toTarget)) <= tolerance);
    // The same eligibility the simulation applies (pods at hand, cooldown, fuel), so a bot never waits on an attack it cannot
    // make; one whose pods' weapons are away (AttackBlock.Away) comes back into play when they are caught.
    let buttons = 0;
    if (target.ship && ultimaReaches(form.ultima, range) && canStartAttack(w, seat, Attack.Ultima)) buttons |= Button.Ultima;
    else if (reaches(form.siege, SIEGE_RANGE, range) && podOnTarget(Role.Siege, tolerance(form.siege, SIEGE_TOLERANCE)) && canStartAttack(w, seat, Attack.Siege) && m.plGauge[seat] >= attackFuel(form, Attack.Siege) + SIEGE_RESERVE) {
      buttons |= Button.Alt;
    } else if (reaches(form.salvo, FIRE_RANGE, range) && podOnTarget(Role.Salvo, tolerance(form.salvo, AIM_TOLERANCE)) && canStartAttack(w, seat, Attack.Salvo)) buttons |= Button.Fire;
    return buttons;
  }
}

/** A salvo or siege attack reaches a target this far away (`volleyRange` for volleys, which fly until they fade). */
function reaches(attack: SalvoDef | SiegeDef, volleyRange: number, range: number): boolean {
  switch (attack.pattern) {
    case Pattern.Volley:
      return range < volleyRange;
    case Pattern.Beam:
      return range < to(attack.length) * BEAM_RANGE_SHARE;
    case Pattern.Artillery:
      return range < to(attack.range);
    case Pattern.Carpet:
      return carpetReaches(attack.first, attack.gap, attack.count, range);
    default:
      throw new RangeError(`no bot rule for attack pattern ${(attack as { pattern: number }).pattern}`);
  }
}

/** How far off a pod may point and still start the attack: artillery aims itself at the nearest pilot within its cone. */
function tolerance(attack: SalvoDef | SiegeDef, aimed: number): number {
  return attack.pattern === Pattern.Artillery ? ARTILLERY_CONE : aimed;
}

function ultimaReaches(ultima: UltimaDef, range: number): boolean {
  switch (ultima.pattern) {
    case Pattern.Spiral:
      return range < ULTIMA_RANGE;
    case Pattern.Wheel:
      return range < to(ultima.length) * BEAM_RANGE_SHARE;
    case Pattern.Bombard:
      return range < to(ultima.range);
    case Pattern.Carpet:
      return carpetReaches(ultima.first, ultima.gap, ultima.count, range);
    default:
      throw new RangeError(`no bot rule for ultima pattern ${(ultima as { pattern: number }).pattern}`);
  }
}

function carpetReaches(first: number, gap: number, count: number, range: number): boolean {
  return range >= to(first) * CARPET_NEAR_SHARE && range <= to(first + gap * (count - 1) + (gap >> 1));
}
