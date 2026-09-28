import * as THREE from 'three';
import { fx } from '@metronome/engine';
import {
  ENEMY_TYPE_COUNT, EnemyFlag, EnemyType, Frame, FRAME_COUNT, FRAME_STATS, GAUGE_MAX, MAX_ENEMIES, MAX_PLAYERS, Phase, TRANSFORM_TICKS, W,
} from '../sim/index.ts';
import type { World } from '../sim/index.ts';
import type { Renderer } from '../render/renderer.ts';
import { ArenaBackground } from './background.ts';
import { BulletsView } from './bullets.ts';
import { FxSystem } from './fx.ts';
import { createEnemyModel } from './models/enemies.ts';
import { createPlayerMech } from './models/mechs.ts';
import type { EnemyModel, MechModel } from './models/types.ts';

const RAW = 1 / fx.ONE;
const MECH_Z = 0;
const ENEMY_Z = 0;
const BEAM_Z = 3.5;
const BEAM_LENGTH = 330;
const BEAM_WIDTH = 15;
const BEAM_ORIGIN = 18;
const STAGE_ACCENTS: readonly number[] = [0x27e1ff, 0x9d6bff, 0xff4a3e];
/** Robots are drawn larger than their collision bodies so they read against a 320x400 arena. */
const MECH_VISUAL_SCALE = 1.5;
/** The boss form swells this much beyond the normal visual scale at full transformation. */
const BOSS_FORM_GROWTH = 0.3;
const ENEMY_VISUAL_SCALE = 1.35;
const BOSS_VISUAL_SCALE = 1.05;

/** Angle-lerp along the shortest way round. */
function turnAngle(current: number, target: number, rate: number): number {
  let d = (target - current) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return current + d * Math.min(1, rate);
}

const BEAM_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const BEAM_FRAG = /* glsl */ `
uniform float uTime;
varying vec2 vUv;
void main() {
  float across = abs(vUv.y - 0.5) * 2.0;
  float core = smoothstep(0.55, 0.0, across);
  float halo = smoothstep(1.0, 0.1, across);
  float stripe = 0.75 + 0.25 * sin(vUv.x * 90.0 - uTime * 60.0);
  float fade = smoothstep(1.0, 0.85, vUv.x) * smoothstep(0.0, 0.02, vUv.x);
  vec3 col = mix(vec3(0.3, 0.75, 1.0), vec3(1.0), core) * (halo * 0.9 + core) * stripe * fade;
  gl_FragColor = vec4(col * 1.6, halo * fade);
}`;

interface MechSlot {
  frame: number;
  model: MechModel;
  holder: THREE.Group;
  form: number;
  alt: number;
  fire: number;
  prevFireCd: number;
  moveAngle: number;
  beam: THREE.Mesh;
}

interface EnemySlot {
  type: number;
  model: EnemyModel;
  holder: THREE.Group;
  heading: number;
}

/** Faces the direction of travel (rather than always facing down the screen). */
function facesTravel(type: number): boolean {
  return type === EnemyType.Drone || type === EnemyType.Lancer;
}

/** Everything that draws the world: floor, robots, enemies, bullets, effects. It only READS the simulation. */
export class FieldView {
  readonly fx = new FxSystem();
  private readonly renderer: Renderer;
  private readonly background: ArenaBackground;
  private readonly bullets = new BulletsView();
  private readonly stage = new THREE.Group();
  private readonly mechs: (MechSlot | null)[] = new Array<MechSlot | null>(MAX_PLAYERS).fill(null);
  private readonly enemies: (EnemySlot | null)[] = new Array<EnemySlot | null>(MAX_ENEMIES).fill(null);
  private readonly beamMaterial: THREE.ShaderMaterial;
  private readonly shake = { x: 0, y: 0 };
  private time = 0;
  private danger = 0;
  private bossModeGlow = 0;
  private accentStage = -1;

  constructor(renderer: Renderer) {
    this.renderer = renderer;
    this.background = new ArenaBackground(renderer);
    this.beamMaterial = new THREE.ShaderMaterial({
      vertexShader: BEAM_VERT,
      fragmentShader: BEAM_FRAG,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      uniforms: { uTime: { value: 0 } },
    });
    this.stage.add(this.bullets.group, this.fx.group);
    renderer.scene.add(this.stage);
    renderer.background = this.background.material;
    renderer.compileBackground(this.background.material);
  }

  /** Builds every model once so all shader programs are compiled before the first fight (no boss-entrance hitch). */
  warmup(): void {
    const temp: Array<{ root: THREE.Object3D; dispose(): void }> = [];
    for (let frame = 0; frame < FRAME_COUNT; frame++) temp.push(createPlayerMech(frame));
    for (let type = 0; type < ENEMY_TYPE_COUNT; type++) temp.push(createEnemyModel(type));
    for (const t of temp) this.stage.add(t.root);
    this.renderer.gl.compile(this.renderer.scene, this.renderer.camera);
    for (const t of temp) {
      this.stage.remove(t.root);
      t.dispose();
    }
  }

