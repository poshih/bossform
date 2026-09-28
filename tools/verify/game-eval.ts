/**
 * Game eval: drives the REAL simulation (autopilot + scenario hooks) and checks every mechanic end to end,
 * then proves the determinism properties on the real game: audit, replay, and lockstep over a hostile network.
 */
import { auditDeterminism, createSession, decodeReplay, hashEquals, hashToString, playReplay, SimulatedNetwork, TickClock } from '@metronome/engine';
import type { Session } from '@metronome/engine';
import {
  createGameSim, Ev, EnemyFlag, EnemyType, Frame, gameCodec, GAUGE_MAX, MAX_BULLETS, Phase, STAGE_COUNT, W,
} from '../../game/src/sim/index.ts';
import type { GameInput, GameSim } from '../../game/src/sim/index.ts';
import { STAGE_SCRIPTS, Op, STEP_SIZE } from '../../game/src/sim/stages.ts';
import { gameParams, runBots, scriptFromReplay } from './game-run.ts';
import { check, finish, info, section } from './lib.ts';

function drainEvents(sim: GameSim, into: Map<number, number>): void {
  const q = sim.world.events;
  for (let i = 0; i < q.count; i++) into.set(q.type[i], (into.get(q.type[i]) ?? 0) + 1);
  q.clear();
}

function jumpToBoss(sim: GameSim): void {
  const wv = sim.world.m.world;
  const script = STAGE_SCRIPTS[wv[W.Stage]];
  for (let at = 0; at < script.length; at += STEP_SIZE) {
    if (script[at] === Op.Boss) {
      wv[W.ScriptPtr] = at;
      wv[W.ScriptTimer] = 0;
      wv[W.Phase] = Phase.Play;
      return;
    }
  }
  throw new Error('stage has no boss');
}

const FRAME_NAMES = ['VANGUARD', 'GALE', 'JUGGERNAUT'];

section('autopilot plays each frame (solo, normal difficulty)');
for (const frame of [Frame.Vanguard, Frame.Gale, Frame.Juggernaut]) {
  const events = new Map<number, number>();
  let maxBullets = 0;
  let bossModes = 0;
  const run = runBots({
    seats: 1, frames: [frame], ticks: 9000,
    onTick: (sim) => {
      const m = sim.world.m;
      maxBullets = Math.max(maxBullets, MAX_BULLETS - m.world[W.BulletFree]);
      drainEvents(sim, events);
    },
  });
  bossModes = events.get(Ev.TransformDone) ?? 0;
  const m = run.sim.world.m;
  check(`${FRAME_NAMES[frame]}: survives and progresses`, m.plLives[0] > 0 || m.world[W.Stage] > 0, `stage ${m.world[W.Stage] + 1}, phase ${m.world[W.Phase]}, lives ${m.plLives[0]}, hp ${m.plHp[0]}, score ${m.plScore[0]}`);
  check(`${FRAME_NAMES[frame]}: kills, grazes and transforms into boss mode`, m.plKills[0] > 20 && m.plGraze[0] > 0 && bossModes >= 1, `kills ${m.plKills[0]}, grazes ${m.plGraze[0]}, transforms ${bossModes}, ends ${events.get(Ev.BossModeEnd) ?? 0}, orbs ${events.get(Ev.OrbPickup) ?? 0}`);
  info(`${run.msPerTick.toFixed(3)} ms/tick avg, ${run.worstMs.toFixed(2)} ms worst, peak ${maxBullets} bullets on screen`);
}

