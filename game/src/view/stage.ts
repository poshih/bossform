import * as THREE from 'three';
import { Pipeline } from '../render/pipeline.ts';
import { ArenaFloor } from '../render/arena.ts';
import { FollowCamera } from '../render/camera.ts';
import type { Beat } from '../beat.ts';
import { Ev, Form, type World } from '../sim/index.ts';
import type { FrameContext, StageView } from './frame.ts';
import { FxView } from './fx.ts';
import { NeutralsView } from './neutrals.ts';
import { OrbsView } from './orbs.ts';
import { ProjectilesView } from './projectiles.ts';
import { WorldSnapshot } from './snapshot.ts';
import { COLOSSUS_DEATH_SHAKE, shakeFalloff } from './shake.ts';
import { ShieldsBoostView } from './shields.ts';
import { ShipsView } from './ships.ts';
import { lerp, toWorld } from './shared.ts';

export class Stage {
  private readonly pipeline: Pipeline;
  private readonly scene = new THREE.Scene();
  private readonly camera = new FollowCamera();
  private readonly arena: ArenaFloor;
  private readonly fx: FxView;
  /** Drawn in this order (the scene graph order): floor, pickups, bullets, units, pilots, effects. */
  private readonly views: readonly StageView[];
  private worldRef: World;
  private previous: WorldSnapshot;
  private current: WorldSnapshot;
  private focusSeatIndex = 0;
  private timeSeconds = 0;
  private alpha = 0;
  private readonly focusPoint = { x: 0, y: 0 };

  constructor(canvas: HTMLCanvasElement, world: World) {
    this.worldRef = world;
    this.pipeline = new Pipeline(canvas);
    this.arena = new ArenaFloor(world);
    this.fx = new FxView();
    this.previous = new WorldSnapshot(world);
    this.current = new WorldSnapshot(world);
    this.views = [
      this.arena,
      new OrbsView(world),
      new ProjectilesView(world),
      new NeutralsView(world.cap.neutrals),
      new ShipsView(world.seats),
      new ShieldsBoostView(world.seats),
      this.fx,
    ];
    for (const view of this.views) this.scene.add(view.root);
  }

  focus(seat: number): void {
    if (seat < 0 || seat >= this.current.seats) throw new RangeError(`seat ${seat} is out of range`);
    this.focusSeatIndex = seat;
  }

  /** `pixelRatio` is the resolved backing scale (config.backingScale). */
  resize(cssWidth: number, cssHeight: number, pixelRatio: number): void {
    this.pipeline.resize(cssWidth, cssHeight, pixelRatio);
    this.camera.resize(cssWidth, cssHeight);
  }

  tick(world: World): void {
    this.worldRef = world;
    const swap = this.previous;
    this.previous = this.current;
    this.current = swap;
    this.current.copyFrom(world);
  }

  handleEvents(world: World): void {
    for (const view of this.views) view.handleEvents(world, this.focusSeatIndex);
    const events = world.events;
    for (let i = 0; i < events.count; i++) {
      if (events.type[i] !== Ev.Death || events.c[i] !== 1) continue;
      this.seatPoint(this.focusSeatIndex, this.focusPoint);
      const distance = Math.hypot(toWorld(events.x[i]) - this.focusPoint.x, toWorld(events.y[i]) - this.focusPoint.y);
      const falloff = shakeFalloff(distance);
      if (falloff > 0) this.camera.shake(COLOSSUS_DEATH_SHAKE * falloff);
    }
  }

  render(world: World, alpha: number, dtSeconds: number, beat: Beat): void {
    this.timeSeconds += dtSeconds;
    this.alpha = alpha;
    const seat = this.focusSeatIndex;
    this.seatPoint(seat, this.focusPoint);
    const form = this.current.plForm[seat];
    this.camera.update({ x: this.focusPoint.x, y: this.focusPoint.y, alive: this.current.plAlive[seat] === 1, boss: form === Form.Boss || form === Form.Morph }, dtSeconds);
    const frame: FrameContext = {
      world,
      alpha,
      dt: dtSeconds,
      time: this.timeSeconds,
      focusSeat: seat,
      focusTeam: this.current.plTeam[seat],
      beat,
    };
    for (const view of this.views) view.update(this.previous, this.current, frame);
    this.arena.setUltimaDim(this.fx.ultimaDim);
    this.pipeline.render(this.scene, this.camera.camera, { punch: this.fx.punch, ultima: this.fx.ultimaDim, beat, time: this.timeSeconds });
  }

  /** Tools only (profiling): shows or hides one scene view, by its position in the draw order (see `views`). */
  setViewVisible(index: number, visible: boolean): void {
    const view = this.views[index];
    if (view === undefined) throw new RangeError(`no view ${index}`);
    view.root.visible = visible;
  }

  get cameraState(): FollowCamera['state'] {
    return this.camera.state;
  }

  /** Where a pilot is drawn this frame (interpolated like the ships), in world units. */
  seatPoint(seat: number, out: { x: number; y: number }): void {
    const jumped = this.previous.plEpoch[seat] !== this.current.plEpoch[seat] || this.previous.plAlive[seat] !== this.current.plAlive[seat];
    const t = jumped ? 1 : this.alpha;
    out.x = lerp(toWorld(this.previous.plX[seat]), toWorld(this.current.plX[seat]), t);
    out.y = lerp(toWorld(this.previous.plY[seat]), toWorld(this.current.plY[seat]), t);
  }

  /** Where a pilot is drawn this frame, in CSS pixels (overlays such as name tags stay glued to the ship). */
  seatScreen(seat: number, out: { x: number; y: number }): void {
    this.seatPoint(seat, out);
    this.camera.project(out.x, out.y, out);
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
    for (const view of this.views) view.dispose();
    this.pipeline.dispose();
  }
}
