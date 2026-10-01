import { fx } from '@metronome/engine';
import {
  Attack,
  AttackPhase,
  Banner,
  BeamKind,
  COUNTDOWN_TICKS,
  Ev,
  FireSlot,
  Form,
  FORMS,
  FRAME_COUNT,
  Phase,
  PRISM,
  ReflectKind,
  TICK_RATE,
  W,
} from '../sim/index.ts';
import { AudioEngine, LAYER_NAMES } from './audio.ts';
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
/** Live beams hum within this distance of the listener; a robot's thin beam sings higher than a colossus's. */
const BEAM_LAYER_DISTANCE = 560;
const BEAM_LAYER_MIN_GAIN = 0.07;
const BEAM_LAYER_MAX_GAIN = 0.2;
const ROBOT_BEAM_PITCH = 1.35;
const BOSS_BEAM_PITCH = 0.72;
const STINGER_FADE_SECONDS = 0.12;

/**
 * The sound of each robot's Ev.Fire, by frame: its primary, and its alt when the alt fires something. An alt with an event of
 * its own (phase dash, bulwark, parry, shadow veil) never sends Ev.Fire, so it has no entry.
 */
const FIRE_SFX: readonly { readonly primary: Sfx; readonly alt: Sfx | null }[] = [
  { primary: 'shotVanguard', alt: 'seekerLaunch' },
  { primary: 'shotGale', alt: null },
  { primary: 'shotJuggernaut', alt: null },
  { primary: 'shotLongbow', alt: 'mineDrop' },
  { primary: 'beamTell', alt: 'lanceTell' },
  { primary: 'shotHailstorm', alt: 'carpetLaunch' },
  { primary: 'shotRonin', alt: null },
  { primary: 'shotShade', alt: null },
  { primary: 'shotGauntlet', alt: 'rocketPunch' },
];
if (FIRE_SFX.length !== FRAME_COUNT) throw new RangeError(`FIRE_SFX lists ${FIRE_SFX.length} frames, the simulation has ${FRAME_COUNT}`);

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
  private viewerTeam = 0;

  constructor(engine: AudioEngine) {
    this.engine = engine;
  }

  /**
   * Every loop layer off at once, with no closing sound: the match they described is over (App.leaveRun). Only update() turns
   * layers on or off, and it does not run on the title screen, so a layer left on would play there until the next match.
   */
  silence(): void {
    for (const name of LAYER_NAMES) this.engine.setLayer(name, { active: false });
    this.ultimaLayerActive = false;
  }

  /**
   * `localSeat` is the listener (the pilot the camera follows); `viewerTeam` the team a cloaked pilot's sounds are kept from:
   * the local pilot's, even while it spectates someone else after dying (App), else the listener's.
   */
  handleEvents(world: World, localSeat: number, viewerTeam = world.m.plTeam[localSeat]): void {
    this.viewerTeam = viewerTeam;
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
          // A shot gives a cloaked pilot away anyway (it breaks the veil): shots are always heard.
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
          this.shipSound(world, { sfx: 'hit', x, y, seat: a, localSeat, style: NORMAL_STYLE });
          break;
        case Ev.Blocked:
          this.shipSound(world, { sfx: 'blocked', x, y, seat: a, localSeat, style: NORMAL_STYLE });
          break;
        case Ev.PartHit:
          this.playSpatial(world, { sfx: 'partHit', x, y, seat: a, localSeat, style: BIG_LOWER_STYLE });
          break;
        case Ev.PartDown:
          this.playSpatial(world, { sfx: 'partDown', x, y, seat: a, localSeat, style: BIG_STYLE });
          break;
        case Ev.Graze:
          this.shipSound(world, { sfx: 'graze', x, y, seat: a, localSeat, style: NORMAL_STYLE });
          break;
        case Ev.Absorb:
          this.shipSound(world, { sfx: 'absorb', x, y, seat: a, localSeat, style: NORMAL_STYLE });
          break;
        case Ev.Death:
          this.shipSound(world, {
            sfx: 'death',
            x,
            y,
            seat: a,
            localSeat,
            style: this.bossEndedSeats.includes(a) ? BIG_STYLE : NORMAL_STYLE,
          });
          break;
        case Ev.Respawn:
          this.shipSound(world, { sfx: 'respawn', x, y, seat: a, localSeat, style: NORMAL_STYLE });
          break;
        case Ev.Left:
          this.engine.play('uiClick', { volume: 0.25 });
          break;
        case Ev.MorphStart:
          this.shipSound(world, { sfx: 'morphStart', x, y, seat: a, localSeat, style: BIG_LOWER_STYLE });
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
          this.shipSound(world, { sfx: 'orbPickup', x, y, seat: a, localSeat, style: NORMAL_STYLE });
          break;
        case Ev.Dash:
          this.shipSound(world, { sfx: 'dash', x, y, seat: a, localSeat, style: NORMAL_STYLE });
          break;
        case Ev.Boost:
          this.shipSound(world, { sfx: 'boost', x, y, seat: a, localSeat, style: NORMAL_STYLE });
          break;
        case Ev.ShieldHit:
          this.shipSound(world, { sfx: 'shieldHit', x, y, seat: a, localSeat, style: NORMAL_STYLE });
          break;
        case Ev.ShieldBreak:
          this.shipSound(world, { sfx: 'shieldBreak', x, y, seat: a, localSeat, style: NORMAL_STYLE });
          break;
        case Ev.ShieldUp:
          // Your own shield coming back is feedback for you; everyone else's would be noise.
          if (a === localSeat) this.engine.play('shieldUp');
          break;
        case Ev.BulwarkUp:
          this.shipSound(world, { sfx: 'bulwarkRaise', x, y, seat: a, localSeat, style: NORMAL_STYLE });
          break;
        case Ev.Burst:
          this.playSpatial(world, { sfx: 'burst', x, y, seat: -1, localSeat, style: NORMAL_STYLE });
          break;
        case Ev.ChargeFull:
          this.shipSound(world, { sfx: 'chargeFull', x, y, seat: a, localSeat, style: NORMAL_STYLE });
          break;
        case Ev.ParryUp:
          this.shipSound(world, { sfx: 'parry', x, y, seat: a, localSeat, style: NORMAL_STYLE });
          break;
        case Ev.Reflect:
          this.playSpatial(world, { sfx: c === ReflectKind.Beam ? 'beamCut' : 'reflect', x, y, seat: a, localSeat, style: NORMAL_STYLE });
          break;
        case Ev.Cloak:
          // The veil drops over the pilot as it is made: only its own team hears it go.
          this.shipSound(world, { sfx: 'cloak', x, y, seat: a, localSeat, style: NORMAL_STYLE });
          break;
        case Ev.Reveal:
          this.playSpatial(world, { sfx: 'reveal', x, y, seat: a, localSeat, style: NORMAL_STYLE });
          break;
        case Ev.Catch:
          this.shipSound(world, { sfx: 'fistCatch', x, y, seat: a, localSeat, style: b > 0 ? BIG_LOWER_STYLE : NORMAL_STYLE });
          break;
        case Ev.Blast:
          // Heard where it lands, like a burst: a pilot's own shells blast far from it, so never as its own close sound.
          this.playSpatial(world, { sfx: 'blast', x, y, seat: -1, localSeat, style: a >= 0 && world.m.plForm[a] === Form.Boss ? BIG_LOWER_STYLE : NORMAL_STYLE });
          break;
        case Ev.BeamOn:
          this.playBeamOn(world, { x, y, seat: a, localSeat }, c);
          break;
        case Ev.LanceFire:
          // x, y is the rail's far end; the crack comes from the gun.
          this.playSpatial(world, { sfx: 'lanceCrack', x: world.m.plX[a], y: world.m.plY[a], seat: a, localSeat, style: NORMAL_STYLE });
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
    this.updateBeamLayer(world, localSeat);
  }

  private fireSfx(frame: number, slot: number): Sfx {
    const sounds = FIRE_SFX[frame];
    const sfx = slot === FireSlot.Alt ? sounds.alt : sounds.primary;
    if (sfx === null) throw new RangeError(`frame ${frame} has no sound for fire slot ${slot}`);
    return sfx;
  }

  /** A beam lit (Ev.BeamOn): PRISM's beam and a colossus's have their own ignition; the lance is heard by its crack (Ev.LanceFire). */
  private playBeamOn(world: World, at: Omit<SpatialSound, 'sfx' | 'style'>, source: number): void {
    switch (source) {
      case BeamKind.Primary:
        this.playSpatial(world, { ...at, sfx: 'beamOn', style: NORMAL_STYLE });
        return;
      case BeamKind.Lance:
        return;
      case BeamKind.Boss:
        this.playSpatial(world, { ...at, sfx: 'bossBeam', style: BIG_STYLE });
        return;
      default:
        throw new RangeError(`unknown beam source ${source}`);
    }
  }

  /**
   * A sound a ship makes by being there (moving, grazing, taking a hit, picking up an orb...). A cloaked pilot makes none that
   * its opponents (other teams than the viewer's) can hear: only its shots and its reveal reach them (see Ev.Fire and Ev.Reveal).
   */
  private shipSound(world: World, sound: SpatialSound): void {
    const { m } = world;
    const seat = sound.seat;
    if (seat >= 0 && m.plCloak[seat] > 0 && m.plTeam[seat] !== this.viewerTeam) return;
    this.playSpatial(world, sound);
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

  /** The hum of the loudest live beam near the listener: PRISM's firing beam, or a colossus pod's beam (salvo, siege, wheel). */
  private updateBeamLayer(world: World, localSeat: number): void {
    const { m } = world;
    const localX = float(m.plX[localSeat]);
    const localY = float(m.plY[localSeat]);
    let bestWeight = 0;
    let bestPan = 0;
    let bestPitch = ROBOT_BEAM_PITCH;
    for (let seat = 0; seat < world.seats; seat++) {
      if (m.plAlive[seat] !== 1) continue;
      const robotBeam = m.plForm[seat] === Form.Normal && m.plBeam[seat] > PRISM.beam.tell;
      if (!robotBeam && !(m.plForm[seat] === Form.Boss && this.bossBeaming(world, seat))) continue;
      const dx = float(m.plX[seat]) - localX;
      const dy = float(m.plY[seat]) - localY;
      const weight = seat === localSeat ? 1 : Math.max(0, 1 - Math.hypot(dx, dy) / BEAM_LAYER_DISTANCE);
      if (weight <= bestWeight) continue;
      bestWeight = weight;
      bestPan = seat === localSeat ? 0 : clamp(dx / PAN_DISTANCE, -1, 1);
      bestPitch = robotBeam ? ROBOT_BEAM_PITCH : BOSS_BEAM_PITCH;
    }
    const state: LayerState = bestWeight > 0
      ? { active: true, gain: BEAM_LAYER_MIN_GAIN + (BEAM_LAYER_MAX_GAIN - BEAM_LAYER_MIN_GAIN) * bestWeight, pitch: bestPitch, pan: bestPan }
      : { active: false };
    this.engine.setLayer('beamHum', state);
  }

  private bossBeaming(world: World, seat: number): boolean {
    const base = world.partBase(seat);
    const parts = FORMS[world.m.plFrame[seat]].parts.length;
    for (let part = 0; part < parts; part++) if (world.m.ptBeamLen[base + part] > 0) return true;
    return false;
  }
}
