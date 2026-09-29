/**
 * Game rules eval (1/4): the rules that are not about boss forms or match flow, each checked by running the real
 * simulation in a hand-built situation: authoring-time definitions, movement and the boost, configuration, the damage
 * window, graze, teams, protection, energy and the shield, the boss gauge, neutral units, orbs and departing pilots.
 */
import { fx } from '@metronome/engine';
import {
  Attack, Button, decodeConfig, encodeConfig, Ev, FORMS, Form, FRAME_STATS, Frame, GALE, GAUGE_MAX, GAUGE_PER_DAMAGE_DEALT,
  GAUGE_PER_DAMAGE_TAKEN, GAUGE_PER_GRAZE, JUGGERNAUT, MIN_WINDUP_TICKS, Mode, NEUTRAL_DEFS, NeutralType, NO_SEAT, ORB_VALUE, Phase,
  PRIMARY_WEAPONS, PROJECTILE_SPEED_CAP, SHOT_DEFS, canBoost, canUseAlt, ShotFlag, VANGUARD, W, WAVE_INTERVAL_TICKS, BOSS_DRAIN_PER_TICK, ARENA_RADIUS_LIMIT, RADIAL_SHIFT, inside, span2,
  ENERGY_MAX, ENERGY_REGEN_DELAY, ENERGY_REGEN_PER_TICK, MOVE_MAX, SHIELD_BREAK_TICKS, SHIELD_COST_PER_DAMAGE, SHIELD_RAISE_ENERGY, SHIELD_RAISE_TICKS, TICK_RATE,
} from '../../game/src/sim/index.ts';
import type { GameInput, World } from '../../game/src/sim/index.ts';
import { shot } from '../../game/src/sim/shots.ts';
import { holding, IDLE, Scenario } from './game-scenario.ts';
import { check, finish, info, section } from './lib.ts';

const FRAME_NAMES = ['VANGUARD', 'GALE', 'JUGGERNAUT'];
const bolt = VANGUARD.rifle.shot;
/** Each robot's primary weapon: refire interval and energy cost. */
/** The design's pace: a full pool feeds a primary weapon for about 7 s of continuous fire. */
const SUSTAINED_FIRE_SECONDS = [6.5, 8] as const;
const FRAMES = [Frame.Vanguard, Frame.Gale, Frame.Juggernaut] as const;

/** Puts a bolt (heading +x) where one step of its own motion lands it exactly on the raw point (x, y), owned by seat 1. */
function boltOnto(s: Scenario, x: number, y: number): number {
  const p = s.shootAt(bolt, 1, 1, 0, 0);
  s.m.pX[p] = x - bolt.spd;
  s.m.pY[p] = y;
  return p;
}

/** Seat 0 holds `buttons` (and aims at -x, away from everybody); everybody else idles. */
const seatZero = (buttons: number, extra: Partial<GameInput> = {}) => (seat: number): GameInput => (seat === 0 ? holding(buttons, { aim: fx.ANGLE_HALF, ...extra }) : IDLE);

const firesOf = (s: Scenario, seat: number, since: number) => s.events(Ev.Fire, since).filter((e) => e.a === seat);
const speedOf = (w: World, seat: number) => Math.hypot(w.m.plVX[seat], w.m.plVY[seat]);
const throwsRange = (fn: () => unknown): boolean => {
  try {
    fn();
    return false;
  } catch (error) {
    return error instanceof RangeError;
  }
};

