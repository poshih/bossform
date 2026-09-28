/** Minimal reporter shared by the eval scripts (they run the real code and print PASS/FAIL; no test framework). */
let passed = 0;
let failed = 0;

export function section(title: string): void {
  console.log(`\n== ${title}`);
}

export function check(name: string, ok: boolean, detail = ''): void {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

export function info(text: string): void {
  console.log(`      ${text}`);
}

export function finish(script: string): never {
  console.log(`\n${script}: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}