  /** Starts showing a (new) world: rebuilds the robot models for its seats. */
  bind(world: World): void {
    this.clearModels();
    const { m } = world;
    for (let p = 0; p < world.seats; p++) {
      if (m.plActive[p] !== 1) continue;
      const frame = m.plFrame[p];
      const model = createPlayerMech(frame);
      const holder = new THREE.Group();
      holder.add(model.root);
      holder.position.z = MECH_Z;
      holder.scale.setScalar(MECH_VISUAL_SCALE);
      const beam = new THREE.Mesh(new THREE.PlaneGeometry(BEAM_LENGTH, BEAM_WIDTH), this.beamMaterial);
      beam.visible = false;
      beam.renderOrder = 22;
      this.stage.add(holder, beam);
      this.mechs[p] = { frame, model, holder, form: 0, alt: 0, fire: 0, prevFireCd: 0, moveAngle: Math.PI / 2, beam };
    }
  }

  private clearModels(): void {
    this.mechs.forEach((slot, i) => {
      if (!slot) return;
      this.stage.remove(slot.holder, slot.beam);
      slot.model.dispose();
      slot.beam.geometry.dispose();
      this.mechs[i] = null;
    });
    this.enemies.forEach((slot, i) => {
      if (!slot) return;
      this.stage.remove(slot.holder);
      slot.model.dispose();
      this.enemies[i] = null;
    });
  }

  setVisible(visible: boolean): void {
    this.stage.visible = visible;
  }

  handleEvent(type: number, x: number, y: number, a: number): void {
    this.fx.handle(type, x, y, a);
  }

  /** Mech centre in world units (interpolated), for HUD anchors and aiming. */
  mechPosition(seat: number, out: { x: number; y: number }): boolean {
    const slot = this.mechs[seat];
    if (!slot) return false;
    out.x = slot.holder.position.x;
    out.y = slot.holder.position.y;
    return true;
  }

  update(world: World, alpha: number, dt: number): void {
    this.time += dt;
    const { m } = world;
    const wv = m.world;

    let anyBossForm = false;
    let anyTransforming = false;
    for (let p = 0; p < MAX_PLAYERS; p++) {
      const slot = this.mechs[p];
      if (!slot) continue;
      this.updateMech(world, p, slot, alpha, dt);
      if (m.plBoss[p] > 0) anyBossForm = true;
      if (m.plTransform[p] > 0) anyTransforming = true;
    }
    this.updateEnemies(world, alpha, dt);
    this.bullets.update(world, alpha, this.time);
    this.beamMaterial.uniforms.uTime.value = this.time;

    const stage = wv[W.Stage];
    if (stage !== this.accentStage) {
      this.accentStage = stage;
      this.background.accent = STAGE_ACCENTS[stage] ?? STAGE_ACCENTS[0];
    }
    const bossFight = wv[W.Phase] === Phase.Boss || wv[W.Phase] === Phase.BossWarning;
    this.danger += ((bossFight ? 1 : 0) - this.danger) * Math.min(1, dt * 2);
    this.bossModeGlow += ((anyBossForm ? 1 : 0) - this.bossModeGlow) * Math.min(1, dt * 4);
    this.background.update(this.time * 22, this.danger, this.bossModeGlow);

    this.fx.bossTint = this.bossModeGlow;
    this.fx.update(dt, anyTransforming);
    this.fx.applyPost(this.renderer.post, this.shake);
    this.renderer.shakeX = this.shake.x;
    this.renderer.shakeY = this.shake.y;
  }

  get elapsed(): number {
    return this.time;
  }

