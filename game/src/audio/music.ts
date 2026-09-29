import { AUDIO_SAMPLE_RATE, midiToHz } from './synth.ts';
import type { Track } from './synth.ts';

const MUSIC_SAMPLE_RATE = AUDIO_SAMPLE_RATE;
const LOOP_TAIL_BEATS = 4;
const STINGER_TAIL_BEATS = 4;
const BEATS_PER_BAR = 4;
const SIXTEENTHS_PER_BAR = 16;
const IN_MATCH_BPM = 145;
const MAIN_ROOT = 40;
/** Bars per streamed section (the worker renders one section per request). */
export const SECTION_BARS = 8;
const RENDER_YIELD_BARS = 4;
const TWO_PI = Math.PI * 2;
/** Sample-peak ceiling of the limiter: 2.2 dB under full scale keeps inter-sample (true) peaks under -1 dBTP. */
export const LIMITER_CEILING = 10 ** (-2.2 / 20);
const NYQUIST_HEADROOM = 0.94;
const DC_BLOCK_HZ = 20;
const REVERB_SEND_HIGHPASS_HZ = 200;
export const LIMITER_LOOKAHEAD_SECONDS = 0.005;
const LIMITER_RELEASE_SECONDS = 0.08;
/** Phrase level changes (battle): quick fades over the last beat of a phrase; a build rises across its whole length. */
const RIDE_FADE_BARS = 0.25;
const RIDE_INTRO_DB = -3.5;
const RIDE_THEME_DB = -2;
const RIDE_BUILD_START_DB = -4;
const FREEVERB_REFERENCE_RATE = 44100;
const FREEVERB_STEREO_SPREAD = 23;
const FREEVERB_ROOM = 0.84;
const FREEVERB_DAMP = 0.28;
const FREEVERB_WET = 0.13;
const FREEVERB_COMBS = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617] as const;
const FREEVERB_ALLPASSES = [556, 441, 341, 225] as const;
const TITLE_BARS = 16;
const BATTLE_BARS = 64;
const BOSS_BARS = 32;
const SUDDEN_BARS = 32;

type TrackStyle = 'title' | 'battle' | 'bossForm' | 'sudden' | 'victory' | 'defeat';
type TrackFamily = 'menu' | 'match' | 'stinger';
type Instrument = 'lead' | 'answer' | 'boss' | 'alarm';
type Wave = 'sine' | 'saw' | 'square' | 'triangle';
type Bus = 'dry' | 'duck' | 'fx' | 'lead';

interface NoteEvent { readonly bar: number; readonly step: number; readonly midi: number; readonly length: number }
interface ChordEvent { readonly root: number; readonly notes: readonly number[] }

export interface RenderedMusic {
  readonly sampleRate: number;
  readonly left: Float32Array;
  readonly right: Float32Array;
}

export interface TrackSpec {
  readonly id: Track;
  readonly bpm: number;
  readonly bars: number;
  readonly loop: boolean;
  readonly rootMidi: number;
  readonly key: string;
  readonly family: TrackFamily;
  readonly style: TrackStyle;
  readonly progression: readonly ChordEvent[];
  /**
   * Fixed master gain before the limiter, measured once per track so its integrated loudness is about -15 LUFS
   * (tools/verify/audio.ts asserts the range). Fixed, not measured per render: every section of a track gets the same
   * gain, so sections streamed one by one play exactly like the whole track.
   */
  readonly gain: number;
}

const EM_I: ChordEvent = { root: 40, notes: [40, 47, 52, 55, 59] };
const EM_VI: ChordEvent = { root: 48, notes: [48, 52, 55, 60, 64] };
const EM_III: ChordEvent = { root: 43, notes: [43, 47, 50, 55, 59] };
const EM_VII: ChordEvent = { root: 50, notes: [50, 54, 57, 62, 66] };
const EM_IV: ChordEvent = { root: 45, notes: [45, 52, 57, 60, 64] };
const EM_V: ChordEvent = { root: 47, notes: [47, 51, 54, 59, 63] };
const EM_FLAT_II: ChordEvent = { root: 41, notes: [41, 48, 53, 56, 60] };
const TITLE_PROGRESSION = [
  { root: 52, notes: [52, 59, 64, 67, 71] },
  { root: 60, notes: [60, 64, 67, 72, 76] },
  { root: 55, notes: [55, 59, 62, 67, 71] },
  { root: 62, notes: [62, 66, 69, 74, 78] },
] as const;
const BATTLE_PROGRESSION = [EM_I, EM_VI, EM_III, EM_VII] as const;
const BOSS_PROGRESSION = [EM_I, EM_FLAT_II, EM_VI, EM_V] as const;
const SUDDEN_PROGRESSION = [EM_I, EM_FLAT_II, EM_III, EM_V] as const;
const VICTORY_PROGRESSION = [
  { root: 52, notes: [52, 56, 59, 64, 68] },
  { root: 60, notes: [60, 64, 67, 72, 76] },
  { root: 55, notes: [55, 59, 62, 67, 71] },
  { root: 52, notes: [52, 56, 59, 64, 76] },
] as const;
const DEFEAT_PROGRESSION = [EM_V, EM_IV, EM_FLAT_II, EM_I] as const;

export const TRACK_SPECS: Record<Track, TrackSpec> = {
  title: { id: 'title', bpm: 136, bars: TITLE_BARS, loop: true, rootMidi: 52, key: 'E minor', family: 'menu', style: 'title', progression: TITLE_PROGRESSION, gain: 1.646 },
  battle: { id: 'battle', bpm: IN_MATCH_BPM, bars: BATTLE_BARS, loop: true, rootMidi: MAIN_ROOT, key: 'E minor', family: 'match', style: 'battle', progression: BATTLE_PROGRESSION, gain: 1.023 },
  bossForm: { id: 'bossForm', bpm: IN_MATCH_BPM, bars: BOSS_BARS, loop: true, rootMidi: MAIN_ROOT, key: 'E phrygian/minor', family: 'match', style: 'bossForm', progression: BOSS_PROGRESSION, gain: 0.82 },
  sudden: { id: 'sudden', bpm: IN_MATCH_BPM, bars: SUDDEN_BARS, loop: true, rootMidi: MAIN_ROOT, key: 'E phrygian/minor', family: 'match', style: 'sudden', progression: SUDDEN_PROGRESSION, gain: 0.86 },
  victory: { id: 'victory', bpm: IN_MATCH_BPM, bars: 2, loop: false, rootMidi: 52, key: 'E major', family: 'stinger', style: 'victory', progression: VICTORY_PROGRESSION, gain: 1.296 },
  defeat: { id: 'defeat', bpm: IN_MATCH_BPM, bars: 2, loop: false, rootMidi: MAIN_ROOT, key: 'E minor', family: 'stinger', style: 'defeat', progression: DEFEAT_PROGRESSION, gain: 1.841 },
};

