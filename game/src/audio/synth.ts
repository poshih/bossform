export type Sfx =
  | 'shotRifle' | 'shotNeedle' | 'shotShell' | 'shotSpread' | 'missile' | 'blade' | 'dash' | 'shield'
  | 'enemyHit' | 'bossHit' | 'explodeS' | 'explodeM' | 'explodeL' | 'explodeBoss' | 'shellBurst'
  | 'graze' | 'orb' | 'absorb' | 'playerHit' | 'playerDeath' | 'respawn'
  | 'gaugeFull' | 'transformStart' | 'transformDone' | 'bossModeEnd'
  | 'bossWarning' | 'bossPhase' | 'stageClear' | 'victory' | 'gameOver'
  | 'uiMove' | 'uiSelect' | 'uiBack' | 'banner' | 'pause';

export type Track = 'title' | 'stage1' | 'stage2' | 'stage3' | 'boss' | 'bossMode' | 'clear' | 'gameOver';

export interface PlayOptions {
  pan?: number;
  volume?: number;
}

export const SFX_NAMES = [
  'shotRifle', 'shotNeedle', 'shotShell', 'shotSpread', 'missile', 'blade', 'dash', 'shield',
  'enemyHit', 'bossHit', 'explodeS', 'explodeM', 'explodeL', 'explodeBoss', 'shellBurst',
  'graze', 'orb', 'absorb', 'playerHit', 'playerDeath', 'respawn',
  'gaugeFull', 'transformStart', 'transformDone', 'bossModeEnd',
  'bossWarning', 'bossPhase', 'stageClear', 'victory', 'gameOver',
  'uiMove', 'uiSelect', 'uiBack', 'banner', 'pause',
] as const satisfies readonly Sfx[];

export const TRACK_NAMES = ['title', 'stage1', 'stage2', 'stage3', 'boss', 'bossMode', 'clear', 'gameOver'] as const satisfies readonly Track[];

export const AUDIO_SAMPLE_RATE = 44100;
const QUIET = 0.0001;
const NOISE_SECONDS = 2;
const BURST_Q = 0.8;
const BELL_PARTIALS = [
  { ratio: 1, amp: 1, decay: 1.3 },
  { ratio: 2.74, amp: 0.42, decay: 0.72 },
  { ratio: 5.38, amp: 0.17, decay: 0.34 },
] as const;

type AnyContext = AudioContext | OfflineAudioContext;

type FilterKind = BiquadFilterType | null;

export interface SfxSpec {
  readonly duration: number;
  readonly minGap: number;
}

export const SFX_SPECS: Record<Sfx, SfxSpec> = {
  shotRifle: { duration: 0.09, minGap: 0.055 },
  shotNeedle: { duration: 0.075, minGap: 0.04 },
  shotShell: { duration: 0.28, minGap: 0.13 },
  shotSpread: { duration: 0.16, minGap: 0.085 },
  missile: { duration: 0.34, minGap: 0.12 },
  blade: { duration: 0.42, minGap: 0.17 },
  dash: { duration: 0.17, minGap: 0.09 },
  shield: { duration: 0.34, minGap: 0.16 },
  enemyHit: { duration: 0.08, minGap: 0.04 },
  bossHit: { duration: 0.12, minGap: 0.05 },
  explodeS: { duration: 0.34, minGap: 0.08 },
  explodeM: { duration: 0.6, minGap: 0.12 },
  explodeL: { duration: 1.1, minGap: 0.18 },
  explodeBoss: { duration: 2.5, minGap: 0.5 },
  shellBurst: { duration: 0.2, minGap: 0.08 },
  graze: { duration: 0.05, minGap: 0.028 },
  orb: { duration: 0.42, minGap: 0.045 },
  absorb: { duration: 0.48, minGap: 0.08 },
  playerHit: { duration: 0.36, minGap: 0.14 },
  playerDeath: { duration: 1.5, minGap: 0.5 },
  respawn: { duration: 0.85, minGap: 0.3 },
  gaugeFull: { duration: 0.38, minGap: 0.2 },
  transformStart: { duration: 1.25, minGap: 0.6 },
  transformDone: { duration: 1.4, minGap: 0.7 },
  bossModeEnd: { duration: 0.9, minGap: 0.4 },
  bossWarning: { duration: 1.45, minGap: 0.6 },
  bossPhase: { duration: 0.82, minGap: 0.3 },
  stageClear: { duration: 1.25, minGap: 0.8 },
  victory: { duration: 1.8, minGap: 1 },
  gameOver: { duration: 1.6, minGap: 1 },
  uiMove: { duration: 0.045, minGap: 0.025 },
  uiSelect: { duration: 0.18, minGap: 0.06 },
  uiBack: { duration: 0.13, minGap: 0.06 },
  banner: { duration: 0.72, minGap: 0.3 },
  pause: { duration: 0.22, minGap: 0.1 },
};

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function createPrng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

