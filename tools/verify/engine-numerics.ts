/**
 * Engine numerics eval: the fixed-point library against exact (BigInt) and floating references, the RNG,
 * hashing and the memory arena. Floating point is used here ONLY as an oracle; the engine never uses it.
 */
import { field, fx, hashBytes, hashEquals, hashToString, Rng, SimMemory } from '@metronome/engine';
import { check, finish, info, section } from './lib.ts';

function bigIsqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = BigInt(Math.floor(Math.sqrt(Number(n))));
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y === x || y === x + 1n && y * y > n) break;
    x = y;
  }
  while (x * x > n) x--;
  while ((x + 1n) * (x + 1n) <= n) x++;
  return x;
}

section('integer sqrt is exact');
{
  const rng = new Rng(new Uint32Array(4));
  rng.seed(12345);
  let bad = 0;
  const probe = (n: number) => {
    if (BigInt(fx.isqrt(n)) !== bigIsqrt(BigInt(n))) bad++;
  };
  for (let i = 0; i < 200000; i++) {
    const hi = rng.nextU32() & 0xfffff;
    probe(hi * 4294967296 * 0 + rng.nextU32() * (1 + (hi & 0x3ff)));
  }
  // Around perfect squares, where a 1-ulp error in Math.sqrt would show.
  for (let r = 1; r < 400000; r += 137) for (const d of [-1, 0, 1]) probe(r * r + d < 0 ? 0 : r * r + d);
  for (const n of [0, 1, 2, 3, 4, 4503599627370495, 2251799813685248]) probe(n);
  check('isqrt == exact BigInt floor sqrt (200k random + perfect-square neighbourhoods)', bad === 0, `${bad} mismatches`);
  let threw = false;
  try { fx.isqrt(4503599627370496); } catch { threw = true; }
  check('isqrt rejects out-of-range input loudly', threw);
}

section('trigonometry tables');
{
  let maxSin = 0;
  let maxCos = 0;
  for (let a = 0; a < fx.ANGLE_FULL; a++) {
    const rad = (a * 2 * Math.PI) / fx.ANGLE_FULL;
    maxSin = Math.max(maxSin, Math.abs(fx.sin(a) - Math.sin(rad) * fx.ONE));
    maxCos = Math.max(maxCos, Math.abs(fx.cos(a) - Math.cos(rad) * fx.ONE));
  }
  check('sin within 1.5 raw units of Math.sin over all 65536 angles', maxSin <= 1.5, `max err ${maxSin.toFixed(3)} raw`);
  check('cos within 1.5 raw units of Math.cos over all 65536 angles', maxCos <= 1.5, `max err ${maxCos.toFixed(3)} raw`);
  check('sin(0)=0, sin(90deg)=1, sin(180deg)=0, sin(270deg)=-1 exactly',
    fx.sin(0) === 0 && fx.sin(fx.ANGLE_QUARTER) === fx.ONE && fx.sin(fx.ANGLE_HALF) === 0 && fx.sin(3 * fx.ANGLE_QUARTER) === -fx.ONE);
  let symmetric = true;
  for (let a = 0; a < fx.ANGLE_FULL; a += 7) if (fx.sin(-a) !== -fx.sin(a) || fx.sin(fx.ANGLE_HALF - a) !== fx.sin(a)) symmetric = false;
  check('sin is exactly odd and mirror symmetric', symmetric);

  let maxAtan = 0;
  let worst = '';
  const steps = 400;
  for (let iy = -steps; iy <= steps; iy++) {
    for (let ix = -steps; ix <= steps; ix++) {
      if (ix === 0 && iy === 0) continue;
      const got = fx.atan2(iy * 917, ix * 917);
      const want = (((Math.atan2(iy, ix) * fx.ANGLE_FULL) / (2 * Math.PI)) % fx.ANGLE_FULL + fx.ANGLE_FULL) % fx.ANGLE_FULL;
      let err = Math.abs(got - want);
      err = Math.min(err, fx.ANGLE_FULL - err);
      if (err > maxAtan) { maxAtan = err; worst = `${ix},${iy}`; }
    }
  }
  check('atan2 within 1.5 angle units (0.008 deg) of Math.atan2 on a 801x801 grid', maxAtan <= 1.5, `max ${maxAtan.toFixed(3)} at ${worst}`);
  check('atan2 axes', fx.atan2(0, 5) === 0 && fx.atan2(5, 0) === fx.ANGLE_QUARTER && fx.atan2(0, -5) === fx.ANGLE_HALF && fx.atan2(-5, 0) === 3 * fx.ANGLE_QUARTER);
  check('turnToward takes the short way and never overshoots',
    fx.turnToward(100, fx.ANGLE_FULL - 100, 50) === 50 && fx.turnToward(0, 30, 50) === 30 && fx.angleDiff(10, 20) === 10 && fx.angleDiff(20, 10) === -10);

  const tables = fx.trigTables();
  const fp = hashBytes(new Uint8Array(tables.sin.buffer.slice(0))).lo ^ hashBytes(new Uint8Array(tables.atan.buffer.slice(0))).hi;
  info(`table fingerprint ${(fp >>> 0).toString(16)} (compared across JS engines by cross-engine.ts)`);
}

