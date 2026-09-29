import { fx } from '@metronome/engine';
import {
  Attack,
  AttackPhase,
  Banner,
  COUNTDOWN_TICKS,
  Ev,
  FireSlot,
  Form,
  Frame,
  Phase,
  TICK_RATE,
  W,
} from '../sim/index.ts';
import { AudioEngine } from './audio.ts';
import { getTrackDuration } from './music.ts';
import { bossReleaseSfx, bossWindupSfx, clamp } from './synth.ts';
import type { LayerState, Sfx, Track } from './audio.ts';
import type { World } from '../sim/index.ts';

const FIXED_SCALE = 65536;
const PAN_DISTANCE = 220;
const NORMAL_REFERENCE_DISTANCE = 160;
const NORMAL_MAX_DISTANCE = 620;
const BOSS_REFERENCE_DISTANCE = 360;
const BOSS_MAX_DISTANCE = 920;
const BOSS_MIN_ARENA_GAIN = 0.18;
const BOSS_TRACK_DISTANCE = 360;
const ULTIMA_LAYER_DISTANCE = 680;
const LOCAL_BOSS_DRONE_MIN_GAIN = 0.06;
const LOCAL_BOSS_DRONE_MAX_GAIN = 0.22;
const LOCAL_BOSS_DRONE_MIN_PITCH = 0.72;
const LOCAL_BOSS_DRONE_MAX_PITCH = 1.18;
const ULTIMA_LAYER_MIN_GAIN = 0.1;
const ULTIMA_LAYER_MAX_GAIN = 0.28;
const ULTIMA_LAYER_MIN_PITCH = 0.84;
const ULTIMA_LAYER_MAX_PITCH = 1.18;
const STINGER_FADE_SECONDS = 0.12;

interface SpatialStyle {
  readonly baseVolume: number;
  readonly referenceDistance: number;
  readonly maxDistance: number;
  readonly arenaWide: boolean;
  readonly minimumArenaGain: number;
}

interface SpatialSound {
  readonly sfx: Sfx;
  readonly x: number;
  readonly y: number;
  readonly seat: number;
  readonly style: SpatialStyle;
  readonly localSeat: number;
}

const NORMAL_STYLE: SpatialStyle = {
  baseVolume: 1,
  referenceDistance: NORMAL_REFERENCE_DISTANCE,
  maxDistance: NORMAL_MAX_DISTANCE,
  arenaWide: false,
  minimumArenaGain: 0,
};

const BIG_STYLE: SpatialStyle = {
  baseVolume: 1,
  referenceDistance: BOSS_REFERENCE_DISTANCE,
  maxDistance: BOSS_MAX_DISTANCE,
  arenaWide: true,
  minimumArenaGain: BOSS_MIN_ARENA_GAIN,
};

const BIG_LOWER_STYLE: SpatialStyle = {
  baseVolume: 0.8,
  referenceDistance: BOSS_REFERENCE_DISTANCE,
  maxDistance: BOSS_MAX_DISTANCE,
  arenaWide: true,
  minimumArenaGain: 0.12,
};

function float(value: number): number {
  return fx.toFloat ? fx.toFloat(value) : value / FIXED_SCALE;
}

function phaseTrack(phase: number): Track | null {
  if (phase === Phase.Countdown) return 'title';
  if (phase !== Phase.Battle) return null;
  return 'battle';
}

export class AudioDirector {
  private readonly engine: AudioEngine;
  private lastCountdownSecond = 0;
  private stingerRemaining = 0;
  private bossEndedSeats: number[] = [];
  private ultimaLayerActive = false;

  constructor(engine: AudioEngine) {
    this.engine = engine;
  }

