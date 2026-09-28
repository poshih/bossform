import { AUDIO_SAMPLE_RATE, createPrng, midiToHz } from './synth.ts';
import type { Track } from './synth.ts';

const TRACK_MASTER_GAIN = 0.74;
const LOOP_TAIL_BEATS = 4;
const QUIET = 0.0001;

type Mode = 'minor' | 'dorian' | 'phrygian' | 'mixolydian';
type Quality = 'm7' | 'M7' | 'sus2' | 'pow';

interface ChordSpec {
  readonly degree: number;
  readonly quality: Quality;
}

export interface TrackSpec {
  readonly id: Track;
  readonly bpm: number;
  readonly bars: number;
  readonly loop: boolean;
  readonly rootMidi: number;
  readonly mode: Mode;
  readonly progression: readonly ChordSpec[];
  readonly intensity: number;
  readonly style: 'title' | 'drive' | 'phrygianDrive' | 'dorianLift' | 'boss' | 'bossMode' | 'clear' | 'gameOver';
  readonly seed: number;
}

const SCALES: Record<Mode, readonly number[]> = {
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
};

const CHORD_QUALITIES: Record<Quality, readonly number[]> = {
  m7: [0, 3, 7, 10],
  M7: [0, 4, 7, 11],
  sus2: [0, 2, 7, 10],
  pow: [0, 7, 12],
};

export const TRACK_SPECS: Record<Track, TrackSpec> = {
  title: {
    id: 'title', bpm: 122, bars: 8, loop: true, rootMidi: 45, mode: 'minor',
    progression: [{ degree: 0, quality: 'm7' }, { degree: 5, quality: 'M7' }, { degree: 3, quality: 'M7' }, { degree: 4, quality: 'sus2' }],
    intensity: 0.52, style: 'title', seed: 11,
  },
  stage1: {
    id: 'stage1', bpm: 128, bars: 8, loop: true, rootMidi: 40, mode: 'minor',
    progression: [{ degree: 0, quality: 'm7' }, { degree: 5, quality: 'M7' }, { degree: 3, quality: 'M7' }, { degree: 4, quality: 'pow' }],
    intensity: 0.7, style: 'drive', seed: 21,
  },
  stage2: {
    id: 'stage2', bpm: 136, bars: 8, loop: true, rootMidi: 41, mode: 'phrygian',
    progression: [{ degree: 0, quality: 'm7' }, { degree: 1, quality: 'M7' }, { degree: 3, quality: 'pow' }, { degree: 1, quality: 'M7' }],
    intensity: 0.8, style: 'phrygianDrive', seed: 31,
  },
  stage3: {
    id: 'stage3', bpm: 144, bars: 8, loop: true, rootMidi: 43, mode: 'dorian',
    progression: [{ degree: 0, quality: 'm7' }, { degree: 4, quality: 'M7' }, { degree: 5, quality: 'sus2' }, { degree: 3, quality: 'M7' }],
    intensity: 0.92, style: 'dorianLift', seed: 41,
  },
  boss: {
    id: 'boss', bpm: 146, bars: 8, loop: true, rootMidi: 38, mode: 'phrygian',
    progression: [{ degree: 0, quality: 'pow' }, { degree: 0, quality: 'm7' }, { degree: 5, quality: 'pow' }, { degree: 1, quality: 'M7' }],
    intensity: 1, style: 'boss', seed: 51,
  },
  bossMode: {
    id: 'bossMode', bpm: 150, bars: 8, loop: true, rootMidi: 47, mode: 'mixolydian',
    progression: [{ degree: 0, quality: 'M7' }, { degree: 4, quality: 'sus2' }, { degree: 5, quality: 'pow' }, { degree: 3, quality: 'M7' }],
    intensity: 1, style: 'bossMode', seed: 61,
  },
  clear: {
    id: 'clear', bpm: 128, bars: 2, loop: false, rootMidi: 55, mode: 'mixolydian',
    progression: [{ degree: 0, quality: 'M7' }, { degree: 4, quality: 'M7' }],
    intensity: 0.75, style: 'clear', seed: 71,
  },
  gameOver: {
    id: 'gameOver', bpm: 96, bars: 2, loop: false, rootMidi: 45, mode: 'minor',
    progression: [{ degree: 5, quality: 'M7' }, { degree: 0, quality: 'm7' }],
    intensity: 0.54, style: 'gameOver', seed: 81,
  },
};