const BATTLE_HOOK = [
  [0, 0, 76, 2], [0, 2, 78, 2], [0, 4, 79, 4], [0, 8, 83, 2], [0, 10, 81, 2], [0, 12, 79, 4],
  [1, 0, 76, 2], [1, 2, 78, 2], [1, 4, 79, 2], [1, 6, 83, 2], [1, 8, 86, 4], [1, 12, 83, 4],
  [2, 0, 83, 2], [2, 2, 81, 2], [2, 4, 79, 4], [2, 8, 78, 2], [2, 10, 79, 2], [2, 12, 81, 4],
  [3, 0, 79, 2], [3, 2, 78, 2], [3, 4, 76, 4], [3, 8, 74, 2], [3, 10, 76, 2], [3, 12, 78, 4],
] as const;
const BATTLE_ANSWER = [
  [0, 8, 88, 2], [0, 10, 86, 2], [0, 12, 83, 2], [0, 14, 86, 2],
  [1, 8, 91, 3], [1, 12, 90, 2], [1, 14, 86, 2],
  [2, 8, 86, 2], [2, 10, 84, 2], [2, 12, 83, 4],
  [3, 8, 81, 2], [3, 10, 83, 2], [3, 12, 78, 4],
] as const;
const BATTLE_BREAK = [
  [0, 0, 71, 4], [0, 4, 74, 4], [0, 8, 76, 8],
  [1, 0, 78, 4], [1, 4, 79, 4], [1, 8, 83, 8],
  [2, 0, 83, 4], [2, 4, 81, 4], [2, 8, 79, 8],
  [3, 0, 78, 4], [3, 4, 76, 4], [3, 8, 74, 8],
] as const;
const BOSS_MOTIF = [
  [0, 0, 64, 2], [0, 2, 65, 1], [0, 3, 64, 1], [0, 4, 71, 4], [0, 8, 64, 2], [0, 10, 65, 2], [0, 12, 67, 4],
  [1, 0, 65, 2], [1, 2, 64, 2], [1, 4, 72, 4], [1, 8, 76, 2], [1, 10, 72, 2], [1, 12, 71, 4],
  [2, 0, 67, 2], [2, 2, 68, 1], [2, 3, 67, 1], [2, 4, 76, 4], [2, 8, 79, 2], [2, 10, 76, 2], [2, 12, 72, 4],
  [3, 0, 71, 2], [3, 2, 70, 2], [3, 4, 64, 4], [3, 8, 65, 2], [3, 10, 64, 2], [3, 12, 59, 4],
] as const;
const SUDDEN_ALARM = [
  [0, 0, 88, 1], [0, 2, 88, 1], [0, 4, 89, 1], [0, 6, 88, 1], [0, 8, 91, 1], [0, 10, 88, 1], [0, 12, 89, 1], [0, 14, 88, 1],
  [1, 0, 88, 1], [1, 2, 91, 1], [1, 4, 93, 2], [1, 8, 91, 1], [1, 10, 89, 1], [1, 12, 88, 4],
  [2, 0, 91, 1], [2, 2, 91, 1], [2, 4, 93, 1], [2, 6, 91, 1], [2, 8, 96, 2], [2, 12, 95, 4],
  [3, 0, 89, 1], [3, 2, 88, 1], [3, 4, 86, 2], [3, 8, 88, 1], [3, 10, 89, 1], [3, 12, 91, 4],
] as const;
const TITLE_HOOK = [
  [0, 0, 76, 4], [0, 6, 78, 2], [0, 8, 79, 6], [1, 0, 83, 4], [1, 6, 81, 2], [1, 8, 79, 8],
  [2, 0, 76, 4], [2, 8, 78, 4], [2, 12, 81, 4], [3, 0, 79, 4], [3, 8, 76, 8],
] as const;
const VICTORY_HOOK = [
  [0, 0, 76, 2], [0, 2, 78, 2], [0, 4, 80, 2], [0, 6, 83, 2], [0, 8, 88, 4], [0, 12, 87, 2], [0, 14, 88, 2],
  [1, 0, 92, 8], [1, 8, 88, 8],
] as const;
const DEFEAT_HOOK = [
  [0, 0, 79, 4], [0, 4, 78, 4], [0, 8, 76, 4], [0, 12, 71, 4],
  [1, 0, 72, 4], [1, 4, 71, 4], [1, 8, 67, 8],
] as const;
const ARP_PATTERN = [0, 2, 4, 2, 1, 2, 4, 2, 0, 2, 3, 2, 1, 2, 4, 2] as const;
const BOSS_ARP_PATTERN = [0, 1, 4, 1, 0, 1, 3, 1, 0, 1, 4, 1, 2, 1, 3, 1] as const;