  handleEvents(world: World, localSeat: number): void {
    this.bossEndedSeats = [];
    for (let i = 0; i < world.events.count; i++) {
      const type = world.events.type[i];
      const x = world.events.x[i];
      const y = world.events.y[i];
      const a = world.events.a[i];
      const b = world.events.b[i];
      const c = world.events.c[i];
      switch (type) {
        case Ev.Fire:
          this.playSpatial(world, {
            sfx: this.fireSfx(b, c),
            x,
            y,
            seat: a,
            localSeat,
            style: NORMAL_STYLE,
          });
          break;
        case Ev.Hit:
        case Ev.StormHit:
          this.playSpatial(world, { sfx: 'hit', x, y, seat: a, localSeat, style: NORMAL_STYLE });
          break;
        case Ev.Blocked:
          this.playSpatial(world, { sfx: 'blocked', x, y, seat: a, localSeat, style: NORMAL_STYLE });
          break;
        case Ev.PartHit:
          this.playSpatial(world, { sfx: 'partHit', x, y, seat: a, localSeat, style: BIG_LOWER_STYLE });
          break;
        case Ev.PartDown:
          this.playSpatial(world, { sfx: 'partDown', x, y, seat: a, localSeat, style: BIG_STYLE });
          break;
        case Ev.Graze:
          this.playSpatial(world, { sfx: 'graze', x, y, seat: a, localSeat, style: NORMAL_STYLE });
          break;
        case Ev.Absorb:
          this.playSpatial(world, { sfx: 'absorb', x, y, seat: a, localSeat, style: NORMAL_STYLE });
          break;
        case Ev.Death:
          this.playSpatial(world, {
            sfx: 'death',
            x,
            y,
            seat: a,
            localSeat,
            style: this.bossEndedSeats.includes(a) ? BIG_STYLE : NORMAL_STYLE,
          });
          break;
        case Ev.Respawn:
          this.playSpatial(world, { sfx: 'respawn', x, y, seat: a, localSeat, style: NORMAL_STYLE });
          break;
        case Ev.Left:
          this.engine.play('uiClick', { volume: 0.25 });
          break;
        case Ev.MorphStart:
          this.playSpatial(world, { sfx: 'morphStart', x, y, seat: a, localSeat, style: BIG_LOWER_STYLE });
          break;
        case Ev.MorphDone:
          this.playSpatial(world, { sfx: 'morphDone', x, y, seat: a, localSeat, style: BIG_STYLE });
          break;
        case Ev.BossEnd:
          this.bossEndedSeats.push(a);
          this.playSpatial(world, { sfx: 'bossEnd', x, y, seat: a, localSeat, style: BIG_STYLE });
          break;
        case Ev.Windup: {
          const frame = world.m.plFrame[a];
          const attack = b;
          const sfx = bossWindupSfx(frame, attack);
          const style = attack === Attack.Salvo ? BIG_LOWER_STYLE : BIG_STYLE;
          this.playSpatial(world, { sfx, x, y, seat: a, localSeat, style });
          break;
        }
        case Ev.Release:
          this.playSpatial(world, {
            sfx: bossReleaseSfx(b),
            x,
            y,
            seat: a,
            localSeat,
            style: b === Attack.Salvo ? BIG_LOWER_STYLE : BIG_STYLE,
          });
          break;
        case Ev.PodFire:
          this.playSpatial(world, { sfx: 'podFire', x, y, seat: a, localSeat, style: BIG_LOWER_STYLE });
          break;
        case Ev.NeutralHit:
          this.playSpatial(world, { sfx: 'neutralHit', x, y, seat: -1, localSeat, style: NORMAL_STYLE });
          break;
        case Ev.NeutralKilled:
          this.playSpatial(world, { sfx: 'neutralKilled', x, y, seat: -1, localSeat, style: BIG_LOWER_STYLE });
          break;
        case Ev.NeutralFire:
          this.playSpatial(world, { sfx: 'neutralFire', x, y, seat: -1, localSeat, style: NORMAL_STYLE });
          break;
        case Ev.OrbPickup:
          this.playSpatial(world, { sfx: 'orbPickup', x, y, seat: a, localSeat, style: NORMAL_STYLE });
          break;
        case Ev.Dash:
          this.playSpatial(world, { sfx: 'dash', x, y, seat: a, localSeat, style: NORMAL_STYLE });
          break;
        case Ev.BulwarkUp:
          this.playSpatial(world, { sfx: 'bulwarkRaise', x, y, seat: a, localSeat, style: NORMAL_STYLE });
          break;
        case Ev.Burst:
          this.playSpatial(world, { sfx: 'burst', x, y, seat: -1, localSeat, style: NORMAL_STYLE });
          break;
        case Ev.StormStart:
          this.engine.play('stormAlarm');
          break;
        case Ev.Banner:
          this.handleBanner(a);
          break;
        case Ev.RoundEnd:
          this.handleRoundEnd(world, localSeat, a, b === 1);
          break;
        default:
          break;
      }
    }
  }

