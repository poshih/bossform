import { createBeamLoop, createNoiseBuffer, renderSfxBuffer, scheduleSfx, SFX_NAMES, SFX_SPECS, TRACK_NAMES } from './synth.ts';
import { renderTrack, TRACK_SPECS } from './music.ts';
import type { BeamLoop, PlayOptions, Sfx, Track } from './synth.ts';

const STORAGE_KEY = 'bossform.muted';
const MUSIC_GAIN = 0.58;
const SFX_GAIN = 0.82;
const MASTER_ON = 1;
const MASTER_OFF = 0;
const CROSSFADE_SECONDS = 0.8;

type CachedTrack = {
  track: Track;
  source: AudioBufferSourceNode;
  gain: GainNode;
};

function stopSource(source: CachedTrack, ctx: AudioContext, fadeSeconds: number): void {
  const fade = Math.max(0.03, fadeSeconds);
  const now = ctx.currentTime;
  source.gain.gain.cancelScheduledValues(now);
  source.gain.gain.setValueAtTime(Math.max(0.0001, source.gain.gain.value), now);
  source.gain.gain.exponentialRampToValueAtTime(0.0001, now + fade);
  source.source.stop(now + fade + 0.05);
}

export type { PlayOptions, Sfx, Track };
export { renderSfxBuffer, SFX_NAMES, TRACK_NAMES };

export class AudioEngine {
  onMuteChange: (muted: boolean) => void = () => {};

  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private muted: boolean;
  private readonly lastPlayed = new Map<Sfx, number>();
  private readonly trackCache = new Map<Track, AudioBuffer>();
  private readonly trackRendering = new Map<Track, Promise<AudioBuffer>>();
  private currentMusic: CachedTrack | null = null;
  private wantedTrack: Track | null = null;
  private beamLoop: BeamLoop | null = null;
  private beamActive = false;

  constructor() {
    let storedMuted = false;
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      storedMuted = stored === '1';
    } catch {
      storedMuted = false;
    }
    this.muted = storedMuted;
  }

  isMuted(): boolean {
    return this.muted;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.masterGain) this.masterGain.gain.value = muted ? MASTER_OFF : MASTER_ON;
    try {
      localStorage.setItem(STORAGE_KEY, muted ? '1' : '0');
    } catch {
      /* storage is optional */
    }
    this.onMuteChange(muted);
  }

  unlock(): void {
    if (!this.ctx) this.build();
    if (this.ctx && this.ctx.state !== 'running') void this.ctx.resume();
  }

  get running(): boolean {
    return this.ctx?.state === 'running';
  }

  play(sfx: Sfx, options?: PlayOptions): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || !this.sfxBus || !this.noise) return;
    const gap = SFX_SPECS[sfx].minGap;
    const now = ctx.currentTime;
    const last = this.lastPlayed.get(sfx) ?? -Infinity;
    if (now - last < gap) return;
    this.lastPlayed.set(sfx, now);
    scheduleSfx(ctx, this.sfxBus, this.noise, sfx, now + 0.005, options);
  }

  playMusic(track: Track, fadeSeconds = CROSSFADE_SECONDS): void {
    if (this.wantedTrack === track) return;
    this.wantedTrack = track;
    if (!this.ctx || this.ctx.state !== 'running') return;
    this.startMusic(track, fadeSeconds);
  }

  stopMusic(fadeSeconds = CROSSFADE_SECONDS): void {
    this.wantedTrack = null;
    if (!this.ctx || !this.currentMusic) return;
    stopSource(this.currentMusic, this.ctx, fadeSeconds);
    this.currentMusic = null;
  }

  setBeam(active: boolean): void {
    this.beamActive = active;
    this.beamLoop?.setActive(active);
  }

  suspendForHidden(hidden: boolean): void {
    if (!this.ctx) return;
    if (hidden) void this.ctx.suspend();
    else if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  dispose(): void {
    if (this.ctx && this.currentMusic) stopSource(this.currentMusic, this.ctx, 0.04);
    this.currentMusic = null;
    this.wantedTrack = null;
    this.beamLoop?.dispose();
    this.beamLoop = null;
    const ctx = this.ctx;
    this.ctx = null;
    this.masterGain = null;
    this.musicBus = null;
    this.sfxBus = null;
    this.noise = null;
    if (ctx) void ctx.close().catch(() => {});
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

    this.noise = createNoiseBuffer(ctx, 2, 5);
    this.beamLoop = createBeamLoop(ctx, sfxBus, this.noise);
    this.beamLoop.setActive(this.beamActive);

    ctx.addEventListener('statechange', () => {
      if (ctx.state !== 'running') return;
      if (this.beamLoop) this.beamLoop.setActive(this.beamActive);
      const wanted = this.wantedTrack;
      if (wanted) this.startMusic(wanted, 0.4);
    });
  }

  private ensureTrack(track: Track): Promise<AudioBuffer> {
    const cached = this.trackCache.get(track);
    if (cached) return Promise.resolve(cached);
    const inflight = this.trackRendering.get(track);
    if (inflight) return inflight;
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

  private startMusic(track: Track, fadeSeconds: number): void {
    const ctx = this.ctx;
    const musicBus = this.musicBus;
    if (!ctx || !musicBus || ctx.state !== 'running') return;
    if (this.currentMusic?.track === track) return;
    void this.ensureTrack(track).then((buffer) => {
      if (!this.ctx || this.ctx !== ctx || ctx.state !== 'running' || this.wantedTrack !== track || !this.musicBus) return;
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = TRACK_SPECS[track].loop;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(1, ctx.currentTime + Math.max(0.04, fadeSeconds));
      source.connect(gain).connect(this.musicBus);
      const previous = this.currentMusic;
      this.currentMusic = { track, source, gain };
      source.onended = () => {
        if (this.currentMusic?.source === source) {
          this.currentMusic = null;
          if (!TRACK_SPECS[track].loop && this.wantedTrack === track) this.wantedTrack = null;
        }
      };
      source.start();
      if (previous) stopSource(previous, ctx, Math.min(0.5, fadeSeconds));
    }).catch(() => {
      if (this.wantedTrack === track) this.wantedTrack = null;
    });
  }
}
