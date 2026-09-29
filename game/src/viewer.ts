import * as THREE from 'three';
import { TEAM_COLORS } from './config.ts';
import { Pipeline } from './render/pipeline.ts';
import { AttackPhase, FORMS, Frame, NeutralType } from './sim/index.ts';
import { createColossus, createNeutral, createRobot } from './view/models/index.ts';
import type { ColossusPose, NeutralPose, PartPose, RobotPose } from './view/models/index.ts';

/**
 * Dev-only model viewer: renders one model on a grid, posed from URL parameters, through the real render pipeline.
 * Examples:
 *   ?model=vanguard&form=robot&fire=1&aim=30
 *   ?model=gale&form=colossus&assemble=1&attack=1&phase=1&progress=0.6&destroy=1,3
 *   ?model=warden&team=2
 * Parameters (all optional): model (vanguard|gale|juggernaut|drone|sentinel|warden), form (robot|colossus), team (0-7),
 * t (seconds), anim=1 (advance time), aim, move, body, orbit (degrees), speed, fire, alt, hit, charge, shield, morph,
 * assemble, attack (0-3), phase (0-3), progress, fuel, heat, pod (0..1 charge on every pod), destroy (part indices),
 * flash (0..1 on every part), zoom (bigger = closer), tilt (degrees from straight down), spin=1.
 */
const params = new URLSearchParams(location.search);
const num = (key: string, fallback: number): number => (params.has(key) ? Number(params.get(key)) : fallback);
const rad = (degrees: number): number => (degrees * Math.PI) / 180;

const model = params.get('model') ?? 'vanguard';
const form = params.get('form') ?? 'robot';
const team = num('team', 1);
const FRAME_OF: Record<string, number> = { vanguard: Frame.Vanguard, gale: Frame.Gale, juggernaut: Frame.Juggernaut };
const NEUTRAL_OF: Record<string, number> = { drone: NeutralType.Drone, sentinel: NeutralType.Sentinel, warden: NeutralType.Warden };

const canvas = document.getElementById('c') as HTMLCanvasElement;
const pipeline = new Pipeline(canvas);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(32, 1, 1, 6000);

const grid = new THREE.GridHelper(2400, 60, 0x0d3347, 0x0a2433);
grid.rotation.x = Math.PI / 2;
scene.add(grid);

const color = new THREE.Color(TEAM_COLORS[team % TEAM_COLORS.length]);
let update: (time: number) => void;
let extent = 60;

if (model in NEUTRAL_OF) {
  const unit = createNeutral(NEUTRAL_OF[model]);
  scene.add(unit.root);
  extent = 26;
  update = (time) => {
    const pose: NeutralPose = { time, heading: rad(num('aim', 0)), flash: num('hit', 0), hp: num('hp', 1), telegraph: num('fire', 0), speed: num('speed', 0) };
    unit.update(pose);
  };
} else if (model in FRAME_OF && form === 'colossus') {
  const frame = FRAME_OF[model];
  const colossus = createColossus(frame);
  colossus.setTeam(color);
  scene.add(colossus.root);
  extent = 90;
  const destroyed = new Set((params.get('destroy') ?? '').split(',').filter(Boolean).map(Number));
  update = (time) => {
    const parts: PartPose[] = FORMS[frame].parts.map((_, k) => ({
      hp: destroyed.has(k) ? 0 : 1,
      facing: rad(num('body', 0)) + rad(num('podturn', 0)),
      flash: num('flash', 0),
      heat: num('heat', 0),
      charge: num('pod', 0),
    }));
    const pose: ColossusPose = {
      time, body: rad(num('body', 0)), orbit: rad(num('orbit', 0)) + (params.get('anim') === '1' ? time * 2 : 0), assemble: num('assemble', 1), speed: num('speed', 0),
      attack: num('attack', 0), phase: num('phase', AttackPhase.Idle), progress: num('progress', 0), fuel: num('fuel', 1), hit: num('hit', 0), parts,
    };
    colossus.update(pose);
  };
} else if (model in FRAME_OF) {
  const robot = createRobot(FRAME_OF[model]);
  robot.setTeam(color);
  scene.add(robot.root);
  extent = 22;
  update = (time) => {
    const pose: RobotPose = {
      time, aim: rad(num('aim', 0)), move: rad(num('move', 0)), speed: num('speed', 0), fire: num('fire', 0), alt: num('alt', 0), hit: num('hit', 0),
      charge: num('charge', 0), shield: num('shield', 0), morph: num('morph', 0),
    };
    robot.update(pose);
  };
} else {
  throw new Error(`unknown model "${model}"`);
}

function layout(): void {
  pipeline.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio);
  camera.aspect = window.innerWidth / window.innerHeight;
  const distance = ((extent * 1.3) / Math.tan(rad(camera.fov / 2))) / num('zoom', 1);
  const tilt = rad(num('tilt', 24));
  camera.position.set(0, -Math.sin(tilt) * distance, Math.cos(tilt) * distance);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', layout);
layout();

let time = num('t', 0);
let last = performance.now();
function frame(now: number): void {
  if (params.get('anim') === '1') time += (now - last) / 1000;
  last = now;
  update(time);
  scene.rotation.z = params.get('spin') === '1' ? time * 0.4 : 0;
  pipeline.render(scene, camera);
  (window as unknown as { ready?: boolean }).ready = true;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
