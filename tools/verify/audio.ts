import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { check, finish, info, section } from './lib.ts';

const MUSIC_SHOT_DIR = 'tools/verify/shots/music';
const PEAK_MINUS_ONE_DB = 10 ** (-1 / 20);
const MIN_TRACK_RMS = 0.018;
const MAX_TRACK_RMS = 0.34;
const MAX_LOOP_DISCONTINUITY = 0.18;
const MAX_STINGER_TAIL_RMS = 0.012;
const TEMPO_TOLERANCE_BPM = 2.5;
const EXPECTED_MUSIC_SAMPLE_RATE = 44100;
const MAX_TRACK_RENDER_MS = 15000;
const MAX_FIRST_SECTION_MS = 3000;
const MAX_TITLE_RENDER_MS = 1500;
const MAX_MUSIC_MEMORY_BYTES = 64 * 1024 * 1024;
const MAX_TRACK_DC = 0.002;
const MIN_SECTION_RMS_DB = -31.5;
const MIN_LOOP_LUFS = -16;
/** Output quieter than this (dBFS RMS over ~46 ms) counts as silence when listening to the running engine. */
const SILENT_DBFS = -50;
/** Loop point: the level may not step by more than this against the same beats a bar away. */
const MAX_LOOP_SEAM_DB = 2;
/** Streamed sections, overlapped with their tails, must reproduce the whole track bar by bar within this level. */
const MAX_SECTION_BAR_DB = 0.5;
/** Battle energy contour (BS.1770 momentary loudness averaged per phrase, LU relative to the first drop). */
const CONTOUR_INTRO_BELOW_DROP = 3;
const CONTOUR_THEME_BELOW_DROP = 1;
const CONTOUR_BUILD_RISE = 2;
const CONTOUR_BREAKDOWN_BELOW_DROP_MIN = 6;
const CONTOUR_BREAKDOWN_BELOW_DROP_MAX = 12;
const CONTOUR_FINAL_BELOW_DROP_MAX = 0.5;
const MAX_LOOP_LUFS = -14;

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required', '--ignore-gpu-blocklist'],
});
let page = await browser.newPage();
const problems: string[] = [];
function attachProblemListeners(): void {
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') problems.push(`[${message.type()}] ${message.text()}`);
  });
  page.on('pageerror', (error) => problems.push(`[pageerror] ${error.message}`));
}

attachProblemListeners();

async function openViewer(): Promise<void> {
  await page.goto('http://127.0.0.1:4427/viewer.html', { waitUntil: 'commit', timeout: 60000 });
  await page.setContent('<!doctype html><html><body></body></html>', { waitUntil: 'domcontentloaded' });
}

await openViewer();

interface BufferReport {
  name: string;
  duration: number;
  expected: number;
  activeDuration: number;
  bpm: number | null;
  detectedBpm: number | null;
  renderMs: number;
  firstSectionMs: number;
  sampleRate: number;
  maxAbsMean: number;
  minSectionRmsDb: number;
  lufs: number;
  truePeak: number;
  maxDiscontinuity: number;
  boundaryDiscontinuity: number;
  tailRms: number;
  loop: boolean;
  peak: number;
  rms: number;
  centroid: number;
  lowShare: number;
  highShare: number;
  finite: boolean;
  silent: boolean;
}

interface WindupReport {
  name: string;
  expected: number;
  actual: number;
}

interface EvalResult {
  tracks: BufferReport[];
  sfx: BufferReport[];
  windups: WindupReport[];
  muteMasterGain: number;
  mutePersisted: string | null;
  muteCallback: boolean;
  muteRestored: boolean;
  preUnlockSafe: boolean;
  preUnlockDeferred: boolean;
  postUnlockSafe: boolean;
  runningAfterUnlock: boolean;
  lockedSafe: boolean;
  adaptiveSwitch: boolean;
  musicPositionWorks: boolean;
  musicMemoryBytes: number;
  contour: { phrases: Record<string, number>; builds: Array<[number, number]> };
  limiter: { step: number; stepLimit: number; peakOverCeiling: number };
  diagnostics: Record<string, number>;
  longestMusicLongTaskMs: number;
  titleAudibleMs: number;
  coldBattleAudibleMs: number;
  titleLevels: number[];
  battleLevels: number[];
  directorCalls: string[];
}

interface AudioModuleShape {
  AudioEngine: new () => {
    onMuteChange: (muted: boolean) => void;
    isMuted(): boolean;
    unlock(): void;
    readonly running: boolean;
    setMuted(muted: boolean): void;
    play(sfx: string, options?: { pan?: number; volume?: number }): void;
    playMusic(track: string, fadeSeconds?: number): void;
    musicPosition(): { readonly bpm: number; readonly beats: number } | null;
    stopMusic(fadeSeconds?: number): void;
    setLayer(name: string, state: { active: boolean; gain?: number; pitch?: number; pan?: number }): void;
    suspendForHidden(hidden: boolean): void;
    dispose(): void;
  };
  SFX_NAMES: readonly string[];
  SFX_SPECS: Record<string, { duration: number }>;
  renderSfxBuffer(name: string): Promise<AudioBuffer>;
}

interface DirectorModuleShape {
  AudioDirector: new (engine: {
    play(name: string, options?: { pan?: number; volume?: number }): void;
    playMusic(name: string, fadeSeconds?: number): void;
    stopMusic(fadeSeconds?: number): void;
    setLayer(name: string, state: { active: boolean; gain?: number; pitch?: number; pan?: number }): void;
  }) => {
    handleEvents(world: unknown, localSeat: number): void;
    update(world: unknown, localSeat: number, dtSeconds: number): void;
  };
}

interface MusicModuleShape {
  TRACK_SPECS: Record<string, { bpm: number; loop: boolean; bars: number; family: string }>;
  SECTION_BARS: number;
  LIMITER_CEILING: number;
  LIMITER_LOOKAHEAD_SECONDS: number;
  renderTrack(name: string): Promise<{ readonly sampleRate: number; readonly left: Float32Array; readonly right: Float32Array }>;
  renderTrackSection(name: string, section?: number, bars?: number): Promise<{ readonly sampleRate: number; readonly left: Float32Array; readonly right: Float32Array }>;
  renderMusicDiagnostic(kind: 'leadAlias' | 'pluckFilter' | 'sidechain' | 'reverb' | 'reverbDc'): Promise<{ readonly sampleRate: number; readonly left: Float32Array; readonly right: Float32Array }>;
  limitStereo(left: Float32Array, right: Float32Array, sampleRate: number): Float32Array;
  trackPhrase(name: string, bar: number): string;
  getTrackDuration(spec: unknown): number;
}

interface SynthModuleShape {
  bossWindupSfx(frame: number, attack: number): string;
  bossWindupDuration(frame: number, attack: number): number;
}

