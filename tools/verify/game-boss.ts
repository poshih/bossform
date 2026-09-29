/**
 * Game rules eval (2/4): the boss form. Transformation, fuel, destructible parts, the core rule, and every attack's
 * wind-up (the tell), origin, cost, recovery and cancellation, on all three colossi.
 */
import { fx } from '@metronome/engine';
import {
  Attack, AttackPhase, BOSS_DRAIN_PER_TICK, BOSS_KILL_ORBS, BOSS_KILL_SCORE, BOSS_MIN_GAUGE, BOSS_PART_GAIN_PCT, Button, Ev, Form, FORMS, Frame,
  FRAME_STATS, GAUGE_MAX, GAUGE_PER_DAMAGE_DEALT, HOT_PART_DAMAGE_PCT, KILL_ORBS, MIN_WINDUP_TICKS, Mode, MORPH_TICKS, PartKind, podMuzzle,
  REVERT_PROTECT_TICKS, Role, VANGUARD, W, attackFuel, canStartAttack,
} from '../../game/src/sim/index.ts';
import type { Vec } from '../../game/src/sim/index.ts';
import { exposedPoint, holding, IDLE, Scenario } from './game-scenario.ts';
import { check, finish, info, section } from './lib.ts';

const bolt = VANGUARD.rifle.shot;
const FORM_NAMES = FORMS.map((f) => f.name);
const PILOT = 0;
const FOE = 1;

/** A deathmatch (so kills never end the round mid-test) with seat 0 already transformed and seat 1 far away. */
function colossus(frame: number, gauge = GAUGE_MAX): Scenario {
  return new Scenario({ mode: Mode.Deathmatch, frames: [frame, Frame.Vanguard] }).battle().exposed().place(PILOT, 0, 0).place(FOE, 600, 0).transform(PILOT, gauge);
}

const presses = (buttons: number) => (seat: number) => (seat === PILOT ? holding(buttons) : IDLE);

section('boss form: transformation, fuel, and returning to normal');
{
  const s = new Scenario({ mode: Mode.Deathmatch, frames: [Frame.Vanguard, Frame.Vanguard] }).battle().exposed().place(PILOT, 0, 0).place(FOE, 600, 0);
  s.m.plGauge[PILOT] = BOSS_MIN_GAUGE - 1;
  s.step(1, presses(Button.Boss));
  check('just below the threshold the boss button does nothing', s.m.plForm[PILOT] === Form.Normal);
  s.m.plGauge[PILOT] = BOSS_MIN_GAUGE;
  s.step(1, presses(Button.Boss));
  const started = s.tick;
  check('holding the button while the gauge reaches the threshold transforms at once (no second press needed)', s.m.plForm[PILOT] === Form.Morph && s.events(Ev.MorphStart).length === 1);
  const hp = s.m.plHp[PILOT];
  s.shootAt(bolt, FOE, FOE, 0, 0);
  s.step();
  check('the pilot is untouchable while the machine unfolds', s.m.plHp[PILOT] === hp);
  while (s.m.plForm[PILOT] === Form.Morph) s.step();
  const done = s.events(Ev.MorphDone)[0];
  check(`the transformation takes exactly ${MORPH_TICKS} ticks`, done !== undefined && done.tick - started === MORPH_TICKS, `${done?.tick - started}`);
  check('every part starts at full health', FORMS[Frame.Vanguard].parts.every((part, k) => s.m.ptHp[k] === part.hp));

  s.m.plGauge[PILOT] = 120 * BOSS_DRAIN_PER_TICK;
  s.step(119);
  check(`fuel burns at exactly ${BOSS_DRAIN_PER_TICK / 100} points per tick`, s.m.plGauge[PILOT] === BOSS_DRAIN_PER_TICK && s.m.plForm[PILOT] === Form.Boss);
  s.step();
  check('at zero fuel the machine folds back: normal form, empty gauge, all parts gone, health kept, a moment of protection',
    s.m.plForm[PILOT] === Form.Normal && s.m.plGauge[PILOT] === 0 && s.m.ptHp.slice(0, FORMS[0].parts.length).every((hpLeft) => hpLeft === 0) &&
    s.m.plHp[PILOT] === hp && s.m.plInvuln[PILOT] === REVERT_PROTECT_TICKS && s.events(Ev.BossEnd).length === 1);
}

