import { AUDIO_SAMPLE_RATE, createPrng, midiToHz } from './synth.ts';
import type { Track } from './synth.ts';

const TRACK_MASTER_GAIN = 0.72;
const LOOP_TAIL_BEATS = 4;
const STINGER_TAIL_BEATS = 3;
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
  readonly style: 'title' | 'battle' | 'bossForm' | 'sudden' | 'victory' | 'defeat';
  readonly intensity: number;
  readonly seed: number;
}

const SCALES: Record<Mode, readonly number[]> = {
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
};

const CHORDS: Record<Quality, readonly number[]> = {
  m7: [0, 3, 7, 10],
  M7: [0, 4, 7, 11],
  sus2: [0, 2, 7, 10],
  pow: [0, 7, 12],
};

export const TRACK_SPECS: Record<Track, TrackSpec> = {
  title: {
    id: 'title',
    bpm: 108,
    bars: 8,
    loop: true,
    rootMidi: 45,
    mode: 'minor',
    progression: [{ degree: 0, quality: 'm7' }, { degree: 5, quality: 'M7' }, { degree: 3, quality: 'M7' }, { degree: 4, quality: 'sus2' }],
    style: 'title',
    intensity: 0.45,
    seed: 11,
  },
  battle: {
    id: 'battle',
    bpm: 118,
    bars: 8,
    loop: true,
    rootMidi: 40,
    mode: 'dorian',
    progression: [{ degree: 0, quality: 'm7' }, { degree: 3, quality: 'M7' }, { degree: 4, quality: 'sus2' }, { degree: 5, quality: 'pow' }],
    style: 'battle',
    intensity: 0.76,
    seed: 21,
  },
  bossForm: {
    id: 'bossForm',
    bpm: 122,
    bars: 8,
    loop: true,
    rootMidi: 38,
    mode: 'phrygian',
    progression: [{ degree: 0, quality: 'pow' }, { degree: 1, quality: 'M7' }, { degree: 3, quality: 'pow' }, { degree: 1, quality: 'M7' }],
    style: 'bossForm',
    intensity: 0.96,
    seed: 31,
  },
  sudden: {
    id: 'sudden',
    bpm: 124,
    bars: 6,
    loop: true,
    rootMidi: 43,
    mode: 'phrygian',
    progression: [{ degree: 0, quality: 'm7' }, { degree: 1, quality: 'pow' }, { degree: 0, quality: 'm7' }],
    style: 'sudden',
    intensity: 0.88,
    seed: 41,
  },
  victory: {
    id: 'victory',
    bpm: 104,
    bars: 4,
    loop: false,
    rootMidi: 52,
    mode: 'mixolydian',
    progression: [{ degree: 0, quality: 'M7' }, { degree: 4, quality: 'M7' }, { degree: 5, quality: 'sus2' }, { degree: 3, quality: 'M7' }],
    style: 'victory',
    intensity: 0.82,
    seed: 51,
  },
  defeat: {
    id: 'defeat',
    bpm: 100,
    bars: 4,
    loop: false,
    rootMidi: 43,
    mode: 'minor',
    progression: [{ degree: 5, quality: 'M7' }, { degree: 0, quality: 'm7' }, { degree: 4, quality: 'pow' }, { degree: 0, quality: 'm7' }],
    style: 'defeat',
    intensity: 0.56,
    seed: 61,
  },
};

function trackSpecOf(track: Track | TrackSpec): TrackSpec {
  return typeof track === 'string' ? TRACK_SPECS[track] : track;
}

function arrangementSeconds(spec: TrackSpec): number {
  return (spec.bars * 4 * 60) / spec.bpm;
}

export function getTrackDuration(track: Track | TrackSpec): number {
  const spec = trackSpecOf(track);
  const body = arrangementSeconds(spec);
  return spec.loop ? body : body + (60 / spec.bpm) * STINGER_TAIL_BEATS;
}

function chordNotes(spec: TrackSpec, chord: ChordSpec, octave = 0): number[] {
  const scale = SCALES[spec.mode];
  const degree = ((chord.degree % scale.length) + scale.length) % scale.length;
  const octaveShift = 12 * (octave + Math.floor(chord.degree / scale.length));
  const root = spec.rootMidi + scale[degree] + octaveShift;
  return CHORDS[chord.quality].map((offset) => root + offset);
}