  private updateMech(world: World, p: number, slot: MechSlot, alpha: number, dt: number): void {
    const { m } = world;
    const stats = FRAME_STATS[slot.frame];
    const playing = world.isPlaying(p);
    const x = (m.plPX[p] + (m.plX[p] - m.plPX[p]) * alpha) * RAW;
    const y = (m.plPY[p] + (m.plY[p] - m.plPY[p]) * alpha) * RAW;
    slot.holder.position.set(x, y, MECH_Z);

    const boss = m.plBoss[p] > 0;
    const invulnBlink = m.plInvuln[p] > 0 && !boss && ((m.world[W.Tick] >> 2) & 1) === 1;
    slot.holder.visible = playing && !invulnBlink;

    const vx = m.plVX[p] * RAW;
    const vy = m.plVY[p] * RAW;
    const speed = Math.hypot(vx, vy);
    if (speed > 0.05) slot.moveAngle = turnAngle(slot.moveAngle, Math.atan2(vy, vx), dt * 14);

    const formStep = dt / (TRANSFORM_TICKS / 60);
    slot.form = boss ? Math.min(1, slot.form + formStep) : Math.max(0, slot.form - formStep);
    slot.holder.scale.setScalar(MECH_VISUAL_SCALE * (1 + BOSS_FORM_GROWTH * slot.form));

    const altOn = m.plAltFx[p] > 0 && !boss && (slot.frame === Frame.Gale || slot.frame === Frame.Juggernaut);
    slot.alt += ((altOn ? 1 : 0) - slot.alt) * Math.min(1, dt * 12);

    const fireCd = m.plFireCd[p];
    if (fireCd > slot.prevFireCd) slot.fire = 1;
    slot.prevFireCd = fireCd;
    slot.fire = Math.max(0, slot.fire - dt * 9);

    const aim = fx.toRadians(m.plAim[p]);
    slot.model.update({
      time: this.time,
      moveAngle: slot.moveAngle,
      speed: Math.min(1, speed / (stats.speed * RAW)),
      aimAngle: aim,
      fire: slot.fire,
      transform: slot.form,
      alt: slot.alt,
      hit: Math.min(1, m.plFlash[p] / 8),
      charge: boss ? 0 : m.plGauge[p] / GAUGE_MAX,
    });

    const beamOn = playing && m.plBeam[p] === 1;
    slot.beam.visible = beamOn;
    if (beamOn) {
      const dx = Math.cos(aim);
      const dy = Math.sin(aim);
      slot.beam.position.set(x + dx * (BEAM_ORIGIN + BEAM_LENGTH / 2), y + dy * (BEAM_ORIGIN + BEAM_LENGTH / 2), BEAM_Z);
      slot.beam.rotation.z = aim;
    }
  }

  private updateEnemies(world: World, alpha: number, dt: number): void {
    const { m } = world;
    for (let e = 0; e < MAX_ENEMIES; e++) {
      let slot = this.enemies[e];
      if (m.eAlive[e] !== 1) {
        if (slot) {
          this.stage.remove(slot.holder);
          slot.model.dispose();
          this.enemies[e] = null;
        }
        continue;
      }
      const type = m.eType[e];
      if (slot && slot.type !== type) {
        this.stage.remove(slot.holder);
        slot.model.dispose();
        slot = null;
      }
      if (!slot) {
        const model = createEnemyModel(type);
        const holder = new THREE.Group();
        holder.add(model.root);
        holder.scale.setScalar(type >= EnemyType.Bulwark ? BOSS_VISUAL_SCALE : ENEMY_VISUAL_SCALE);
        this.stage.add(holder);
        slot = { type, model, holder, heading: -Math.PI / 2 };
        this.enemies[e] = slot;
      }
      const px = m.ePX[e] * RAW;
      const py = m.ePY[e] * RAW;
      const x = px + (m.eX[e] * RAW - px) * alpha;
      const y = py + (m.eY[e] * RAW - py) * alpha;
      slot.holder.position.set(x, y, ENEMY_Z);

      const dx = m.eX[e] * RAW - px;
      const dy = m.eY[e] * RAW - py;
      const travel = Math.hypot(dx, dy);
      if (facesTravel(type)) {
        if (travel > 0.05) slot.heading = turnAngle(slot.heading, Math.atan2(dy, dx), dt * 12);
      } else slot.heading = -Math.PI / 2;

      const target = world.nearestPlayer(m.eX[e], m.eY[e]);
      const aim = target >= 0 ? Math.atan2((m.plY[target] - m.eY[e]) * RAW, (m.plX[target] - m.eX[e]) * RAW) : -Math.PI / 2;
      const flags = m.eFlags[e];
      slot.model.update({
        time: this.time,
        heading: slot.heading,
        aim,
        flash: Math.min(1, m.eFlash[e] / 3),
        telegraph: (flags & EnemyFlag.Telegraph) !== 0 ? Math.min(1, m.eTimer[e] / 38) : 0,
        hp: m.eMaxHp[e] > 0 ? Math.max(0, m.eHp[e] / m.eMaxHp[e]) : 0,
        phase: m.ePhase[e],
        dying: (flags & EnemyFlag.Dying) !== 0 ? Math.min(1, m.eTimer[e] / 120) : 0,
        invulnerable: (flags & EnemyFlag.Invulnerable) !== 0,
        speed: Math.min(1, travel / 3),
      });
    }
  }

  dispose(): void {
    this.clearModels();
    this.bullets.dispose();
    this.fx.dispose();
    this.beamMaterial.dispose();
    this.renderer.scene.remove(this.stage);
  }
}
