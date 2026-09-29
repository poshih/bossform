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
  await page.waitForFunction(() => (window as unknown as { __viewerReady?: boolean }).__viewerReady === true, null, { timeout: 60000 });
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
  directorCalls: string[];
}

const runChecks = () => page.evaluate(async () => {
  const audio = await import('/src/audio/audio.ts');
  const directorModule = await import('/src/audio/director.ts');
  const music = await import('/src/audio/music.ts');
  const synth = await import('/src/audio/synth.ts');
  const sim = await import('/src/sim/index.ts');

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
    const buffer = await music.renderTrack(name as keyof typeof music.TRACK_SPECS);
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
  engine.onMuteChange = (muted) => {
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
  const director = new directorModule.AudioDirector(fakeEngine as unknown as audio.AudioEngine);
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
      plFireCd: new Int32Array([sim.VANGUARD.rifle.interval, sim.JUGGERNAUT.mortar.interval]),
      plAltCd: new Int32Array([0, 0]),
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
      c: new Int32Array(6),
    },
  };
  world.m.world[sim.W.Phase] = sim.Phase.Battle;
  director.handleEvents(world as unknown as sim.World, 0);
  director.update(world as unknown as sim.World, 0, 1 / 60);

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
  director.handleEvents(endWorld as unknown as sim.World, 0);

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
  const durationOk = Math.abs(sfx.activeDuration - sfx.expected) < 0.09;
  const spectrumOk = sfx.centroid >= 50 && sfx.centroid <= 9000;
  const ok = durationOk && spectrumOk && sfx.finite && !sfx.silent && sfx.peak < 1;
  check(`sfx ${sfx.name}`, ok, `active=${sfx.activeDuration.toFixed(3)}s peak=${sfx.peak.toFixed(3)} centroid=${sfx.centroid.toFixed(0)}Hz`);
}

section('Windups');
for (const windup of result.windups) {
  check(`windup ${windup.name}`, Math.abs(windup.actual - windup.expected) < 0.06, `actual=${windup.actual.toFixed(3)}s expected=${windup.expected.toFixed(3)}s`);
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
