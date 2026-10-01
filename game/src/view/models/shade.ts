import * as THREE from 'three';
import { edgeGeometry, type VectorMaterial } from '../../render/vector.ts';
import { Attack, AttackPhase, FORMS, FRAME_STATS, Frame, PartKind, Role } from '../../sim/index.ts';
import {
  applyColossusVectorState,
  applyRobotVectorState,
  createMechKit,
  diamondGeometry,
  lineGeometry,
  merge,
  plateGeometry,
  ringGeometry,
  shapeExtrude,
  type MechKit,
} from './kit-mechs.ts';
import { clamp01, easeOutCubic, lerp, lerpRadians, smooth01, smoothstep, toWorld, wrapAngleRadians } from '../shared.ts';
import type { ColossusModel, ColossusPose, PartPose, RobotModel, RobotPose } from './types.ts';

/*
 * SHADE, the stealth ninja, and KITSUNE, its nine-tailed fox colossus. Contract: view/models/types.ts.
 */

type Point2 = readonly [number, number];
type Point3 = readonly [number, number, number];

/** Violet: the visor, the shuriken and the shadow core. Magenta: the scarf and the foxfire. */
const VIOLET = 0xb98cff;
const MAGENTA = 0xff5ad8;
/**
 * An accent must not drown in the team colour it rides on (pink, violet and blue teams): within this hue distance (0..0.5
 * of the wheel, measured in the colour space the view hands to setTeam) it gives way to its alternative.
 */
const ACCENT_CLASH = 20 / 360;
const MAGENTA_ALTERNATIVE = 0xf0e0ff;
const VIOLET_ALTERNATIVE = MAGENTA;

const hsl = { h: 0, s: 0, l: 0 };
function hueOf(color: THREE.Color): number {
  color.getHSL(hsl);
  return hsl.h;
}
/** Hue of an accent, converted the way the view converts team colours (view/ships.ts teamColor). */
const accentHue = (hex: number): number => hueOf(new THREE.Color().setHex(hex).convertSRGBToLinear());
const MAGENTA_HUE = accentHue(MAGENTA);
const VIOLET_HUE = accentHue(VIOLET);

/** Sets each accent material to its colour, or to its alternative where the team colour would swallow it. */
function tintAccents(team: THREE.Color, magenta: readonly VectorMaterial[], violet: readonly VectorMaterial[]): void {
  const hue = hueOf(team);
  const clash = (accent: number): boolean => {
    const gap = Math.abs(hue - accent) % 1;
    return Math.min(gap, 1 - gap) < ACCENT_CLASH;
  };
  const magentaHex = clash(MAGENTA_HUE) ? MAGENTA_ALTERNATIVE : MAGENTA;
  const violetHex = clash(VIOLET_HUE) ? VIOLET_ALTERNATIVE : VIOLET;
  for (const material of magenta) material.uniforms.uEdge.value.setHex(magentaHex);
  for (const material of violet) material.uniforms.uEdge.value.setHex(violetHex);
}

/**
 * A strip of `sections` x `columns` points that move every frame (SHADE's scarf, KITSUNE's tails), drawn in the vector look.
 * Which edges glow is decided once, from the shape it is built in: build it straight, with the creases that should show as
 * real creases; later frames only rewrite the points and their flat normals. The mesh sits at height `sortZ` (three stacks
 * transparent meshes by their origins, render/layers.ts) and its points are given in its parent's space. It is never culled:
 * it moves outside the bounds it was built with.
 */
class Ribbon {
  readonly mesh: THREE.Mesh;
  private readonly grid: Float32Array;
  private readonly corners: Uint16Array;
  private readonly position: THREE.BufferAttribute;
  private readonly normal: THREE.BufferAttribute;
  private readonly columns: number;
  private readonly sortZ: number;

  /** `shape` gives the build shape (any place, any orientation: only its creases matter); `crease` as in edgeGeometry. */
  constructor(kit: MechKit, parent: THREE.Object3D, material: VectorMaterial, sections: number, columns: number, sortZ: number, crease: number, shape: (section: number, column: number) => Point3) {
    this.columns = columns;
    this.sortZ = sortZ;
    this.grid = new Float32Array(sections * columns * 3);
    const corners: number[] = [];
    for (let s = 0; s + 1 < sections; s++) {
      for (let c = 0; c + 1 < columns; c++) {
        const a = s * columns + c;
        corners.push(a, a + columns, a + columns + 1, a, a + columns + 1, a + 1);
      }
    }
    const built = new Float32Array(sections * columns * 3);
    for (let s = 0; s < sections; s++) {
      for (let c = 0; c < columns; c++) built.set(shape(s, c), (s * columns + c) * 3);
    }
    const source = new THREE.BufferGeometry();
    source.setAttribute('position', new THREE.BufferAttribute(built, 3));
    source.setIndex(corners);
    const geometry = kit.own(edgeGeometry(source, crease));
    source.dispose();
    this.corners = Uint16Array.from(corners);
    this.position = geometry.getAttribute('position') as THREE.BufferAttribute;
    this.normal = geometry.getAttribute('normal') as THREE.BufferAttribute;
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.position.z = sortZ;
    this.mesh.frustumCulled = false;
    parent.add(this.mesh);
  }

  set(section: number, column: number, x: number, y: number, z: number): void {
    const at = (section * this.columns + column) * 3;
    this.grid[at] = x;
    this.grid[at + 1] = y;
    this.grid[at + 2] = z - this.sortZ;
  }

  /** Uploads the points set since the last commit, with flat normals (a collapsed triangle faces up: never a NaN). */
  commit(): void {
    const grid = this.grid;
    const corners = this.corners;
    const position = this.position.array as Float32Array;
    const normal = this.normal.array as Float32Array;
    for (let t = 0; t < corners.length; t += 3) {
      const a = corners[t] * 3;
      const b = corners[t + 1] * 3;
      const c = corners[t + 2] * 3;
      for (let k = 0; k < 3; k++) {
        position[t * 3 + k] = grid[a + k];
        position[t * 3 + 3 + k] = grid[b + k];
        position[t * 3 + 6 + k] = grid[c + k];
      }
      // (c - b) x (a - b), the way edgeGeometry orients its normals.
      const ux = grid[c] - grid[b];
      const uy = grid[c + 1] - grid[b + 1];
      const uz = grid[c + 2] - grid[b + 2];
      const vx = grid[a] - grid[b];
      const vy = grid[a + 1] - grid[b + 1];
      const vz = grid[a + 2] - grid[b + 2];
      let nx = uy * vz - uz * vy;
      let ny = uz * vx - ux * vz;
      let nz = ux * vy - uy * vx;
      const length = Math.hypot(nx, ny, nz);
      if (length > 1e-9) {
        nx /= length;
        ny /= length;
        nz /= length;
      } else {
        nx = 0;
        ny = 0;
        nz = 1;
      }
      for (let v = 0; v < 3; v++) {
        normal[(t + v) * 3] = nx;
        normal[(t + v) * 3 + 1] = ny;
        normal[(t + v) * 3 + 2] = nz;
      }
    }
    this.position.needsUpdate = true;
    this.normal.needsUpdate = true;
  }
}

