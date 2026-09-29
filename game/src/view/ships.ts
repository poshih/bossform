import * as THREE from 'three';
import {
  Attack,
  AttackPhase,
  BOSS_MIN_GAUGE,
  FLASH_TICKS,
  FORMS,
  FRAME_STATS,
  Form,
  Frame,
  GAUGE_MAX,
  JUGGERNAUT,
  MAX_PARTS,
  MORPH_TICKS,
  Role,
} from '../sim/index.ts';
import { TEAM_COLORS } from '../config.ts';
import { createVectorMaterial, vectorMesh } from '../render/vector.ts';
import type { VectorMaterial } from '../render/vector.ts';
import { createColossus, createRobot } from './models/index.ts';
import type { ColossusPose, PartPose, RobotPose } from './models/index.ts';
import type { WorldSnapshot } from './snapshot.ts';
import { binaryAngleToRadians, clamp01, colorIntoLinear, easeOutCubic, lerp, lerpRadiansBinary, smoothstep, toWorld } from './shared.ts';

export interface ShipPulses {
  readonly fire: Float32Array;
  readonly alt: Float32Array;
}

interface ShipRenderSample {
  x: number;
  y: number;
  vx: number;
  vy: number;
  aim: number;
  body: number;
  orbit: number;
  speed: number;
  alive: boolean;
  epochChanged: boolean;
}

/** Robots are drawn this much larger than their collision bodies so they read as machines; the hurtbox is the core dot. */
const ROBOT_VISUAL_SCALE = 1.6;
/** The bulwark wedge is gameplay, not decoration: it is drawn from the simulation's radius and arc, never scaled. */
const BULWARK_RADIUS = toWorld(JUGGERNAUT.bulwark.radius);
const BULWARK_HALF_ARC = binaryAngleToRadians(JUGGERNAUT.bulwark.halfArc);
const BULWARK_INNER_RADIUS = toWorld(FRAME_STATS[Frame.Juggernaut].bodyR) * ROBOT_VISUAL_SCALE;
const BULWARK_SEGMENTS = 32;
const BULWARK_CREASE_DEGREES = 40;
const BULWARK_FILL_ALPHA = 0.16;
const BULWARK_FILL_TINT = 0.1;
const BULWARK_EDGE_WIDTH = 1.7;
const BULWARK_GLOW = 1.5;
const INVULN_FADE_TICKS = 20;
const NORMAL_MARKER_SCALE = 1.14;
const BOSS_MARKER_SCALE = 1.02;
const MIN_CORE_VISUAL_RADIUS = 2.2;
const NORMAL_CORE_SCALE = 1.18;
const BOSS_CORE_SCALE = 1.05;
const FOCUS_CORE_GAIN = 1.18;

function teamColor(team: number): THREE.Color {
  return colorIntoLinear(new THREE.Color(), TEAM_COLORS[team % TEAM_COLORS.length]);
}

export class ShipsView {
  readonly root = new THREE.Group();

  private readonly robots = [] as ReturnType<typeof createRobot>[];
  private readonly robotMounts: THREE.Group[] = [];
  private readonly bulwarks: THREE.Mesh[] = [];
  private readonly bulwarkMaterials: VectorMaterial[] = [];
  private readonly colossi = [] as ReturnType<typeof createColossus>[];
  private readonly markers: THREE.Mesh[] = [];
  private readonly markerMaterials: THREE.ShaderMaterial[] = [];
  private readonly glows: THREE.Mesh[] = [];
  private readonly glowMaterials: THREE.MeshBasicMaterial[] = [];
  private readonly coreDots: THREE.Mesh[] = [];
  private readonly coreDotMaterials: THREE.MeshBasicMaterial[] = [];
  private readonly coreRings: THREE.Mesh[] = [];
  private readonly coreRingMaterials: THREE.MeshBasicMaterial[] = [];
  private readonly modelFrames: number[] = [];
  private readonly partPoses: PartPose[][];