function trackSpecOf(track: Track | TrackSpec): TrackSpec { return typeof track === 'string' ? TRACK_SPECS[track] : track }
function arrangementSeconds(spec: TrackSpec): number { return (spec.bars * BEATS_PER_BAR * 60) / spec.bpm }
export function getTrackDuration(track: Track | TrackSpec): number {
  const spec = trackSpecOf(track);
  return arrangementSeconds(spec) + (spec.loop ? 0 : (60 / spec.bpm) * STINGER_TAIL_BEATS);
}
function eventList(rows: readonly (readonly [number, number, number, number])[]): readonly NoteEvent[] {
  return rows.map(([bar, step, midi, length]) => ({ bar, step, midi, length }));
}
function chordAt(spec: TrackSpec, bar: number): ChordEvent { return spec.progression[bar % spec.progression.length] }
function secondsAt(beat: number, bar: number, step = 0): number { return (bar * BEATS_PER_BAR + step * 0.25) * beat }
function clamp(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, value)) }
function clampFrequency(sampleRate: number, hz: number): number { return clamp(hz, 1, sampleRate * 0.5 * NYQUIST_HEADROOM) }
function polyBlep(phase: number, increment: number): number {
  if (phase < increment) {
    const t = phase / increment;
    return t + t - t * t - 1;
  }
  if (phase > 1 - increment) {
    const t = (phase - 1) / increment;
    return t * t + t + t + 1;
  }
  return 0;
}
function bandLimitedWave(type: Wave, phase: number, increment: number): number {
  const p = phase - Math.floor(phase);
  if (type === 'sine') return Math.sin(TWO_PI * p);
  if (type === 'triangle') return 1 - 4 * Math.abs(Math.round(p - 0.25) - (p - 0.25));
  if (increment > 2 && (type === 'saw' || type === 'square')) {
    const maxHarmonic = Math.max(1, Math.floor(0.48 / increment));
    let sum = 0;
    let norm = 0;
    for (let h = 1; h <= maxHarmonic; h++) {
      if (type === 'square' && h % 2 === 0) continue;
      const amp = 1 / h;
      sum += Math.sin(TWO_PI * p * h) * amp;
      norm += amp;
    }
    return norm > 0 ? sum / norm : 0;
  }
  if (type === 'square') {
    let value = p < 0.5 ? 1 : -1;
    value += polyBlep(p, increment);
    value -= polyBlep((p + 0.5) % 1, increment);
    return value;
  }
  return 2 * p - 1 - polyBlep(p, increment);
}
function noiseAt(index: number, seed: number): number {
  let state = (index + seed * 374761393) | 0;
  state = Math.imul(state ^ (state >>> 13), 1274126177);
  return ((state ^ (state >>> 16)) >>> 0) / 0x80000000 - 1;
}
function seededPhase(seed: number): number {
  return (noiseAt(seed, 313) + 1) * 0.5;
}
function attackRelease(pos: number, length: number, attack: number, release: number): number {
  const a = Math.max(1, attack);
  const r = Math.max(1, release);
  if (pos < a) return pos / a;
  if (pos > length - r) return Math.max(0, (length - pos) / r);
  return 1;
}
function expDecay(pos: number, length: number, power: number): number { return Math.pow(Math.max(0, 1 - pos / Math.max(1, length)), power) }

class SvfFilter {
  private ic1 = 0;
  private ic2 = 0;
  private readonly sampleRate: number;
  constructor(sampleRate: number) { this.sampleRate = sampleRate; }
  process(input: number, cutoffHz: number, q: number, mode: 'lowpass' | 'highpass'): number {
    const g = Math.tan(Math.PI * clampFrequency(this.sampleRate, cutoffHz) / this.sampleRate);
    const k = 1 / Math.max(0.2, q);
    const a1 = 1 / (1 + g * (g + k));
    const a2 = g * a1;
    const a3 = g * a2;
    const v3 = input - this.ic2;
    const v1 = a1 * this.ic1 + a2 * v3;
    const v2 = this.ic2 + a2 * this.ic1 + a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    return mode === 'lowpass' ? v2 : input - k * v1 - v2;
  }
}

interface ToneOptions {
  readonly bus: Bus;
  readonly cutoffStart: number;
  readonly cutoffEnd: number;
  readonly q: number;
  readonly highpass: number;
  readonly send: number;
  readonly phaseSeed: number;
}

const DEFAULT_TONE: ToneOptions = {
  bus: 'duck', cutoffStart: 4200, cutoffEnd: 1800, q: 0.8, highpass: 140, send: 0.08, phaseSeed: 1,
};

class BufferWriter {
  private readonly left: Float32Array;
  private readonly right: Float32Array;
  private readonly duckLeft: Float32Array;
  private readonly duckRight: Float32Array;
  private readonly fxLeft: Float32Array;
  private readonly fxRight: Float32Array;
  private readonly leadLeft: Float32Array;
  private readonly leadRight: Float32Array;
  private readonly sampleRate: number;
  /** Absolute track time (seconds) of the buffer's first sample: a section's notes are placed relative to it. */
  private readonly origin: number;
  /** Absolute times, like every time given to this writer. */
  private readonly kickTimes: number[] = [];

  constructor(sampleRate: number, seconds: number, origin: number) {
    this.sampleRate = sampleRate;
    this.origin = origin;
    const length = Math.max(1, Math.round(seconds * sampleRate));
    this.left = new Float32Array(length);
    this.right = new Float32Array(length);
    this.duckLeft = new Float32Array(length);
    this.duckRight = new Float32Array(length);
    this.fxLeft = new Float32Array(length);
    this.fxRight = new Float32Array(length);
    this.leadLeft = new Float32Array(length);
    this.leadRight = new Float32Array(length);
  }

  rendered(): RenderedMusic {
    return { sampleRate: this.sampleRate, left: this.left, right: this.right };
  }

  get frames(): number {
    return this.left.length;
  }

  /** Buffer frame of an absolute track time. */
  private frameOf(seconds: number): number {
    return Math.floor((seconds - this.origin) * this.sampleRate);
  }

  private busArrays(bus: Bus): readonly [Float32Array, Float32Array] {
    if (bus === 'duck') return [this.duckLeft, this.duckRight];
    if (bus === 'fx') return [this.fxLeft, this.fxRight];
    if (bus === 'lead') return [this.leadLeft, this.leadRight];
    return [this.left, this.right];
  }

