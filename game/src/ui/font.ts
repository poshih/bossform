// Procedural 5x7 bitmap font rendered into cached, pre-tinted glyph atlases (no font files, pixel exact).

const GLYPHS: Record<string, string> = {
  A: '.###.#...##...#######...##...##...#',
  B: '####.#...##...#####.#...##...#####.',
  C: '.###.#...##....#....#....#...#.###.',
  D: '####.#...##...##...##...##...#####.',
  E: '######....#....####.#....#....#####',
  F: '######....#....####.#....#....#....',
  G: '.###.#...##....#.####...##...#.####',
  H: '#...##...##...#######...##...##...#',
  I: '.###...#....#....#....#....#...###.',
  J: '..###...#....#....#....##..#..##...',
  K: '#...##..#.#.#..##...#.#..#..#.#...#',
  L: '#....#....#....#....#....#....#####',
  M: '#...###.###.#.##.#.##...##...##...#',
  N: '#...##...###..##.#.##..###...##...#',
  O: '.###.#...##...##...##...##...#.###.',
  P: '####.#...##...#####.#....#....#....',
  Q: '.###.#...##...##...##.#.##..#..##.#',
  R: '####.#...##...#####.#.#..#..#.#...#',
  S: '.#####....#.....###.....#....#####.',
  T: '#####..#....#....#....#....#....#..',
  U: '#...##...##...##...##...##...#.###.',
  V: '#...##...##...##...##...#.#.#...#..',
  W: '#...##...##...##.#.##.#.##.#.#.#.#.',
  X: '#...##...#.#.#...#...#.#.#...##...#',
  Y: '#...##...#.#.#...#....#....#....#..',
  Z: '#####....#...#...#...#...#....#####',
  '0': '.###.#...##..###.#.###..##...#.###.',
  '1': '..#...##....#....#....#....#...###.',
  '2': '.###.#...#....#...#...#...#...#####',
  '3': '####.....#....#.###.....#....#####.',
  '4': '...#...##..#.#.#..#.#####...#....#.',
  '5': '######....####.....#....##...#.###.',
  '6': '..##..#...#....####.#...##...#.###.',
  '7': '#####....#...#...#...#....#....#...',
  '8': '.###.#...##...#.###.#...##...#.###.',
  '9': '.###.#...##...#.####....#...#..##..',
  ' ': '...................................',
  '.': '...........................##...##.',
  ',': '....................##....#...#....',
  ':': '......##...##........##...##.......',
  ';': '......##...##........##....#...#...',
  '!': '..#....#....#....#....#.........#..',
  '?': '.###.#...#....#...#...#.........#..',
  '-': '...............#####...............',
  '+': '.......#....#..#####..#....#.......',
  '/': '....#....#...#...#...#...#....#....',
  "'": '..#....#...#.......................',
  '"': '.#.#..#.#..........................',
  '(': '...#...#...#....#....#.....#.....#.',
  ')': '.#.....#.....#....#....#...#...#...',
  '[': '.###..#....#....#....#....#....###.',
  ']': '.###....#....#....#....#....#..###.',
  '<': '...#...#...#...#.....#.....#.....#.',
  '>': '.#.....#.....#.....#...#...#...#...',
  '=': '..........#####.....#####..........',
  '%': '##..###..#...#...#...#...#..###..##',
  '#': '.#.#..#.#.#####.#.#.#####.#.#..#.#.',
  '*': '.....#.#.#.###.#####.###.#.#.#.....',
  _: '..............................#####',
  '&': '.##..#..#.#.#...#...#.#.##..#..##.#',
  '|': '..#....#....#....#....#....#....#..',
  '~': '...........#...#.#.#...#...........',
  '×': '.....#...#.#.#...#...#.#.#...#.....',
  '▶': '#....##...###..####.###..##...#....',
  '◀': '....#...##..###.####..###...##....#',
  '●': '......###.###############.###......',
  '■': '.....#########################.....',
  '⌛': '#####.#.#..#.#...#...#.#..###.#####',
  '♦': '..#...#.#.#...##.#.##...#.#.#...#..',
  '「': '.####.#....#....#....#.............',
  '」': '...............#....#....#....####.',
  '↑': '..#...###.#.#.#..#....#....#....#..',
  '↓': '..#....#....#....#..#.#.#.###...#..',
  '←': '.......#...#...#####.#.....#.......',
  '→': '.......#.....#.#####...#...#.......',
  '°': '.##..#..#..##......................',
};

