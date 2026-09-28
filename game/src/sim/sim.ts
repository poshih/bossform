import type { SimInit, Simulation, TickInput } from '@metronome/engine';
import { updateBullets } from './bullets.ts';
import { collideBodies, collideBullets, collideShots } from './collisions.ts';
import { updateOrbs } from './combat.ts';
import { updateEnemies } from './enemies.ts';
import { checkGameOver, updateFlow } from './flow.ts';
import type { GameInput } from './input.ts';
import { W } from './layout.ts';
import { updatePlayers } from './players.ts';
import { updateShots } from './shots.ts';
import { World } from './world.ts';

/**
 * The BOSSFORM simulation: a pure function of (state in `memory`, this tick's inputs). It implements the
 * engine's Simulation contract and knows nothing about rendering, audio, the DOM or the network.
 */
export class GameSim implements Simulation<GameInput> {
  readonly world: World;
  readonly memory: World['memory'];

  constructor(init: SimInit) {
    this.world = new World(init);
    this.memory = this.world.memory;
  }

  step(frame: TickInput<GameInput>): void {
    const w = this.world;
    w.m.world[W.Tick]++;
    updateFlow(w);
    updatePlayers(w, frame.inputs, frame.present);
    updateEnemies(w);
    updateBullets(w);
    updateShots(w);
    collideShots(w);
    collideBullets(w);
    collideBodies(w);
    updateOrbs(w);
    checkGameOver(w);
  }
}

export function createGameSim(init: SimInit): GameSim {
  return new GameSim(init);
}