/** A flat star of `blades` points; the inner corners are turned by `sweep` radians, which hooks the blades like a shuriken's. */
function starShape(blades: number, outer: number, inner: number, sweep: number): Point2[] {
  const points: Point2[] = [];
  for (let i = 0; i < blades * 2; i++) {
    const angle = (Math.PI * i) / blades + (i % 2 === 1 ? sweep : 0);
    const radius = i % 2 === 0 ? outer : inner;
    points.push([Math.cos(angle) * radius, Math.sin(angle) * radius]);
  }
  return points;
}

/** The same outline on the other side of the x axis (`side` -1), or unchanged (`side` 1). */
function sided(points: readonly Point2[], side: number): Point2[] {
  return points.map(([x, y]) => [x, y * side] as const);
}

/** A three-sided pyramid (an ear, a spike): base triangle and apex, every face a crease. */
function pyramidGeometry(b1: Point3, b2: Point3, b3: Point3, apex: Point3): THREE.BufferGeometry {
  const faces = [b1, b2, b3, b1, b3, apex, b3, b2, apex, b2, b1, apex];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(faces.flatMap((p) => [p[0], p[1], p[2]]), 3));
  return geometry;
}

/** A material's own fill and edge width, which the cloak scales down from. */
interface Look {
  readonly material: VectorMaterial;
  readonly fillAlpha: number;
  readonly edgeWidth: number;
}

function looksOf(materials: readonly THREE.Material[]): Look[] {
  return materials.map((material) => {
    const vector = material as VectorMaterial;
    return { material: vector, fillAlpha: vector.uniforms.uFillAlpha.value, edgeWidth: vector.uniforms.uEdgeWidth.value };
  });
}

// ---- SHADE -------------------------------------------------------------------------------------------------------------

const ROBOT_RADIUS = toWorld(FRAME_STATS[Frame.Shade].bodyR);
const HULL_Z = 2.25;
const NECK = new THREE.Vector3(1.25, 0, 3.62);
/** The scarf: the long tail and the short one, their lengths idle and at full speed, and their widths at the knot and the end. */
const SCARF_SECTIONS = 14;
const SCARF_TAIL_SECTIONS = 9;
const SCARF_IDLE_LENGTH = 6.8;
const SCARF_RUN_LENGTH = 10.2;
const SCARF_WIDTH = [1.3, 0.62] as const;
const SCARF_TAIL_SHARE = 0.56;
/** How fast the scarf swings round to trail behind (per second): its root follows quickly, its end lags. */
const SCARF_FOLLOW = 9;
const SCARF_LAG = 3.2;
/** Cloak: faces all but vanish, edges thin down and shimmer. */
const CLOAK_FILL = 0.95;
const CLOAK_EDGE = 0.45;
const CLOAK_OPACITY = 0.6;
const CLOAK_FLOW = 0.7;

