import { Attack, FORMS, Frame, HAILSTORM, PRISM, TICK_RATE } from '../sim/index.ts';

export type BossDroneLayer = 'bossDrone';
export type UltimaBarrageLayer = 'ultimaBarrage';
export type BeamHumLayer = 'beamHum';
export type LayerName = BossDroneLayer | UltimaBarrageLayer | BeamHumLayer;

/** A frame's key in the simulation's Frame table ('Vanguard', 'Gale', ...): the boss wind-up sounds are named after it. */
type FrameKey = keyof typeof Frame;
/** The boss attacks, by the name their wind-up sounds carry. */
const WINDUP_ATTACKS = { salvo: Attack.Salvo, siege: Attack.Siege, ultima: Attack.Ultima } as const;
type WindupAttackKey = keyof typeof WINDUP_ATTACKS;
/** One wind-up per boss form and attack, named after the robot: `salvoWindupVanguard` ... `ultimaWindupGauntlet`. */
export type BossWindupSfx = `${WindupAttackKey}Windup${FrameKey}`;

/** Every sound except the boss wind-ups (those are generated per frame and attack below). */
const EVENT_SFX_NAMES = [
  'shotVanguard', 'shotGale', 'shotJuggernaut', 'seekerLaunch',
  'dash', 'bulwarkRaise', 'absorb', 'hit', 'blocked', 'graze',
  'boost', 'shieldHit', 'shieldBreak', 'shieldUp',
  'shotLongbow', 'chargeFull', 'mineDrop',
  'beamTell', 'beamOn', 'lanceTell', 'lanceCrack',
  'shotHailstorm', 'carpetLaunch', 'blast',
  'shotRonin', 'parry', 'reflect', 'beamCut',
  'shotShade', 'cloak', 'reveal',
  'shotGauntlet', 'rocketPunch', 'fistCatch',
  'partHit', 'partDown', 'podFire', 'bossBeam', 'death', 'respawn', 'orbPickup',
  'neutralFire', 'neutralHit', 'neutralKilled', 'burst',
  'morphStart', 'morphDone', 'bossEnd',
  'salvoRelease', 'siegeRelease', 'ultimaRelease', 'ultimaClose',
  'stormAlarm', 'count3', 'count2', 'count1', 'fight',
  'roundWon', 'roundDraw', 'matchWon', 'defeat',
  'uiMove', 'uiClick', 'uiConfirm',
] as const;
type EventSfx = typeof EVENT_SFX_NAMES[number];
export type Sfx = EventSfx | BossWindupSfx;

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

interface WindupEntry {
  readonly name: BossWindupSfx;
  readonly frame: number;
  readonly attack: number;
}

/** Frame keys in frame-id order: the simulation's Frame table owns both the names and the ids. */
const FRAME_KEYS = (Object.keys(Frame) as FrameKey[]).sort((a, b) => Frame[a] - Frame[b]);
const WINDUPS: readonly WindupEntry[] = FRAME_KEYS.flatMap((key) =>
  (Object.keys(WINDUP_ATTACKS) as WindupAttackKey[]).map((attack): WindupEntry => ({ name: `${attack}Windup${key}`, frame: Frame[key], attack: WINDUP_ATTACKS[attack] })));

export const SFX_NAMES: readonly Sfx[] = [...EVENT_SFX_NAMES, ...WINDUPS.map((windup) => windup.name)];
export const TRACK_NAMES = ['title', 'battle', 'bossForm', 'sudden', 'victory', 'defeat'] as const satisfies readonly Track[];
export const LAYER_NAMES = ['bossDrone', 'ultimaBarrage', 'beamHum'] as const satisfies readonly LayerName[];

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
/** Boss wind-up retrigger gaps, seconds, indexed by Attack (see WindupVoice.minGap). */
type WindupGaps = Readonly<Record<number, number>>;
const WINDUP_GAPS: WindupGaps = { [Attack.Salvo]: 0.12, [Attack.Siege]: 0.25, [Attack.Ultima]: 0.9 };
/** FORTRESS has always kept its heavier wind-ups a little further apart. */
const FORTRESS_WINDUP_GAPS: WindupGaps = { [Attack.Salvo]: 0.14, [Attack.Siege]: 0.28, [Attack.Ultima]: 1 };
const BELL_PARTIALS = [
  { ratio: 1, amp: 1, decay: 1.2 },
  { ratio: 2.74, amp: 0.42, decay: 0.7 },
  { ratio: 5.38, amp: 0.16, decay: 0.34 },
] as const;
/** PRISM's tells last exactly as long as the simulation's, so the sound ends when the beam lights or the rail fires. */
const BEAM_TELL_SECONDS = PRISM.beam.tell / TICK_RATE;
const LANCE_TELL_SECONDS = PRISM.lance.tell / TICK_RATE;
/** The LANCE tell's pulses, as fractions of the tell: they come quicker toward the shot, like the drawn laser. */
const LANCE_PULSES = [0, 0.3, 0.52, 0.68, 0.79, 0.87, 0.93, 0.97] as const;
/** One launch pop per bomb of a CARPET BOMB, this far apart (seconds). */
const CARPET_POP_GAP = 0.034;
/** Seconds between SHADE's two shuriken whips (one throw launches both). */
const SHURIKEN_PAIR_GAP = 0.028;