section('every boss: phases, defeat, stage clear, progression');
for (let stage = 0; stage < STAGE_COUNT; stage++) {
  const events = new Map<number, number>();
  const phasesSeen = new Set<number>();
  let cleared = false;
  let nextStageIntro = false;
  const bossType = EnemyType.Bulwark + stage;
  const run = runBots({
    seats: 1, frames: [stage % 3], ticks: 2400, stage,
    onTick: (sim, tick) => {
      const m = sim.world.m;
      if (tick === 5) jumpToBoss(sim);
      drainEvents(sim, events);
      const slot = m.world[W.BossSlot];
      if (slot >= 0 && m.eType[slot] === bossType) {
        phasesSeen.add(m.ePhase[slot]);
        // Scripted damage so the run reaches every phase quickly and deterministically.
        if ((m.eFlags[slot] & EnemyFlag.Invulnerable) === 0) {
          const hp = m.eHp[slot];
          const max = m.eMaxHp[slot];
          if (m.ePhase[slot] === 0 && hp * 100 > max * 60) m.eHp[slot] = Math.floor((max * 60) / 100);
          else if (m.ePhase[slot] === 1 && hp * 100 > max * 30) m.eHp[slot] = Math.floor((max * 30) / 100);
          else if (m.ePhase[slot] === 2 && m.eAge[slot] > 400) m.eHp[slot] = 1;
        }
      }
      if (m.world[W.Phase] === Phase.Clear) cleared = true;
      if (cleared && (m.world[W.Phase] === Phase.Intro || m.world[W.Phase] === Phase.Win)) nextStageIntro = true;
    },
  });
  const m = run.sim.world.m;
  check(`stage ${stage + 1}: boss ${['BULWARK', 'SERAPH', 'OVERLORD'][stage]} shows all 3 phases`, phasesSeen.size === 3, `phases ${[...phasesSeen].join(',')}, phase-change events ${events.get(Ev.BossPhase) ?? 0}`);
  check(`stage ${stage + 1}: boss defeat -> stage clear -> ${stage + 1 < STAGE_COUNT ? 'next stage' : 'victory'}`,
    (events.get(Ev.BossDefeated) ?? 0) === 1 && (events.get(Ev.StageClear) ?? 0) === 1 && nextStageIntro && (stage + 1 < STAGE_COUNT ? m.world[W.Stage] === stage + 1 : m.world[W.Phase] === Phase.Win),
    `defeated ${events.get(Ev.BossDefeated) ?? 0}, clear ${events.get(Ev.StageClear) ?? 0}, now stage ${m.world[W.Stage] + 1} phase ${m.world[W.Phase]}, victory ${events.get(Ev.Victory) ?? 0}`);
}

section('game over');
{
  const events = new Map<number, number>();
  const run = runBots({
    seats: 1, frames: [Frame.Gale], ticks: 3000,
    onTick: (sim, tick) => {
      const m = sim.world.m;
      drainEvents(sim, events);
      // Take away every defence: no lives, one hit point, no i-frames, and the bot stands still.
      if (tick === 300) {
        m.plLives[0] = 1;
        m.plHp[0] = 1;
      }
      if (tick > 300) {
        m.plInvuln[0] = 0;
        m.plAltFx[0] = 0;
        m.plX[0] = 0;
        m.plY[0] = 0;
      }
    },
  });
  check('all lives lost -> game over phase and event', run.sim.world.m.world[W.Phase] === Phase.Over && (events.get(Ev.GameOver) ?? 0) === 1, `phase ${run.sim.world.m.world[W.Phase]}`);
}

section('boss mode rules (VANGUARD, forced gauge)');
{
  // The field is emptied (Clear phase, endless timer) so nothing extends or interrupts the timer.
  const events = new Map<number, number>();
  let transformStart = -1;
  let doneAt = -1;
  let endAt = -1;
  let damagedWhileTransforming = false;
  let gaugeAfterEnd = -1;
  runBots({
    seats: 1, frames: [Frame.Vanguard], ticks: 1500,
    onTick: (sim, tick) => {
      const m = sim.world.m;
      drainEvents(sim, events);
      if (tick === 5) {
        m.world[W.Phase] = Phase.Clear;
        m.world[W.PhaseTimer] = 1_000_000;
      }
      if (tick === 200) m.plGauge[0] = GAUGE_MAX;
      if (m.plTransform[0] > 0 && m.plHp[0] < 100) damagedWhileTransforming = true;
      if (transformStart < 0 && m.plBoss[0] > 0) transformStart = tick;
      if (doneAt < 0 && transformStart >= 0 && m.plTransform[0] === 0 && m.plBoss[0] > 0) doneAt = tick;
      if (endAt < 0 && transformStart >= 0 && m.plBoss[0] === 0) {
        endAt = tick;
        gaugeAfterEnd = m.plGauge[0];
      }
    },
  });
  check('pressing BOSS with a full gauge transforms (rooted, then active)', transformStart >= 200 && transformStart <= 204 && doneAt - transformStart >= 44 && doneAt - transformStart <= 48, `start ${transformStart}, done ${doneAt}`);
  check('boss mode lasts exactly BOSS_MODE_TICKS (11 s) then reverts with an empty gauge', endAt - doneAt === 660 && gaugeAfterEnd === 0, `duration ${endAt - doneAt} ticks, gauge after ${gaugeAfterEnd}`);
  check('transform start / done / end each fire exactly once', (events.get(Ev.TransformStart) ?? 0) === 1 && (events.get(Ev.TransformDone) ?? 0) === 1 && (events.get(Ev.BossModeEnd) ?? 0) === 1);
  check('no damage is taken while transforming', !damagedWhileTransforming);
}

