import {
  CLEAR_TICKS, FRAME_STATS, INTRO_TICKS, MAX_ENEMIES, MAX_ORBS, MAX_SHOTS, Phase, STAGE_CLEAR_BONUS, STAGE_COUNT, STAGE_HEAL_PCT,
  WARNING_TICKS,
} from './constants.ts';
import { spawnBoss } from './bosses.ts';
import { aliveEnemyCount } from './enemies.ts';
import { Banner, Ev } from './events.ts';
import { W } from './layout.ts';
import { wipeBullets } from './patterns.ts';
import { spawnEnemy } from './spawn.ts';
import { Op, STAGE_SCRIPTS, STEP_SIZE } from './stages.ts';
import type { World } from './world.ts';

const NO_BOSS = -1;
const STAGE_START_INVULN = 120;

/** Clears the field and stages the players for a fresh stage. */
export function beginStage(w: World, stage: number, healPct: number): void {
  const { m } = w;
  const wv = m.world;
  wv[W.Stage] = stage;
  wv[W.Phase] = Phase.Intro;
  wv[W.PhaseTimer] = INTRO_TICKS;
  wv[W.ScriptPtr] = 0;
  wv[W.ScriptTimer] = 0;
  wv[W.StageTick] = 0;
  wv[W.StageHits] = 0;
  wv[W.BossSlot] = NO_BOSS;
  wipeBullets(w);
  for (let s = 0; s < MAX_SHOTS; s++) if (m.sAlive[s] === 1) w.freeShot(s);
  for (let e = 0; e < MAX_ENEMIES; e++) if (m.eAlive[e] === 1) w.freeEnemy(e);
  for (let o = 0; o < MAX_ORBS; o++) if (m.oAlive[o] === 1) w.freeOrb(o);
  for (let p = 0; p < w.seats; p++) {
    if (m.plActive[p] !== 1 || m.plLives[p] <= 0) continue;
    const maxHp = FRAME_STATS[m.plFrame[p]].maxHp;
    m.plHp[p] = m.plHp[p] <= 0 ? maxHp : Math.min(maxHp, m.plHp[p] + Math.floor((maxHp * healPct) / 100));
    m.plRespawn[p] = 0;
    m.plBoss[p] = 0;
    m.plTransform[p] = 0;
    m.plAltFx[p] = 0;
    m.plBeam[p] = 0;
    m.plX[p] = m.plPX[p] = w.spawnX(p);
    m.plY[p] = m.plPY[p] = w.spawnY;
    m.plInvuln[p] = STAGE_START_INVULN;
  }
  w.emit(Ev.Banner, stage + 1, 0, Banner.Stage);
}

export function updateFlow(w: World): void {
  const wv = w.m.world;
  switch (wv[W.Phase]) {
    case Phase.Intro:
      if (--wv[W.PhaseTimer] <= 0) wv[W.Phase] = Phase.Play;
      break;
    case Phase.Play:
      wv[W.StageTick]++;
      runScript(w);
      break;
    case Phase.BossWarning:
      if (--wv[W.PhaseTimer] <= 0) {
        spawnBoss(w, wv[W.PendingBoss]);
        wv[W.Phase] = Phase.Boss;
      }
      break;
    case Phase.Boss:
      wv[W.StageTick]++;
      if (wv[W.BossSlot] === NO_BOSS) stageCleared(w);
      break;
    case Phase.Clear:
      if (--wv[W.PhaseTimer] <= 0) advanceStage(w);
      break;
    default:
      break;
  }
}

function runScript(w: World): void {
  const wv = w.m.world;
  const script = STAGE_SCRIPTS[wv[W.Stage]];
  const next = (at: number) => {
    wv[W.ScriptPtr] = at + STEP_SIZE;
    wv[W.ScriptTimer] = 0;
  };
  for (;;) {
    const at = wv[W.ScriptPtr];
    if (at >= script.length) return;
    switch (script[at]) {
      case Op.Wait:
        if (wv[W.ScriptTimer] >= script[at + 1]) {
          next(at);
          continue;
        }
        wv[W.ScriptTimer]++;
        return;
      case Op.Spawn:
        spawnEnemy(w, script[at + 1], script[at + 2], script[at + 3], { r0: script[at + 4], r1: script[at + 5], r2: script[at + 6], r3: script[at + 7] });
        next(at);
        continue;
      case Op.Clear:
        if (aliveEnemyCount(w) === 0 || wv[W.ScriptTimer] >= script[at + 1]) {
          next(at);
          continue;
        }
        wv[W.ScriptTimer]++;
        return;
      case Op.Round:
        w.emit(Ev.Banner, script[at + 1], 0, Banner.Round);
        next(at);
        continue;
      case Op.Boss:
        wv[W.PendingBoss] = script[at + 1];
        wv[W.Phase] = Phase.BossWarning;
        wv[W.PhaseTimer] = WARNING_TICKS;
        w.emit(Ev.BossWarning, 0, 0, script[at + 1]);
        next(at);
        return;
      default:
        return;
    }
  }
}

function stageCleared(w: World): void {
  const { m } = w;
  const wv = m.world;
  wv[W.Phase] = Phase.Clear;
  wv[W.PhaseTimer] = CLEAR_TICKS;
  const bonus = STAGE_CLEAR_BONUS * (wv[W.StageHits] === 0 ? 2 : 1);
  for (let p = 0; p < w.seats; p++) if (w.isPlaying(p)) m.plScore[p] += bonus;
  w.emit(Ev.StageClear, 0, 0, wv[W.Stage]);
  w.emit(Ev.Banner, wv[W.Stage] + 1, 0, Banner.Clear);
}

function advanceStage(w: World): void {
  const wv = w.m.world;
  if (wv[W.Stage] + 1 >= STAGE_COUNT) {
    wv[W.Phase] = Phase.Win;
    w.emit(Ev.Victory);
    w.emit(Ev.Banner, 0, 0, Banner.Victory);
    return;
  }
  beginStage(w, wv[W.Stage] + 1, STAGE_HEAL_PCT);
}

/** Game over once every seat is out of lives and hit points. */
export function checkGameOver(w: World): void {
  const { m } = w;
  const phase = m.world[W.Phase];
  if (phase === Phase.Over || phase === Phase.Win) return;
  for (let p = 0; p < w.seats; p++) if (m.plActive[p] === 1 && (m.plLives[p] > 0 || m.plHp[p] > 0)) return;
  m.world[W.Phase] = Phase.Over;
  w.emit(Ev.GameOver);
  w.emit(Ev.Banner, 0, 0, Banner.GameOver);
}
