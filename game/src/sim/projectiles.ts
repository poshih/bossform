import { fx } from '@metronome/engine';
import { ARTILLERY_CONE, Form, PROJECTILE_RIM_MARGIN, SEEK_RANGE } from './constants.ts';
import { Ev } from './events.ts';
import { inside, radial, span2, within } from './geometry.ts';
import type { Vec } from './geometry.ts';
import { W } from './layout.ts';
import { isFighting, nearestHostile, pickupRadius, targetable } from './query.ts';
import { SHOT_DEFS, ShotFlag } from './shots.ts';
import type { ShotDef } from './shots.ts';
import type { World } from './world.ts';

/** Who fired: recorded on every projectile so hits, kills and the boss-attack rules can be attributed. */
export interface Shooter {
  /** Seat, or NO_SEAT for neutral units. */
  readonly owner: number;
  readonly team: number;
  readonly attack: number;
  /** Boss-form part index, or -1. */
  readonly part: number;
}

/** Where a returning shot is (pMode): flying out, or on its way home. */
export const ReturnMode = { Outbound: 0, Returning: 1 } as const;
/** pLast of a shot that has struck nothing yet. */
const STRUCK_NOTHING = -1;
/** pLast of a returning shot that last struck neutral unit `n` (a seat is itself, nothing is -1). */
export const struckNeutral = (n: number): number => -2 - n;

/**
 * Creates one projectile. The speed rule was enforced when the ShotDef was authored (see shots.ts). A returning shot thrown by
 * a pod takes the pod's weapon away (ptAway) until the shot is gone (World.freeProjectile).
 */
export function launch(w: World, who: Shooter, def: ShotDef, x: number, y: number, angle: number): number {
  const i = w.allocProjectile();
  if (i < 0) {
    w.m.world[W.Dropped]++;
    return -1;
  }
  const { m } = w;
  m.pAlive[i] = 1;
  m.pDef[i] = def.id;
  m.pOwner[i] = who.owner;
  m.pTeam[i] = who.team;
  m.pAttack[i] = who.attack;
  m.pPart[i] = who.part + 1;
  m.pX[i] = x;
  m.pY[i] = y;
  m.pAng[i] = angle & fx.ANGLE_MASK;
  m.pSpd[i] = def.spd;
  m.pAge[i] = 0;
  m.pGraze[i] = -1;
  m.pMode[i] = ReturnMode.Outbound;
  m.pLast[i] = STRUCK_NOTHING;
  m.pFuse[i] = 0;
  if (who.part >= 0 && (def.flags & ShotFlag.Return) !== 0) m.ptAway[w.partBase(who.owner) + who.part] = 1;
  return i;
}

/** `count` shots spread evenly across `spread` (total angle), centred on `center`. */
export function fan(w: World, who: Shooter, def: ShotDef, x: number, y: number, center: number, count: number, spread: number): void {
  if (count === 1) {
    launch(w, who, def, x, y, center);
    return;
  }
  const start = center - (spread >> 1);
  for (let k = 0; k < count; k++) launch(w, who, def, x, y, start + Math.floor((spread * k) / (count - 1)));
}

/** `count` shots evenly around a full circle, rotated by `offset`. */
export function ring(w: World, who: Shooter, def: ShotDef, x: number, y: number, count: number, offset: number): void {
  for (let k = 0; k < count; k++) launch(w, who, def, x, y, offset + Math.floor((fx.ANGLE_FULL * k) / count));
}

/** Who fired projectile `p`: its bursts and blasts belong to the same shooter. */
export function shooterOf(w: World, p: number): Shooter {
  const { m } = w;
  return { owner: m.pOwner[p], team: m.pTeam[p], attack: m.pAttack[p], part: m.pPart[p] - 1 };
}

/**
 * Lobs a shell (ShotFlag.Lob) from (x, y) at the ground point (tx, ty), kept inside the arena and within the shell's reach. It
 * flies straight over everything, at the speed that lands it exactly there after pFuse ticks, and detonates where it lands
 * (blast.ts): its landing point and blast are known from launch.
 */
