import { fx } from '@metronome/engine';
import {
  Attack, AttackPhase, BOSS_DRAIN_PER_TICK, Form, MAX_PARTS, MORPH_TICKS, REVERT_PROTECT_TICKS, ROOT_BRAKE,
} from './constants.ts';
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

function begin(w: World, seat: number, attack: number, timing: AttackTiming): void {
  const { m } = w;
  m.plGauge[seat] -= timing.cost;
  m.plAtk[seat] = attack;
  m.plAtkPhase[seat] = AttackPhase.Windup;
  m.plAtkTimer[seat] = timing.windup;
  m.plAtkSeq[seat] = 0;
  w.emit(Ev.Windup, m.plX[seat], m.plY[seat], seat, attack);
}

/** Ultima outranks the siege shot, which outranks the salvo. An attack is paid for in full when it starts. */
function tryStart(w: World, seat: number, form: FormDef, buttons: number): void {
  const { m } = w;
  const gauge = m.plGauge[seat];
  if ((buttons & Button.Ultima) !== 0 && m.plUltCd[seat] === 0 && gauge > form.ultima.cost) begin(w, seat, Attack.Ultima, form.ultima);
  else if ((buttons & Button.Alt) !== 0 && gauge > form.siege.cost && hasPod(w, seat, form, Role.Siege)) begin(w, seat, Attack.Siege, form.siege);
  else if ((buttons & Button.Fire) !== 0 && gauge > form.salvo.cost && hasPod(w, seat, form, Role.Salvo)) begin(w, seat, Attack.Salvo, form.salvo);
}

function shooter(w: World, seat: number, attack: number, part: number): Shooter {
  return { owner: seat, team: w.m.plTeam[seat], attack, part };
}

/** The ultima: live pods spiral shots outward while the core pulses rings; the machine cannot move. */
function barrage(w: World, seat: number, form: FormDef): void {
  const { m } = w;
  const ultima = form.ultima;
  const base = w.partBase(seat);
  const seq = m.plAtkSeq[seat];
  if (seq % ultima.interval === 0) {
    const spiral = Math.floor(seq / ultima.interval) * ultima.step;
    const at: Vec = { x: 0, y: 0 };
    form.parts.forEach((part, k) => {
      if (part.kind !== PartKind.Pod || (part.roles & Role.Ultima) === 0 || m.ptHp[base + k] <= 0) return;
      podMuzzle(w, seat, k, at);
      const who = shooter(w, seat, Attack.Ultima, k);
      for (let arm = 0; arm < ultima.arms; arm++) {
        launch(w, who, ultima.shot, at.x, at.y, m.ptAng[base + k] + spiral + Math.floor((fx.ANGLE_FULL * arm) / ultima.arms));
      }
    });
  }
  if (seq % ultima.ringEvery === 0) {
    const interleave = Math.floor(seq / ultima.ringEvery) % 2 === 0 ? 0 : Math.floor(fx.ANGLE_FULL / (2 * ultima.ringCount));
    ring(w, shooter(w, seat, Attack.Ultima, -1), ultima.ringShot, m.plX[seat], m.plY[seat], ultima.ringCount, interleave);
  }
  m.plAtkSeq[seat] = seq + 1;
  if (--m.plAtkTimer[seat] > 0) return;
  m.plAtkPhase[seat] = AttackPhase.Recovery;
  m.plAtkTimer[seat] = ultima.recovery;
  m.plUltCd[seat] = ultima.cooldown;
  form.parts.forEach((part, k) => {
    if (part.kind === PartKind.Pod && (part.roles & Role.Ultima) !== 0) m.ptHeat[base + k] = ultima.recovery;
  });
}

/** The wind-up is over: every live pod of the attack fires along its own current facing. */
function release(w: World, seat: number, form: FormDef): void {
  const { m } = w;
  const attack = m.plAtk[seat];
  const base = w.partBase(seat);
  w.emit(Ev.Release, m.plX[seat], m.plY[seat], seat, attack);
  if (attack === Attack.Ultima) {
    m.plAtkPhase[seat] = AttackPhase.Release;
    m.plAtkTimer[seat] = form.ultima.duration;
    m.plAtkSeq[seat] = 0;
    barrage(w, seat, form);
    return;
  }
  const volley = attack === Attack.Salvo ? form.salvo : form.siege;
  const role = attack === Attack.Salvo ? Role.Salvo : Role.Siege;
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
  m.plAtkPhase[seat] = AttackPhase.Recovery;
  m.plAtkTimer[seat] = volley.recovery;
}

function runAttack(w: World, seat: number, form: FormDef, buttons: number): void {
  const { m } = w;
  switch (m.plAtkPhase[seat]) {
    case AttackPhase.Idle:
      tryStart(w, seat, form, buttons);
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
  runAttack(w, seat, form, buttons);
  if (isRooted(m.plAtk[seat], m.plAtkPhase[seat])) drive(w, seat, 0, 0, 0, ROOT_BRAKE);
  else drive(w, seat, moveX, moveY, form.speed, form.accel);
  keepInside(w, seat, form.reach);
}