interface SimModuleShape {
  Frame: { Vanguard: number; Gale: number; Juggernaut: number };
  Attack: { None: number; Salvo: number; Siege: number; Ultima: number };
  AttackPhase: { Idle: number; Release: number };
  Ev: { Fire: number; Windup: number; Release: number; StormStart: number; RoundEnd: number; Banner: number; MorphDone: number };
  Banner: { Fight: number };
  FireSlot: { Primary: number; Alt: number };
  Form: { Normal: number; Boss: number };
  Phase: { Battle: number };
  W: { Phase: number; SafeR: number };
}

const runChecks = () => page.evaluate(async () => {
  const load = async <T>(path: string): Promise<T> => import(/* @vite-ignore */ path) as Promise<T>;
  const audio = await load<AudioModuleShape>('/src/audio/audio.ts');
  const directorModule = await load<DirectorModuleShape>('/src/audio/director.ts');
  const music = await load<MusicModuleShape>('/src/audio/music.ts');
  const synth = await load<SynthModuleShape>('/src/audio/synth.ts');
  const sim = await load<SimModuleShape>('/src/sim/index.ts');
  // Runs in the page: constants used here must be declared here.
  const DC_WINDOW_SECONDS = 4;
  const toBuffer = (rendered: { readonly sampleRate: number; readonly left: Float32Array; readonly right: Float32Array }): AudioBuffer => {
    const ctx = new OfflineAudioContext(2, 1, rendered.sampleRate);
    const buffer = ctx.createBuffer(2, rendered.left.length, rendered.sampleRate);
    buffer.copyToChannel(new Float32Array(rendered.left), 0);
    buffer.copyToChannel(new Float32Array(rendered.right), 1);
    return buffer;
  };

  /**
   * ITU-R BS.1770-4 loudness: K-weighting (high shelf + RLB high-pass, coefficients derived for the buffer's rate as in
   * libebur128), 400 ms blocks every 100 ms. `momentary` is each block's loudness; `integrated` applies the -70 LUFS
   * absolute and -10 LU relative gates.
   */
  const loudness = (buffer: AudioBuffer): { integrated: number; momentary: Float64Array; hopSeconds: number } => {
    const rate = buffer.sampleRate;
    const biquad = (input: Float32Array, b: readonly number[], a: readonly number[]): Float64Array => {
      const out = new Float64Array(input.length);
      let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      for (let i = 0; i < input.length; i++) {
        const x = input[i];
        const y = b[0] * x + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2;
        x2 = x1; x1 = x; y2 = y1; y1 = y;
        out[i] = y;
      }
      return out;
    };
    const shelfK = Math.tan((Math.PI * 1681.974450955533) / rate);
    const shelfQ = 0.7071752369554196;
    const vh = 10 ** (3.999843853973347 / 20);
    const vb = vh ** 0.4996667741545416;
    const shelfA0 = 1 + shelfK / shelfQ + shelfK * shelfK;
    const shelfB = [(vh + (vb * shelfK) / shelfQ + shelfK * shelfK) / shelfA0, (2 * (shelfK * shelfK - vh)) / shelfA0, (vh - (vb * shelfK) / shelfQ + shelfK * shelfK) / shelfA0];
    const shelfA = [1, (2 * (shelfK * shelfK - 1)) / shelfA0, (1 - shelfK / shelfQ + shelfK * shelfK) / shelfA0];
    const hpK = Math.tan((Math.PI * 38.13547087602444) / rate);
    const hpQ = 0.5003270373238773;
    const hpA0 = 1 + hpK / hpQ + hpK * hpK;
    const hpA = [1, (2 * (hpK * hpK - 1)) / hpA0, (1 - hpK / hpQ + hpK * hpK) / hpA0];
    const weighted: Float64Array[] = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const shelved = biquad(buffer.getChannelData(c), shelfB, shelfA);
      weighted.push(biquad(Float32Array.from(shelved), [1, -2, 1], hpA));
    }
    const block = Math.round(rate * 0.4);
    const hop = Math.round(rate * 0.1);
    const squares: number[] = [];
    for (let start = 0; start + block <= buffer.length; start += hop) {
      let sum = 0;
      for (const channel of weighted) for (let i = start; i < start + block; i++) sum += channel[i] * channel[i];
      squares.push(sum / block);
    }
    const toLufs = (meanSquare: number): number => -0.691 + 10 * Math.log10(Math.max(1e-20, meanSquare));
    const momentary = Float64Array.from(squares, toLufs);
    const aboveAbsolute = squares.filter((value) => toLufs(value) > -70);
    const mean = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
    const relativeGate = toLufs(mean(aboveAbsolute)) - 10;
    const gated = aboveAbsolute.filter((value) => toLufs(value) > relativeGate);
    return { integrated: gated.length > 0 ? toLufs(mean(gated)) : -Infinity, momentary, hopSeconds: hop / rate };
  };
  /** True peak (linear): the largest sample after 4x oversampling with a Hann-windowed sinc (16 taps per phase). */
  const truePeakOf = (buffer: AudioBuffer): number => {
    const phases = 4;
    const half = 8;
    const kernel: number[][] = [];
    for (let p = 0; p < phases; p++) {
      const taps: number[] = [];
      for (let k = -half + 1; k <= half; k++) {
        const t = k - p / phases;
        const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
        taps.push(sinc * (0.5 + 0.5 * Math.cos((Math.PI * t) / half)));
      }
      kernel.push(taps);
    }
    let peak = 0;
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const data = buffer.getChannelData(c);
      for (let i = half; i < data.length - half; i++) {
        for (let p = 0; p < phases; p++) {
          const taps = kernel[p];
          let value = 0;
          for (let k = 0; k < taps.length; k++) value += taps[k] * data[i - half + 1 + k];
          peak = Math.max(peak, Math.abs(value));
        }
      }
    }
    return peak;
  };
  const detectTempo = (buffer: AudioBuffer, expectedBpm: number): number => {
    const hop = 512;
    const channel = buffer.getChannelData(0);
    const envelope: number[] = [];
    let previous = 0;
    for (let offset = 0; offset + hop < channel.length; offset += hop) {
      let energy = 0;
      for (let i = 0; i < hop; i++) {
        const value = channel[offset + i];
        energy += value * value;
      }
      const rms = Math.sqrt(energy / hop);
      envelope.push(Math.max(0, rms - previous));
      previous = rms;
    }
    const lag = Math.max(1, Math.round((60 / expectedBpm) * buffer.sampleRate / hop));
    let score = 0;
    for (let i = lag; i < envelope.length; i++) score += envelope[i] * envelope[i - lag];
    return score > 0 ? 60 / (lag * hop / buffer.sampleRate) : expectedBpm;
  };

  const tailRms = (buffer: AudioBuffer, seconds: number): number => {
    const frames = Math.max(1, Math.min(buffer.length, Math.round(buffer.sampleRate * seconds)));
    let energy = 0;
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      const data = buffer.getChannelData(channel);
      for (let i = buffer.length - frames; i < buffer.length; i++) energy += data[i] * data[i];
    }
    return Math.sqrt(energy / (frames * buffer.numberOfChannels));
  };

  const discontinuity = (buffer: AudioBuffer): { max: number; boundary: number } => {
    let max = 0;
    let boundary = 0;
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      const data = buffer.getChannelData(channel);
      boundary = Math.max(boundary, Math.abs(data[0] - data[data.length - 1]));
      const stride = Math.max(1, Math.floor(data.length / 200000));
      for (let i = stride; i < data.length; i += stride) max = Math.max(max, Math.abs(data[i] - data[i - stride]));
    }
    return { max, boundary };
  };

  const analyze = (name: string, buffer: AudioBuffer, expected: number, spec?: { bpm: number; loop: boolean }): BufferReport => {
    let peak = 0;
    let energy = 0;
    let finite = true;
    let first = -1;
    let last = -1;
    const threshold = 1e-4;
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < buffer.numberOfChannels; i++) {
      const data = buffer.getChannelData(i);
      for (let j = 0; j < data.length; j++) {
        const value = data[j];
        if (!Number.isFinite(value)) finite = false;
        const abs = Math.abs(value);
        if (abs > peak) peak = abs;
        if (abs > threshold) {
          if (first < 0 || j < first) first = j;
          if (j > last) last = j;
        }
        energy += value * value;
      }
    }

    const spectralSize = Math.min(2048, channel.length);
    const start = Math.max(0, Math.min(channel.length - spectralSize, first > 0 ? first : 0));
    let totalMag = 0;
    let centroidWeighted = 0;
    let low = 0;
    let high = 0;
    for (let k = 1; k < spectralSize / 2; k++) {
      let real = 0;
      let imag = 0;
      for (let n = 0; n < spectralSize; n++) {
        const angle = (2 * Math.PI * k * n) / spectralSize;
        const sample = channel[start + n];
        real += sample * Math.cos(angle);
        imag -= sample * Math.sin(angle);
      }
      const mag = Math.hypot(real, imag);
      const hz = (k * buffer.sampleRate) / spectralSize;
      totalMag += mag;
      centroidWeighted += mag * hz;
      if (hz <= 400) low += mag;
      if (hz >= 2000) high += mag;
    }

    const activeDuration = first >= 0 && last >= first ? (last - first) / buffer.sampleRate : 0;
    const jumps = discontinuity(buffer);
    const oneSecond = Math.max(1, buffer.sampleRate);
    let maxAbsMean = 0;
    let minSectionRms = Infinity;
    for (let offset = 0; offset < buffer.length; offset += oneSecond) {
      const end = Math.min(buffer.length, offset + oneSecond);
      let sectionEnergy = 0;
      for (let channelIndex = 0; channelIndex < buffer.numberOfChannels; channelIndex++) {
        const data = buffer.getChannelData(channelIndex);
        for (let i = offset; i < end; i++) sectionEnergy += data[i] * data[i];
      }
      if (end - offset >= oneSecond * 0.5) minSectionRms = Math.min(minSectionRms, Math.sqrt(sectionEnergy / Math.max(1, (end - offset) * buffer.numberOfChannels)));
    }
    const lufs = loudness(buffer).integrated;
    // DC: the mean over phrase-length windows. (Over one second a loud mix's sidechained sub-bass alone moves the mean by
    // about 0.002; a real offset stays for seconds, like the +0.17 this check was written for.)
    const dcWindow = Math.max(1, Math.round(buffer.sampleRate * DC_WINDOW_SECONDS));
    for (let offset = 0; offset < buffer.length; offset += dcWindow) {
      const end = Math.min(buffer.length, offset + dcWindow);
      let sum = 0;
      for (let channelIndex = 0; channelIndex < buffer.numberOfChannels; channelIndex++) {
        const data = buffer.getChannelData(channelIndex);
        for (let i = offset; i < end; i++) sum += data[i];
      }
      maxAbsMean = Math.max(maxAbsMean, Math.abs(sum / Math.max(1, (end - offset) * buffer.numberOfChannels)));
    }
    return {
      name,
      duration: buffer.duration,
      expected,
      activeDuration,
      bpm: spec?.bpm ?? null,
      detectedBpm: spec === undefined ? null : detectTempo(buffer, spec.bpm),
      renderMs: 0,
      firstSectionMs: 0,
      sampleRate: buffer.sampleRate,
      maxAbsMean,
      minSectionRmsDb: 20 * Math.log10(Math.max(1e-8, minSectionRms)),
      lufs,
      truePeak: truePeakOf(buffer),
      maxDiscontinuity: jumps.max,
      boundaryDiscontinuity: jumps.boundary,
      tailRms: tailRms(buffer, 0.25),
      loop: spec?.loop ?? false,
      peak,
      rms: Math.sqrt(energy / Math.max(1, buffer.length * buffer.numberOfChannels)),
      centroid: totalMag > 0 ? centroidWeighted / totalMag : 0,
      lowShare: totalMag > 0 ? low / totalMag : 0,
      highShare: totalMag > 0 ? high / totalMag : 0,
      finite,
      silent: peak < threshold,
    };
  };

  const tracks: BufferReport[] = [];
  const trackBuffers = new Map<string, AudioBuffer>();
  let musicMemoryBytes = 0;
  for (const [name, spec] of Object.entries(music.TRACK_SPECS)) {
    const sectionStarted = performance.now();
    const sectionBuffer = toBuffer(await music.renderTrackSection(name));
    const firstSectionMs = performance.now() - sectionStarted;
    const started = performance.now();
    const buffer = toBuffer(await music.renderTrack(name));
    const report = analyze(name, buffer, music.getTrackDuration(spec), spec);
    report.renderMs = performance.now() - started;
    report.firstSectionMs = firstSectionMs;
    tracks.push(report);
    trackBuffers.set(name, buffer);
    const memoryBuffer = spec.family === 'match' ? sectionBuffer : buffer;
    musicMemoryBytes += memoryBuffer.length * memoryBuffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT;
  }

  const windowRms = (buffer: AudioBuffer, startSeconds: number, seconds: number): number => {
    const start = Math.max(0, Math.floor(startSeconds * buffer.sampleRate));
    const end = Math.min(buffer.length, start + Math.max(1, Math.floor(seconds * buffer.sampleRate)));
    let energy = 0;
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      const data = buffer.getChannelData(channel);
      for (let i = start; i < end; i++) energy += data[i] * data[i];
    }
    return Math.sqrt(energy / Math.max(1, (end - start) * buffer.numberOfChannels));
  };
  const centroidAt = (buffer: AudioBuffer, startSeconds: number, size: number): number => {
    const channel = buffer.getChannelData(0);
    const start = Math.max(0, Math.min(channel.length - size, Math.floor(startSeconds * buffer.sampleRate)));
    let total = 0;
    let weighted = 0;
    for (let k = 1; k < size / 2; k++) {
      let real = 0;
      let imag = 0;
      for (let n = 0; n < size; n++) {
        const sample = channel[start + n] * (0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (size - 1)));
        const angle = (2 * Math.PI * k * n) / size;
        real += sample * Math.cos(angle);
        imag -= sample * Math.sin(angle);
      }
      const mag = Math.hypot(real, imag);
      const hz = (k * buffer.sampleRate) / size;
      total += mag;
      weighted += mag * hz;
    }
    return total > 0 ? weighted / total : 0;
  };
  const leadAliasDb = (buffer: AudioBuffer): number => {
    const size = 8192;
    const f0 = 440 * 2 ** ((96 - 69) / 12);
    const channel = buffer.getChannelData(0);
    const start = Math.floor(0.18 * buffer.sampleRate);
    let harmonic = 0;
    let inharmonic = 0;
    for (let k = 1; k < size / 2; k++) {
      let real = 0;
      let imag = 0;
      for (let n = 0; n < size; n++) {
        const sample = channel[start + n] * (0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (size - 1)));
        const angle = (2 * Math.PI * k * n) / size;
        real += sample * Math.cos(angle);
        imag -= sample * Math.sin(angle);
      }
      const power = real * real + imag * imag;
      const hz = (k * buffer.sampleRate) / size;
      const nearest = Math.max(1, Math.round(hz / f0));
      if (Math.abs(hz - nearest * f0) <= buffer.sampleRate / size * 2.5) harmonic += power;
      else if (hz > f0 * 1.5) inharmonic += power;
    }
    return 10 * Math.log10(Math.max(1e-20, inharmonic) / Math.max(1e-20, harmonic));
  };
  const reverbStats = (buffer: AudioBuffer): { readonly rt60: number; readonly density: number } => {
    const frame = Math.max(1, Math.floor(buffer.sampleRate * 0.005));
    const channel = buffer.getChannelData(0);
    const windows: number[] = [];
    const peaks: number[] = [];
    for (let offset = 0; offset + frame < channel.length; offset += frame) {
      let energy = 0;
      let peak = 0;
      for (let i = offset; i < offset + frame; i++) {
        energy += channel[i] * channel[i];
        peak = Math.max(peak, Math.abs(channel[i]));
      }
      windows.push(Math.sqrt(energy / frame));
      peaks.push(peak);
    }
    const max = Math.max(...windows);
    const threshold = max * 0.001;
    const last = windows.findLastIndex((value) => value > threshold);
    const after80 = Math.floor(0.08 / 0.005);
    let ratio = 0;
    let count = 0;
    for (let i = after80; i < Math.min(windows.length, after80 + 80); i++) {
      if (windows[i] <= 1e-7) continue;
      ratio += peaks[i] / windows[i];
      count++;
    }
    return { rt60: Math.max(0, last * 0.005), density: count > 0 ? ratio / count : Infinity };
  };
  /** Every section rendered alone, overlapped with its tail like the runtime schedules them: worst per-bar level difference from the whole track. */
  const sectionMatchDb = async (): Promise<number> => {
    let worst = 0;
    for (const [name, spec] of Object.entries(music.TRACK_SPECS)) {
      const whole = trackBuffers.get(name);
      if (!spec.loop || whole === undefined) continue;
      const barFrames = Math.round((whole.sampleRate * 4 * 60) / spec.bpm);
      const sum = [new Float32Array(whole.length), new Float32Array(whole.length)];
      for (let section = 0; section * music.SECTION_BARS < spec.bars; section++) {
        const part = await music.renderTrackSection(name, section, music.SECTION_BARS);
        const start = section * music.SECTION_BARS * barFrames;
        for (let i = 0; i < part.left.length; i++) {
          const k = (start + i) % whole.length;
          sum[0][k] += part.left[i];
          sum[1][k] += part.right[i];
        }
      }
      for (let bar = 0; bar < spec.bars; bar++) {
        let a = 0;
        let b = 0;
        for (let c = 0; c < 2; c++) {
          const data = whole.getChannelData(c);
          for (let i = bar * barFrames; i < Math.min(whole.length, (bar + 1) * barFrames); i++) {
            a += data[i] * data[i];
            b += sum[c][i] * sum[c][i];
          }
        }
        worst = Math.max(worst, Math.abs(10 * Math.log10(Math.max(1e-20, b) / Math.max(1e-20, a))));
      }
    }
    return worst;
  };
  /** Battle's loudness per phrase (energy mean of the momentary loudness), and each build's first and last bar. */
  const battleContour = (): { phrases: Record<string, number>; builds: Array<[number, number]> } => {
    const whole = trackBuffers.get('battle')!;
    const spec = music.TRACK_SPECS.battle;
    const { momentary, hopSeconds } = loudness(whole);
    const barSeconds = (4 * 60) / spec.bpm;
    const energyByPhrase = new Map<string, number[]>();
    const energyByBar: number[][] = Array.from({ length: spec.bars }, () => []);
    momentary.forEach((value, index) => {
      // A block describes the 400 ms that END at its hop: attribute it to the bar its middle falls in.
      const bar = Math.floor((index * hopSeconds + 0.2) / barSeconds);
      if (bar >= spec.bars) return;
      const energy = 10 ** (value / 10);
      const phrase = music.trackPhrase('battle', bar);
      energyByPhrase.set(phrase, [...(energyByPhrase.get(phrase) ?? []), energy]);
      energyByBar[bar].push(energy);
    });
    const level = (values: number[]): number => 10 * Math.log10(values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length));
    const phrases: Record<string, number> = {};
    for (const [phrase, values] of energyByPhrase) phrases[phrase] = level(values);
    const builds: Array<[number, number]> = [];
    for (let bar = 0; bar < spec.bars; bar++) {
      if (music.trackPhrase('battle', bar) !== 'build' || music.trackPhrase('battle', bar - 1) === 'build') continue;
      let last = bar;
      while (last + 1 < spec.bars && music.trackPhrase('battle', last + 1) === 'build') last++;
      builds.push([level(energyByBar[bar]), level(energyByBar[last])]);
    }
    return { phrases, builds };
  };
  /** A 1 kHz burst driven 6 dB over the ceiling: the limiter's gain may move by at most 1/lookahead per sample. */
  const limiterTest = (): { step: number; stepLimit: number; peakOverCeiling: number } => {
    const rate = 44100;
    const left = new Float32Array(Math.round(rate * 1.1));
    const right = new Float32Array(left.length);
    for (let i = Math.round(rate * 0.1); i < Math.round(rate * 0.6); i++) {
      left[i] = right[i] = 2 * music.LIMITER_CEILING * Math.sin((2 * Math.PI * 1000 * i) / rate);
    }
    const gain = music.limitStereo(left, right, rate);
    let step = 0;
    let peak = 0;
    for (let i = 1; i < gain.length; i++) step = Math.max(step, Math.abs(gain[i] - gain[i - 1]));
    for (let i = 0; i < left.length; i++) peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
    return { step, stepLimit: 1 / Math.max(1, Math.round(music.LIMITER_LOOKAHEAD_SECONDS * rate)), peakOverCeiling: peak / music.LIMITER_CEILING };
  };
  /**
   * A fade or dip at the loop point: the last 400 ms against the same beats one bar earlier, and the first 400 ms against
   * the same beats one bar later (comparing equal rhythmic positions, so a downbeat kick is never measured against a tail).
   */
  const loopSeamDb = (): number => {
    let worst = 0;
    for (const track of tracks.filter((entry) => entry.loop)) {
      const buffer = trackBuffers.get(track.name);
      const spec = music.TRACK_SPECS[track.name];
      if (buffer === undefined) continue;
      const bar = (4 * 60) / spec.bpm;
      const db = (start: number) => 20 * Math.log10(Math.max(1e-8, windowRms(buffer, start, 0.4)));
      worst = Math.max(worst, Math.abs(db(buffer.duration - 0.4) - db(buffer.duration - bar - 0.4)), Math.abs(db(0) - db(bar)));
    }
    return worst;
  };
  const aliasBuffer = toBuffer(await music.renderMusicDiagnostic('leadAlias'));
  const pluckBuffer = toBuffer(await music.renderMusicDiagnostic('pluckFilter'));
  const sidechainBuffer = toBuffer(await music.renderMusicDiagnostic('sidechain'));
  const reverbBuffer = toBuffer(await music.renderMusicDiagnostic('reverb'));
  const reverbDcBuffer = toBuffer(await music.renderMusicDiagnostic('reverbDc'));
  const beat = 60 / music.TRACK_SPECS.battle.bpm;
  let sidechainDb = 0;
  for (let kick = 1; kick < 7; kick++) {
    const after = windowRms(sidechainBuffer, kick * beat + 0.01, 0.06);
    const before = windowRms(sidechainBuffer, (kick + 1) * beat - 0.08, 0.06);
    sidechainDb += 20 * Math.log10(Math.max(1e-8, after) / Math.max(1e-8, before));
  }
  sidechainDb /= 6;
  const reverb = reverbStats(reverbBuffer);
  const diagnostics = {
    aliasDb: leadAliasDb(aliasBuffer),
    pluckCentroidRatio: centroidAt(pluckBuffer, 0.1, 2048) / Math.max(1, centroidAt(pluckBuffer, 0.01, 2048)),
    sidechainDb,
    reverbRt60: reverb.rt60,
    reverbDensity: reverb.density,
    reverbDcMean: Math.abs(Array.from(reverbDcBuffer.getChannelData(0).subarray(Math.floor(reverbDcBuffer.sampleRate * 2))).reduce((sum, value) => sum + value, 0) / Math.max(1, reverbDcBuffer.length - Math.floor(reverbDcBuffer.sampleRate * 2))),
    loopSeamDb: loopSeamDb(),
    sectionMatchDb: await sectionMatchDb(),
  };
  const contour = battleContour();
  const limiter = limiterTest();

  const sfx: BufferReport[] = [];
  for (const name of audio.SFX_NAMES) {
    const buffer = await audio.renderSfxBuffer(name);
    sfx.push(analyze(name, buffer, audio.SFX_SPECS[name].duration));
  }

  const windups: WindupReport[] = [];
  for (const frame of [sim.Frame.Vanguard, sim.Frame.Gale, sim.Frame.Juggernaut]) {
    for (const attack of [sim.Attack.Salvo, sim.Attack.Siege, sim.Attack.Ultima]) {
      const sfxName = synth.bossWindupSfx(frame, attack);
      windups.push({
        name: sfxName,
        expected: synth.bossWindupDuration(frame, attack),
        actual: sfx.find((entry) => entry.name === sfxName)?.activeDuration ?? 0,
      });
    }
  }

  localStorage.removeItem('bossform.muted');
  const cold = new audio.AudioEngine();
  let preUnlockSafe = true;
  try {
    cold.play('shotVanguard');
    cold.playMusic('battle');
    cold.stopMusic();
    cold.setLayer('bossDrone', { active: true, gain: 0.1, pitch: 1 });
    cold.setLayer('bossDrone', { active: false });
  } catch {
    preUnlockSafe = false;
  }
  cold.playMusic('battle');
  const preUnlockDeferred = !cold.running;
  cold.unlock();
  await new Promise((resolve) => setTimeout(resolve, 80));
  const runningAfterUnlock = cold.running;
  let postUnlockSafe = true;
  try {
    for (const name of audio.SFX_NAMES) cold.play(name, { pan: 0.2, volume: 0.75 });
    cold.playMusic('battle', 0.1);
    cold.playMusic('bossForm', 0.1);
    cold.setLayer('bossDrone', { active: true, gain: 0.15, pitch: 0.9 });
    cold.setLayer('ultimaBarrage', { active: true, gain: 0.16, pitch: 1.05, pan: -0.2 });
    cold.setLayer('ultimaBarrage', { active: false });
    cold.stopMusic(0.05);
    cold.suspendForHidden(true);
    cold.suspendForHidden(false);
  } catch {
    postUnlockSafe = false;
  }

  const waitForTrack = async (engine: unknown, track: string): Promise<boolean> => {
    for (let i = 0; i < 80; i++) {
      const current = (engine as { currentTrack?: { track: string } | null }).currentTrack;
      if (current?.track === track) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  };
  const adaptive = new audio.AudioEngine();
  adaptive.unlock();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const adaptiveCtx = (adaptive as { ctx?: AudioContext | null }).ctx;
  const adaptiveCache = (adaptive as { trackCache?: Map<string, AudioBuffer> }).trackCache;
  if (adaptiveCtx !== null && adaptiveCtx !== undefined && adaptiveCache !== undefined) {
    for (const name of ['battle', 'bossForm', 'sudden']) adaptiveCache.set(name, adaptiveCtx.createBuffer(2, adaptiveCtx.sampleRate * 4, adaptiveCtx.sampleRate));
  }
  adaptive.playMusic('battle', 0.05);
  const battleStarted = await waitForTrack(adaptive, 'battle');
  await new Promise((resolve) => setTimeout(resolve, 260));
  const beforeSwitch = adaptive.musicPosition();
  adaptive.playMusic('bossForm', 0.05);
  const bossStarted = await waitForTrack(adaptive, 'bossForm');
  const afterSwitch = adaptive.musicPosition();
  const switchedTrack = (adaptive as { currentTrack?: { startBeat: number; track: string } | null }).currentTrack;
  const adaptiveSwitch = battleStarted && bossStarted && beforeSwitch !== null && afterSwitch !== null
    && switchedTrack?.track === 'bossForm'
    && Math.abs(switchedTrack.startBeat % 4) < 0.001
    && afterSwitch.beats > beforeSwitch.beats
    && afterSwitch.bpm === beforeSwitch.bpm;
  const musicPositionWorks = afterSwitch !== null && afterSwitch.beats > 0 && afterSwitch.bpm === music.TRACK_SPECS.battle.bpm;
  adaptive.dispose();

  let longestMusicLongTaskMs = 0;
  const observedDurations: number[] = [];
  const observer = 'PerformanceObserver' in window ? new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) observedDurations.push(entry.duration);
  }) : null;
  observer?.observe({ entryTypes: ['longtask'] });
  const titleLatencyEngine = new audio.AudioEngine();
  titleLatencyEngine.unlock();
  await new Promise((resolve) => setTimeout(resolve, 40));
  let started = performance.now();
  titleLatencyEngine.playMusic('title', 0.02);
  await waitForTrack(titleLatencyEngine, 'title');
  const titleAudibleMs = performance.now() - started;
  titleLatencyEngine.dispose();
  const battleLatencyEngine = new audio.AudioEngine();
  battleLatencyEngine.unlock();
  await new Promise((resolve) => setTimeout(resolve, 40));
  started = performance.now();
  battleLatencyEngine.playMusic('battle', 0.02);
  await waitForTrack(battleLatencyEngine, 'battle');
  const coldBattleAudibleMs = performance.now() - started;
  battleLatencyEngine.dispose();
  await new Promise((resolve) => setTimeout(resolve, 100));
  observer?.disconnect();
  longestMusicLongTaskMs = observedDurations.length > 0 ? Math.max(...observedDurations) : 0;

  // Listen to what actually comes out: a test-only tap on every connection to the destination feeds an analyser.
  const taps = new WeakMap<BaseAudioContext, AnalyserNode>();
  const connect = AudioNode.prototype.connect as (this: AudioNode, destination: AudioNode, ...rest: number[]) => AudioNode;
  (AudioNode.prototype as unknown as { connect: typeof connect }).connect = function (this: AudioNode, destination: AudioNode, ...rest: number[]): AudioNode {
    if (destination instanceof AudioDestinationNode) {
      let tap = taps.get(this.context);
      if (tap === undefined) {
        tap = this.context.createAnalyser();
        tap.fftSize = 2048;
        taps.set(this.context, tap);
      }
      connect.call(this, tap);
    }
    return connect.call(this, destination, ...rest);
  };
  /** Output level (dBFS RMS) every 250 ms while one track plays from a cold start. */
  const listen = async (track: string, seconds: number): Promise<number[]> => {
    const engine = new audio.AudioEngine();
    engine.setMuted(false);
    engine.unlock();
    engine.playMusic(track, 0.02);
    await waitForTrack(engine, track);
    const context = (engine as unknown as { ctx: AudioContext }).ctx;
    const samples = new Float32Array(2048);
    const levels: number[] = [];
    const end = performance.now() + seconds * 1000;
    while (performance.now() < end) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const tap = taps.get(context);
      if (tap === undefined) { levels.push(-Infinity); continue; }
      tap.getFloatTimeDomainData(samples);
      let energy = 0;
      for (const value of samples) energy += value * value;
      levels.push(10 * Math.log10(Math.max(1e-12, energy / samples.length)));
    }
    engine.dispose();
    return levels;
  };
  const titleLevels = await listen('title', 31);
  const battleLevels = await listen('battle', 16);

  const engine = new audio.AudioEngine();
  let muteCallback = false;
  engine.onMuteChange = (muted: boolean) => {
    if (muted) muteCallback = true;
  };
  engine.unlock();
  await new Promise((resolve) => setTimeout(resolve, 50));
  engine.setMuted(true);
  const muteMasterGain = Number((engine as { masterGain?: GainNode | null }).masterGain?.gain.value ?? Number.NaN);
  const mutePersisted = localStorage.getItem('bossform.muted');
  const mirror = new audio.AudioEngine();
  const muteRestored = mirror.isMuted() === true;
  mirror.dispose();
  engine.setMuted(false);

  const directorCalls: string[] = [];
  const fakeEngine = {
    play: (name: string) => directorCalls.push(`play:${name}`),
    playMusic: (name: string) => directorCalls.push(`music:${name}`),
    stopMusic: () => directorCalls.push('music:stop'),
    setLayer: (name: string, state: { active: boolean }) => directorCalls.push(`layer:${name}:${state.active ? 'on' : 'off'}`),
  };
  const director = new directorModule.AudioDirector(fakeEngine);
  const world = {
    arenaR: 900 * 65536,
    seats: 2,
    m: {
      world: new Int32Array(32),
      plX: new Int32Array([0, 120 * 65536]),
      plY: new Int32Array([0, 0]),
      plFrame: new Uint8Array([sim.Frame.Vanguard, sim.Frame.Juggernaut]),
      plTeam: new Uint8Array([0, 1]),
      plAlive: new Uint8Array([1, 1]),
      plForm: new Uint8Array([sim.Form.Normal, sim.Form.Boss]),
      plGauge: new Int32Array([0, 60000]),
      plAtk: new Uint8Array([sim.Attack.None, sim.Attack.Ultima]),
      plAtkPhase: new Uint8Array([sim.AttackPhase.Idle, sim.AttackPhase.Release]),
    },
    events: {
      count: 6,
      type: new Uint8Array([sim.Ev.Fire, sim.Ev.Windup, sim.Ev.Release, sim.Ev.StormStart, sim.Ev.Banner, sim.Ev.MorphDone]),
      x: new Int32Array([0, 120 * 65536, 120 * 65536, 0, 0, 120 * 65536]),
      y: new Int32Array(6),
      a: new Int32Array([0, 1, 1, 0, sim.Banner.Fight, 1]),
      b: new Int32Array([sim.Frame.Vanguard, sim.Attack.Ultima, sim.Attack.Siege, 0, 0, 0]),
      c: new Int32Array([sim.FireSlot.Primary, 0, 0, 0, 0, 0]),
    },
  };
  world.m.world[sim.W.Phase] = sim.Phase.Battle;
  world.m.world[sim.W.SafeR] = world.arenaR;
  director.handleEvents(world, 0);
  director.update(world, 0, 1 / 60);
  director.update(world, 1, 1 / 60);

  const lockedEngine = new audio.AudioEngine();
  const lockedDirector = new directorModule.AudioDirector(lockedEngine);
  let lockedSafe = true;
  try {
    lockedDirector.handleEvents(world, 1);
    lockedDirector.update(world, 1, 1 / 60);
  } catch {
    lockedSafe = false;
  }
  lockedEngine.dispose();

  const endWorld = {
    ...world,
    events: {
      count: 1,
      type: new Uint8Array([sim.Ev.RoundEnd]),
      x: new Int32Array(1),
      y: new Int32Array(1),
      a: new Int32Array([0]),
      b: new Int32Array([1]),
      c: new Int32Array(1),
    },
  };
  director.handleEvents(endWorld, 0);

  cold.dispose();
  engine.dispose();
  return {
    tracks,
    sfx,
    windups,
    muteMasterGain,
    mutePersisted,
    muteCallback,
    muteRestored,
    preUnlockSafe,
    preUnlockDeferred,
    postUnlockSafe,
    runningAfterUnlock,
    lockedSafe,
    adaptiveSwitch,
    musicPositionWorks,
    musicMemoryBytes,
    diagnostics,
    contour,
    limiter,
    longestMusicLongTaskMs,
    titleAudibleMs,
    coldBattleAudibleMs,
    titleLevels,
    battleLevels,
    directorCalls,
  } satisfies EvalResult;
});

