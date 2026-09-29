import {
  BOSS_KILL_SCORE, GAUGE_PER_DAMAGE_DEALT, GAUGE_PER_DAMAGE_TAKEN, FLASH_TICKS, Form, KILL_CREDIT_TICKS, KILL_SCORE, NO_SEAT, RESPAWN_TICKS,
} from './constants.ts';
import { clearBoss } from './boss.ts';
import { earn } from './energy.ts';
import { Ev } from './events.ts';
import { FRAME_STATS } from './frames.ts';
import { W } from './layout.ts';
import { dropKillOrbs } from './orbs.ts';
import type { World } from './world.ts';

/** Bullet damage passes through the damage window; the storm ignores it. */
export const DamageKind = { Bullet: 0, Storm: 1 } as const;

/**
 * Hurts a ship's core. A robot can only take `windowCap` damage per `windowTicks`: the window opens on the first hit
 * and anything beyond the cap inside it is ignored. `attacker` is a seat or NO_SEAT.
 */
export function damageShip(w: World, seat: number, amount: number, attacker: number, kind: number): void {
  const { m } = w;
  const stats = FRAME_STATS[m.plFrame[seat]];
  const tick = m.world[W.Tick];
  let applied = amount;
  if (kind === DamageKind.Bullet) {
    if (tick >= m.plWinEnd[seat]) {
      m.plWinEnd[seat] = tick + stats.windowTicks;
      m.plWinDmg[seat] = 0;
    }
    applied = Math.min(amount, stats.windowCap - m.plWinDmg[seat]);
    m.plWinDmg[seat] += applied;
  }
  if (applied <= 0) {
    w.emit(Ev.Blocked, m.plX[seat], m.plY[seat], seat);
    return;
  }
  m.plHp[seat] -= applied;
  m.plFlash[seat] = FLASH_TICKS;
  if (attacker !== NO_SEAT) {
    m.plLastHit[seat] = attacker;
    m.plLastHitAt[seat] = tick;
  }
  earn(w, seat, applied * GAUGE_PER_DAMAGE_TAKEN);
  if (attacker >= 0) {
    earn(w, attacker, applied * GAUGE_PER_DAMAGE_DEALT);
    m.plDealt[attacker] += applied;
  }
  w.emit(kind === DamageKind.Storm ? Ev.StormHit : Ev.Hit, m.plX[seat], m.plY[seat], seat, applied, attacker);
  if (m.plHp[seat] <= 0) killShip(w, seat, attacker);
}

/** Destroys a ship. The kill goes to `killer`, or to whoever last hurt it if the storm finished it. */
export function killShip(w: World, seat: number, killer: number): void {
  const { m } = w;
  const wasBoss = m.plForm[seat] === Form.Boss;
  const tick = m.world[W.Tick];
  let credit = killer;
  if (credit === NO_SEAT && m.plLastHit[seat] !== NO_SEAT && tick - m.plLastHitAt[seat] <= KILL_CREDIT_TICKS) credit = m.plLastHit[seat];
  m.plAlive[seat] = 0;
  m.plHp[seat] = 0;
  m.plDeaths[seat]++;
  if (credit >= 0) {
    m.plKills[credit]++;
    if (w.isDeathmatch) m.teamScore[m.plTeam[credit]] += wasBoss ? BOSS_KILL_SCORE : KILL_SCORE;
  }
  dropKillOrbs(w, seat, wasBoss);
  if (wasBoss) w.emit(Ev.BossEnd, m.plX[seat], m.plY[seat], seat);
  clearBoss(w, seat);
  m.plGauge[seat] = 0;
  m.plRespawn[seat] = w.isDeathmatch ? RESPAWN_TICKS : 0;
  w.emit(Ev.Death, m.plX[seat], m.plY[seat], seat, credit);
}
