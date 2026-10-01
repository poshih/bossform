import { fx } from '@metronome/engine';
import {
  Attack, AttackPhase, Button, FORMS, Form, FRAME_STATS, Frame, MAX_PARTS, MUZZLE, PartKind, Pattern, PRIMARY_WEAPONS, PRISM, RONIN, Role,
  SHOT_DEFS, ShotFlag, canBoost, canUseAlt, isFighting, partCenter, podMuzzle, podReady,
} from '../sim/index.ts';
import type { Vec, World } from '../sim/index.ts';
import { mayFire, to, type BotSense, type Point, type RobotTactics } from './tactics.ts';

/** Where the katana's slashes fade, from RONIN's centre: the muzzle plus their flight (about 73 units). */
const KATANA_REACH = to(MUZZLE) + to(PRIMARY_WEAPONS[Frame.Ronin].reach);
/** RONIN slashes at a target this much beyond that: a slash's own width and the target's shield or core. */
const SLASH_MARGIN = 8;
/** Once in reach it circles the target at about this distance (the shared strafing, see bot.ts). */
const DUEL_RANGE = 52;
/** It walks in (the shared strafing takes over inside this distance)... */
const CLOSE_IN = DUEL_RANGE + 10;
/** ...weaving this far (radians) either side of the straight line while it is farther than a boost's reach... */
const WEAVE = 0.42;
const WEAVE_MIN_TICKS = 24;
const WEAVE_SPREAD_TICKS = 30;
/**
 * ...and boosts in at a pilot from where the boost (its speed times its ticks, about 94 units) ends between BOOST_IN_SHORT short
 * of it and inside the katana's reach. Chance per tick, scaled by skill; the boost's first ticks dodge what it flies through.
 */
const BOOST = FRAME_STATS[Frame.Ronin].boost;
const BOOST_REACH = to(BOOST.speed) * BOOST.ticks;
const BOOST_IN_SHORT = 20;
const BOOST_IN_MIN = BOOST_REACH + BOOST_IN_SHORT;
const BOOST_IN_MAX = BOOST_REACH + KATANA_REACH - 15;
const BOOST_IN_CHANCE = 0.12;
/** The boost aims where the pilot will be this many ticks later (scaled by skill). */
const BOOST_LEAD_TICKS = 8;

/**
 * The parry: raised when the first hostile shot or beam that would hurt RONIN is due at its guard within PARRY_LEAD ticks
 * (late, so the guard's ticks catch whatever follows), if what arrives while the guard is up is worth it: with the shield
 * raised, at least PARRY_WORTH_SHIELDED damage (a volley, not a stray bolt the shield stops cheaply); with it down, anything.
 * Chance per tick, scaled by skill: a pilot's reaction, not a machine's.
 */
const PARRY_LEAD = 4;
const PARRY_HORIZON = RONIN.parry.ticks - 1;
const PARRY_WORTH_SHIELDED = 8;
const PARRY_REACTION = 0.3;
/** A beam counts as this many of its pulses: it keeps burning while it crosses RONIN. */
const BEAM_PULSES = 3;
/** Shots and beams count as a threat when they pass this close to RONIN's shield. */
const HIT_MARGIN = 3;
/**
 * The guard turns to what it parries; when that is this close to the aim at the target (well inside the arc's half-width), it
 * stays on the target instead, so what it sends back flies at the pilot.
 */
const RIPOSTE_CONE = fx.deg(45);

const GUARD_RADIUS = to(RONIN.parry.radius);
const SHIELD_RADIUS = to(FRAME_STATS[Frame.Ronin].grazeR);

/** What is due at RONIN's guard: when the first of it arrives, how much it would hurt, and (summed, damage-weighted) where from. */
interface Threat {
  soonest: number;
  damage: number;
  x: number;
  y: number;
}

