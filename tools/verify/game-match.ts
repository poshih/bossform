/**
 * Game rules eval (3/4): match flow (elimination, sudden death, deathmatch, teams) in hand-built situations, then
 * full bot-versus-bot matches on which every rule is watched tick by tick: the speed rule, friendly fire, the
 * damage window, the boss-attack tell, the weight limits, energy, shields and boosts, and basic sanity of the state.
 */
import { fx } from '@metronome/engine';
import {
  Attack, BOSS_KILL_SCORE, DEATHMATCH_TICKS, Ev, Form, FORMS, Frame, FRAME_STATS, KILL_SCORE, MAX_PARTS, MIN_WINDUP_TICKS, Mode, NO_WINNER,
  PartKind, Phase, PROJECTILE_SPEED_CAP, RESPAWN_TICKS, ROOT_BRAKE, ROUND_END_TICKS, ROUNDS_TO_WIN, SAFE_RADIUS_MIN, SHOT_DEFS, SHRINK_TICKS,
  SPAWN_PROTECT_TICKS, SPAWN_RING_PCT, STORM_INTERVAL, SUDDEN_DEATH_TICKS, VANGUARD, W, GAUGE_MAX, arenaRadius, podMuzzle, radial,
  ENERGY_MAX,
} from '../../game/src/sim/index.ts';
import type { GameSim } from '../../game/src/sim/index.ts';
import { freeForAll, rotatingFrames, runBots } from './game-run.ts';
import { Scenario } from './game-scenario.ts';
import { check, finish, info, section } from './lib.ts';

const bolt = VANGUARD.rifle.shot;
const V = Frame.Vanguard;

section('elimination: last team standing wins the round, best of three');
{
  const s = new Scenario({ frames: [V, V, V], teams: [0, 1, 2] }).battle().exposed().place(0, -300, 0).place(1, 0, 0).place(2, 300, 0);
  const round = (winnerSeat: number, others: number[]) => {
    for (const seat of others) {
      s.m.plHp[seat] = 1;
      s.shootAt(bolt, winnerSeat, winnerSeat, s.m.plX[seat] / fx.ONE, s.m.plY[seat] / fx.ONE);
    }
    s.step();
  };
  round(0, [1, 2]);
  const end = s.events(Ev.RoundEnd)[0];
  check('when one team is left the round ends and that team scores it', s.m.world[W.Phase] === Phase.RoundEnd && s.m.teamWins[0] === 1 && end.a === 0 && end.b === 0);
  check('the kills are credited to the shooter', s.m.plKills[0] === 2 && s.m.plDeaths[1] === 1 && s.m.plDeaths[2] === 1);
  s.step(ROUND_END_TICKS);
  check('the next round begins in a countdown with everybody back at full health', s.m.world[W.Round] === 2 && s.m.world[W.Phase] === Phase.Countdown && s.m.plAlive.every((a) => a === 1) && s.m.plHp[1] === FRAME_STATS[V].hp);
  s.battle().exposed().place(0, -300, 0).place(1, 0, 0).place(2, 300, 0);
  round(0, [1, 2]);
  const over = s.events(Ev.RoundEnd).at(-1)!;
  check(`${ROUNDS_TO_WIN} round wins take the match`, s.m.world[W.Phase] === Phase.Over && s.m.world[W.Winner] === 0 && over.b === 1);
}
{
  const s = new Scenario({ frames: [V, V] }).battle().exposed().place(0, -100, 0).place(1, 100, 0);
  s.m.plHp[0] = 1;
  s.m.plHp[1] = 1;
  s.shootAt(bolt, 1, 1, -100, 0);
  s.shootAt(bolt, 0, 0, 100, 0);
  s.step();
  check('if the last two ships fall on the same tick the round is a draw: nobody scores', s.m.world[W.Phase] === Phase.RoundEnd && s.m.teamWins[0] === 0 && s.m.teamWins[1] === 0 && s.events(Ev.RoundEnd)[0].a === NO_WINNER);
}
{
  const s = new Scenario({ frames: [V, V, V, V], teams: [0, 0, 1, 1] }).battle().exposed();
  s.m.plHp[2] = 1;
  s.m.plHp[3] = 1;
  s.shootAt(bolt, 0, 0, s.m.plX[2] / fx.ONE, s.m.plY[2] / fx.ONE);
  s.step();
  check('a team fights on while any member lives: no round end after one of two falls', s.m.world[W.Phase] === Phase.Battle && s.m.plAlive[2] === 0);
  s.shootAt(bolt, 0, 0, s.m.plX[3] / fx.ONE, s.m.plY[3] / fx.ONE);
  s.step();
  check('and the round is won when the whole opposing team has fallen', s.m.world[W.Phase] === Phase.RoundEnd && s.m.teamWins[0] === 1);
}
{
  const s = new Scenario({ frames: [V, V, V, V], teams: [0, 1, 0, 1] });
  const at = (seat: number) => Math.atan2(s.m.plY[seat], s.m.plX[seat]);
  const gap = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(at(a) - at(b)), Math.cos(at(a) - at(b))));
  check('teammates start next to each other on the ring, facing the centre', gap(0, 2) < gap(0, 1) && gap(1, 3) < gap(1, 0) && Math.abs(radial(s.m.plX[0], s.m.plY[0]) - Math.floor((arenaRadius(4) * SPAWN_RING_PCT) / 100)) < fx.fromInt(1));
}

