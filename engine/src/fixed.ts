/**
 * Q16.16 fixed-point math for deterministic simulation code.
 *
 * A fixed value is a plain JS number that always holds an INTEGER: the "raw" value, i.e. real * 65536.
 * Raw values are kept inside int32 so they can live in Int32Array state.
 *
 * Why this is bit-exact on every JS engine:
 *  - + - * on integers below 2^53 are exact; products are formed in doubles and floor-shifted back.
 *  - / and Math.sqrt are only ever used as a *guess* that an integer fix-up then corrects (see isqrt),
 *    so a 1-ulp difference between engines cannot change a result.
 *  - sin/cos/atan use tables built at load time from Taylor series that use only + - * / (IEEE-exact
 *    everywhere). Math.sin, Math.cos, Math.atan2, Math.pow, Math.hypot... are implementation-approximated
 *    by the spec and are never used.
 *
 * Operand ranges (documented, and enforced where cheap): |raw| < 2^31 for stored values; for mul/div the
 * intermediate product must stay below 2^53 (true for world-scale values, e.g. |a|,|b| < 2^26).
 */

/** Captured once: only ever an initial guess for isqrt. */
const SQRT_GUESS = Math.sqrt;

export const FRAC_BITS = 16;
export const ONE = 1 << FRAC_BITS;
export const HALF = ONE >> 1;
/** Exact power of two, so multiplying by it is an error-free scaling. */
const INV_ONE = 1 / ONE;

/** Full turn in binary angle units: 65536 = 360 degrees. Angles are integers, wrapped with & ANGLE_MASK. */
export const ANGLE_BITS = 16;
export const ANGLE_FULL = 1 << ANGLE_BITS;
export const ANGLE_MASK = ANGLE_FULL - 1;
export const ANGLE_HALF = ANGLE_FULL >> 1;
export const ANGLE_QUARTER = ANGLE_FULL >> 2;
export const ANGLE_EIGHTH = ANGLE_FULL >> 3;

const ISQRT_LIMIT = 4503599627370496; // 2^52: r*r and (r+1)*(r+1) stay exactly representable below this.

// ---------------------------------------------------------------------------------------------------
// Conversions
// ---------------------------------------------------------------------------------------------------

/** Integer -> fixed. */
export function fromInt(n: number): number {
  return n * ONE;
}

/** Fixed -> integer, rounding toward negative infinity (like an arithmetic shift). */
export function toInt(a: number): number {
  return Math.floor(a * INV_ONE);
}

/** Fixed -> integer, rounding to nearest (ties up). */
export function round(a: number): number {
  return Math.floor((a + HALF) * INV_ONE);
}

/**
 * Authoring-time constant: real -> fixed. Deterministic for any literal or any expression built from IEEE
 * basic operations (the scaling by 65536 is exact, Math.round is exact). Use it for tuning constants only.
 */
export function lit(real: number): number {
  return Math.round(real * ONE);
}

/** Presentation only (renderers, HUD text). Never feed the result back into a simulation. */
export function toFloat(a: number): number {
  return a * INV_ONE;
}

// ---------------------------------------------------------------------------------------------------
// Arithmetic
// ---------------------------------------------------------------------------------------------------

/** a * b, floor-shifted. */
export function mul(a: number, b: number): number {
  return Math.floor(a * b * INV_ONE);
}

/** a / b. Throws on a zero divisor: that is a programmer error, and a silent NaN would poison the state. */
export function div(a: number, b: number): number {
  if (b === 0) throw new RangeError('fixed: division by zero');
  return Math.floor((a * ONE) / b);
}

/** floor(a * b / c) for raw integers (e.g. percentages, ratios). */
export function mulDiv(a: number, b: number, c: number): number {
  if (c === 0) throw new RangeError('fixed: division by zero');
  return Math.floor((a * b) / c);
}

export function abs(a: number): number {
  return a < 0 ? -a : a;
}