function trackOf(track: Track | TrackSpec): TrackSpec {
  return typeof track === 'string' ? TRACK_SPECS[track] : track;
}

function arrangementSeconds(spec: TrackSpec): number {
  return (spec.bars * 4 * 60) / spec.bpm;
}

export function getTrackDuration(track: Track | TrackSpec): number {
  const spec = trackOf(track);
  const loopSeconds = arrangementSeconds(spec);
  return spec.loop ? loopSeconds : loopSeconds + (60 / spec.bpm) * 2.5;
}

function chordNotes(spec: TrackSpec, chord: ChordSpec, octave = 0): number[] {
  const scale = SCALES[spec.mode];
  const degree = ((chord.degree % scale.length) + scale.length) % scale.length;
  const octaveShift = 12 * (octave + Math.floor(chord.degree / scale.length));
  const root = spec.rootMidi + scale[degree] + octaveShift;
  return CHORD_QUALITIES[chord.quality].map((note) => root + note);
}

class Synth {
  readonly out: GainNode;
  readonly fxSend: GainNode;
  private readonly noise: AudioBuffer;
  private readonly ctx: OfflineAudioContext;

  constructor(ctx: OfflineAudioContext, beat: number) {
    this.ctx = ctx;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.knee.value = 5;
    limiter.ratio.value = 8;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.12;
    limiter.connect(ctx.destination);

    this.out = ctx.createGain();
    this.out.gain.value = TRACK_MASTER_GAIN;
    this.out.connect(limiter);

    this.fxSend = ctx.createGain();
    this.fxSend.gain.value = 0.36;

    const delayL = ctx.createDelay(2);
    const delayR = ctx.createDelay(2);
    delayL.delayTime.value = beat * 0.75;
    delayR.delayTime.value = beat * 0.5;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.24;
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 3200;
    const merger = ctx.createChannelMerger(2);
    this.fxSend.connect(delayL);
    delayL.connect(tone);
    tone.connect(delayR);
    delayR.connect(feedback);
    feedback.connect(delayL);
    delayL.connect(merger, 0, 0);
    delayR.connect(merger, 0, 1);
    const wet = ctx.createGain();
    wet.gain.value = 0.3;
    merger.connect(wet).connect(this.out);

    const length = Math.max(1, Math.round(ctx.sampleRate * 2));
    this.noise = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    const random = createPrng(123);
    for (let i = 0; i < data.length; i++) data[i] = random() * 2 - 1;
  }

  private pan(value: number): StereoPannerNode {
    const node = this.ctx.createStereoPanner();
    node.pan.value = value;
    node.connect(this.out);
    return node;
  }

  private env(gain: GainNode, start: number, attack: number, peak: number, decay: number): void {
    gain.gain.setValueAtTime(QUIET, start);
    gain.gain.exponentialRampToValueAtTime(peak, start + Math.max(0.001, attack));
    gain.gain.exponentialRampToValueAtTime(QUIET, start + Math.max(0.002, attack + decay));
  }

  kick(start: number, gainValue = 0.8): void {
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(154, start);
    osc.frequency.exponentialRampToValueAtTime(43, start + 0.14);
    const gain = this.ctx.createGain();
    this.env(gain, start, 0.003, gainValue, 0.28);
    osc.connect(gain).connect(this.out);
    osc.start(start);
    osc.stop(start + 0.34);
  }

  snare(start: number, gainValue = 0.36): void {
    const noise = this.ctx.createBufferSource();
    noise.buffer = this.noise;
    const band = this.ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 1800;
    band.Q.value = 0.7;
    const gain = this.ctx.createGain();
    this.env(gain, start, 0.002, gainValue, 0.18);
    noise.connect(band).connect(gain).connect(this.pan(0.1));
    noise.start(start, 0.1, 0.25);

    const body = this.ctx.createOscillator();
    body.type = 'triangle';
    body.frequency.setValueAtTime(210, start);
    body.frequency.exponentialRampToValueAtTime(120, start + 0.1);
    const bodyGain = this.ctx.createGain();
    this.env(bodyGain, start, 0.002, gainValue * 0.6, 0.09);
    body.connect(bodyGain).connect(this.out);
    body.start(start);
    body.stop(start + 0.14);
  }