section('sudden death: the safe zone shrinks and the storm ignores the damage window');
{
  const s = new Scenario({ frames: [V, V] }).battle().exposed().place(0, 250, 0).place(1, 0, 0);
  s.m.world[W.RoundTick] = SUDDEN_DEATH_TICKS - 1;
  s.step();
  check('sudden death begins with the safe zone at full size', s.events(Ev.StormStart).length === 1 && s.m.world[W.SafeR] === arenaRadius(2));
  s.m.world[W.RoundTick] = SUDDEN_DEATH_TICKS + SHRINK_TICKS - 1;
  s.step();
  check('after the shrink time the safe zone has its minimum radius', s.m.world[W.SafeR] === SAFE_RADIUS_MIN);
  const hp = s.m.plHp[0];
  const safe = s.m.plHp[1];
  const from = s.tick + 1;
  s.step(STORM_INTERVAL * 10);
  const storm = s.events(Ev.StormHit, from).filter((e) => e.a === 0);
  check('a ship outside the safe zone is hurt steadily, the one inside is not, and the damage window is not involved',
    hp - s.m.plHp[0] === 10 && storm.length === 10 && safe === s.m.plHp[1] && s.m.plWinDmg[0] === 0 && s.events(Ev.Blocked).length === 0, `${hp - s.m.plHp[0]} damage`);
  s.m.plHp[0] = 1;
  s.m.plLastHit[0] = 1;
  s.m.plLastHitAt[0] = s.tick;
  s.step(STORM_INTERVAL);
  check('a ship the storm finishes is credited to whoever last hurt it', s.m.plAlive[0] === 0 && s.m.plKills[1] === 1);
}