  constructor(seats: number) {
    this.partPoses = Array.from({ length: seats }, () => Array.from({ length: MAX_PARTS }, () => ({ hp: 0, facing: 0, flash: 0, heat: 0, charge: 0 })));
    const markerGeometry = new THREE.RingGeometry(13, 14.2, 48);
    const glowGeometry = new THREE.CircleGeometry(1, 48);
    const coreDotGeometry = new THREE.CircleGeometry(1, 28);
    const coreRingGeometry = new THREE.RingGeometry(1.1, 1.55, 28);
    const bulwarkGeometry = new THREE.RingGeometry(BULWARK_INNER_RADIUS, BULWARK_RADIUS, BULWARK_SEGMENTS, 1, -BULWARK_HALF_ARC, BULWARK_HALF_ARC * 2);
    for (let seat = 0; seat < seats; seat++) {
      const robot = createRobot(Frame.Vanguard);
      const mount = new THREE.Group();
      mount.scale.setScalar(ROBOT_VISUAL_SCALE);
      mount.visible = false;
      mount.add(robot.root);
      this.robots.push(robot);
      this.robotMounts.push(mount);
      this.root.add(mount);

      const bulwarkMaterial = createVectorMaterial({ fillAlpha: BULWARK_FILL_ALPHA, edgeWidth: BULWARK_EDGE_WIDTH, glow: BULWARK_GLOW });
      const bulwark = vectorMesh(bulwarkGeometry.clone(), bulwarkMaterial, BULWARK_CREASE_DEGREES);
      bulwark.position.z = 2.4;
      bulwark.visible = false;
      this.root.add(bulwark);
      this.bulwarks.push(bulwark);
      this.bulwarkMaterials.push(bulwarkMaterial);

      const colossus = createColossus(Frame.Vanguard);
      colossus.root.visible = false;
      this.colossi.push(colossus);
      this.root.add(colossus.root);

      const markerMaterial = createVectorMaterial({ edge: 0xffffff, fill: 0x03060c, fillAlpha: 0.0, edgeWidth: 1.25, glow: 1.45 });
      const marker = vectorMesh(markerGeometry.clone(), markerMaterial, 12);
      marker.position.z = 2;
      marker.visible = false;
      this.root.add(marker);
      this.markers.push(marker);
      this.markerMaterials.push(markerMaterial);

      const glowMaterial = new THREE.MeshBasicMaterial({ color: teamColor(0), transparent: true, opacity: 0.08, depthWrite: false });
      const glow = new THREE.Mesh(glowGeometry.clone(), glowMaterial);
      glow.position.z = -0.35;
      glow.visible = false;
      this.root.add(glow);
      this.glows.push(glow);
      this.glowMaterials.push(glowMaterial);

      const coreDotMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.92, depthWrite: false, depthTest: false });
      const coreDot = new THREE.Mesh(coreDotGeometry.clone(), coreDotMaterial);
      coreDot.position.z = 3.2;
      coreDot.renderOrder = 40;
      coreDot.visible = false;
      this.root.add(coreDot);
      this.coreDots.push(coreDot);
      this.coreDotMaterials.push(coreDotMaterial);

