import { fx } from '@metronome/engine';
import { Button, GAUNTLET, MUZZLE, ReturnMode, SHOT_DEFS, ShotFlag, W, canUseAlt, dodging } from '../sim/index.ts';
import type { ShotDef, World } from '../sim/index.ts';
import { inPrimaryReach, leadTicks, mayFire, to, type BotSense, type Point, type RobotTactics, type Target } from './tactics.ts';

/** GAUNTLET brawls this close, well inside its knuckles' reach. */
const BRAWL_RANGE = 130;
/** It rocket-punches a pilot who will be within this share of the fist's reach when the fist gets there... */
const ROCKET_REACH_SHARE = 0.9;
/** ...with this much energy to spare on top of the punch, unless the target's shield just broke. */
const ROCKET_SPARE_ENERGY = 80;
/** A pilot this close in its boost's dodge would let the fist pass through: the punch waits for it. */
const DODGE_WAIT_RANGE = 60;
/**
 * While the fist flies home it strikes again (never what it struck last): GAUNTLET steps onto the line from the fist through
 * its target, beyond the target (at least this far from it), so the fist comes home through the target. Worth it only while
 * the fist is still this much farther away than the target.
 */
const RETURN_STAND_MIN = 70;
const RETURN_LEAD = 40;
/**
 * Knockback shoves along the shot's heading: with a hazard this close behind the target (the storm edge or the rim, a mine or
 * a landing shell of GAUNTLET's own side), GAUNTLET circles to the target's far side so its knuckles push the target into it.
 */
const HAZARD_REACH = 110;
/** A shell of its side counts as a hazard once it lands within this many ticks. */
const LOB_SOON_TICKS = 45;
/** It bothers with either only in a fight this close. */
const ENGAGE_RANGE = 260;
/** Close enough to where it wants to stand: the shared strafing takes over. */
const ARRIVED = 16;

/** How far the rocket fist has flown after each tick of its flight out (index = ticks), its speed growing as in the simulation. */
function outboundFlight(def: ShotDef): number[] {
  const flown = [0];
  let speed = to(def.spd);
  let distance = 0;
  for (let tick = 1; tick <= def.returnAt; tick++) {
    speed = Math.min(to(def.maxSpd), speed + to(def.acc));
    distance += speed;
    flown.push(distance);
  }
  return flown;
}

const FLIGHT = outboundFlight(GAUNTLET.rocket.fist);
/** From GAUNTLET's centre to where the fist turns for home. */
const ROCKET_REACH = to(MUZZLE) + FLIGHT[FLIGHT.length - 1];

/** Ticks the rocket fist needs to fly `distance` from the muzzle (its whole flight out, if it is farther). */
function flightTicks(distance: number): number {
  let ticks = 0;
  while (ticks < FLIGHT.length - 1 && FLIGHT[ticks] < distance) ticks++;
  return ticks;
}

interface Fist extends Point {
  readonly returning: boolean;
  /** pLast: the seat it struck last, which it will not strike again. */
  readonly last: number;
}

/** The bot's own rocket fist while it is out (a returning shot it threw itself), or null when it is home. */
function rocketFist(w: World, seat: number): Fist | null {
  const { m } = w;
  for (let p = 0; p < w.cap.projectiles; p++) {
    if (m.pAlive[p] !== 1 || m.pOwner[p] !== seat || m.pPart[p] !== 0 || (SHOT_DEFS[m.pDef[p]].flags & ShotFlag.Return) === 0) continue;
    return { x: to(m.pX[p]), y: to(m.pY[p]), returning: m.pMode[p] === ReturnMode.Returning, last: m.pLast[p] };
  }
  return null;
}

/** Ticks the rocket fist would take to reach the target where it stands now (the lead for the punch). */
function rocketLead(sense: BotSense): number {
  return flightTicks(sense.range - to(MUZZLE));
}

/** The rocket punch is worth throwing now: the fist is home, the target will be in its reach, and energy allows. */
function rocketReady(sense: BotSense): boolean {
  const { w, seat, me, target, range } = sense;
  if (!target.ship || !canUseAlt(w, seat)) return false;
  if (range < DODGE_WAIT_RANGE && dodging(w, target.seat)) return false;
  const ticks = rocketLead(sense) * sense.skill;
  const there = Math.hypot(target.x + target.vx * ticks - me.x, target.y + target.vy * ticks - me.y);
  if (there > ROCKET_REACH * ROCKET_REACH_SHARE) return false;
  return sense.exposed || w.m.plEnergy[seat] >= GAUNTLET.rocket.cost + ROCKET_SPARE_ENERGY;
}

