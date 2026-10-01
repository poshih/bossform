import type { SimInit, Simulation, TickInput } from '@metronome/engine';
import { expireProjectiles } from './blast.ts';
import { collideProjectiles } from './combat.ts';
import type { GameInput } from './input.ts';
import { W } from './layout.ts';
import { resolveMatch, startMatch, updateMatch } from './match.ts';
import { updateNeutrals } from './neutrals.ts';
import { updateOrbs } from './orbs.ts';
import { updateProjectiles } from './projectiles.ts';
import { updateShips } from './ships.ts';
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
    startMatch(this.world);
  }

  step(frame: TickInput<GameInput>): void {
    const w = this.world;
    w.m.world[W.Tick]++;
    updateMatch(w);
    updateShips(w, frame.inputs, frame.present);
    updateNeutrals(w);
    updateProjectiles(w);
    expireProjectiles(w);
    collideProjectiles(w);
    updateOrbs(w);
    resolveMatch(w);
  }
}

export function createGameSim(init: SimInit): GameSim {
  return new GameSim(init);
}
