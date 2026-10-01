import { fx } from '@metronome/engine';
import {
  Attack, AttackPhase, FORMS, Form, Frame, MAX_PARTS, MUZZLE, PartKind, Pattern, PRIMARY_WEAPONS, PRISM, Role, SHOT_DEFS, ShotFlag, isFighting,
  partCenter, podMuzzle, podReady,
} from '../sim/index.ts';
import type { Vec, World } from '../sim/index.ts';
import { to, type Point } from './tactics.ts';

/*
 * Dangers that are not bullets flying at the bot: where hostile lobbed shells will land, armed hostile mines, and the lines of
 * hostile beams, rails and the laser tells that show exactly where they will fire. The bot reads them the way a player does,
 * from what is drawn, and steps out of them like out of a bullet's path (nearer the middle and sooner weigh more).
 */

/** Room kept between the bot and a hazard's edge, world units. */
const HAZARD_MARGIN = 10;
/** A lobbed shell is heeded once it will land within this many ticks. */
const LOB_HEED_TICKS = 70;
/** How much less a hazard matters per tick until it bites (like a bullet's closest approach in bot.ts). */
const TIME_FALLOFF = 0.12;

export interface Avoidance extends Point {
  /** Ticks until the soonest danger reaches the bot. */
  soonest: number;
}

/**
 * Adds to `out` a push away from every hazard that threatens the bot: `coreR` is what must stay out of blasts and beams, `bodyR`
 * what sets off mines (world units).
 */
export function avoidHazards(w: World, seat: number, me: Point, coreR: number, bodyR: number, out: Avoidance): void {
  const { m } = w;
  const team = m.plTeam[seat];
  for (let p = 0; p < w.cap.projectiles; p++) {
    if (m.pAlive[p] !== 1 || m.pTeam[p] === team) continue;
    const def = SHOT_DEFS[m.pDef[p]];
    if ((def.flags & ShotFlag.Lob) !== 0 && def.blastR > 0) {
      const left = (m.pFuse[p] > 0 ? m.pFuse[p] : def.life) - m.pAge[p];
      if (left > LOB_HEED_TICKS) continue;
      const heading = fx.toRadians(m.pAng[p]);
      const travel = to(m.pSpd[p]) * left;
      circle(out, me, to(m.pX[p]) + Math.cos(heading) * travel, to(m.pY[p]) + Math.sin(heading) * travel, to(def.blastR) + coreR, left);
    } else if ((def.flags & ShotFlag.Proximity) !== 0) {
      circle(out, me, to(m.pX[p]), to(m.pY[p]), to(def.trigger) + bodyR, Math.max(0, def.arm - m.pAge[p]));
    }
  }
  for (let s = 0; s < w.seats; s++) {
    if (!isFighting(w, s) || m.plTeam[s] === team) continue;
    if (m.plForm[s] === Form.Normal && m.plFrame[s] === Frame.Prism) prismLines(w, s, me, coreR, out);
    else if (m.plForm[s] === Form.Boss) bossLines(w, s, me, coreR, out);
  }
}

/** PRISM's beam (its tell and the beam itself, heeded to its full reach: where it stops now may be the bot) and its lance tell. */
function prismLines(w: World, s: number, me: Point, coreR: number, out: Avoidance): void {
  const { m } = w;
  const muzzle = to(MUZZLE);
  const x = to(m.plX[s]);
  const y = to(m.plY[s]);
  if (m.plBeam[s] > 0) {
    const angle = fx.toRadians(m.plBeamAng[s]);
    const ticks = Math.max(0, PRISM.beam.tell + 1 - m.plBeam[s]);
    line(out, me, x + Math.cos(angle) * muzzle, y + Math.sin(angle) * muzzle, angle, to(PRIMARY_WEAPONS[Frame.Prism].reach), to(PRISM.beam.width) + coreR, ticks);
  }
  if (m.plLance[s] > 0) {
    const angle = fx.toRadians(m.plLanceAng[s]);
    line(out, me, x + Math.cos(angle) * muzzle, y + Math.sin(angle) * muzzle, angle, to(PRISM.lance.length), to(PRISM.lance.width) + coreR, m.plLance[s]);
  }
}

const pod: Vec = { x: 0, y: 0 };
const center: Vec = { x: 0, y: 0 };

/**
 * A colossus's beam attacks: along each firing pod's barrel (or out from the core, for a wheel), told through the wind-up. The
 * whole length is heeded: where the beam stops now (ptBeamLen) may be the bot itself.
 */
function bossLines(w: World, s: number, me: Point, coreR: number, out: Avoidance): void {
  const { m } = w;
  const attack = m.plAtk[s];
  const phase = m.plAtkPhase[s];
  if (attack === Attack.None || (phase !== AttackPhase.Windup && phase !== AttackPhase.Release)) return;
  const form = FORMS[m.plFrame[s]];
  const def = attack === Attack.Salvo ? form.salvo : attack === Attack.Siege ? form.siege : form.ultima;
  if (def.pattern !== Pattern.Beam && def.pattern !== Pattern.Wheel) return;
  const role = attack === Attack.Salvo ? Role.Salvo : attack === Attack.Siege ? Role.Siege : Role.Ultima;
  const base = s * MAX_PARTS;
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
    line(out, me, to(pod.x), to(pod.y), angle, to(def.length), to(def.width) + coreR, ticks);
  }
}

function circle(out: Avoidance, me: Point, cx: number, cy: number, radius: number, ticks: number): void {
  const dx = me.x - cx;
  const dy = me.y - cy;
  const need = radius + HAZARD_MARGIN;
  const d = Math.hypot(dx, dy);
  if (d >= need) return;
  const weight = (need - d) / need / (1 + ticks * TIME_FALLOFF);
  out.soonest = Math.min(out.soonest, ticks);
  // Dead in the middle every way out is as good: take +x.
  if (d < 0.001) {
    out.x += weight;
    return;
  }
  out.x += (dx / d) * weight;
  out.y += (dy / d) * weight;
}

function line(out: Avoidance, me: Point, x: number, y: number, angle: number, length: number, halfWidth: number, ticks: number): void {
  const ux = Math.cos(angle);
  const uy = Math.sin(angle);
  const rx = me.x - x;
  const ry = me.y - y;
  const along = rx * ux + ry * uy;
  if (along < 0 || along > length) return;
  const across = ry * ux - rx * uy;
  const need = halfWidth + HAZARD_MARGIN;
  const d = Math.abs(across);
  if (d >= need) return;
  const weight = (need - d) / need / (1 + ticks * TIME_FALLOFF);
  out.soonest = Math.min(out.soonest, ticks);
  const side = across >= 0 ? 1 : -1;
  out.x += -uy * side * weight;
  out.y += ux * side * weight;
}