let result: EvalResult;
try {
  result = await runChecks();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.includes('Execution context was destroyed')) throw error;
  await page.close().catch(() => {});
  page = await browser.newPage();
  attachProblemListeners();
  await openViewer();
  result = await runChecks();
}

mkdirSync(MUSIC_SHOT_DIR, { recursive: true });
await page.close().catch(() => {});
for (const track of result.tracks) {
  const exportPage = await browser.newPage();
  await exportPage.goto('http://127.0.0.1:4427/viewer.html', { waitUntil: 'commit', timeout: 60000 });
  await exportPage.setContent('<!doctype html><html><body></body></html>', { waitUntil: 'domcontentloaded' });
  const downloadPromise = exportPage.waitForEvent('download', { timeout: 180000 });
  await exportPage.evaluate(async (trackName) => {
    const path = '/src/audio/music.ts';
    const music = await import(/* @vite-ignore */ path) as MusicModuleShape;
    const raw = await music.renderTrack(trackName);
    const buffer = new OfflineAudioContext(2, 1, raw.sampleRate).createBuffer(2, raw.left.length, raw.sampleRate);
    buffer.copyToChannel(new Float32Array(raw.left), 0);
    buffer.copyToChannel(new Float32Array(raw.right), 1);
    const channels = 2;
    const dataBytes = buffer.length * channels * 2;
    const bytes = new Uint8Array(44 + dataBytes);
    const view = new DataView(bytes.buffer);
    const writeString = (offset: number, value: string): void => {
      for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i);
    };
    writeString(0, 'RIFF');
    view.setUint32(4, 36 + dataBytes, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, channels, true);
    view.setUint32(24, buffer.sampleRate, true);
    view.setUint32(28, buffer.sampleRate * channels * 2, true);
    view.setUint16(32, channels * 2, true);
    view.setUint16(34, 16, true);
    writeString(36, 'data');
    view.setUint32(40, dataBytes, true);
    const left = buffer.getChannelData(0);
    const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
    let offset = 44;
    for (let i = 0; i < buffer.length; i++) {
      const l = Math.max(-1, Math.min(1, left[i]));
      const r = Math.max(-1, Math.min(1, right[i]));
      view.setInt16(offset, l < 0 ? l * 0x8000 : l * 0x7fff, true);
      view.setInt16(offset + 2, r < 0 ? r * 0x8000 : r * 0x7fff, true);
      offset += 4;
    }
    const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${trackName}.wav`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, track.name);
  const download = await downloadPromise;
  await download.saveAs(`${MUSIC_SHOT_DIR}/${track.name}.wav`);
  await exportPage.close();
}

section('Tracks');
for (const track of result.tracks) {
  const durationOk = Math.abs(track.duration - track.expected) < 0.03;
  const spectrumOk = track.centroid >= 80 && track.centroid <= 7000 && track.lowShare > 0.01 && track.highShare > 0.01;
  const peakOk = track.peak <= PEAK_MINUS_ONE_DB && track.truePeak <= PEAK_MINUS_ONE_DB;
  const rmsOk = track.rms >= MIN_TRACK_RMS && track.rms <= MAX_TRACK_RMS;
  const tempoOk = track.bpm === null || (track.detectedBpm !== null && Math.abs(track.detectedBpm - track.bpm) <= TEMPO_TOLERANCE_BPM);
  const loopOk = !track.loop || track.boundaryDiscontinuity <= MAX_LOOP_DISCONTINUITY;
  const stingerTailOk = track.loop || track.tailRms <= MAX_STINGER_TAIL_RMS;
  const rateOk = track.sampleRate === EXPECTED_MUSIC_SAMPLE_RATE;
  const renderOk = track.renderMs <= MAX_TRACK_RENDER_MS;
  const sectionOk = track.firstSectionMs <= MAX_FIRST_SECTION_MS;
  const dcOk = track.maxAbsMean <= MAX_TRACK_DC;
  const holeOk = !track.loop || track.minSectionRmsDb >= MIN_SECTION_RMS_DB;
  const lufsOk = !track.loop || (track.lufs >= MIN_LOOP_LUFS && track.lufs <= MAX_LOOP_LUFS);
  const titleStartOk = track.name !== 'title' || track.firstSectionMs <= MAX_TITLE_RENDER_MS;
  const ok = durationOk && spectrumOk && track.finite && !track.silent && peakOk && rmsOk && tempoOk && loopOk && stingerTailOk && rateOk && renderOk && sectionOk && titleStartOk && dcOk && holeOk && lufsOk;
  check(`track ${track.name}`, ok, `dur=${track.duration.toFixed(3)}s rate=${track.sampleRate} truePeak=${(20 * Math.log10(track.truePeak)).toFixed(1)}dBTP lufs=${track.lufs.toFixed(1)} dc=${track.maxAbsMean.toFixed(4)} min1s=${track.minSectionRmsDb.toFixed(1)}dB bpm=${track.detectedBpm?.toFixed(1) ?? 'n/a'} first=${track.firstSectionMs.toFixed(0)}ms render=${track.renderMs.toFixed(0)}ms`);
}

section('SFX');
for (const sfx of result.sfx) {
  const durationLower = Math.max(0.02, sfx.expected * 0.45);
  const durationUpper = Math.max(sfx.expected + 0.24, sfx.expected * 1.45 + 0.08);
  const durationOk = sfx.activeDuration >= durationLower && sfx.activeDuration <= durationUpper;
  const spectrumOk = sfx.centroid >= 50 && sfx.centroid <= 10000;
  const ok = durationOk && spectrumOk && sfx.finite && !sfx.silent && sfx.peak < 1;
  check(`sfx ${sfx.name}`, ok, `active=${sfx.activeDuration.toFixed(3)}s peak=${sfx.peak.toFixed(3)} centroid=${sfx.centroid.toFixed(0)}Hz`);
}

section('Windups');
for (const windup of result.windups) {
  check(`windup ${windup.name}`, windup.actual >= windup.expected - 0.05 && windup.actual <= windup.expected + 0.26, `actual=${windup.actual.toFixed(3)}s expected=${windup.expected.toFixed(3)}s`);
}

section('Runtime');
check('mute sets master gain to zero', result.muteMasterGain === 0, `gain=${Number.isFinite(result.muteMasterGain) ? result.muteMasterGain.toFixed(3) : 'NaN'}`);
check('mute persists to localStorage', result.mutePersisted === '1', `stored=${String(result.mutePersisted)}`);
check('mute callback fired', result.muteCallback);
check('mute restores in new engine', result.muteRestored);
check('pre-unlock calls are safe', result.preUnlockSafe);
check('pre-unlock playMusic stays deferred', result.preUnlockDeferred);
check('unlock reaches running state', result.runningAfterUnlock);
check('post-unlock calls are safe', result.postUnlockSafe);
check('locked AudioEngine + AudioDirector stay safe before unlock', result.lockedSafe);
check('musicPosition reports continuous beats', result.musicPositionWorks);
check('in-match music switches on the bar grid', result.adaptiveSwitch);
check('music worker keeps main-thread tasks short', result.longestMusicLongTaskMs < 50, `${result.longestMusicLongTaskMs.toFixed(1)}ms`);
check('title section becomes audible within budget', result.titleAudibleMs <= 1500, `${result.titleAudibleMs.toFixed(0)}ms`);
check('cold battle section becomes audible within budget', result.coldBattleAudibleMs <= 3000, `${result.coldBattleAudibleMs.toFixed(0)}ms`);
{
  // Streaming: music must keep sounding across section boundaries and the loop wrap (no half second of silence).
  const gaps = (levels: number[]) => levels.slice(8).filter((level, i, rest) => level < SILENT_DBFS && (rest[i + 1] ?? 0) < SILENT_DBFS).length;
  const quietest = (levels: number[]) => {
    const rest = levels.slice(8);
    const index = rest.indexOf(Math.min(...rest));
    return `${rest[index].toFixed(1)} dBFS at ${((index + 9) * 0.25).toFixed(2)} s`;
  };
  check('the title keeps playing across its section boundary and the loop wrap', result.titleLevels.length > 100 && gaps(result.titleLevels) === 0, `${result.titleLevels.length} samples, quietest ${quietest(result.titleLevels)}`);
  check('battle keeps playing across its first section boundary', result.battleLevels.length > 50 && gaps(result.battleLevels) === 0, `${result.battleLevels.length} samples, quietest ${quietest(result.battleLevels)}`);
}
check('lead oscillator aliasing stays below harmonic floor', result.diagnostics.aliasDb <= -50, `${result.diagnostics.aliasDb.toFixed(1)} dB`);
check('pluck filter closes after attack', result.diagnostics.pluckCentroidRatio <= 0.5, `ratio=${result.diagnostics.pluckCentroidRatio.toFixed(2)}`);
check('sidechain ducks tonal bus after kicks', result.diagnostics.sidechainDb <= -4, `${result.diagnostics.sidechainDb.toFixed(1)} dB`);
check('reverb RT60 is musical', result.diagnostics.reverbRt60 >= 1 && result.diagnostics.reverbRt60 <= 3, `${result.diagnostics.reverbRt60.toFixed(2)}s`);
check('reverb tail is dense', result.diagnostics.reverbDensity <= 8, `peak/rms=${result.diagnostics.reverbDensity.toFixed(2)}`);
check('reverb rejects DC input', result.diagnostics.reverbDcMean <= 0.002, `mean=${result.diagnostics.reverbDcMean.toFixed(4)}`);
check('loop seam level stays even', result.diagnostics.loopSeamDb <= MAX_LOOP_SEAM_DB, `${result.diagnostics.loopSeamDb.toFixed(2)} dB`);
check('streamed sections reproduce every bar of every loop', result.diagnostics.sectionMatchDb <= MAX_SECTION_BAR_DB, `worst bar ${result.diagnostics.sectionMatchDb.toFixed(2)} dB`);
check('the limiter glides (no gain steps) and holds the ceiling', result.limiter.step <= result.limiter.stepLimit * 1.001 && result.limiter.peakOverCeiling <= 1.0001, `largest step ${result.limiter.step.toExponential(2)} (limit ${result.limiter.stepLimit.toExponential(2)}), peak ${result.limiter.peakOverCeiling.toFixed(4)} x ceiling`);
{
  const p = result.contour.phrases;
  const describe = Object.entries(p).map(([name, value]) => `${name} ${value.toFixed(1)}`).join(', ');
  check('battle: the intro sits under the drop', p.intro <= p.drop - CONTOUR_INTRO_BELOW_DROP, describe);
  check('battle: the theme sits under the drop', p.theme <= p.drop - CONTOUR_THEME_BELOW_DROP);
  check('battle: every build rises', result.contour.builds.length >= 2 && result.contour.builds.every(([first, last]) => last >= first + CONTOUR_BUILD_RISE), result.contour.builds.map(([first, last]) => `${first.toFixed(1)} -> ${last.toFixed(1)}`).join(', '));
  check('battle: the breakdown drops the energy, not the music', p.breakdown >= p.drop - CONTOUR_BREAKDOWN_BELOW_DROP_MAX && p.breakdown <= p.drop - CONTOUR_BREAKDOWN_BELOW_DROP_MIN);
  check('battle: the final drop hits at least as hard', p.final >= p.drop - CONTOUR_FINAL_BELOW_DROP_MAX);
}
check('director maps core cues', result.directorCalls.includes('play:shotVanguard')
  && result.directorCalls.some((call) => call.startsWith('play:ultimaWindup'))
  && result.directorCalls.includes('play:siegeRelease')
  && result.directorCalls.includes('play:stormAlarm')
  && result.directorCalls.includes('play:matchWon')
  && result.directorCalls.includes('play:fight')
  && result.directorCalls.includes('music:bossForm')
  && result.directorCalls.includes('layer:ultimaBarrage:on'));
check('page emitted no warnings or errors', problems.length === 0, problems[0] ?? 'clean');

section('Music exports');
info(`decoded music memory ${(result.musicMemoryBytes / 1024 / 1024).toFixed(1)} MiB`);
check('decoded music stays under memory budget', result.musicMemoryBytes <= MAX_MUSIC_MEMORY_BYTES, `${(result.musicMemoryBytes / 1024 / 1024).toFixed(1)} MiB`);
for (const track of result.tracks) info(`${MUSIC_SHOT_DIR}/${track.name}.wav`);

if (problems.length > 0) {
  section('Console problems');
  for (const problem of problems) info(problem);
}

await browser.close();
finish('audio');
