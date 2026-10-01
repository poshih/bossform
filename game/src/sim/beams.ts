import { fx } from '@metronome/engine';
import { dodging } from './boost.ts';
import { Form, GAUGE_PER_ABSORB, PROJECTILE_RIM_MARGIN, RADIAL_SHIFT, SHIELD_COST_PER_DAMAGE } from './constants.ts';
import { DamageKind, damageShip } from './damage.ts';
import { absorbShot, spendEnergy } from './energy.ts';
import { Ev } from './events.ts';
import { FORMS } from './forms.ts';
import { FRAME_STATS, JUGGERNAUT } from './frames.ts';
import { earn } from './gauge.ts';
import type { Vec } from './geometry.ts';
import { damageNeutral, NEUTRAL_DEFS } from './neutrals.ts';
import { damagePart } from './parts.ts';
import { isFighting, partCenter } from './query.ts';
import { RONIN } from './ronin.ts';
import { cutBeam } from './ronin-weapons.ts';
import type { World } from './world.ts';

/**
 * Beams: a robot's (PRISM's beam and lance) and a boss pod's (a Beam attack's sweep, a Wheel ultima's spokes). A beam is one
 * deterministic ray cast from an origin along an angle, up to a length and `width` either side, and the first hostile thing
 * it meets stops it: a RONIN's parry arc (which cuts it), a JUGGERNAUT's bulwark (while its pool can pay for a pulse, like
 * bullets), a raised shield, a robot's core, a live boss-form part, a boss form's core, a neutral unit. Protected or dodging
 * robots let it pass, as they let bullets pass; the rim stops it. Damage lands only on pulse ticks (fireBeam); on the ticks
 * between, traceBeam only finds where it stops, so it can be drawn. Distances are measured along and across the ray
 * (projections), so no arena-scale value is ever squared; only obstacle radii are.
 */

/** Who fires a beam and what one pulse of it does. */
export interface Beam {
  /** The seat firing it. */
  readonly owner: number;
  readonly team: number;
  /** Half-width: added to the radius of everything the beam can meet. */
  readonly width: number;
  /** Damage of one pulse (a bulwark stops the beam only while its pool can pay for a pulse). */
  readonly dmg: number;
}

/** What stopped a beam. */
const Stop = { None: 0, Parry: 1, Bulwark: 2, Shield: 3, Core: 4, Part: 5, BossCore: 6, Neutral: 7 } as const;
/** A ray that does not meet an obstacle (distances along a ray are never negative). */
const MISS = -1;

if (RONIN.parry.halfArc >= fx.ANGLE_QUARTER || JUGGERNAUT.bulwark.halfArc >= fx.ANGLE_QUARTER) {
  throw new RangeError('beams clip a parry or a bulwark as a wedge: its half-arc must stay under a right angle');
}

interface Ray {
  readonly x: number;
  readonly y: number;
  /** Direction cosine and sine. */
  readonly c: number;
  readonly s: number;
  /** Clipped at the rim. */
  readonly length: number;
}

interface Hit {
  stop: number;
  seat: number;
  /** The boss part or the neutral unit that stopped it. */
  index: number;
  /** Distance along the ray. */
  at: number;
}

/** Distance along the ray at which it first touches the circle of radius `r` around (cx, cy) (0 if it starts inside), or MISS. */
function enterCircle(ray: Ray, cx: number, cy: number, r: number): number {
  const dx = cx - ray.x;
  const dy = cy - ray.y;
  const along = fx.mul(dx, ray.c) + fx.mul(dy, ray.s);
  if (along < -r || along - r > ray.length) return MISS;
  const across = fx.mul(dy, ray.c) - fx.mul(dx, ray.s);
  if (across > r || across < -r) return MISS;
  const half = fx.isqrt(r * r - across * across);
  if (along + half < 0 || along - half > ray.length) return MISS;
  return Math.max(0, along - half);
}

/** The part of a ray, as distances along it, that lies inside a region. */
interface Span {
  lo: number;
  hi: number;
}

/**
 * Narrows `span` to the side of the line through (dx, dy) (relative to the ray's origin) that its normal (nx, ny) points to.
 * The ray crosses that line where n.(origin - centre) + t n.direction = 0.
 */