export function sign(a: number): number {
  return a > 0 ? 1 : a < 0 ? -1 : 0;
}

export function min(a: number, b: number): number {
  return a < b ? a : b;
}

export function max(a: number, b: number): number {
  return a > b ? a : b;
}

export function clamp(a: number, lo: number, hi: number): number {
  return a < lo ? lo : a > hi ? hi : a;
}

/** a + (b - a) * t, with t a fixed fraction (0..ONE). */
export function lerp(a: number, b: number, t: number): number {
  return a + mul(b - a, t);
}

/** Exact floor(sqrt(n)) for integers 0 <= n < 2^52, independent of Math.sqrt precision. */
export function isqrt(n: number): number {
  if (!(n >= 0 && n < ISQRT_LIMIT)) throw new RangeError(`fixed: isqrt out of range (${n})`);
  let r = Math.floor(SQRT_GUESS(n));
  while (r * r > n) r--;
  while ((r + 1) * (r + 1) <= n) r++;
  return r;
}

/** sqrt of a non-negative fixed value. */
export function sqrt(a: number): number {
  return isqrt(a * ONE);
}

/** sqrt(dx^2 + dy^2) for fixed components. Needs |dx|,|dy| < ~2^25.5 raw (about 700 world units at 1 unit = 1). */
export function hypot(dx: number, dy: number): number {
  return isqrt(dx * dx + dy * dy);
}

/** Squared length in raw units (Q32.32 scale). Compare against another raw square, e.g. r * r. */
export function len2(dx: number, dy: number): number {
  return dx * dx + dy * dy;
}

// ---------------------------------------------------------------------------------------------------
// Trigonometry (tables built from IEEE-exact basic operations)
// ---------------------------------------------------------------------------------------------------

const SIN_BITS = 12;
const SIN_SIZE = 1 << SIN_BITS;
const SIN_QUARTER = SIN_SIZE >> 2;
const SIN_SHIFT = ANGLE_BITS - SIN_BITS;
const SIN_FRAC_MASK = (1 << SIN_SHIFT) - 1;

const ATAN_STEPS = 1024;
const TAYLOR_TERMS = 30;

function sinTaylor(x: number): number {
  const x2 = x * x;
  let term = x;
  let sum = x;
  for (let k = 1; k <= 14; k++) {
    term = (-term * x2) / ((2 * k) * (2 * k + 1));
    sum += term;
  }
  return sum;
}

function atanSmall(y: number): number {
  const y2 = y * y;
  let term = y;
  let sum = y;
  for (let k = 1; k <= TAYLOR_TERMS; k++) {
    term = -term * y2;
    sum += term / (2 * k + 1);
  }
  return sum;
}

function atanUnit(x: number): number {
  // x in [0, 1]. Above 0.5 use atan(x) = pi/4 - atan((1-x)/(1+x)) so the series argument stays <= 1/2.
  if (x > 0.5) return Math.PI / 4 - atanSmall((1 - x) / (1 + x));
  return atanSmall(x);
}

function buildSinTable(): Int32Array {
  const table = new Int32Array(SIN_SIZE + 1);
  const halfPi = Math.PI / 2;
  for (let i = 0; i <= SIN_QUARTER; i++) {
    const v = Math.round(sinTaylor(halfPi * (i / SIN_QUARTER)) * ONE);
    table[i] = v;
    table[2 * SIN_QUARTER - i] = v;
    table[2 * SIN_QUARTER + i] = -v;
    table[4 * SIN_QUARTER - i] = -v;
  }
  table[SIN_SIZE] = table[0];
  return table;
}

function buildAtanTable(): Int32Array {
  const table = new Int32Array(ATAN_STEPS + 1);
  const anglePerRadian = ANGLE_FULL / (2 * Math.PI);
  for (let i = 0; i <= ATAN_STEPS; i++) table[i] = Math.round(atanUnit(i / ATAN_STEPS) * anglePerRadian);
  return table;
}