export const GLYPH_W = 5;
export const GLYPH_H = 7;
const CELL_W = GLYPH_W + 3;
const CELL_H = GLYPH_H + 3;
const PAD = 1;

const glyphIndex = new Map<string, number>();
const glyphBits: Uint8Array[] = [];
for (const [ch, rows] of Object.entries(GLYPHS)) {
  if (rows.length !== GLYPH_W * GLYPH_H) throw new Error(`Glyph "${ch}" has ${rows.length} cells`);
  glyphIndex.set(ch, glyphBits.length);
  const bits = new Uint8Array(GLYPH_W * GLYPH_H);
  for (let i = 0; i < bits.length; i++) bits[i] = rows[i] === '#' ? 1 : 0;
  glyphBits.push(bits);
}
const FALLBACK = glyphIndex.get('?')!;

export interface TextStyle {
  /** One CSS colour, or one per glyph row (7) for 16-bit style gradients. */
  fill: string | readonly string[];
  outline?: string;
  shadow?: string;
}

const atlasCache = new Map<string, HTMLCanvasElement>();

function styleKey(s: TextStyle): string {
  return `${Array.isArray(s.fill) ? s.fill.join(',') : s.fill}|${s.outline ?? ''}|${s.shadow ?? ''}`;
}

function buildAtlas(style: TextStyle): HTMLCanvasElement {
  const n = glyphBits.length;
  const c = document.createElement('canvas');
  c.width = n * CELL_W;
  c.height = CELL_H;
  const g = c.getContext('2d')!;
  const rowFill = (row: number): string =>
    typeof style.fill === 'string' ? style.fill : style.fill[Math.min(row, style.fill.length - 1)];
  for (let gi = 0; gi < n; gi++) {
    const bits = glyphBits[gi];
    const ox = gi * CELL_W + PAD;
    const oy = PAD;
    if (style.shadow) {
      g.fillStyle = style.shadow;
      for (let y = 0; y < GLYPH_H; y++) for (let x = 0; x < GLYPH_W; x++) {
        if (!bits[y * GLYPH_W + x]) continue;
        if (style.outline) g.fillRect(ox + x, oy + y, 3, 3);
        else g.fillRect(ox + x + 1, oy + y + 1, 1, 1);
      }
    }
    if (style.outline) {
      g.fillStyle = style.outline;
      for (let y = 0; y < GLYPH_H; y++) for (let x = 0; x < GLYPH_W; x++) {
        if (bits[y * GLYPH_W + x]) g.fillRect(ox + x - 1, oy + y - 1, 3, 3);
      }
    }
    for (let y = 0; y < GLYPH_H; y++) {
      g.fillStyle = rowFill(y);
      for (let x = 0; x < GLYPH_W; x++) if (bits[y * GLYPH_W + x]) g.fillRect(ox + x, oy + y, 1, 1);
    }
  }
  return c;
}

function atlasFor(style: TextStyle): HTMLCanvasElement {
  const key = styleKey(style);
  let a = atlasCache.get(key);
  if (!a) {
    a = buildAtlas(style);
    atlasCache.set(key, a);
  }
  return a;
}

export function textWidth(text: string, scale = 1, spacing = 1): number {
  const n = [...text].length;
  return n === 0 ? 0 : (n * (GLYPH_W + spacing) - spacing) * scale;
}

export type Align = 'left' | 'center' | 'right';

export interface GlyphFx {
  dx: number;
  dy: number;
  alpha: number;
  /** Per-glyph style override (e.g. a flash colour during a reveal). */
  style?: TextStyle;
}

const OUTLINE_OFFSETS: ReadonlyArray<readonly [number, number]> = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]];

/**
 * Draws one glyph. At scale 1 the outline is baked into the atlas; at larger scales the outline is a crisp
 * one-pixel stroke and the shadow a hard drop shadow, so big lettering keeps a clean 16-bit silhouette.
 */