section('boss form: parts stay destroyed until the next transformation, which restores every part');
{
  const s = colossus(Frame.Vanguard);
  const parts = FORMS[Frame.Vanguard].parts;
  s.m.ptHp[0] = 0;
  s.m.ptHp[4] = 0;
  s.step(200);
  check('destroyed parts do not regenerate while the boss form lasts', s.m.ptHp[0] === 0 && s.m.ptHp[4] === 0 && s.m.plForm[PILOT] === Form.Boss);
  s.m.plGauge[PILOT] = 1;
  s.step(2);
  check('the form ends and nothing is left standing', s.m.plForm[PILOT] === Form.Normal && parts.every((_, k) => s.m.ptHp[k] === 0));
  s.step();
  s.m.plGauge[PILOT] = GAUGE_MAX;
  s.step(1, presses(Button.Boss));
  check('transforming again restores every part to full health', parts.every((part, k) => s.m.ptHp[k] === part.hp));
}

section('boss form: armour first, and only the core hurts the pilot');
{
  const s = colossus(Frame.Vanguard);
  const parts = FORMS[Frame.Vanguard].parts;
  const chest = parts.findIndex((p) => p.name === 'chest');
  const hp = s.m.plHp[PILOT];
  const chestHp = s.m.ptHp[chest];
  const foeGauge = s.m.plGauge[FOE];
  s.shootAt(bolt, FOE, FOE, 0, 0);
  s.step();
  check('a bullet on the core is caught by the plate that covers it: the plate is hurt, the pilot is not', s.m.ptHp[chest] === chestHp - bolt.dmg && s.m.plHp[PILOT] === hp);
  check('damage to boss parts refuels the attacker at twice the normal rate', s.m.plGauge[FOE] - foeGauge === (bolt.dmg * GAUGE_PER_DAMAGE_DEALT * BOSS_PART_GAIN_PCT) / 100, `${s.m.plGauge[FOE] - foeGauge}`);
  s.m.ptHp[chest] = 0;
  s.shootAt(bolt, FOE, FOE, 0, 0);
  s.step();
  check('with that plate gone the very same bullet reaches the core', s.m.plHp[PILOT] === hp - bolt.dmg && s.events(Ev.PartHit).length === 1);
  for (let i = 0; i < 12; i++) s.shootAt(bolt, FOE, FOE, 0, 0);
  s.step();
  check('the core takes damage through the damage window like the robot inside', s.m.plHp[PILOT] === hp - FRAME_STATS[Frame.Vanguard].windowCap);

  const cannonL = parts.findIndex((p) => p.name === 'cannonL');
  const cannonR = parts.findIndex((p) => p.name === 'cannonR');
  const left = exposedPoint(Frame.Vanguard, cannonL, 3);
  const right = exposedPoint(Frame.Vanguard, cannonR, 3);
  const leftHp = s.m.ptHp[cannonL];
  const rightHp = s.m.ptHp[cannonR];
  s.m.ptHeat[cannonL] = 5;
  s.shootAt(bolt, FOE, FOE, left.x, left.y);
  s.shootAt(bolt, FOE, FOE, right.x, right.y);
  s.step();
  check(`pods that just fired are hot and take ${HOT_PART_DAMAGE_PCT}% damage`, leftHp - s.m.ptHp[cannonL] === Math.floor((bolt.dmg * HOT_PART_DAMAGE_PCT) / 100) && rightHp - s.m.ptHp[cannonR] === bolt.dmg);
}

section('boss form: destroying the core destroys the machine, and a boss kill is a bounty');
{
  const s = colossus(Frame.Vanguard);
  s.m.ptHp[0] = 0;
  s.m.plHp[PILOT] = 1;
  s.shootAt(bolt, FOE, FOE, 0, 0);
  s.step();
  const orbs = s.m.oAlive.reduce((n, a) => n + a, 0);
  check('the pilot is destroyed, the form and parts are gone, and the killer scores the boss-kill bonus',
    s.m.plAlive[PILOT] === 0 && s.m.plForm[PILOT] === Form.Normal && s.m.ptHp[1] === 0 && s.m.teamScore[FOE] === BOSS_KILL_SCORE && s.events(Ev.BossEnd).length === 1);
  check('and drops the kill orbs plus the boss bounty', orbs === KILL_ORBS + BOSS_KILL_ORBS, `${orbs} orbs`);
}