  tone(start: number, duration: number, midi: number, waveType: Wave, gain: number, pan: number, detuneCents = 0, options: Partial<ToneOptions> = {}): void {
    const opts = { ...DEFAULT_TONE, ...options };
    const [busL, busR] = this.busArrays(opts.bus);
    const startFrame = Math.max(0, this.frameOf(start));
    const frames = Math.max(1, Math.floor(duration * this.sampleRate));
    const end = Math.min(this.left.length, startFrame + frames);
    const hz = clampFrequency(this.sampleRate, midiToHz(midi) * Math.pow(2, detuneCents / 1200));
    const phaseStep = hz / this.sampleRate;
    const lGain = gain * Math.cos((pan + 1) * Math.PI * 0.25);
    const rGain = gain * Math.sin((pan + 1) * Math.PI * 0.25);
    let phase = seededPhase(opts.phaseSeed + Math.floor(midi * 11 + detuneCents * 3 + startFrame));
    const attack = Math.floor(this.sampleRate * 0.006);
    const release = Math.floor(Math.min(frames * 0.45, this.sampleRate * 0.09));
    const lowL = new SvfFilter(this.sampleRate);
    const lowR = new SvfFilter(this.sampleRate);
    const hpL = new SvfFilter(this.sampleRate);
    const hpR = new SvfFilter(this.sampleRate);
    for (let i = startFrame; i < end; i++) {
      const pos = i - startFrame;
      const t = pos / Math.max(1, frames - 1);
      const env = attackRelease(pos, frames, attack, release);
      const cutoff = opts.cutoffStart * Math.pow(Math.max(0.001, opts.cutoffEnd / opts.cutoffStart), t);
      let sample = bandLimitedWave(waveType, phase, phaseStep) * env;
      let l = lowL.process(sample * lGain, cutoff, opts.q, 'lowpass');
      let r = lowR.process(sample * rGain, cutoff, opts.q, 'lowpass');
      if (opts.highpass > 0) {
        l = hpL.process(l, opts.highpass, 0.7, 'highpass');
        r = hpR.process(r, opts.highpass, 0.7, 'highpass');
      }
      busL[i] += l;
      busR[i] += r;
      if (opts.send > 0) {
        this.fxLeft[i] += l * opts.send;
        this.fxRight[i] += r * opts.send;
      }
      phase += phaseStep;
      phase -= Math.floor(phase);
    }
  }

  supersaw(start: number, duration: number, notes: readonly number[], gain: number, opening = false): void {
    const detunes = [-18, -11, -5, 0, 5, 11, 18] as const;
    const voiceGain = gain / Math.max(1, notes.length * detunes.length) * 2.35;
    for (const note of notes) {
      for (let i = 0; i < detunes.length; i++) {
        this.tone(start, duration, note, 'saw', voiceGain, (i - 3) * 0.23, detunes[i], {
          bus: 'duck', cutoffStart: opening ? 1200 : 3600, cutoffEnd: opening ? 6200 : 2300, q: 0.95, highpass: 180, send: 0.26, phaseSeed: 101 + i,
        });
      }
      this.tone(start, duration, note - 12, 'saw', voiceGain * 0.5, 0, 0, { bus: 'duck', cutoffStart: 1800, cutoffEnd: 1400, q: 0.7, highpass: 160, send: 0.12, phaseSeed: 151 });
    }
  }

  lead(start: number, duration: number, midi: number, gain: number, pan: number): void {
    for (const detune of [-9, 0, 9] as const) this.tone(start, duration, midi, 'saw', gain / 2.2, pan + detune / 90, detune, {
      bus: 'lead', cutoffStart: 6800, cutoffEnd: 4200, q: 0.8, highpass: 220, send: 0.16, phaseSeed: 211 + detune,
    });
    this.tone(start, duration, midi + 12, 'square', gain * 0.13, pan * -0.5, 0, { bus: 'lead', cutoffStart: 5200, cutoffEnd: 3400, q: 0.9, highpass: 400, send: 0.08, phaseSeed: 233 });
  }

  bass(start: number, duration: number, midi: number, gain: number, reese: boolean): void {
    if (reese) {
      this.tone(start, duration, midi, 'saw', gain * 0.48, -0.08, -7, { bus: 'duck', cutoffStart: 1350, cutoffEnd: 420, q: 1.2, highpass: 28, send: 0, phaseSeed: 301 });
      this.tone(start, duration, midi, 'saw', gain * 0.48, 0.08, 7, { bus: 'duck', cutoffStart: 1350, cutoffEnd: 420, q: 1.2, highpass: 28, send: 0, phaseSeed: 307 });
    } else {
      this.tone(start, duration, midi, 'saw', gain * 0.52, 0, 0, { bus: 'duck', cutoffStart: 950, cutoffEnd: 260, q: 1.05, highpass: 25, send: 0, phaseSeed: 311 });
    }
    this.tone(start, duration, midi - 12, 'sine', gain * 0.68, 0, 0, { bus: 'duck', cutoffStart: 180, cutoffEnd: 120, q: 0.7, highpass: 20, send: 0, phaseSeed: 313 });
  }

  kick(start: number, gain: number): void {
    this.kickTimes.push(start);
    const startFrame = this.frameOf(start);
    const frames = Math.floor(this.sampleRate * 0.34);
    for (let pos = 0; pos < frames; pos++) {
      const i = startFrame + pos;
      if (i < 0 || i >= this.left.length) continue;
      const t = pos / this.sampleRate;
      const hz = 45 + 115 * Math.exp(-t * 22);
      const body = Math.sin(TWO_PI * hz * t) * expDecay(pos, frames, 2.5);
      const click = noiseAt(i, 12) * Math.exp(-t * 120) * 0.16;
      const sample = Math.tanh((body + click) * 1.5) * gain;
      this.left[i] += sample;
      this.right[i] += sample;
    }
  }

  snare(start: number, gain: number): void {
    const startFrame = this.frameOf(start);
    const frames = Math.floor(this.sampleRate * 0.18);
    for (let pos = 0; pos < frames; pos++) {
      const i = startFrame + pos;
      if (i < 0 || i >= this.left.length) continue;
      const t = pos / this.sampleRate;
      const env = expDecay(pos, frames, 2.2);
      const body = Math.sin(TWO_PI * (210 - 80 * t) * t) * 0.35;
      const snap = (noiseAt(i, 31) - noiseAt(i - 1, 31)) * 0.58;
      const sample = (body + snap) * env * gain;
      this.left[i] += sample * 0.94;
      this.right[i] += sample;
      this.fxLeft[i] += sample * 0.16;
      this.fxRight[i] += sample * 0.18;
    }
  }

  clap(start: number, gain: number): void { for (const offset of [0, 0.014, 0.027] as const) this.snare(start + offset, gain * 0.28) }

