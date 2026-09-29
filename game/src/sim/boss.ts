import { fx } from '@metronome/engine';
import {
  Attack, AttackPhase, BOSS_DRAIN_PER_TICK, Form, MAX_PARTS, MORPH_TICKS, REVERT_PROTECT_TICKS, ROOT_BRAKE,
} from './constants.ts';
import { stopBursts } from './boost.ts';
import { dropShield } from './energy.ts';
import { Ev } from './events.ts';
import { FORMS, PartKind, Role } from './forms.ts';
import type { AttackTiming, FormDef } from './forms.ts';
import type { Vec } from './geometry.ts';
import { Button } from './input.ts';
import { drive, keepInside } from './movement.ts';
import { fan, launch, ring } from './projectiles.ts';
import type { Shooter } from './projectiles.ts';
import { podMuzzle } from './query.ts';
import type { World } from './world.ts';

/** Rooted: braced against the recoil of a heavy charge, or pouring the whole reactor through the guns. */
function isRooted(attack: number, phase: number): boolean {
  return (phase === AttackPhase.Windup && attack !== Attack.Salvo) || phase === AttackPhase.Release;
}

/** Resets everything boss-form: parts gone, attacks idle, back to the normal form. */
export function clearBoss(w: World, seat: number): void {
  const { m } = w;
  const base = w.partBase(seat);
  for (let k = 0; k < MAX_PARTS; k++) {
    m.ptHp[base + k] = 0;
    m.ptFlash[base + k] = 0;
    m.ptHeat[base + k] = 0;
  }
  m.plForm[seat] = Form.Normal;
  m.plTimer[seat] = 0;
  m.plAtk[seat] = Attack.None;
  m.plAtkPhase[seat] = AttackPhase.Idle;
  m.plAtkTimer[seat] = 0;
  m.plAtkSeq[seat] = 0;
}

/** Begins the transformation: every part is restored to full health, and the pilot is safe while it unfolds. */
export function startMorph(w: World, seat: number): void {
  const { m } = w;
  const form = FORMS[m.plFrame[seat]];
  const base = w.partBase(seat);
  clearBoss(w, seat);
  dropShield(w, seat);
  stopBursts(w, seat);
  m.plForm[seat] = Form.Morph;
  m.plTimer[seat] = MORPH_TICKS;
  m.plInvuln[seat] = Math.max(m.plInvuln[seat], MORPH_TICKS);
  m.plUltCd[seat] = 0;
  m.plOrbit[seat] = 0;
  form.parts.forEach((part, k) => {
    m.ptHp[base + k] = part.hp;
    m.ptAng[base + k] = m.plBody[seat];
  });
  w.emit(Ev.MorphStart, m.plX[seat], m.plY[seat], seat);
}

export function updateMorph(w: World, seat: number): void {
  const { m } = w;
  drive(w, seat, 0, 0, 0, ROOT_BRAKE);
  if (--m.plTimer[seat] > 0) return;
  m.plForm[seat] = Form.Boss;
  w.emit(Ev.MorphDone, m.plX[seat], m.plY[seat], seat);
}

/** The fuel ran out: the colossus folds back into the robot, which keeps its health and gets a moment's protection. */
function endBoss(w: World, seat: number): void {
  const { m } = w;
  w.emit(Ev.BossEnd, m.plX[seat], m.plY[seat], seat);
  clearBoss(w, seat);
  m.plGauge[seat] = 0;
  m.plInvuln[seat] = Math.max(m.plInvuln[seat], REVERT_PROTECT_TICKS);
  m.plBody[seat] = m.plAim[seat];
}

function hasPod(w: World, seat: number, form: FormDef, role: number): boolean {
  const base = w.partBase(seat);
  return form.parts.some((part, k) => part.kind === PartKind.Pod && (part.roles & role) !== 0 && w.m.ptHp[base + k] > 0);
}

function timingOf(form: FormDef, attack: number): AttackTiming {
  switch (attack) {
    case Attack.Salvo:
      return form.salvo;
    case Attack.Siege:
      return form.siege;
    case Attack.Ultima:
      return form.ultima;
    default:
      throw new RangeError(`not a boss attack: ${attack}`);
  }
}

function roleOf(attack: number): number {
  return attack === Attack.Salvo ? Role.Salvo : attack === Attack.Siege ? Role.Siege : Role.Ultima;
}

/**
 * The least gauge, as it stands between ticks (what the HUD and bots read), that lets an attack start AND run to the end of
 * its recovery: its cost, plus every passive drain on the way (updateBoss drains before it runs the attack: the request
 * tick, each wind-up tick, the ultima's barrage after its first volley, each recovery tick), plus the last unit that keeps
 * the form alive. So the fuel can never run out mid wind-up (the tell never lies) and the recovery punish window happens.
 */
export function attackFuel(form: FormDef, attack: number): number {
  const timing = timingOf(form, attack);
  const barrage = attack === Attack.Ultima ? form.ultima.duration - 1 : 0;
  return timing.cost + BOSS_DRAIN_PER_TICK * (1 + timing.windup + barrage + timing.recovery) + 1;
}