export function createNoiseBuffer(ctx: BaseAudioContext, seconds = NOISE_SECONDS, seed = 1): AudioBuffer {
  const length = Math.max(1, Math.round(ctx.sampleRate * seconds));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  const random = createPrng(seed);
  for (let i = 0; i < length; i++) data[i] = random() * 2 - 1;
  return buffer;
}

function makePanNode(ctx: AnyContext, pan: number): StereoPannerNode {
  const node = ctx.createStereoPanner();
  node.pan.value = clamp(pan, -1, 1);
  return node;
}

function makeVoiceBus(ctx: AnyContext, destination: AudioNode, options: PlayOptions | undefined): GainNode {
  const volume = clamp(options?.volume ?? 1, 0, 1);
  const gain = ctx.createGain();
  gain.gain.value = volume;
  const panner = makePanNode(ctx, options?.pan ?? 0);
  gain.connect(panner).connect(destination);
  return gain;
}

function envelope(gain: GainNode, start: number, attack: number, peak: number, decay: number, floor = QUIET): void {
  gain.gain.setValueAtTime(floor, start);
  gain.gain.exponentialRampToValueAtTime(Math.max(floor, peak), start + Math.max(0.001, attack));
  gain.gain.exponentialRampToValueAtTime(floor, start + Math.max(0.002, attack + decay));
}

function tone(
  ctx: AnyContext,
  destination: AudioNode,
  type: OscillatorType,
  startHz: number,
  endHz: number,
  start: number,
  duration: number,
  gainValue: number,
  filterType: FilterKind = null,
  filterHz = 1800,
  detune = 0,
): void {
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.detune.value = detune;
  osc.frequency.setValueAtTime(Math.max(1, startHz), start);
  if (endHz !== startHz) osc.frequency.exponentialRampToValueAtTime(Math.max(1, endHz), start + duration);
  const env = ctx.createGain();
  envelope(env, start, Math.min(0.01, duration * 0.25), gainValue, duration);
  let last: AudioNode = osc;
  if (filterType) {
    const filter = ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.setValueAtTime(filterHz, start);
    last.connect(filter);
    last = filter;
  }
  last.connect(env).connect(destination);
  osc.start(start);
  osc.stop(start + duration + 0.03);
}

function toneBurst(
  ctx: AnyContext,
  destination: AudioNode,
  type: OscillatorType,
  hz: number,
  start: number,
  duration: number,
  gainValue: number,
  attack = 0.003,
): void {
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.value = Math.max(1, hz);
  const env = ctx.createGain();
  envelope(env, start, attack, gainValue, duration);
  osc.connect(env).connect(destination);
  osc.start(start);
  osc.stop(start + duration + 0.02);
}