/** RONIN, the duelist: weaves and boosts in, circles its target inside the katana's reach and slashes, parries what comes at it. */
export function createRoninTactics(): RobotTactics {
  /** The direction the guard faces while parrying (binary angle), or null to aim at the target as usual. */
  let guard: number | null = null;
  let boostIn = false;
  let weaveSide = 1;
  let weaveLeft = 0;
  return {
    range: DUEL_RANGE,
    buttons(sense: BotSense): number {
      const { w, seat, range } = sense;
      const { m } = w;
      let buttons = boostIn ? Button.Boost : 0;
      boostIn = false;
      const threat = scan(sense);
      guard = null;
      if (m.plParry[seat] > 0) {
        // Keep the guard on what is still coming.
        if (threat.soonest < m.plParry[seat]) guard = guardOn(threat, sense.aim);
      } else if (threat.soonest <= PARRY_LEAD && threat.damage >= (m.plShield[seat] === 1 ? PARRY_WORTH_SHIELDED : 1) && canUseAlt(w, seat) && sense.random() < PARRY_REACTION * sense.skill) {
        buttons |= Button.Alt;
        guard = guardOn(threat, sense.aim);
      }
      // The katana does not swing while the guard is up.
      if (guard === null && m.plParry[seat] === 0 && range < KATANA_REACH + SLASH_MARGIN && mayFire(sense)) buttons |= Button.Fire;
      return buttons;
    },
    aim: (sense) => guard ?? sense.aim,
    move(sense: BotSense): Point | null {
      const { w, seat, me, target, range } = sense;
      if (range <= CLOSE_IN) return null;
      if (target.ship && range > BOOST_IN_MIN && range < BOOST_IN_MAX && canBoost(w, seat) && sense.random() < BOOST_IN_CHANCE * sense.skill) {
        boostIn = true;
        const lead = BOOST_LEAD_TICKS * sense.skill;
        return unit(target.x + target.vx * lead - me.x, target.y + target.vy * lead - me.y);
      }
      if (--weaveLeft <= 0) {
        weaveSide = sense.random() < 0.5 ? -1 : 1;
        weaveLeft = WEAVE_MIN_TICKS + Math.floor(sense.random() * WEAVE_SPREAD_TICKS);
      }
      const toward = Math.atan2(target.y - me.y, target.x - me.x);
      const heading = range > BOOST_IN_MIN ? toward + weaveSide * WEAVE : toward;
      return { x: Math.cos(heading), y: Math.sin(heading) };
    },
  };
}

function unit(x: number, y: number): Point {
  const length = Math.hypot(x, y);
  return length > 0 ? { x: x / length, y: y / length } : { x: 1, y: 0 };
}

/** Where to hold the guard against `threat`: toward it, or on the target (`aim`) when that covers it too (see RIPOSTE_CONE). */
function guardOn(threat: Threat, aim: number): number {
  if (threat.x === 0 && threat.y === 0) return aim;
  const toward = fx.fromRadians(Math.atan2(threat.y, threat.x));
  return Math.abs(fx.angleDiff(toward, aim)) <= RIPOSTE_CONE ? aim : toward;
}

/** Everything hostile due at RONIN's guard within the parry's duration. */
function scan(sense: BotSense): Threat {
  const threat: Threat = { soonest: Infinity, damage: 0, x: 0, y: 0 };
  shots(sense, threat);
  beams(sense.w, sense.seat, sense.me, threat);
  return threat;
}

/** Something due in `ticks`, dealing `damage`, reaching the guard from direction (dx, dy) (a unit vector from RONIN). */
function add(threat: Threat, ticks: number, damage: number, dx: number, dy: number): void {
  threat.soonest = Math.min(threat.soonest, ticks);
  threat.damage += damage;
  threat.x += dx * damage;
  threat.y += dy * damage;
}

/** Hostile shots that would reach RONIN's shield, by when they cross into its guard's radius and from where. */
function shots(sense: BotSense, threat: Threat): void {
  const { w, seat, me } = sense;
  const { m } = w;
  for (let p = 0; p < w.cap.projectiles; p++) {
    if (m.pAlive[p] !== 1 || m.pTeam[p] === m.plTeam[seat]) continue;
    const def = SHOT_DEFS[m.pDef[p]];
    if ((def.flags & ShotFlag.Inert) !== 0) continue;
    const radius = GUARD_RADIUS + to(def.rad);
    const speed = to(m.pSpd[p]);
    const rx = to(m.pX[p]) - me.x;
    const ry = to(m.pY[p]) - me.y;
    const reach = radius + speed * PARRY_HORIZON;
    if (rx * rx + ry * ry > reach * reach) continue;
    const heading = fx.toRadians(m.pAng[p]);
    const vx = Math.cos(heading) * speed;
    const vy = Math.sin(heading) * speed;
    const b = rx * vx + ry * vy;
    // Its closest approach must bring it onto the shield: a shot passing wide is no threat (though the guard would take it).
    if (b >= 0) continue;
    const closest = -b / (speed * speed);
    if (Math.hypot(rx + vx * closest, ry + vy * closest) > SHIELD_RADIUS + to(def.rad) + HIT_MARGIN) continue;
    // When it crosses the guard's radius: the first root of |r + v t| = radius (now, if it is already inside).
    const c = rx * rx + ry * ry - radius * radius;
    const t = c > 0 ? (-b - Math.sqrt(Math.max(0, b * b - speed * speed * c))) / (speed * speed) : 0;
    if (t > PARRY_HORIZON) continue;
    const ex = rx + vx * t;
    const ey = ry + vy * t;
    const length = Math.hypot(ex, ey);
    if (length > 0) add(threat, t, def.dmg, ex / length, ey / length);
  }
}