section('definitions: the speed rule and the weight rules are enforced when content is authored');
{
  const moves = (d: (typeof SHOT_DEFS)[number]) => ((d.flags & ShotFlag.Inert) !== 0 ? d.spd >= 0 : d.spd > 0);
  check(`all ${SHOT_DEFS.length} projectile blueprints launch and top out at or below the cap (only a harmless inert fuse may stand still)`, SHOT_DEFS.every((d) => moves(d) && d.spd <= PROJECTILE_SPEED_CAP && d.maxSpd <= PROJECTILE_SPEED_CAP));
  check('a stationary shot that could hurt is refused', throwsRange(() => shot({ kind: 0, spd: 0, rad: fx.fromInt(2), dmg: 1, life: 10 })));
  check('shrapnel blueprints obey the cap too', SHOT_DEFS.every((d) => d.burst === null || d.burst.shot.maxSpd <= PROJECTILE_SPEED_CAP));
  check('authoring a shot faster than the cap is refused', throwsRange(() => shot({ kind: 0, spd: PROJECTILE_SPEED_CAP + 1, rad: fx.fromInt(2), dmg: 1, life: 10 })));
  check('authoring a shot that accelerates past the cap is refused', throwsRange(() => shot({ kind: 0, spd: fx.lit(2), acc: fx.lit(0.1), maxSpd: PROJECTILE_SPEED_CAP + 1, rad: fx.fromInt(2), dmg: 1, life: 10 })));
  for (const form of FORMS) {
    const { salvo, siege, ultima } = form;
    const tell = form.salvo.windup >= MIN_WINDUP_TICKS[Attack.Salvo] && siege.windup >= MIN_WINDUP_TICKS[Attack.Siege] && ultima.windup >= MIN_WINDUP_TICKS[Attack.Ultima];
    check(`${form.name}: wind-ups meet the tell minimums (${MIN_WINDUP_TICKS.slice(1).join('/')})`, tell, `${salvo.windup}/${siege.windup}/${ultima.windup}`);
    check(`${form.name}: heavier attack, longer wind-up, longer recovery, higher cost`,
      salvo.windup < siege.windup && siege.windup < ultima.windup && salvo.recovery < siege.recovery && siege.recovery < ultima.recovery && salvo.cost < siege.cost && siege.cost < ultima.cost);
    check(`${form.name}: slower to move and accelerate than its robot`, form.speed < FRAME_STATS[form.frame].speed && form.accel < FRAME_STATS[form.frame].accel);
  }
  const [paladin, tempest, fortress] = FORMS;
  check('the heavier the machine the longer it winds up: FORTRESS > PALADIN > TEMPEST for every attack',
    [Attack.Salvo, Attack.Siege, Attack.Ultima].every((a) => {
      const w = (f: typeof paladin) => (a === Attack.Salvo ? f.salvo.windup : a === Attack.Siege ? f.siege.windup : f.ultima.windup);
      return w(fortress) > w(paladin) && w(paladin) > w(tempest);
    }));
  check('the heavier the machine the slower it turns: FORTRESS < PALADIN < TEMPEST', fortress.bodyTurn < paladin.bodyTurn && paladin.bodyTurn < tempest.bodyTurn);
  check('lighter robots can take less damage per window: GALE < VANGUARD < JUGGERNAUT',
    FRAME_STATS[Frame.Gale].windowCap < FRAME_STATS[Frame.Vanguard].windowCap && FRAME_STATS[Frame.Vanguard].windowCap < FRAME_STATS[Frame.Juggernaut].windowCap);
  check('every primary weapon refires sooner than energy starts to refill, so a pilot who keeps firing never refills',
    PRIMARY_WEAPONS.every((weapon) => weapon.interval < ENERGY_REGEN_DELAY), PRIMARY_WEAPONS.map((weapon) => weapon.interval).join(' / '));
  for (const frame of [Frame.Vanguard, Frame.Gale, Frame.Juggernaut]) {
    const { interval, cost } = PRIMARY_WEAPONS[frame];
    const seconds = (Math.floor(ENERGY_MAX / cost) * interval) / TICK_RATE;
    check(`${FRAME_NAMES[frame]}: a full pool buys ${SUSTAINED_FIRE_SECONDS.join(' to ')} s of continuous primary fire`, seconds >= SUSTAINED_FIRE_SECONDS[0] && seconds <= SUSTAINED_FIRE_SECONDS[1], `${seconds.toFixed(2)} s`);
    const boost = FRAME_STATS[frame].boost;
    check(`${FRAME_NAMES[frame]}: its boost is at least twice its top speed, dodges for part of it, and cools down for longer than it lasts`,
      boost.speed >= 2 * FRAME_STATS[frame].speed && boost.dodge > 0 && boost.dodge < boost.ticks && boost.cooldown > boost.ticks,
      `${boost.speed / fx.ONE} u/tick for ${boost.ticks} ticks (${(boost.speed * boost.ticks) / fx.ONE} units), dodge ${boost.dodge}, cooldown ${boost.cooldown}`);
  }
  check('the heavier the robot the shorter its boost reaches and the longer it cools down: GALE > VANGUARD > JUGGERNAUT',
    [Frame.Gale, Frame.Vanguard, Frame.Juggernaut].every((frame, i, order) => i === 0 || (FRAME_STATS[order[i - 1]].boost.speed * FRAME_STATS[order[i - 1]].boost.ticks > FRAME_STATS[frame].boost.speed * FRAME_STATS[frame].boost.ticks && FRAME_STATS[order[i - 1]].boost.cooldown < FRAME_STATS[frame].boost.cooldown)));
}

section('movement: robots stop and reverse quickly, never gain speed from a turn; colossi keep their weight');
for (const frame of [Frame.Vanguard, Frame.Gale, Frame.Juggernaut]) {
  const stats = FRAME_STATS[frame];
  const name = FRAME_NAMES[frame];
  const runRight = () => {
    const s = new Scenario({ mode: Mode.Deathmatch, frames: [frame, Frame.Vanguard] }).battle().exposed().place(0, -300, 0).place(1, 300, 300);
    s.step(90, (seat) => (seat === 0 ? holding(0, { moveX: 127 }) : IDLE));
    return s;
  };
  const toTop = runRight();
  check(`${name}: full deflection reaches top speed`, toTop.m.plVX[0] === stats.speed && toTop.m.plVY[0] === 0, `${toTop.m.plVX[0] / fx.ONE}`);

  const stop = runRight();
  const x0 = stop.m.plX[0];
  let stopTicks = 0;
  while (stop.m.plVX[0] > 0 && stopTicks < 120) {
    stop.step(1);
    stopTicks++;
  }
  const slide = (stop.m.plX[0] - x0) / fx.ONE;
  const brakeTicks = Math.ceil(stats.speed / stats.brake);
  check(`${name}: letting go stops the robot in ${brakeTicks} ticks (brake ${stats.brake / fx.ONE}/tick), sliding ${slide.toFixed(1)} units`, stopTicks === brakeTicks && stop.m.plVY[0] === 0, `${stopTicks} ticks`);

  const turn = runRight();
  let fastest = 0;
  for (let i = 0; i < 40; i++) {
    turn.step(1, (seat) => (seat === 0 ? holding(0, { moveY: 127 }) : IDLE));
    fastest = Math.max(fastest, Math.hypot(turn.m.plVX[0], turn.m.plVY[0]));
  }
  check(`${name}: a right-angle turn never makes it faster than its top speed`, fastest <= stats.speed + 1, `${(fastest / fx.ONE).toFixed(3)} vs ${stats.speed / fx.ONE}`);

  const reverse = runRight();
  let reverseTicks = 0;
  while (reverse.m.plVX[0] > -stats.speed && reverseTicks < 120) {
    reverse.step(1, (seat) => (seat === 0 ? holding(0, { moveX: -127 }) : IDLE));
    reverseTicks++;
  }
  const expected = Math.ceil(stats.speed / stats.brake) + Math.ceil(stats.speed / stats.accel);
  check(`${name}: reversing at full speed takes about ${expected} ticks (braking, then accelerating)`, Math.abs(reverseTicks - expected) <= 1, `${reverseTicks} ticks`);
}
{
  const s = new Scenario({ mode: Mode.Deathmatch, frames: [Frame.Vanguard, Frame.Vanguard] }).battle().exposed().place(0, 0, 0).place(1, 500, 300).transform(0, GAUGE_MAX);
  const form = FORMS[Frame.Vanguard];
  s.step(200, (seat) => (seat === 0 ? holding(0, { moveX: 127 }) : IDLE));
  let biggest = 0;
  for (let i = 0; i < 60; i++) {
    const vx = s.m.plVX[0];
    const vy = s.m.plVY[0];
    s.step(1, (seat) => (seat === 0 ? holding(0, { moveX: -127 }) : IDLE));
    biggest = Math.max(biggest, Math.hypot(s.m.plVX[0] - vx, s.m.plVY[0] - vy));
  }
  check('a colossus still changes its velocity by at most its own acceleration per tick, braking included (its weight)', biggest <= form.accel + 1, `${(biggest / fx.ONE).toFixed(3)} vs ${form.accel / fx.ONE}`);
}