section('boss mode is extended by kills but capped');
{
  let peak = 0;
  let doneAt = -1;
  let endAt = -1;
  runBots({
    seats: 1, frames: [Frame.Gale], ticks: 3000,
    onTick: (sim, tick) => {
      const m = sim.world.m;
      if (tick === 195) m.plGauge[0] = GAUGE_MAX;
      peak = Math.max(peak, m.plBoss[0]);
      if (doneAt < 0 && m.plBoss[0] > 0 && m.plTransform[0] === 0) doneAt = tick;
      if (endAt < 0 && doneAt >= 0 && m.plBoss[0] === 0) endAt = tick;
    },
  });
  check('killing while transformed extends boss mode beyond 660 ticks; the remaining time never exceeds the cap', endAt - doneAt > 660 && peak <= 900, `lasted ${endAt - doneAt} ticks, peak remaining ${peak}`);
}

section('boss mode requires a full gauge');
{
  let transformed = false;
  runBots({
    seats: 1, frames: [Frame.Gale], ticks: 400,
    onTick: (sim, tick) => {
      const m = sim.world.m;
      if (tick < 380) m.plGauge[0] = Math.min(m.plGauge[0], GAUGE_MAX - 1);
      if (m.plBoss[0] > 0) transformed = true;
    },
  });
  check('with the gauge held below 100% the boss button does nothing', !transformed);
}

section('determinism on the real game');
{
  const solo = runBots({ seats: 1, frames: [Frame.Vanguard], ticks: 6000, stage: 0 });
  const coop = runBots({ seats: 2, frames: [Frame.Gale, Frame.Juggernaut], ticks: 6000, difficulty: 2 });
  for (const [name, run] of [['solo VANGUARD', solo], ['co-op GALE + JUGGERNAUT (hard)', coop]] as const) {
    const script = scriptFromReplay(run.replay);
    const report = auditDeterminism({
      factory: createGameSim, codec: gameCodec, params: script.params, ticks: script.ticks, inputAt: script.inputAt, restoreEvery: 400, fingerprintEvery: 60,
    });
    check(`${name}: twin runs, snapshot/restore parity and tripwires`, report.ok, report.failures.join('; '));
    info(`${script.ticks} ticks, final ${hashToString(report.finalHash)}, ${report.restoreChecks} restore checks, replay ${run.replay.length} bytes`);
    const replay = playReplay(decodeReplay(run.replay), createGameSim, gameCodec);
    check(`${name}: replay reproduces every checkpoint and the final state`, replay.ok && hashEquals(replay.finalHash, run.sim.memory.hash()), replay.mismatch ? `diverged @${replay.mismatch.tick}` : '');
  }

  // Lockstep: two machines, each owning one seat, over a hostile network, must equal the ideal local run.
  const script = scriptFromReplay(coop.replay);
  const delay = 8;
  const params = { ...gameParams({ seats: 2, frames: [Frame.Gale, Frame.Juggernaut], difficulty: 2 }, delay) };
  const target = 5000;
  const sample = (seat: number, tick: number): GameInput => script.inputAt(tick, seat);
  const reference = createSession({ factory: createGameSim, codec: gameCodec, params, self: 0, seatOwners: [0, 0], sampleInput: sample });
  while (reference.tick < target) reference.update(0, target - reference.tick);
  const net = new SimulatedNetwork({ latencyMs: 70, jitterMs: 50, lossRate: 0.2, duplicateRate: 0.1 }, 99);
  const peers: Session<GameInput>[] = [0, 1].map((self) => createSession({
    factory: createGameSim, codec: gameCodec, params, self, seatOwners: [0, 1], transport: net.connect(self), sampleInput: sample,
  }));
  const clocks = peers.map(() => new TickClock({ tickRate: 60 }));
  const desync: string[] = [];
  peers.forEach((p, i) => { void p; void i; });
  for (let frame = 0; frame < 60 * 120 && peers.some((p) => p.tick < target); frame++) {
    const now = frame * (1000 / 60);
    net.advance(now);
    peers.forEach((p, i) => {
      const t = now + i * 4.1;
      const due = clocks[i].begin(t);
      clocks[i].end(p.update(t, Math.max(0, Math.min(due, target - p.tick))).ticks);
      if (p.status === 'desynced') desync.push(`peer ${i}`);
    });
  }
  check('2-machine co-op over 70ms +-50 / 20% loss / 10% dup lockstep == ideal local run',
    peers.every((p) => p.tick === target && hashEquals(p.sim.memory.hash(), reference.sim.memory.hash())) && desync.length === 0,
    `ticks ${peers.map((p) => p.tick)}, final ${hashToString(reference.sim.memory.hash())}, stalls ${peers.map((p) => p.stats.stalledUpdates)}, rtt ${peers.map((p) => Math.round(p.stats.rttMs))}ms`);
}

finish('game-eval');