const pod: Vec = { x: 0, y: 0 };
const center: Vec = { x: 0, y: 0 };

/** Hostile beams whose line crosses RONIN: a PRISM's beam and lance, a colossus's beam attack or wheel (see bot/hazards.ts). */
function beams(w: World, seat: number, me: Point, threat: Threat): void {
  const { m } = w;
  for (let s = 0; s < w.seats; s++) {
    if (!isFighting(w, s) || m.plTeam[s] === m.plTeam[seat]) continue;
    if (m.plForm[s] === Form.Normal && m.plFrame[s] === Frame.Prism) prismBeams(w, s, me, threat);
    else if (m.plForm[s] === Form.Boss) bossBeams(w, s, me, threat);
  }
}

function prismBeams(w: World, s: number, me: Point, threat: Threat): void {
  const { m } = w;
  const muzzle = to(MUZZLE);
  const x = to(m.plX[s]);
  const y = to(m.plY[s]);
  if (m.plBeam[s] > 0) {
    const angle = fx.toRadians(m.plBeamAng[s]);
    const ticks = Math.max(0, PRISM.beam.tell + 1 - m.plBeam[s]);
    line(threat, me, x + Math.cos(angle) * muzzle, y + Math.sin(angle) * muzzle, angle, to(PRISM.beam.length), to(PRISM.beam.width), ticks, PRISM.beam.dmg * BEAM_PULSES);
  }
  if (m.plLance[s] > 0) {
    // It counts down at the start of PRISM's tick and fires when it reaches zero: plLance ticks from now.
    const angle = fx.toRadians(m.plLanceAng[s]);
    line(threat, me, x + Math.cos(angle) * muzzle, y + Math.sin(angle) * muzzle, angle, to(PRISM.lance.length), to(PRISM.lance.width), m.plLance[s], PRISM.lance.dmg);
  }
}

function bossBeams(w: World, s: number, me: Point, threat: Threat): void {
  const { m } = w;
  const attack = m.plAtk[s];
  const phase = m.plAtkPhase[s];
  if (attack === Attack.None || (phase !== AttackPhase.Windup && phase !== AttackPhase.Release)) return;
  const form = FORMS[m.plFrame[s]];
  const def = attack === Attack.Salvo ? form.salvo : attack === Attack.Siege ? form.siege : form.ultima;
  if (def.pattern !== Pattern.Beam && def.pattern !== Pattern.Wheel) return;
  const role = attack === Attack.Salvo ? Role.Salvo : attack === Attack.Siege ? Role.Siege : Role.Ultima;
  const base = s * MAX_PARTS;
  // The wind-up counts down each tick and the beam's first pulse comes with the release, when it reaches zero.
  const ticks = phase === AttackPhase.Windup ? m.plAtkTimer[s] : 0;
  for (let k = 0; k < form.parts.length; k++) {
    const part = form.parts[k];
    if (part.kind !== PartKind.Pod || (part.roles & role) === 0 || !podReady(w, s, k)) continue;
    let angle: number;
    if (def.pattern === Pattern.Wheel) {
      partCenter(w, s, k, center);
      angle = Math.atan2(center.y - m.plY[s], center.x - m.plX[s]);
      pod.x = center.x + Math.cos(angle) * part.muzzle;
      pod.y = center.y + Math.sin(angle) * part.muzzle;
    } else {
      podMuzzle(w, s, k, pod);
      angle = fx.toRadians(m.ptAng[base + k]);
    }
    line(threat, me, to(pod.x), to(pod.y), angle, to(def.length), to(def.width), ticks, def.dmg * BEAM_PULSES);
  }
}

/** A beam from (x, y) along `angle`, due in `ticks`: a threat if its line crosses RONIN's shield; it reaches the guard from its source. */
function line(threat: Threat, me: Point, x: number, y: number, angle: number, length: number, halfWidth: number, ticks: number, damage: number): void {
  if (ticks > PARRY_HORIZON) return;
  const ux = Math.cos(angle);
  const uy = Math.sin(angle);
  const rx = me.x - x;
  const ry = me.y - y;
  const along = rx * ux + ry * uy;
  if (along < 0 || along > length + GUARD_RADIUS) return;
  const across = ry * ux - rx * uy;
  if (Math.abs(across) > halfWidth + SHIELD_RADIUS + HIT_MARGIN) return;
  add(threat, ticks, damage, -ux, -uy);
}