section('the GALE dash leaves its echo where the dash began, and the echo bursts there');
{
  const s = new Scenario({ mode: Mode.Deathmatch, frames: [Frame.Gale, Frame.Vanguard] }).battle().exposed().place(0, -200, 0).place(1, 300, 300);
  const startX = s.m.plX[0];
  const startY = s.m.plY[0];
  s.step(1, (seat) => (seat === 0 ? holding(Button.Alt, { moveX: 127 }) : IDLE));
  const dash = s.events(Ev.Dash)[0];
  const echoDef = GALE.dash.echo;
  let echo = -1;
  for (let p = 0; p < s.w.cap.projectiles; p++) if (s.m.pAlive[p] === 1 && s.m.pDef[p] === echoDef.id) echo = p;
  const placed = echo >= 0 && s.m.pX[echo] === startX && s.m.pY[echo] === startY;
  // It ages once on the tick it is laid, so its fuse runs out `life - 1` ticks later: look one tick before that.
  s.step(echoDef.life - 2);
  const stayed = echo >= 0 && s.m.pAlive[echo] === 1 && s.m.pX[echo] === startX && s.m.pY[echo] === startY;
  s.step(2);
  const burst = s.events(Ev.Burst).find((e) => e.a === echoDef.id);
  check('the echo appears where the dash began, stays there through its fuse, and bursts on that spot',
    dash !== undefined && placed && stayed && burst !== undefined && burst.x === startX && burst.y === startY,
    `placed ${placed}, stayed ${stayed}, burst at ${burst ? ((burst.x - startX) / fx.ONE).toFixed(1) : 'none'}`);
}

section('boost: a burst of speed where the pilot presses (or aims), whose first ticks dodge');
for (const frame of FRAMES) {
  const name = FRAME_NAMES[frame];
  const boost = FRAME_STATS[frame].boost;
  const s = new Scenario({ mode: Mode.Deathmatch, frames: [frame, Frame.Vanguard] }).battle().exposed().place(0, -200, -150).place(1, 300, 300);
  const x0 = s.m.plX[0];
  const y0 = s.m.plY[0];
  const since = s.tick + 1;
  s.step(1, seatZero(Button.Boost, { moveY: MOVE_MAX }));
  s.step(boost.ticks - 1);
  const started = s.events(Ev.Boost, since);
  const travelled = s.m.plY[0] - y0;
  check(`${name}: pressing up and boosting flies ${boost.ticks} ticks x ${boost.speed / fx.ONE} = ${(boost.ticks * boost.speed) / fx.ONE} units straight up, then drops to top speed`,
    started.length === 1 && started[0].b === fx.ANGLE_QUARTER && started[0].c === frame && s.m.plX[0] === x0 && travelled === boost.ticks * boost.speed && speedOf(s.w, 0) <= FRAME_STATS[frame].speed,
    `${(travelled / fx.ONE).toFixed(2)} units, then ${(speedOf(s.w, 0) / fx.ONE).toFixed(2)} u/tick`);

  const aimed = new Scenario({ mode: Mode.Deathmatch, frames: [frame, Frame.Vanguard] }).battle().exposed().place(0, 0, 0).place(1, 300, 300);
  aimed.step(1, seatZero(Button.Boost));
  const aimedBoost = aimed.events(Ev.Boost)[0];
  check(`${name}: pressing no direction, it boosts where it aims`, aimedBoost !== undefined && aimedBoost.b === fx.ANGLE_HALF && aimed.m.plVX[0] < 0 && aimed.m.plVY[0] === 0);

  const held = new Scenario({ mode: Mode.Deathmatch, frames: [frame, Frame.Vanguard] }).battle().exposed().place(0, 0, 0).place(1, 300, 300);
  const heldSince = held.tick + 1;
  held.step(boost.cooldown * 3, seatZero(Button.Boost, { moveX: MOVE_MAX }));
  const starts = held.events(Ev.Boost, heldSince).map((e) => e.tick);
  check(`${name}: held, it boosts again exactly every ${boost.cooldown} ticks (its cooldown)`, starts.length === 3 && starts[1] - starts[0] === boost.cooldown && starts[2] - starts[1] === boost.cooldown, starts.join(', '));
}
{
  // A bolt lands on the robot's core on each tick of a boost (shields are down: exposed()). The first `dodge` ticks it passes.
  const boost = FRAME_STATS[Frame.Vanguard].boost;
  const s = new Scenario({ mode: Mode.Deathmatch, frames: [Frame.Vanguard, Frame.Vanguard] }).battle().exposed().place(0, -200, -150).place(1, 300, 300);
  const outcome: string[] = [];
  for (let k = 0; k <= boost.dodge; k++) {
    const vy = k === 0 ? boost.speed : s.m.plVY[0];
    boltOnto(s, s.m.plX[0], s.m.plY[0] + vy);
    const hp = s.m.plHp[0];
    const since = s.tick + 1;
    s.step(1, k === 0 ? seatZero(Button.Boost, { moveY: MOVE_MAX }) : () => IDLE);
    outcome.push(s.m.plHp[0] < hp ? 'hit' : s.events(Ev.Graze, since).some((e) => e.a === 0) ? 'graze' : 'none');
  }
  const dodged = outcome.slice(0, boost.dodge);
  check(`a boost dodges for its first ${boost.dodge} ticks: a bolt on the core passes and only grazes; on the next tick it hurts again`,
    dodged.every((o) => o === 'graze') && outcome[boost.dodge] === 'hit', outcome.join(' '));
}
{
  const s = new Scenario({ mode: Mode.Deathmatch, frames: [Frame.Vanguard, Frame.Vanguard] }).battle().exposed().place(0, 0, 0).place(1, 500, 300).transform(0, GAUGE_MAX);
  const since = s.tick + 1;
  s.step(120, seatZero(Button.Boost, { moveX: MOVE_MAX }));
  check('a colossus never boosts, and canBoost (what the HUD and bots read) says so', s.events(Ev.Boost, since).length === 0 && s.m.plBoost[0] === 0 && !canBoost(s.w, 0));

  const dash = new Scenario({ mode: Mode.Deathmatch, frames: [Frame.Gale, Frame.Vanguard] }).battle().exposed().place(0, 0, 0).place(1, 500, 300);
  const readyBefore = canBoost(dash.w, 0);
  dash.step(1, seatZero(Button.Alt, { moveX: MOVE_MAX }));
  const heldByDash = dash.m.plDash[0] > 0 && !canBoost(dash.w, 0);
  const pressedAt = dash.tick + 1;
  dash.step(1, seatZero(Button.Boost, { moveY: MOVE_MAX }));
  check('canBoost is false during a phase dash, and a boost pressed then does not start',
    readyBefore && heldByDash && dash.events(Ev.Boost, pressedAt).length === 0 && dash.m.plBoost[0] === 0);

  const gale = new Scenario({ mode: Mode.Deathmatch, frames: [Frame.Gale, Frame.Vanguard] }).battle().exposed().place(0, -200, 0).place(1, 300, 300);
  gale.step(2, seatZero(Button.Boost, { moveY: MOVE_MAX }));
  const dashSince = gale.tick + 1;
  gale.step(1, seatZero(Button.Alt | Button.Boost, { moveX: MOVE_MAX }));
  const dashed = gale.events(Ev.Dash, dashSince).length === 1 && gale.m.plBoost[0] === 0 && gale.m.plVX[0] === GALE.dash.speed && gale.m.plVY[0] === 0;
  const boostSince = gale.tick + 1;
  gale.step(GALE.dash.ticks - 1, seatZero(Button.Boost, { moveY: MOVE_MAX }));
  check('a GALE phase dash cancels a running boost, and no boost starts while the dash runs', dashed && gale.events(Ev.Boost, boostSince).length === 0);

  const firing = new Scenario({ mode: Mode.Deathmatch, frames: [Frame.Vanguard, Frame.Vanguard] }).battle().exposed().place(0, 0, 0).place(1, 300, 300);
  const fireSince = firing.tick + 1;
  firing.step(1, seatZero(Button.Fire | Button.Boost, { moveY: MOVE_MAX }));
  check('a robot boosts and fires on the same tick: movement and aim stay independent', firing.events(Ev.Boost, fireSince).length === 1 && firesOf(firing, 0, fireSince).length === 1);
}