  hat(start: number, open: boolean, gainValue = 0.08, pan = 0.2): void {
    const noise = this.ctx.createBufferSource();
    noise.buffer = this.noise;
    const high = this.ctx.createBiquadFilter();
    high.type = 'highpass';
    high.frequency.value = 6800;
    const gain = this.ctx.createGain();
    this.env(gain, start, 0.001, gainValue, open ? 0.12 : 0.03);
    noise.connect(high).connect(gain).connect(this.pan(pan));
    noise.start(start, (start * 5.37) % 0.5, 0.18);
  }

  clap(start: number, gainValue = 0.16): void {
    for (let i = 0; i < 3; i++) {
      const time = start + i * 0.015;
      const noise = this.ctx.createBufferSource();
      noise.buffer = this.noise;
      const band = this.ctx.createBiquadFilter();
      band.type = 'bandpass';
      band.frequency.value = 1400;
      band.Q.value = 0.8;
      const gain = this.ctx.createGain();
      this.env(gain, time, 0.001, gainValue * (1 - i * 0.18), 0.08);
      noise.connect(band).connect(gain).connect(this.out);
      noise.start(time, (time * 3.7) % 0.3, 0.12);
    }
  }

  bass(start: number, midi: number, duration: number, gainValue = 0.24, cutoff = 1400): void {
    const saw = this.ctx.createOscillator();
    saw.type = 'sawtooth';
    saw.frequency.value = midiToHz(midi);
    const sub = this.ctx.createOscillator();
    sub.type = 'square';
    sub.frequency.value = midiToHz(midi - 12);
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 6;
    filter.frequency.setValueAtTime(cutoff, start);
    filter.frequency.exponentialRampToValueAtTime(220, start + duration * 0.92);
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(QUIET, start);
    gain.gain.exponentialRampToValueAtTime(gainValue, start + 0.006);
    gain.gain.setValueAtTime(gainValue, start + duration * 0.72);
    gain.gain.exponentialRampToValueAtTime(QUIET, start + duration);
    const subGain = this.ctx.createGain();
    subGain.gain.value = 0.34;
    saw.connect(filter);
    sub.connect(subGain).connect(filter);
    filter.connect(gain).connect(this.out);
    saw.start(start);
    sub.start(start);
    saw.stop(start + duration + 0.02);
    sub.stop(start + duration + 0.02);
  }

  arp(start: number, midi: number, duration: number, gainValue = 0.07, pan = 0, type: OscillatorType = 'square', cutoff = 3200): void {
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = midiToHz(midi);
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(cutoff, start);
    filter.frequency.exponentialRampToValueAtTime(700, start + duration);
    const gain = this.ctx.createGain();
    this.env(gain, start, 0.002, gainValue, duration);
    osc.connect(filter).connect(gain);
    gain.connect(this.pan(pan));
    gain.connect(this.fxSend);
    osc.start(start);
    osc.stop(start + duration + 0.03);
  }

  pad(start: number, notes: readonly number[], duration: number, gainValue = 0.028, cutoff = 1300): void {
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = cutoff;
    filter.Q.value = 0.7;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(QUIET, start);
    gain.gain.linearRampToValueAtTime(gainValue, start + Math.min(0.8, duration * 0.28));
    gain.gain.setValueAtTime(gainValue, start + duration * 0.78);
    gain.gain.linearRampToValueAtTime(QUIET, start + duration);
    filter.connect(gain).connect(this.out);
    gain.connect(this.fxSend);
    for (const midi of notes) {
      for (const detune of [-7, 7]) {
        const osc = this.ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.value = midiToHz(midi);
        osc.detune.value = detune;
        osc.connect(filter);
        osc.start(start);
        osc.stop(start + duration + 0.04);
      }
    }
  }

  lead(start: number, midi: number, duration: number, gainValue = 0.08, cutoff = 2600): void {
    const osc = this.ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = midiToHz(midi);
    const vib = this.ctx.createOscillator();
    vib.type = 'sine';
    vib.frequency.value = 5.6;
    const vibGain = this.ctx.createGain();
    vibGain.gain.setValueAtTime(0, start);
    vibGain.gain.linearRampToValueAtTime(midiToHz(midi) * 0.011, start + Math.min(0.22, duration * 0.4));
    vib.connect(vibGain).connect(osc.frequency);
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = cutoff;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(QUIET, start);
    gain.gain.exponentialRampToValueAtTime(gainValue, start + 0.02);
    gain.gain.setValueAtTime(gainValue, start + duration * 0.8);
    gain.gain.exponentialRampToValueAtTime(QUIET, start + duration);
    osc.connect(filter).connect(gain).connect(this.out);
    gain.connect(this.fxSend);
    osc.start(start);
    vib.start(start);
    osc.stop(start + duration + 0.03);
    vib.stop(start + duration + 0.03);
  }