for (const frame of [Frame.Vanguard, Frame.Gale, Frame.Juggernaut]) {
  const form = FORMS[frame];
  const name = FORM_NAMES[frame];
  const salvoPods = form.parts.flatMap((p, k) => (p.kind === PartKind.Pod && (p.roles & Role.Salvo) !== 0 ? [k] : []));

  section(`${name}: salvo. The tell, the origin, the cost`);
  {
    const s = colossus(frame);
    const before = s.m.plGauge[PILOT];
    let first = -1;
    let shots: number[] = [];
    for (let i = 0; i < 120 && first < 0; i++) {
      s.step(1, presses(Button.Fire));
      const fresh = s.newBossShots();
      if (fresh.length > 0) {
        first = s.tick;
        shots = fresh;
      }
    }
    const windup = s.events(Ev.Windup)[0];
    check(`wind-up lasts exactly ${form.salvo.windup} ticks (tell minimum ${MIN_WINDUP_TICKS[Attack.Salvo]}) before any shot exists`, windup !== undefined && first - windup.tick === form.salvo.windup, `${first - windup?.tick}`);
    check('the attack is paid for in full when the wind-up starts', s.m.plGauge[PILOT] === before - BOSS_DRAIN_PER_TICK * (form.salvo.windup + 1) - form.salvo.cost);
    const at: Vec = { x: 0, y: 0 };
    const podsUsed = new Set(shots.map((p) => s.m.pPart[p] - 1));
    const fromMuzzles = shots.every((p) => {
      const k = s.m.pPart[p] - 1;
      if (k < 0 || !salvoPods.includes(k)) return false;
      podMuzzle(s.w, PILOT, k, at);
      const spread = Math.abs(fx.angleDiff(s.m.ptAng[k], s.m.pAng[p]));
      return Math.hypot(s.m.pX[p] - at.x, s.m.pY[p] - at.y) / fx.ONE < 8 && spread <= (form.salvo.spread >> 1) + fx.deg(1);
    });
    check('every shot leaves a live salvo pod\'s muzzle, fanned around that pod\'s own facing', fromMuzzles && podsUsed.size === salvoPods.length && shots.length === salvoPods.length * form.salvo.count, `${shots.length} shots from ${podsUsed.size} pods`);
    check('the pods that fired are hot for the whole recovery', salvoPods.every((k) => s.m.ptHeat[k] === form.salvo.recovery));
    check('the machine is not rooted by a salvo (it only ever slows the turn and fire rate)', s.m.plAtkPhase[PILOT] === AttackPhase.Recovery);
  }

  section(`${name}: a pod destroyed during its wind-up cancels its shot, and the energy is still spent`);
  {
    const s = colossus(frame);
    const before = s.m.plGauge[PILOT];
    s.step(1, presses(Button.Fire));
    const victim = salvoPods[0];
    s.step(4, presses(Button.Fire));
    s.m.ptHp[victim] = 0;
    let shots: number[] = [];
    for (let i = 0; i < form.salvo.windup && shots.length === 0; i++) {
      s.step(1, presses(Button.Fire));
      shots = s.newBossShots();
    }
    check('no shot comes from the destroyed pod, the others still fire', shots.length > 0 && shots.every((p) => s.m.pPart[p] - 1 !== victim) && shots.some((p) => salvoPods.includes(s.m.pPart[p] - 1)));
    check('and the cost was not refunded', s.m.plGauge[PILOT] < before - form.salvo.cost);
  }

  section(`${name}: siege shot. Rooted while it charges, kicked back when it fires`);
  {
    const s = colossus(frame);
    const before = s.m.plGauge[PILOT];
    const x0 = s.m.plX[PILOT];
    let first = -1;
    let shots: number[] = [];
    let rooted = true;
    for (let i = 0; i < 160 && first < 0; i++) {
      s.step(1, (seat) => (seat === PILOT ? holding(Button.Alt, { moveX: 127 }) : IDLE));
      const fresh = s.newBossShots();
      if (fresh.length > 0) {
        first = s.tick;
        shots = fresh;
      } else if (Math.abs(s.m.plX[PILOT] - x0) > fx.fromInt(1)) rooted = false;
    }
    const windup = s.events(Ev.Windup)[0];
    check(`wind-up lasts exactly ${form.siege.windup} ticks (tell minimum ${MIN_WINDUP_TICKS[Attack.Siege]}) and the body cannot be steered meanwhile`, windup !== undefined && first - windup.tick === form.siege.windup && rooted, `${first - windup?.tick}, rooted ${rooted}`);
    const siegePods = form.parts.filter((p) => p.kind === PartKind.Pod && (p.roles & Role.Siege) !== 0).length;
    check('the shells leave the siege pods, and the whole machine is thrown backwards', shots.length === siegePods * form.siege.count && shots.every((p) => s.m.pAttack[p] === Attack.Siege) && s.m.plVX[PILOT] < 0);
    check('the cost of a siege shot is far above a salvo\'s', before - s.m.plGauge[PILOT] >= form.siege.cost && form.siege.cost > form.salvo.cost);
  }

  section(`${name}: ultima. The longest tell, a rooted barrage, then a long cooldown`);
  {
    const s = colossus(frame);
    const x0 = s.m.plX[PILOT];
    let first = -1;
    let recovery = -1;
    let windupTicks = 0;
    let rooted = true;
    for (let i = 0; i < 900 && recovery < 0; i++) {
      s.step(1, (seat) => (seat === PILOT ? holding(Button.Ultima, { moveX: 127 }) : IDLE));
      const phase = s.m.plAtkPhase[PILOT];
      if (phase === AttackPhase.Windup) windupTicks++;
      if (first < 0 && s.newBossShots().length > 0) first = s.tick;
      if ((phase === AttackPhase.Windup || phase === AttackPhase.Release) && Math.abs(s.m.plX[PILOT] - x0) > fx.fromInt(1)) rooted = false;
      if (phase === AttackPhase.Recovery) recovery = s.tick;
    }
    const windup = s.events(Ev.Windup)[0];
    check(`wind-up lasts exactly ${form.ultima.windup} ticks (tell minimum ${MIN_WINDUP_TICKS[Attack.Ultima]}) before any shot exists`, windup !== undefined && first - windup.tick === form.ultima.windup, `${first - windup?.tick}`);
    check(`the barrage lasts exactly ${form.ultima.duration} ticks and the machine stays rooted through the charge and the barrage`, recovery - first + 1 === form.ultima.duration && rooted, `${recovery - first + 1} ticks`);
    check('the ultima costs the most and starts a long cooldown', s.m.plUltCd[PILOT] === form.ultima.cooldown && form.ultima.cost > form.siege.cost);
    info(`${name}: ${windupTicks} ticks of wind-up, ${form.ultima.duration} of barrage, cooldown ${form.ultima.cooldown}`);
  }
}