  hat(start: number, open: boolean, gain: number, pan: number): void {
    const startFrame = this.frameOf(start);
    const frames = Math.floor(this.sampleRate * (open ? 0.22 : 0.06));
    const lGain = gain * Math.cos((pan + 1) * Math.PI * 0.25);
    const rGain = gain * Math.sin((pan + 1) * Math.PI * 0.25);
    for (let pos = 1; pos < frames; pos++) {
      const i = startFrame + pos;
      if (i < 0 || i >= this.left.length) continue;
      const bright = noiseAt(i, 43) - noiseAt(i - 1, 43);
      const metal = Math.sin(i * 0.37) + Math.sin(i * 0.271) + Math.sin(i * 0.191);
      const sample = (bright * 0.58 + metal * 0.11) * expDecay(pos, frames, open ? 1.5 : 3.8);
      this.left[i] += sample * lGain;
      this.right[i] += sample * rGain;
    }
  }

  crash(start: number, gain: number): void {
    const startFrame = this.frameOf(start);
    const frames = Math.floor(this.sampleRate * 1.15);
    for (let pos = 1; pos < frames; pos++) {
      const i = startFrame + pos;
      if (i < 0 || i >= this.left.length) continue;
      const sample = (noiseAt(i, 77) - noiseAt(i - 2, 77)) * expDecay(pos, frames, 1.35) * gain;
      this.left[i] += sample * 0.85;
      this.right[i] += sample;
      this.fxLeft[i] += sample * 0.05;
      this.fxRight[i] += sample * 0.06;
    }
  }

  impulseToFx(): void {
    this.fxLeft[0] = 1;
    this.fxRight[0] = 1;
  }

  constantToFx(seconds: number, level: number): void {
    const frames = Math.min(this.fxLeft.length, Math.floor(seconds * this.sampleRate));
    for (let i = 0; i < frames; i++) {
      this.fxLeft[i] = level;
      this.fxRight[i] = level;
    }
  }

  riser(start: number, duration: number, gain: number, up: boolean): void {
    const startFrame = this.frameOf(start);
    const frames = Math.max(1, Math.floor(duration * this.sampleRate));
    for (let pos = 0; pos < frames; pos++) {
      const i = startFrame + pos;
      if (i < 0 || i >= this.left.length) continue;
      const t = pos / frames;
      const toneHz = clampFrequency(this.sampleRate, up ? 400 + 7600 * t * t : 7600 - 7200 * t);
      const sample = (noiseAt(i, 91) * 0.5 + Math.sin(TWO_PI * toneHz * pos / this.sampleRate) * 0.18) * Math.sin(Math.PI * t) * gain;
      this.left[i] += sample * 0.85;
      this.right[i] += sample;
    }
  }

  private applySidechain(): void {
    const attackFrames = Math.max(1, Math.floor(this.sampleRate * 0.012));
    const releaseFrames = Math.max(1, Math.floor(this.sampleRate * 0.22));
    const curve = new Float32Array(this.duckLeft.length);
    curve.fill(1);
    for (const kick of this.kickTimes) {
      const start = Math.max(0, this.frameOf(kick));
      const end = Math.min(curve.length, start + attackFrames + releaseFrames);
      for (let i = start; i < end; i++) {
        const frame = i - start;
        const local = frame < attackFrames ? 0.28 + 0.72 * frame / attackFrames : 0.28 + 0.72 * Math.min(1, (frame - attackFrames) / releaseFrames);
        curve[i] = Math.min(curve[i], local);
      }
    }
    for (let i = 0; i < this.duckLeft.length; i++) {
      this.left[i] += this.duckLeft[i] * curve[i];
      this.right[i] += this.duckRight[i] * curve[i];
    }
  }

  private applyPingPongDelay(): void {
    const delayL = Math.floor(this.sampleRate * 0.31);
    const delayR = Math.floor(this.sampleRate * 0.465);
    for (let i = 0; i < this.leadLeft.length; i++) {
      const dryL = this.leadLeft[i];
      const dryR = this.leadRight[i];
      this.left[i] += dryL;
      this.right[i] += dryR;
      this.fxLeft[i] += (dryL + dryR) * 0.16;
      this.fxRight[i] += (dryL + dryR) * 0.16;
      if (i >= delayL) this.right[i] += this.leadLeft[i - delayL] * 0.24;
      if (i >= delayR) this.left[i] += this.leadRight[i - delayR] * 0.18;
    }
  }

  private applyReverb(): void {
    this.highpass(this.fxLeft, REVERB_SEND_HIGHPASS_HZ);
    this.highpass(this.fxRight, REVERB_SEND_HIGHPASS_HZ);
    const outL = this.freeverbChannel(this.fxLeft, 0);
    const outR = this.freeverbChannel(this.fxRight, FREEVERB_STEREO_SPREAD);
    this.dcBlock(outL);
    this.dcBlock(outR);
    for (let i = 0; i < this.left.length; i++) {
      this.left[i] += outL[i] * FREEVERB_WET;
      this.right[i] += outR[i] * FREEVERB_WET;
    }
  }

  private scaledDelay(samples: number, spread: number): number {
    return Math.max(1, Math.round((samples + spread) * this.sampleRate / FREEVERB_REFERENCE_RATE));
  }

  private freeverbChannel(input: Float32Array, spread: number): Float32Array {
    let sum = new Float32Array(input.length);
    for (const comb of FREEVERB_COMBS) {
      const delay = this.scaledDelay(comb, spread);
      const line = new Float32Array(delay);
      let index = 0;
      let dampState = 0;
      for (let i = 0; i < input.length; i++) {
        const delayed = line[index];
        dampState = delayed * (1 - FREEVERB_DAMP) + dampState * FREEVERB_DAMP;
        line[index] = input[i] + dampState * FREEVERB_ROOM;
        sum[i] += delayed;
        index = (index + 1) % delay;
      }
    }
    for (const allpass of FREEVERB_ALLPASSES) {
      const delay = this.scaledDelay(allpass, spread);
      const line = new Float32Array(delay);
      let index = 0;
      const next = new Float32Array(sum.length);
      for (let i = 0; i < sum.length; i++) {
        const buffered = line[index];
        const inputSample = sum[i];
        next[i] = buffered - inputSample;
        line[index] = inputSample + buffered * 0.5;
        index = (index + 1) % delay;
      }
      sum = next;
    }
    return sum;
  }