section('deathmatch: respawns, team score, time limit');
{
  const s = new Scenario({ mode: Mode.Deathmatch, frames: [V, V, V], teams: [0, 1, 2] }).battle().exposed().place(0, 0, 0).place(1, 300, 0).place(2, -300, 0);
  s.m.plHp[1] = 1;
  s.shootAt(bolt, 0, 0, 300, 0);
  s.step();
  check('a kill scores for the killer\'s team and the dead ship waits for its respawn', s.m.teamScore[0] === KILL_SCORE && s.m.plAlive[1] === 0 && s.m.plRespawn[1] === RESPAWN_TICKS && s.m.world[W.Phase] === Phase.Battle);
  const epoch = s.m.plEpoch[1];
  s.step(RESPAWN_TICKS);
  check('after the delay it returns at full health, protected, with a Respawn event', s.m.plAlive[1] === 1 && s.m.plHp[1] === FRAME_STATS[V].hp && s.m.plInvuln[1] === SPAWN_PROTECT_TICKS && s.events(Ev.Respawn).length === 1 && s.m.plEpoch[1] === epoch + 1);
  const ring = (arenaRadius(3) * SPAWN_RING_PCT) / 100 / fx.ONE;
  const distances = Array.from({ length: 16 }, (_, k) => {
    const cx = Math.cos((2 * Math.PI * k) / 16) * ring;
    const cy = Math.sin((2 * Math.PI * k) / 16) * ring;
    return Math.min(Math.hypot(cx - s.m.plX[0] / fx.ONE, cy - s.m.plY[0] / fx.ONE), Math.hypot(cx - s.m.plX[2] / fx.ONE, cy - s.m.plY[2] / fx.ONE));
  });
  const mine = Math.min(Math.hypot(s.m.plX[1] / fx.ONE - s.m.plX[0] / fx.ONE, s.m.plY[1] / fx.ONE - s.m.plY[0] / fx.ONE), Math.hypot(s.m.plX[1] / fx.ONE - s.m.plX[2] / fx.ONE, s.m.plY[1] / fx.ONE - s.m.plY[2] / fx.ONE));
  check('it reappears on the spawn ring at the point farthest from the opposing ships', Math.abs(Math.hypot(s.m.plX[1], s.m.plY[1]) / fx.ONE - ring) < 1 && mine >= Math.max(...distances) - 1, `${mine.toFixed(0)} vs best ${Math.max(...distances).toFixed(0)}`);

  const boss = new Scenario({ mode: Mode.Deathmatch, frames: [V, V], teams: [0, 1] }).battle().exposed().place(0, 0, 0).place(1, 600, 0).transform(0, GAUGE_MAX);
  boss.m.ptHp[0] = 0;
  boss.m.plHp[0] = 1;
  boss.shootAt(bolt, 1, 1, 0, 0);
  boss.step();
  check('killing a boss form is worth more', boss.m.teamScore[1] === BOSS_KILL_SCORE && BOSS_KILL_SCORE > KILL_SCORE);

  const timed = new Scenario({ mode: Mode.Deathmatch, frames: [V, V], teams: [0, 1] }).battle().exposed();
  timed.m.teamScore[0] = 3;
  timed.m.teamScore[1] = 1;
  timed.m.world[W.RoundTick] = DEATHMATCH_TICKS - 1;
  timed.step();
  check('at the time limit the highest team score wins', timed.m.world[W.Phase] === Phase.Over && timed.m.world[W.Winner] === 0);
  const tied = new Scenario({ mode: Mode.Deathmatch, frames: [V, V], teams: [0, 1] }).battle().exposed();
  tied.m.teamScore[0] = 2;
  tied.m.teamScore[1] = 2;
  tied.m.world[W.RoundTick] = DEATHMATCH_TICKS - 1;
  tied.step();
  check('a tie at the limit is a draw', tied.m.world[W.Phase] === Phase.Over && tied.m.world[W.Winner] === NO_WINNER);
}

// ---------------------------------------------------------------------------------------------------
// Full matches, watched tick by tick
// ---------------------------------------------------------------------------------------------------

/** Shrapnel is born where its parent burst, not at a muzzle, so it is exempt from the muzzle-origin check. */
const BURST_CHILDREN = new Set(SHOT_DEFS.flatMap((d) => (d.burst === null ? [] : [d.burst.shot.id])));

class Watch {
  readonly problems: string[] = [];
  readonly shots = { player: 0, boss: 0, neutral: 0, seeker: 0, burstBorn: 0 };
  readonly kinds = new Set<number>();
  readonly counts = new Map<number, number>();
  readonly attacksSeen = new Set<number>();
  bossTicks = 0;
  muzzleChecks = 0;
  private readonly prevX: Int32Array;
  private readonly prevY: Int32Array;
  private readonly prevAge: Int32Array;
  private readonly prev: { form: Uint8Array; body: Int32Array; vx: Int32Array; vy: Int32Array; pod: Int32Array };
  private readonly windowEnd: number[];
  private readonly windowSum: number[];
  private readonly windup: number[][];

  constructor(sim: GameSim) {
    const w = sim.world;
    this.prevX = new Int32Array(w.cap.projectiles);
    this.prevY = new Int32Array(w.cap.projectiles);
    this.prevAge = new Int32Array(w.cap.projectiles);
    this.prev = { form: new Uint8Array(w.seats), body: new Int32Array(w.seats), vx: new Int32Array(w.seats), vy: new Int32Array(w.seats), pod: new Int32Array(w.cap.parts) };
    this.windowEnd = new Array<number>(w.seats).fill(0);
    this.windowSum = new Array<number>(w.seats).fill(0);
    this.windup = Array.from({ length: w.seats }, () => new Array<number>(4).fill(-1));
  }

  private fail(message: string): void {
    if (this.problems.length < 8) this.problems.push(message);
  }