export function lob(w: World, who: Shooter, def: ShotDef, x: number, y: number, tx: number, ty: number): number {
  let px = tx;
  let py = ty;
  if (!inside(px, py, w.arenaR)) {
    const out = radial(px, py);
    px = fx.mul(fx.div(px, out), w.arenaR);
    py = fx.mul(fx.div(py, out), w.arenaR);
  }
  let dx = px - x;
  let dy = py - y;
  let distance = radial(dx, dy);
  const reach = def.spd * def.life;
  if (distance > reach) {
    dx = fx.mulDiv(dx, reach, distance);
    dy = fx.mulDiv(dy, reach, distance);
    distance = reach;
  }
  const flight = Math.max(1, Math.ceil(distance / def.spd));
  const p = launch(w, who, def, x, y, fx.atan2(dy, dx));
  if (p < 0) return -1;
  w.m.pSpd[p] = Math.floor(distance / flight);
  w.m.pFuse[p] = flight;
  return p;
}

/** A line of `count` lobbed shells along `angle` from (x, y): the first lands `first` out, the rest `gap` apart, each later than the last. */
export function carpet(w: World, who: Shooter, def: ShotDef, x: number, y: number, angle: number, first: number, gap: number, count: number): void {
  const c = fx.cos(angle);
  const s = fx.sin(angle);
  for (let k = 0; k < count; k++) {
    const distance = first + gap * k;
    lob(w, who, def, x, y, x + fx.mul(c, distance), y + fx.mul(s, distance));
  }
}

/**
 * Where artillery firing from (x, y) along `facing` aims: at the nearest targetable ship not on `team` within `range` and within
 * ARTILLERY_CONE of `facing` (ties go to the lower seat), else at the point `range` out along `facing`.
 */
export function artilleryTarget(w: World, team: number, x: number, y: number, facing: number, range: number, out: Vec): void {
  const { m } = w;
  let best = -1;
  let bestD = Infinity;
  for (let seat = 0; seat < w.seats; seat++) {
    if (!targetable(w, seat) || m.plTeam[seat] === team) continue;
    const dx = m.plX[seat] - x;
    const dy = m.plY[seat] - y;
    if (!inside(dx, dy, range) || Math.abs(fx.angleDiff(facing, fx.atan2(dy, dx))) > ARTILLERY_CONE) continue;
    const d = span2(dx, dy);
    if (d < bestD) {
      bestD = d;
      best = seat;
    }
  }
  if (best >= 0) {
    out.x = m.plX[best];
    out.y = m.plY[best];
    return;
  }
  out.x = x + fx.mul(fx.cos(facing), range);
  out.y = y + fx.mul(fx.sin(facing), range);
}

/** A returning shot of `seat`'s is out (GAUNTLET's rocket punch waits for its fist to come home). */
export function hasReturning(w: World, seat: number): boolean {
  const { m } = w;
  for (let p = 0; p < w.cap.projectiles; p++) {
    if (m.pAlive[p] === 1 && m.pOwner[p] === seat && (SHOT_DEFS[m.pDef[p]].flags & ShotFlag.Return) !== 0) return true;
  }
  return false;
}

/**
 * A returning shot struck something, or was parried (`struck`: a seat, or struckNeutral(n)): on its way out it turns straight
 * round for home. It is not used up, and it never strikes the same thing twice in a row.
 */
export function turnBack(w: World, p: number, struck: number): void {
  const { m } = w;
  if (m.pMode[p] === ReturnMode.Outbound) {
    m.pMode[p] = ReturnMode.Returning;
    m.pAng[p] = (m.pAng[p] + fx.ANGLE_HALF) & fx.ANGLE_MASK;
  }
  m.pLast[p] = struck;
}

/** Projectile `p` starts over as `who`'s shot along `angle`, at its own speed: age 0, nothing grazed or struck yet (a parry). */
export function reissue(w: World, p: number, who: Shooter, angle: number): void {
  const { m } = w;
  m.pOwner[p] = who.owner;
  m.pTeam[p] = who.team;
  m.pAttack[p] = who.attack;
  m.pPart[p] = who.part + 1;
  m.pAng[p] = angle & fx.ANGLE_MASK;
  m.pAge[p] = 0;
  m.pGraze[p] = -1;
  m.pLast[p] = STRUCK_NOTHING;
}