section('arena-scale distances compare exactly, even in the largest arena the fixed-point range allows');
{
  const widest = ARENA_RADIUS_LIMIT * 2;
  check('the squared shifted length of the widest possible vector is an exact integer', Number.isSafeInteger(span2(widest, widest)), `${span2(widest, widest)}`);
  const r = ARENA_RADIUS_LIMIT;
  check('a point on the rim is inside, one raw step beyond the shifted grid is not', inside(r, 0, r) && !inside(r + (1 << RADIAL_SHIFT), 0, r));
}

section('configuration is validated where it enters the simulation');
{
  const good = encodeConfig({ mode: Mode.Deathmatch, seats: [{ frame: Frame.Gale, team: 0 }, { frame: Frame.Juggernaut, team: 1 }] });
  const decoded = decodeConfig(good, 2);
  check('a valid configuration round-trips', decoded.mode === Mode.Deathmatch && decoded.seats[1].frame === Frame.Juggernaut && decoded.seats[1].team === 1);
  check('a wrong length is rejected', throwsRange(() => decodeConfig(new Uint8Array(3), 2)));
  check('an unknown mode is rejected', throwsRange(() => decodeConfig(Uint8Array.of(9, 0, 0, 0, 1), 2)));
  check('an unknown frame is rejected', throwsRange(() => decodeConfig(Uint8Array.of(0, 7, 0, 0, 1), 2)));
  check('team ids are free labels (a lobby\'s team colours survive into the match), as long as two teams exist', decodeConfig(Uint8Array.of(0, 0, 5, 0, 200), 2).seats[1].team === 200);
  check('a match with a single team is rejected', throwsRange(() => decodeConfig(Uint8Array.of(0, 0, 0, 0, 0), 2)));
}

section('damage window: a robot takes at most its cap per window, and the cap is a per-robot balance value');
for (const frame of [Frame.Vanguard, Frame.Gale, Frame.Juggernaut]) {
  const name = FRAME_NAMES[frame];
  const stats = FRAME_STATS[frame];
  const s = new Scenario({ frames: [frame, Frame.Vanguard] }).battle().exposed().place(0, 0, 0).place(1, 300, 0);
  const before = s.m.plHp[0];
  const volley = Math.ceil(stats.windowCap / bolt.dmg) + 4;
  for (let i = 0; i < volley; i++) s.shootAt(bolt, 1, 1, 0, 0);
  s.step();
  const opened = s.tick;
  const hits = s.events(Ev.Hit, opened).length;
  const blocked = s.events(Ev.Blocked, opened).length;
  check(`${name}: ${volley} bolts (${volley * bolt.dmg} damage) cost exactly the cap of ${stats.windowCap}`, before - s.m.plHp[0] === stats.windowCap, `hp ${before} -> ${s.m.plHp[0]}`);
  check(`${name}: the excess is blocked, not applied, and every bolt is used up`, blocked >= 1 && hits + blocked === volley && s.liveProjectiles() === 0, `${hits} applied, ${blocked} blocked`);
  s.stepTo(opened + 58);
  s.shootAt(bolt, 1, 1, 0, 0);
  s.step();
  const capped = before - s.m.plHp[0];
  s.shootAt(bolt, 1, 1, 0, 0);
  s.step();
  check(`${name}: still capped one tick before the window ends, damage flows again on the tick it ends`, capped === stats.windowCap && before - s.m.plHp[0] === stats.windowCap + bolt.dmg);
}
for (const frame of [Frame.Vanguard, Frame.Gale, Frame.Juggernaut]) {
  const stats = FRAME_STATS[frame];
  const s = new Scenario({ frames: [frame, Frame.Vanguard] }).battle().exposed().place(0, 0, 0).place(1, 300, 0);
  const first = s.tick + 1;
  while (s.m.plAlive[0] === 1 && s.tick < first + 2000) {
    for (let i = 0; i < 12; i++) s.shootAt(bolt, 1, 1, 0, 0);
    s.step();
  }
  const windows = Math.ceil(stats.hp / stats.windowCap);
  const expected = (windows - 1) * stats.windowTicks;
  check(`${FRAME_NAMES[frame]}: relentless fire cannot kill faster than ${windows} windows (${expected} ticks after the first hit)`, s.tick - first === expected, `died after ${s.tick - first} ticks`);
}