section('an attack needs its cost plus all the fuel its wind-up, barrage and recovery burn: the tell never lies');
for (const frame of [Frame.Vanguard, Frame.Gale, Frame.Juggernaut]) {
  const form = FORMS[frame];
  for (const [attack, button, label] of [[Attack.Salvo, Button.Fire, 'salvo'], [Attack.Siege, Button.Alt, 'siege'], [Attack.Ultima, Button.Ultima, 'ultima']] as const) {
    const need = attackFuel(form, attack);
    const short = colossus(frame);
    short.m.plGauge[PILOT] = need - 1;
    const refusedAhead = !canStartAttack(short.w, PILOT, attack);
    short.step(1, presses(button));
    const refused = short.events(Ev.Windup).length === 0 && short.m.plAtkPhase[PILOT] === AttackPhase.Idle;

    const exact = colossus(frame);
    exact.m.plGauge[PILOT] = need;
    const allowedAhead = canStartAttack(exact.w, PILOT, attack);
    exact.step(1, presses(button));
    const started = exact.events(Ev.Windup).length === 1;
    let stayed = true;
    for (let i = 0; i < 1200 && exact.m.plAtkPhase[PILOT] !== AttackPhase.Idle; i++) {
      exact.step();
      if (exact.m.plForm[PILOT] !== Form.Boss) stayed = false;
    }
    const finished = exact.events(Ev.Release).length === 1 && exact.m.plAtkPhase[PILOT] === AttackPhase.Idle;
    check(`${FORM_NAMES[frame]} ${label}: one unit short of ${need} it cannot start; with exactly that it winds up, fires and recovers before the fuel runs out`,
      refusedAhead && refused && allowedAhead && started && stayed && finished && exact.m.plForm[PILOT] === Form.Boss,
      `short refused ${refused}, started ${started}, stayed in form ${stayed}, finished ${finished}`);
  }
}

info(`${W.Count} world scalars`);
finish('game-boss');
