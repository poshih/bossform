import { fx } from '@metronome/engine';
import {
  COUNTDOWN_TICKS, DEATHMATCH_TICKS, NO_SEAT, NO_WINNER, Phase, ROUND_END_TICKS, ROUNDS_TO_WIN, SAFE_RADIUS_MIN, SHRINK_TICKS,
  SPAWN_PROTECT_TICKS, STORM_DAMAGE, STORM_INTERVAL, SUDDEN_DEATH_TICKS, FIRST_WAVE_TICKS, WARDEN_FIRST_TICKS,
  WAVE_INTERVAL_SUDDEN_DEATH_TICKS, WAVE_INTERVAL_TICKS,
} from './constants.ts';
import { DamageKind, damageShip } from './damage.ts';
import { Banner, Ev } from './events.ts';
import type { Vec } from './geometry.ts';
import { within } from './geometry.ts';
import { W } from './layout.ts';
import { clearNeutrals, updateWaves } from './neutrals.ts';
import { clearOrbs } from './orbs.ts';
import { clearProjectiles } from './projectiles.ts';
import { isFighting } from './query.ts';
import { resetShip } from './ships.ts';
import { roundStart } from './spawn.ts';
import type { World } from './world.ts';

/** Clears the arena and puts every participating ship on its starting ring for a new round. */
function beginRound(w: World): void {
  const { m } = w;
  const s = m.world;
  clearProjectiles(w);
  clearNeutrals(w);
  clearOrbs(w);
  s[W.Phase] = Phase.Countdown;
  s[W.PhaseTimer] = COUNTDOWN_TICKS;
  s[W.RoundTick] = 0;
  s[W.SafeR] = w.arenaR;
  s[W.WaveTimer] = FIRST_WAVE_TICKS;
  s[W.WaveCount] = 0;
  s[W.WardenTimer] = WARDEN_FIRST_TICKS;
  const at: Vec = { x: 0, y: 0 };
  for (let seat = 0; seat < w.seats; seat++) {
    if (m.plActive[seat] === 0) continue;
    const aim = roundStart(w, seat, at);
    resetShip(w, seat, at, aim, COUNTDOWN_TICKS + SPAWN_PROTECT_TICKS);
  }
  w.emit(Ev.Banner, 0, 0, Banner.Round, s[W.Round]);
}

export function startMatch(w: World): void {
  beginRound(w);
}

/** Teams that still have a ship fighting. */
function fightingTeams(w: World): number[] {
  const teams: number[] = [];
  for (let seat = 0; seat < w.seats; seat++) {
    if (isFighting(w, seat) && !teams.includes(w.m.plTeam[seat])) teams.push(w.m.plTeam[seat]);
  }
  return teams;
}

/** Teams that still have a pilot in the match (fighting or waiting to respawn). */
function activeTeams(w: World): number[] {
  const teams: number[] = [];
  for (let seat = 0; seat < w.seats; seat++) {
    if (w.m.plActive[seat] === 1 && !teams.includes(w.m.plTeam[seat])) teams.push(w.m.plTeam[seat]);
  }
  return teams;
}

/** Sudden death: the safe zone shrinks and the storm hurts anything outside it, ignoring the damage window. */
function stormTick(w: World): void {
  const { m } = w;
  const t = m.world[W.RoundTick] - SUDDEN_DEATH_TICKS;
  if (w.isDeathmatch || t < 0) return;
  if (t === 0) w.emit(Ev.StormStart);
  const safe = w.arenaR - fx.mulDiv(w.arenaR - SAFE_RADIUS_MIN, Math.min(t, SHRINK_TICKS), SHRINK_TICKS);
  m.world[W.SafeR] = safe;
  if (t % STORM_INTERVAL !== 0) return;
  for (let seat = 0; seat < w.seats; seat++) {
    if (isFighting(w, seat) && !within(m.plX[seat], m.plY[seat], safe)) damageShip(w, seat, STORM_DAMAGE, NO_SEAT, DamageKind.Storm);
  }
}

function battleTick(w: World): void {
  const s = w.m.world;
  s[W.RoundTick]++;
  stormTick(w);
  const suddenDeath = !w.isDeathmatch && s[W.RoundTick] >= SUDDEN_DEATH_TICKS;
  updateWaves(w, suddenDeath ? WAVE_INTERVAL_SUDDEN_DEATH_TICKS : WAVE_INTERVAL_TICKS);
}

/** Phase timers, sudden death and the neutral waves. Runs first each tick. */
export function updateMatch(w: World): void {
  const s = w.m.world;
  switch (s[W.Phase]) {
    case Phase.Countdown:
      if (--s[W.PhaseTimer] <= 0) {
        s[W.Phase] = Phase.Battle;
        w.emit(Ev.Banner, 0, 0, Banner.Fight, 0);
      }
      break;
    case Phase.Battle:
      battleTick(w);
      break;
    case Phase.RoundEnd:
      if (--s[W.PhaseTimer] <= 0) {
        s[W.Round]++;
        beginRound(w);
      }
      break;
    default:
  }
}

function endRound(w: World, winner: number): void {
  const { m } = w;
  const s = m.world;
  if (winner !== NO_WINNER) m.teamWins[winner]++;
  const matchWon = winner !== NO_WINNER && m.teamWins[winner] >= ROUNDS_TO_WIN;
  if (matchWon) {
    s[W.Winner] = winner;
    s[W.Phase] = Phase.Over;
  } else {
    s[W.Phase] = Phase.RoundEnd;
    s[W.PhaseTimer] = ROUND_END_TICKS;
  }
  w.emit(Ev.RoundEnd, 0, 0, winner, matchWon ? 1 : 0);
}

/** Deathmatch: highest team score wins; a tie for the lead is a draw. */
function leadingTeam(w: World): number {
  const { m } = w;
  let best = NO_WINNER;
  let bestScore = -1;
  let tied = false;
  for (const team of activeTeams(w)) {
    if (m.teamScore[team] > bestScore) {
      best = team;
      bestScore = m.teamScore[team];
      tied = false;
    } else if (m.teamScore[team] === bestScore) tied = true;
  }
  return tied ? NO_WINNER : best;
}

function endDeathmatch(w: World, winner: number): void {
  const s = w.m.world;
  s[W.Winner] = winner;
  s[W.Phase] = Phase.Over;
  w.emit(Ev.RoundEnd, 0, 0, winner, 1);
}

/** Win conditions. Runs last each tick, once this tick's deaths are known. */
export function resolveMatch(w: World): void {
  const s = w.m.world;
  if (s[W.Phase] !== Phase.Battle) return;
  if (w.isDeathmatch) {
    const teams = activeTeams(w);
    if (teams.length <= 1) endDeathmatch(w, teams.length === 1 ? teams[0] : NO_WINNER);
    else if (s[W.RoundTick] >= DEATHMATCH_TICKS) endDeathmatch(w, leadingTeam(w));
    return;
  }
  const alive = fightingTeams(w);
  if (alive.length <= 1) endRound(w, alive.length === 1 ? alive[0] : NO_WINNER);
}