section('graze, teams and protection');
{
  const s = new Scenario({ frames: [Frame.Vanguard, Frame.Vanguard, Frame.Vanguard], teams: [0, 0, 1] }).battle().exposed();
  s.place(0, 0, 0).place(1, 300, 300).place(2, -300, -300);
  const passing = s.shootAt(bolt, 2, 1, 10, -40);
  s.m.pAng[passing] = fx.ANGLE_QUARTER;
  s.m.pX[passing] = fx.fromInt(10);
  s.m.pY[passing] = fx.fromInt(-40);
  s.step(40);
  check('a bullet that passes outside the core but inside the graze band pays once', s.m.plGauge[0] === GAUGE_PER_GRAZE && s.events(Ev.Graze).length === 1 && s.m.plHp[0] === FRAME_STATS[Frame.Vanguard].hp, `gauge ${s.m.plGauge[0]}`);
  const friendly = s.shootAt(bolt, 1, 0, 0, 0);
  const hp = s.m.plHp[0];
  s.step();
  check('no friendly fire: a teammate\'s bullet passes through and is not used up', s.m.plHp[0] === hp && s.m.pAlive[friendly] === 1);

  const guarded = new Scenario({ frames: [Frame.Vanguard, Frame.Vanguard] }).battle().place(0, 0, 0).place(1, 300, 0);
  const shield = guarded.shootAt(bolt, 1, 1, 0, 0);
  guarded.step();
  check('a freshly spawned ship is protected: bullets pass through it harmlessly', guarded.m.plHp[0] === FRAME_STATS[Frame.Vanguard].hp && guarded.m.pAlive[shield] === 1);
}

section('bulwark: the heavy bunker swallows bullets into its boss gauge');
{
  const s = new Scenario({ frames: [Frame.Juggernaut, Frame.Vanguard] }).battle().exposed().place(0, 0, 0).place(1, 300, 0);
  s.step(1, (seat) => (seat === 0 ? holding(Button.Alt, { aim: 0 }) : IDLE));
  const front = s.shootAt(bolt, 1, 1, 20, 0);
  const behind = s.shootAt(bolt, 1, 1, -20, 0);
  s.m.pAng[behind] = fx.ANGLE_HALF;
  s.m.pX[behind] = fx.fromInt(-20) + bolt.spd;
  const hp = s.m.plHp[0];
  s.step();
  check('a bullet inside the wedge in front is absorbed and pays the boss gauge, without harm', s.m.pAlive[front] === 0 && s.events(Ev.Absorb).length === 1 && s.m.plHp[0] === hp && s.m.plGauge[0] > 0);
  check('a bullet behind the ship is not absorbed', s.m.pAlive[behind] === 1);
}

section('energy: every shot pays from one pool, which refills once nothing has been spent for a moment');
for (const frame of FRAMES) {
  const name = FRAME_NAMES[frame];
  const { interval, cost } = PRIMARY_WEAPONS[frame];
  const s = new Scenario({ mode: Mode.Deathmatch, frames: [frame, Frame.Vanguard] }).battle().exposed().place(0, 0, 0).place(1, 300, 300);
  check(`${name}: a robot comes into the round with a full pool`, s.m.plEnergy[0] === ENERGY_MAX);
  const since = s.tick + 1;
  const affordable = Math.floor(ENERGY_MAX / cost);
  s.step(affordable * interval + 2, seatZero(Button.Fire));
  const fired = firesOf(s, 0, since);
  const remainder = ENERGY_MAX - affordable * cost;
  check(`${name}: held fire takes ${affordable} shots of ${cost} (no refill while firing), then the gun falls silent with ${remainder} left`,
    fired.length === affordable && s.m.plEnergy[0] === remainder, `${fired.length} shots, ${s.m.plEnergy[0]} left`);
  const last = fired[fired.length - 1].tick;
  const refillTicks = Math.ceil((cost - remainder) / ENERGY_REGEN_PER_TICK);
  // The refill resumes on the delay's last tick, and a refill lands before the weapons act in the same tick.
  const expected = ENERGY_REGEN_DELAY + refillTicks - 1;
  s.step(expected + 1, seatZero(Button.Fire));
  const next = firesOf(s, 0, last + 1)[0];
  check(`${name}: still held, it fires again ${expected} ticks after its last shot: the refill resumes after ${ENERGY_REGEN_DELAY}, and ${refillTicks} refill(s) pay for a shot`,
    next !== undefined && next.tick - last === expected, `${next ? next.tick - last : 'no'} ticks`);
}
{
  const s = new Scenario({ mode: Mode.Deathmatch, frames: [Frame.Vanguard, Frame.Vanguard] }).battle().exposed().place(0, 0, 0).place(1, 300, 300);
  s.step(1, seatZero(Button.Fire));
  const after = s.m.plEnergy[0];
  s.step(ENERGY_REGEN_DELAY - 1);
  const waited = s.m.plEnergy[0];
  s.step(1);
  check(`energy refills ${ENERGY_REGEN_PER_TICK} per tick, starting ${ENERGY_REGEN_DELAY} ticks after the last shot`, after === ENERGY_MAX - VANGUARD.rifle.cost && waited === after && s.m.plEnergy[0] === after + ENERGY_REGEN_PER_TICK);
  s.step(Math.ceil(ENERGY_MAX / ENERGY_REGEN_PER_TICK));
  check('and never beyond a full pool', s.m.plEnergy[0] === ENERGY_MAX);
  const alt = new Scenario({ mode: Mode.Deathmatch, frames: [Frame.Vanguard, Frame.Vanguard] }).battle().exposed().place(0, 0, 0).place(1, 300, 300);
  alt.step(1, seatZero(Button.Alt));
  check('VANGUARD\'s seekers are a weapon too: they pay their own cost', alt.m.plEnergy[0] === ENERGY_MAX - VANGUARD.seekers.cost);

  const poor = new Scenario({ mode: Mode.Deathmatch, frames: [Frame.Vanguard, Frame.Vanguard] }).battle().exposed().place(0, 0, 0).place(1, 300, 300);
  poor.m.plEnergy[0] = VANGUARD.seekers.cost - 1;
  poor.m.plRegenWait[0] = ENERGY_REGEN_DELAY;
  const poorReady = canUseAlt(poor.w, 0);
  const poorSince = poor.tick + 1;
  poor.step(1, seatZero(Button.Alt));
  const poorFired = poor.events(Ev.Fire, poorSince).length;
  poor.m.plEnergy[0] = VANGUARD.seekers.cost;
  const paidReady = canUseAlt(poor.w, 0);
  poor.step(1, seatZero(Button.Alt));
  check('canUseAlt (what the HUD reads) matches the sim: the seekers wait for the energy they cost, then go off',
    !poorReady && poorFired === 0 && paidReady && poor.events(Ev.Fire, poorSince).length === 1 && !canUseAlt(poor.w, 0));
}

