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
  peak: number;
  rms: number;
  finite: boolean;
  silent: boolean;
}

interface EvalResult {
  tracks: BufferReport[];
  sfx: BufferReport[];
  muteMasterGain: number;
  mutePersisted: string | null;
  muteCallback: boolean;
  muteRestored: boolean;
  preUnlockSafe: boolean;
  preUnlockDeferred: boolean;
  postUnlockSafe: boolean;
  runningAfterUnlock: boolean;
}

const runChecks = () => page.evaluate(async () => {
  // Resolved by the dev server inside the page; kept out of TypeScript's module resolution on purpose.
  const load = (path: string) => import(/* @vite-ignore */ path) as Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const audio = await load('/src/audio/audio.ts');
  const music = await load('/src/audio/music.ts');
  const synth = await load('/src/audio/synth.ts');

  const analyze = (name: string, buffer: AudioBuffer, expected: number): BufferReport => {
    let peak = 0;
    let energy = 0;
    let finite = true;
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      const data = buffer.getChannelData(channel);
      for (let i = 0; i < data.length; i++) {
        const value = data[i];
        if (!Number.isFinite(value)) finite = false;
        const abs = Math.abs(value);
        if (abs > peak) peak = abs;
        energy += value * value;
      }
    }
    const rms = Math.sqrt(energy / Math.max(1, buffer.length * buffer.numberOfChannels));
    return { name, duration: buffer.duration, expected, peak, rms, finite, silent: peak < 1e-4 };
  };

  const tracks: BufferReport[] = [];
  for (const [name, spec] of Object.entries(music.TRACK_SPECS)) {
    const buffer = await music.renderTrack(name as keyof typeof music.TRACK_SPECS);
    tracks.push(analyze(name, buffer, music.getTrackDuration(spec)));
  }

  const sfx: BufferReport[] = [];
  for (const name of audio.SFX_NAMES) {
    const buffer = await audio.renderSfxBuffer(name);
    const spec = synth.SFX_SPECS[name];
    sfx.push(analyze(name, buffer, spec.duration));
  }

  localStorage.removeItem('bossform.muted');
  const cold = new audio.AudioEngine();
  let preUnlockSafe = true;
  try {
    cold.play('shotRifle');
    cold.playMusic('stage1');
    cold.stopMusic();
    cold.setBeam(true);
    cold.setBeam(false);
  } catch {
    preUnlockSafe = false;
  }
  cold.playMusic('stage1');
  const preUnlockDeferred = !cold.running;
  cold.unlock();
  await new Promise((resolve) => setTimeout(resolve, 80));
  const runningAfterUnlock = cold.running;
  let postUnlockSafe = true;
  try {
    for (const name of audio.SFX_NAMES) cold.play(name, { pan: 0.25, volume: 0.8 });
    cold.playMusic('stage1', 0.1);
    cold.playMusic('stage1', 0.1);
    cold.playMusic('bossMode', 0.1);
    cold.setBeam(true);
    cold.setBeam(false);
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

  cold.dispose();
  engine.dispose();
  return {
    tracks,
    sfx,
    muteMasterGain,
    mutePersisted,
    muteCallback,
    muteRestored,
    preUnlockSafe,
    preUnlockDeferred,
    postUnlockSafe,
    runningAfterUnlock,
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
  const ok = durationOk && track.finite && !track.silent && track.peak < 1;
  check(`track ${track.name}`, ok, `dur=${track.duration.toFixed(3)}s peak=${track.peak.toFixed(3)} rms=${track.rms.toFixed(3)}`);
}

section('SFX');
for (const sfx of result.sfx) {
  const durationOk = sfx.duration >= sfx.expected && sfx.duration <= sfx.expected + 0.25;
  const ok = durationOk && sfx.finite && !sfx.silent && sfx.peak < 1;
  check(`sfx ${sfx.name}`, ok, `dur=${sfx.duration.toFixed(3)}s peak=${sfx.peak.toFixed(3)} rms=${sfx.rms.toFixed(3)}`);
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
check('page emitted no warnings or errors', problems.length === 0, problems[0] ?? 'clean');

if (problems.length > 0) {
  section('Console problems');
  for (const problem of problems) info(problem);
}

await browser.close();
finish('audio');
