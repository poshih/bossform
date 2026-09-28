/**
 * Renders the dev-only model viewer (game/viewer.html) through the real low-res pipeline and saves a PNG.
 *   node tools/verify/models.ts <name> '<json array of entries | path to a .json file>' [width] [height] [time]
 * Entry: { kind: 'mech'|'enemy', id, x, y, scale?, spin?, pose? }   (see game/src/viewer.ts)
 * Requires the dev server:  npm run dev -w @bossform/game   (port 4427). Fails if the page logs any error.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const [name = 'sheet', spec = '[]', w = '960', h = '540', t = '1.0'] = process.argv.slice(2);
const entries = JSON.parse(fs.existsSync(spec) ? fs.readFileSync(spec, 'utf8') : spec) as unknown;
const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'shots/models');
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: Number(w), height: Number(h) } });
const problems: string[] = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
await page.goto('http://127.0.0.1:4427/viewer.html');
await page.waitForFunction(() => (window as unknown as { __viewerReady?: boolean }).__viewerReady === true, null, { timeout: 60000 });
await page.evaluate(({ list, time }) => {
  const v = (window as unknown as { __viewer: { show(e: unknown): void; freeze(t: number): void } }).__viewer;
  v.show(list);
  v.freeze(time);
}, { list: entries, time: Number(t) });
await page.waitForTimeout(1200);
const file = path.join(outDir, `${name}.png`);
await page.screenshot({ path: file });
await browser.close();
console.log(`saved ${file}`);
if (problems.length > 0) {
  console.log(problems.join('\n'));
  process.exit(1);
}