section('shield: up whenever the pilot is not attacking; it stops whatever reaches it and energy pays for it');
{
  const fresh = new Scenario({ mode: Mode.Deathmatch, frames: [Frame.Vanguard, Frame.Gale, Frame.Juggernaut] }).battle();
  check('every robot comes into the round with its shield up', [0, 1, 2].every((seat) => fresh.m.plShield[seat] === 1));

  const stats = FRAME_STATS[Frame.Vanguard];
  const s = new Scenario({ mode: Mode.Deathmatch, frames: [Frame.Vanguard, Frame.Vanguard] }).battle().exposed().shields().place(0, 0, 0).place(1, 300, 300);
  s.step();
  check('once shields are allowed again the shield comes straight up, with a ShieldUp event', s.m.plShield[0] === 1 && s.events(Ev.ShieldUp).some((e) => e.a === 0));
  const band = (stats.grazeR + stats.hurtR) / 2;
  const hp = s.m.plHp[0];
  const gauges = [s.m.plGauge[0], s.m.plGauge[1]];
  const since = s.tick + 1;
  const stopped = boltOnto(s, band, 0);
  s.step();
  const hit = s.events(Ev.ShieldHit, since)[0];
  check(`a bolt that would only have grazed (${(band / fx.ONE).toFixed(1)} units out) is stopped at the shield's radius, the graze radius`,
    s.m.pAlive[stopped] === 0 && hit !== undefined && hit.a === 0 && hit.b === bolt.dmg && hit.c === 1 && s.events(Ev.Graze, since).length === 0);
  check(`the pool pays ${SHIELD_COST_PER_DAMAGE} per point of damage (${bolt.dmg * SHIELD_COST_PER_DAMAGE}), the robot is unharmed`, s.m.plEnergy[0] === ENERGY_MAX - bolt.dmg * SHIELD_COST_PER_DAMAGE && s.m.plHp[0] === hp);
  check('the shooter\'s boss gauge earns for the stopped shot as for a hit; the shielded pilot took no damage and earns nothing', s.m.plGauge[0] === gauges[0] && s.m.plGauge[1] - gauges[1] === bolt.dmg * GAUGE_PER_DAMAGE_DEALT);

  s.m.plEnergy[0] = bolt.dmg * SHIELD_COST_PER_DAMAGE + 1;
  boltOnto(s, 0, 0);
  s.step();
  const heldUp = s.m.plShield[0] === 1 && s.m.plEnergy[0] === 1;
  const breakSince = s.tick + 1;
  boltOnto(s, 0, 0);
  s.step();
  const broke = s.events(Ev.ShieldBreak, breakSince)[0];
  check('a pool that can pay keeps the shield up; one that cannot still stops that shot, then the shield shatters and the pool is empty',
    heldUp && broke !== undefined && broke.a === 0 && s.m.plShield[0] === 0 && s.m.plEnergy[0] === 0 && s.m.plShieldBreak[0] === SHIELD_BREAK_TICKS && s.m.plHp[0] === hp);
  const brokeAt = s.tick;
  const exposedHp = s.m.plHp[0];
  boltOnto(s, 0, 0);
  s.step();
  check('while it is broken the core is bare: a bolt on it hurts', s.m.plHp[0] === exposedHp - bolt.dmg);
  s.stepTo(brokeAt + SHIELD_BREAK_TICKS - 1);
  const stillDown = s.m.plShield[0] === 0;
  s.step();
  check(`it comes back ${SHIELD_BREAK_TICKS} ticks after it shattered (the pool refilled meanwhile)`, stillDown && s.m.plShield[0] === 1 && s.m.plEnergy[0] >= SHIELD_RAISE_ENERGY);
}
{
  const s = new Scenario({ mode: Mode.Deathmatch, frames: [Frame.Vanguard, Frame.Vanguard] }).battle().exposed().shields().place(0, 0, 0).place(1, 300, 300);
  s.step();
  const hp = s.m.plHp[0];
  boltOnto(s, 0, 0);
  s.step(1, seatZero(Button.Fire));
  check('attacking drops the shield on that very tick: a bolt reaching the core hurts', s.m.plShield[0] === 0 && s.m.plHp[0] === hp - bolt.dmg);
  s.step(SHIELD_RAISE_TICKS - 1, seatZero(Button.Fire));
  const lastHeld = s.tick;
  s.step(SHIELD_RAISE_TICKS - 1);
  const notYet = s.m.plShield[0] === 0;
  s.step();
  check(`it comes back ${SHIELD_RAISE_TICKS} ticks after the last tick the button was held`, notYet && s.m.plShield[0] === 1 && s.tick - lastHeld === SHIELD_RAISE_TICKS);

  const low = new Scenario({ mode: Mode.Deathmatch, frames: [Frame.Vanguard, Frame.Vanguard] }).battle().exposed().shields().place(0, 0, 0).place(1, 300, 300);
  low.m.plEnergy[0] = SHIELD_RAISE_ENERGY - 1;
  low.m.plRegenWait[0] = ENERGY_REGEN_DELAY;
  low.step(ENERGY_REGEN_DELAY - 1);
  const waiting = low.m.plShield[0] === 0;
  low.step();
  check(`a shield needs ${SHIELD_RAISE_ENERGY} energy to come up: it rises on the tick the refill reaches it`, waiting && low.m.plShield[0] === 1 && low.m.plEnergy[0] === SHIELD_RAISE_ENERGY - 1 + ENERGY_REGEN_PER_TICK);

  const gale = new Scenario({ mode: Mode.Deathmatch, frames: [Frame.Gale, Frame.Vanguard] }).battle().exposed().shields().place(0, 0, 0).place(1, 300, 300);
  gale.step(1);
  gale.step(3, seatZero(Button.Alt, { moveX: MOVE_MAX }));
  check('GALE\'s alt (phase dash) is not an attack: the shield stays up and nothing is paid', gale.m.plShield[0] === 1 && gale.m.plEnergy[0] === ENERGY_MAX);
  const bunker = new Scenario({ mode: Mode.Deathmatch, frames: [Frame.Juggernaut, Frame.Vanguard] }).battle().exposed().shields().place(0, 0, 0).place(1, 300, 300);
  bunker.step(1);
  bunker.step(1, seatZero(Button.Alt));
  const raised = bunker.m.plBulwark[0] > 0 && bunker.m.plShield[0] === 0 && bunker.m.plEnergy[0] === ENERGY_MAX;
  const lastRaised = bunker.tick + bunker.m.plBulwark[0] - 1;
  bunker.stepTo(lastRaised + SHIELD_RAISE_TICKS - 1);
  const stillDown = bunker.m.plShield[0] === 0;
  bunker.step();
  check('JUGGERNAUT\'s bulwark costs nothing but takes the shield\'s place while raised (it covers the front only); the shield returns after it',
    raised && stillDown && bunker.m.plShield[0] === 1, `bulwark ${JUGGERNAUT.bulwark.ticks} ticks, shield back ${SHIELD_RAISE_TICKS} ticks after`);
  const vanguard = new Scenario({ mode: Mode.Deathmatch, frames: [Frame.Vanguard, Frame.Vanguard] }).battle().exposed().shields().place(0, 0, 0).place(1, 300, 300);
  vanguard.step(1);
  vanguard.step(1, seatZero(Button.Alt));
  check('VANGUARD\'s alt (seekers) is an attack: it drops the shield', vanguard.m.plShield[0] === 0);

  const boss = new Scenario({ mode: Mode.Deathmatch, frames: [Frame.Vanguard, Frame.Vanguard] }).battle().exposed().shields().place(0, 0, 0).place(1, 500, 300);
  boss.step();
  const upBefore = boss.m.plShield[0] === 1;
  boss.m.plGauge[0] = GAUGE_MAX;
  boss.step(1, seatZero(Button.Boss));
  const morphing = boss.m.plForm[0] === Form.Morph && boss.m.plShield[0] === 0;
  while (boss.m.plForm[0] !== Form.Boss) boss.step();
  boss.step(30);
  check('transforming drops the shield, and a colossus has none', upBefore && morphing && boss.m.plShield[0] === 0);

  // The colossus folds back while the pool is full: the shield returns at once, even if the pilot was firing when it
  // transformed (its raise delay ran out during the boss form).
  const back = new Scenario({ mode: Mode.Deathmatch, frames: [Frame.Vanguard, Frame.Vanguard] }).battle().exposed().shields().place(0, 0, 0).place(1, 500, 300);
  back.step(1, seatZero(Button.Fire));
  back.transform(0, GAUGE_MAX);
  back.step(SHIELD_RAISE_TICKS);
  back.m.plGauge[0] = 1;
  back.step();
  const folded = back.events(Ev.BossEnd).length === 1 && back.m.plForm[0] === Form.Normal;
  back.step();
  check('a colossus that folds back has its shield up on its first tick as a robot', folded && back.m.plShield[0] === 1, `shield ${back.m.plShield[0]}, wait ${back.m.plShieldWait[0]}`);
}
{
  const top = FRAME_STATS[Frame.Vanguard].speed;
  const boosting = new Scenario({ mode: Mode.Deathmatch, frames: [Frame.Vanguard, Frame.Vanguard] }).battle().exposed().place(0, 0, 0).place(1, 500, 300);
  boosting.m.plGauge[0] = GAUGE_MAX;
  boosting.step(2, seatZero(Button.Boost, { moveX: MOVE_MAX }));
  boosting.step(1, seatZero(Button.Boss));
  check('transforming mid-boost ends the boost: the robot unfolds at no more than its top speed',
    boosting.m.plForm[0] === Form.Morph && boosting.m.plBoost[0] === 0 && speedOf(boosting.w, 0) <= top, `${(speedOf(boosting.w, 0) / fx.ONE).toFixed(2)} u/tick`);

  const dashing = new Scenario({ mode: Mode.Deathmatch, frames: [Frame.Gale, Frame.Vanguard] }).battle().exposed().place(0, 0, 0).place(1, 500, 300);
  dashing.step(1, seatZero(Button.Alt, { moveX: MOVE_MAX }));
  const dashed = dashing.m.plDash[0] > 0;
  dashing.transform(0, GAUGE_MAX);
  dashing.m.plGauge[0] = 1;
  dashing.step(2);
  check('transforming mid-dash ends the phase dash: the robot that folds back does not finish a stale dash',
    dashed && dashing.m.plForm[0] === Form.Normal && dashing.m.plDash[0] === 0 && speedOf(dashing.w, 0) <= FRAME_STATS[Frame.Gale].speed);
}

