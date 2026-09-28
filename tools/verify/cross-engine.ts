/**
 * Cross-engine determinism: the same recordings are replayed through the real simulation in Node (V8), Chromium
 * (V8), Firefox (SpiderMonkey) and WebKit (JavaScriptCore). Every checkpoint recorded in Node must be reproduced
 * by every engine, and the final state, trig tables and numeric probes must be bit-identical.
 * The browsers load the TypeScript sources from a private Vite server that this script starts and stops.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium, firefox, webkit } from 'playwright';
import type { BrowserType } from 'playwright';
import { checkReplays } from '../../game/src/dev/replayCheck.ts';
import type { EngineReport } from '../../game/src/dev/replayCheck.ts';
import { Frame } from '../../game/src/sim/index.ts';
import { runBots } from './game-run.ts';
import { check, finish, info, section } from './lib.ts';

const gameRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../game');
const CHECK_PORT = 4432;

section('recording the reference matches (Node, autopilot)');
const runs = [
  { name: 'solo VANGUARD, normal', spec: { seats: 1, frames: [Frame.Vanguard], ticks: 12000 } },
  { name: 'solo GALE, hard', spec: { seats: 1, frames: [Frame.Gale], difficulty: 2, ticks: 12000 } },
  { name: 'solo JUGGERNAUT, easy, stage 3', spec: { seats: 1, frames: [Frame.Juggernaut], difficulty: 0, stage: 2, ticks: 9000 } },
  { name: 'co-op GALE + VANGUARD, hard', spec: { seats: 2, frames: [Frame.Gale, Frame.Vanguard], difficulty: 2, ticks: 14000 } },
];
const recordings = runs.map((r) => {
  const run = runBots(r.spec);
  info(`${r.name}: ${run.session.tick} ticks, ${(run.replay.length / 1024).toFixed(0)} KiB replay`);
  return Array.from(run.replay);
});

section('replaying in every engine');
const node = checkReplays(recordings);
const server = await createServer({ root: gameRoot, logLevel: 'error', server: { port: CHECK_PORT, strictPort: true, host: '127.0.0.1' } });
await server.listen();
const reports: Array<[string, EngineReport, number]> = [['Node (V8)', node, 0]];
for (const [name, type] of [['Chromium (V8)', chromium], ['Firefox (SpiderMonkey)', firefox], ['WebKit (JavaScriptCore)', webkit]] as Array<[string, BrowserType]>) {
  const started = Date.now();
  const browser = await type.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${CHECK_PORT}/viewer.html`);
    const report = await page.evaluate(async (data) => {
      const load = (path: string) => import(/* @vite-ignore */ path) as Promise<{ checkReplays(r: number[][]): unknown }>;
      const module = await load('/src/dev/replayCheck.ts');
      return module.checkReplays(data);
    }, recordings) as EngineReport;
    reports.push([name, report, Date.now() - started]);
  } finally {
    await browser.close();
  }
}

await server.close();

for (const [name, report, ms] of reports) {
  const sameAsNode = report.tables === node.tables && report.probes === node.probes
    && report.replays.every((r, i) => r.finalHash === node.replays[i].finalHash && r.ticks === node.replays[i].ticks);
  check(`${name}: replays reproduce every recorded checkpoint`, report.replays.every((r) => r.ok), report.replays.map((r) => r.firstMismatch ?? 'ok').join(','));
  check(`${name}: tables, numeric probes and final states identical to Node`, sameAsNode, `tables ${report.tables} probes ${report.probes}`);
  if (ms > 0) info(`${(ms / 1000).toFixed(1)} s including browser start`);
}
info(`final states: ${node.replays.map((r) => r.finalHash).join('  ')}`);
finish('cross-engine');