      const coreRingMaterial = new THREE.MeshBasicMaterial({ color: teamColor(0), transparent: true, opacity: 0.9, depthWrite: false, depthTest: false });
      const coreRing = new THREE.Mesh(coreRingGeometry.clone(), coreRingMaterial);
      coreRing.position.z = 3.1;
      coreRing.renderOrder = 39;
      coreRing.visible = false;
      this.root.add(coreRing);
      this.coreRings.push(coreRing);
      this.coreRingMaterials.push(coreRingMaterial);
      this.modelFrames.push(Frame.Vanguard);
    }
    markerGeometry.dispose();
    glowGeometry.dispose();
    coreDotGeometry.dispose();
    coreRingGeometry.dispose();
    bulwarkGeometry.dispose();
  }

  setTeams(snapshot: WorldSnapshot): void {
    for (let seat = 0; seat < snapshot.seats; seat++) {
      const frame = snapshot.plFrame[seat];
      const color = teamColor(snapshot.plTeam[seat]);
      if (frame !== this.modelFrames[seat]) {
        this.robotMounts[seat].remove(this.robots[seat].root);
        this.robots[seat].dispose();
        this.robots[seat] = createRobot(frame);
        this.robotMounts[seat].add(this.robots[seat].root);

        this.root.remove(this.colossi[seat].root);
        this.colossi[seat].dispose();
        this.colossi[seat] = createColossus(frame);
        this.colossi[seat].root.visible = false;
        this.root.add(this.colossi[seat].root);
        this.modelFrames[seat] = frame;
      }
      this.robots[seat].setTeam(color);
      this.colossi[seat].setTeam(color);
      this.bulwarkMaterials[seat].uniforms.uEdge.value.copy(color);
      this.bulwarkMaterials[seat].uniforms.uFill.value.copy(color).multiplyScalar(BULWARK_FILL_TINT);
      this.glowMaterials[seat].color.copy(color);
      this.coreRingMaterials[seat].color.copy(color);
    }
  }

  update(previous: WorldSnapshot, current: WorldSnapshot, alpha: number, focusSeat: number, pulses: ShipPulses, timeSeconds: number): void {
    for (let seat = 0; seat < current.seats; seat++) {
      const sample = this.sample(previous, current, seat, alpha);
      const robot = this.robots[seat];
      const mount = this.robotMounts[seat];
      const bulwark = this.bulwarks[seat];
      const colossus = this.colossi[seat];
      const marker = this.markers[seat];
      const markerMaterial = this.markerMaterials[seat];
      const glow = this.glows[seat];
      const coreDot = this.coreDots[seat];
      const coreRing = this.coreRings[seat];
      const frame = current.plFrame[seat];
      const form = current.plForm[seat];
      const flash = clamp01(current.plFlash[seat] / FLASH_TICKS);
      const shield = clamp01(current.plInvuln[seat] / INVULN_FADE_TICKS);
      const gauge = clamp01(current.plGauge[seat] / BOSS_MIN_GAUGE);
      const speed = clamp01(sample.speed / toWorld(FRAME_STATS[frame].speed));
      const move = Math.abs(sample.vx) + Math.abs(sample.vy) > 0.0001 ? Math.atan2(sample.vy, sample.vx) : sample.aim;
      const morph = form === Form.Morph ? 1 - current.plTimer[seat] / MORPH_TICKS : 0;
      const robotPose: RobotPose = {
        time: timeSeconds,
        aim: sample.aim,
        move,
        speed,
        fire: pulses.fire[seat],
        alt: this.altAmount(current, seat, timeSeconds, pulses.alt[seat]),
        hit: flash,
        charge: gauge,
        shield: smoothstep(0, 1, shield),
        morph,
      };
      const showRobot = sample.alive && (form === Form.Normal || form === Form.Morph);
      mount.visible = showRobot;
      mount.position.set(sample.x, sample.y, 0);
      if (showRobot) robot.update(robotPose);

      const showBulwark = showRobot && frame === Frame.Juggernaut && current.plBulwark[seat] > 0;
      bulwark.visible = showBulwark;
      bulwark.position.set(sample.x, sample.y, bulwark.position.z);
      bulwark.rotation.z = sample.aim;
      this.bulwarkMaterials[seat].uniforms.uOpacity.value = robotPose.alt;

      const showColossus = sample.alive && (form === Form.Boss || form === Form.Morph);
      colossus.root.visible = showColossus;
      colossus.root.position.set(sample.x, sample.y, 0);
      if (showColossus) colossus.update(this.colossusPose(previous, current, seat, alpha, timeSeconds, sample, morph));

      glow.visible = showRobot || showColossus;
      glow.position.set(sample.x, sample.y, -0.35);
      glow.scale.setScalar(showColossus ? toWorld(FORMS[frame].reach) * 0.78 : toWorld(FRAME_STATS[frame].bodyR) * (1.35 + ROBOT_VISUAL_SCALE * 0.18));
      this.glowMaterials[seat].opacity = showColossus ? (seat === focusSeat ? 0.06 : 0.045) : (seat === focusSeat ? 0.10 : 0.07);

      marker.visible = showRobot || showColossus;
      marker.position.set(sample.x, sample.y, 1.5);
      marker.scale.setScalar(showColossus ? BOSS_MARKER_SCALE : NORMAL_MARKER_SCALE);
      markerMaterial.uniforms.uOpacity.value = seat === focusSeat ? 0.88 : 0;
      markerMaterial.uniforms.uPulse.value = seat === focusSeat ? 0.10 + 0.05 * Math.sin(timeSeconds * 3.2) : 0;
      markerMaterial.uniforms.uFlash.value = 0;

      const focusGain = seat === focusSeat ? FOCUS_CORE_GAIN : 1;
      const coreRadius = showColossus
        ? toWorld(FORMS[frame].coreR) * BOSS_CORE_SCALE * focusGain
        : Math.max(MIN_CORE_VISUAL_RADIUS, toWorld(FRAME_STATS[frame].hurtR) * NORMAL_CORE_SCALE) * focusGain;
      coreDot.visible = showRobot || showColossus;
      coreRing.visible = showRobot || showColossus;
      coreDot.position.set(sample.x, sample.y, 3.2);
      coreRing.position.set(sample.x, sample.y, 3.1);
      coreDot.scale.setScalar(coreRadius);
      coreRing.scale.setScalar(coreRadius);
      this.coreDotMaterials[seat].opacity = showColossus ? 0.98 : seat === focusSeat ? 1 : 0.92;
      this.coreRingMaterials[seat].opacity = showColossus ? 0.96 : seat === focusSeat ? 0.98 : 0.88;
    }
  }

  dispose(): void {
    for (const robot of this.robots) robot.dispose();
    for (const bulwark of this.bulwarks) bulwark.geometry.dispose();
    for (const material of this.bulwarkMaterials) material.dispose();
    for (const colossus of this.colossi) colossus.dispose();
    for (const marker of this.markers) marker.geometry.dispose();
    for (const material of this.markerMaterials) material.dispose();
    for (const glow of this.glows) glow.geometry.dispose();
    for (const material of this.glowMaterials) material.dispose();
    for (const dot of this.coreDots) dot.geometry.dispose();
    for (const material of this.coreDotMaterials) material.dispose();
    for (const ring of this.coreRings) ring.geometry.dispose();
    for (const material of this.coreRingMaterials) material.dispose();
  }

  private sample(previous: WorldSnapshot, current: WorldSnapshot, seat: number, alpha: number): ShipRenderSample {
    const epochChanged = previous.plEpoch[seat] !== current.plEpoch[seat] || previous.plAlive[seat] !== current.plAlive[seat];
    const snap = epochChanged ? 1 : alpha;
    const x = lerp(toWorld(previous.plX[seat]), toWorld(current.plX[seat]), snap);
    const y = lerp(toWorld(previous.plY[seat]), toWorld(current.plY[seat]), snap);
    const vx = lerp(toWorld(previous.plVX[seat]), toWorld(current.plVX[seat]), snap);
    const vy = lerp(toWorld(previous.plVY[seat]), toWorld(current.plVY[seat]), snap);
    return {
      x,
      y,
      vx,
      vy,
      aim: lerpRadiansBinary(previous.plAim[seat], current.plAim[seat], snap),
      body: lerpRadiansBinary(previous.plBody[seat], current.plBody[seat], snap),
      orbit: lerpRadiansBinary(previous.plOrbit[seat], current.plOrbit[seat], snap),
      speed: Math.hypot(vx, vy),
      alive: current.plActive[seat] === 1 && current.plAlive[seat] === 1,
      epochChanged,
    };
  }

  private colossusPose(previous: WorldSnapshot, current: WorldSnapshot, seat: number, alpha: number, timeSeconds: number, sample: ShipRenderSample, morph: number): ColossusPose {
    const frame = current.plFrame[seat];
    const form = FORMS[frame];
    const base = seat * MAX_PARTS;
    const attack = current.plAtk[seat];
    const phase = current.plAtkPhase[seat];
    const progress = this.attackProgress(current, seat);
    const partPose = this.partPoses[seat];
    for (let k = 0; k < form.parts.length; k++) {
      const part = form.parts[k];
      const hp = clamp01(current.ptHp[base + k] / part.hp);
      const charge = phase === AttackPhase.Windup && this.partCharges(attack, part.roles) && hp > 0 ? progress : 0;
      partPose[k].hp = hp;
      partPose[k].facing = lerpRadiansBinary(previous.ptAng[base + k], current.ptAng[base + k], sample.epochChanged ? 1 : alpha);
      partPose[k].flash = clamp01(current.ptFlash[base + k] / FLASH_TICKS);
      partPose[k].heat = clamp01(current.ptHeat[base + k] / this.heatWindow(form, attack));
      partPose[k].charge = charge;
    }
    return {
      time: timeSeconds,
      body: sample.body,
      orbit: sample.orbit,
      assemble: current.plForm[seat] === Form.Boss ? 1 : easeOutCubic(morph),
      speed: clamp01(sample.speed / toWorld(form.speed)),
      attack,
      phase,
      progress,
      fuel: clamp01(current.plGauge[seat] / GAUGE_MAX),
      hit: clamp01(current.plFlash[seat] / FLASH_TICKS),
      parts: partPose,
    };
  }

  private attackProgress(current: WorldSnapshot, seat: number): number {
    const frame = current.plFrame[seat];
    const attack = current.plAtk[seat];
    if (attack === Attack.None) return 0;
    const form = FORMS[frame];
    const timer = current.plAtkTimer[seat];
    const phase = current.plAtkPhase[seat];
    const timing = attack === Attack.Salvo ? form.salvo : attack === Attack.Siege ? form.siege : form.ultima;
    if (phase === AttackPhase.Windup) return clamp01(1 - timer / timing.windup);
    if (phase === AttackPhase.Recovery) return clamp01(1 - timer / timing.recovery);
    if (phase === AttackPhase.Release && attack === Attack.Ultima) return clamp01(1 - timer / form.ultima.duration);
    return 1;
  }

  private altAmount(current: WorldSnapshot, seat: number, timeSeconds: number, pulse: number): number {
    switch (current.plFrame[seat]) {
      case Frame.Gale:
        return current.plDash[seat] > 0 ? 0.45 + 0.55 * Math.sin(timeSeconds * 22) * 0.5 + 0.55 : 0;
      case Frame.Juggernaut:
        return smoothstep(0, 1, clamp01(current.plBulwark[seat] / 18));
      default:
        return pulse;
    }
  }

  private heatWindow(form: (typeof FORMS)[number], attack: number): number {
    if (attack === Attack.Siege) return form.siege.recovery;
    if (attack === Attack.Ultima) return form.ultima.recovery;
    return form.salvo.recovery;
  }

  private partCharges(attack: number, roles: number): boolean {
    if (attack === Attack.Salvo) return (roles & Role.Salvo) !== 0;
    if (attack === Attack.Siege) return (roles & Role.Siege) !== 0;
    if (attack === Attack.Ultima) return (roles & Role.Ultima) !== 0;
    return false;
  }
}