  /**
   * Effects, then the master chain: fixed gain, limiter, fader ride, DC removal (last, so nothing after it can shift the
   * waveform). The ride is master fader automation, one gain per sample as a function of absolute track time, so a
   * section's buffer (its tail included) is ridden exactly as the whole track.
   */
  finalize(masterGain: number, ride: Float32Array): void {
    this.applySidechain();
    this.applyPingPongDelay();
    this.applyReverb();
    for (let i = 0; i < this.left.length; i++) {
      this.left[i] *= masterGain;
      this.right[i] *= masterGain;
    }
    limitStereo(this.left, this.right, this.sampleRate);
    for (let i = 0; i < this.left.length; i++) {
      this.left[i] *= ride[i];
      this.right[i] *= ride[i];
    }
    this.dcBlock(this.left);
    this.dcBlock(this.right);
  }

  private highpass(data: Float32Array, hz: number): void {
    const rc = 1 / (TWO_PI * hz);
    const dt = 1 / this.sampleRate;
    const alpha = rc / (rc + dt);
    let previousInput = 0;
    let previousOutput = 0;
    for (let i = 0; i < data.length; i++) {
      const input = data[i];
      const output = alpha * (previousOutput + input - previousInput);
      data[i] = output;
      previousInput = input;
      previousOutput = output;
    }
  }

  private dcBlock(data: Float32Array): void {
    this.highpass(data, DC_BLOCK_HZ);
  }
}

/**
 * Stereo-linked look-ahead peak limiter, in place; returns the gain it applied to each sample (tools inspect it).
 * O(n): the gain each sample needs is min-held over the look-ahead (a sliding-window minimum), released exponentially,
 * then averaged over the look-ahead, so the gain glides down in time to meet every peak at the ceiling and never steps
 * (it moves by at most 1/lookahead per sample).
 */
export function limitStereo(left: Float32Array, right: Float32Array, sampleRate: number): Float32Array {
  const n = left.length;
  const lookahead = Math.max(1, Math.round(LIMITER_LOOKAHEAD_SECONDS * sampleRate));
  const releaseKeep = Math.exp(-1 / (LIMITER_RELEASE_SECONDS * sampleRate));
  const need = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const peak = Math.max(Math.abs(left[i]), Math.abs(right[i]));
    need[i] = peak > LIMITER_CEILING ? LIMITER_CEILING / peak : 1;
  }
  // held[i] = min(need[i .. i + lookahead - 1]): a monotonic deque of indices whose needs increase.
  const held = new Float32Array(n);
  const deque = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let j = 0; j < n + lookahead - 1; j++) {
    if (j < n) {
      while (tail > head && need[deque[tail - 1]] >= need[j]) tail--;
      deque[tail++] = j;
    }
    const i = j - lookahead + 1;
    if (i < 0) continue;
    while (deque[head] < i) head++;
    held[i] = need[deque[head]];
  }
  const gain = new Float32Array(n);
  if (n === 0) return gain;
  // The history before the buffer starts at held[0], which already meets every peak inside the first window.
  const history = new Float32Array(lookahead).fill(held[0]);
  let released = held[0];
  let sum = held[0] * lookahead;
  for (let i = 0; i < n; i++) {
    released = held[i] < released ? held[i] : held[i] + (released - held[i]) * releaseKeep;
    const slot = i % lookahead;
    sum += released - history[slot];
    history[slot] = released;
    gain[i] = sum / lookahead;
    left[i] *= gain[i];
    right[i] *= gain[i];
  }
  return gain;
}
/** The arrangement phrase a bar belongs to (tools check the energy contour with it). */
export function trackPhrase(track: Track, bar: number): ReturnType<typeof phraseName> {
  return phraseName(TRACK_SPECS[track].style, bar);
}

function phraseName(style: TrackStyle, bar: number): 'intro' | 'theme' | 'build' | 'drop' | 'breakdown' | 'final' | 'bridge' {
  if (style === 'title') return bar < 4 ? 'intro' : bar < 8 ? 'theme' : bar < 12 ? 'breakdown' : 'final';
  if (style === 'battle') {
    if (bar < 4) return 'intro';
    if (bar < 12) return 'theme';
    if (bar < 16) return 'build';
    if (bar < 32) return 'drop';
    if (bar < 40) return 'breakdown';
    if (bar < 44) return 'build';
    if (bar < 60) return 'final';
    return 'bridge';
  }
  if (style === 'bossForm') return bar < 4 ? 'intro' : bar < 12 ? 'drop' : bar < 16 ? 'build' : bar < 24 ? 'final' : 'drop';
  if (style === 'sudden') return bar < 4 ? 'build' : bar < 12 ? 'drop' : bar < 20 ? 'final' : bar < 28 ? 'drop' : 'build';
  return 'final';
}

function drums(spec: TrackSpec, out: BufferWriter, bar: number): void {
  const beat = 60 / spec.bpm;
  const start = secondsAt(beat, bar);
  const phrase = phraseName(spec.style, bar);
  if (spec.style === 'victory') { out.kick(start, 0.62); out.kick(start + beat * 2, 0.42); out.snare(start + beat * 3, 0.18); if (bar === 0) out.crash(start, 0.16); return }
  if (spec.style === 'defeat') { out.kick(start, 0.28); out.snare(start + beat * 2, 0.11); return }
  const full = spec.style === 'title' ? bar >= 2 && phrase !== 'breakdown' : phrase !== 'breakdown' || spec.style === 'sudden';
  if (!full) { out.kick(start, 0.36); if (bar % 2 === 1) out.snare(start + beat * 3, 0.12); return }
  const kickGain = spec.style === 'bossForm' ? 0.8 : spec.style === 'title' ? 0.46 : 0.72;
  for (let i = 0; i < 4; i++) out.kick(start + i * beat, kickGain);
  out.snare(start + beat, 0.24); out.snare(start + beat * 3, 0.26); out.clap(start + beat, 0.08); out.clap(start + beat * 3, 0.09);
  for (let i = 0; i < SIXTEENTHS_PER_BAR; i++) {
    const t = start + i * beat * 0.25;
    if (i % 4 === 2) out.hat(t, true, 0.05, i % 8 === 2 ? 0.36 : -0.24);
    else if (i % 2 === 0 || spec.style === 'sudden') out.hat(t, false, spec.style === 'sudden' ? 0.036 : 0.03, i % 4 === 0 ? -0.32 : 0.28);
  }
  if (bar % 8 === 0 || phrase === 'drop' && bar % 8 === 0 || phrase === 'final' && bar % 4 === 0) out.crash(start, 0.15);
  if (phrase === 'build') for (let i = 0; i < 8; i++) out.snare(start + beat * 2 + i * beat * 0.25, 0.1 + i * 0.018);
}