function noiseBurst(
  ctx: AnyContext,
  destination: AudioNode,
  noise: AudioBuffer,
  start: number,
  duration: number,
  gainValue: number,
  filterType: BiquadFilterType,
  startHz: number,
  endHz: number,
  q = BURST_Q,
): void {
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const filter = ctx.createBiquadFilter();
  filter.type = filterType;
  filter.Q.value = q;
  filter.frequency.setValueAtTime(Math.max(20, startHz), start);
  if (endHz !== startHz) filter.frequency.exponentialRampToValueAtTime(Math.max(20, endHz), start + duration);
  const env = ctx.createGain();
  envelope(env, start, 0.003, gainValue, duration);
  src.connect(filter).connect(env).connect(destination);
  src.start(start, ((start * 17.13) % Math.max(0.05, noise.duration - duration - 0.01)), duration + 0.06);
}

function noiseRise(
  ctx: AnyContext,
  destination: AudioNode,
  noise: AudioBuffer,
  start: number,
  duration: number,
  peak: number,
  fromHz: number,
  toHz: number,
  q = 1.5,
): void {
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.Q.value = q;
  filter.frequency.setValueAtTime(fromHz, start);
  filter.frequency.exponentialRampToValueAtTime(toHz, start + duration);
  const env = ctx.createGain();
  env.gain.setValueAtTime(QUIET, start);
  env.gain.exponentialRampToValueAtTime(peak, start + duration * 0.75);
  env.gain.exponentialRampToValueAtTime(QUIET, start + duration);
  src.connect(filter).connect(env).connect(destination);
  src.start(start, (start * 11.7) % 0.6, duration + 0.08);
}

function bell(ctx: AnyContext, destination: AudioNode, start: number, midi: number, gainValue: number): void {
  const base = midiToHz(midi);
  for (const partial of BELL_PARTIALS) toneBurst(ctx, destination, 'sine', base * partial.ratio, start, partial.decay, gainValue * partial.amp, 0.002);
}

function chord(ctx: AnyContext, destination: AudioNode, start: number, rootMidi: number, offsets: readonly number[], gainValue: number, duration: number, type: OscillatorType): void {
  for (const offset of offsets) tone(ctx, destination, type, midiToHz(rootMidi + offset), midiToHz(rootMidi + offset), start, duration, gainValue, 'lowpass', 2600, offset === 0 ? -4 : 4);
}

function servo(ctx: AnyContext, destination: AudioNode, noise: AudioBuffer, start: number, midi: number, gainValue: number): void {
  tone(ctx, destination, 'square', midiToHz(midi), midiToHz(midi - 3), start, 0.08, gainValue, 'lowpass', 1400);
  noiseBurst(ctx, destination, noise, start, 0.035, gainValue * 0.4, 'bandpass', 900, 1200, 2.4);
}

function softImpact(ctx: AnyContext, destination: AudioNode, noise: AudioBuffer, start: number, gainValue: number, size: 'small' | 'medium' | 'large'): void {
  const toneGain = size === 'small' ? 0.18 : size === 'medium' ? 0.24 : 0.35;
  const noiseGain = size === 'small' ? 0.12 : size === 'medium' ? 0.2 : 0.28;
  const dur = size === 'small' ? 0.18 : size === 'medium' ? 0.34 : 0.52;
  tone(ctx, destination, 'sine', size === 'small' ? 180 : size === 'medium' ? 120 : 88, size === 'small' ? 60 : size === 'medium' ? 42 : 28, start, dur, toneGain * gainValue, 'lowpass', 1300);
  noiseBurst(ctx, destination, noise, start, dur * 0.85, noiseGain * gainValue, 'lowpass', 2800, 180, 0.7);
}

function risingTriad(ctx: AnyContext, destination: AudioNode, start: number, rootMidi: number, gainValue: number, step = 0.07): void {
  bell(ctx, destination, start + step * 0, rootMidi, gainValue);
  bell(ctx, destination, start + step * 1, rootMidi + 4, gainValue * 0.96);
  bell(ctx, destination, start + step * 2, rootMidi + 7, gainValue * 0.92);
}