section('fixed-point arithmetic');
{
  check('mul / div / lit round trips', fx.mul(fx.fromInt(3), fx.lit(0.5)) === fx.lit(1.5) && fx.div(fx.fromInt(3), fx.fromInt(2)) === fx.lit(1.5) && fx.mul(fx.lit(-0.5), fx.lit(0.5)) === fx.lit(-0.25));
  check('floor semantics for negatives (arithmetic shift)', fx.toInt(fx.lit(-1.5)) === -2 && fx.toInt(fx.lit(1.5)) === 1 && fx.mul(-1, 1) === -1);
  check('hypot(3,4)=5 exactly', fx.hypot(fx.fromInt(3), fx.fromInt(4)) === fx.fromInt(5));
  let threw = false;
  try { fx.div(1, 0); } catch { threw = true; }
  check('division by zero fails loudly instead of producing NaN', threw);
  let exact = true;
  for (let a = -3000; a <= 3000; a += 13) for (let b = -3000; b <= 3000; b += 17) {
    const want = Number((BigInt(a * 4093) * BigInt(b * 4111)) >> 16n);
    if (fx.mul(a * 4093, b * 4111) !== want) exact = false;
  }
  check('mul == exact 64-bit floor-shifted product for operands up to ~12M raw', exact);
}

section('rng');
{
  const mem = new SimMemory({ rng: field.u32(4) });
  const rng = new Rng(mem.f.rng);
  rng.seed(99);
  const first = Array.from({ length: 8 }, () => rng.nextU32());
  rng.seed(99);
  const again = Array.from({ length: 8 }, () => rng.nextU32());
  check('same seed, same sequence', first.every((v, i) => v === again[i]));
  rng.seed(99, 1);
  check('different stream, different sequence', rng.nextU32() !== first[0]);
  rng.seed(7);
  const buckets = new Array<number>(16).fill(0);
  const samples = 320000;
  for (let i = 0; i < samples; i++) buckets[rng.int(16)]++;
  const expected = samples / 16;
  const worstBucket = Math.max(...buckets.map((b) => Math.abs(b - expected) / expected));
  check('int(16) is uniform within 2% over 320k draws', worstBucket < 0.02, `worst deviation ${(worstBucket * 100).toFixed(2)}%`);
  rng.seed(5);
  const snapshot = mem.snapshot();
  const a = rng.nextU32();
  mem.restore(snapshot);
  check('rng state lives in sim memory: restore rewinds the sequence', rng.nextU32() === a);
  let zeroSeed = true;
  for (const seed of [0, 1, 0xffffffff]) { rng.seed(seed); if (rng.state.every((w) => w === 0)) zeroSeed = false; }
  check('no seed produces the all-zero (stuck) state', zeroSeed);
}

section('hash + memory arena');
{
  const layout = { a: field.i32(100), b: field.u8(33), c: field.i16(7) } as const;
  const m1 = new SimMemory(layout);
  const m2 = new SimMemory(layout);
  check('identical layouts hash identically when empty', hashEquals(m1.hash(), m2.hash()));
  check('layout hash is stable', hashEquals(m1.layoutHash, m2.layoutHash));
  m1.f.b[32] = 1;
  check('a single flipped bit changes the checksum', !hashEquals(m1.hash(), m2.hash()));
  const snap = m1.snapshot();
  m1.f.a[50] = 12345;
  m1.restore(snap);
  check('snapshot/restore round trips', m1.f.a[50] === 0 && m1.f.b[32] === 1);
  const other = new SimMemory({ a: field.i32(100), b: field.u8(34), c: field.i16(7) });
  check('a different layout has a different layout hash', !hashEquals(m1.layoutHash, other.layoutHash));
  let threw = false;
  try { other.restore(snap); } catch { threw = true; }
  check('restoring a snapshot of another layout fails loudly', threw);
  const h = hashBytes(new Uint8Array([1, 2, 3, 4, 5]));
  check('hashBytes handles unaligned tails', hashToString(h).length === 16 && !hashEquals(h, hashBytes(new Uint8Array([1, 2, 3, 4, 6]))));
}

finish('engine-numerics');