section('boss gauge: graze, damage dealt and taken and orbs fill it; a boss form burns it and does not earn it');
{
  const s = new Scenario({ frames: [Frame.Vanguard, Frame.Vanguard] }).battle().exposed().place(0, 0, 0).place(1, 300, 0);
  s.shootAt(bolt, 1, 1, 0, 0);
  s.step();
  check('being hit pays 60 per damage point, hitting pays 40', s.m.plGauge[0] === bolt.dmg * GAUGE_PER_DAMAGE_TAKEN && s.m.plGauge[1] === bolt.dmg * GAUGE_PER_DAMAGE_DEALT, `${s.m.plGauge[0]} / ${s.m.plGauge[1]}`);
  const before = s.m.plGauge[0];
  s.spawnOrb(0, 0, ORB_VALUE);
  s.step();
  check('an orb refuels whoever touches it', s.m.plGauge[0] - before === ORB_VALUE && s.m.oAlive.every((alive) => alive === 0));
  s.m.plGauge[0] = GAUGE_MAX - 10;
  s.spawnOrb(0, 0, ORB_VALUE);
  s.step();
  check('the gauge never exceeds full', s.m.plGauge[0] === GAUGE_MAX);

  const boss = new Scenario({ frames: [Frame.Vanguard, Frame.Vanguard] }).battle().exposed().place(0, 0, 0).place(1, 300, 0).transform(0, 60000);
  const chest = FORMS[Frame.Vanguard].parts.findIndex((p) => p.name === 'chest');
  boss.m.ptHp[chest] = 0;
  const fuel = boss.m.plGauge[0];
  boss.shootAt(bolt, 1, 1, 0, 0);
  boss.step();
  check('a boss form burns fuel every tick and earns nothing from being hit', boss.m.plGauge[0] === fuel - BOSS_DRAIN_PER_TICK && boss.m.plHp[0] < FRAME_STATS[Frame.Vanguard].hp);
  const tank = boss.m.plGauge[0];
  boss.spawnOrb(0, 0, ORB_VALUE);
  boss.step();
  check('but orbs still refuel a boss form', boss.m.plGauge[0] === tank + ORB_VALUE - BOSS_DRAIN_PER_TICK && boss.m.plForm[0] === Form.Boss);
}