  update(world: World, localSeat: number, dtSeconds: number): void {
    if (this.stingerRemaining > 0) this.stingerRemaining = Math.max(0, this.stingerRemaining - dtSeconds);

    const phase = world.m.world[W.Phase];
    this.updateCountdown(world);
    this.updateMusic(world, localSeat, phase);
    this.updateBossDrone(world, localSeat);
    this.updateUltimaLayer(world, localSeat);
  }

  private fireSfx(frame: number, slot: number): Sfx {
    if (slot === FireSlot.Alt) return 'seekerLaunch';
    if (frame === Frame.Vanguard) return 'shotVanguard';
    if (frame === Frame.Gale) return 'shotGale';
    return 'shotJuggernaut';
  }

  private playSpatial(world: World, sound: SpatialSound): void {
    const localX = float(world.m.plX[sound.localSeat]);
    const localY = float(world.m.plY[sound.localSeat]);
    if (sound.seat === sound.localSeat) {
      this.engine.play(sound.sfx, { pan: 0, volume: sound.style.baseVolume });
      return;
    }
    const dx = float(sound.x) - localX;
    const dy = float(sound.y) - localY;
    const distance = Math.hypot(dx, dy);
    const attenuation = this.attenuation(distance, sound.style);
    if (attenuation <= 0) return;
    this.engine.play(sound.sfx, {
      pan: clamp(dx / PAN_DISTANCE, -1, 1),
      volume: attenuation * sound.style.baseVolume,
    });
  }

  private attenuation(distance: number, style: SpatialStyle): number {
    if (distance <= 0.001) return 1;
    if (style.arenaWide) {
      const shaped = 1 / (1 + Math.pow(distance / style.referenceDistance, 1.3));
      return Math.max(style.minimumArenaGain, shaped);
    }
    if (distance >= style.maxDistance) return 0;
    const linear = 1 - distance / style.maxDistance;
    const curved = linear * linear;
    const nearBoost = 1 / (1 + Math.pow(distance / style.referenceDistance, 1.1));
    return curved * Math.max(0.15, nearBoost);
  }

  private handleBanner(banner: number): void {
    switch (banner) {
      case Banner.Round:
        this.engine.play('uiConfirm', { volume: 0.35 });
        break;
      case Banner.Fight:
        this.engine.play('fight');
        break;
      case Banner.RoundWon:
        this.engine.play('roundWon');
        break;
      case Banner.Draw:
        this.engine.play('roundDraw');
        break;
      case Banner.MatchWon:
        this.engine.play('matchWon');
        break;
      case Banner.TimeUp:
        this.engine.play('stormAlarm', { volume: 0.7 });
        break;
      default:
        break;
    }
  }

  private handleRoundEnd(world: World, localSeat: number, winnerTeam: number, matchOver: boolean): void {
    const localTeam = world.m.plTeam[localSeat];
    let sfx: Sfx;
    let track: Track;
    if (winnerTeam < 0) {
      sfx = 'roundDraw';
      track = 'defeat';
    } else if (winnerTeam === localTeam) {
      sfx = matchOver ? 'matchWon' : 'roundWon';
      track = 'victory';
    } else {
      sfx = 'defeat';
      track = 'defeat';
    }
    this.engine.play(sfx);
    this.engine.playMusic(track, STINGER_FADE_SECONDS);
    this.stingerRemaining = getTrackDuration(track);
  }

  private updateCountdown(world: World): void {
    const phase = world.m.world[W.Phase];
    if (phase !== Phase.Countdown) {
      this.lastCountdownSecond = 0;
      return;
    }
    const timer = world.m.world[W.PhaseTimer];
    const secondsLeft = clamp(Math.ceil(timer / TICK_RATE), 0, COUNTDOWN_TICKS / TICK_RATE);
    if (secondsLeft === this.lastCountdownSecond) return;
    this.lastCountdownSecond = secondsLeft;
    if (secondsLeft === 3) this.engine.play('count3');
    else if (secondsLeft === 2) this.engine.play('count2');
    else if (secondsLeft === 1) this.engine.play('count1');
  }