/** Why a boss attack cannot start right now; None means it can. Checked in this order. */
export const AttackBlock = { None: 0, NotBoss: 1, NoPod: 2, Cooldown: 3, Fuel: 4, Busy: 5 } as const;

/** Everything an attack needs to start: a colossus, a live pod of its role, the ultima off cooldown, the fuel, and no attack in progress. */
function blockOf(w: World, seat: number, form: FormDef, attack: number, fuel: number): number {
  const { m } = w;
  if (m.plForm[seat] !== Form.Boss) return AttackBlock.NotBoss;
  if (!hasPod(w, seat, form, roleOf(attack))) return AttackBlock.NoPod;
  if (attack === Attack.Ultima && m.plUltCd[seat] !== 0) return AttackBlock.Cooldown;
  if (fuel < attackFuel(form, attack)) return AttackBlock.Fuel;
  if (m.plAtkPhase[seat] !== AttackPhase.Idle) return AttackBlock.Busy;
  return AttackBlock.None;
}

/**
 * What stops an attack from starting if it were pressed now (for the HUD and bots; the simulation applies the same rule).
 * Timers count down before the next decision, so an attack on cooldown may become possible one tick before this says so.
 */
export function attackBlocker(w: World, seat: number, attack: number): number {
  return blockOf(w, seat, FORMS[w.m.plFrame[seat]], attack, w.m.plGauge[seat]);
}

export function canStartAttack(w: World, seat: number, attack: number): boolean {
  return attackBlocker(w, seat, attack) === AttackBlock.None;
}

function begin(w: World, seat: number, attack: number, timing: AttackTiming): void {
  const { m } = w;
  m.plGauge[seat] -= timing.cost;
  m.plAtk[seat] = attack;
  m.plAtkPhase[seat] = AttackPhase.Windup;
  m.plAtkTimer[seat] = timing.windup;
  m.plAtkSeq[seat] = 0;
  w.emit(Ev.Windup, m.plX[seat], m.plY[seat], seat, attack);
}

/**
 * Ultima outranks the siege shot, which outranks the salvo. An attack is paid for in full when it starts. `fuel` is the gauge
 * before this tick's drain, the value everyone saw (see attackFuel).
 */
function tryStart(w: World, seat: number, form: FormDef, buttons: number, fuel: number): void {
  if ((buttons & Button.Ultima) !== 0 && blockOf(w, seat, form, Attack.Ultima, fuel) === AttackBlock.None) begin(w, seat, Attack.Ultima, form.ultima);
  else if ((buttons & Button.Alt) !== 0 && blockOf(w, seat, form, Attack.Siege, fuel) === AttackBlock.None) begin(w, seat, Attack.Siege, form.siege);
  else if ((buttons & Button.Fire) !== 0 && blockOf(w, seat, form, Attack.Salvo, fuel) === AttackBlock.None) begin(w, seat, Attack.Salvo, form.salvo);
}

function shooter(w: World, seat: number, attack: number, part: number): Shooter {
  return { owner: seat, team: w.m.plTeam[seat], attack, part };
}

/** The attack is over (or has nothing left to fire with): recovery begins, and an ultima starts its cooldown. */
function toRecovery(w: World, seat: number, form: FormDef, attack: number): void {
  const { m } = w;
  m.plAtkPhase[seat] = AttackPhase.Recovery;
  m.plAtkTimer[seat] = timingOf(form, attack).recovery;
  if (attack === Attack.Ultima) m.plUltCd[seat] = form.ultima.cooldown;
}

/**
 * The ultima: every live ultima pod spirals shots outward and, every `ringEvery` ticks, fires a ring from its own muzzle;
 * the machine cannot move. Each pod keeps a fixed share of the ring's directions (its ordinal among the form's ultima pods),
 * so the pods interleave into one dense ring, and a destroyed pod leaves its gaps. When no ultima pod is left, it stops.
 */
function barrage(w: World, seat: number, form: FormDef): void {
  const { m } = w;
  const ultima = form.ultima;
  const base = w.partBase(seat);
  if (!hasPod(w, seat, form, Role.Ultima)) {
    toRecovery(w, seat, form, Attack.Ultima);
    return;
  }
  const seq = m.plAtkSeq[seat];
  const spiral = seq % ultima.interval === 0;
  const ringTick = seq % ultima.ringEvery === 0;
  const pods = form.ultimaPods;
  const directions = ultima.ringPerPod * pods.length;
  const ringAlternate = Math.floor(seq / ultima.ringEvery) % 2 === 0 ? 0 : Math.floor(fx.ANGLE_FULL / (2 * directions));
  const at: Vec = { x: 0, y: 0 };
  pods.forEach((k, ordinal) => {
    if (m.ptHp[base + k] <= 0) return;
    const who = shooter(w, seat, Attack.Ultima, k);
    const facing = m.ptAng[base + k];
    podMuzzle(w, seat, k, at);
    if (spiral) {
      const turn = Math.floor(seq / ultima.interval) * ultima.step;
      for (let arm = 0; arm < ultima.arms; arm++) launch(w, who, ultima.shot, at.x, at.y, facing + turn + Math.floor((fx.ANGLE_FULL * arm) / ultima.arms));
    }
    if (ringTick) {
      const share = Math.floor((fx.ANGLE_FULL * ordinal) / directions);
      ring(w, who, ultima.ringShot, at.x, at.y, ultima.ringPerPod, facing + share + ringAlternate);
      w.emit(Ev.PodFire, at.x, at.y, seat, k);
    }
  });
  m.plAtkSeq[seat] = seq + 1;
  if (--m.plAtkTimer[seat] > 0) return;
  toRecovery(w, seat, form, Attack.Ultima);
  pods.forEach((k) => {
    if (m.ptHp[base + k] > 0) m.ptHeat[base + k] = ultima.recovery;
  });
}