  bell(start: number, midi: number, gainValue = 0.08): void {
    const partials = [
      { ratio: 1, amp: 1, decay: 1.4 },
      { ratio: 2.74, amp: 0.4, decay: 0.72 },
      { ratio: 5.4, amp: 0.18, decay: 0.38 },
    ] as const;
    for (const partial of partials) {
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = midiToHz(midi) * partial.ratio;
      const gain = this.ctx.createGain();
      this.env(gain, start, 0.002, gainValue * partial.amp, partial.decay);
      osc.connect(gain).connect(this.out);
      gain.connect(this.fxSend);
      osc.start(start);
      osc.stop(start + partial.decay + 0.03);
    }
  }

  rise(start: number, duration: number, fromMidi: number, toMidi: number, gainValue = 0.05): void {
    const osc = this.ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(midiToHz(fromMidi), start);
    osc.frequency.exponentialRampToValueAtTime(midiToHz(toMidi), start + duration);
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(QUIET, start);
    gain.gain.exponentialRampToValueAtTime(gainValue, start + duration * 0.85);
    gain.gain.exponentialRampToValueAtTime(QUIET, start + duration);
    osc.connect(gain).connect(this.out);
    gain.connect(this.fxSend);
    osc.start(start);
    osc.stop(start + duration + 0.03);
  }
}

function motif(spec: TrackSpec): Array<[number, number, number]> {
  const random = createPrng(spec.seed);
  const out: Array<[number, number, number]> = [];
  let pos = 0;
  let degree = spec.style === 'bossMode' ? 5 : 4;
  while (pos < 32) {
    const choices = [1, 2, 2, 3, 4];
    const len = choices[Math.floor(random() * choices.length)];
    if (random() < 0.86) out.push([pos, degree, Math.min(len, 32 - pos)]);
    degree += [-2, -1, 1, 2, 3, -3][Math.floor(random() * 6)];
    degree = Math.max(0, Math.min(10, degree));
    pos += len;
  }
  return out;
}

function scaleNote(spec: TrackSpec, degree: number, octave = 0): number {
  const scale = SCALES[spec.mode];
  const length = scale.length;
  const index = ((degree % length) + length) % length;
  return spec.rootMidi + scale[index] + 12 * (octave + Math.floor(degree / length));
}