function clipHalfPlane(ray: Ray, dx: number, dy: number, nx: number, ny: number, span: Span): void {
  const start = -(fx.mul(nx, dx) + fx.mul(ny, dy));
  const rate = fx.mul(nx, ray.c) + fx.mul(ny, ray.s);
  if (rate === 0) {
    if (start < 0) span.hi = -1;
    return;
  }
  const t = fx.div(-start, rate);
  if (rate > 0) span.lo = Math.max(span.lo, t);
  else span.hi = Math.min(span.hi, t);
}

/**
 * Distance along the ray at which it first enters the wedge of radius `r` around (cx, cy), `halfArc` (under a right angle)
 * either side of `facing`, or MISS: the circle's chord, clipped by the wedge's two edges.
 */
function enterWedge(ray: Ray, cx: number, cy: number, r: number, facing: number, halfArc: number): number {
  const dx = cx - ray.x;
  const dy = cy - ray.y;
  const along = fx.mul(dx, ray.c) + fx.mul(dy, ray.s);
  const across = fx.mul(dy, ray.c) - fx.mul(dx, ray.s);
  if (along < -r || along - r > ray.length || across > r || across < -r) return MISS;
  const half = fx.isqrt(r * r - across * across);
  const span: Span = { lo: Math.max(0, along - half), hi: Math.min(ray.length, along + half) };
  // Inside the wedge: to the left of the edge at facing - halfArc and to the right of the edge at facing + halfArc.
  const right = facing - halfArc;
  const left = facing + halfArc;
  clipHalfPlane(ray, dx, dy, -fx.sin(right), fx.cos(right), span);
  clipHalfPlane(ray, dx, dy, fx.sin(left), -fx.cos(left), span);
  return span.lo <= span.hi ? span.lo : MISS;
}

/** How far a ray from (x, y) along (c, s) runs before it crosses the rim (as projectiles vanish there), in shifted units like span2. */
function toRim(w: World, x: number, y: number, c: number, s: number): number {
  const r = (w.arenaR + PROJECTILE_RIM_MARGIN) >> RADIAL_SHIFT;
  const along = -(fx.mul(x, c) + fx.mul(y, s)) >> RADIAL_SHIFT;
  const across = (fx.mul(x, s) - fx.mul(y, c)) >> RADIAL_SHIFT;
  if (across > r || across < -r) return 0;
  const exit = along + fx.isqrt(r * r - across * across);
  return exit > 0 ? exit << RADIAL_SHIFT : 0;
}

function closer(hit: Hit, stop: number, seat: number, index: number, at: number): void {
  if (at === MISS || at >= hit.at) return;
  hit.stop = stop;
  hit.seat = seat;
  hit.index = index;
  hit.at = at;
}

/** A robot's obstacles, in the order a bullet meets them (combat.ts hitRobot): parry, bulwark, then (unless it lets everything pass) shield, core. */
function meetRobot(w: World, beam: Beam, ray: Ray, seat: number, hit: Hit): void {
  const { m } = w;
  const stats = FRAME_STATS[m.plFrame[seat]];
  const x = m.plX[seat];
  const y = m.plY[seat];
  if (m.plParry[seat] > 0) closer(hit, Stop.Parry, seat, -1, enterWedge(ray, x, y, RONIN.parry.radius + beam.width, m.plAim[seat], RONIN.parry.halfArc));
  const bulwark = JUGGERNAUT.bulwark;
  if (m.plBulwark[seat] > 0 && m.plEnergy[seat] >= beam.dmg * SHIELD_COST_PER_DAMAGE) {
    closer(hit, Stop.Bulwark, seat, -1, enterWedge(ray, x, y, bulwark.radius + beam.width, m.plAim[seat], bulwark.halfArc));
  }
  if (m.plInvuln[seat] > 0 || dodging(w, seat)) return;
  if (m.plShield[seat] === 1) closer(hit, Stop.Shield, seat, -1, enterCircle(ray, x, y, stats.grazeR + beam.width));
  closer(hit, Stop.Core, seat, -1, enterCircle(ray, x, y, stats.hurtR + beam.width));
}