/** A unit vector from `me` toward (x, y), or null once within ARRIVED of it. */
function toward(me: Point, x: number, y: number): Point | null {
  const dx = x - me.x;
  const dy = y - me.y;
  const distance = Math.hypot(dx, dy);
  return distance < ARRIVED ? null : { x: dx / distance, y: dy / distance };
}

/** Where to stand so the returning fist flies through the target on its way home, or null when that is not worth it. */
function returnPath(sense: BotSense, fist: Fist): Point | null {
  const { me, target, range } = sense;
  if (!fist.returning || fist.last === target.seat) return null;
  const fromFist = Math.hypot(target.x - fist.x, target.y - fist.y);
  if (fromFist < 1 || Math.hypot(fist.x - me.x, fist.y - me.y) < range + RETURN_LEAD) return null;
  const stand = Math.max(RETURN_STAND_MIN, Math.min(range, BRAWL_RANGE));
  return toward(me, target.x + ((target.x - fist.x) / fromFist) * stand, target.y + ((target.y - fist.y) / fromFist) * stand);
}

/**
 * The direction from the target to the nearest hazard it could be shoved into, within HAZARD_REACH: the edge of the safe
 * zone (the storm in sudden death, else the solid rim, where a pinned pilot has no room to dodge), an armed mine of the bot's
 * side, or where a shell of its side is about to land. Null when there is none.
 */
function hazardBehind(w: World, seat: number, target: Target): Point | null {
  const { m } = w;
  const team = m.plTeam[seat];
  let best = HAZARD_REACH;
  let found: Point | null = null;
  const fromCentre = Math.hypot(target.x, target.y);
  const edge = to(m.world[W.SafeR]) - fromCentre;
  if (fromCentre > 1 && edge < best) {
    best = edge;
    found = { x: target.x / fromCentre, y: target.y / fromCentre };
  }
  for (let p = 0; p < w.cap.projectiles; p++) {
    if (m.pAlive[p] !== 1 || m.pTeam[p] !== team) continue;
    const def = SHOT_DEFS[m.pDef[p]];
    let x = to(m.pX[p]);
    let y = to(m.pY[p]);
    if ((def.flags & ShotFlag.Lob) !== 0 && def.blastR > 0) {
      const left = (m.pFuse[p] > 0 ? m.pFuse[p] : def.life) - m.pAge[p];
      if (left > LOB_SOON_TICKS) continue;
      const heading = fx.toRadians(m.pAng[p]);
      x += Math.cos(heading) * to(m.pSpd[p]) * left;
      y += Math.sin(heading) * to(m.pSpd[p]) * left;
    } else if ((def.flags & ShotFlag.Proximity) === 0 || m.pAge[p] < def.arm) continue;
    const dx = x - target.x;
    const dy = y - target.y;
    const distance = Math.hypot(dx, dy);
    if (distance > 1 && distance < best) {
      best = distance;
      found = { x: dx / distance, y: dy / distance };
    }
  }
  return found;
}

/**
 * GAUNTLET, the super robot brawler: closes to brawling range and jabs with its knuckles; rocket-punches when its fist is home
 * and the target will be in reach (leading it), then steps onto the fist's way home so it strikes again; and fights from the
 * side that shoves its target into the nearest hazard.
 */
export function createGauntletTactics(): RobotTactics {
  let punching = false;
  return {
    range: BRAWL_RANGE,
    buttons(sense: BotSense): number {
      let buttons = 0;
      if (inPrimaryReach(sense) && mayFire(sense)) buttons |= Button.Fire;
      punching = rocketReady(sense);
      if (punching) buttons |= Button.Alt;
      return buttons;
    },
    aim: (sense) => (punching ? leadTicks(sense, rocketLead(sense)) : sense.aim),
    move(sense: BotSense): Point | null {
      const { w, seat, target } = sense;
      if (!target.ship || sense.range > ENGAGE_RANGE) return null;
      const fist = rocketFist(w, seat);
      const homeward = fist === null ? null : returnPath(sense, fist);
      if (homeward !== null) return homeward;
      const hazard = hazardBehind(w, seat, target);
      if (hazard === null) return null;
      return toward(sense.me, target.x - hazard.x * BRAWL_RANGE, target.y - hazard.y * BRAWL_RANGE);
    },
  };
}