type AnyContext = AudioContext | OfflineAudioContext;

const ATTACK_RELEASE_SFX: Record<number, Sfx> = {
  [Attack.Salvo]: 'salvoRelease',
  [Attack.Siege]: 'siegeRelease',
  [Attack.Ultima]: 'ultimaRelease',
};

const WINDUP_DURATIONS = FORMS.map((form) => ({
  [Attack.Salvo]: form.salvo.windup / TICK_RATE,
  [Attack.Siege]: form.siege.windup / TICK_RATE,
  [Attack.Ultima]: form.ultima.windup / TICK_RATE,
})) as readonly Readonly<Record<number, number>>[];

/** A boss form's salvo wind-up: a tonal sweep, a rising hiss and (for gun mounts) a breech clack a third of the way in. */
interface SalvoVoice {
  readonly peak: number;
  readonly filterHz: number;
  readonly noisePeak: number;
  readonly noiseToHz: number;
  /** Loudness of the breech clack; 0 = none. */
  readonly clack: number;
}

/** A siege wind-up: a charge sweep from far below the base note to `endOffset` semitones from it, over a sub-bass rise. */
interface SiegeVoice {
  readonly endOffset: number;
  readonly peak: number;
  readonly subFromHz: number;
  readonly subToHz: number;
}

/** An ultima wind-up: the whole reactor rising two octaves, a sub-bass climb and a bell past halfway. */
interface UltimaVoice {
  readonly peak: number;
  readonly subFromHz: number;
  readonly subToHz: number;
}

/** A signature layered over every wind-up of one form, so each colossus is known by ear. */
type WindupAccent = 'none' | 'rail' | 'prism' | 'klaxon' | 'blade' | 'bells' | 'engine';

interface WindupVoice {
  /** The form's pitch centre (MIDI): light forms sit high, heavy ones low. */
  readonly baseMidi: number;
  /** Retrigger gaps of the form's wind-ups (seconds, by Attack): a second identical wind-up inside its gap is dropped. */
  readonly minGap: WindupGaps;
  readonly salvo: SalvoVoice;
  readonly siege: SiegeVoice;
  readonly ultima: UltimaVoice;
  readonly accent: WindupAccent;
}