function descendingMinor(ctx: AnyContext, destination: AudioNode, start: number, rootMidi: number, gainValue: number): void {
  bell(ctx, destination, start + 0.0, rootMidi + 7, gainValue);
  bell(ctx, destination, start + 0.15, rootMidi + 3, gainValue * 0.9);
  bell(ctx, destination, start + 0.3, rootMidi, gainValue * 0.82);
}

export function scheduleSfx(
  ctx: AnyContext,
  destination: AudioNode,
  noise: AudioBuffer,
  name: Sfx,
  start: number,
  options?: PlayOptions,
): number {
  const voice = makeVoiceBus(ctx, destination, options);
  const t = start;
  switch (name) {
    case 'shotRifle':
      tone(ctx, voice, 'square', 1680, 980, t, 0.028, 0.055, 'lowpass', 2400);
      noiseBurst(ctx, voice, noise, t, 0.02, 0.018, 'highpass', 5000, 3400, 1.4);
      break;
    case 'shotNeedle':
      tone(ctx, voice, 'triangle', 2450, 3450, t, 0.016, 0.03, 'bandpass', 3200);
      tone(ctx, voice, 'sine', 3800, 2400, t + 0.008, 0.022, 0.015, 'bandpass', 3000);
      break;
    case 'shotShell':
      tone(ctx, voice, 'triangle', 190, 82, t, 0.15, 0.12, 'lowpass', 900);
      noiseBurst(ctx, voice, noise, t + 0.012, 0.16, 0.07, 'lowpass', 2400, 320, 0.7);
      break;
    case 'shotSpread':
      for (let i = 0; i < 3; i++) tone(ctx, voice, 'square', 1020 + i * 120, 700 + i * 90, t + i * 0.012, 0.034, 0.032, 'lowpass', 1900);
      noiseBurst(ctx, voice, noise, t, 0.045, 0.02, 'bandpass', 2200, 1600, 1.1);
      break;
    case 'missile':
      noiseBurst(ctx, voice, noise, t, 0.18, 0.04, 'bandpass', 420, 1600, 2.2);
      tone(ctx, voice, 'sawtooth', 180, 120, t + 0.015, 0.24, 0.055, 'lowpass', 1100);
      break;
    case 'blade':
      noiseRise(ctx, voice, noise, t, 0.22, 0.06, 1100, 4200, 1.8);
      tone(ctx, voice, 'sine', 760, 1340, t, 0.26, 0.055, 'bandpass', 1800);
      bell(ctx, voice, t + 0.07, 82, 0.03);
      break;
    case 'dash':
      noiseBurst(ctx, voice, noise, t, 0.12, 0.05, 'bandpass', 700, 2200, 1.8);
      tone(ctx, voice, 'sine', 240, 100, t, 0.11, 0.035, 'highpass', 160);
      break;
    case 'shield':
      tone(ctx, voice, 'sine', 520, 760, t, 0.22, 0.045, 'bandpass', 1500);
      for (let i = 0; i < 4; i++) bell(ctx, voice, t + 0.02 + i * 0.035, 79 + i, 0.018);
      break;
    case 'enemyHit':
      tone(ctx, voice, 'triangle', 980, 620, t, 0.045, 0.038, 'bandpass', 1400);
      noiseBurst(ctx, voice, noise, t, 0.03, 0.024, 'highpass', 4200, 3200, 1.1);
      break;
    case 'bossHit':
      tone(ctx, voice, 'sawtooth', 780, 420, t, 0.08, 0.06, 'lowpass', 1700);
      noiseBurst(ctx, voice, noise, t, 0.055, 0.04, 'bandpass', 2600, 1800, 1.2);
      break;
    case 'explodeS':
      softImpact(ctx, voice, noise, t, 1, 'small');
      break;
    case 'explodeM':
      softImpact(ctx, voice, noise, t, 1, 'medium');
      tone(ctx, voice, 'sawtooth', 240, 72, t, 0.26, 0.045, 'lowpass', 1200);
      break;
    case 'explodeL':
      softImpact(ctx, voice, noise, t, 1, 'large');
      tone(ctx, voice, 'sawtooth', 180, 42, t, 0.62, 0.05, 'lowpass', 1000);
      noiseRise(ctx, voice, noise, t + 0.03, 0.28, 0.035, 300, 1500, 0.9);
      break;
    case 'explodeBoss':
      for (let i = 0; i < 5; i++) softImpact(ctx, voice, noise, t + i * 0.24, 0.95 - i * 0.08, i < 2 ? 'large' : 'medium');
      tone(ctx, voice, 'sawtooth', 120, 28, t, 1.7, 0.09, 'lowpass', 780);
      noiseRise(ctx, voice, noise, t, 1.1, 0.06, 260, 2600, 0.75);
      for (let i = 0; i < 8; i++) bell(ctx, voice, t + 0.28 + i * 0.12, 48 + i, 0.012);
      break;
    case 'shellBurst':
      for (let i = 0; i < 5; i++) tone(ctx, voice, 'square', 920 + i * 150, 640 + i * 90, t + i * 0.008, 0.03, 0.02, 'lowpass', 2000);
      noiseBurst(ctx, voice, noise, t, 0.08, 0.024, 'highpass', 3600, 2200, 1.3);
      break;
    case 'graze':
      tone(ctx, voice, 'sine', 2800, 3600, t, 0.022, 0.02, 'bandpass', 3200);
      break;
    case 'orb': {
      const random = createPrng(Math.floor(start * 100000) + 7);
      const offset = random() < 0.5 ? 0 : 1;
      bell(ctx, voice, t, 79 + offset, 0.03);
      bell(ctx, voice, t + 0.08, 83 + offset, 0.028);
      bell(ctx, voice, t + 0.16, 86 + offset, 0.024);
      tone(ctx, voice, 'triangle', midiToHz(79 + offset), midiToHz(91 + offset), t, 0.25, 0.016, 'bandpass', 2200);
      break;
    }
    case 'absorb':
      noiseRise(ctx, voice, noise, t, 0.3, 0.03, 420, 2200, 1.5);
      tone(ctx, voice, 'sine', 180, 760, t + 0.03, 0.28, 0.028, 'bandpass', 1200);
      break;
    case 'playerHit':
      tone(ctx, voice, 'sawtooth', 720, 120, t, 0.26, 0.085, 'lowpass', 1600);
      noiseBurst(ctx, voice, noise, t, 0.16, 0.05, 'lowpass', 2400, 200, 0.8);
      break;
    case 'playerDeath':
      softImpact(ctx, voice, noise, t, 1, 'large');
      tone(ctx, voice, 'sawtooth', 760, 40, t, 0.95, 0.08, 'lowpass', 1800);
      descendingMinor(ctx, voice, t + 0.22, 62, 0.05);
      break;
    case 'respawn':
      noiseRise(ctx, voice, noise, t, 0.32, 0.035, 600, 3200, 1.3);
      risingTriad(ctx, voice, t + 0.06, 64, 0.025, 0.1);
      tone(ctx, voice, 'triangle', 220, 660, t, 0.36, 0.024, 'bandpass', 1800);
      break;
    case 'gaugeFull':
      risingTriad(ctx, voice, t, 72, 0.022, 0.07);
      bell(ctx, voice, t + 0.22, 84, 0.03);
      break;
    case 'transformStart':
      noiseRise(ctx, voice, noise, t, 0.8, 0.06, 280, 4200, 1.1);
      tone(ctx, voice, 'sawtooth', 90, 620, t, 0.86, 0.05, 'lowpass', 2400);
      servo(ctx, voice, noise, t + 0.08, 46, 0.028);
      servo(ctx, voice, noise, t + 0.26, 50, 0.026);
      servo(ctx, voice, noise, t + 0.42, 55, 0.024);
      servo(ctx, voice, noise, t + 0.58, 59, 0.022);
      bell(ctx, voice, t + 0.7, 81, 0.03);
      break;
    case 'transformDone':
      softImpact(ctx, voice, noise, t, 1.15, 'large');
      chord(ctx, voice, t + 0.02, 57, [0, 4, 7, 12], 0.03, 0.65, 'sawtooth');
      tone(ctx, voice, 'sine', 240, 46, t, 0.78, 0.055, 'lowpass', 900);
      noiseRise(ctx, voice, noise, t, 0.22, 0.03, 400, 2200, 0.9);
      break;
    case 'bossModeEnd':
      tone(ctx, voice, 'triangle', 820, 110, t, 0.54, 0.045, 'lowpass', 1500);
      noiseBurst(ctx, voice, noise, t + 0.06, 0.18, 0.02, 'bandpass', 1600, 520, 1.5);
      break;
    case 'bossWarning':
      for (let i = 0; i < 4; i++) {
        tone(ctx, voice, 'square', i % 2 === 0 ? 660 : 520, i % 2 === 0 ? 660 : 520, t + i * 0.28, 0.18, 0.04, 'lowpass', 1900);
        noiseBurst(ctx, voice, noise, t + i * 0.28, 0.12, 0.018, 'bandpass', 900, 1800, 1.6);
      }
      break;
    case 'bossPhase':
      noiseRise(ctx, voice, noise, t, 0.24, 0.045, 500, 3400, 1.4);
      chord(ctx, voice, t, 50, [0, 3, 7, 10], 0.018, 0.4, 'triangle');
      tone(ctx, voice, 'sine', 130, 48, t, 0.5, 0.038, 'lowpass', 800);
      break;
    case 'stageClear':
      bell(ctx, voice, t + 0.0, 72, 0.035);
      bell(ctx, voice, t + 0.14, 76, 0.035);
      bell(ctx, voice, t + 0.28, 79, 0.038);
      chord(ctx, voice, t + 0.22, 60, [0, 4, 7, 12], 0.017, 0.7, 'triangle');
      break;
    case 'victory':
      bell(ctx, voice, t + 0.0, 72, 0.04);
      bell(ctx, voice, t + 0.14, 76, 0.04);
      bell(ctx, voice, t + 0.28, 79, 0.04);
      bell(ctx, voice, t + 0.48, 84, 0.05);
      chord(ctx, voice, t + 0.32, 60, [0, 4, 7, 12], 0.018, 1.1, 'sawtooth');
      tone(ctx, voice, 'sine', 180, 90, t + 0.3, 0.65, 0.024, 'lowpass', 1200);
      break;
    case 'gameOver':
      bell(ctx, voice, t + 0.0, 69, 0.034);
      bell(ctx, voice, t + 0.18, 65, 0.03);
      bell(ctx, voice, t + 0.36, 60, 0.028);
      tone(ctx, voice, 'triangle', 220, 70, t, 0.74, 0.03, 'lowpass', 900);
      break;
    case 'uiMove':
      tone(ctx, voice, 'square', 840, 840, t, 0.02, 0.028, 'lowpass', 2200);
      break;
    case 'uiSelect':
      bell(ctx, voice, t, 79, 0.018);
      bell(ctx, voice, t + 0.06, 83, 0.022);
      break;
    case 'uiBack':
      tone(ctx, voice, 'square', 620, 460, t, 0.06, 0.03, 'lowpass', 1800);
      break;
    case 'banner':
      noiseRise(ctx, voice, noise, t, 0.22, 0.03, 600, 2600, 1.4);
      chord(ctx, voice, t + 0.08, 55, [0, 4, 7, 12], 0.018, 0.45, 'triangle');
      bell(ctx, voice, t + 0.18, 79, 0.024);
      break;
    case 'pause':
      tone(ctx, voice, 'square', 980, 980, t, 0.03, 0.024, 'lowpass', 2400);
      tone(ctx, voice, 'square', 780, 780, t + 0.04, 0.03, 0.02, 'lowpass', 2000);
      break;
  }
  return start + SFX_SPECS[name].duration;
}

