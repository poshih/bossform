import { Attack, FORMS, Frame, TICK_RATE } from '../sim/index.ts';

export type BossDroneLayer = 'bossDrone';
export type UltimaBarrageLayer = 'ultimaBarrage';
export type LayerName = BossDroneLayer | UltimaBarrageLayer;

export type BossWindupSfx =
  | 'salvoWindupVanguard' | 'salvoWindupGale' | 'salvoWindupJuggernaut'
  | 'siegeWindupVanguard' | 'siegeWindupGale' | 'siegeWindupJuggernaut'
  | 'ultimaWindupVanguard' | 'ultimaWindupGale' | 'ultimaWindupJuggernaut';

export type Sfx =
  | 'shotVanguard' | 'shotGale' | 'shotJuggernaut' | 'seekerLaunch'
  | 'dash' | 'bulwarkRaise' | 'absorb' | 'hit' | 'blocked' | 'graze'
  | 'partHit' | 'partDown' | 'podFire' | 'death' | 'respawn' | 'orbPickup'
  | 'neutralFire' | 'neutralHit' | 'neutralKilled' | 'burst'
  | 'morphStart' | 'morphDone' | 'bossEnd'
  | BossWindupSfx
  | 'salvoRelease' | 'siegeRelease' | 'ultimaRelease' | 'ultimaClose'
  | 'stormAlarm' | 'count3' | 'count2' | 'count1' | 'fight'
  | 'roundWon' | 'roundDraw' | 'matchWon' | 'defeat'
  | 'uiMove' | 'uiClick' | 'uiConfirm';

export type Track = 'title' | 'battle' | 'bossForm' | 'sudden' | 'victory' | 'defeat';

export interface PlayOptions {
  pan?: number;
  volume?: number;
}

export interface LayerState {
  active: boolean;
  gain?: number;
  pitch?: number;
  pan?: number;
}

export interface SfxSpec {
  readonly duration: number;
  readonly minGap: number;
}

export interface LoopLayer {
  setState(state: LayerState): void;
  dispose(): void;
}

export const AUDIO_SAMPLE_RATE = 44100;
export const SFX_NAMES = [
  'shotVanguard', 'shotGale', 'shotJuggernaut', 'seekerLaunch',
  'dash', 'bulwarkRaise', 'absorb', 'hit', 'blocked', 'graze',
  'partHit', 'partDown', 'podFire', 'death', 'respawn', 'orbPickup',
  'neutralFire', 'neutralHit', 'neutralKilled', 'burst',
  'morphStart', 'morphDone', 'bossEnd',
  'salvoWindupVanguard', 'salvoWindupGale', 'salvoWindupJuggernaut',
  'siegeWindupVanguard', 'siegeWindupGale', 'siegeWindupJuggernaut',
  'ultimaWindupVanguard', 'ultimaWindupGale', 'ultimaWindupJuggernaut',
  'salvoRelease', 'siegeRelease', 'ultimaRelease', 'ultimaClose',
  'stormAlarm', 'count3', 'count2', 'count1', 'fight',
  'roundWon', 'roundDraw', 'matchWon', 'defeat',
  'uiMove', 'uiClick', 'uiConfirm',
] as const satisfies readonly Sfx[];

export const TRACK_NAMES = ['title', 'battle', 'bossForm', 'sudden', 'victory', 'defeat'] as const satisfies readonly Track[];
export const LAYER_NAMES = ['bossDrone', 'ultimaBarrage'] as const satisfies readonly LayerName[];

const QUIET = 0.0001;
const NOISE_SECONDS = 2;
const BURST_Q = 0.9;
const OFF_PAN = 0;
const DEFAULT_LAYER_GAIN = 0.2;
const DEFAULT_LAYER_PITCH = 1;
const DEFAULT_SFX_VOLUME = 1;
const SFX_PAD_SECONDS = 0.24;
const FORM_WINDUP_TAIL = 0.05;
const UI_GAP = 0.03;
const BELL_PARTIALS = [
  { ratio: 1, amp: 1, decay: 1.2 },
  { ratio: 2.74, amp: 0.42, decay: 0.7 },
  { ratio: 5.38, amp: 0.16, decay: 0.34 },
] as const;

type AnyContext = AudioContext | OfflineAudioContext;

interface WindupPack {
  readonly salvo: BossWindupSfx;
  readonly siege: BossWindupSfx;
  readonly ultima: BossWindupSfx;
}

const WINDUP_NAMES: readonly WindupPack[] = [
  { salvo: 'salvoWindupVanguard', siege: 'siegeWindupVanguard', ultima: 'ultimaWindupVanguard' },
  { salvo: 'salvoWindupGale', siege: 'siegeWindupGale', ultima: 'ultimaWindupGale' },
  { salvo: 'salvoWindupJuggernaut', siege: 'siegeWindupJuggernaut', ultima: 'ultimaWindupJuggernaut' },
] as const;