export function createShade(): RobotModel {
  const kit = createMechKit();
  const root = new THREE.Group();
  const hull = new THREE.Group();
  root.add(hull);

  const hullA = kit.teamMaterial(0.42, 0.95, 1.25, 0x05040b, 0.64, 1.35);
  const hullB = kit.teamMaterial(0.6, 0.82, 1.55, 0x0a0713, 0.58, 1.3);
  const violet = kit.accentMaterial(VIOLET, 0x10051a, 1.85, 0.14, 1.3);
  const scarfMat = kit.accentMaterial(MAGENTA, 0x3a0830, 1.75, 0.5, 1.3);
  const glass = kit.glassMaterial(0xe8c2ff, 0x0c0316);

  // Narrow torso, a chest plate over it and a small shadow core.
  const torso = kit.mesh(hull, kit.own(shapeExtrude([
    [3.1, 0], [2.2, 1.2], [0.5, 1.5], [-1.2, 1.15], [-2.6, 0.55], [-3.0, 0], [-2.6, -0.55], [-1.2, -1.15], [0.5, -1.5], [2.2, -1.2],
  ], 1.25, 0.3)), hullA, 0, 0, HULL_Z, 50);
  torso.rotation.y = -0.05;
  const chest = kit.mesh(hull, kit.own(shapeExtrude([
    [2.55, 0], [1.8, 0.85], [0.1, 1.02], [-1.3, 0.55], [-1.75, 0], [-1.3, -0.55], [0.1, -1.02], [1.8, -0.85],
  ], 0.55, 0.22)), hullB, 0.1, 0, HULL_Z + 0.95, 50);
  chest.rotation.y = -0.1;
  const heart = kit.mesh(hull, kit.own(diamondGeometry(0.34, 0.16)), violet, 1.55, 0, HULL_Z + 1.42, 30);
  heart.rotation.x = 0.4;

  // Swept pauldrons.
  for (const side of [-1, 1] as const) {
    const pauldron = kit.mesh(hull, kit.own(shapeExtrude(sided([[0.95, 0], [0.35, 0.72], [-1.45, 0.5], [-1.0, -0.3], [0.25, -0.32]], side), 0.5, 0.2)), hullB, 0.55, side * 1.42, HULL_Z + 0.72, 50);
    pauldron.rotation.x = side * -0.2;
  }

  // The fuuma shuriken folded on its back.
  const backStar = kit.mesh(hull, kit.own(shapeExtrude(starShape(4, 1.75, 0.46, 0.32), 0.16, 0.08)), hullB, -1.35, 0, HULL_Z + 1.05, 40);
  backStar.rotation.y = 0.12;
  const backHub = kit.mesh(hull, kit.own(ringGeometry(0.34, 0.1)), violet, -1.35, 0, HULL_Z + 1.24, 30);

  // Head: a low helmet with a visor slit and two blade-fin antennae swept back.
  const head = new THREE.Group();
  head.position.set(2.35, 0, HULL_Z + 1.45);
  hull.add(head);
  kit.mesh(head, kit.own(shapeExtrude([[1.0, 0], [0.55, 0.55], [-0.6, 0.52], [-0.85, 0], [-0.6, -0.52], [0.55, -0.55]], 0.62, 0.2)), hullB, 0, 0, 0, 50);
  const visor = kit.mesh(head, kit.own(lineGeometry(0.18, 0.96, 0.14)), glass, 0.66, 0, 0.2, 30);
  visor.rotation.z = 0.02;
  const fins: THREE.Group[] = [];
  for (const side of [-1, 1] as const) {
    const yaw = new THREE.Group();
    yaw.position.set(-0.2, side * 0.4, 0.3);
    head.add(yaw);
    const pitch = new THREE.Group();
    pitch.rotation.y = -0.42;
    yaw.add(pitch);
    const blade = kit.mesh(pitch, kit.own(shapeExtrude([[0, -0.16], [1.7, -0.1], [3.3, 0.02], [1.7, 0.16], [0, 0.2]], 0.08, 0.05)), hullB, 0, 0, 0, 40);
    blade.rotation.x = side * 0.35;
    fins.push(yaw);
  }

  // Forearms with shuriken launchers; they throw both stars at once (the pincer), the lead arm alternating.
  const arms: THREE.Group[] = [];
  const stars: THREE.Mesh[] = [];
  const flashes: THREE.Mesh[] = [];
  for (const side of [-1, 1] as const) {
    const arm = new THREE.Group();
    arm.position.set(0.7, side * 2.05, HULL_Z + 0.2);
    hull.add(arm);
    kit.mesh(arm, kit.own(plateGeometry(2.6, 0.5, 0.56, 0.2)), hullA, 1.2, 0, 0, 50).rotation.y = -0.06;
    kit.mesh(arm, kit.own(shapeExtrude([[1.1, 0], [0.6, 0.3], [-0.7, 0.26], [-0.7, -0.26], [0.6, -0.3]], 0.26, 0.1)), hullB, 1.15, 0, 0.38, 44);
    const star = kit.mesh(arm, kit.own(shapeExtrude(starShape(4, 0.64, 0.2, 0.36), 0.1, 0.05)), violet, 1.65, side * 0.06, 0.72, 30);
    stars.push(star);
    const flash = kit.mesh(arm, kit.own(shapeExtrude(starShape(4, 0.62, 0.14, 0), 0.06, 0.03)), glass, 2.95, 0, 0.45, 28);
    flashes.push(flash);
    arms.push(arm);
  }

  // Slim legs in a sprinter's crouch, mostly under the torso.
  const legs: THREE.Group[] = [];
  for (const side of [-1, 1] as const) {
    const leg = new THREE.Group();
    leg.position.set(-1.2, side * 0.72, 1.45);
    hull.add(leg);
    kit.mesh(leg, kit.own(shapeExtrude([[0.4, -0.3], [-1.6, -0.22], [-1.9, 0], [-1.6, 0.22], [0.4, 0.3]], 0.5, 0.14)), hullA, 0, 0, 0, 44);
    kit.mesh(leg, kit.own(shapeExtrude([[0.5, 0], [0.1, 0.28], [-0.6, 0.22], [-0.6, -0.22], [0.1, -0.28]], 0.3, 0.1)), hullB, -1.85, 0, -0.5, 44);
    legs.push(leg);
  }

  // The scarf: a knot at the neck and two tails that trail and flutter behind.
  kit.mesh(hull, kit.own(ringGeometry(0.62, 0.18)), scarfMat, NECK.x, 0, NECK.z - 0.1, 30).scale.set(1, 1.25, 0.8);
  const flat = (length: number, sections: number) => (section: number, column: number): Point3 => [-length * section / (sections - 1), column === 0 ? 0.4 : -0.4, 0];
  const scarf = new Ribbon(kit, hull, scarfMat, SCARF_SECTIONS, 2, NECK.z - 0.2, 20, flat(SCARF_RUN_LENGTH, SCARF_SECTIONS));
  const scarfTail = new Ribbon(kit, hull, scarfMat, SCARF_TAIL_SECTIONS, 2, NECK.z - 0.25, 20, flat(SCARF_RUN_LENGTH * SCARF_TAIL_SHARE, SCARF_TAIL_SECTIONS));

  const shellRing = kit.mesh(root, kit.own(ringGeometry(ROBOT_RADIUS * 1.1, 0.14)), glass, 0, 0, 0.9, 26);
  shellRing.visible = false;

  const looks = looksOf(kit.materials);
  let lastTime = Number.NaN;
  let lastFire = 0;
  let lead = 1;
  /** Where the scarf trails (world radians): its root follows the travel quickly, its end more slowly. */
  let trailRoot = 0;
  let trailEnd = 0;

  /** Lays one scarf tail from the knot along the trail, fluttering (more with speed) and twisting. */
  const layScarf = (ribbon: Ribbon, sections: number, length: number, width: number, start: THREE.Vector3, rootAngle: number, endAngle: number, droop: number, flutter: number, rate: number, time: number, phase: number): void => {
    let x = start.x;
    let y = start.y;
    const step = length / (sections - 1);
    for (let i = 0; i < sections; i++) {
      const u = i / (sections - 1);
      const heading = lerpRadians(rootAngle, endAngle, u);
      if (i > 0) {
        x += Math.cos(heading) * step;
        y += Math.sin(heading) * step;
      }
      const nx = -Math.sin(heading);
      const ny = Math.cos(heading);
      const wave = Math.sin(u * 5.2 - time * rate + phase);
      const lateral = flutter * u ** 1.25 * wave;
      const cx = x + nx * lateral;
      const cy = y + ny * lateral;
      const cz = Math.max(0.5, start.z - droop * u ** 1.4 + flutter * 0.28 * u * Math.cos(u * 4.1 - time * rate * 0.8 + phase));
      const half = lerp(SCARF_WIDTH[0], SCARF_WIDTH[1], u) * width * 0.5;
      const twist = (0.25 + flutter * 0.5) * u * Math.sin(u * 3.3 - time * rate * 0.6 + phase * 1.7);
      const wx = nx * Math.cos(twist) * half;
      const wy = ny * Math.cos(twist) * half;
      const wz = Math.sin(twist) * half;
      ribbon.set(i, 0, cx + wx, cy + wy, cz + wz);
      ribbon.set(i, 1, cx - wx, cy - wy, cz - wz);
    }
    ribbon.commit();
  };

  const tailStart = new THREE.Vector3();

  return {
    root,
    setTeam(color) {
      kit.setTeam(color);
      tintAccents(color, [scarfMat], [violet]);
    },
    update(pose: RobotPose) {
      const morph = smooth01(pose.morph);
      const cloak = clamp01(pose.special);
      const speed = clamp01(pose.speed);
      const travel = wrapAngleRadians(pose.move - pose.aim);
      const bank = Math.sin(travel) * speed;
      const alt = clamp01(pose.alt);
      const dt = Number.isNaN(lastTime) ? -1 : pose.time - lastTime;
      lastTime = pose.time;

      root.rotation.z = pose.aim;
      root.position.z = Math.sin(pose.time * 3.4) * 0.09;
      root.scale.set(1 - morph * 0.74, 1 - morph * 0.3, 1 - morph * 0.5);
      hull.rotation.x = bank * 0.22;
      hull.rotation.y = speed * 0.12 * Math.max(0.3, Math.cos(travel));
      head.rotation.z = -bank * 0.12;
      for (let i = 0; i < fins.length; i++) {
        const side = i === 0 ? -1 : 1;
        fins[i].rotation.z = side * (Math.PI - 0.78 + speed * 0.16 + cloak * 0.08);
      }

      // A new throw (the fire pulse jumps back up) switches the lead arm.
      if (pose.fire > lastFire + 0.2) lead = -lead;
      lastFire = pose.fire;
      const reload = 1 - smoothstep(0.3, 0.85, pose.fire) * 0.85;
      for (let i = 0; i < arms.length; i++) {
        const side = i === 0 ? -1 : 1;
        const throwing = pose.fire * (side === lead ? 1 : 0.62);
        arms[i].rotation.z = side * (-0.06 + throwing * 0.52 - alt * 0.62);
        arms[i].position.set(0.7 + throwing * 0.35 + alt * 0.3, side * (2.05 - alt * 0.75), HULL_Z + 0.2);
        stars[i].rotation.z = pose.time * (5 + pose.fire * 14) * side;
        stars[i].scale.setScalar(reload);
        flashes[i].visible = pose.fire > 0.04;
        flashes[i].scale.setScalar(0.4 + pose.fire * 1.2);
        flashes[i].rotation.z = pose.fire * 1.6;
      }
      const stride = Math.sin(pose.time * (5 + speed * 8));
      for (let i = 0; i < legs.length; i++) {
        const side = i === 0 ? -1 : 1;
        const swing = stride * side * speed;
        legs[i].rotation.z = side * (0.42 + speed * 0.12) + swing * 0.26;
        legs[i].position.x = -1.2 + swing * 0.4;
      }
      backStar.rotation.z = cloak * pose.time * 1.4;
      backHub.rotation.z = -pose.time * 0.8;

      // The scarf trails the travel (hangs behind the back at rest), swinging round with some lag.
      const moving = smoothstep(0.04, 0.35, speed);
      const trailTarget = Math.atan2(Math.sin(pose.move + Math.PI) * moving + Math.sin(pose.aim + Math.PI) * (1 - moving), Math.cos(pose.move + Math.PI) * moving + Math.cos(pose.aim + Math.PI) * (1 - moving));
      if (dt < 0 || dt > 0.5) {
        trailRoot = trailTarget;
        trailEnd = trailTarget;
      } else if (dt > 0) {
        trailRoot = lerpRadians(trailRoot, trailTarget, 1 - Math.exp(-SCARF_FOLLOW * dt));
        trailEnd = lerpRadians(trailEnd, trailRoot, 1 - Math.exp(-SCARF_LAG * dt));
      }
      const rootAngle = wrapAngleRadians(trailRoot - pose.aim);
      const endAngle = wrapAngleRadians(trailEnd - pose.aim);
      const length = lerp(SCARF_IDLE_LENGTH, SCARF_RUN_LENGTH, speed) * (1 - morph * 0.6);
      const flutter = 0.3 + speed * 0.95 + alt * 0.6;
      const rate = 4.5 + speed * 9;
      const droop = lerp(2.7, 1.05, speed);
      layScarf(scarf, SCARF_SECTIONS, length, 1, NECK, rootAngle, endAngle, droop, flutter, rate, pose.time, 0);
      tailStart.set(NECK.x - 0.15, NECK.y + (rootAngle > 0 ? -0.28 : 0.28), NECK.z - 0.08);
      layScarf(scarfTail, SCARF_TAIL_SECTIONS, length * SCARF_TAIL_SHARE, 0.85, tailStart, rootAngle + (rootAngle > 0 ? -0.3 : 0.3), endAngle, droop * 0.8, flutter * 0.85, rate * 1.15, pose.time, 1.9);

      shellRing.visible = pose.shield > 0.03;
      shellRing.scale.setScalar(1 + pose.shield * 0.07);
      shellRing.rotation.z = pose.time * 1.1;

      applyRobotVectorState(kit, pose.time, pose.hit, pose.charge, pose.shield, morph);
      violet.uniforms.uPulse.value += pose.fire * 0.35 + alt * 0.2;
      scarfMat.uniforms.uPulse.value += alt * 0.25 + speed * 0.04;
      violet.uniforms.uOpacity.value = lerp(1, 0.2, morph);
      scarfMat.uniforms.uOpacity.value = lerp(1, 0.12, morph);
      glass.uniforms.uOpacity.value = lerp(0.55, 0.12, morph) + pose.shield * 0.14;

      // Cloaked (only its own team ever sees this): a thin, shimmering outline.
      const shimmer = 0.5 + 0.5 * Math.sin(pose.time * 19 + Math.sin(pose.time * 6.3) * 2.2);
      for (const look of looks) {
        const u = look.material.uniforms;
        u.uFillAlpha.value = look.fillAlpha * (1 - cloak * CLOAK_FILL);
        u.uEdgeWidth.value = look.edgeWidth * (1 - cloak * CLOAK_EDGE);
        u.uOpacity.value *= 1 - cloak * (CLOAK_OPACITY - 0.2 * shimmer);
        u.uFlow.value += cloak * CLOAK_FLOW;
        u.uPulse.value += cloak * 0.12 * shimmer;
      }
    },
    dispose() {
      kit.dispose();
    },
  };
}