function writeTrack(spec: TrackSpec, synth: Synth): void {
  const beat = 60 / spec.bpm;
  const step = beat / 4;
  const phrase = motif(spec);
  const arpPatterns = {
    title: [0, 2, 1, 3, 2, 1, 3, 1],
    drive: [0, 1, 2, 3, 1, 2, 3, 2],
    phrygianDrive: [0, 2, 3, 1, 2, 0, 3, 1],
    dorianLift: [0, 1, 3, 2, 1, 3, 2, 3],
    boss: [0, 0, 2, 1, 3, 1, 2, 3],
    bossMode: [0, 1, 2, 3, 2, 1, 3, 2],
    clear: [0, 1, 2, 3, 1, 2, 3, 2],
    gameOver: [3, 2, 1, 0, 2, 1, 0, 1],
  } as const;

  for (let bar = 0; bar < spec.bars; bar++) {
    const start = bar * beat * 4;
    const chord = spec.progression[bar % spec.progression.length];
    const notes = chordNotes(spec, chord, 0);
    const highNotes = chordNotes(spec, chord, 2);
    const barDuration = beat * 4;
    const intro = bar < 2 && spec.loop;
    const leadSlice = phrase.filter(([pos]) => pos >= (bar % 2) * 16 && pos < (bar % 2) * 16 + 16);

    switch (spec.style) {
      case 'title': {
        synth.pad(start, notes.map((m) => m + 24), barDuration, 0.028, 1100);
        for (let i = 0; i < 8; i++) synth.arp(start + i * beat * 0.5, highNotes[arpPatterns.title[i] % highNotes.length], beat * 0.88, 0.048, i % 2 === 0 ? -0.42 : 0.42, 'triangle', 2500);
        if (!intro) {
          synth.kick(start, 0.58);
          synth.kick(start + beat * 2.5, 0.42);
          synth.snare(start + beat, 0.16);
          synth.snare(start + beat * 3, 0.18);
          for (let i = 0; i < 4; i++) synth.hat(start + i * beat + beat * 0.5, false, 0.045, 0.18);
          synth.bass(start, notes[0] + 12, beat * 1.6, 0.18, 760);
          synth.bass(start + beat * 2, notes[0] + 12, beat * 1.6, 0.18, 760);
        }
        if (bar % 2 === 0) synth.bell(start, highNotes[0], 0.035);
        break;
      }
      case 'drive':
      case 'phrygianDrive':
      case 'dorianLift': {
        const panBase = spec.style === 'phrygianDrive' ? 0.52 : spec.style === 'dorianLift' ? 0.6 : 0.45;
        synth.pad(start, notes.slice(0, 3).map((m) => m + 24), barDuration, 0.022 + spec.intensity * 0.01, 1500);
        for (let i = 0; i < 4; i++) synth.kick(start + i * beat, 0.76 + spec.intensity * 0.08);
        synth.snare(start + beat, 0.34);
        synth.snare(start + beat * 3, 0.36);
        if (spec.style !== 'drive') synth.clap(start + beat * 3.5, 0.12 + spec.intensity * 0.05);
        for (let i = 0; i < 16; i++) synth.hat(start + i * step, i % 4 === 2, i % 2 === 0 ? 0.07 : 0.052, i % 2 === 0 ? panBase : -panBase * 0.7);
        for (let i = 0; i < 8; i++) {
          const bassMidi = notes[0] + (i % 4 === 3 && spec.style === 'phrygianDrive' ? 1 : 0);
          synth.bass(start + i * beat * 0.5, bassMidi, beat * 0.46, 0.2 + spec.intensity * 0.05, 1300 + spec.intensity * 400);
        }
        const pattern = arpPatterns[spec.style];
        for (let i = 0; i < 16; i++) {
          const midi = highNotes[pattern[i % pattern.length] % highNotes.length] + (i >= 8 && spec.style === 'dorianLift' ? 12 : 0);
          synth.arp(start + i * step, midi, step * 1.6, intro ? 0.032 : 0.052, (i % 4) / 2 - 0.75, spec.style === 'dorianLift' ? 'sawtooth' : 'square', spec.style === 'phrygianDrive' ? 2600 : 3000);
        }
        if (!intro) {
          for (const [pos, degree, len] of leadSlice) {
            const local = pos - (bar % 2) * 16;
            synth.lead(start + local * step, scaleNote(spec, degree, spec.style === 'dorianLift' ? 2 : 1) + (spec.style === 'dorianLift' ? 12 : 0), len * step * 0.95, spec.style === 'drive' ? 0.052 : 0.06, spec.style === 'dorianLift' ? 3100 : 2400);
          }
        }
        break;
      }
      case 'boss': {
        synth.pad(start, notes.map((m) => m + 12), barDuration, 0.024, 1100);
        for (let i = 0; i < 4; i++) synth.kick(start + i * beat, 0.86);
        synth.kick(start + beat * 3.5, 0.46);
        synth.snare(start + beat, 0.38);
        synth.snare(start + beat * 3, 0.42);
        synth.clap(start + beat * 3.5, 0.15);
        for (let i = 0; i < 16; i++) synth.hat(start + i * step, i % 4 === 3, i % 4 === 0 ? 0.09 : 0.05, i % 2 === 0 ? 0.28 : -0.24);
        for (let i = 0; i < 16; i++) synth.bass(start + i * step, notes[0] + (i % 4 === 2 ? 12 : 0), step * 0.92, 0.26, 1700);
        const pattern = arpPatterns.boss;
        for (let i = 0; i < 16; i++) synth.arp(start + i * step, highNotes[pattern[i % pattern.length] % highNotes.length], step * 1.3, intro ? 0.024 : 0.042, i % 2 === 0 ? -0.3 : 0.3, 'square', 2100);
        if (!intro) {
          for (const [pos, degree, len] of leadSlice) {
            const local = pos - (bar % 2) * 16;
            synth.lead(start + local * step, scaleNote(spec, degree, 1), len * step * 0.92, 0.064, 2100);
          }
        }
        synth.rise(start + beat * 3.25, beat * 0.6, 45, 57, 0.02);
        break;
      }
      case 'bossMode': {
        synth.pad(start, notes.map((m) => m + 24), barDuration, 0.028, 1700);
        for (let i = 0; i < 4; i++) synth.kick(start + i * beat, 0.88);
        synth.snare(start + beat, 0.42);
        synth.snare(start + beat * 3, 0.42);
        synth.clap(start + beat * 3.5, 0.15);
        for (let i = 0; i < 16; i++) synth.hat(start + i * step, i % 4 === 1, i % 2 === 0 ? 0.1 : 0.058, i % 2 === 0 ? 0.33 : -0.25);
        for (let i = 0; i < 8; i++) synth.bass(start + i * beat * 0.5, notes[0] + 12, beat * 0.47, 0.28, 1900);
        const pattern = arpPatterns.bossMode;
        for (let i = 0; i < 16; i++) synth.arp(start + i * step, highNotes[pattern[i % pattern.length] % highNotes.length] + 12, step * 1.8, intro ? 0.03 : 0.056, i % 4 < 2 ? -0.48 : 0.48, 'sawtooth', 3600);
        if (!intro) {
          for (const [pos, degree, len] of leadSlice) {
            const local = pos - (bar % 2) * 16;
            synth.lead(start + local * step, scaleNote(spec, degree + 1, 2), len * step, 0.074, 3400);
          }
        }
        if (bar % 2 === 0) synth.bell(start, highNotes[0] + 12, 0.05);
        break;
      }
      case 'clear': {
        synth.pad(start, notes.map((m) => m + 24), barDuration, 0.03, 1800);
        synth.kick(start, 0.62);
        synth.kick(start + beat * 2, 0.5);
        synth.snare(start + beat * 3, 0.24);
        for (let i = 0; i < 8; i++) synth.arp(start + i * beat * 0.5, highNotes[arpPatterns.clear[i] % highNotes.length] + 12, beat * 0.9, 0.06, i % 2 === 0 ? -0.35 : 0.35, 'triangle', 3400);
        synth.bell(start, highNotes[0] + 12, 0.06);
        synth.bell(start + beat * 1.5, highNotes[1] + 12, 0.05);
        break;
      }
      case 'gameOver': {
        synth.pad(start, notes.map((m) => m + 12), barDuration, 0.025, 900);
        synth.kick(start, 0.4);
        synth.snare(start + beat * 2, 0.18);
        synth.bass(start, notes[0], beat * 3.4, 0.17, 620);
        for (let i = 0; i < 4; i++) synth.arp(start + i * beat, highNotes[arpPatterns.gameOver[i] % highNotes.length], beat * 1.3, 0.04, i % 2 === 0 ? -0.3 : 0.3, 'triangle', 1800);
        if (bar === spec.bars - 1) synth.rise(start + beat * 2.5, beat * 1.2, 60, 52, 0.015);
        break;
      }
    }
  }
}

export async function renderTrack(track: Track | TrackSpec): Promise<AudioBuffer> {
  const spec = trackOf(track);
  const loopSeconds = arrangementSeconds(spec);
  const beat = 60 / spec.bpm;
  const tailSeconds = spec.loop ? beat * LOOP_TAIL_BEATS : beat * 2.5;
  const totalFrames = Math.max(1, Math.round((loopSeconds + tailSeconds) * AUDIO_SAMPLE_RATE));
  const ctx = new OfflineAudioContext(2, totalFrames, AUDIO_SAMPLE_RATE);
  const synth = new Synth(ctx, beat);
  writeTrack(spec, synth);
  const rendered = await ctx.startRendering();
  if (!spec.loop) return rendered;
  const loopFrames = Math.round(loopSeconds * AUDIO_SAMPLE_RATE);
  const out = ctx.createBuffer(2, loopFrames, AUDIO_SAMPLE_RATE);
  for (let channel = 0; channel < 2; channel++) {
    const source = rendered.getChannelData(channel);
    const dest = out.getChannelData(channel);
    dest.set(source.subarray(0, loopFrames));
    for (let i = loopFrames; i < source.length; i++) dest[i - loopFrames] += source[i];
  }
  return out;
}
