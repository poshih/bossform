import { chromium } from 'playwright';
import { check, finish, info, section } from './lib.ts';

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage();
const problems: string[] = [];
page.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') problems.push(`[${message.type()}] ${message.text()}`);
});
page.on('pageerror', (error) => problems.push(`[pageerror] ${error.message}`));

async function openViewer(): Promise<void> {
  await page.goto('http://127.0.0.1:4427/viewer.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(500);
}

await openViewer();

interface BufferReport {
  name: string;
  duration: number;
  expected: number;
  activeDuration: number;
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
  TRACK_SPECS: Record<string, unknown>;
  renderTrack(name: string): Promise<AudioBuffer>;
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

  const analyze = (name: string, buffer: AudioBuffer, expected: number): BufferReport => {
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
    return {
      name,
      duration: buffer.duration,
      expected,
      activeDuration,
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
  for (const [name, spec] of Object.entries(music.TRACK_SPECS)) {
    const buffer = await music.renderTrack(name);
    tracks.push(analyze(name, buffer, music.getTrackDuration(spec)));
  }

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
    directorCalls,
  } satisfies EvalResult;
});

let result: EvalResult;
try {
  result = await runChecks();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.includes('Execution context was destroyed')) throw error;
  await openViewer();
  result = await runChecks();
}

section('Tracks');
for (const track of result.tracks) {
  const durationOk = Math.abs(track.duration - track.expected) < 0.03;
  const spectrumOk = track.centroid >= 80 && track.centroid <= 7000 && track.lowShare > 0.01 && track.highShare > 0.01;
  const ok = durationOk && spectrumOk && track.finite && !track.silent && track.peak < 1;
  check(`track ${track.name}`, ok, `dur=${track.duration.toFixed(3)}s peak=${track.peak.toFixed(3)} centroid=${track.centroid.toFixed(0)}Hz`);
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
check('director maps core cues', result.directorCalls.includes('play:shotVanguard')
  && result.directorCalls.some((call) => call.startsWith('play:ultimaWindup'))
  && result.directorCalls.includes('play:siegeRelease')
  && result.directorCalls.includes('play:stormAlarm')
  && result.directorCalls.includes('play:matchWon')
  && result.directorCalls.includes('play:fight')
  && result.directorCalls.includes('music:bossForm')
  && result.directorCalls.includes('layer:ultimaBarrage:on'));
check('page emitted no warnings or errors', problems.length === 0, problems[0] ?? 'clean');

if (problems.length > 0) {
  section('Console problems');
  for (const problem of problems) info(problem);
}

await browser.close();
finish('audio');