function bass(spec: TrackSpec, out: BufferWriter, bar: number): void {
  const beat = 60 / spec.bpm;
  const start = secondsAt(beat, bar);
  const chord = chordAt(spec, bar);
  const phrase = phraseName(spec.style, bar);
  if (spec.style === 'title') {
    if (bar < 2 || phrase === 'breakdown') out.bass(start, beat * 3.4, chord.root, 0.09, false);
    else for (let i = 0; i < 4; i++) out.bass(start + i * beat + beat * 0.5, beat * 0.42, chord.root, 0.12, false);
    return;
  }
  if (spec.style === 'victory' || spec.style === 'defeat' || phrase === 'breakdown') { out.bass(start, beat * 3.3, chord.root, spec.style === 'defeat' ? 0.1 : 0.12, false); return }
  if (spec.style === 'sudden') {
    for (let i = 0; i < SIXTEENTHS_PER_BAR; i++) out.bass(start + i * beat * 0.25, beat * 0.22, chord.root + (i % 8 === 7 ? 12 : 0), 0.1, false);
    return;
  }
  for (let i = 0; i < 8; i++) out.bass(start + i * beat * 0.5 + (i % 2) * beat * 0.5, beat * 0.38, chord.root + (i % 4 === 3 ? 12 : 0), spec.style === 'bossForm' ? 0.16 : 0.13, spec.style === 'bossForm');
}

function harmony(spec: TrackSpec, out: BufferWriter, bar: number): void {
  const beat = 60 / spec.bpm;
  const start = secondsAt(beat, bar);
  const chord = chordAt(spec, bar);
  const phrase = phraseName(spec.style, bar);
  const padOctave = spec.style === 'bossForm' || spec.style === 'defeat' ? 12 : 24;
  out.supersaw(start, beat * 3.9, chord.notes.slice(1, spec.style === 'title' ? 2 : spec.style === 'bossForm' || spec.style === 'sudden' ? 4 : 3).map((note) => note + padOctave), phrase === 'breakdown' ? 0.032 : 0.044, phrase === 'build' || phrase === 'final');
  if (spec.style === 'defeat' || spec.style === 'title' && bar < 2) return;
  const pattern = spec.style === 'bossForm' ? BOSS_ARP_PATTERN : ARP_PATTERN;
  const pluckGain = spec.style === 'sudden' ? 0.034 : spec.style === 'title' ? 0.028 : 0.038;
  for (let i = 0; i < SIXTEENTHS_PER_BAR; i++) {
    if (phrase === 'breakdown' && i % 2 === 1) continue;
    out.tone(start + i * beat * 0.25, beat * 0.25, chord.notes[pattern[i] % chord.notes.length] + (spec.style === 'sudden' ? 36 : 24), 'saw', pluckGain, i % 4 < 2 ? -0.38 : 0.38);
  }
}

function notes(spec: TrackSpec, out: BufferWriter, bar: number, baseBar: number, list: readonly NoteEvent[], instrument: Instrument): void {
  const beat = 60 / spec.bpm;
  const phraseBar = (bar - baseBar) % 4;
  for (const note of list) {
    if (note.bar !== phraseBar) continue;
    const start = secondsAt(beat, bar, note.step);
    const duration = note.length * beat * 0.25 * 0.94;
    if (instrument === 'alarm') out.tone(start, duration, note.midi, 'square', 0.055, note.step % 4 === 0 ? -0.2 : 0.2);
    else out.lead(start, duration, note.midi, instrument === 'answer' ? 0.04 : instrument === 'boss' ? 0.062 : 0.058, instrument === 'answer' ? 0.28 : -0.06);
  }
}

function leads(spec: TrackSpec, out: BufferWriter, bar: number): void {
  const beat = 60 / spec.bpm;
  const start = secondsAt(beat, bar);
  const phrase = phraseName(spec.style, bar);
  if (spec.style === 'title') { if (bar >= 4) notes(spec, out, bar, 4, eventList(TITLE_HOOK), 'lead'); if (bar === 3 || bar === 7) out.riser(start + beat * 2, beat * 2, 0.025, true); return }
  if (spec.style === 'battle') {
    if (phrase === 'theme') notes(spec, out, bar, 4, eventList(BATTLE_HOOK), 'lead');
    if (phrase === 'drop' || phrase === 'final') { notes(spec, out, bar, phrase === 'drop' ? 16 : 44, eventList(BATTLE_HOOK), 'lead'); notes(spec, out, bar, phrase === 'drop' ? 16 : 44, eventList(BATTLE_ANSWER), 'answer'); }
    if (phrase === 'breakdown' || phrase === 'bridge') notes(spec, out, bar, phrase === 'bridge' ? 60 : 32, eventList(BATTLE_BREAK), 'lead');
    if (phrase === 'build' && bar % 2 === 1) out.riser(start, beat * 4, 0.04, true);
    if (bar === 15 || bar === 43 || bar === 63) out.riser(start + beat * 3.3, beat * 0.7, 0.05, false);
    return;
  }
  if (spec.style === 'bossForm') { if (phrase !== 'intro') notes(spec, out, bar, phrase === 'drop' ? 2 : phrase === 'build' ? 8 : 12, eventList(BOSS_MOTIF), 'boss'); if (phrase === 'build') out.riser(start, beat * 4, 0.045, true); return }
  if (spec.style === 'sudden') { notes(spec, out, bar, 0, eventList(SUDDEN_ALARM), 'alarm'); if (bar % 4 === 3) out.riser(start + beat, beat * 3, 0.05, true); return }
  if (spec.style === 'victory') { notes(spec, out, bar, 0, eventList(VICTORY_HOOK), 'lead'); return }
  notes(spec, out, bar, 0, eventList(DEFEAT_HOOK), 'lead');
}

