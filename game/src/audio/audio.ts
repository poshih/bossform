/**
 * AudioEngine public API:
 * - constructor()
 * - onMuteChange: (muted: boolean) => void
 * - isMuted(): boolean
 * - setMuted(muted: boolean): void
 * - unlock(): void
 * - get running(): boolean
 * - play(sfx: Sfx, options?: PlayOptions): void
 * - playMusic(track: Track, fadeSeconds?: number): void
 * - musicPosition(): { readonly bpm: number; readonly beats: number } | null
 *   Returns continuous beat position for the current music timeline. In-match music
 *   (battle / bossForm / sudden) switches on bar boundaries and preserves this beat
 *   counter across vertical-remix switches; menu/stinger families may restart it.
 *   Muting only silences output, so position continues while muted.
 * - stopMusic(fadeSeconds?: number): void
 * - setLayer(name: LayerName, state: LayerState): void
 * - suspendForHidden(hidden: boolean): void
 * - dispose(): void
 */
import { SECTION_BARS, TRACK_SPECS } from './music.ts';
import type { MusicPosition } from '../beat.ts';
import {
  LAYER_NAMES,
  SFX_NAMES,
  SFX_SPECS,
  TRACK_NAMES,
  createLoopLayer,
  createNoiseBuffer,
  renderSfxBuffer,
  scheduleSfx,
} from './synth.ts';
import type { LayerName, LayerState, LoopLayer, PlayOptions, Sfx, Track } from './synth.ts';

const STORAGE_KEY = 'bossform.muted';
const MASTER_ON = 1;
const MASTER_OFF = 0;
const CROSSFADE_SECONDS = 0.8;
const MUSIC_GAIN = 0.56;
const SFX_GAIN = 0.82;
const LAYER_GAIN = 0.44;
const FADE_FLOOR = 0.0001;
const BEATS_PER_BAR = 4;
const BAR_SWITCH_LOOKAHEAD_BEATS = 0.05;
const QUANTIZED_CROSSFADE_SECONDS = 0.22;
const PRELOAD_MATCH_TRACKS: readonly Track[] = ['battle', 'bossForm', 'sudden'];
const SECTIONS_SCHEDULED_AHEAD = 2;

interface PlayingTrack {
  readonly track: Track;
  readonly gain: GainNode;
  readonly startTime: number;
  readonly startBeat: number;
  readonly bpm: number;
  readonly loopBeats: number;
  readonly family: string;
  readonly loop: boolean;
  readonly sources: AudioBufferSourceNode[];
  nextSection: number;
  nextStartTime: number;
}

interface WorkerSection {
  readonly sampleRate: number;
  readonly left: Float32Array;
  readonly right: Float32Array;
}

interface WorkerSectionResponse extends WorkerSection {
  readonly id: number;
  readonly track: Track;
  readonly section: number;
}

function stopTrackAt(track: PlayingTrack, ctx: AudioContext, when: number, fadeSeconds: number): void {
  const fade = Math.max(0.03, fadeSeconds);
  track.gain.gain.cancelScheduledValues(when);
  track.gain.gain.setValueAtTime(Math.max(FADE_FLOOR, track.gain.gain.value), when);
  track.gain.gain.exponentialRampToValueAtTime(FADE_FLOOR, when + fade);
  for (const source of track.sources) source.stop(when + fade + 0.05);
}

function stopTrack(track: PlayingTrack, ctx: AudioContext, fadeSeconds: number): void {
  stopTrackAt(track, ctx, ctx.currentTime, fadeSeconds);
}

export type { LayerName, LayerState, MusicPosition, PlayOptions, Sfx, Track };
export { LAYER_NAMES, SFX_NAMES, SFX_SPECS, TRACK_NAMES, renderSfxBuffer };

export class AudioEngine {
  onMuteChange: (muted: boolean) => void = () => {};

  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private layerBus: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private muted: boolean;
  private readonly lastPlayed = new Map<Sfx, number>();
  private readonly sectionCache = new Map<string, AudioBuffer>();
  private readonly sectionRendering = new Map<string, Promise<AudioBuffer>>();
  private readonly layers = new Map<LayerName, LoopLayer>();
  private readonly layerState = new Map<LayerName, LayerState>();
  private currentTrack: PlayingTrack | null = null;
  private wantedTrack: Track | null = null;
  private matchPreloadStarted = false;
  private musicWorker: Worker | null = null;
  private nextWorkerRequestId = 1;
  private readonly workerResolvers = new Map<number, (section: WorkerSectionResponse) => void>();