// ---- KITSUNE -----------------------------------------------------------------------------------------------------------

const FORM = FORMS[Frame.Shade];
const CORE_RADIUS = toWorld(FORM.coreR);
/**
 * Sort heights: three stacks the model's transparent meshes by the depth of their origins, and a colossus is wide enough for
 * the camera's tilt to reorder meshes whose origins are only a little apart in height. So the layers that must stay under the
 * others (the body and the tails' plumes) keep their origins far below the floor, on the body's axis, and are drawn
 * at their real height by lifting their geometry; the parts ride above them.
 */
const MASS_SORT_Z = -60;
const PLUME_SORT_Z = -36;
const RUFF_SORT_Z = -6;
const CORE_Z = 10;
const MASK_Z = 15;
const HAUNCH_Z = 9;
const TIP_Z = 11;
const PLUME_ROOT_Z = 6.5;
const PLUME_SECTIONS = 13;
/** A destroyed tail leaves a scorched stub of this share of its plume. */
const STUB_SHARE = 0.3;
const ASSEMBLE_ARC_HEIGHT = 5;
const ASSEMBLE_ARC_SWAY = 0.14;

function staggered(value: number, start: number, span: number): number {
  return easeOutCubic((value - start) / span);
}

interface Tail {
  readonly index: number;
  readonly order: number;
  /** Pod centre (body space), its root under the haunch, the plume's bend, its width. */
  readonly tipX: number;
  readonly tipY: number;
  readonly rootX: number;
  readonly rootY: number;
  readonly bendX: number;
  readonly bendY: number;
  readonly width: number;
  readonly siege: boolean;
  readonly ultima: boolean;
  readonly plume: Ribbon;
  /** The energy line along the tail's spine: lit while its pod winds up (which tails will fire), dark otherwise. */
  readonly spine: Ribbon;
  readonly spineMat: VectorMaterial;
  readonly tip: THREE.Group;
  readonly tuft: THREE.Mesh;
  readonly gun: THREE.Group;
  readonly orb: THREE.Mesh;
  readonly flame: THREE.Mesh;
  readonly flare: THREE.Mesh;
  readonly embers: readonly THREE.Mesh[];
  readonly hull: readonly VectorMaterial[];
  readonly fire: readonly VectorMaterial[];
  readonly plumeMat: VectorMaterial;
}

