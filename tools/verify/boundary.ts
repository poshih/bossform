/**
 * Boundary eval: enforces the architecture mechanically.
 *
 *   engine/         imports nothing but itself; no DOM / Node / game vocabulary; compiled without DOM libs
 *   game/src/sim/   imports only the engine's public entry + itself; no presentation; no non-deterministic APIs
 *   game view/ui/audio/render   read the simulation through sim/index.ts and never write to it
 *   game (all)      reaches the engine only through the bare package specifier
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, finish, info, section } from './lib.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== 'dist') walk(full, out);
    } else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Source with comments and string/template contents blanked, so patterns only match real code. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length))
    .replace(/(['"`])(?:\\.|(?!\1)[^\\\n])*\1/g, (m) => m[0] + ' '.repeat(Math.max(0, m.length - 2)) + m[m.length - 1]);
}

function imports(text: string): string[] {
  const specs: string[] = [];
  const pattern = /(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const m of text.matchAll(pattern)) specs.push(m[1] ?? m[2] ?? m[3]);
  return specs;
}

const rel = (file: string) => path.relative(root, file);
function report(name: string, violations: string[]): void {
  check(name, violations.length === 0, violations.slice(0, 4).join(' | '));
  for (const v of violations.slice(4, 12)) info(v);
}

const engineFiles = walk(path.join(root, 'engine/src'));
const gameFiles = walk(path.join(root, 'game/src'));
const simFiles = gameFiles.filter((f) => f.includes(`${path.sep}sim${path.sep}`));
const presentation = gameFiles.filter((f) => /[\\/](view|ui|audio|render)[\\/]/.test(f));

section('engine is self-contained');
{
  const bad: string[] = [];
  for (const file of engineFiles) {
    for (const spec of imports(fs.readFileSync(file, 'utf8'))) {
      if (!spec.startsWith('./')) bad.push(`${rel(file)} imports "${spec}"`);
    }
  }
  report('engine imports only sibling engine files (no packages, no node:, no ../)', bad);

  const globals = /\b(window|document|navigator|process|require|Buffer|localStorage|sessionStorage|requestAnimationFrame|setInterval|fetch|XMLHttpRequest|HTMLElement|console)\b/;
  const badGlobals: string[] = [];
  for (const file of engineFiles) {
    code(fs.readFileSync(file, 'utf8')).split('\n').forEach((line, i) => {
      if (globals.test(line)) badGlobals.push(`${rel(file)}:${i + 1} ${line.trim()}`);
    });
  }
  report('engine touches no DOM / Node / console globals', badGlobals);

  const vocabulary = /\b(bullet|enemy|enemies|boss|robot|arena|mech|gauge|shmup|bossform|vanguard|gale|juggernaut)\b|three\.?js|from\s+['"]three['"]/i;
  const badWords: string[] = [];
  for (const file of engineFiles) {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (vocabulary.test(line)) badWords.push(`${rel(file)}:${i + 1} ${line.trim()}`);
    });
  }
  report('engine contains no game vocabulary (comments included)', badWords);

  const tsconfig = JSON.parse(fs.readFileSync(path.join(root, 'engine/tsconfig.json'), 'utf8')) as { compilerOptions: { lib: string[]; types: string[] } };
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'engine/package.json'), 'utf8')) as { dependencies?: object; peerDependencies?: object };
  check('engine compiles with lib ES2023 only and no ambient types (no DOM, no @types/node)',
    tsconfig.compilerOptions.lib.every((l) => /^ES\d+$/i.test(l)) && tsconfig.compilerOptions.types.length === 0);
  check('engine declares zero runtime dependencies', !pkg.dependencies && !pkg.peerDependencies);
}

section('game reaches the engine only through its public entry');
{
  const bad: string[] = [];
  for (const file of gameFiles) {
    for (const spec of imports(fs.readFileSync(file, 'utf8'))) {
      if (spec.startsWith('@metronome/') && spec !== '@metronome/engine') bad.push(`${rel(file)} imports "${spec}" (deep import)`);
      if (spec.startsWith('.') && path.resolve(path.dirname(file), spec).startsWith(path.join(root, 'engine'))) bad.push(`${rel(file)} imports "${spec}" (reaches into engine/)`);
    }
  }
  report('no deep or relative imports of engine internals from the game', bad);

  const engineImporters = gameFiles.filter((f) => imports(fs.readFileSync(f, 'utf8')).includes('@metronome/engine'));
  info(`${engineImporters.length} game files import @metronome/engine`);
  const gamePkg = JSON.parse(fs.readFileSync(path.join(root, 'game/package.json'), 'utf8')) as { dependencies: Record<string, string> };
  check('the engine is a declared dependency of the game (and the engine does not depend on the game)', '@metronome/engine' in gamePkg.dependencies);
}

section('simulation is pure');
{
  const bad: string[] = [];
  for (const file of simFiles) {
    for (const spec of imports(fs.readFileSync(file, 'utf8'))) {
      const ok = spec === '@metronome/engine' || (spec.startsWith('./') && !spec.slice(2).includes('/'));
      if (!ok) bad.push(`${rel(file)} imports "${spec}"`);
    }
  }
  report('sim imports only @metronome/engine and sibling sim files (no three, DOM, view, ui, audio, bot)', bad);

  const badGlobals: string[] = [];
  const domGlobals = /\b(window|document|navigator|localStorage|requestAnimationFrame|setTimeout|setInterval|fetch|HTMLElement|AudioContext|WebGL\w*|console)\b/;
  for (const file of simFiles) {
    code(fs.readFileSync(file, 'utf8')).split('\n').forEach((line, i) => {
      if (domGlobals.test(line)) badGlobals.push(`${rel(file)}:${i + 1} ${line.trim()}`);
    });
  }
  report('sim uses no DOM / timer / console globals', badGlobals);

  const nondeterministic = /\bMath\.(random|sin|cos|tan|asin|acos|atan|atan2|sinh|cosh|tanh|asinh|acosh|atanh|exp|expm1|log|log1p|log2|log10|pow|cbrt|hypot|sqrt|fround|clz32)\b|\bDate\b|\bperformance\b|\*\*|\bcrypto\b|\bstructuredClone\b|\bMap\b|\bSet\b|\bWeakMap\b|\bfor\s*\([^)]*\bin\b/;
  const badApis: string[] = [];
  for (const file of simFiles) {
    code(fs.readFileSync(file, 'utf8')).split('\n').forEach((line, i) => {
      if (nondeterministic.test(line)) badApis.push(`${rel(file)}:${i + 1} ${line.trim()}`);
    });
  }
  report('sim uses no Math.random/trig/pow/hypot/sqrt, Date, performance, **, Map/Set or for-in', badApis);

  // Fractional numbers may only appear as authoring-time constants: fx.lit(..), fx.deg(..), fx.turns(..).
  const badFloats: string[] = [];
  for (const file of simFiles) {
    const stripped = code(fs.readFileSync(file, 'utf8')).replace(/fx\.(lit|deg|turns)\(\s*-?\d*\.?\d+(?:e-?\d+)?\s*\)/g, 'CONST');
    stripped.split('\n').forEach((line, i) => {
      if (/(^|[^\w.])\d+\.\d+|\d[eE]-?\d/.test(line)) badFloats.push(`${rel(file)}:${i + 1} ${line.trim()}`);
    });
  }
  report('sim contains no floating-point literals outside fx.lit / fx.deg / fx.turns', badFloats);
}

section('presentation only reads the simulation');
{
  const bad: string[] = [];
  for (const file of presentation) {
    for (const spec of imports(fs.readFileSync(file, 'utf8'))) {
      if (/(^|\/)sim\//.test(spec) && !/\/sim\/index\.ts$/.test(spec)) bad.push(`${rel(file)} imports "${spec}" (use sim/index.ts)`);
      if (spec.includes('/bot/')) bad.push(`${rel(file)} imports the bot`);
    }
  }
  report('view/ui/audio/render import the simulation only via sim/index.ts', bad);

  const writes: string[] = [];
  const mutation = /\b(?:m|sim\.world\.m|world\.m)\.\w+\[[^\]]*\]\s*(?:=(?!=)|\+=|-=|\*=|\|=|&=|\+\+|--)|(?:\+\+|--)\s*(?:m|world\.m)\.\w+\[/;
  for (const file of presentation) {
    code(fs.readFileSync(file, 'utf8')).split('\n').forEach((line, i) => {
      if (mutation.test(line)) writes.push(`${rel(file)}:${i + 1} ${line.trim()}`);
    });
  }
  report('presentation code never assigns into simulation memory', writes);
}

finish('boundary');
