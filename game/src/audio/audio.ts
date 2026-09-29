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
 * - stopMusic(fadeSeconds?: number): void
 * - setLayer(name: LayerName, state: LayerState): void
 * - suspendForHidden(hidden: boolean): void
 * - dispose(): void
 */
import { TRACK_SPECS, renderTrack } from './music.ts';
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

interface PlayingTrack {
  readonly track: Track;
  readonly source: AudioBufferSourceNode;
  readonly gain: GainNode;
}

function stopTrack(track: PlayingTrack, ctx: AudioContext, fadeSeconds: number): void {
  const fade = Math.max(0.03, fadeSeconds);
  const now = ctx.currentTime;
  track.gain.gain.cancelScheduledValues(now);
  track.gain.gain.setValueAtTime(Math.max(FADE_FLOOR, track.gain.gain.value), now);
  track.gain.gain.exponentialRampToValueAtTime(FADE_FLOOR, now + fade);
  track.source.stop(now + fade + 0.05);
}

export type { LayerName, LayerState, PlayOptions, Sfx, Track };
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
  private readonly trackCache = new Map<Track, AudioBuffer>();
  private readonly trackRendering = new Map<Track, Promise<AudioBuffer>>();
  private readonly layers = new Map<LayerName, LoopLayer>();
  private readonly layerState = new Map<LayerName, LayerState>();
  private currentTrack: PlayingTrack | null = null;
  private wantedTrack: Track | null = null;

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

  private ensureTrack(track: Track): Promise<AudioBuffer> {
    const cached = this.trackCache.get(track);
    if (cached !== undefined) return Promise.resolve(cached);
    const inflight = this.trackRendering.get(track);
    if (inflight !== undefined) return inflight;
    const render = renderTrack(track).then((buffer) => {
      this.trackCache.set(track, buffer);
      return buffer;
    });
    this.trackRendering.set(track, render);
    void render.finally(() => {
      this.trackRendering.delete(track);
    });
    return render;
  }

  private startTrack(track: Track, fadeSeconds: number): void {
    const ctx = this.ctx;
    if (ctx === null || this.musicBus === null || ctx.state !== 'running') return;
    if (this.currentTrack?.track === track) return;
    void this.ensureTrack(track).then((buffer) => {
      if (this.ctx !== ctx || this.musicBus === null || ctx.state !== 'running' || this.wantedTrack !== track) return;
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = TRACK_SPECS[track].loop;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(FADE_FLOOR, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(1, ctx.currentTime + Math.max(0.04, fadeSeconds));
      source.connect(gain).connect(this.musicBus);
      const previous = this.currentTrack;
      this.currentTrack = { track, source, gain };
      source.onended = () => {
        if (this.currentTrack?.source !== source) return;
        this.currentTrack = null;
        if (!TRACK_SPECS[track].loop && this.wantedTrack === track) this.wantedTrack = null;
      };
      source.start();
      if (previous !== null) stopTrack(previous, ctx, Math.min(0.5, fadeSeconds));
    }).catch(() => {
      if (this.wantedTrack === track) this.wantedTrack = null;
    });
  }
}