/** Where a plume's width peaks and how it closes round the tuft. */
function plumeProfile(u: number): number {
  const swell = Math.sin(Math.PI * 0.5 * Math.min(1, u / 0.68));
  const close = u > 0.68 ? 1 - 0.5 * ((u - 0.68) / 0.32) ** 2 : 1;
  return (0.3 + 0.7 * swell) * close;
}

/** A tail's white tip, pointing out along the plume: a brush of fur flicks that covers the pod. */
const TUFT: readonly Point2[] = [
  [9.4, 0], [5.8, 2.4], [6.6, 4.4], [2.6, 4.6], [1.4, 6.8], [-2.2, 5.8], [-5.6, 6.2], [-6.6, 3.6], [-8.8, 1.2],
  [-8.8, -1.2], [-6.6, -3.6], [-5.6, -6.2], [-2.2, -5.8], [1.4, -6.8], [2.6, -4.6], [6.6, -4.4], [5.8, -2.4],
];
/** Share of the team colour tinting the plumes' and tufts' faces (their fur). */
const PLUME_TINT = 0.16;
const TUFT_TINT = 0.24;

export function createKitsune(): ColossusModel {
  const kit = createMechKit();
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  const massMat = kit.teamMaterial(0.3, 0.72, 0.42, 0x040309, 0.44, 1.35);
  const ruffMat = kit.teamMaterial(0.56, 0.85, 1.25, 0x080610, 0.48, 1.3);
  const coreMat = kit.accentMaterial(0xffd2f6, 0x1a0514, 2.2, 0.16, 1.3);
  const haloMat = kit.glassMaterial(VIOLET, 0x0b0414);
  const paradeMat = kit.accentMaterial(MAGENTA, 0x1a0414, 1.9, 0.08, 1.2);

  // The fox's body under the parts: chest, flanks and rump in one dim mass (a picture of mass, not a hitbox).
  const massOutline: Point2[] = [
    [18, 0], [12, 9], [2, 12.5], [-10, 13.5], [-24, 14.5], [-35, 11], [-42, 4], [-43, 0], [-42, -4], [-35, -11], [-24, -14.5], [-10, -13.5], [2, -12.5], [12, -9],
  ];
  const massGeometry = shapeExtrude(massOutline, 3.4, 0.5);
  massGeometry.translate(0, 0, 3 - MASS_SORT_Z);
  kit.mesh(body, kit.own(massGeometry), massMat, 0, 0, MASS_SORT_Z, 70);

  // Chest ruff: fur tufts swept back round the core, one mesh on the body's axis.
  const tufts: THREE.BufferGeometry[] = [];
  const TUFTS = 11;
  for (let i = 0; i < TUFTS; i++) {
    const angle = (i / TUFTS) * Math.PI * 2 + 0.28;
    const sweep = angle + 0.4 * Math.sign(Math.sin(angle));
    const bx = Math.cos(angle);
    const by = Math.sin(angle);
    const tuft = shapeExtrude([
      [bx * 8 - by * 3, by * 8 + bx * 3], [Math.cos(sweep) * 16.5, Math.sin(sweep) * 16.5], [bx * 8 + by * 3, by * 8 - bx * 3],
    ], 1.1, 0.25);
    tuft.translate(0, 0, 7 - RUFF_SORT_Z);
    tufts.push(tuft);
  }
  const ruff = kit.mesh(body, kit.own(merge(tufts)), ruffMat, 0, 0, RUFF_SORT_Z, 30);
  for (const tuft of tufts) tuft.dispose();

  const core = kit.mesh(body, kit.own(new THREE.OctahedronGeometry(CORE_RADIUS * 0.72, 0)), coreMat, 0, 0, CORE_Z, 28);
  const coreHalo = kit.mesh(body, kit.own(ringGeometry(CORE_RADIUS * 1.3, 0.2)), haloMat, 0, 0, CORE_Z - 1.2, 28);
  const parade = kit.mesh(body, kit.own(ringGeometry(46, 0.5)), paradeMat, 0, 0, 5, 28);
  parade.visible = false;

  // ---- The mask (armour): a kitsune mask with a long snout, slanted eyes, markings and tall ears.
  const maskIndex = FORM.parts.findIndex((part) => part.name === 'mask');
  const haunchIndex = FORM.parts.findIndex((part) => part.name === 'haunch');
  if (maskIndex < 0 || haunchIndex < 0) throw new RangeError('KITSUNE needs its mask and haunch');
  const maskDef = FORM.parts[maskIndex];
  const haunchDef = FORM.parts[haunchIndex];

  const maskAnchor = new THREE.Group();
  body.add(maskAnchor);
  const maskHead = new THREE.Group();
  maskAnchor.add(maskHead);
  const maskA = kit.teamMaterial(0.56, 0.7, 1.35, 0x0b0912, 0.62, 1.45);
  const maskB = kit.teamMaterial(0.74, 0.5, 1.6, 0x100d18, 0.5, 1.35);
  const maskMark = kit.accentMaterial(MAGENTA, 0x1c0416, 2.1, 0.3, 1.3);
  kit.mesh(maskHead, kit.own(shapeExtrude([
    [17, 0], [12, 4.6], [6, 7.4], [0.5, 10.5], [-5, 15], [-8.5, 12], [-13, 7.5], [-15.5, 2.5],
    [-15.5, -2.5], [-13, -7.5], [-8.5, -12], [-5, -15], [0.5, -10.5], [6, -7.4], [12, -4.6],
  ], 3.2, 0.5)), maskA, 0, 0, 0, 40);
  const snout = kit.mesh(maskHead, kit.own(shapeExtrude([[16.5, 0], [9, 2.4], [-2, 3.6], [-9, 2.2], [-10.5, 0], [-9, -2.2], [-2, -3.6], [9, -2.4]], 1.6, 0.35)), maskB, 0, 0, 2.4, 40);
  snout.rotation.y = 0.04;
  kit.mesh(maskHead, kit.own(diamondGeometry(1.4, 0.8)), maskA, 16.2, 0, 2.6, 40);
  const eyes: THREE.Mesh[] = [];
  for (const side of [-1, 1] as const) {
    const brow = kit.mesh(maskHead, kit.own(shapeExtrude(sided([[4.2, 0], [-1, 1.3], [-7.2, 0.7], [-6.2, -0.8], [0, -0.9]], side), 0.8, 0.2)), maskB, 1.4, side * 6.2, 2.3, 40);
    brow.rotation.z = side * 0.42;
    const eye = kit.mesh(maskHead, kit.own(shapeExtrude(sided([[3.4, 0], [-2.8, 1.0], [-3.3, 0.35], [2.7, -0.55]], side), 0.5, 0.12)), maskMark, 3.8, side * 4.6, 2.9, 30);
    eye.rotation.z = side * 0.4;
    eyes.push(eye);
    for (const [x, y, turn] of [[6.4, 6.4, 0.3], [4.4, 8.1, 0.55]] as const) {
      kit.mesh(maskHead, kit.own(lineGeometry(3.6, 0.32, 0.22)), maskMark, x, side * y, 1.95, 30).rotation.z = side * turn;
    }
    const ear: [Point3, Point3, Point3, Point3] = [[-1.5, 7.2 * side, 1.6], [-13, 5.8 * side, 1.6], [-8, 14.2 * side, 1.4], [-14.5, 15 * side, 12.5]];
    kit.mesh(maskHead, kit.own(pyramidGeometry(ear[0], ear[1], ear[2], ear[3])), maskB, 0, 0, 0, 30);
    const inward = (p: Point3, share: number): Point3 => [lerp(p[0], -8.4, share), lerp(p[1], 10.6 * side, share), lerp(p[2], 5.2, share) + 0.4];
    kit.mesh(maskHead, kit.own(pyramidGeometry(inward(ear[0], 0.3), inward(ear[2], 0.3), inward(ear[3], 0.3), inward([-6.8, 10.4 * side, 3.6], 0))), maskMark, 0, 0, 0, 30);
  }
  const flameMark = kit.mesh(maskHead, kit.own(shapeExtrude([[4.2, 0], [0.6, 1.7], [-2.6, 1.2], [-3.4, 0], [-2.6, -1.2], [0.6, -1.7]], 0.5, 0.14)), maskMark, -6.2, 0, 3.3, 30);

  // ---- The haunch (armour): the rump the nine tails grow from.
  const haunchAnchor = new THREE.Group();
  body.add(haunchAnchor);
  const hauA = kit.teamMaterial(0.5, 0.82, 1.3, 0x09070f, 0.6, 1.45);
  const hauB = kit.teamMaterial(0.68, 0.62, 1.55, 0x0e0b16, 0.48, 1.35);
  const hauMark = kit.accentMaterial(MAGENTA, 0x1c0416, 1.9, 0.2, 1.2);
  const rump: Point2[] = [[12, 5], [8, 11], [0, 15], [-9, 14.5], [-15, 9], [-17, 0], [-15, -9], [-9, -14.5], [0, -15], [8, -11], [12, -5], [13, 0]];
  kit.mesh(haunchAnchor, kit.own(shapeExtrude(rump, 3.2, 0.5)), hauA, 0, 0, 0, 40);
  kit.mesh(haunchAnchor, kit.own(shapeExtrude(rump.map(([x, y]) => [x * 0.6 - 1.5, y * 0.58] as const), 1.3, 0.3)), hauB, 0, 0, 2.2, 40);
  for (const x of [5, -1.5, -8]) {
    kit.mesh(haunchAnchor, kit.own(shapeExtrude([[-2.2, 0], [1.4, 3.6], [2.8, 3.6], [-0.8, 0], [2.8, -3.6], [1.4, -3.6]], 0.5, 0.12)), hauB, x, 0, 3.3, 30);
  }
  for (const side of [-1, 1] as const) {
    kit.mesh(haunchAnchor, kit.own(plateGeometry(9, 4.2, 1.2, 0.2)), hauB, -2, side * 11.4, 1.9, 40).rotation.z = side * 0.5;
  }
  const knot = kit.mesh(haunchAnchor, kit.own(ringGeometry(3.4, 0.55)), hauMark, -13.2, 0, 2.6, 28);
  kit.mesh(haunchAnchor, kit.own(diamondGeometry(1.2, 0.6)), hauMark, -13.2, 0, 3.2, 28).rotation.x = 0.4;

  const maskLooks = [maskA, maskB, maskMark];
  const haunchLooks = [hauA, hauB, hauMark];

  // ---- The nine tails: plumes fanned from under the haunch, a white tuft and a foxfire at each tip (the pods).
  const haunchX = toWorld(haunchDef.x);
  const haunchY = toWorld(haunchDef.y);
  const pods = FORM.parts.flatMap((part, index) => (part.kind === PartKind.Pod ? [index] : []));
  const byFan = [...pods].sort((a, b) => Math.abs(wrapAngleRadians(Math.atan2(toWorld(FORM.parts[a].y), toWorld(FORM.parts[a].x)) - Math.PI)) - Math.abs(wrapAngleRadians(Math.atan2(toWorld(FORM.parts[b].y), toWorld(FORM.parts[b].x)) - Math.PI)));
  const tails: Tail[] = pods.map((index) => {
    const def = FORM.parts[index];
    const tipX = toWorld(def.x);
    const tipY = toWorld(def.y);
    const radius = toWorld(def.rad);
    const angle = Math.atan2(tipY, tipX);
    const rootX = haunchX + Math.cos(angle) * 9;
    const rootY = haunchY + Math.sin(angle) * 9;
    const reach = Math.hypot(tipX - rootX, tipY - rootY);
    const outX = Math.cos(angle) - 1;
    const outY = Math.sin(angle);
    const out = Math.hypot(outX, outY);
    const plumeMat = kit.teamMaterial(0.5, 0.9, 1.3, 0x07050c, 0.52, 1.35);
    const tuftMat = kit.teamMaterial(0.66, 0.62, 1.45, 0x0d0b14, 0.5, 1.35);
    const fireMat = kit.accentMaterial(MAGENTA, 0x1a0414, 2.0, 0.22, 1.3);
    const fireCore = kit.accentMaterial(0xffe4fb, 0x1a0a18, 2.4, 0.3, 1.2);
    const width = Math.min(7.6, Math.max(5.2, 3 + reach * 0.1));
    const plume = new Ribbon(kit, body, plumeMat, PLUME_SECTIONS, 2, PLUME_SORT_Z, 22, (section, column) => {
      const u = section / (PLUME_SECTIONS - 1);
      const half = plumeProfile(u) * width;
      return [u * 40, column === 0 ? half : -half, 0];
    });
    const spineMat = kit.accentMaterial(MAGENTA, 0x2a0620, 2.1, 0.5, 1.2);
    const spine = new Ribbon(kit, body, spineMat, PLUME_SECTIONS, 2, PLUME_SORT_Z + 2, 22, (section, column) => [section * 3, column === 0 ? 0.4 : -0.4, 0]);
    const tip = new THREE.Group();
    body.add(tip);
    const scale = radius / 9;
    const tuft = kit.mesh(tip, kit.own(shapeExtrude(TUFT.map(([x, y]) => [x * scale, y * scale] as const), 1.2, 0.3)), tuftMat, 0, 0, 0, 40);
    const gun = new THREE.Group();
    tip.add(gun);
    const orb = kit.mesh(gun, kit.own(new THREE.IcosahedronGeometry(radius * 0.34, 0)), fireMat, 0, 0, 2.4, 28);
    kit.mesh(gun, kit.own(new THREE.OctahedronGeometry(radius * 0.16, 0)), fireCore, 0, 0, 2.7, 28);
    const reachOut = toWorld(def.muzzle);
    const flame = kit.mesh(gun, kit.own(shapeExtrude([[reachOut, 0], [reachOut * 0.46, 1.5], [reachOut * 0.1, 2.4], [-2, 2], [-3, 0], [-2, -2], [reachOut * 0.1, -2.4], [reachOut * 0.46, -1.5]], 0.8, 0.2)), fireMat, 0, 0, 2.3, 30);
    const flare = kit.mesh(gun, kit.own(ringGeometry(radius * 0.58, 0.24)), fireCore, 0, 0, 2.5, 26);
    const embers = [0, 1, 2].map(() => kit.mesh(gun, kit.own(diamondGeometry(0.8, 0.4)), fireMat, 0, 0, 3.2, 26));
    return {
      index,
      order: byFan.indexOf(index),
      tipX,
      tipY,
      rootX,
      rootY,
      bendX: rootX + (outX / out) * reach * 0.55,
      bendY: rootY + (outY / out) * reach * 0.55,
      width,
      siege: (def.roles & Role.Siege) !== 0,
      ultima: (def.roles & Role.Ultima) !== 0,
      plume,
      spine,
      spineMat,
      tip,
      tuft,
      gun,
      orb,
      flame,
      flare,
      embers,
      hull: [plumeMat, tuftMat],
      fire: [fireMat, fireCore],
      plumeMat,
    };
  });

  /** Lays a tail's plume along its bend from root to tip (a share of it when destroyed), swaying without leaving its ends; returns the heading it arrives at the tip with. */
  const layPlume = (tail: Tail, tipX: number, tipY: number, reach: number, sway: number, arch: number, time: number, rate: number, lit: boolean): number => {
    const bendX = lerp(tail.rootX, tail.bendX, reach);
    const bendY = lerp(tail.rootY, tail.bendY, reach);
    const stub = reach < 0 ? 1 : 0;
    const share = stub ? STUB_SHARE : 1;
    let lastX = 0;
    let lastY = 0;
    let heading = 0;
    for (let s = 0; s < PLUME_SECTIONS; s++) {
      const u = (s / (PLUME_SECTIONS - 1)) * share;
      const a = (1 - u) * (1 - u);
      const b = 2 * (1 - u) * u;
      const c = u * u;
      const x = a * tail.rootX + b * bendX + c * tipX;
      const y = a * tail.rootY + b * bendY + c * tipY;
      let tx = 2 * (1 - u) * (bendX - tail.rootX) + 2 * u * (tipX - bendX);
      let ty = 2 * (1 - u) * (bendY - tail.rootY) + 2 * u * (tipY - bendY);
      const length = Math.hypot(tx, ty);
      tx = length > 1e-6 ? tx / length : -1;
      ty = length > 1e-6 ? ty / length : 0;
      const nx = -ty;
      const ny = tx;
      const lateral = sway * Math.sin(Math.PI * u) * Math.sin(time * rate + tail.order * 0.9 - u * 2.4);
      const z = lerp(PLUME_ROOT_Z, TIP_Z - 1, u) + arch * Math.sin(Math.PI * u);
      const taper = stub ? 1 - (s / (PLUME_SECTIONS - 1)) ** 2 : 1;
      const half = plumeProfile(u) * tail.width * Math.max(0.2, Math.abs(reach)) * taper;
      const px = x + nx * lateral;
      const py = y + ny * lateral;
      tail.plume.set(s, 0, px + nx * half, py + ny * half, z);
      tail.plume.set(s, 1, px - nx * half, py - ny * half, z);
      if (lit) {
        const line = lerp(0.5, 0.22, u) * taper;
        tail.spine.set(s, 0, px + nx * line, py + ny * line, z + 0.3);
        tail.spine.set(s, 1, px - nx * line, py - ny * line, z + 0.3);
      }
      if (s > 0) heading = Math.atan2(py - lastY, px - lastX);
      lastX = px;
      lastY = py;
    }
    tail.plume.commit();
    if (lit) tail.spine.commit();
    return heading;
  };

  const placeArmor = (anchor: THREE.Group, def: typeof maskDef, ease: number, z: number): void => {
    const homeX = toWorld(def.x);
    const homeY = toWorld(def.y);
    const arc = Math.sin(ease * Math.PI);
    anchor.position.set(homeX * ease - homeY * ASSEMBLE_ARC_SWAY * arc, homeY * ease + homeX * ASSEMBLE_ARC_SWAY * arc, z + (1 - ease) * 3 + arc * ASSEMBLE_ARC_HEIGHT);
    anchor.scale.setScalar(0.4 + 0.6 * ease);
  };

  const partState = (materials: readonly VectorMaterial[], part: PartPose, hit: number, extraPulse: number): void => {
    for (const material of materials) {
      material.uniforms.uFlash.value = Math.max(part.flash * 0.45, hit * 0.28);
      material.uniforms.uPulse.value += (part.hp < 0.35 ? 0.1 + 0.08 * Math.sin(material.uniforms.uTime.value * 13) : 0) + extraPulse;
    }
  };

  return {
    root,
    setTeam(color) {
      kit.setTeam(color);
      tintAccents(color, [maskMark, hauMark, paradeMat, ...tails.flatMap((tail) => [tail.fire[0], tail.spineMat])], [haloMat]);
      for (const tail of tails) {
        tail.hull[0].uniforms.uFill.value.copy(color).multiplyScalar(PLUME_TINT);
        tail.hull[1].uniforms.uFill.value.copy(color).multiplyScalar(TUFT_TINT);
      }
    },
    update(pose: ColossusPose) {
      const assemble = smooth01(pose.assemble);
      const windup = pose.phase === AttackPhase.Windup ? clamp01(pose.progress) : 0;
      const release = pose.phase === AttackPhase.Release ? 1 : 0;
      const siegeWindup = pose.attack === Attack.Siege ? windup : 0;
      const ultimaWindup = pose.attack === Attack.Ultima ? windup : 0;
      const ultimaRelease = pose.attack === Attack.Ultima ? release : 0;
      const rise = Math.max(ultimaWindup, ultimaRelease);
      const recovery = pose.phase === AttackPhase.Recovery ? 1 - clamp01(pose.progress) : 0;
      const speed = clamp01(pose.speed);
      const time = pose.time;

      body.rotation.z = pose.body;
      body.position.z = Math.sin(time * 1.3) * 0.3 - siegeWindup * 1.4 + rise * 0.9 - recovery * 0.4;

      const trot = time * (2.6 + speed * 5.5);
      core.scale.setScalar(0.45 + assemble * (0.3 + pose.fuel * 0.3));
      core.rotation.z = time * 0.5;
      coreHalo.rotation.z = -time * 0.3;
      coreHalo.visible = assemble > 0.08;
      ruff.scale.setScalar(0.5 + 0.5 * assemble);
      parade.visible = rise > 0.01;
      parade.scale.setScalar(ultimaRelease > 0 ? 1 + 0.04 * Math.sin(time * 7) : 1.35 - ultimaWindup * 0.55);
      parade.rotation.z = time * (0.6 + rise);

      // Mask: bows into a siege lob, rears up through the ultima; eyes blaze with the attack.
      const maskPose = pose.parts[maskIndex];
      maskAnchor.visible = maskPose.hp > 0 && assemble > 0.02;
      placeArmor(maskAnchor, maskDef, staggered(assemble, 0.02, 0.6), MASK_Z);
      maskHead.rotation.y = siegeWindup * 0.12 - rise * 0.1;
      maskHead.rotation.z = Math.sin(time * 0.7) * 0.03;
      for (let i = 0; i < eyes.length; i++) eyes[i].scale.set(1 + rise * 0.3, 1 + rise * 0.2, 1);
      flameMark.scale.setScalar(1 + rise * 0.35 + 0.05 * Math.sin(time * 5));

      const haunchPose = pose.parts[haunchIndex];
      haunchAnchor.visible = haunchPose.hp > 0 && assemble > 0.02;
      placeArmor(haunchAnchor, haunchDef, staggered(assemble, 0.08, 0.6), HAUNCH_Z);
      haunchAnchor.rotation.z = Math.sin(trot) * 0.02 * speed;
      knot.rotation.z = time * 0.6;

      applyColossusVectorState(kit, time, pose.hit, pose.fuel, assemble);
      massMat.uniforms.uOpacity.value = 0.5;
      massMat.uniforms.uPulse.value = 0;
      coreMat.uniforms.uPulse.value += 0.1 + (1 - pose.fuel) * 0.14 * (0.5 + 0.5 * Math.sin(time * 9)) + rise * 0.2;
      haloMat.uniforms.uOpacity.value = 0.18 + (1 - pose.fuel) * 0.08 + rise * 0.1;
      paradeMat.uniforms.uOpacity.value = 0.3 + rise * 0.5;
      paradeMat.uniforms.uPulse.value += rise * 0.3;
      partState(maskLooks, maskPose, pose.hit, 0);
      maskMark.uniforms.uPulse.value += rise * 0.4 + siegeWindup * 0.2 + 0.05 * Math.sin(time * 3);
      partState(haunchLooks, haunchPose, pose.hit, 0);
      hauMark.uniforms.uPulse.value += rise * 0.2;

      const sway = 1.8 + speed * 1.8 + rise * 1.4;
      const swayRate = 1.7 + speed * 1.6 + rise * 2.4;
      for (const tail of tails) {
        const part = pose.parts[tail.index];
        const alive = part.hp > 0;
        const ease = staggered(assemble, 0.18 + tail.order * 0.055, 0.5);
        const shown = ease > 0.02;
        const tipX = lerp(tail.rootX, tail.tipX, ease);
        const tipY = lerp(tail.rootY, tail.tipY, ease);
        tail.plume.mesh.visible = shown;
        tail.tip.visible = shown && alive;
        const charge = alive && !part.away ? clamp01(part.charge) : 0;
        const burning = ultimaRelease > 0 && tail.ultima && alive && !part.away ? 1 : 0;
        const energy = Math.max(charge, burning * (0.55 + 0.25 * Math.sin(time * 9 + tail.order)));
        const lit = shown && energy > 0.02;
        const arch = 2.2 + (tail.siege ? siegeWindup * 5 : 0) + rise * 2.5 + charge * 1.2;
        const arrive = shown ? layPlume(tail, tipX, tipY, alive ? ease : -ease, alive ? sway : sway * 0.25, arch, time, swayRate, lit) : 0;
        tail.spine.mesh.visible = lit;
        tail.spineMat.uniforms.uOpacity.value = energy;
        tail.spineMat.uniforms.uFlow.value = 0.9;
        tail.spineMat.uniforms.uPulse.value += energy * 0.5;
        tail.plumeMat.uniforms.uOpacity.value = alive ? 0.92 : 0.45;
        partState(tail.hull, part, pose.hit, 0);
        if (!tail.tip.visible) continue;
        const arc = Math.sin(ease * Math.PI);
        tail.tip.position.set(tipX, tipY, TIP_Z + arc * ASSEMBLE_ARC_HEIGHT * 0.5);
        tail.tip.scale.setScalar(0.3 + 0.7 * ease);
        tail.tuft.rotation.z = arrive;
        tail.gun.rotation.z = part.facing - pose.body;
        const flicker = 0.06 * Math.sin(time * 11 + tail.order * 1.7) + 0.04 * Math.sin(time * 23 + tail.order);
        tail.orb.scale.setScalar(1 + charge * 0.7 + flicker + burning * 0.25);
        tail.orb.rotation.z = time * 1.3;
        tail.flame.visible = !part.away;
        tail.flame.scale.set(0.62 + charge * 0.42 + burning * 0.08 + flicker, 1 + charge * 0.35 + flicker, 1);
        tail.flare.visible = charge > 0.02;
        tail.flare.scale.setScalar(1.9 - charge * 0.95);
        tail.flare.rotation.z = -time * 2;
        const heat = clamp01(part.heat);
        for (let e = 0; e < tail.embers.length; e++) {
          const ember = tail.embers[e];
          ember.visible = heat > 0.04;
          const angle = time * 2.4 + (e * Math.PI * 2) / 3;
          ember.position.set(Math.cos(angle) * 5.4, Math.sin(angle) * 5.4, 3.2);
          ember.scale.setScalar(0.6 + heat * 0.8);
        }
        partState(tail.fire, part, pose.hit, charge * 0.7 + heat * 0.45 + burning * 0.12 + (part.away ? 0.4 : 0));
        for (const material of tail.fire) material.uniforms.uOpacity.value = 0.78 + charge * 0.22;
      }
    },
    dispose() {
      kit.dispose();
    },
  };
}
