/**
 * Proves the engine is a real, self-contained package: it is compiled on its own with tsc (no game, no bundler,
 * no dependencies), copied into an empty directory with nothing but its package.json, and a consumer that lives
 * outside the repository runs a two-peer lockstep session over the simulated network using only that copy.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, finish, info, section } from './lib.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const work = path.join(root, 'tools/verify/.standalone-work');

fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });

section('compile the engine alone');
const dist = path.join(work, 'node_modules/@metronome/engine');
fs.mkdirSync(dist, { recursive: true });
execFileSync(path.join(root, 'node_modules/.bin/tsc'), ['-p', path.join(root, 'engine/tsconfig.build.json'), '--outDir', path.join(dist, 'dist')], { stdio: 'pipe' });
fs.writeFileSync(path.join(dist, 'package.json'), JSON.stringify({ name: '@metronome/engine', version: '0.0.0', type: 'module', exports: { '.': './dist/index.js' } }));
const emitted = fs.readdirSync(path.join(dist, 'dist')).filter((f) => f.endsWith('.js'));
check('tsc emits plain JavaScript for every module with no game or bundler involved', emitted.length >= 12, `${emitted.length} modules`);
const imports = emitted.flatMap((f) => [...fs.readFileSync(path.join(dist, 'dist', f), 'utf8').matchAll(/from '([^']+)'/g)].map((m) => m[1]));
check('the emitted engine imports only its own files', imports.every((i) => i.startsWith('./') && i.endsWith('.js')), `${imports.length} imports`);

section('consume it from outside the repository');
fs.writeFileSync(path.join(work, 'package.json'), JSON.stringify({ type: 'module' }));
fs.writeFileSync(path.join(work, 'consumer.mjs'), `
import { createSession, SimulatedNetwork, SimMemory, field, fx, hashEquals, hashToString } from '@metronome/engine';

const codec = { byteLength: 2, neutral: () => ({ x: 0, y: 0 }), encode: (i, o, at) => { o[at] = i.x & 255; o[at + 1] = i.y & 255; }, decode: (b, at) => ({ x: (b[at] << 24) >> 24, y: (b[at + 1] << 24) >> 24 }) };
const factory = (init) => {
  const memory = new SimMemory({ px: field.i32(4), py: field.i32(4) });
  return { memory, step({ inputs, present }) { inputs.forEach((i, s) => { if (present[s]) { memory.f.px[s] += fx.mul(fx.fromInt(i.x), fx.lit(0.25)); memory.f.py[s] += fx.mul(fx.fromInt(i.y), fx.lit(0.25)); } }); } };
};
const params = { simVersion: 1, seed: 7, seats: 2, tickRate: 60, inputDelay: 5, checksumInterval: 30, config: new Uint8Array(0) };
const script = (seat, tick) => ({ x: ((tick * (seat + 3)) % 41) - 20, y: ((tick * 7 + seat) % 33) - 16 });
const net = new SimulatedNetwork({ latencyMs: 60, jitterMs: 40, lossRate: 0.2, duplicateRate: 0.1 }, 3);
const peers = [0, 1].map((self) => createSession({ factory, codec, params, self, seatOwners: [0, 1], transport: net.connect(self), sampleInput: script }));
const local = createSession({ factory, codec, params, self: 0, seatOwners: [0, 0], sampleInput: script });
while (local.tick < 1200) local.update(0, 1200 - local.tick);
for (let f = 0; f < 4000 && peers.some((p) => p.tick < 1200); f++) {
  const now = f * (1000 / 60);
  net.advance(now);
  for (const p of peers) p.update(now, Math.max(0, Math.min(2, 1200 - p.tick)));
}
const same = peers.every((p) => p.tick === 1200 && hashEquals(p.sim.memory.hash(), local.sim.memory.hash()));
console.log(JSON.stringify({ same, ticks: peers.map((p) => p.tick), hash: hashToString(local.sim.memory.hash()) }));
`);
const output = execFileSync(process.execPath, [path.join(work, 'consumer.mjs')], { cwd: work, encoding: 'utf8' });
const result = JSON.parse(output) as { same: boolean; ticks: number[]; hash: string };
check('a two-peer lockstep session over a lossy network matches the ideal run, using only the compiled package', result.same, `ticks ${result.ticks}, final ${result.hash}`);
info(`built and run in ${work}`);
fs.rmSync(work, { recursive: true, force: true });
finish('engine-standalone');