  onTick(sim: GameSim, tick: number): void {
    const w = sim.world;
    const { m } = w;
    const q = w.events;
    const siegeRelease = new Set<number>();
    for (let e = 0; e < q.count; e++) {
      const type = q.type[e];
      this.counts.set(type, (this.counts.get(type) ?? 0) + 1);
      if (type === Ev.Windup) {
        this.windup[q.a[e]][q.b[e]] = tick;
        this.attacksSeen.add(q.b[e]);
      } else if (type === Ev.Release && q.b[e] === Attack.Siege) siegeRelease.add(q.a[e]);
      else if (type === Ev.Hit) {
        const seat = q.a[e];
        const stats = FRAME_STATS[m.plFrame[seat]];
        if (tick >= this.windowEnd[seat]) {
          this.windowEnd[seat] = tick + stats.windowTicks;
          this.windowSum[seat] = 0;
        }
        this.windowSum[seat] += q.b[e];
        if (this.windowSum[seat] > stats.windowCap) this.fail(`tick ${tick}: seat ${seat} took ${this.windowSum[seat]} in one window (cap ${stats.windowCap})`);
        if (q.c[e] >= 0 && m.plTeam[q.c[e]] === m.plTeam[seat]) this.fail(`tick ${tick}: friendly fire, seat ${q.c[e]} hurt seat ${seat}`);
      }
    }
    q.clear();

    const tolerance = Math.floor(PROJECTILE_SPEED_CAP * 1.01) + 2;
    for (let p = 0; p < w.cap.projectiles; p++) {
      if (m.pAlive[p] !== 1) {
        this.prevAge[p] = 0;
        continue;
      }
      const def = SHOT_DEFS[m.pDef[p]];
      if (m.pSpd[p] > PROJECTILE_SPEED_CAP) this.fail(`tick ${tick}: projectile speed ${m.pSpd[p] / fx.ONE} exceeds the cap`);
      if (this.prevAge[p] === m.pAge[p] - 1 && m.pAge[p] >= 2) {
        const moved = Math.hypot(m.pX[p] - this.prevX[p], m.pY[p] - this.prevY[p]);
        if (moved > tolerance) this.fail(`tick ${tick}: a projectile moved ${(moved / fx.ONE).toFixed(2)} units in one tick`);
      }
      if (m.pAge[p] === 1) {
        this.kinds.add(def.kind);
        if (m.pAttack[p] !== 0) {
          this.shots.boss++;
          const seat = m.pOwner[p];
          const started = this.windup[seat][m.pAttack[p]];
          // Shrapnel is born where its shell bursts, possibly during the NEXT wind-up of the same attack: the shell itself was
          // checked (tell and muzzle) when it was launched.
          if (!BURST_CHILDREN.has(def.id)) {
            if (started < 0 || tick - started < MIN_WINDUP_TICKS[m.pAttack[p]]) this.fail(`tick ${tick}: a boss attack ${m.pAttack[p]} shot (blueprint ${def.id}) appeared ${tick - started} ticks after its wind-up began`);
            this.checkMuzzle(sim, p, tick);
          }
        } else if (m.pOwner[p] < 0) this.shots.neutral++;
        else this.shots.player++;
        if ((def.flags & 1) !== 0) this.shots.seeker++;
      }
      this.prevX[p] = m.pX[p];
      this.prevY[p] = m.pY[p];
      this.prevAge[p] = m.pAge[p];
    }

    for (let seat = 0; seat < w.seats; seat++) this.checkShip(sim, seat, tick, siegeRelease.has(seat));
  }

