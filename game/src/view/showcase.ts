import * as THREE from 'three';
import { FRAME_COUNT } from '../sim/index.ts';
import type { Renderer } from '../render/renderer.ts';
import { createPlayerMech } from './models/mechs.ts';
import type { MechModel } from './models/types.ts';

const SPACING = 104;
const BASE_SCALE = 3.4;
const SELECTED_SCALE = 4.5;
const FORM_PERIOD = 6;
const FORM_SECONDS = 0.9;

/** The three robots on display for the frame-select screen. Only exists while that screen is up. */
export class Showcase {
  private readonly group = new THREE.Group();
  private readonly renderer: Renderer;
  private readonly models: MechModel[] = [];
  private readonly holders: THREE.Group[] = [];
  private readonly scales: number[] = [];
  private time = 0;
  private selected = 0;

  constructor(renderer: Renderer) {
    this.renderer = renderer;
    for (let frame = 0; frame < FRAME_COUNT; frame++) {
      const model = createPlayerMech(frame);
      const holder = new THREE.Group();
      holder.add(model.root);
      holder.position.set((frame - 1) * SPACING, 40, 0);
      this.group.add(holder);
      this.models.push(model);
      this.holders.push(holder);
      this.scales.push(BASE_SCALE);
    }
    this.group.visible = false;
    renderer.scene.add(this.group);
  }

  show(visible: boolean): void {
    this.group.visible = visible;
    if (visible) this.time = 0;
  }

  select(frame: number): void {
    if (frame !== this.selected) this.time = 0;
    this.selected = frame;
  }

  /** Screen position (low-res UI pixels) of a frame's pedestal, for captions. */
  uiPosition(frame: number, out: { x: number; y: number }): { x: number; y: number } {
    return this.renderer.worldToUi(this.holders[frame].position.x, this.holders[frame].position.y, out);
  }

  update(dt: number): void {
    if (!this.group.visible) return;
    this.time += dt;
    const cycle = this.time % FORM_PERIOD;
    const bossPhase = cycle > FORM_PERIOD / 2 ? Math.min(1, (cycle - FORM_PERIOD / 2) / FORM_SECONDS) : 0;
    const back = cycle > FORM_PERIOD - FORM_SECONDS ? (cycle - (FORM_PERIOD - FORM_SECONDS)) / FORM_SECONDS : 0;
    const transform = Math.max(0, bossPhase - back);
    this.models.forEach((model, frame) => {
      const chosen = frame === this.selected;
      const target = chosen ? SELECTED_SCALE : BASE_SCALE;
      this.scales[frame] += (target - this.scales[frame]) * Math.min(1, dt * 9);
      const holder = this.holders[frame];
      holder.scale.setScalar(this.scales[frame] / (chosen && transform > 0.5 ? 1.35 : 1));
      const aim = chosen ? Math.PI / 2 + Math.sin(this.time * 1.4) * 0.7 : Math.PI / 2;
      model.update({
        time: this.time,
        moveAngle: Math.PI / 2,
        speed: chosen ? 0.35 : 0.1,
        aimAngle: aim,
        fire: 0,
        transform: chosen ? transform : 0,
        alt: 0,
        hit: 0,
        charge: chosen ? 0.6 : 0,
      });
    });
  }

  dispose(): void {
    this.renderer.scene.remove(this.group);
    for (const model of this.models) model.dispose();
  }
}
