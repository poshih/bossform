/**
 * Balance report (dev tool, not a check): runs bot-versus-bot matches and prints the numbers the design is tuned by:
 * time to the first transformation, transformations per pilot-minute, how long boss forms last and how much of
 * their armour survives, kill pace, and how often the damage window blocks a hit.
 *   node tools/verify/balance.ts [matches=6]
 */
import { Ev, Form, FORMS, Mode, Phase, TICK_RATE, W } from '../../game/src/sim/index.ts';
import { freeForAll, rotatingFrames, runBots } from './game-run.ts';
import type { RunSpec } from './game-run.ts';

const matches = Number(process.argv[2] ?? 6);
const FRAME_NAMES = ['VANGUARD', 'GALE', 'JUGGERNAUT'];

interface Totals {
  ticks: number;
  pilotTicks: number;
  firstMorph: number[];
  morphs: number;
  bossTicks: number;
  bossLife: number[];
  partsDownPerForm: number[];
  deaths: number;
  bossDeaths: number;
  hits: number;
  blocked: number;
  grazes: number;
  neutralKills: number;
  byFrame: Array<{ morphs: number; kills: number; deaths: number }>;
  roundTicks: number[];
}

function measure(specs: readonly RunSpec[]): Totals {
  const t: Totals = {
    ticks: 0, pilotTicks: 0, firstMorph: [], morphs: 0, bossTicks: 0, bossLife: [], partsDownPerForm: [], deaths: 0, bossDeaths: 0, hits: 0, blocked: 0,
    grazes: 0, neutralKills: 0, byFrame: [0, 1, 2].map(() => ({ morphs: 0, kills: 0, deaths: 0 })), roundTicks: [],
  };
  for (const spec of specs) {
    const seats = spec.frames.length;
    const firstSeen = new Array<number>(seats).fill(-1);
    const bossSince = new Array<number>(seats).fill(-1);
    const partsDown = new Array<number>(seats).fill(0);
    let battleStart = 0;
    let previousPhase = -1;
    const run = runBots({
      ...spec,
      onTick: (sim, tick) => {
        const w = sim.world;
        const { m } = w;
        const phase = m.world[W.Phase];
        if (phase === Phase.Battle && previousPhase !== Phase.Battle) battleStart = tick;
        if (previousPhase === Phase.Battle && phase !== Phase.Battle) t.roundTicks.push(tick - battleStart);
        previousPhase = phase;
        for (let e = 0; e < w.events.count; e++) {
          const a = w.events.a[e];
          switch (w.events.type[e]) {
            case Ev.MorphStart:
              t.morphs++;
              t.byFrame[m.plFrame[a]].morphs++;
              if (firstSeen[a] < 0) {
                firstSeen[a] = tick - battleStart;
                t.firstMorph.push(firstSeen[a]);
              }
              bossSince[a] = tick;
              partsDown[a] = 0;
              break;
            case Ev.PartDown:
              partsDown[a]++;
              break;
            case Ev.BossEnd:
              if (bossSince[a] >= 0) {
                t.bossLife.push(tick - bossSince[a]);
                t.partsDownPerForm.push(partsDown[a]);
                bossSince[a] = -1;
              }
              break;
            case Ev.Death:
              t.deaths++;
              t.byFrame[m.plFrame[a]].deaths++;
              if (w.events.b[e] >= 0) t.byFrame[m.plFrame[w.events.b[e]]].kills++;
              break;
            case Ev.Hit:
              t.hits++;
              break;
            case Ev.Blocked:
              t.blocked++;
              break;
            case Ev.Graze:
              t.grazes++;
              break;
            case Ev.NeutralKilled:
              t.neutralKills++;
              break;
            default:
          }
        }
        w.events.clear();
        for (let s = 0; s < seats; s++) {
          if (m.plActive[s] === 1) t.pilotTicks++;
          if (m.plForm[s] === Form.Boss) t.bossTicks++;
        }
      },
    });
    t.ticks += run.session.tick;
  }
  return t;
}

const avg = (values: readonly number[]) => (values.length === 0 ? NaN : values.reduce((a, b) => a + b, 0) / values.length);
const secs = (ticks: number) => (ticks / TICK_RATE).toFixed(1);

function report(name: string, specs: readonly RunSpec[]): void {
  const t = measure(specs);
  const minutes = t.pilotTicks / TICK_RATE / 60;
  console.log(`\n== ${name}: ${specs.length} matches, ${(t.ticks / TICK_RATE / 60).toFixed(1)} min of play, ${minutes.toFixed(1)} pilot-minutes`);
  console.log(`first transformation ${secs(avg(t.firstMorph))} s into the round (median ${secs([...t.firstMorph].sort((a, b) => a - b)[Math.floor(t.firstMorph.length / 2)] ?? NaN)})`);
  console.log(`transformations ${(t.morphs / minutes).toFixed(2)} per pilot-minute; boss form lives ${secs(avg(t.bossLife))} s on average, ${avg(t.partsDownPerForm).toFixed(1)} parts destroyed per form; ${(100 * t.bossTicks / t.pilotTicks).toFixed(0)}% of pilot time is boss form`);
  console.log(`deaths ${(t.deaths / minutes).toFixed(2)} per pilot-minute (${(t.deaths / (t.ticks / TICK_RATE / 60)).toFixed(1)} per match-minute), hits ${(t.hits / minutes).toFixed(0)} / blocked ${(t.blocked / minutes).toFixed(0)} per pilot-minute, grazes ${(t.grazes / minutes).toFixed(0)}, neutrals killed ${(t.neutralKills / minutes).toFixed(2)}`);
  console.log(t.byFrame.map((f, i) => `${FRAME_NAMES[i]} (${FORMS[i].name}): ${f.morphs} transformations, ${f.kills} kills, ${f.deaths} deaths`).join(' | '));
  if (t.roundTicks.length > 0) console.log(`round length ${secs(avg(t.roundTicks))} s on average (${secs(Math.min(...t.roundTicks))} to ${secs(Math.max(...t.roundTicks))})`);
}

const seeds = Array.from({ length: matches }, (_, i) => 100 + i);
report('deathmatch, 8 pilots', seeds.map((seed) => ({ mode: Mode.Deathmatch, frames: rotatingFrames(8, seed), teams: freeForAll(8), ticks: 11000, seed })));
report('elimination, 4 pilots free-for-all', seeds.map((seed) => ({ mode: Mode.Elimination, frames: rotatingFrames(4, seed), teams: freeForAll(4), ticks: 40000, seed })));
report('elimination, 2 pilots (duels)', seeds.map((seed) => ({ mode: Mode.Elimination, frames: [seed % 3, (seed + 1) % 3] as number[], teams: [0, 1], ticks: 40000, seed })));
