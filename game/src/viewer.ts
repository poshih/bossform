import * as THREE from 'three';
import { Renderer } from './render/renderer.ts';
import { ArenaBackground } from './view/background.ts';
import { createEnemyModel } from './view/models/enemies.ts';
import { createPlayerMech } from './view/models/mechs.ts';
import type { EnemyModel, EnemyPose, MechModel, MechPose } from './view/models/types.ts';

/** Dev-only contact sheet for the procedural robot models (used by tools/verify/models.ts and for design review). */
interface Entry {
  kind: 'mech' | 'enemy';
  id: number;
  x: number;
  y: number;
  scale?: number;
  /** Extra rotation of the whole model in radians (view it from any side). */
  spin?: number;
  pose?: Partial<MechPose & EnemyPose>;
}

interface Shown {
  entry: Entry;
  model: MechModel | EnemyModel;
}

const DEFAULT_MECH_POSE: MechPose = { time: 0, moveAngle: Math.PI / 2, speed: 0, aimAngle: Math.PI / 2, fire: 0, transform: 0, alt: 0, hit: 0, charge: 0 };
const DEFAULT_ENEMY_POSE: EnemyPose = { time: 0, heading: -Math.PI / 2, aim: -Math.PI / 2, flash: 0, telegraph: 0, hp: 1, phase: 0, dying: 0, invulnerable: false, speed: 0 };

const container = document.getElementById('app')!;
const canvas = document.createElement('canvas');
canvas.id = 'game';
container.appendChild(canvas);
const renderer = new Renderer(canvas);
const resize = () => {
  const r = container.getBoundingClientRect();
  renderer.resize(Math.max(1, Math.floor(r.width)), Math.max(1, Math.floor(r.height)));
};
resize();
new ResizeObserver(resize).observe(container);

// The real arena floor, so contrast is judged against what the game actually draws.
const floor = new ArenaBackground(renderer);
renderer.background = floor.material;

let shown: Shown[] = [];
let frozenTime: number | null = null;
const group = new THREE.Group();
renderer.scene.add(group);

function clear(): void {
  for (const s of shown) {
    group.remove(s.model.root);
    s.model.dispose();
  }
  shown = [];
}

function apply(time: number): void {
  for (const s of shown) {
    const e = s.entry;
    if (e.kind === 'mech') (s.model as MechModel).update({ ...DEFAULT_MECH_POSE, ...e.pose, time });
    else (s.model as EnemyModel).update({ ...DEFAULT_ENEMY_POSE, ...e.pose, time });
  }
}

const viewer = {
  show(entries: Entry[]): void {
    clear();
    for (const entry of entries) {
      const model = entry.kind === 'mech' ? createPlayerMech(entry.id) : createEnemyModel(entry.id);
      const holder = new THREE.Group();
      holder.position.set(entry.x, entry.y, 0);
      holder.scale.setScalar(entry.scale ?? 1);
      holder.rotation.z = entry.spin ?? 0;
      holder.add(model.root);
      group.add(holder);
      shown.push({ entry, model: Object.assign(model, { root: model.root }) });
      (model as { holder?: THREE.Group }).holder = holder;
    }
  },
  freeze(time: number | null): void {
    frozenTime = time;
  },
  metrics: () => ({ ...renderer.metrics }),
};

declare global {
  interface Window {
    __viewer: typeof viewer;
    __viewerReady: boolean;
  }
}
window.__viewer = viewer;
window.__viewerReady = true;

const start = performance.now();
const loop = () => {
  const time = frozenTime ?? (performance.now() - start) / 1000;
  apply(time);
  floor.update(time * 22, 0, 0);
  renderer.ui.clearRect(0, 0, renderer.uiCanvas.width, renderer.uiCanvas.height);
  renderer.markUiDirty();
  renderer.render(time);
  requestAnimationFrame(loop);
};
requestAnimationFrame(loop);
