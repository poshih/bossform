import * as THREE from 'three';
import { FLASH_TICKS, NEUTRAL_DEFS, NeutralType } from '../sim/index.ts';
import { createNeutral, type NeutralPose } from '../view/models/index.ts';
import type { WorldSnapshot } from './snapshot.ts';
import { clamp01, lerp, lerpRadiansBinary, toWorld } from './shared.ts';

export class NeutralsView {
  readonly root = new THREE.Group();
  private readonly models = [] as ReturnType<typeof createNeutral>[];

  constructor(capacity: number) {
    for (let n = 0; n < capacity; n++) {
      const model = createNeutral(NeutralType.Drone);
      model.root.visible = false;
      this.models.push(model);
      this.root.add(model.root);
    }
  }

  update(previous: WorldSnapshot, current: WorldSnapshot, alpha: number, telegraph: Float32Array, timeSeconds: number): void {
    for (let n = 0; n < current.neutrals; n++) {
      const model = this.models[n];
      if (current.nAlive[n] !== 1) {
        model.root.visible = false;
        continue;
      }
      if (previous.nType[n] !== current.nType[n]) {
        this.root.remove(model.root);
        model.dispose();
        this.models[n] = createNeutral(current.nType[n]);
        this.models[n].root.visible = false;
        this.root.add(this.models[n].root);
      }
      const snap = previous.nAlive[n] !== 1 ? 1 : alpha;
      const x = lerp(toWorld(previous.nX[n]), toWorld(current.nX[n]), snap);
      const y = lerp(toWorld(previous.nY[n]), toWorld(current.nY[n]), snap);
      const vx = lerp(toWorld(previous.nVX[n]), toWorld(current.nVX[n]), snap);
      const vy = lerp(toWorld(previous.nVY[n]), toWorld(current.nVY[n]), snap);
      const heading = current.nType[n] === NeutralType.Sentinel
        ? lerpRadiansBinary(previous.nAng[n], current.nAng[n], snap)
        : Math.abs(vx) + Math.abs(vy) > 0.001 ? Math.atan2(vy, vx) : lerpRadiansBinary(previous.nAng[n], current.nAng[n], snap);
      const pose: NeutralPose = {
        time: timeSeconds,
        heading,
        flash: clamp01(current.nFlash[n] / FLASH_TICKS),
        hp: clamp01(current.nHp[n] / NEUTRAL_DEFS[current.nType[n]].hp),
        telegraph: telegraph[n],
        speed: clamp01(Math.hypot(vx, vy) / toWorld(NEUTRAL_DEFS[current.nType[n]].speed)),
      };
      this.models[n].root.position.set(x, y, 0);
      this.models[n].root.visible = true;
      this.models[n].update(pose);
    }
  }

  dispose(): void {
    for (const model of this.models) model.dispose();
  }
}