/** Each boss form's wind-up voice, by frame. */
const WINDUP_VOICES: readonly WindupVoice[] = [
  // PALADIN, TEMPEST, FORTRESS
  { baseMidi: 72, minGap: WINDUP_GAPS, salvo: { peak: 0.038, filterHz: 1500, noisePeak: 0.024, noiseToHz: 2200, clack: 0.012 }, siege: { endOffset: -2, peak: 0.042, subFromHz: 52, subToHz: 74 }, ultima: { peak: 0.034, subFromHz: 48, subToHz: 122 }, accent: 'none' },
  { baseMidi: 84, minGap: WINDUP_GAPS, salvo: { peak: 0.038, filterHz: 2200, noisePeak: 0.02, noiseToHz: 3000, clack: 0 }, siege: { endOffset: 2, peak: 0.042, subFromHz: 61, subToHz: 86 }, ultima: { peak: 0.034, subFromHz: 54, subToHz: 130 }, accent: 'none' },
  { baseMidi: 60, minGap: FORTRESS_WINDUP_GAPS, salvo: { peak: 0.045, filterHz: 1500, noisePeak: 0.024, noiseToHz: 2200, clack: 0.015 }, siege: { endOffset: -2, peak: 0.05, subFromHz: 70, subToHz: 98 }, ultima: { peak: 0.04, subFromHz: 60, subToHz: 138 }, accent: 'none' },
  // BALLISTA: cold and high, a rail whine climbing over every tell.
  { baseMidi: 76, minGap: WINDUP_GAPS, salvo: { peak: 0.034, filterHz: 2600, noisePeak: 0.02, noiseToHz: 3200, clack: 0.011 }, siege: { endOffset: 5, peak: 0.04, subFromHz: 58, subToHz: 80 }, ultima: { peak: 0.032, subFromHz: 50, subToHz: 118 }, accent: 'rail' },
  // HELIOS: a glassy chord of light swelling toward the beam.
  { baseMidi: 79, minGap: WINDUP_GAPS, salvo: { peak: 0.03, filterHz: 2400, noisePeak: 0.016, noiseToHz: 3400, clack: 0 }, siege: { endOffset: 7, peak: 0.038, subFromHz: 56, subToHz: 96 }, ultima: { peak: 0.032, subFromHz: 52, subToHz: 126 }, accent: 'prism' },
  // ARMADA: a low warship with a klaxon on its bridge.
  { baseMidi: 57, minGap: WINDUP_GAPS, salvo: { peak: 0.044, filterHz: 1300, noisePeak: 0.026, noiseToHz: 2000, clack: 0.016 }, siege: { endOffset: -3, peak: 0.048, subFromHz: 66, subToHz: 92 }, ultima: { peak: 0.04, subFromHz: 58, subToHz: 134 }, accent: 'klaxon' },
  // SHOGUN: steel ringing as blades are drawn, war drums before the ultima.
  { baseMidi: 69, minGap: WINDUP_GAPS, salvo: { peak: 0.034, filterHz: 1900, noisePeak: 0.022, noiseToHz: 3600, clack: 0 }, siege: { endOffset: 3, peak: 0.042, subFromHz: 55, subToHz: 78 }, ultima: { peak: 0.034, subFromHz: 50, subToHz: 120 }, accent: 'blade' },
  // KITSUNE: soft and eerie, a falling glide and shrine bells.
  { baseMidi: 81, minGap: WINDUP_GAPS, salvo: { peak: 0.03, filterHz: 2000, noisePeak: 0.018, noiseToHz: 2800, clack: 0 }, siege: { endOffset: -5, peak: 0.036, subFromHz: 62, subToHz: 84 }, ultima: { peak: 0.03, subFromHz: 54, subToHz: 128 }, accent: 'bells' },
  // ATLAS: the deepest voice, an engine spooling up and a heroic chord before the ultima.
  { baseMidi: 55, minGap: WINDUP_GAPS, salvo: { peak: 0.046, filterHz: 1400, noisePeak: 0.024, noiseToHz: 2100, clack: 0.017 }, siege: { endOffset: -2, peak: 0.05, subFromHz: 68, subToHz: 100 }, ultima: { peak: 0.042, subFromHz: 62, subToHz: 140 }, accent: 'engine' },
];

if (WINDUP_VOICES.length !== FRAME_KEYS.length) throw new RangeError(`WINDUP_VOICES lists ${WINDUP_VOICES.length} forms, the simulation has ${FRAME_KEYS.length}`);