function steer(w: World, p: number, def: ShotDef): void {
  const { m } = w;
  const target = nearestHostile(w, m.pX[p], m.pY[p], m.pTeam[p]);
  if (target < 0) return;
  const dx = m.plX[target] - m.pX[p];
  const dy = m.plY[target] - m.pY[p];
  if (within(dx, dy, SEEK_RANGE)) m.pAng[p] = fx.turnToward(m.pAng[p], fx.atan2(dy, dx), def.turn);
}

/**
 * Returning shot `p` still has a home: its owner is fighting and, if a pod threw it, is still the colossus that pod belongs to
 * (when the form ends, its weapons go with it). A shot without a home expires (blast.ts expireProjectiles).
 */
export function hasHome(w: World, p: number): boolean {
  const { m } = w;
  const owner = m.pOwner[p];
  return owner >= 0 && isFighting(w, owner) && (m.pPart[p] === 0 || m.plForm[owner] === Form.Boss);
}

/** A returning shot flies straight out until `returnAt` (or a strike, turnBack), then turns toward its owner by at most `turn` a tick. */
function home(w: World, p: number, def: ShotDef): void {
  const { m } = w;
  if (m.pMode[p] === ReturnMode.Outbound) {
    if (m.pAge[p] < def.returnAt) return;
    m.pMode[p] = ReturnMode.Returning;
  }
  if (!hasHome(w, p)) return;
  const owner = m.pOwner[p];
  m.pAng[p] = fx.turnToward(m.pAng[p], fx.atan2(m.plY[owner] - m.pY[p], m.plX[owner] - m.pX[p]), def.turn);
}

/** A returning shot on its way home has reached its owner's pickup radius: caught. */
function caught(w: World, p: number, def: ShotDef): boolean {
  const { m } = w;
  if (m.pMode[p] !== ReturnMode.Returning || !hasHome(w, p)) return false;
  const owner = m.pOwner[p];
  return within(m.plX[owner] - m.pX[p], m.plY[owner] - m.pY[p], pickupRadius(w, owner) + def.rad);
}

/**
 * Moves every projectile one tick along its (optionally accelerating / turning / seeking / homeward) heading; a returning shot
 * that reaches its owner is caught. Expiry is a second pass (blast.ts expireProjectiles): shrapnel born from a burst is created
 * at age 0 and neither moves nor collides until next tick, whatever slot it lands in.
 */
export function updateProjectiles(w: World): void {
  const { m } = w;
  const rim = w.arenaR + PROJECTILE_RIM_MARGIN;
  for (let p = 0; p < w.cap.projectiles; p++) {
    if (m.pAlive[p] !== 1) continue;
    const def = SHOT_DEFS[m.pDef[p]];
    const returning = (def.flags & ShotFlag.Return) !== 0;
    m.pAge[p]++;
    if ((def.flags & ShotFlag.Seek) !== 0) steer(w, p, def);
    else if (returning) home(w, p, def);
    else if (def.turn !== 0) m.pAng[p] = (m.pAng[p] + def.turn) & fx.ANGLE_MASK;
    if (m.pSpd[p] < def.maxSpd) m.pSpd[p] = Math.min(def.maxSpd, m.pSpd[p] + def.acc);
    m.pX[p] += fx.mul(fx.cos(m.pAng[p]), m.pSpd[p]);
    m.pY[p] += fx.mul(fx.sin(m.pAng[p]), m.pSpd[p]);
    if (returning && caught(w, p, def)) {
      w.emit(Ev.Catch, m.pX[p], m.pY[p], m.pOwner[p], m.pPart[p]);
      w.freeProjectile(p);
    } else if (!inside(m.pX[p], m.pY[p], rim)) w.freeProjectile(p);
  }
}

/** Removes every projectile without effect (round changes). */
export function clearProjectiles(w: World): void {
  for (let p = 0; p < w.cap.projectiles; p++) if (w.m.pAlive[p] === 1) w.freeProjectile(p);
}