  private checkMuzzle(sim: GameSim, p: number, tick: number): void {
    const w = sim.world;
    const { m } = w;
    const seat = m.pOwner[p];
    const part = m.pPart[p] - 1;
    const form = FORMS[m.plFrame[seat]];
    if (m.plForm[seat] !== Form.Boss || m.plAlive[seat] === 0) return;
    const limit = fx.fromInt(8);
    if (part < 0) {
      this.fail(`tick ${tick}: a boss shot with no pod (every boss projectile must leave a live pod's muzzle)`);
      return;
    }
    if (form.parts[part].kind !== PartKind.Pod) {
      this.fail(`tick ${tick}: a boss shot claims to come from an armour plate`);
      return;
    }
    if (m.ptHp[w.partBase(seat) + part] <= 0) return;
    const at = { x: 0, y: 0 };
    podMuzzle(sim.world, seat, part, at);
    this.muzzleChecks++;
    const off = Math.hypot(m.pX[p] - at.x, m.pY[p] - at.y);
    if (off > limit) this.fail(`tick ${tick}: ${form.name} seat ${seat} pod ${form.parts[part].name} shot ${(off / fx.ONE).toFixed(1)} units from its muzzle (attack ${m.pAttack[p]}, ship at ${(radial(m.plX[seat], m.plY[seat]) / fx.ONE).toFixed(0)} of ${(w.arenaR / fx.ONE).toFixed(0)}, v ${(Math.hypot(m.plVX[seat], m.plVY[seat]) / fx.ONE).toFixed(2)})`);
  }

  private checkShip(sim: GameSim, seat: number, tick: number, siegeReleased: boolean): void {
    const w = sim.world;
    const { m } = w;
    const stats = FRAME_STATS[m.plFrame[seat]];
    const base = w.partBase(seat);
    if (m.plGauge[seat] < 0 || m.plGauge[seat] > GAUGE_MAX) this.fail(`tick ${tick}: seat ${seat} gauge ${m.plGauge[seat]} out of range`);
    if (m.plHp[seat] > stats.hp) this.fail(`tick ${tick}: seat ${seat} above full health`);
    if (m.plAlive[seat] === 1 && radial(m.plX[seat], m.plY[seat]) > w.arenaR + fx.fromInt(1)) this.fail(`tick ${tick}: seat ${seat} left the arena`);
    if (m.plAlive[seat] === 0 && m.plForm[seat] !== Form.Normal) this.fail(`tick ${tick}: a destroyed ship is still transformed`);
    if (m.plEnergy[seat] < 0 || m.plEnergy[seat] > ENERGY_MAX) this.fail(`tick ${tick}: seat ${seat} energy ${m.plEnergy[seat]} out of range`);
    if (m.plShield[seat] === 1 && (m.plForm[seat] !== Form.Normal || m.plAlive[seat] === 0 || m.plEnergy[seat] <= 0)) this.fail(`tick ${tick}: seat ${seat} has a shield without being a living robot with energy`);
    if (m.plShield[seat] === 1 && m.plBulwark[seat] > 0) this.fail(`tick ${tick}: seat ${seat} has its shield up behind a raised bulwark (the bulwark takes its place)`);
    if (m.plBoost[seat] > 0 && (m.plForm[seat] !== Form.Normal || m.plAlive[seat] === 0)) this.fail(`tick ${tick}: seat ${seat} boosts without being a living robot`);
    if (m.plBoost[seat] > 0 && Math.hypot(m.plVX[seat], m.plVY[seat]) > FRAME_STATS[m.plFrame[seat]].boost.speed * TRIG_LENGTH_TOLERANCE) this.fail(`tick ${tick}: seat ${seat} boosts faster than its boost speed`);
    const boss = m.plForm[seat] === Form.Boss && m.plAlive[seat] === 1;
    if (boss) {
      const form = FORMS[m.plFrame[seat]];
      this.bossTicks++;
      if (this.prev.form[seat] === Form.Boss) {
        if (Math.abs(fx.angleDiff(this.prev.body[seat], m.plBody[seat])) > form.bodyTurn) this.fail(`tick ${tick}: ${form.name} body turned faster than ${form.bodyTurn}`);
        form.parts.forEach((part, k) => {
          if (part.kind === PartKind.Pod && m.ptHp[base + k] > 0 && Math.abs(fx.angleDiff(this.prev.pod[base + k], m.ptAng[base + k])) > part.turn) this.fail(`tick ${tick}: ${form.name} pod ${part.name} turned faster than its limit`);
        });
        const dv = Math.hypot(m.plVX[seat] - this.prev.vx[seat], m.plVY[seat] - this.prev.vy[seat]);
        const nearRim = radial(m.plX[seat], m.plY[seat]) > w.arenaR - form.reach - fx.fromInt(10);
        const allowed = Math.max(form.accel, ROOT_BRAKE) + (siegeReleased ? form.siege.recoil * form.parts.length : 0) + 4;
        if (!nearRim && dv > allowed) this.fail(`tick ${tick}: ${form.name} changed velocity by ${(dv / fx.ONE).toFixed(2)} in one tick`);
      }
    }
    this.prev.form[seat] = boss ? Form.Boss : m.plForm[seat];
    this.prev.body[seat] = m.plBody[seat];
    this.prev.vx[seat] = m.plVX[seat];
    this.prev.vy[seat] = m.plVY[seat];
    for (let k = 0; k < MAX_PARTS; k++) this.prev.pod[base + k] = m.ptAng[base + k];
  }
}