export async function renderSfxBuffer(name: Sfx, options?: PlayOptions): Promise<AudioBuffer> {
  const spec = SFX_SPECS[name];
  const frames = Math.max(1, Math.ceil((spec.duration + 0.2) * AUDIO_SAMPLE_RATE));
  const ctx = new OfflineAudioContext(2, frames, AUDIO_SAMPLE_RATE);
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -8;
  limiter.knee.value = 4;
  limiter.ratio.value = 10;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.12;
  limiter.connect(ctx.destination);
  const master = ctx.createGain();
  master.gain.value = 0.82;
  master.connect(limiter);
  const noise = createNoiseBuffer(ctx, NOISE_SECONDS, 7);
  scheduleSfx(ctx, master, noise, name, 0.01, options);
  return ctx.startRendering();
}

export interface BeamLoop {
  setActive(active: boolean): void;
  dispose(): void;
}

export function createBeamLoop(ctx: AudioContext, destination: AudioNode, noise: AudioBuffer): BeamLoop {
  const master = ctx.createGain();
  master.gain.value = 0;
  master.connect(destination);

  const hum = ctx.createOscillator();
  hum.type = 'sawtooth';
  hum.frequency.value = 92;
  const humSub = ctx.createOscillator();
  humSub.type = 'triangle';
  humSub.frequency.value = 46;
  const humGain = ctx.createGain();
  humGain.gain.value = 0.045;
  hum.connect(humGain);
  humSub.connect(humGain);

  const color = ctx.createBiquadFilter();
  color.type = 'lowpass';
  color.frequency.value = 900;
  humGain.connect(color).connect(master);

  const hiss = ctx.createBufferSource();
  hiss.buffer = noise;
  hiss.loop = true;
  const hissFilter = ctx.createBiquadFilter();
  hissFilter.type = 'bandpass';
  hissFilter.frequency.value = 2900;
  hissFilter.Q.value = 1.2;
  const hissGain = ctx.createGain();
  hissGain.gain.value = 0.018;
  hiss.connect(hissFilter).connect(hissGain).connect(master);

  const lfo = ctx.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.value = 5.2;
  const lfoDepth = ctx.createGain();
  lfoDepth.gain.value = 420;
  lfo.connect(lfoDepth).connect(hissFilter.frequency);
  const tremoloDepth = ctx.createGain();
  tremoloDepth.gain.value = 0.012;
  lfo.connect(tremoloDepth).connect(humGain.gain);

  hum.start();
  humSub.start();
  hiss.start();
  lfo.start();

  let active = false;
  return {
    setActive(next: boolean): void {
      if (active === next) return;
      active = next;
      const time = ctx.currentTime;
      master.gain.cancelScheduledValues(time);
      master.gain.setValueAtTime(Math.max(QUIET, master.gain.value), time);
      if (next) master.gain.exponentialRampToValueAtTime(0.9, time + 0.04);
      else master.gain.exponentialRampToValueAtTime(QUIET, time + 0.09);
      color.frequency.cancelScheduledValues(time);
      color.frequency.setValueAtTime(Math.max(80, color.frequency.value), time);
      color.frequency.exponentialRampToValueAtTime(next ? 1400 : 700, time + 0.12);
      hissFilter.frequency.cancelScheduledValues(time);
      hissFilter.frequency.setValueAtTime(Math.max(200, hissFilter.frequency.value), time);
      hissFilter.frequency.exponentialRampToValueAtTime(next ? 3600 : 2200, time + 0.12);
    },
    dispose(): void {
      const stopAt = ctx.currentTime + 0.05;
      hum.stop(stopAt);
      humSub.stop(stopAt);
      hiss.stop(stopAt);
      lfo.stop(stopAt);
      master.disconnect();
    },
  };
}
