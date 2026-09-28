/**
 * Serves game/dist for browser checks.
 *   node tools/verify/serve.ts [port] [csp]     csp: "hopinto" (default; the hosting platform's strict policy) | "open"
 * The hopinto policy allows no network beyond the page's own origin, which proves the solo game needs none.
 * "open" additionally allows the local relay used by the online co-op checks.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../game/dist');
const port = Number(process.argv[2] ?? 4429);
const mode = process.argv[3] ?? 'hopinto';
const PREFIX = '/r/local-test/';
const BASE_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data: blob:; media-src 'self' blob:; worker-src 'self' blob:; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'";
const CSP = `${BASE_CSP}; connect-src 'self' data: blob:${mode === 'open' ? ' ws://127.0.0.1:4431' : ''}`;
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp' };

http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/frame.html') {
    const w = url.searchParams.get('w') ?? '1280';
    const h = url.searchParams.get('h') ?? '720';
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><body style="margin:0;background:#222"><iframe id="f" src="${PREFIX}index.html${url.search.replace(/[?&]w=\d+|[?&]h=\d+/g, '')}" sandbox="allow-scripts allow-same-origin allow-pointer-lock" style="border:0;width:${w}px;height:${h}px"></iframe></body>`);
    return;
  }
  if (!url.pathname.startsWith(PREFIX)) {
    res.writeHead(404);
    res.end('outside release');
    return;
  }
  const rel = decodeURIComponent(url.pathname.slice(PREFIX.length)) || 'index.html';
  const file = path.join(root, rel);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    res.end('missing');
    return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'Content-Security-Policy': CSP, 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1', () => console.log(`serving ${root} at http://127.0.0.1:${port}${PREFIX} (${mode} CSP)`));