const EVENT_SFX_SPECS: Record<EventSfx, SfxSpec> = {
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
  boost: { duration: 0.22, minGap: 0.08 },
  shieldHit: { duration: 0.12, minGap: 0.035 },
  shieldBreak: { duration: 0.45, minGap: 0.2 },
  shieldUp: { duration: 0.18, minGap: 0.12 },
  shotLongbow: { duration: 0.3, minGap: 0.1 },
  chargeFull: { duration: 0.3, minGap: 0.25 },
  mineDrop: { duration: 0.4, minGap: 0.2 },
  beamTell: { duration: BEAM_TELL_SECONDS, minGap: 0.15 },
  beamOn: { duration: 0.26, minGap: 0.12 },
  lanceTell: { duration: LANCE_TELL_SECONDS, minGap: 0.3 },
  lanceCrack: { duration: 0.56, minGap: 0.2 },
  shotHailstorm: { duration: 0.05, minGap: 0.035 },
  carpetLaunch: { duration: 0.34, minGap: 0.2 },
  blast: { duration: 0.44, minGap: 0.07 },
  shotRonin: { duration: 0.14, minGap: 0.08 },
  parry: { duration: 0.3, minGap: 0.2 },
  reflect: { duration: 0.26, minGap: 0.05 },
  beamCut: { duration: 0.12, minGap: 0.12 },
  shotShade: { duration: 0.09, minGap: 0.07 },
  cloak: { duration: 0.46, minGap: 0.3 },
  reveal: { duration: 0.26, minGap: 0.15 },
  shotGauntlet: { duration: 0.14, minGap: 0.08 },
  rocketPunch: { duration: 0.46, minGap: 0.2 },
  fistCatch: { duration: 0.22, minGap: 0.1 },
  partHit: { duration: 0.11, minGap: 0.05 },
  partDown: { duration: 0.32, minGap: 0.12 },
  podFire: { duration: 0.12, minGap: 0.045 },
  bossBeam: { duration: 0.74, minGap: 0.2 },
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

/** Every sound's length and retrigger gap; a boss wind-up lasts exactly as long as its attack's wind-up. */
export const SFX_SPECS: Record<Sfx, SfxSpec> = {
  ...EVENT_SFX_SPECS,
  ...Object.fromEntries(WINDUPS.map((windup) => [windup.name, { duration: bossWindupDuration(windup.frame, windup.attack), minGap: WINDUP_VOICES[windup.frame].minGap[windup.attack] }])) as Record<BossWindupSfx, SfxSpec>,
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
  const windup = WINDUPS.find((entry) => entry.frame === frame && entry.attack === attack);
  if (windup === undefined) throw new RangeError(`no boss wind-up sound for frame ${frame}, attack ${attack}`);
  return windup.name;
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

/** A tone that builds to its peak at `crest` (a fraction of its length) and then dies away: a charge, where tone() strikes. */
function swellTone(
  ctx: AnyContext,
  destination: AudioNode,
  type: OscillatorType,
  startHz: number,
  endHz: number,
  start: number,
  duration: number,
  peak: number,
  filterType: BiquadFilterType,
  filterHz: number,
  crest = 0.85,
): void {
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(Math.max(1, startHz), start);
  if (endHz !== startHz) osc.frequency.exponentialRampToValueAtTime(Math.max(1, endHz), start + duration);
  const filter = ctx.createBiquadFilter();
  filter.type = filterType;
  filter.frequency.setValueAtTime(filterHz, start);
  const env = ctx.createGain();
  env.gain.setValueAtTime(QUIET, start);
  env.gain.exponentialRampToValueAtTime(Math.max(QUIET, peak), start + duration * crest);
  env.gain.exponentialRampToValueAtTime(QUIET, start + duration);
  osc.connect(filter).connect(env).connect(destination);
  osc.start(start);
  osc.stop(start + duration + 0.05);
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

/** How strongly a form's accent sits over each attack's wind-up (the ultima's is the loudest). Indexed by Attack. */
const ACCENT_WEIGHT: Readonly<Record<number, number>> = { [Attack.Salvo]: 0.6, [Attack.Siege]: 1, [Attack.Ultima]: 1.2 };
/** Where SHOGUN's war drums fall in its ultima wind-up (fractions of it): they quicken toward the release. */
const WAR_DRUMS = [0.08, 0.34, 0.54, 0.68, 0.78, 0.86, 0.92] as const;
/** Where KITSUNE's shrine bells ring (fractions of the wind-up) and their pitch above the base note. */
const SHRINE_BELLS = [
  { at: 0.12, offset: 19 }, { at: 0.36, offset: 22 }, { at: 0.55, offset: 15 }, { at: 0.72, offset: 19 }, { at: 0.86, offset: 24 },
] as const;
/** ARMADA's klaxon: one blast per period (seconds), alternating between two pitches (semitones above the base). */
const KLAXON_PERIOD = 0.24;
const KLAXON_PITCHES = [12, 9] as const;

function windupSweep(
  ctx: AnyContext,
  destination: AudioNode,
  noise: AudioBuffer,
  frame: number,
  attack: number,
  start: number,
): void {
  const duration = bossWindupDuration(frame, attack);
  const voice = WINDUP_VOICES[frame];
  const base = voice.baseMidi;
  windupAccent(ctx, destination, noise, voice, attack, start, duration);
  if (attack === Attack.Salvo) {
    const salvo = voice.salvo;
    tone(ctx, destination, 'triangle', midiToHz(base - 10), midiToHz(base + 2), start, duration, salvo.peak, 'bandpass', salvo.filterHz);
    noiseRise(ctx, destination, noise, start, duration, salvo.noisePeak, 800, salvo.noiseToHz, 1.6);
    if (salvo.clack > 0) metalClack(ctx, destination, noise, start + Math.max(0.03, duration * 0.35), salvo.clack);
    return;
  }
  if (attack === Attack.Siege) {
    const siege = voice.siege;
    tone(ctx, destination, 'sawtooth', midiToHz(base - 18), midiToHz(base + siege.endOffset), start, duration, siege.peak, 'lowpass', 1200);
    tone(ctx, destination, 'sine', siege.subFromHz, siege.subToHz, start, duration, 0.03, 'lowpass', 400);
    noiseRise(ctx, destination, noise, start, duration, 0.028, 260, 1600, 0.8);
    return;
  }
  const ultima = voice.ultima;
  tone(ctx, destination, 'sawtooth', midiToHz(base - 16), midiToHz(base + 12), start, duration, ultima.peak, 'lowpass', 1700);
  tone(ctx, destination, 'triangle', midiToHz(base - 4), midiToHz(base + 19), start, duration, 0.022, 'bandpass', 2600, 7);
  tone(ctx, destination, 'sine', ultima.subFromHz, ultima.subToHz, start, duration, 0.026, 'lowpass', 460);
  noiseRise(ctx, destination, noise, start, duration, 0.024, 300, 2800, 1.1);
  bell(ctx, destination, start + duration * 0.58, base + 18, 0.012);
}

function windupAccent(ctx: AnyContext, destination: AudioNode, noise: AudioBuffer, voice: WindupVoice, attack: number, start: number, duration: number): void {
  const base = voice.baseMidi;
  const weight = ACCENT_WEIGHT[attack];
  switch (voice.accent) {
    case 'none':
      return;
    case 'rail':
      // A capacitor whine climbing an octave and a half, a tick of the rail locking at the end.
      swellTone(ctx, destination, 'sine', midiToHz(base + 12), midiToHz(base + 31), start, duration, 0.011 * weight, 'bandpass', 3200, 0.95);
      bell(ctx, destination, start + duration * 0.94, base + 24, 0.006 * weight);
      return;
    case 'prism':
      // A chord of light (root, fifth, octave) swelling a tone higher toward the beam.
      for (const offset of [12, 19, 24]) swellTone(ctx, destination, 'triangle', midiToHz(base + offset), midiToHz(base + offset + 2), start, duration, 0.008 * weight, 'bandpass', 2600);
      noiseRise(ctx, destination, noise, start, duration, 0.008 * weight, 2400, 6400, 2.2);
      return;
    case 'klaxon':
      for (let blast = 0; blast * KLAXON_PERIOD < duration - KLAXON_PERIOD * 0.5; blast++) {
        const midi = base + KLAXON_PITCHES[blast % KLAXON_PITCHES.length];
        tone(ctx, destination, 'square', midiToHz(midi), midiToHz(midi), start + blast * KLAXON_PERIOD, KLAXON_PERIOD * 0.6, 0.012 * weight, 'lowpass', 1600);
      }
      return;
    case 'blade':
      // Steel sliding from its sheath, a glint at the release; the ultima adds war drums that quicken.
      noiseRise(ctx, destination, noise, start, duration, 0.012 * weight, 2600, 7200, 2.4);
      bell(ctx, destination, start + duration * 0.92, base + 27, 0.01 * weight);
      if (attack === Attack.Ultima) for (const at of WAR_DRUMS) tone(ctx, destination, 'sine', 118, 52, start + duration * at, 0.18, 0.05, 'lowpass', 300);
      return;
    case 'bells':
      // Shrine bells over a falling, breathy glide.
      swellTone(ctx, destination, 'sine', midiToHz(base + 12), midiToHz(base + 5), start, duration, 0.008 * weight, 'bandpass', 1800, 0.6);
      for (const ring of SHRINE_BELLS) bell(ctx, destination, start + duration * ring.at, base + ring.offset, 0.006 * weight);
      return;
    case 'engine':
      // Turbines spooling up under the whole tell; the ultima ends on a heroic major chord.
      swellTone(ctx, destination, 'sawtooth', 38, 132, start, duration, 0.03 * weight, 'lowpass', 700, 0.92);
      if (attack === Attack.Ultima) chord(ctx, destination, start + duration * 0.8, base + 12, [0, 4, 7], duration * 0.2, 0.012, 'triangle');
      return;
  }
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

export function scheduleSfx(ctx: AnyContext, destination: AudioNode, noise: AudioBuffer, name: Sfx, start: number, options?: PlayOptions): number {
  const voice = makeVoiceBus(ctx, destination, options);
  const windup = WINDUPS.find((entry) => entry.name === name);
  if (windup !== undefined) {
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
    case 'boost':
      // An airy rush that opens upward, a low push under it and a quick rising edge on top.
      noiseBurst(ctx, voice, noise, start, 0.2, 0.05, 'bandpass', 900, 4200, 1.4);
      tone(ctx, voice, 'sine', 140, 70, start, 0.08, 0.03, 'lowpass', 400);
      tone(ctx, voice, 'triangle', 420, 980, start + 0.01, 0.09, 0.015, 'bandpass', 1400);
      break;
    case 'shieldHit':
      // Glassy: a short bright ping with a bell overtone and a tick of noise.
      tone(ctx, voice, 'sine', 1800, 1500, start, 0.06, 0.018, 'bandpass', 1800);
      bell(ctx, voice, start + 0.005, 96, 0.006);
      noiseBurst(ctx, voice, noise, start, 0.02, 0.008, 'highpass', 6000, 5000, 1.1);
      break;
    case 'shieldBreak':
      // Shatter: a falling crash of glass over a low thud (band-passed: an open high end is piercing in a busy mix).
      noiseBurst(ctx, voice, noise, start, 0.26, 0.05, 'bandpass', 5200, 2600, 0.8);
      tone(ctx, voice, 'square', 1200, 300, start, 0.22, 0.02, 'bandpass', 1500);
      bell(ctx, voice, start + 0.01, 90, 0.008);
      bell(ctx, voice, start + 0.03, 94, 0.006);
      tone(ctx, voice, 'sine', 110, 55, start, 0.2, 0.04, 'lowpass', 300);
      break;
    case 'shieldUp':
      // Soft rising chime: the shield is back.
      tone(ctx, voice, 'sine', 520, 880, start, 0.12, 0.012, 'bandpass', 900);
      bell(ctx, voice, start + 0.04, 84, 0.004);
      break;
    case 'shotLongbow':
      // A rail: a hard crack, a bright zap falling away, a thump in the chest and the barrel ringing.
      noiseBurst(ctx, voice, noise, start, 0.05, 0.035, 'highpass', 5200, 2800, 1.2);
      tone(ctx, voice, 'sawtooth', 2600, 380, start, 0.18, 0.028, 'lowpass', 3400);
      tone(ctx, voice, 'sine', 120, 55, start, 0.14, 0.05, 'lowpass', 320);
      bell(ctx, voice, start + 0.01, 93, 0.005);
      break;
    case 'chargeFull':
      // A glint: a quick bright rise and a high bell.
      tone(ctx, voice, 'sine', 2200, 3300, start, 0.07, 0.01, 'bandpass', 2800);
      bell(ctx, voice, start + 0.03, 95, 0.01);
      break;
    case 'mineDrop':
      // A heavy disc set down, then two arming blips.
      metalClack(ctx, voice, noise, start, 0.022);
      tone(ctx, voice, 'sine', 150, 80, start, 0.08, 0.04, 'lowpass', 400);
      tone(ctx, voice, 'square', 1560, 1560, start + 0.16, 0.035, 0.012, 'lowpass', 2600);
      tone(ctx, voice, 'square', 1560, 1560, start + 0.3, 0.035, 0.012, 'lowpass', 2600);
      break;
    case 'beamTell':
      // A thin laser warming up: a high whine rising under a faint hiss, gone as the beam lights.
      swellTone(ctx, voice, 'sine', 900, 2600, start, BEAM_TELL_SECONDS, 0.012, 'bandpass', 2400);
      noiseRise(ctx, voice, noise, start, BEAM_TELL_SECONDS, 0.008, 1800, 5200, 1.6);
      break;
    case 'beamOn':
      // Ignition: a buzzing snap as the beam lights (the beamHum layer carries it from there).
      tone(ctx, voice, 'sawtooth', 220, 160, start, 0.2, 0.028, 'bandpass', 1600);
      noiseBurst(ctx, voice, noise, start, 0.08, 0.028, 'bandpass', 5200, 2400, 1.1);
      tone(ctx, voice, 'sine', 1800, 1320, start, 0.16, 0.01, 'bandpass', 1600);
      break;
    case 'lanceTell':
      // A capacitor charging: a climbing whine whose pulse quickens toward the shot, like the drawn laser.
      swellTone(ctx, voice, 'triangle', 500, 2400, start, LANCE_TELL_SECONDS, 0.014, 'bandpass', 2000, 0.97);
      for (const at of LANCE_PULSES) tone(ctx, voice, 'sine', 2400, 2400, start + at * LANCE_TELL_SECONDS, 0.03, 0.008, 'bandpass', 2600);
      break;
    case 'lanceCrack':
      // The rail fires: a split-second crack, a zap that crosses the arena and a low boom.
      noiseBurst(ctx, voice, noise, start, 0.07, 0.055, 'highpass', 6000, 2400, 0.9);
      tone(ctx, voice, 'sawtooth', 3600, 160, start, 0.3, 0.032, 'lowpass', 4200);
      tone(ctx, voice, 'square', 1200, 300, start, 0.12, 0.012, 'bandpass', 1800);
      impact(ctx, voice, noise, start + 0.01, 'medium', 0.8);
      break;
    case 'shotHailstorm':
      // One round of a rotary cannon: a short dry bark (it fires up to twenty a second).
      tone(ctx, voice, 'square', 640, 400, start, 0.025, 0.02, 'lowpass', 1800);
      noiseBurst(ctx, voice, noise, start, 0.02, 0.012, 'bandpass', 2600, 1600, 1.2);
      tone(ctx, voice, 'sine', 170, 110, start, 0.03, 0.02, 'lowpass', 500);
      break;
    case 'carpetLaunch':
      // Every tube of the rack firing in a quick ripple, one pop per bomb.
      for (let tube = 0; tube < HAILSTORM.carpet.count; tube++) {
        const at = start + tube * CARPET_POP_GAP;
        tone(ctx, voice, 'triangle', 260 - tube * 12, 110, at, 0.07, 0.032, 'lowpass', 900);
        noiseBurst(ctx, voice, noise, at, 0.05, 0.014, 'bandpass', 1400, 600, 1);
      }
      break;
    case 'blast':
      // A lobbed shell landing: a thud and a crackle of debris.
      impact(ctx, voice, noise, start, 'medium', 1);
      noiseBurst(ctx, voice, noise, start + 0.03, 0.22, 0.02, 'bandpass', 2600, 700, 1.3);
      break;
    case 'shotRonin':
      // A katana cut: a fast rising swish with a faint ring of steel.
      noiseBurst(ctx, voice, noise, start, 0.1, 0.04, 'bandpass', 1400, 5200, 1.6);
      tone(ctx, voice, 'triangle', 900, 1500, start, 0.06, 0.008, 'bandpass', 1400);
      bell(ctx, voice, start + 0.04, 96, 0.003);
      break;
    case 'parry':
      // The blade snaps to guard: a sliding steel "shing".
      noiseBurst(ctx, voice, noise, start, 0.12, 0.022, 'highpass', 3600, 7000, 1.2);
      tone(ctx, voice, 'sine', 2600, 3100, start + 0.02, 0.2, 0.01, 'bandpass', 2800);
      bell(ctx, voice, start + 0.02, 91, 0.008);
      break;
    case 'reflect':
      // A shot knocked back: a hard clang with a ringing overtone.
      metalClack(ctx, voice, noise, start, 0.03);
      bell(ctx, voice, start, 86, 0.012);
      bell(ctx, voice, start + 0.012, 93, 0.008);
      break;
    case 'beamCut':
      // A beam split on the blade (it repeats while the beam is held on it): a hiss of sparks and a thin ring.
      noiseBurst(ctx, voice, noise, start, 0.08, 0.018, 'bandpass', 5200, 3000, 1.4);
      bell(ctx, voice, start, 91, 0.005);
      break;
    case 'shotShade':
      // Two stars thrown at once: a pair of light, airy whips.
      for (const at of [start, start + SHURIKEN_PAIR_GAP]) {
        noiseBurst(ctx, voice, noise, at, 0.05, 0.02, 'bandpass', 2200, 4600, 2.2);
        tone(ctx, voice, 'triangle', 1600, 2400, at, 0.03, 0.007, 'bandpass', 2200);
      }
      break;
    case 'cloak':
      // Fading out: a soft breath that falls away into nothing.
      noiseBurst(ctx, voice, noise, start, 0.42, 0.022, 'bandpass', 4200, 500, 1.4);
      tone(ctx, voice, 'sine', 880, 330, start, 0.36, 0.01, 'bandpass', 900);
      break;
    case 'reveal':
      // Snapping back into view: a quick rising shimmer.
      tone(ctx, voice, 'triangle', 420, 1500, start, 0.09, 0.016, 'bandpass', 1200);
      noiseBurst(ctx, voice, noise, start, 0.06, 0.016, 'highpass', 3200, 5200, 1.2);
      bell(ctx, voice, start + 0.05, 86, 0.008);
      break;
    case 'shotGauntlet':
      // A knuckle round: a punchy low thump with a knock of metal.
      tone(ctx, voice, 'sine', 160, 60, start, 0.1, 0.08, 'lowpass', 500);
      tone(ctx, voice, 'square', 380, 180, start, 0.05, 0.018, 'lowpass', 1300);
      noiseBurst(ctx, voice, noise, start, 0.06, 0.03, 'lowpass', 1800, 300, 0.8);
      break;
    case 'rocketPunch':
      // The wrist clamps let go and a rocket roars away.
      metalClack(ctx, voice, noise, start, 0.02);
      noiseBurst(ctx, voice, noise, start + 0.02, 0.4, 0.045, 'bandpass', 900, 2400, 1.1);
      tone(ctx, voice, 'sawtooth', 90, 150, start + 0.02, 0.36, 0.028, 'lowpass', 900);
      tone(ctx, voice, 'sine', 130, 60, start, 0.14, 0.05, 'lowpass', 400);
      break;
    case 'fistCatch':
      // The fist docks: two clamp clanks over a low thunk.
      metalClack(ctx, voice, noise, start, 0.026);
      metalClack(ctx, voice, noise, start + 0.05, 0.018);
      tone(ctx, voice, 'sine', 120, 70, start, 0.09, 0.045, 'lowpass', 400);
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
    case 'bossBeam':
      // A colossus beam lights: a deep roar with a bright, searing edge.
      tone(ctx, voice, 'sawtooth', 74, 52, start, 0.66, 0.055, 'lowpass', 900);
      noiseBurst(ctx, voice, noise, start, 0.5, 0.028, 'bandpass', 2600, 1200, 0.9);
      tone(ctx, voice, 'triangle', 1400, 900, start, 0.4, 0.012, 'bandpass', 1600);
      tone(ctx, voice, 'sine', 150, 50, start, 0.3, 0.05, 'lowpass', 400);
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

/**
 * A live beam's hum: two detuned saws buzzing through a wobbling band-pass, a thin high shimmer and a sizzle of noise. The
 * director follows the loudest beam near the listener; `pitch` is high for a robot's thin beam and low for a colossus's.
 */
function createBeamHumLayer(ctx: AudioContext, destination: AudioNode, noise: AudioBuffer): LoopLayer {
  const gain = ctx.createGain();
  gain.gain.value = QUIET;
  const panner = makePanNode(ctx, OFF_PAN);
  gain.connect(panner).connect(destination);

  const core = ctx.createOscillator();
  core.type = 'sawtooth';
  core.frequency.value = 110;
  const coreTwin = ctx.createOscillator();
  coreTwin.type = 'sawtooth';
  coreTwin.frequency.value = 110;
  coreTwin.detune.value = 9;
  const band = ctx.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.value = 1400;
  band.Q.value = 2.2;
  const coreGain = ctx.createGain();
  coreGain.gain.value = 0.035;
  core.connect(band);
  coreTwin.connect(band);
  band.connect(coreGain).connect(gain);

  const shimmer = ctx.createOscillator();
  shimmer.type = 'sine';
  shimmer.frequency.value = 1650;
  const shimmerGain = ctx.createGain();
  shimmerGain.gain.value = 0.008;
  shimmer.connect(shimmerGain).connect(gain);

  const sizzle = ctx.createBufferSource();
  sizzle.buffer = noise;
  sizzle.loop = true;
  const sizzleFilter = ctx.createBiquadFilter();
  sizzleFilter.type = 'bandpass';
  sizzleFilter.frequency.value = 4200;
  sizzleFilter.Q.value = 1.4;
  const sizzleGain = ctx.createGain();
  sizzleGain.gain.value = 0.01;
  sizzle.connect(sizzleFilter).connect(sizzleGain).connect(gain);

  const lfo = ctx.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.value = 11;
  const lfoGain = ctx.createGain();
  lfoGain.gain.value = 260;
  lfo.connect(lfoGain).connect(band.frequency);

  core.start();
  coreTwin.start();
  shimmer.start();
  sizzle.start();
  lfo.start();

  return {
    setState(state: LayerState): void {
      const now = ctx.currentTime;
      const pitch = clamp(state.pitch ?? DEFAULT_LAYER_PITCH, 0.4, 2.4);
      rampParameter(core.frequency, now, 110 * pitch, 0.06);
      rampParameter(coreTwin.frequency, now, 110 * pitch, 0.06);
      rampParameter(band.frequency, now, 900 + 600 * pitch, 0.06);
      rampParameter(shimmer.frequency, now, 1500 * pitch, 0.06);
      rampParameter(sizzleFilter.frequency, now, 3000 + 1500 * pitch, 0.06);
      panner.pan.setValueAtTime(clamp(state.pan ?? OFF_PAN, -1, 1), now);
      const target = state.active ? clamp(state.gain ?? DEFAULT_LAYER_GAIN, 0.02, 1) : QUIET;
      rampParameter(gain.gain, now, target, state.active ? 0.04 : 0.09);
    },
    dispose(): void {
      const stopAt = ctx.currentTime + 0.05;
      core.stop(stopAt);
      coreTwin.stop(stopAt);
      shimmer.stop(stopAt);
      sizzle.stop(stopAt);
      lfo.stop(stopAt);
      gain.disconnect();
    },
  };
}

export function createLoopLayer(name: LayerName, ctx: AudioContext, destination: AudioNode, noise: AudioBuffer): LoopLayer {
  switch (name) {
    case 'bossDrone':
      return createBossDroneLayer(ctx, destination, noise);
    case 'ultimaBarrage':
      return createUltimaBarrageLayer(ctx, destination, noise);
    case 'beamHum':
      return createBeamHumLayer(ctx, destination, noise);
  }
}