const MATCHES = [
  { name: 'deathmatch, 8 pilots, free-for-all', mode: Mode.Deathmatch, frames: rotatingFrames(8), teams: freeForAll(8), ticks: DEATHMATCH_TICKS + 400, seed: 11 },
  { name: 'elimination, 2 v 2', mode: Mode.Elimination, frames: rotatingFrames(4, 1), teams: [0, 0, 1, 1], ticks: 40000, seed: 5 },
  { name: 'elimination, 3 pilots, free-for-all', mode: Mode.Elimination, frames: rotatingFrames(3), teams: freeForAll(3), ticks: 40000, seed: 8 },
] as const;

/** A heading's fixed-point unit vector (sine and cosine tables) may be up to about 1e-5 longer than 1. */
const TRIG_LENGTH_TOLERANCE = 1.0001;

const totals = { morphs: new Set<number>(), attacks: new Set<number>(), partsDown: 0, deaths: 0, boss: 0, neutral: 0, player: 0, seeker: 0 };
for (const spec of MATCHES) {
  section(`full match: ${spec.name}`);
  let watch: Watch | null = null;
  const run = runBots({
    ...spec,
    onTick: (sim, tick) => {
      watch ??= new Watch(sim);
      watch.onTick(sim, tick);
      const m = sim.world.m;
      for (let seat = 0; seat < sim.world.seats; seat++) if (m.plForm[seat] === Form.Boss) totals.morphs.add(m.plFrame[seat]);
    },
  });
  const w = watch!;
  const m = run.sim.world.m;
  const phase = m.world[W.Phase];
  check('the match reaches its end by the rules', phase === Phase.Over, `phase ${phase}, ${run.session.tick} ticks (${(run.session.tick / 3600).toFixed(1)} min), winner team ${m.world[W.Winner]}`);
  check('every rule held on every tick: speed cap, damage window, friendly fire, tell, weight, arena, ranges', w.problems.length === 0, w.problems.join(' | '));
  check('the projectile pool never ran dry', m.world[W.Dropped] === 0);
  w.attacksSeen.forEach((a) => totals.attacks.add(a));
  totals.partsDown += w.counts.get(Ev.PartDown) ?? 0;
  totals.deaths += w.counts.get(Ev.Death) ?? 0;
  totals.boss += w.shots.boss;
  totals.neutral += w.shots.neutral;
  totals.player += w.shots.player;
  totals.seeker += w.shots.seeker;
  info(`${w.shots.player} pilot shots, ${w.shots.boss} boss shots, ${w.shots.neutral} neutral shots; ${w.counts.get(Ev.MorphStart) ?? 0} transformations, ${w.counts.get(Ev.PartDown) ?? 0} parts destroyed, ${w.counts.get(Ev.Death) ?? 0} deaths, ${w.counts.get(Ev.NeutralKilled) ?? 0} neutrals killed, ${w.counts.get(Ev.Graze) ?? 0} grazes`);
  info(`${w.bossTicks} boss-form pilot-ticks and ${w.muzzleChecks} pod-origin checks watched; ${w.kinds.size} projectile kinds seen; ${run.msPerTick.toFixed(3)} ms/tick with bots`);
}

section('coverage of the watched matches (so the rule checks above were not vacuous)');
check('all three colossi appeared', totals.morphs.size === 3);
check('salvo, siege shot and ultima were all used', totals.attacks.has(Attack.Salvo) && totals.attacks.has(Attack.Siege) && totals.attacks.has(Attack.Ultima), [...totals.attacks].join(','));
check('pilots, boss forms, neutral units and seekers all fired', totals.player > 0 && totals.boss > 0 && totals.neutral > 0 && totals.seeker > 0);
check('boss parts were destroyed and pilots were killed', totals.partsDown > 0 && totals.deaths > 0);

finish('game-match');