/**
 * The wind-up is over: every live pod of the attack fires along its own current facing. If every pod it needed was destroyed
 * during the wind-up, nothing is released (the energy stays spent) and the machine goes straight into its recovery.
 */
function release(w: World, seat: number, form: FormDef): void {
  const { m } = w;
  const attack = m.plAtk[seat];
  const base = w.partBase(seat);
  const role = roleOf(attack);
  if (!hasPod(w, seat, form, role)) {
    toRecovery(w, seat, form, attack);
    return;
  }
  w.emit(Ev.Release, m.plX[seat], m.plY[seat], seat, attack);
  if (attack === Attack.Ultima) {
    m.plAtkPhase[seat] = AttackPhase.Release;
    m.plAtkTimer[seat] = form.ultima.duration;
    m.plAtkSeq[seat] = 0;
    barrage(w, seat, form);
    return;
  }
  const volley = attack === Attack.Salvo ? form.salvo : form.siege;
  const at: Vec = { x: 0, y: 0 };
  form.parts.forEach((part, k) => {
    if (part.kind !== PartKind.Pod || (part.roles & role) === 0 || m.ptHp[base + k] <= 0) return;
    const facing = m.ptAng[base + k];
    podMuzzle(w, seat, k, at);
    fan(w, shooter(w, seat, attack, k), volley.shot, at.x, at.y, facing, volley.count, volley.spread);
    m.ptHeat[base + k] = volley.recovery;
    w.emit(Ev.PodFire, at.x, at.y, seat, k);
    if (attack === Attack.Siege) {
      m.plVX[seat] -= fx.mul(fx.cos(facing), form.siege.recoil);
      m.plVY[seat] -= fx.mul(fx.sin(facing), form.siege.recoil);
    }
  });
  toRecovery(w, seat, form, attack);
}

function runAttack(w: World, seat: number, form: FormDef, buttons: number, fuel: number): void {
  const { m } = w;
  switch (m.plAtkPhase[seat]) {
    case AttackPhase.Idle:
      tryStart(w, seat, form, buttons, fuel);
      break;
    case AttackPhase.Windup:
      if (--m.plAtkTimer[seat] <= 0) release(w, seat, form);
      break;
    case AttackPhase.Release:
      barrage(w, seat, form);
      break;
    default:
      if (--m.plAtkTimer[seat] <= 0) {
        m.plAtk[seat] = Attack.None;
        m.plAtkPhase[seat] = AttackPhase.Idle;
      }
  }
}

/**
 * One tick of the colossus. Everything is slow and heavy: the body turns slowly, each pod swings toward the aim
 * at its own (slower for bigger mounts) rate, acceleration is a fraction of the robot's, and every attack winds
 * up, releases and recovers. Fuel burns steadily; at zero the form ends.
 */
export function updateBoss(w: World, seat: number, buttons: number, moveX: number, moveY: number): void {
  const { m } = w;
  const form = FORMS[m.plFrame[seat]];
  const base = w.partBase(seat);
  const fuel = m.plGauge[seat];
  m.plGauge[seat] -= BOSS_DRAIN_PER_TICK;
  if (m.plGauge[seat] <= 0) {
    endBoss(w, seat);
    return;
  }
  m.plBody[seat] = fx.turnToward(m.plBody[seat], m.plAim[seat], form.bodyTurn);
  m.plOrbit[seat] = (m.plOrbit[seat] + form.orbitTurn) & fx.ANGLE_MASK;
  form.parts.forEach((part, k) => {
    if (m.ptFlash[base + k] > 0) m.ptFlash[base + k]--;
    if (m.ptHeat[base + k] > 0) m.ptHeat[base + k]--;
    if (part.kind === PartKind.Pod && m.ptHp[base + k] > 0) m.ptAng[base + k] = fx.turnToward(m.ptAng[base + k], m.plAim[seat], part.turn);
  });
  runAttack(w, seat, form, buttons, fuel);
  if (isRooted(m.plAtk[seat], m.plAtkPhase[seat])) drive(w, seat, 0, 0, 0, ROOT_BRAKE);
  else drive(w, seat, moveX, moveY, form.speed, form.accel);
  keepInside(w, seat, form.reach);
}