async function renderBars(spec: TrackSpec, fromBar: number, bars: number, includeTail: boolean): Promise<RenderedMusic> {
  const beat = 60 / spec.bpm;
  const seconds = bars * BEATS_PER_BAR * beat + (includeTail ? (spec.loop ? LOOP_TAIL_BEATS : STINGER_TAIL_BEATS) * beat : 0);
  const out = new BufferWriter(MUSIC_SAMPLE_RATE, seconds, secondsAt(beat, fromBar));
  for (let offset = 0; offset < bars; offset++) {
    const bar = fromBar + offset;
    harmony(spec, out, bar);
    bass(spec, out, bar);
    drums(spec, out, bar);
    leads(spec, out, bar);
    if (offset % RENDER_YIELD_BARS === RENDER_YIELD_BARS - 1) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  out.finalize(spec.gain, rideCurve(spec, fromBar, out.frames));
  return out.rendered();
}

/** The phrase's level in dB at the START of a bar (battle rides its phrases; other tracks are arranged flat). */
function phraseLevelDb(spec: TrackSpec, bar: number): number {
  if (spec.style !== 'battle') return 0;
  const phrase = phraseName(spec.style, bar);
  // The bridge settles at the intro's level, so the loop seam carries no level change.
  if (phrase === 'intro' || phrase === 'bridge') return RIDE_INTRO_DB;
  if (phrase === 'theme') return RIDE_THEME_DB;
  if (phrase !== 'build') return 0;
  let first = bar;
  while (first > 0 && phraseName(spec.style, first - 1) === 'build') first--;
  let last = bar;
  while (last + 1 < spec.bars && phraseName(spec.style, last + 1) === 'build') last++;
  return last === first ? 0 : RIDE_BUILD_START_DB * (1 - (bar - first) / (last - first));
}

/**
 * Gain per sample for bars from `fromBar` on (the tail included), as a function of the absolute bar position, so a
 * section rendered alone gets exactly the gain it has inside the whole track. Levels hold through a phrase and fade
 * over its last beat into the next one; a build glides across each of its bars. Loops wrap to their first bar.
 */
function rideCurve(spec: TrackSpec, fromBar: number, frames: number): Float32Array {
  const curve = new Float32Array(frames);
  const barSeconds = (BEATS_PER_BAR * 60) / spec.bpm;
  const levelAt = (bar: number): number => phraseLevelDb(spec, spec.loop ? ((bar % spec.bars) + spec.bars) % spec.bars : Math.min(bar, spec.bars - 1));
  for (let i = 0; i < frames; i++) {
    const position = fromBar + i / MUSIC_SAMPLE_RATE / barSeconds;
    const bar = Math.floor(position);
    const within = position - bar;
    const from = levelAt(bar);
    const to = levelAt(bar + 1);
    const glide = phraseName(spec.style, spec.loop ? bar % spec.bars : Math.min(bar, spec.bars - 1)) === 'build' ? within : clamp((within - (1 - RIDE_FADE_BARS)) / RIDE_FADE_BARS, 0, 1);
    curve[i] = 10 ** ((from + (to - from) * glide) / 20);
  }
  return curve;
}

function foldLoopTail(rendered: RenderedMusic, spec: TrackSpec): RenderedMusic {
  const loopFrames = Math.round(arrangementSeconds(spec) * MUSIC_SAMPLE_RATE);
  const left = new Float32Array(loopFrames);
  const right = new Float32Array(loopFrames);
  left.set(rendered.left.subarray(0, loopFrames));
  right.set(rendered.right.subarray(0, loopFrames));
  for (let i = loopFrames; i < rendered.left.length; i++) {
    left[i - loopFrames] += rendered.left[i];
    right[i - loopFrames] += rendered.right[i];
  }
  return { sampleRate: rendered.sampleRate, left, right };
}

function fadeTail(buffer: RenderedMusic, seconds: number): void {
  const frames = Math.min(buffer.left.length, Math.max(1, Math.floor(buffer.sampleRate * seconds)));
  for (const data of [buffer.left, buffer.right]) {
    for (let i = 0; i < frames; i++) {
      const index = data.length - frames + i;
      const gain = 1 - i / frames;
      data[index] *= gain * gain;
    }
  }
}

export async function renderTrackSection(track: Track | TrackSpec, section = 0, bars = SECTION_BARS): Promise<RenderedMusic> {
  const spec = trackSpecOf(track);
  const safeBars = Math.max(1, Math.min(bars, spec.bars - section * bars));
  return renderBars(spec, section * bars, safeBars, true);
}

export async function renderTrack(track: Track | TrackSpec): Promise<RenderedMusic> {
  const spec = trackSpecOf(track);
  const rendered = await renderBars(spec, 0, spec.bars, true);
  if (spec.loop) return foldLoopTail(rendered, spec);
  fadeTail(rendered, (60 / spec.bpm) * STINGER_TAIL_BEATS);
  return rendered;
}

export async function renderMusicDiagnostic(kind: 'leadAlias' | 'pluckFilter' | 'sidechain' | 'reverb' | 'reverbDc'): Promise<RenderedMusic> {
  const out = new BufferWriter(MUSIC_SAMPLE_RATE, 3, 0);
  if (kind === 'leadAlias') out.tone(0.1, 1.2, 96, 'sine', 0.22, 0, 0, { bus: 'lead', cutoffStart: 12000, cutoffEnd: 12000, q: 0.7, highpass: 20, send: 0, phaseSeed: 901 });
  else if (kind === 'pluckFilter') out.tone(0.02, 0.24, 84, 'saw', 0.22, 0, 0, { bus: 'duck', cutoffStart: 14000, cutoffEnd: 1, q: 1.8, highpass: 180, send: 0, phaseSeed: 701 });
  else if (kind === 'sidechain') {
    const beat = 60 / IN_MATCH_BPM;
    out.supersaw(0, beat * 7.8, [64, 67, 71], 0.12, false);
    for (let i = 0; i < 8; i++) out.kick(i * beat, 0);
  } else {
    if (kind === 'reverbDc') out.constantToFx(1, 0.1);
    else out.impulseToFx();
  }
  out.finalize(1, new Float32Array(out.frames).fill(1));
  return out.rendered();
}
