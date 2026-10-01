import { fx } from '@metronome/engine';
import {
  Attack, AttackPhase, BOSS_DRAIN_PER_TICK, Form, MORPH_TICKS, REVERT_PROTECT_TICKS, ROOT_BRAKE,
} from './constants.ts';
import { fireBeam, traceBeam } from './beams.ts';
import type { Beam } from './beams.ts';
import { stopBursts } from './boost.ts';
import { dropShield } from './energy.ts';
import { BeamKind, Ev } from './events.ts';
import { FORMS, PartKind, Pattern, Role } from './forms.ts';
import type { ArtilleryAttack, AttackTiming, BombardUltima, FormDef, SalvoDef, UltimaDef, WheelUltima } from './forms.ts';
import type { Vec } from './geometry.ts';
import { Button } from './input.ts';
import { clearKit } from './kit.ts';
import { drive, keepInside } from './movement.ts';
import { clearBoss } from './parts.ts';
import { artilleryTarget, carpet, fan, launch, lob, ring } from './projectiles.ts';
import type { Shooter } from './projectiles.ts';
import { partCenter, podMuzzle, podReady } from './query.ts';
import type { World } from './world.ts';

/** Rooted: braced against the recoil of a heavy charge, or pouring the whole reactor through the guns. */
function isRooted(attack: number, phase: number): boolean {
  return (phase === AttackPhase.Windup && attack !== Attack.Salvo) || phase === AttackPhase.Release;
}

/**
 * Begins the transformation: every part is restored to full health, and the pilot is safe while it unfolds. The robot's kit
 * stops (a charge, a spin, a parry, a beam, a lance) and a cloak ends.
 */