function scaleNote(spec: TrackSpec, degree: number, octave = 0): number {
  const scale = SCALES[spec.mode];
  const length = scale.length;
  const index = ((degree % length) + length) % length;
  return spec.rootMidi + scale[index] + 12 * (octave + Math.floor(degree / length));
}

class Synth {
  readonly out: GainNode;
  readonly fxSend: GainNode;
  private readonly ctx: OfflineAudioContext;
  private readonly noise: AudioBuffer;

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
    this.fxSend.gain.value = 0.34;

    const delayL = ctx.createDelay(2);
    const delayR = ctx.createDelay(2);
    delayL.delayTime.value = beat * 0.75;
    delayR.delayTime.value = beat * 0.5;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.22;
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
    wet.gain.value = 0.28;
    merger.connect(wet).connect(this.out);

    const buffer = ctx.createBuffer(1, Math.round(ctx.sampleRate * 2), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    const random = createPrng(101);
    for (let i = 0; i < data.length; i++) data[i] = random() * 2 - 1;
    this.noise = buffer;
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

  kick(start: number, peak = 0.8): void {
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(140, start);
    osc.frequency.exponentialRampToValueAtTime(42, start + 0.14);
    const gain = this.ctx.createGain();
    this.env(gain, start, 0.003, peak, 0.28);
    osc.connect(gain).connect(this.out);
    osc.start(start);
    osc.stop(start + 0.34);
  }

  snare(start: number, peak = 0.3): void {
    const noise = this.ctx.createBufferSource();
    noise.buffer = this.noise;
    const band = this.ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 1800;
    band.Q.value = 0.7;
    const gain = this.ctx.createGain();
    this.env(gain, start, 0.002, peak, 0.14);
    noise.connect(band).connect(gain).connect(this.pan(0.08));
    noise.start(start, 0.1, 0.22);

    const body = this.ctx.createOscillator();
    body.type = 'triangle';
    body.frequency.setValueAtTime(210, start);
    body.frequency.exponentialRampToValueAtTime(120, start + 0.09);
    const bodyGain = this.ctx.createGain();
    this.env(bodyGain, start, 0.002, peak * 0.6, 0.08);
    body.connect(bodyGain).connect(this.out);
    body.start(start);
    body.stop(start + 0.14);
  }

  hat(start: number, open: boolean, peak = 0.07, pan = 0.2): void {
    const noise = this.ctx.createBufferSource();
    noise.buffer = this.noise;
    const high = this.ctx.createBiquadFilter();
    high.type = 'highpass';
    high.frequency.value = 7000;
    const gain = this.ctx.createGain();
    this.env(gain, start, 0.001, peak, open ? 0.12 : 0.03);
    noise.connect(high).connect(gain).connect(this.pan(pan));
    noise.start(start, (start * 4.73) % 0.5, 0.14);
  }

  clap(start: number, peak = 0.14): void {
    for (let i = 0; i < 3; i++) {
      const time = start + i * 0.015;
      const noise = this.ctx.createBufferSource();
      noise.buffer = this.noise;
      const band = this.ctx.createBiquadFilter();
      band.type = 'bandpass';
      band.frequency.value = 1500;
      band.Q.value = 0.8;
      const gain = this.ctx.createGain();
      this.env(gain, time, 0.001, peak * (1 - i * 0.16), 0.08);
      noise.connect(band).connect(gain).connect(this.out);
      noise.start(time, (time * 2.9) % 0.25, 0.1);
    }
  }

  bass(start: number, midi: number, duration: number, peak = 0.24, cutoff = 1200): void {
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
    filter.frequency.exponentialRampToValueAtTime(220, start + duration * 0.9);
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(QUIET, start);
    gain.gain.exponentialRampToValueAtTime(peak, start + 0.006);
    gain.gain.setValueAtTime(peak, start + duration * 0.72);
    gain.gain.exponentialRampToValueAtTime(QUIET, start + duration);
    const subGain = this.ctx.createGain();
    subGain.gain.value = 0.34;
    saw.connect(filter);
    sub.connect(subGain).connect(filter);
    filter.connect(gain).connect(this.out);
    saw.start(start);
    sub.start(start);
    saw.stop(start + duration + 0.03);
    sub.stop(start + duration + 0.03);
  }

  arp(start: number, midi: number, duration: number, peak = 0.06, pan = 0, type: OscillatorType = 'square', cutoff = 3200): void {
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = midiToHz(midi);
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(cutoff, start);
    filter.frequency.exponentialRampToValueAtTime(800, start + duration);
    const gain = this.ctx.createGain();
    this.env(gain, start, 0.002, peak, duration);
    osc.connect(filter).connect(gain);
    gain.connect(this.pan(pan));
    gain.connect(this.fxSend);
    osc.start(start);
    osc.stop(start + duration + 0.03);
  }

  pad(start: number, notes: readonly number[], duration: number, peak = 0.028, cutoff = 1300): void {
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = cutoff;
    filter.Q.value = 0.7;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(QUIET, start);
    gain.gain.linearRampToValueAtTime(peak, start + Math.min(0.9, duration * 0.28));
    gain.gain.setValueAtTime(peak, start + duration * 0.78);
    gain.gain.linearRampToValueAtTime(QUIET, start + duration);
    filter.connect(gain).connect(this.out);
    gain.connect(this.fxSend);
    for (const midi of notes) {
      for (const detune of [-8, 8]) {
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

  lead(start: number, midi: number, duration: number, peak = 0.07, cutoff = 2500): void {
    const osc = this.ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = midiToHz(midi);
    const vib = this.ctx.createOscillator();
    vib.type = 'sine';
    vib.frequency.value = 5.5;
    const vibGain = this.ctx.createGain();
    vibGain.gain.setValueAtTime(0, start);
    vibGain.gain.linearRampToValueAtTime(midiToHz(midi) * 0.011, start + Math.min(0.24, duration * 0.4));
    vib.connect(vibGain).connect(osc.frequency);
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = cutoff;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(QUIET, start);
    gain.gain.exponentialRampToValueAtTime(peak, start + 0.02);
    gain.gain.setValueAtTime(peak, start + duration * 0.8);
    gain.gain.exponentialRampToValueAtTime(QUIET, start + duration);
    osc.connect(filter).connect(gain).connect(this.out);
    gain.connect(this.fxSend);
    osc.start(start);
    vib.start(start);
    osc.stop(start + duration + 0.04);
    vib.stop(start + duration + 0.04);
  }

  bell(start: number, midi: number, peak = 0.08): void {
    const partials = [
      { ratio: 1, amp: 1, decay: 1.4 },
      { ratio: 2.74, amp: 0.4, decay: 0.7 },
      { ratio: 5.4, amp: 0.18, decay: 0.38 },
    ] as const;
    for (const partial of partials) {
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = midiToHz(midi) * partial.ratio;
      const gain = this.ctx.createGain();
      this.env(gain, start, 0.002, peak * partial.amp, partial.decay);
      osc.connect(gain).connect(this.out);
      gain.connect(this.fxSend);
      osc.start(start);
      osc.stop(start + partial.decay + 0.04);
    }
  }

  rise(start: number, duration: number, fromMidi: number, toMidi: number, peak = 0.03): void {
    const osc = this.ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(midiToHz(fromMidi), start);
    osc.frequency.exponentialRampToValueAtTime(midiToHz(toMidi), start + duration);
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(QUIET, start);
    gain.gain.exponentialRampToValueAtTime(peak, start + duration * 0.84);
    gain.gain.exponentialRampToValueAtTime(QUIET, start + duration);
    osc.connect(gain).connect(this.out);
    gain.connect(this.fxSend);
    osc.start(start);
    osc.stop(start + duration + 0.03);
  }
}

function buildMotif(spec: TrackSpec): Array<[number, number, number]> {
  const random = createPrng(spec.seed);
  const out: Array<[number, number, number]> = [];
  let pos = 0;
  let degree = spec.style === 'bossForm' ? 5 : 4;
  while (pos < 32) {
    const choices = [1, 2, 2, 3, 4];
    const len = choices[Math.floor(random() * choices.length)];
    if (random() < 0.88) out.push([pos, degree, Math.min(len, 32 - pos)]);
    degree += [-2, -1, 1, 2, 3, -3][Math.floor(random() * 6)];
    degree = Math.max(0, Math.min(10, degree));
    pos += len;
  }
  return out;
}

function writeTrack(spec: TrackSpec, synth: Synth): void {
  const beat = 60 / spec.bpm;
  const step = beat / 4;
  const phrase = buildMotif(spec);
  const arpOrder = {
    title: [0, 2, 1, 3, 2, 1, 3, 1],
    battle: [0, 1, 2, 3, 1, 2, 3, 2],
    bossForm: [0, 0, 2, 1, 3, 1, 2, 3],
    sudden: [0, 2, 3, 1, 2, 0, 3, 1],
    victory: [0, 1, 2, 3, 1, 2, 3, 2],
    defeat: [3, 2, 1, 0, 2, 1, 0, 1],
  } as const;

  for (let bar = 0; bar < spec.bars; bar++) {
    const start = bar * beat * 4;
    const barDuration = beat * 4;
    const chord = spec.progression[bar % spec.progression.length];
    const notes = chordNotes(spec, chord, 0);
    const highNotes = chordNotes(spec, chord, 2);
    const phraseSlice = phrase.filter(([pos]) => pos >= (bar % 2) * 16 && pos < (bar % 2) * 16 + 16);
    const intro = spec.loop && bar < 2;

    switch (spec.style) {
      case 'title':
        synth.pad(start, notes.map((m) => m + 24), barDuration, 0.026, 1100);
        for (let i = 0; i < 8; i++) synth.arp(start + i * beat * 0.5, highNotes[arpOrder.title[i] % highNotes.length], beat * 0.9, 0.046, i % 2 === 0 ? -0.38 : 0.38, 'triangle', 2600);
        if (!intro) {
          synth.kick(start, 0.52);
          synth.kick(start + beat * 2.5, 0.38);
          synth.snare(start + beat, 0.14);
          synth.snare(start + beat * 3, 0.16);
          for (let i = 0; i < 4; i++) synth.hat(start + i * beat + beat * 0.5, false, 0.04, 0.15);
          synth.bass(start, notes[0] + 12, beat * 1.6, 0.17, 760);
          synth.bass(start + beat * 2, notes[0] + 12, beat * 1.6, 0.17, 760);
        }
        if (bar % 2 === 0) synth.bell(start, highNotes[0], 0.03);
        break;
      case 'battle':
        synth.pad(start, notes.slice(0, 3).map((m) => m + 24), barDuration, 0.024, 1500);
        for (let i = 0; i < 4; i++) synth.kick(start + i * beat, 0.76);
        synth.snare(start + beat, 0.3);
        synth.snare(start + beat * 3, 0.32);
        for (let i = 0; i < 16; i++) synth.hat(start + i * step, i % 4 === 2, i % 2 === 0 ? 0.074 : 0.05, i % 2 === 0 ? 0.42 : -0.3);
        for (let i = 0; i < 8; i++) synth.bass(start + i * beat * 0.5, notes[0] + (i % 4 === 3 ? 12 : 0), beat * 0.46, 0.23, 1500);
        for (let i = 0; i < 16; i++) synth.arp(start + i * step, highNotes[arpOrder.battle[i % arpOrder.battle.length] % highNotes.length], step * 1.5, intro ? 0.03 : 0.05, (i % 4) / 2 - 0.75);
        if (!intro) {
          for (const [pos, degree, len] of phraseSlice) {
            const local = pos - (bar % 2) * 16;
            synth.lead(start + local * step, scaleNote(spec, degree, 2), len * step * 0.94, 0.056, 2600);
          }
        }
        break;
      case 'bossForm':
        synth.pad(start, notes.map((m) => m + 24), barDuration, 0.028, 1700);
        for (let i = 0; i < 4; i++) synth.kick(start + i * beat, 0.86);
        synth.snare(start + beat, 0.34);
        synth.snare(start + beat * 3, 0.36);
        synth.clap(start + beat * 3.5, 0.13);
        for (let i = 0; i < 16; i++) synth.hat(start + i * step, i % 4 === 1, i % 2 === 0 ? 0.092 : 0.056, i % 2 === 0 ? 0.34 : -0.26);
        for (let i = 0; i < 8; i++) synth.bass(start + i * beat * 0.5, notes[0] + 12, beat * 0.47, 0.28, 1900);
        for (let i = 0; i < 16; i++) synth.arp(start + i * step, highNotes[arpOrder.bossForm[i % arpOrder.bossForm.length] % highNotes.length] + 12, step * 1.8, intro ? 0.028 : 0.055, i % 4 < 2 ? -0.46 : 0.46, 'sawtooth', 3600);
        if (!intro) {
          for (const [pos, degree, len] of phraseSlice) {
            const local = pos - (bar % 2) * 16;
            synth.lead(start + local * step, scaleNote(spec, degree + 1, 2), len * step, 0.074, 3400);
          }
        }
        if (bar % 2 === 0) synth.bell(start, highNotes[0] + 12, 0.046);
        break;
      case 'sudden':
        synth.pad(start, notes.map((m) => m + 18), barDuration, 0.026, 1200);
        for (let i = 0; i < 4; i++) synth.kick(start + i * beat, 0.8);
        synth.snare(start + beat, 0.24);
        synth.snare(start + beat * 3, 0.24);
        synth.clap(start + beat * 3.5, 0.1);
        for (let i = 0; i < 16; i++) synth.hat(start + i * step, i % 4 === 3, i % 2 === 0 ? 0.08 : 0.045, i % 2 === 0 ? 0.26 : -0.26);
        for (let i = 0; i < 16; i++) synth.bass(start + i * step, notes[0], step * 0.92, 0.2, 1100);
        for (let i = 0; i < 16; i++) synth.arp(start + i * step, highNotes[arpOrder.sudden[i % arpOrder.sudden.length] % highNotes.length], step * 1.35, intro ? 0.024 : 0.04, i % 2 === 0 ? -0.24 : 0.24, 'square', 2100);
        synth.rise(start + beat * 3.1, beat * 0.7, 50, 62, 0.018);
        break;
      case 'victory':
        synth.pad(start, notes.map((m) => m + 24), barDuration, 0.028, 1700);
        synth.kick(start, 0.6);
        synth.kick(start + beat * 2, 0.48);
        synth.snare(start + beat * 3, 0.22);
        for (let i = 0; i < 8; i++) synth.arp(start + i * beat * 0.5, highNotes[arpOrder.victory[i] % highNotes.length] + 12, beat * 0.92, 0.06, i % 2 === 0 ? -0.36 : 0.36, 'triangle', 3400);
        synth.bell(start, highNotes[0] + 12, 0.06);
        synth.bell(start + beat * 1.5, highNotes[1] + 12, 0.05);
        if (bar === spec.bars - 1) synth.lead(start + beat * 2, scaleNote(spec, 6, 2), beat * 1.7, 0.08, 3200);
        break;
      case 'defeat':
        synth.pad(start, notes.map((m) => m + 12), barDuration, 0.022, 900);
        synth.kick(start, 0.36);
        synth.snare(start + beat * 2, 0.15);
        synth.bass(start, notes[0], beat * 3.4, 0.16, 620);
        for (let i = 0; i < 4; i++) synth.arp(start + i * beat, highNotes[arpOrder.defeat[i] % highNotes.length], beat * 1.25, 0.036, i % 2 === 0 ? -0.24 : 0.24, 'triangle', 1700);
        if (bar === spec.bars - 1) synth.rise(start + beat * 2.4, beat * 1.3, 60, 52, 0.012);
        break;
    }
  }
}

export async function renderTrack(track: Track | TrackSpec): Promise<AudioBuffer> {
  const spec = trackSpecOf(track);
  const loopSeconds = arrangementSeconds(spec);
  const beat = 60 / spec.bpm;
  const tailSeconds = spec.loop ? beat * LOOP_TAIL_BEATS : beat * STINGER_TAIL_BEATS;
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