const ATTACK_RELEASE_SFX: Record<number, Sfx> = {
  [Attack.Salvo]: 'salvoRelease',
  [Attack.Siege]: 'siegeRelease',
  [Attack.Ultima]: 'ultimaRelease',
};

const FRAME_BASE_MIDI = [72, 84, 60] as const;

const WINDUP_DURATIONS = FORMS.map((form) => ({
  [Attack.Salvo]: form.salvo.windup / TICK_RATE,
  [Attack.Siege]: form.siege.windup / TICK_RATE,
  [Attack.Ultima]: form.ultima.windup / TICK_RATE,
})) as readonly Readonly<Record<number, number>>[];

export const SFX_SPECS: Record<Sfx, SfxSpec> = {
  shotVanguard: { duration: 0.08, minGap: 0.045 },
  shotGale: { duration: 0.045, minGap: 0.03 },
  shotJuggernaut: { duration: 0.28, minGap: 0.11 },
  seekerLaunch: { duration: 0.24, minGap: 0.1 },
  dash: { duration: 0.17, minGap: 0.09 },
  bulwarkRaise: { duration: 0.28, minGap: 0.16 },
  absorb: { duration: 0.22, minGap: 0.045 },
  hit: { duration: 0.1, minGap: 0.04 },
  blocked: { duration: 0.07, minGap: 0.04 },
  graze: { duration: 0.042, minGap: 0.025 },
  partHit: { duration: 0.11, minGap: 0.05 },
  partDown: { duration: 0.32, minGap: 0.12 },
  podFire: { duration: 0.12, minGap: 0.045 },
  death: { duration: 1.4, minGap: 0.5 },
  respawn: { duration: 0.74, minGap: 0.25 },
  orbPickup: { duration: 0.34, minGap: 0.03 },
  neutralFire: { duration: 0.11, minGap: 0.04 },
  neutralHit: { duration: 0.09, minGap: 0.045 },
  neutralKilled: { duration: 0.54, minGap: 0.14 },
  burst: { duration: 0.24, minGap: 0.08 },
  morphStart: { duration: 0.86, minGap: 0.4 },
  morphDone: { duration: 0.72, minGap: 0.35 },
  bossEnd: { duration: 0.92, minGap: 0.35 },
  salvoWindupVanguard: { duration: WINDUP_DURATIONS[Frame.Vanguard][Attack.Salvo], minGap: 0.12 },
  salvoWindupGale: { duration: WINDUP_DURATIONS[Frame.Gale][Attack.Salvo], minGap: 0.12 },
  salvoWindupJuggernaut: { duration: WINDUP_DURATIONS[Frame.Juggernaut][Attack.Salvo], minGap: 0.14 },
  siegeWindupVanguard: { duration: WINDUP_DURATIONS[Frame.Vanguard][Attack.Siege], minGap: 0.25 },
  siegeWindupGale: { duration: WINDUP_DURATIONS[Frame.Gale][Attack.Siege], minGap: 0.25 },
  siegeWindupJuggernaut: { duration: WINDUP_DURATIONS[Frame.Juggernaut][Attack.Siege], minGap: 0.28 },
  ultimaWindupVanguard: { duration: WINDUP_DURATIONS[Frame.Vanguard][Attack.Ultima], minGap: 0.9 },
  ultimaWindupGale: { duration: WINDUP_DURATIONS[Frame.Gale][Attack.Ultima], minGap: 0.9 },
  ultimaWindupJuggernaut: { duration: WINDUP_DURATIONS[Frame.Juggernaut][Attack.Ultima], minGap: 1 },
  salvoRelease: { duration: 0.42, minGap: 0.12 },
  siegeRelease: { duration: 0.96, minGap: 0.28 },
  ultimaRelease: { duration: 0.62, minGap: 0.5 },
  ultimaClose: { duration: 0.78, minGap: 0.3 },
  stormAlarm: { duration: 0.92, minGap: 0.5 },
  count3: { duration: 0.16, minGap: 0.1 },
  count2: { duration: 0.16, minGap: 0.1 },
  count1: { duration: 0.16, minGap: 0.1 },
  fight: { duration: 0.52, minGap: 0.25 },
  roundWon: { duration: 0.72, minGap: 0.4 },
  roundDraw: { duration: 0.82, minGap: 0.4 },
  matchWon: { duration: 1.1, minGap: 0.8 },
  defeat: { duration: 1.05, minGap: 0.8 },
  uiMove: { duration: 0.045, minGap: UI_GAP },
  uiClick: { duration: 0.09, minGap: UI_GAP },
  uiConfirm: { duration: 0.16, minGap: 0.05 },
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

export function bossWindupSfx(frame: number, attack: number): BossWindupSfx {
  const names = WINDUP_NAMES[frame];
  if (attack === Attack.Salvo) return names.salvo;
  if (attack === Attack.Siege) return names.siege;
  return names.ultima;
}

export function bossWindupDuration(frame: number, attack: number): number {
  return WINDUP_DURATIONS[frame][attack];
}

export function bossReleaseSfx(attack: number): Sfx {
  return ATTACK_RELEASE_SFX[attack] ?? 'salvoRelease';
}

function makePanNode(ctx: AnyContext, pan: number): StereoPannerNode {
  const node = ctx.createStereoPanner();
  node.pan.value = clamp(pan, -1, 1);
  return node;
}

function makeVoiceBus(ctx: AnyContext, destination: AudioNode, options: PlayOptions | undefined): GainNode {
  const gain = ctx.createGain();
  gain.gain.value = clamp(options?.volume ?? DEFAULT_SFX_VOLUME, 0, 1);
  const panner = makePanNode(ctx, options?.pan ?? OFF_PAN);
  gain.connect(panner).connect(destination);
  return gain;
}

function envelope(gain: GainNode, start: number, attack: number, peak: number, decay: number): void {
  gain.gain.setValueAtTime(QUIET, start);
  gain.gain.exponentialRampToValueAtTime(Math.max(QUIET, peak), start + Math.max(0.001, attack));
  gain.gain.exponentialRampToValueAtTime(QUIET, start + Math.max(0.002, attack + decay));
}

function tone(
  ctx: AnyContext,
  destination: AudioNode,
  type: OscillatorType,
  startHz: number,
  endHz: number,
  start: number,
  duration: number,
  peak: number,
  filterType: BiquadFilterType | null = null,
  filterHz = 1600,
  detune = 0,
): void {
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.detune.value = detune;
  osc.frequency.setValueAtTime(Math.max(1, startHz), start);
  if (endHz !== startHz) osc.frequency.exponentialRampToValueAtTime(Math.max(1, endHz), start + duration);
  const env = ctx.createGain();
  envelope(env, start, Math.min(0.012, duration * 0.25), peak, duration);
  let last: AudioNode = osc;
  if (filterType !== null) {
    const filter = ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.setValueAtTime(filterHz, start);
    last.connect(filter);
    last = filter;
  }
  last.connect(env).connect(destination);
  osc.start(start);
  osc.stop(start + duration + 0.05);
}

function staticTone(ctx: AnyContext, destination: AudioNode, type: OscillatorType, hz: number, start: number, duration: number, peak: number): void {
  tone(ctx, destination, type, hz, hz, start, duration, peak);
}

function noiseBurst(
  ctx: AnyContext,
  destination: AudioNode,
  noise: AudioBuffer,
  start: number,
  duration: number,
  peak: number,
  filterType: BiquadFilterType,
  fromHz: number,
  toHz: number,
  q = BURST_Q,
): void {
  const source = ctx.createBufferSource();
  source.buffer = noise;
  const filter = ctx.createBiquadFilter();
  filter.type = filterType;
  filter.Q.value = q;
  filter.frequency.setValueAtTime(Math.max(20, fromHz), start);
  if (fromHz !== toHz) filter.frequency.exponentialRampToValueAtTime(Math.max(20, toHz), start + duration);
  const env = ctx.createGain();
  envelope(env, start, 0.002, peak, duration);
  source.connect(filter).connect(env).connect(destination);
  source.start(start, (start * 17.91) % Math.max(0.05, Math.max(0.05, noise.duration - duration - 0.02)), duration + 0.08);
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
  q = 1.2,
): void {
  const source = ctx.createBufferSource();
  source.buffer = noise;
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.Q.value = q;
  filter.frequency.setValueAtTime(Math.max(20, fromHz), start);
  filter.frequency.exponentialRampToValueAtTime(Math.max(20, toHz), start + duration);
  const env = ctx.createGain();
  env.gain.setValueAtTime(QUIET, start);
  env.gain.exponentialRampToValueAtTime(peak, start + duration * 0.8);
  env.gain.exponentialRampToValueAtTime(QUIET, start + duration);
  source.connect(filter).connect(env).connect(destination);
  source.start(start, (start * 9.7) % Math.max(0.05, noise.duration - 0.1), duration + 0.08);
}

function bell(ctx: AnyContext, destination: AudioNode, start: number, midi: number, peak: number): void {
  const base = midiToHz(midi);
  for (const partial of BELL_PARTIALS) staticTone(ctx, destination, 'sine', base * partial.ratio, start, partial.decay, peak * partial.amp);
}

function chord(ctx: AnyContext, destination: AudioNode, start: number, rootMidi: number, offsets: readonly number[], duration: number, peak: number, type: OscillatorType): void {
  for (const offset of offsets) tone(ctx, destination, type, midiToHz(rootMidi + offset), midiToHz(rootMidi + offset), start, duration, peak, 'lowpass', 2400, offset === 0 ? -6 : 5);
}

function metalClack(ctx: AnyContext, destination: AudioNode, noise: AudioBuffer, start: number, peak: number): void {
  tone(ctx, destination, 'square', 920, 620, start, 0.08, peak, 'bandpass', 1600);
  tone(ctx, destination, 'triangle', 410, 250, start + 0.008, 0.09, peak * 0.6, 'bandpass', 900);
  noiseBurst(ctx, destination, noise, start, 0.05, peak * 0.5, 'highpass', 3000, 1800, 1.9);
}

function impact(ctx: AnyContext, destination: AudioNode, noise: AudioBuffer, start: number, kind: 'small' | 'medium' | 'large', peak = 1): void {
  const toneGain = kind === 'small' ? 0.1 : kind === 'medium' ? 0.18 : 0.28;
  const noiseGain = kind === 'small' ? 0.07 : kind === 'medium' ? 0.13 : 0.2;
  const duration = kind === 'small' ? 0.14 : kind === 'medium' ? 0.28 : 0.52;
  const startHz = kind === 'small' ? 220 : kind === 'medium' ? 130 : 82;
  const endHz = kind === 'small' ? 86 : kind === 'medium' ? 48 : 24;
  tone(ctx, destination, 'sine', startHz, endHz, start, duration, toneGain * peak, 'lowpass', 1100);
  noiseBurst(ctx, destination, noise, start, duration * 0.82, noiseGain * peak, 'lowpass', 2400, 180, 0.7);
}

function risingChime(ctx: AnyContext, destination: AudioNode, start: number, rootMidi: number, peak: number): void {
  bell(ctx, destination, start, rootMidi, peak);
  bell(ctx, destination, start + 0.07, rootMidi + 4, peak * 0.92);
  bell(ctx, destination, start + 0.14, rootMidi + 7, peak * 0.86);
}

function countdownBeep(ctx: AnyContext, destination: AudioNode, start: number, midi: number, peak: number): void {
  tone(ctx, destination, 'square', midiToHz(midi), midiToHz(midi), start, 0.11, peak, 'lowpass', 2400);
  bell(ctx, destination, start, midi, peak * 0.45);
}

function windupSweep(
  ctx: AnyContext,
  destination: AudioNode,
  noise: AudioBuffer,
  frame: number,
  attack: number,
  start: number,
): void {
  const duration = bossWindupDuration(frame, attack);
  const base = FRAME_BASE_MIDI[frame];
  if (attack === Attack.Salvo) {
    tone(ctx, destination, 'triangle', midiToHz(base - 10), midiToHz(base + 2), start, duration, frame === Frame.Juggernaut ? 0.045 : 0.038, 'bandpass', frame === Frame.Gale ? 2200 : 1500);
    noiseRise(ctx, destination, noise, start, duration, frame === Frame.Gale ? 0.02 : 0.024, 800, frame === Frame.Gale ? 3000 : 2200, 1.6);
    if (frame !== Frame.Gale) metalClack(ctx, destination, noise, start + Math.max(0.03, duration * 0.35), frame === Frame.Juggernaut ? 0.015 : 0.012);
    return;
  }
  if (attack === Attack.Siege) {
    const endMidi = frame === Frame.Gale ? base + 2 : base - 2;
    tone(ctx, destination, 'sawtooth', midiToHz(base - 18), midiToHz(endMidi), start, duration, frame === Frame.Juggernaut ? 0.05 : 0.042, 'lowpass', 1200);
    tone(ctx, destination, 'sine', 52 + frame * 9, 74 + frame * 12, start, duration, 0.03, 'lowpass', 400);
    noiseRise(ctx, destination, noise, start, duration, 0.028, 260, 1600, 0.8);
    return;
  }
  tone(ctx, destination, 'sawtooth', midiToHz(base - 16), midiToHz(base + 12), start, duration, frame === Frame.Juggernaut ? 0.04 : 0.034, 'lowpass', 1700);
  tone(ctx, destination, 'triangle', midiToHz(base - 4), midiToHz(base + 19), start, duration, 0.022, 'bandpass', 2600, 7);
  tone(ctx, destination, 'sine', 48 + frame * 6, 122 + frame * 8, start, duration, 0.026, 'lowpass', 460);
  noiseRise(ctx, destination, noise, start, duration, 0.024, 300, 2800, 1.1);
  bell(ctx, destination, start + duration * 0.58, base + 18, 0.012);
}

function releaseHit(ctx: AnyContext, destination: AudioNode, noise: AudioBuffer, start: number, attack: number): void {
  if (attack === Attack.Salvo) {
    impact(ctx, destination, noise, start, 'medium', 0.9);
    tone(ctx, destination, 'triangle', 140, 52, start, 0.26, 0.09, 'lowpass', 950);
    return;
  }
  if (attack === Attack.Siege) {
    impact(ctx, destination, noise, start, 'large', 1.15);
    tone(ctx, destination, 'sawtooth', 92, 24, start, 0.74, 0.08, 'lowpass', 800);
    noiseRise(ctx, destination, noise, start, 0.3, 0.025, 200, 1000, 0.9);
    return;
  }
  impact(ctx, destination, noise, start, 'large', 1.05);
  tone(ctx, destination, 'sawtooth', 180, 46, start, 0.44, 0.065, 'lowpass', 1100);
  chord(ctx, destination, start + 0.02, 48, [0, 7, 12], 0.48, 0.016, 'triangle');
}

function mapWindupName(name: Sfx): { frame: number; attack: number } | null {
  switch (name) {
    case 'salvoWindupVanguard': return { frame: Frame.Vanguard, attack: Attack.Salvo };
    case 'salvoWindupGale': return { frame: Frame.Gale, attack: Attack.Salvo };
    case 'salvoWindupJuggernaut': return { frame: Frame.Juggernaut, attack: Attack.Salvo };
    case 'siegeWindupVanguard': return { frame: Frame.Vanguard, attack: Attack.Siege };
    case 'siegeWindupGale': return { frame: Frame.Gale, attack: Attack.Siege };
    case 'siegeWindupJuggernaut': return { frame: Frame.Juggernaut, attack: Attack.Siege };
    case 'ultimaWindupVanguard': return { frame: Frame.Vanguard, attack: Attack.Ultima };
    case 'ultimaWindupGale': return { frame: Frame.Gale, attack: Attack.Ultima };
    case 'ultimaWindupJuggernaut': return { frame: Frame.Juggernaut, attack: Attack.Ultima };
    default: return null;
  }
}

export function scheduleSfx(ctx: AnyContext, destination: AudioNode, noise: AudioBuffer, name: Sfx, start: number, options?: PlayOptions): number {
  const voice = makeVoiceBus(ctx, destination, options);
  const windup = mapWindupName(name);
  if (windup !== null) {
    windupSweep(ctx, voice, noise, windup.frame, windup.attack, start);
    return start + bossWindupDuration(windup.frame, windup.attack) + FORM_WINDUP_TAIL;
  }
  switch (name) {
    case 'shotVanguard':
      tone(ctx, voice, 'square', 1420, 920, start, 0.03, 0.04, 'lowpass', 2200);
      noiseBurst(ctx, voice, noise, start, 0.02, 0.012, 'highpass', 4400, 3000, 1.4);
      break;
    case 'shotGale':
      tone(ctx, voice, 'triangle', 2500, 3300, start, 0.014, 0.018, 'bandpass', 3200);
      tone(ctx, voice, 'sine', 3400, 2100, start + 0.005, 0.018, 0.008, 'bandpass', 2600);
      break;
    case 'shotJuggernaut':
      tone(ctx, voice, 'triangle', 170, 74, start, 0.16, 0.11, 'lowpass', 820);
      noiseBurst(ctx, voice, noise, start + 0.01, 0.12, 0.05, 'lowpass', 2200, 300, 0.75);
      break;
    case 'seekerLaunch':
      noiseBurst(ctx, voice, noise, start, 0.14, 0.03, 'bandpass', 420, 1600, 2.1);
      tone(ctx, voice, 'sawtooth', 240, 140, start + 0.015, 0.18, 0.036, 'lowpass', 1200);
      break;
    case 'dash':
      noiseBurst(ctx, voice, noise, start, 0.1, 0.04, 'bandpass', 700, 2600, 1.8);
      tone(ctx, voice, 'sine', 220, 90, start, 0.11, 0.024, 'highpass', 180);
      break;
    case 'bulwarkRaise':
      tone(ctx, voice, 'square', 220, 150, start, 0.18, 0.05, 'lowpass', 880);
      tone(ctx, voice, 'sine', 520, 420, start + 0.02, 0.14, 0.02, 'bandpass', 1200);
      metalClack(ctx, voice, noise, start + 0.04, 0.018);
      break;
    case 'absorb':
      tone(ctx, voice, 'sine', 300, 820, start, 0.13, 0.02, 'bandpass', 1500);
      bell(ctx, voice, start + 0.04, 82, 0.012);
      break;
    case 'hit':
      tone(ctx, voice, 'triangle', 760, 440, start, 0.05, 0.03, 'bandpass', 1200);
      noiseBurst(ctx, voice, noise, start, 0.03, 0.018, 'highpass', 3400, 2400, 1.2);
      break;
    case 'blocked':
      tone(ctx, voice, 'sine', 340, 280, start, 0.045, 0.018, 'bandpass', 900);
      break;
    case 'graze':
      tone(ctx, voice, 'sine', 3000, 3600, start, 0.02, 0.014, 'bandpass', 3400);
      break;
    case 'partHit':
      metalClack(ctx, voice, noise, start, 0.03);
      break;
    case 'partDown':
      metalClack(ctx, voice, noise, start, 0.04);
      metalClack(ctx, voice, noise, start + 0.06, 0.028);
      impact(ctx, voice, noise, start + 0.03, 'small', 0.8);
      break;
    case 'podFire':
      tone(ctx, voice, 'triangle', 320, 130, start, 0.08, 0.024, 'lowpass', 900);
      noiseBurst(ctx, voice, noise, start, 0.05, 0.018, 'bandpass', 1800, 1200, 1.2);
      break;
    case 'death':
      impact(ctx, voice, noise, start, 'large', 1.05);
      tone(ctx, voice, 'sawtooth', 460, 36, start, 0.88, 0.06, 'lowpass', 1500);
      noiseRise(ctx, voice, noise, start, 0.42, 0.028, 340, 1800, 0.8);
      break;
    case 'respawn':
      noiseRise(ctx, voice, noise, start, 0.22, 0.024, 600, 2600, 1.2);
      risingChime(ctx, voice, start + 0.04, 72, 0.02);
      tone(ctx, voice, 'triangle', 180, 620, start, 0.28, 0.018, 'bandpass', 1800);
      break;
    case 'orbPickup':
      risingChime(ctx, voice, start, 81, 0.022);
      tone(ctx, voice, 'triangle', midiToHz(81), midiToHz(90), start, 0.2, 0.012, 'bandpass', 2200);
      break;
    case 'neutralFire':
      tone(ctx, voice, 'square', 920, 720, start, 0.04, 0.018, 'lowpass', 1800);
      noiseBurst(ctx, voice, noise, start, 0.03, 0.01, 'highpass', 2800, 2200, 1.4);
      break;
    case 'neutralHit':
      tone(ctx, voice, 'triangle', 620, 380, start, 0.055, 0.024, 'bandpass', 1100);
      break;
    case 'neutralKilled':
      impact(ctx, voice, noise, start, 'medium', 0.9);
      tone(ctx, voice, 'triangle', 220, 62, start, 0.26, 0.05, 'lowpass', 900);
      break;
    case 'burst':
      for (let i = 0; i < 5; i++) tone(ctx, voice, 'square', 800 + i * 150, 560 + i * 90, start + i * 0.008, 0.028, 0.015, 'lowpass', 1700);
      noiseBurst(ctx, voice, noise, start, 0.06, 0.018, 'highpass', 3200, 1800, 1.3);
      break;
    case 'morphStart':
      noiseRise(ctx, voice, noise, start, 0.62, 0.04, 260, 3200, 1.1);
      tone(ctx, voice, 'sawtooth', 88, 520, start, 0.68, 0.04, 'lowpass', 2200);
      metalClack(ctx, voice, noise, start + 0.1, 0.018);
      metalClack(ctx, voice, noise, start + 0.24, 0.018);
      metalClack(ctx, voice, noise, start + 0.38, 0.016);
      break;
    case 'morphDone':
      impact(ctx, voice, noise, start, 'large', 1.15);
      chord(ctx, voice, start + 0.02, 45, [0, 7, 12], 0.44, 0.018, 'sawtooth');
      tone(ctx, voice, 'sine', 180, 40, start, 0.54, 0.05, 'lowpass', 860);
      break;
    case 'bossEnd':
      tone(ctx, voice, 'triangle', 240, 34, start, 0.78, 0.04, 'lowpass', 760);
      noiseBurst(ctx, voice, noise, start + 0.05, 0.24, 0.028, 'bandpass', 1000, 260, 1.1);
      break;
    case 'salvoRelease':
      releaseHit(ctx, voice, noise, start, Attack.Salvo);
      break;
    case 'siegeRelease':
      releaseHit(ctx, voice, noise, start, Attack.Siege);
      break;
    case 'ultimaRelease':
      releaseHit(ctx, voice, noise, start, Attack.Ultima);
      break;
    case 'ultimaClose':
      tone(ctx, voice, 'triangle', 660, 90, start, 0.46, 0.03, 'lowpass', 1500);
      noiseBurst(ctx, voice, noise, start, 0.18, 0.016, 'bandpass', 2400, 720, 1.2);
      break;
    case 'stormAlarm':
      for (let i = 0; i < 3; i++) {
        tone(ctx, voice, 'square', i % 2 === 0 ? 590 : 460, i % 2 === 0 ? 590 : 460, start + i * 0.24, 0.16, 0.032, 'lowpass', 1700);
        noiseBurst(ctx, voice, noise, start + i * 0.24, 0.1, 0.012, 'bandpass', 700, 1500, 1.5);
      }
      break;
    case 'count3':
      countdownBeep(ctx, voice, start, 72, 0.026);
      break;
    case 'count2':
      countdownBeep(ctx, voice, start, 76, 0.026);
      break;
    case 'count1':
      countdownBeep(ctx, voice, start, 79, 0.03);
      break;
    case 'fight':
      risingChime(ctx, voice, start, 74, 0.026);
      chord(ctx, voice, start + 0.12, 50, [0, 4, 7], 0.32, 0.016, 'triangle');
      tone(ctx, voice, 'sine', 140, 72, start + 0.1, 0.28, 0.018, 'lowpass', 1200);
      break;
    case 'roundWon':
      bell(ctx, voice, start, 76, 0.03);
      bell(ctx, voice, start + 0.14, 81, 0.032);
      chord(ctx, voice, start + 0.18, 57, [0, 4, 7], 0.32, 0.014, 'triangle');
      break;
    case 'roundDraw':
      bell(ctx, voice, start, 69, 0.024);
      bell(ctx, voice, start + 0.14, 72, 0.024);
      bell(ctx, voice, start + 0.28, 74, 0.022);
      break;
    case 'matchWon':
      risingChime(ctx, voice, start, 76, 0.03);
      bell(ctx, voice, start + 0.26, 88, 0.04);
      chord(ctx, voice, start + 0.24, 57, [0, 4, 7, 12], 0.64, 0.016, 'sawtooth');
      break;
    case 'defeat':
      bell(ctx, voice, start, 69, 0.024);
      bell(ctx, voice, start + 0.18, 65, 0.022);
      bell(ctx, voice, start + 0.36, 60, 0.02);
      tone(ctx, voice, 'triangle', 220, 60, start, 0.6, 0.024, 'lowpass', 840);
      break;
    case 'uiMove':
      tone(ctx, voice, 'square', 860, 860, start, 0.02, 0.02, 'lowpass', 2200);
      break;
    case 'uiClick':
      tone(ctx, voice, 'square', 980, 720, start, 0.05, 0.02, 'lowpass', 2200);
      break;
    case 'uiConfirm':
      bell(ctx, voice, start, 84, 0.015);
      bell(ctx, voice, start + 0.05, 88, 0.018);
      break;
  }
  return start + SFX_SPECS[name].duration;
}

export async function renderSfxBuffer(name: Sfx, options?: PlayOptions): Promise<AudioBuffer> {
  const frames = Math.max(1, Math.ceil((SFX_SPECS[name].duration + SFX_PAD_SECONDS) * AUDIO_SAMPLE_RATE));
  const ctx = new OfflineAudioContext(2, frames, AUDIO_SAMPLE_RATE);
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -8;
  limiter.knee.value = 4;
  limiter.ratio.value = 10;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.12;
  limiter.connect(ctx.destination);
  const master = ctx.createGain();
  master.gain.value = 0.82;
  master.connect(limiter);
  const noise = createNoiseBuffer(ctx, NOISE_SECONDS, 7);
  scheduleSfx(ctx, master, noise, name, 0.01, options);
  return ctx.startRendering();
}

function rampParameter(param: AudioParam, now: number, value: number, seconds: number): void {
  param.cancelScheduledValues(now);
  param.setValueAtTime(Math.max(QUIET, param.value), now);
  param.exponentialRampToValueAtTime(Math.max(QUIET, value), now + Math.max(0.02, seconds));
}

function createBossDroneLayer(ctx: AudioContext, destination: AudioNode, noise: AudioBuffer): LoopLayer {
  const gain = ctx.createGain();
  gain.gain.value = QUIET;
  const panner = makePanNode(ctx, OFF_PAN);
  gain.connect(panner).connect(destination);

  const low = ctx.createOscillator();
  low.type = 'sawtooth';
  low.frequency.value = 68;
  const lowBody = ctx.createBiquadFilter();
  lowBody.type = 'lowpass';
  lowBody.frequency.value = 720;
  const lowGain = ctx.createGain();
  lowGain.gain.value = 0.08;
  low.connect(lowBody).connect(lowGain).connect(gain);

  const sub = ctx.createOscillator();
  sub.type = 'triangle';
  sub.frequency.value = 34;
  const subGain = ctx.createGain();
  subGain.gain.value = 0.05;
  sub.connect(subGain).connect(gain);

  const hiss = ctx.createBufferSource();
  hiss.buffer = noise;
  hiss.loop = true;
  const hissFilter = ctx.createBiquadFilter();
  hissFilter.type = 'bandpass';
  hissFilter.frequency.value = 2200;
  hissFilter.Q.value = 1.1;
  const hissGain = ctx.createGain();
  hissGain.gain.value = 0.012;
  hiss.connect(hissFilter).connect(hissGain).connect(gain);

  const lfo = ctx.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.value = 4.2;
  const lfoGain = ctx.createGain();
  lfoGain.gain.value = 240;
  lfo.connect(lfoGain).connect(hissFilter.frequency);

  low.start();
  sub.start();
  hiss.start();
  lfo.start();

  let active = false;
  return {
    setState(state: LayerState): void {
      active = state.active;
      const now = ctx.currentTime;
      const pitch = clamp(state.pitch ?? DEFAULT_LAYER_PITCH, 0.4, 2.4);
      rampParameter(low.frequency, now, 68 * pitch, 0.12);
      rampParameter(sub.frequency, now, 34 * pitch, 0.12);
      rampParameter(lowBody.frequency, now, 600 + 420 * pitch, 0.12);
      rampParameter(hissFilter.frequency, now, 1700 + 900 * pitch, 0.12);
      panner.pan.setValueAtTime(clamp(state.pan ?? OFF_PAN, -1, 1), now);
      const target = active ? clamp(state.gain ?? DEFAULT_LAYER_GAIN, 0.02, 1) : QUIET;
      rampParameter(gain.gain, now, target, active ? 0.08 : 0.12);
    },
    dispose(): void {
      const stopAt = ctx.currentTime + 0.05;
      low.stop(stopAt);
      sub.stop(stopAt);
      hiss.stop(stopAt);
      lfo.stop(stopAt);
      gain.disconnect();
    },
  };
}

function createUltimaBarrageLayer(ctx: AudioContext, destination: AudioNode, noise: AudioBuffer): LoopLayer {
  const gain = ctx.createGain();
  gain.gain.value = QUIET;
  const panner = makePanNode(ctx, OFF_PAN);
  gain.connect(panner).connect(destination);

  const pulse = ctx.createOscillator();
  pulse.type = 'sawtooth';
  pulse.frequency.value = 96;
  const pulseFilter = ctx.createBiquadFilter();
  pulseFilter.type = 'bandpass';
  pulseFilter.frequency.value = 1800;
  pulseFilter.Q.value = 1.2;
  const pulseGain = ctx.createGain();
  pulseGain.gain.value = 0.04;
  pulse.connect(pulseFilter).connect(pulseGain).connect(gain);

  const sub = ctx.createOscillator();
  sub.type = 'triangle';
  sub.frequency.value = 48;
  const subGain = ctx.createGain();
  subGain.gain.value = 0.035;
  sub.connect(subGain).connect(gain);

  const spray = ctx.createBufferSource();
  spray.buffer = noise;
  spray.loop = true;
  const sprayFilter = ctx.createBiquadFilter();
  sprayFilter.type = 'bandpass';
  sprayFilter.frequency.value = 3000;
  sprayFilter.Q.value = 0.9;
  const sprayGain = ctx.createGain();
  sprayGain.gain.value = 0.014;
  spray.connect(sprayFilter).connect(sprayGain).connect(gain);

  const lfo = ctx.createOscillator();
  lfo.type = 'triangle';
  lfo.frequency.value = 7.5;
  const lfoGain = ctx.createGain();
  lfoGain.gain.value = 420;
  lfo.connect(lfoGain).connect(pulseFilter.frequency);
  const lfoAmp = ctx.createGain();
  lfoAmp.gain.value = 0.02;
  lfo.connect(lfoAmp).connect(pulseGain.gain);

  pulse.start();
  sub.start();
  spray.start();
  lfo.start();

  let active = false;
  return {
    setState(state: LayerState): void {
      active = state.active;
      const now = ctx.currentTime;
      const pitch = clamp(state.pitch ?? DEFAULT_LAYER_PITCH, 0.5, 2.6);
      rampParameter(pulse.frequency, now, 96 * pitch, 0.08);
      rampParameter(sub.frequency, now, 48 * pitch, 0.08);
      rampParameter(pulseFilter.frequency, now, 1400 + 1200 * pitch, 0.08);
      rampParameter(sprayFilter.frequency, now, 2200 + 1600 * pitch, 0.08);
      panner.pan.setValueAtTime(clamp(state.pan ?? OFF_PAN, -1, 1), now);
      const target = active ? clamp(state.gain ?? DEFAULT_LAYER_GAIN, 0.02, 1) : QUIET;
      rampParameter(gain.gain, now, target, active ? 0.04 : 0.1);
    },
    dispose(): void {
      const stopAt = ctx.currentTime + 0.05;
      pulse.stop(stopAt);
      sub.stop(stopAt);
      spray.stop(stopAt);
      lfo.stop(stopAt);
      gain.disconnect();
    },
  };
}

export function createLoopLayer(name: LayerName, ctx: AudioContext, destination: AudioNode, noise: AudioBuffer): LoopLayer {
  if (name === 'bossDrone') return createBossDroneLayer(ctx, destination, noise);
  return createUltimaBarrageLayer(ctx, destination, noise);
}