/** A colossus's live parts and its core (a protected one lets the beam pass). */
function meetBoss(w: World, beam: Beam, ray: Ray, seat: number, hit: Hit): void {
  const { m } = w;
  const form = FORMS[m.plFrame[seat]];
  if (m.plInvuln[seat] > 0 || enterCircle(ray, m.plX[seat], m.plY[seat], form.reach + beam.width) === MISS) return;
  const base = w.partBase(seat);
  const at: Vec = { x: 0, y: 0 };
  form.parts.forEach((part, k) => {
    if (m.ptHp[base + k] <= 0) return;
    partCenter(w, seat, k, at);
    closer(hit, Stop.Part, seat, k, enterCircle(ray, at.x, at.y, part.rad + beam.width));
  });
  closer(hit, Stop.BossCore, seat, -1, enterCircle(ray, m.plX[seat], m.plY[seat], form.coreR + beam.width));
}

/**
 * Finds what stops the beam first (ties go to the first found: lower seat, then the order above, then neutral units). A ray
 * that does nothing (`felt` false: a tell, a tick between pulses) passes through a cloaked pilot, so it can neither reveal it
 * nor betray where it is; only a pulse finds it (and the hit gives it away).
 */
function find(w: World, beam: Beam, ray: Ray, hit: Hit, felt: boolean): void {
  const { m } = w;
  for (let seat = 0; seat < w.seats; seat++) {
    if (!isFighting(w, seat) || m.plTeam[seat] === beam.team || (!felt && m.plCloak[seat] > 0)) continue;
    if (m.plForm[seat] === Form.Boss) meetBoss(w, beam, ray, seat, hit);
    else meetRobot(w, beam, ray, seat, hit);
  }
  for (let n = 0; n < w.cap.neutrals; n++) {
    if (m.nAlive[n] === 1) closer(hit, Stop.Neutral, -1, n, enterCircle(ray, m.nX[n], m.nY[n], NEUTRAL_DEFS[m.nType[n]].rad + beam.width));
  }
}

function cast(w: World, beam: Beam, x: number, y: number, angle: number, length: number, hit: Hit, felt: boolean): Ray {
  const c = fx.cos(angle);
  const s = fx.sin(angle);
  const ray: Ray = { x, y, c, s, length: Math.min(length, toRim(w, x, y, c, s)) };
  hit.at = ray.length + 1;
  find(w, beam, ray, hit, felt);
  if (hit.stop === Stop.None) hit.at = ray.length;
  return ray;
}

/** How far a beam from (x, y) along `angle` reaches, up to `length`, before something stops it. No effect: a tell, or a tick between pulses. */
export function traceBeam(w: World, beam: Beam, x: number, y: number, angle: number, length: number): number {
  const hit: Hit = { stop: Stop.None, seat: -1, index: -1, at: 0 };
  cast(w, beam, x, y, angle, length, hit, false);
  return hit.at;
}

/** A pulse: like traceBeam, and one pulse of the beam's damage lands on what stopped it. Returns how far it reached. */
export function fireBeam(w: World, beam: Beam, x: number, y: number, angle: number, length: number): number {
  const hit: Hit = { stop: Stop.None, seat: -1, index: -1, at: 0 };
  const ray = cast(w, beam, x, y, angle, length, hit, true);
  const hx = ray.x + fx.mul(ray.c, hit.at);
  const hy = ray.y + fx.mul(ray.s, hit.at);
  switch (hit.stop) {
    case Stop.Parry:
      cutBeam(w, hit.seat, hx, hy);
      break;
    case Stop.Bulwark:
      spendEnergy(w, hit.seat, beam.dmg * SHIELD_COST_PER_DAMAGE);
      earn(w, hit.seat, GAUGE_PER_ABSORB);
      w.emit(Ev.Absorb, hx, hy, hit.seat);
      break;
    case Stop.Shield:
      absorbShot(w, hit.seat, beam.dmg, beam.owner, hx, hy);
      break;
    case Stop.Core:
    case Stop.BossCore:
      damageShip(w, hit.seat, beam.dmg, beam.owner, DamageKind.Bullet);
      break;
    case Stop.Part:
      damagePart(w, hit.seat, hit.index, beam.dmg, beam.owner);
      break;
    case Stop.Neutral:
      damageNeutral(w, hit.index, beam.dmg, beam.owner);
      break;
    default:
  }
  return hit.at;
}
