import * as THREE from 'three';
import { Pipeline } from '../render/pipeline.ts';
import { ArenaFloor } from '../render/arena.ts';
import { FollowCamera } from '../render/camera.ts';
import { Ev, Form, Frame, VANGUARD, type World } from '../sim/index.ts';
import { FxView } from './fx.ts';
import { NeutralsView } from './neutrals.ts';
import { OrbsView } from './orbs.ts';
import { ProjectilesView } from './projectiles.ts';
import { WorldSnapshot } from './snapshot.ts';
import { ShipsView } from './ships.ts';
import { expStep, lerp, lerpBinaryAngle, toWorld } from './shared.ts';

const FIRE_DECAY = 8;
const ALT_DECAY = 5;
const TELEGRAPH_DECAY = 4;
const HIT_SHAKE = 0.38;
const BLOCK_SHAKE = 0.14;
const PART_SHAKE = 0.28;
const PART_DOWN_SHAKE = 0.75;
const DEATH_SHAKE = 1.35;
const MORPH_SHAKE = 0.65;
const BOSS_END_SHAKE = 1.0;
const DASH_SHAKE = 0.25;
const BULWARK_SHAKE = 0.18;
const SIEGE_SHAKE = 1.2;
const ULTIMA_SHAKE = 1.9;
const STORM_SHAKE = 0.22;

export class Stage {
  private readonly pipeline: Pipeline;
  private readonly scene = new THREE.Scene();
  private readonly camera: FollowCamera;
  private readonly arena: ArenaFloor;
  private readonly ships: ShipsView;
  private readonly projectiles: ProjectilesView;
  private readonly neutrals: NeutralsView;
  private readonly orbs: OrbsView;
  private readonly fx: FxView;
  private worldRef: World;
  private previous: WorldSnapshot;
  private current: WorldSnapshot;
  private focusSeatIndex = 0;
  private timeSeconds = 0;
  private readonly firePulse: Float32Array;
  private readonly altPulse: Float32Array;
  private readonly neutralTelegraph: Float32Array;
  private readonly shipScratch = { x: 0, y: 0, vx: 0, vy: 0, aim: 0, alive: true, boss: false };

  constructor(canvas: HTMLCanvasElement, world: World) {
    this.worldRef = world;
    this.pipeline = new Pipeline(canvas);
    this.camera = new FollowCamera(world);
    this.arena = new ArenaFloor(world);
    this.ships = new ShipsView(world.seats);
    this.projectiles = new ProjectilesView(world);
    this.neutrals = new NeutralsView(world.cap.neutrals);
    this.orbs = new OrbsView(world);
    this.fx = new FxView();
    this.previous = new WorldSnapshot(world);
    this.current = new WorldSnapshot(world);
    this.firePulse = new Float32Array(world.seats);
    this.altPulse = new Float32Array(world.seats);
    this.neutralTelegraph = new Float32Array(world.cap.neutrals);

    this.scene.add(this.arena.mesh);
    this.scene.add(this.orbs.mesh);
    this.scene.add(this.projectiles.mesh);
    this.scene.add(this.neutrals.root);
    this.scene.add(this.ships.root);
    this.scene.add(this.fx.root);
    this.ships.setTeams(this.current);
  }

  focus(seat: number): void {
    if (seat < 0 || seat >= this.current.seats) throw new RangeError(`seat ${seat} is out of range`);
    this.focusSeatIndex = seat;
  }

  resize(cssWidth: number, cssHeight: number, devicePixelRatio: number): void {
    this.pipeline.resize(cssWidth, cssHeight, devicePixelRatio);
    this.camera.resize(cssWidth, cssHeight);
  }

  tick(world: World): void {
    this.worldRef = world;
    const swap = this.previous;
    this.previous = this.current;
    this.current = swap;
    this.current.copyFrom(world);
    this.ships.setTeams(this.current);
  }

  handleEvents(world: World): void {
    this.fx.handleEvents(world, this.focusSeatIndex);
    for (let i = 0; i < world.events.count; i++) {
      const type = world.events.type[i];
      const seat = world.events.a[i];
      switch (type) {
        case Ev.Fire:
          this.firePulse[seat] = 1;
          if (world.m.plFrame[seat] === Frame.Vanguard && world.m.plAltCd[seat] === VANGUARD.seekers.cooldown) this.altPulse[seat] = 1;
          break;
        case Ev.Hit:
          this.camera.impulse(HIT_SHAKE);
          break;
        case Ev.Blocked:
          this.camera.impulse(BLOCK_SHAKE);
          break;
        case Ev.PartHit:
          this.camera.impulse(PART_SHAKE);
          break;
        case Ev.PartDown:
          this.camera.impulse(PART_DOWN_SHAKE);
          break;
        case Ev.Death:
          this.camera.impulse(DEATH_SHAKE);
          break;
        case Ev.MorphStart:
        case Ev.MorphDone:
          this.camera.impulse(MORPH_SHAKE);
          break;
        case Ev.BossEnd:
          this.camera.impulse(BOSS_END_SHAKE);
          break;
        case Ev.NeutralFire:
          this.markNeutralTelegraph(world.events.x[i], world.events.y[i], world.events.a[i]);
          break;
        case Ev.Dash:
          this.camera.impulse(DASH_SHAKE);
          break;
        case Ev.BulwarkUp:
          this.camera.impulse(BULWARK_SHAKE);
          break;
        case Ev.Release:
          if (world.events.b[i] === 2) this.camera.impulse(SIEGE_SHAKE);
          if (world.events.b[i] === 3) this.camera.impulse(ULTIMA_SHAKE);
          break;
        case Ev.StormHit:
          this.camera.impulse(STORM_SHAKE);
          break;
        default:
      }
    }
  }