  constructor() {
    let stored = false;
    try {
      stored = localStorage.getItem(STORAGE_KEY) === '1';
    } catch {
      stored = false;
    }
    this.muted = stored;
    for (const name of LAYER_NAMES) this.layerState.set(name, { active: false });
  }

  isMuted(): boolean {
    return this.muted;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.masterGain !== null) this.masterGain.gain.value = muted ? MASTER_OFF : MASTER_ON;
    try {
      localStorage.setItem(STORAGE_KEY, muted ? '1' : '0');
    } catch {
      /* storage is optional */
    }
    this.onMuteChange(muted);
  }

  unlock(): void {
    if (this.ctx === null) this.build();
    if (this.ctx !== null && this.ctx.state !== 'running') void this.ctx.resume();
  }

  get running(): boolean {
    return this.ctx?.state === 'running';
  }

  play(sfx: Sfx, options?: PlayOptions): void {
    const ctx = this.ctx;
    if (ctx === null || ctx.state !== 'running' || this.sfxBus === null || this.noise === null) return;
    const now = ctx.currentTime;
    const gap = SFX_SPECS[sfx].minGap;
    const last = this.lastPlayed.get(sfx) ?? -Infinity;
    if (now - last < gap) return;
    this.lastPlayed.set(sfx, now);
    scheduleSfx(ctx, this.sfxBus, this.noise, sfx, now + 0.005, options);
  }

  playMusic(track: Track, fadeSeconds = CROSSFADE_SECONDS): void {
    if (this.wantedTrack === track) return;
    this.wantedTrack = track;
    if (this.ctx === null || this.ctx.state !== 'running') return;
    this.startTrack(track, fadeSeconds);
  }

  musicPosition(): MusicPosition | null {
    const ctx = this.ctx;
    const track = this.currentTrack;
    if (ctx === null || track === null || ctx.state !== 'running') return null;
    return { bpm: track.bpm, beats: this.trackBeats(track, ctx.currentTime) };
  }

  stopMusic(fadeSeconds = CROSSFADE_SECONDS): void {
    this.wantedTrack = null;
    if (this.ctx === null || this.currentTrack === null) return;
    stopTrack(this.currentTrack, this.ctx, fadeSeconds);
    this.currentTrack = null;
  }

  setLayer(name: LayerName, state: LayerState): void {
    this.layerState.set(name, {
      active: state.active,
      gain: state.gain,
      pitch: state.pitch,
      pan: state.pan,
    });
    if (this.ctx === null || this.ctx.state !== 'running') return;
    this.ensureLayer(name)?.setState(state);
  }

  suspendForHidden(hidden: boolean): void {
    if (this.ctx === null) return;
    if (hidden) void this.ctx.suspend();
    else if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  dispose(): void {
    if (this.ctx !== null && this.currentTrack !== null) stopTrack(this.currentTrack, this.ctx, 0.04);
    this.currentTrack = null;
    this.wantedTrack = null;
    for (const layer of this.layers.values()) layer.dispose();
    this.layers.clear();
    const ctx = this.ctx;
    this.ctx = null;
    this.masterGain = null;
    this.musicBus = null;
    this.sfxBus = null;
    this.layerBus = null;
    this.noise = null;
    this.musicWorker?.terminate();
    this.musicWorker = null;
    if (ctx !== null) void ctx.close().catch(() => {});
  }

  private build(): void {
    let ctx: AudioContext;
    try {
      ctx = new AudioContext({ latencyHint: 'interactive' });
    } catch {
      return;
    }
    this.ctx = ctx;
    const master = ctx.createGain();
    master.gain.value = this.muted ? MASTER_OFF : MASTER_ON;
    this.masterGain = master;

    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -8;
    limiter.knee.value = 4;
    limiter.ratio.value = 10;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.12;
    master.connect(limiter).connect(ctx.destination);

    const musicBus = ctx.createGain();
    musicBus.gain.value = MUSIC_GAIN;
    musicBus.connect(master);
    this.musicBus = musicBus;

    const sfxBus = ctx.createGain();
    sfxBus.gain.value = SFX_GAIN;
    sfxBus.connect(master);
    this.sfxBus = sfxBus;

    const layerBus = ctx.createGain();
    layerBus.gain.value = LAYER_GAIN;
    layerBus.connect(master);
    this.layerBus = layerBus;

    this.noise = createNoiseBuffer(ctx, 2, 5);
    for (const name of LAYER_NAMES) {
      const layer = this.ensureLayer(name);
      if (layer !== null) layer.setState(this.layerState.get(name) ?? { active: false });
    }

    ctx.addEventListener('statechange', () => {
      if (ctx.state !== 'running') return;
      for (const name of LAYER_NAMES) this.ensureLayer(name)?.setState(this.layerState.get(name) ?? { active: false });
      if (this.wantedTrack !== null) this.startTrack(this.wantedTrack, 0.4);
    });
  }

  private ensureLayer(name: LayerName): LoopLayer | null {
    const existing = this.layers.get(name);
    if (existing !== undefined) return existing;
    if (this.ctx === null || this.layerBus === null || this.noise === null) return null;
    const layer = createLoopLayer(name, this.ctx, this.layerBus, this.noise);
    this.layers.set(name, layer);
    return layer;
  }

  private ensureMusicWorker(): Worker {
    if (this.musicWorker !== null) return this.musicWorker;
    const worker = new Worker(new URL('./musicWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<WorkerSectionResponse>) => {
      const resolver = this.workerResolvers.get(event.data.id);
      if (resolver === undefined) return;
      this.workerResolvers.delete(event.data.id);
      resolver(event.data);
    };
    this.musicWorker = worker;
    return worker;
  }

  private sectionKey(track: Track, section: number): string {
    return `${track}:${section}`;
  }

  private sectionCount(track: Track): number {
    return Math.ceil(TRACK_SPECS[track].bars / SECTION_BARS);
  }

  private toAudioBuffer(section: WorkerSection): AudioBuffer | null {
    const ctx = this.ctx;
    if (ctx === null) return null;
    const buffer = ctx.createBuffer(2, section.left.length, section.sampleRate);
    buffer.copyToChannel(new Float32Array(section.left), 0);
    buffer.copyToChannel(new Float32Array(section.right), 1);
    return buffer;
  }

  private ensureSection(track: Track, section: number): Promise<AudioBuffer> {
    const wrapped = ((section % this.sectionCount(track)) + this.sectionCount(track)) % this.sectionCount(track);
    const key = this.sectionKey(track, wrapped);
    const cached = this.sectionCache.get(key);
    if (cached !== undefined) return Promise.resolve(cached);
    const inflight = this.sectionRendering.get(key);
    if (inflight !== undefined) return inflight;
    const requestId = this.nextWorkerRequestId++;
    const render = new Promise<AudioBuffer>((resolve) => {
      this.workerResolvers.set(requestId, (response) => {
        const buffer = this.toAudioBuffer(response);
        if (buffer === null) return;
        this.sectionCache.set(key, buffer);
        resolve(buffer);
      });
      this.ensureMusicWorker().postMessage({ id: requestId, track, section: wrapped, bars: SECTION_BARS });
    });
    this.sectionRendering.set(key, render);
    void render.finally(() => this.sectionRendering.delete(key));
    return render;
  }

  private startTrack(track: Track, fadeSeconds: number): void {
    const ctx = this.ctx;
    if (ctx === null || this.musicBus === null || ctx.state !== 'running') return;
    if (this.currentTrack?.track === track) return;
    const spec = TRACK_SPECS[track];
    const previous = this.currentTrack;
    const quantized = previous !== null && previous.family === 'match' && spec.family === 'match' && previous.bpm === spec.bpm;
    const timing = quantized ? this.nextBarTiming(previous, ctx.currentTime) : { startTime: ctx.currentTime, startBeat: 0 };
    const loopBeats = spec.bars * BEATS_PER_BAR;
    const offsetBeats = spec.loop ? ((timing.startBeat % loopBeats) + loopBeats) % loopBeats : 0;
    const section = Math.floor(offsetBeats / (SECTION_BARS * BEATS_PER_BAR));
    void this.ensureSection(track, section).then((buffer) => {
      if (this.ctx !== ctx || this.musicBus === null || ctx.state !== 'running' || this.wantedTrack !== track) return;
      if (previous?.track === track) return;
      const lateBy = Math.max(0, ctx.currentTime + 0.02 - timing.startTime);
      const actualTiming = lateBy > 0 && !quantized ? {
        startTime: ctx.currentTime + 0.02,
        startBeat: timing.startBeat + lateBy * spec.bpm / 60,
      } : lateBy > 0 ? { startTime: ctx.currentTime + 0.02, startBeat: timing.startBeat } : timing;
      const fade = quantized ? Math.min(QUANTIZED_CROSSFADE_SECONDS, fadeSeconds) : Math.max(0.04, fadeSeconds);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(FADE_FLOOR, actualTiming.startTime);
      gain.gain.exponentialRampToValueAtTime(1, actualTiming.startTime + fade);
      gain.connect(this.musicBus);
      const playing: PlayingTrack = {
        track,
        gain,
        startTime: actualTiming.startTime,
        startBeat: actualTiming.startBeat,
        bpm: spec.bpm,
        loopBeats,
        family: spec.family,
        loop: spec.loop,
        sources: [],
        nextSection: section,
        nextStartTime: actualTiming.startTime,
      };
      this.currentTrack = playing;
      const actualOffsetBeats = spec.loop ? ((actualTiming.startBeat % loopBeats) + loopBeats) % loopBeats : 0;
      this.scheduleSection(playing, buffer, actualOffsetBeats % (SECTION_BARS * BEATS_PER_BAR), true);
      this.fillSchedule(playing);
      if (previous !== null) stopTrackAt(previous, ctx, quantized ? actualTiming.startTime : ctx.currentTime, quantized ? fade : Math.min(0.5, fadeSeconds));
      if (track === 'title') this.preloadMatchTracks();
      if (spec.family === 'match') this.preloadMatchTracks();
    }).catch(() => {
      if (this.wantedTrack === track) this.wantedTrack = null;
    });
  }

  private preloadMatchTracks(): void {
    if (this.matchPreloadStarted) return;
    this.matchPreloadStarted = true;
    for (const track of PRELOAD_MATCH_TRACKS) void this.ensureSection(track, 0);
  }

  private scheduleSection(playing: PlayingTrack, buffer: AudioBuffer, offsetBeats: number, first: boolean): void {
    if (this.ctx === null) return;
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(playing.gain);
    const offsetSeconds = (offsetBeats * 60) / playing.bpm;
    source.start(playing.nextStartTime, offsetSeconds);
    playing.sources.push(source);
    const sectionBodySeconds = (SECTION_BARS * BEATS_PER_BAR * 60) / playing.bpm;
    playing.nextStartTime += first ? sectionBodySeconds - offsetSeconds : sectionBodySeconds;
    playing.nextSection++;
    source.onended = () => {
      const index = playing.sources.indexOf(source);
      if (index >= 0) playing.sources.splice(index, 1);
      if (this.currentTrack === playing && !playing.loop && playing.sources.length === 0) this.currentTrack = null;
      if (this.currentTrack === playing && playing.loop) this.fillSchedule(playing);
    };
  }

  private fillSchedule(playing: PlayingTrack): void {
    const ctx = this.ctx;
    if (ctx === null || this.currentTrack !== playing) return;
    while (playing.nextStartTime < ctx.currentTime + SECTIONS_SCHEDULED_AHEAD * SECTION_BARS * BEATS_PER_BAR * 60 / playing.bpm) {
      const section = playing.nextSection;
      if (!playing.loop && section >= this.sectionCount(playing.track)) break;
      void this.ensureSection(playing.track, section).then((buffer) => {
        if (this.currentTrack !== playing) return;
        this.scheduleSection(playing, buffer, 0, false);
        this.fillSchedule(playing);
      });
      break;
    }
  }

  private trackBeats(track: PlayingTrack, time: number): number {
    const elapsed = Math.max(0, time - track.startTime);
    return track.startBeat + elapsed * track.bpm / 60;
  }

  private nextBarTiming(track: PlayingTrack, now: number): { readonly startTime: number; readonly startBeat: number } {
    const beats = this.trackBeats(track, now);
    const nextBar = Math.ceil((beats + BAR_SWITCH_LOOKAHEAD_BEATS) / BEATS_PER_BAR) * BEATS_PER_BAR;
    return {
      startTime: now + (nextBar - beats) * 60 / track.bpm,
      startBeat: nextBar,
    };
  }
}