function drawGlyph(ctx: CanvasRenderingContext2D, gi: number, x: number, y: number, scale: number, style: TextStyle): void {
  const sx = gi * CELL_W;
  if (scale === 1 || (!style.outline && !style.shadow)) {
    ctx.drawImage(atlasFor(style), sx, 0, CELL_W, CELL_H, x - PAD * scale, y - PAD * scale, CELL_W * scale, CELL_H * scale);
    return;
  }
  const w = CELL_W * scale;
  const h = CELL_H * scale;
  const ox = x - PAD * scale;
  const oy = y - PAD * scale;
  if (style.shadow) {
    const d = Math.max(1, Math.round(scale / 2));
    ctx.drawImage(atlasFor({ fill: style.shadow }), sx, 0, CELL_W, CELL_H, ox + d, oy + d, w, h);
  }
  if (style.outline) {
    const outline = atlasFor({ fill: style.outline });
    for (const [dx, dy] of OUTLINE_OFFSETS) ctx.drawImage(outline, sx, 0, CELL_W, CELL_H, ox + dx, oy + dy, w, h);
  }
  ctx.drawImage(atlasFor({ fill: style.fill }), sx, 0, CELL_W, CELL_H, ox, oy, w, h);
}

/** Draws text on a low-res canvas at integer pixel positions. Returns the drawn width. */
export function drawText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  scale: number,
  style: TextStyle,
  align: Align = 'left',
  spacing = 1,
  fx?: (index: number, ch: string) => GlyphFx | null,
): number {
  const chars = [...text.toUpperCase()];
  const w = textWidth(text, scale, spacing);
  let cx = Math.round(align === 'center' ? x - w / 2 : align === 'right' ? x - w : x);
  const cy = Math.round(y);
  const adv = (GLYPH_W + spacing) * scale;
  const prevAlpha = ctx.globalAlpha;
  for (let i = 0; i < chars.length; i++, cx += adv) {
    const ch = chars[i];
    if (ch === ' ') continue;
    let gx = cx;
    let gy = cy;
    let st = style;
    if (fx) {
      const f = fx(i, ch);
      if (!f || f.alpha <= 0) continue;
      gx += Math.round(f.dx);
      gy += Math.round(f.dy);
      ctx.globalAlpha = prevAlpha * Math.min(1, f.alpha);
      if (f.style) st = f.style;
    }
    drawGlyph(ctx, glyphIndex.get(ch) ?? FALLBACK, gx, gy, scale, st);
  }
  ctx.globalAlpha = prevAlpha;
  return w;
}

/** Vertical 7-step gradient between two hex colours, quantised like a 16-bit palette ramp. */
export function ramp(top: string, bottom: string): string[] {
  const a = parseHex(top);
  const b = parseHex(bottom);
  const out: string[] = [];
  for (let i = 0; i < GLYPH_H; i++) {
    const t = i / (GLYPH_H - 1);
    const r = Math.round(a[0] + (b[0] - a[0]) * t);
    const g = Math.round(a[1] + (b[1] - a[1]) * t);
    const bl = Math.round(a[2] + (b[2] - a[2]) * t);
    out.push(`rgb(${r & 0xf8},${g & 0xf8},${bl & 0xf8})`);
  }
  return out;
}

function parseHex(h: string): [number, number, number] {
  const v = parseInt(h.replace('#', ''), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

export const TEXT = {
  hud: { fill: '#e9fbff', outline: '#061022' } as TextStyle,
  hudDim: { fill: '#7fb8d8', outline: '#061022' } as TextStyle,
  gold: { fill: ramp('#fff3c4', '#ff9a2a'), outline: '#2a1204' } as TextStyle,
  cyan: { fill: ramp('#ffffff', '#27c8ff'), outline: '#041a2c' } as TextStyle,
  magenta: { fill: ramp('#ffd6ea', '#ff2e88'), outline: '#2a0616' } as TextStyle,
  red: { fill: ramp('#ffe0e0', '#ff3b4e'), outline: '#2a0408' } as TextStyle,
  white: { fill: '#ffffff', outline: '#000000' } as TextStyle,
  flash: { fill: '#ffffff', outline: '#27e1ff' } as TextStyle,
  logo: { fill: ramp('#ffffff', '#27e1ff'), outline: '#061a33', shadow: '#ff2e88' } as TextStyle,
  osd: { fill: '#f4f4f4', shadow: '#000000' } as TextStyle,
};

/** Filled cells of a glyph as [x, y] pairs (y down), for building voxel/bullet lettering. */
export function glyphCells(ch: string): Array<[number, number]> {
  const gi = glyphIndex.get(ch.toUpperCase()) ?? FALLBACK;
  const bits = glyphBits[gi];
  const out: Array<[number, number]> = [];
  for (let y = 0; y < GLYPH_H; y++) for (let x = 0; x < GLYPH_W; x++) if (bits[y * GLYPH_W + x]) out.push([x, y]);
  return out;
}