section('neutral units and orbs');
{
  const s = new Scenario({ frames: [Frame.Vanguard, Frame.Vanguard] }).battle().exposed().place(0, -300, 0).place(1, 300, 0);
  s.m.world[W.WaveTimer] = 1;
  s.step();
  const alive = () => s.m.nAlive.reduce((n, a) => n + a, 0);
  check('a wave of 2 + seats/2 neutral units enters and the next wave is scheduled', alive() === 3 && s.m.world[W.WaveCount] === 1 && s.m.world[W.WaveTimer] === WAVE_INTERVAL_TICKS);
  s.m.nAlive.fill(0);
  s.w.events.clear();

  const hp = s.m.plHp[0];
  s.shootAt(bolt, NO_SEAT, NO_SEAT, -300, 0);
  s.step();
  check('neutral projectiles hurt ships (and credit no seat)', s.m.plHp[0] === hp - bolt.dmg && s.events(Ev.Hit).some((e) => e.c === NO_SEAT));

  const drone = s.spawnNeutral(NeutralType.Drone, 0, 250);
  const shooterGauge = s.m.plGauge[1];
  for (let i = 0; i < 4; i++) {
    s.shootAt(bolt, 1, 1, 0, 250);
    s.step();
  }
  const total = NEUTRAL_DEFS[NeutralType.Drone].hp;
  check('players\' bullets kill a neutral unit, which drops its orbs', s.m.nAlive[drone] === 0 && s.events(Ev.NeutralKilled).length === 1 && s.m.oAlive.reduce((n, a) => n + a, 0) === NEUTRAL_DEFS[NeutralType.Drone].orbs);
  check('and the shooter is paid 40 per point of damage dealt to it', s.m.plGauge[1] - shooterGauge === total * GAUGE_PER_DAMAGE_DEALT, `${s.m.plGauge[1] - shooterGauge}`);
  const untouchable = s.spawnNeutral(NeutralType.Sentinel, 0, -250);
  s.shootAt(bolt, NO_SEAT, NO_SEAT, 0, -250);
  s.step();
  check('neutral projectiles do not hurt neutral units', s.m.nHp[untouchable] === NEUTRAL_DEFS[NeutralType.Sentinel].hp);
  s.m.nAlive.fill(0);
  s.m.world[W.WardenTimer] = 1;
  s.step();
  const wardens = () => s.m.nAlive.reduce((n, a, i) => n + (a === 1 && s.m.nType[i] === NeutralType.Warden ? 1 : 0), 0);
  check('the Warden appears once and is not stacked while it lives', wardens() === 1 && (() => { s.m.world[W.WardenTimer] = 1; s.step(); return wardens() === 1; })());
}

section('a pilot who leaves takes their ship out of the match');
{
  const s = new Scenario({ frames: [Frame.Vanguard, Frame.Gale] }).battle();
  s.step(1, (seat) => (seat === 1 ? holding(Button.Boost, { moveX: MOVE_MAX }) : IDLE));
  const busy = s.m.plBoost[1] > 0 && s.m.plShield[1] === 1;
  s.step(1, undefined, [true, false]);
  check('the departed seat becomes inactive and the round goes to the remaining team', s.m.plActive[1] === 0 && s.m.plAlive[1] === 0 && s.events(Ev.Left).length === 1 && s.m.teamWins[0] === 1 && s.m.world[W.Phase] === Phase.RoundEnd);
  check('a pilot who leaves mid-boost leaves no robot state behind (no shield, no boost, no dash)', busy && s.m.plShield[1] === 0 && s.m.plBoost[1] === 0 && s.m.plDash[1] === 0);
}

info(`${JUGGERNAUT.bulwark.ticks} tick bulwark, ${GALE.dash.ticks} tick dash`);
finish('game-rules');
