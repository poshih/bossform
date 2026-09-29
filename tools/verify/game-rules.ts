/**
 * Game rules eval (1/4): the rules that are not about boss forms or match flow, each checked by running the real
 * simulation in a hand-built situation: authoring-time definitions, configuration, the damage window, graze,
 * teams, protection, energy, neutral units, orbs and departing pilots.
 */
import { fx } from '@metronome/engine';
import {
  Attack, Button, decodeConfig, encodeConfig, Ev, FORMS, Form, FRAME_STATS, Frame, GALE, GAUGE_MAX, GAUGE_PER_DAMAGE_DEALT,
  GAUGE_PER_DAMAGE_TAKEN, GAUGE_PER_GRAZE, JUGGERNAUT, MIN_WINDUP_TICKS, Mode, NEUTRAL_DEFS, NeutralType, NO_SEAT, ORB_VALUE, Phase,
  PROJECTILE_SPEED_CAP, SHOT_DEFS, ShotFlag, VANGUARD, W, WAVE_INTERVAL_TICKS, BOSS_DRAIN_PER_TICK,
} from '../../game/src/sim/index.ts';
import { shot } from '../../game/src/sim/shots.ts';
import { holding, IDLE, Scenario } from './game-scenario.ts';
import { check, finish, info, section } from './lib.ts';

const FRAME_NAMES = ['VANGUARD', 'GALE', 'JUGGERNAUT'];
const bolt = VANGUARD.rifle.shot;
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

section('bulwark: the heavy bunker swallows bullets into energy');
{
  const s = new Scenario({ frames: [Frame.Juggernaut, Frame.Vanguard] }).battle().exposed().place(0, 0, 0).place(1, 300, 0);
  s.step(1, (seat) => (seat === 0 ? holding(Button.Alt, { aim: 0 }) : IDLE));
  const front = s.shootAt(bolt, 1, 1, 20, 0);
  const behind = s.shootAt(bolt, 1, 1, -20, 0);
  s.m.pAng[behind] = fx.ANGLE_HALF;
  s.m.pX[behind] = fx.fromInt(-20) + bolt.spd;
  const hp = s.m.plHp[0];
  s.step();
  check('a bullet inside the wedge in front is absorbed and pays energy, without harm', s.m.pAlive[front] === 0 && s.events(Ev.Absorb).length === 1 && s.m.plHp[0] === hp && s.m.plGauge[0] > 0);
  check('a bullet behind the ship is not absorbed', s.m.pAlive[behind] === 1);
}

section('energy: graze, damage dealt and taken and orbs fill the gauge; a boss form burns it and does not earn it');
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
  s.step(1, undefined, [true, false]);
  check('the departed seat becomes inactive and the round goes to the remaining team', s.m.plActive[1] === 0 && s.m.plAlive[1] === 0 && s.events(Ev.Left).length === 1 && s.m.teamWins[0] === 1 && s.m.world[W.Phase] === Phase.RoundEnd);
}

info(`${JUGGERNAUT.bulwark.ticks} tick bulwark, ${GALE.dash.ticks} tick dash`);
finish('game-rules');