  render(world: World, alpha: number, dtSeconds: number): void {
    this.timeSeconds += dtSeconds;
    this.decay(this.firePulse, FIRE_DECAY, dtSeconds);
    this.decay(this.altPulse, ALT_DECAY, dtSeconds);
    this.decay(this.neutralTelegraph, TELEGRAPH_DECAY, dtSeconds);

    const focus = this.focusSample(alpha);
    this.camera.update({
      seat: this.focusSeatIndex,
      x: focus.x,
      y: focus.y,
      vx: focus.vx,
      vy: focus.vy,
      aim: focus.aim,
      alive: focus.alive,
      boss: focus.boss,
    }, dtSeconds);

    this.arena.update(this.timeSeconds);
    this.arena.setSafeRadius(this.current.safeR);
    this.ships.update(this.previous, this.current, alpha, this.focusSeatIndex, { fire: this.firePulse, alt: this.altPulse }, this.timeSeconds);
    this.neutrals.update(this.previous, this.current, alpha, this.neutralTelegraph, this.timeSeconds);
    this.orbs.update(this.previous, this.current, alpha, this.timeSeconds);
    this.projectiles.update(this.previous, this.current, alpha, this.current.plTeam[this.focusSeatIndex], this.timeSeconds);
    this.fx.update(world, this.current, dtSeconds, this.timeSeconds);
    this.arena.setUltimaDim(this.fx.ultimaDim);
    this.pipeline.render(this.scene, this.camera.camera);
  }

  project(x: number, y: number, out: { x: number; y: number }): void {
    this.camera.project(x, y, out);
  }

  /** The floor point, in world units, under a position on the canvas (CSS pixels). */
  ground(cssX: number, cssY: number, out: { x: number; y: number }): void {
    this.camera.ground(cssX, cssY, out);
  }

  aimFrom(seat: number, cssX: number, cssY: number): number {
    return this.camera.aimFrom(this.worldRef, seat, cssX, cssY);
  }

  dispose(): void {
    this.arena.dispose();
    this.ships.dispose();
    this.projectiles.dispose();
    this.neutrals.dispose();
    this.orbs.dispose();
    this.fx.dispose();
    this.pipeline.dispose();
  }

  private decay(values: Float32Array, sharpness: number, dtSeconds: number): void {
    for (let i = 0; i < values.length; i++) values[i] = expStep(values[i], 0, sharpness, dtSeconds);
  }

  private markNeutralTelegraph(rawX: number, rawY: number, type: number): void {
    let best = -1;
    let bestDistance = Infinity;
    for (let n = 0; n < this.current.neutrals; n++) {
      if (this.current.nAlive[n] !== 1 || this.current.nType[n] !== type) continue;
      const dx = this.current.nX[n] - rawX;
      const dy = this.current.nY[n] - rawY;
      const distance = dx * dx + dy * dy;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = n;
      }
    }
    if (best >= 0) this.neutralTelegraph[best] = 1;
  }

  private focusSample(alpha: number): { x: number; y: number; vx: number; vy: number; aim: number; alive: boolean; boss: boolean } {
    const seat = this.focusSeatIndex;
    const snap = this.previous.plEpoch[seat] !== this.current.plEpoch[seat] || this.previous.plAlive[seat] !== this.current.plAlive[seat] ? 1 : alpha;
    this.shipScratch.x = lerp(toWorld(this.previous.plX[seat]), toWorld(this.current.plX[seat]), snap);
    this.shipScratch.y = lerp(toWorld(this.previous.plY[seat]), toWorld(this.current.plY[seat]), snap);
    this.shipScratch.vx = lerp(toWorld(this.previous.plVX[seat]), toWorld(this.current.plVX[seat]), snap);
    this.shipScratch.vy = lerp(toWorld(this.previous.plVY[seat]), toWorld(this.current.plVY[seat]), snap);
    this.shipScratch.aim = lerpBinaryAngle(this.previous.plAim[seat], this.current.plAim[seat], snap);
    this.shipScratch.alive = this.current.plAlive[seat] === 1;
    this.shipScratch.boss = this.current.plForm[seat] === Form.Boss;
    return this.shipScratch;
  }
}