export function startMorph(w: World, seat: number): void {
  const { m } = w;
  const form = FORMS[m.plFrame[seat]];
  const base = w.partBase(seat);
  clearBoss(w, seat);
  clearKit(w, seat);
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

/** The colossus has a live pod of `role`. */
function hasPod(w: World, seat: number, form: FormDef, role: number): boolean {
  const base = w.partBase(seat);
  return form.parts.some((part, k) => part.kind === PartKind.Pod && (part.roles & role) !== 0 && w.m.ptHp[base + k] > 0);
}

/** The colossus has a pod of `role` that can fire right now (live, its weapon not away: query.ts podReady). */
function hasReadyPod(w: World, seat: number, form: FormDef, role: number): boolean {
  return form.parts.some((part, k) => part.kind === PartKind.Pod && (part.roles & role) !== 0 && podReady(w, seat, k));
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

/** The salvo's or the siege shot's release. */
function releaseOf(form: FormDef, attack: number): SalvoDef {
  return attack === Attack.Salvo ? form.salvo : form.siege;
}

/** Ticks an attack spends releasing: the ultima's barrage and a beam's sweep last; any other release is one tick. */
function releaseTicks(form: FormDef, attack: number): number {
  if (attack === Attack.Ultima) return form.ultima.duration;
  const release = releaseOf(form, attack);
  return release.pattern === Pattern.Beam ? release.duration : 1;
}

/**
 * The least gauge, as it stands between ticks (what the HUD and bots read), that lets an attack start AND run to the end of
 * its recovery: its cost, plus every passive drain on the way (updateBoss drains before it runs the attack: the request
 * tick, each wind-up tick, each release tick after the first (the ultima's barrage, a beam's sweep), each recovery tick),
 * plus the last unit that keeps the form alive. So the fuel can never run out mid wind-up (the tell never lies) and the
 * recovery punish window happens.
 */
export function attackFuel(form: FormDef, attack: number): number {
  const timing = timingOf(form, attack);
  return timing.cost + BOSS_DRAIN_PER_TICK * (1 + timing.windup + (releaseTicks(form, attack) - 1) + timing.recovery) + 1;
}

/**
 * Why a boss attack cannot start right now; None means it can. Checked in this order: NotBoss, NoPod (no live pod of its role),
 * Away (every live pod of its role has its weapon away: a returning shot it threw is still out), Cooldown, Fuel, Busy.
 */
export const AttackBlock = { None: 0, NotBoss: 1, NoPod: 2, Cooldown: 3, Fuel: 4, Busy: 5, Away: 6 } as const;

/**
 * Everything an attack needs to start: a colossus, a live pod of its role with its weapon at hand, the ultima off cooldown, the
 * fuel, and no attack in progress.
 */
function blockOf(w: World, seat: number, form: FormDef, attack: number, fuel: number): number {
  const { m } = w;
  const role = roleOf(attack);
  if (m.plForm[seat] !== Form.Boss) return AttackBlock.NotBoss;
  if (!hasPod(w, seat, form, role)) return AttackBlock.NoPod;
  if (!hasReadyPod(w, seat, form, role)) return AttackBlock.Away;
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

/** A beam fired by one of `seat`'s pods. */
function podBeam(w: World, seat: number, width: number, dmg: number): Beam {
  return { owner: seat, team: w.m.plTeam[seat], width, dmg };
}

/** An artillery volley from one pod: the first shell at its target, the rest evenly around it on a circle turned at random. */
function artillery(w: World, who: Shooter, attack: ArtilleryAttack, at: Vec, facing: number): void {
  const target: Vec = { x: 0, y: 0 };
  artilleryTarget(w, who.team, at.x, at.y, facing, attack.range, target);
  lob(w, who, attack.shell, at.x, at.y, target.x, target.y);
  const around = attack.count - 1;
  if (around === 0) return;
  const turn = w.rng.angle();
  for (let n = 0; n < around; n++) {
    const angle = turn + Math.floor((fx.ANGLE_FULL * n) / around);
    lob(w, who, attack.shell, at.x, at.y, target.x + fx.mul(fx.cos(angle), attack.radius), target.y + fx.mul(fx.sin(angle), attack.radius));
  }
}

/** A bombardment volley from one pod: `count` shells lobbed at random points within `radius` of its target (evenly over the disc). */
function bombard(w: World, who: Shooter, ultima: BombardUltima, at: Vec, facing: number): void {
  const target: Vec = { x: 0, y: 0 };
  artilleryTarget(w, who.team, at.x, at.y, facing, ultima.range, target);
  for (let n = 0; n < ultima.count; n++) {
    const angle = w.rng.angle();
    const distance = fx.mul(ultima.radius, fx.sqrt(w.rng.fixed()));
    lob(w, who, ultima.shell, at.x, at.y, target.x + fx.mul(fx.cos(angle), distance), target.y + fx.mul(fx.sin(angle), distance));
  }
}

/**
 * A wheel spoke: ultima pod `k` beams outward, from its muzzle along the line from the core through the pod (so the spokes
 * turn with the body, or the orbit), pulsing on the barrage's first tick and every `every` ticks after.
 */
function spoke(w: World, seat: number, k: number, ultima: WheelUltima, seq: number): void {
  const { m } = w;
  const center: Vec = { x: 0, y: 0 };
  partCenter(w, seat, k, center);
  const angle = fx.atan2(center.y - m.plY[seat], center.x - m.plX[seat]);
  const muzzle = FORMS[m.plFrame[seat]].parts[k].muzzle;
  const x = center.x + fx.mul(fx.cos(angle), muzzle);
  const y = center.y + fx.mul(fx.sin(angle), muzzle);
  const beam = podBeam(w, seat, ultima.width, ultima.dmg);
  if (seq === 0) w.emit(Ev.BeamOn, x, y, seat, k + 1, BeamKind.Boss);
  m.ptBeamLen[w.partBase(seat) + k] = seq % ultima.every === 0 ? fireBeam(w, beam, x, y, angle, ultima.length) : traceBeam(w, beam, x, y, angle, ultima.length);
}

/**
 * One barrage tick of one live ultima pod, by pattern (its rings aside), from its muzzle `at`. Returns true on the ticks it
 * throws a volley of shells.
 */
function barrageTick(w: World, seat: number, ultima: UltimaDef, k: number, who: Shooter, facing: number, at: Vec, seq: number): boolean {
  switch (ultima.pattern) {
    case Pattern.Spiral:
      if (seq % ultima.interval === 0) {
        const turn = Math.floor(seq / ultima.interval) * ultima.step;
        for (let arm = 0; arm < ultima.arms; arm++) launch(w, who, ultima.shot, at.x, at.y, facing + turn + Math.floor((fx.ANGLE_FULL * arm) / ultima.arms));
      }
      return false;
    case Pattern.Wheel:
      spoke(w, seat, k, ultima, seq);
      return false;
    case Pattern.Bombard:
      if (seq % ultima.every !== 0) return false;
      bombard(w, who, ultima, at, facing);
      return true;
    default:
      if (seq % ultima.every !== 0) return false;
      carpet(w, who, ultima.shell, at.x, at.y, facing, ultima.first, ultima.gap, ultima.count);
      return true;
  }
}

/**
 * The ultima: every ready ultima pod (live, its weapon not away) pours out its pattern (a spiral, a wheel spoke, bombardment,
 * carpets) and, every `ringEvery` ticks, fires a ring from its own muzzle; the machine cannot move. Each pod keeps a fixed share
 * of the ring's directions (its ordinal among the form's ultima pods), so the pods interleave into one dense ring, and a
 * destroyed or away pod leaves its gaps. When no ultima pod can fire, it stops.
 */
function barrage(w: World, seat: number, form: FormDef): void {
  const { m } = w;
  const ultima = form.ultima;
  const base = w.partBase(seat);
  if (!hasReadyPod(w, seat, form, Role.Ultima)) {
    toRecovery(w, seat, form, Attack.Ultima);
    return;
  }
  const seq = m.plAtkSeq[seat];
  const ringTick = seq % ultima.ringEvery === 0;
  const pods = form.ultimaPods;
  const directions = ultima.ringPerPod * pods.length;
  const ringAlternate = Math.floor(seq / ultima.ringEvery) % 2 === 0 ? 0 : Math.floor(fx.ANGLE_FULL / (2 * directions));
  const at: Vec = { x: 0, y: 0 };
  pods.forEach((k, ordinal) => {
    if (!podReady(w, seat, k)) return;
    const who = shooter(w, seat, Attack.Ultima, k);
    const facing = m.ptAng[base + k];
    podMuzzle(w, seat, k, at);
    const volley = barrageTick(w, seat, ultima, k, who, facing, at, seq);
    if (ringTick) {
      const share = Math.floor((fx.ANGLE_FULL * ordinal) / directions);
      ring(w, who, ultima.ringShot, at.x, at.y, ultima.ringPerPod, facing + share + ringAlternate);
    }
    if (ringTick || volley) w.emit(Ev.PodFire, at.x, at.y, seat, k);
  });
  m.plAtkSeq[seat] = seq + 1;
  if (--m.plAtkTimer[seat] > 0) return;
  toRecovery(w, seat, form, Attack.Ultima);
  pods.forEach((k) => {
    if (podReady(w, seat, k)) m.ptHeat[base + k] = ultima.recovery;
  });
}

/**
 * One tick of a beam attack's release: every ready pod of the attack (live, its weapon not away) beams along its own facing
 * (it keeps swinging toward the aim, so the beam sweeps no faster than the pod turns), pulsing on the first tick and every
 * `every` ticks after. It stops the moment no pod of it can fire; after `duration` ticks the pods that fired are hot for the
 * recovery.
 */
function sweep(w: World, seat: number, form: FormDef): void {
  const { m } = w;
  const attack = m.plAtk[seat];
  const def = releaseOf(form, attack);
  if (def.pattern !== Pattern.Beam) throw new RangeError(`${form.name} attack ${attack} does not sweep a beam`);
  const role = roleOf(attack);
  const base = w.partBase(seat);
  if (!hasReadyPod(w, seat, form, role)) {
    toRecovery(w, seat, form, attack);
    return;
  }
  const seq = m.plAtkSeq[seat];
  const beam = podBeam(w, seat, def.width, def.dmg);
  const at: Vec = { x: 0, y: 0 };
  form.parts.forEach((part, k) => {
    if (part.kind !== PartKind.Pod || (part.roles & role) === 0 || !podReady(w, seat, k)) return;
    podMuzzle(w, seat, k, at);
    const facing = m.ptAng[base + k];
    m.ptBeamLen[base + k] = seq % def.every === 0 ? fireBeam(w, beam, at.x, at.y, facing, def.length) : traceBeam(w, beam, at.x, at.y, facing, def.length);
  });
  m.plAtkSeq[seat] = seq + 1;
  if (--m.plAtkTimer[seat] > 0) return;
  toRecovery(w, seat, form, attack);
  form.parts.forEach((part, k) => {
    if (part.kind === PartKind.Pod && (part.roles & role) !== 0 && podReady(w, seat, k)) m.ptHeat[base + k] = def.recovery;
  });
}

/**
 * The wind-up is over: every ready pod of the attack (live, its weapon not away) fires along its own current facing (a fan of
 * shots, shells lobbed at its target or along its line, or the start of a beam sweep), and a siege shot kicks the machine back.
 * If every pod it needed was destroyed during the wind-up, nothing is released (the energy stays spent) and the machine goes
 * straight into its recovery.
 */
function release(w: World, seat: number, form: FormDef): void {
  const { m } = w;
  const attack = m.plAtk[seat];
  const base = w.partBase(seat);
  const role = roleOf(attack);
  if (!hasReadyPod(w, seat, form, role)) {
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
  const def = releaseOf(form, attack);
  const at: Vec = { x: 0, y: 0 };
  form.parts.forEach((part, k) => {
    if (part.kind !== PartKind.Pod || (part.roles & role) === 0 || !podReady(w, seat, k)) return;
    const facing = m.ptAng[base + k];
    const who = shooter(w, seat, attack, k);
    podMuzzle(w, seat, k, at);
    switch (def.pattern) {
      case Pattern.Volley:
        fan(w, who, def.shot, at.x, at.y, facing, def.count, def.spread);
        break;
      case Pattern.Beam:
        w.emit(Ev.BeamOn, at.x, at.y, seat, k + 1, BeamKind.Boss);
        break;
      case Pattern.Artillery:
        artillery(w, who, def, at, facing);
        break;
      default:
        carpet(w, who, def.shell, at.x, at.y, facing, def.first, def.gap, def.count);
    }
    if (def.pattern !== Pattern.Beam) m.ptHeat[base + k] = def.recovery;
    w.emit(Ev.PodFire, at.x, at.y, seat, k);
    if (attack === Attack.Siege) {
      m.plVX[seat] -= fx.mul(fx.cos(facing), form.siege.recoil);
      m.plVY[seat] -= fx.mul(fx.sin(facing), form.siege.recoil);
    }
  });
  if (def.pattern === Pattern.Beam) {
    m.plAtkPhase[seat] = AttackPhase.Release;
    m.plAtkTimer[seat] = def.duration;
    m.plAtkSeq[seat] = 0;
    sweep(w, seat, form);
    return;
  }
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
      if (m.plAtk[seat] === Attack.Ultima) barrage(w, seat, form);
      else sweep(w, seat, form);
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
    m.ptBeamLen[base + k] = 0;
    if (m.ptFlash[base + k] > 0) m.ptFlash[base + k]--;
    if (m.ptHeat[base + k] > 0) m.ptHeat[base + k]--;
    if (part.kind === PartKind.Pod && m.ptHp[base + k] > 0) m.ptAng[base + k] = fx.turnToward(m.ptAng[base + k], m.plAim[seat], part.turn);
  });
  runAttack(w, seat, form, buttons, fuel);
  if (isRooted(m.plAtk[seat], m.plAtkPhase[seat])) drive(w, seat, 0, 0, 0, ROOT_BRAKE);
  else drive(w, seat, moveX, moveY, form.speed, form.accel);
  keepInside(w, seat, form.reach);
}