  private updateMusic(world: World, localSeat: number, phase: number): void {
    if (this.stingerRemaining > 0) return;
    const base = phaseTrack(phase);
    if (base === null) {
      this.engine.stopMusic(0.35);
      return;
    }
    if (phase === Phase.Battle) {
      const sudden = world.m.world[W.SafeR] < world.arenaR;
      if (sudden) {
        this.engine.playMusic('sudden', 0.45);
        return;
      }
      if (this.anyNearbyBoss(world, localSeat)) {
        this.engine.playMusic('bossForm', 0.45);
        return;
      }
    }
    this.engine.playMusic(base, 0.45);
  }

  private anyNearbyBoss(world: World, localSeat: number): boolean {
    const localX = float(world.m.plX[localSeat]);
    const localY = float(world.m.plY[localSeat]);
    for (let seat = 0; seat < world.seats; seat++) {
      if (world.m.plAlive[seat] !== 1 || world.m.plForm[seat] !== Form.Boss) continue;
      if (seat === localSeat) return true;
      const dx = float(world.m.plX[seat]) - localX;
      const dy = float(world.m.plY[seat]) - localY;
      if (Math.hypot(dx, dy) <= BOSS_TRACK_DISTANCE) return true;
    }
    return false;
  }

  private updateBossDrone(world: World, localSeat: number): void {
    if (world.m.plForm[localSeat] !== Form.Boss) {
      this.engine.setLayer('bossDrone', { active: false });
      return;
    }
    const fuel = clamp(world.m.plGauge[localSeat] / 100000, 0, 1);
    this.engine.setLayer('bossDrone', {
      active: true,
      gain: LOCAL_BOSS_DRONE_MIN_GAIN + (LOCAL_BOSS_DRONE_MAX_GAIN - LOCAL_BOSS_DRONE_MIN_GAIN) * fuel,
      pitch: LOCAL_BOSS_DRONE_MIN_PITCH + (LOCAL_BOSS_DRONE_MAX_PITCH - LOCAL_BOSS_DRONE_MIN_PITCH) * fuel,
      pan: 0,
    });
  }

  private updateUltimaLayer(world: World, localSeat: number): void {
    const localX = float(world.m.plX[localSeat]);
    const localY = float(world.m.plY[localSeat]);
    let bestGain = 0;
    let bestPan = 0;
    let bestPitch = ULTIMA_LAYER_MIN_PITCH;
    for (let seat = 0; seat < world.seats; seat++) {
      if (world.m.plAlive[seat] !== 1 || world.m.plAtk[seat] !== Attack.Ultima || world.m.plAtkPhase[seat] !== AttackPhase.Release) continue;
      if (seat === localSeat) {
        bestGain = ULTIMA_LAYER_MAX_GAIN;
        bestPan = 0;
        bestPitch = ULTIMA_LAYER_MAX_PITCH;
        break;
      }
      const dx = float(world.m.plX[seat]) - localX;
      const dy = float(world.m.plY[seat]) - localY;
      const distance = Math.hypot(dx, dy);
      const weight = Math.max(0, 1 - distance / ULTIMA_LAYER_DISTANCE);
      if (weight <= bestGain) continue;
      bestGain = ULTIMA_LAYER_MIN_GAIN + (ULTIMA_LAYER_MAX_GAIN - ULTIMA_LAYER_MIN_GAIN) * weight;
      bestPan = clamp(dx / PAN_DISTANCE, -1, 1);
      bestPitch = ULTIMA_LAYER_MIN_PITCH + (ULTIMA_LAYER_MAX_PITCH - ULTIMA_LAYER_MIN_PITCH) * weight;
    }
    const state: LayerState = bestGain > 0
      ? { active: true, gain: bestGain, pitch: bestPitch, pan: bestPan }
      : { active: false };
    if (this.ultimaLayerActive && !state.active) this.engine.play('ultimaClose', { volume: 0.5 });
    this.ultimaLayerActive = state.active;
    this.engine.setLayer('ultimaBarrage', state);
  }
}