const SIN_TABLE = buildSinTable();
const ATAN_TABLE = buildAtanTable();

/** Exposed so runtimes can be compared: identical on every conforming engine. */
export function trigTables(): { readonly sin: Int32Array; readonly atan: Int32Array } {
  return { sin: SIN_TABLE, atan: ATAN_TABLE };
}

/** Degrees -> binary angle (authoring-time constant). */
export function deg(degrees: number): number {
  return Math.round((degrees * ANGLE_FULL) / 360) & ANGLE_MASK;
}

/** Fraction of a turn -> binary angle (authoring-time constant). */
export function turns(fraction: number): number {
  return Math.round(fraction * ANGLE_FULL) & ANGLE_MASK;
}

/** Binary angle -> radians. Presentation only. */
export function toRadians(angle: number): number {
  return (angle & ANGLE_MASK) * ((2 * Math.PI) / ANGLE_FULL);
}

/** Radians -> binary angle. For turning device input (mouse, sticks) into a quantised sim input; not for sim code. */
export function fromRadians(radians: number): number {
  return Math.round(radians * (ANGLE_FULL / (2 * Math.PI))) & ANGLE_MASK;
}

/**
 * sin of a binary angle as a fixed value in [-ONE, ONE], linearly interpolated between table entries.
 * The angle is first folded into the first quadrant, so the result is exactly odd and mirror symmetric
 * (mirrored geometry stays bit-identical).
 */
export function sin(angle: number): number {
  let a = angle & ANGLE_MASK;
  const negative = a >= ANGLE_HALF;
  if (negative) a -= ANGLE_HALF;
  if (a > ANGLE_QUARTER) a = ANGLE_HALF - a;
  const i = a >> SIN_SHIFT;
  const s0 = SIN_TABLE[i];
  const v = s0 + (((SIN_TABLE[i + 1] - s0) * (a & SIN_FRAC_MASK)) >> SIN_SHIFT);
  return negative ? -v : v;
}

export function cos(angle: number): number {
  return sin(angle + ANGLE_QUARTER);
}

function atanRatio(n: number, d: number): number {
  // angle of atan(n/d) for 0 <= n <= d, d > 0, in binary angle units [0, ANGLE_EIGHTH].
  const scaled = n * ATAN_STEPS;
  const i = Math.floor(scaled / d);
  if (i >= ATAN_STEPS) return ATAN_TABLE[ATAN_STEPS];
  const rem = scaled - i * d;
  const a0 = ATAN_TABLE[i];
  return a0 + Math.floor(((ATAN_TABLE[i + 1] - a0) * rem) / d);
}

/** Direction of (x, y) as a binary angle: 0 = +x, ANGLE_QUARTER = +y (counter-clockwise). atan2(0,0) = 0. */
export function atan2(y: number, x: number): number {
  if (x === 0 && y === 0) return 0;
  const ax = x < 0 ? -x : x;
  const ay = y < 0 ? -y : y;
  let a = ay <= ax ? atanRatio(ay, ax) : ANGLE_QUARTER - atanRatio(ax, ay);
  if (x < 0) a = ANGLE_HALF - a;
  if (y < 0) a = -a;
  return a & ANGLE_MASK;
}

/** Shortest signed difference to - from, in [-ANGLE_HALF, ANGLE_HALF). */
export function angleDiff(from: number, to: number): number {
  return ((to - from + ANGLE_HALF) & ANGLE_MASK) - ANGLE_HALF;
}

/** Rotates `current` toward `target` by at most `maxStep` (a non-negative angle). */
export function turnToward(current: number, target: number, maxStep: number): number {
  const diff = angleDiff(current, target);
  const step = diff > maxStep ? maxStep : diff < -maxStep ? -maxStep : diff;
  return (current + step) & ANGLE_MASK;
}
