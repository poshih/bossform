/**
 * Screenshot helper for visual review of any page served by the dev server (dev tool, not a check).
 *   node tools/verify/shot.ts "<url>" <out.png> [--size=960x540] [--wait=1500] [--ready=window.ready] [--scale=1]
 * Waits until the page's ready expression is truthy (default `window.ready === true`), then a settle time, saves the
 * PNG and prints every console error / page error the page produced (the exit code is 1 if there were any).
 */
import { chromium } from 'playwright';

const [url, out, ...flags] = process.argv.slice(2);
if (!url || !out) {
  console.error('usage: node tools/verify/shot.ts "<url>" <out.png> [--size=960x540] [--wait=1500] [--ready=<expr>] [--scale=1]');
  process.exit(2);
}
const flag = (name: string, fallback: string): string => flags.find((f) => f.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const [width, height] = flag('size', '960x540').split('x').map(Number);
const settleMs = Number(flag('wait', '1500'));
const ready = flag('ready', 'window.ready === true');
const scale = Number(flag('scale', '1'));

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale });
const problems: string[] = [];
page.on('console', (message) => {
  if (message.type() === 'error') problems.push(`console: ${message.text()}`);
});
page.on('pageerror', (error) => problems.push(`page: ${String(error)}`));
await page.goto(url);
await page.waitForFunction(ready, null, { timeout: 60000 });
await page.waitForTimeout(settleMs);
await page.screenshot({ path: out });
await browser.close();
console.log(`saved ${out}${problems.length > 0 ? `\n${problems.join('\n')}` : ''}`);
process.exit(problems.length > 0 ? 1 : 0);
