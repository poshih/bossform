import { Bot } from './bot/bot.ts';
import { Menus, MenuScreen } from './ui/menus.ts';
import { createGameSim, encodeConfig, Frame, MAX_PLAYERS, Mode } from './sim/index.ts';
import { evenTeams } from './setup.ts';

declare global {
  interface Window { ready?: boolean; }
}

const root = document.getElementById('app')!;
const status = document.getElementById('status')!;
const query = new URLSearchParams(location.search);
const screen = (query.get('screen') ?? 'title').toLowerCase();
const menus = new Menus(root, {
  requestSeed: () => 777001,
  onStartMatch: (setup) => { status.textContent = `Start: ${setup.pilots.length} pilots · seed ${setup.seed}`; },
  onJoinLobby: (room) => { status.textContent = `Join room ${room}`; },
  onLobbyEdit: (edits) => { status.textContent = `Edit ${JSON.stringify(edits)}`; },
  onLobbyStart: () => { status.textContent = 'Lobby start'; },
  onLeaveLobby: () => { status.textContent = 'Leave lobby'; },
  onResume: () => { status.textContent = 'Resume'; },
  onQuitToTitle: () => { status.textContent = 'Quit to title'; menus.show(MenuScreen.Title); },
  onRematch: () => { status.textContent = 'Rematch'; },
  onToggleMute: () => { status.textContent = 'Mute toggle'; },
});

menus.update({
  room: 'vector-arena',
  mode: Mode.Elimination,
  maxPlayers: MAX_PLAYERS,
  host: true,
  status: 'waiting',
  message: 'Waiting for pilots. Host may adjust mode, teams, and bots.',
  players: [
    { name: 'YOU', frame: Frame.Vanguard, team: 0, bot: false, self: true, host: true },
    { name: 'BRAVO', frame: Frame.Gale, team: 1, bot: false, self: false, host: false },
    { name: 'CHARLIE', frame: Frame.Juggernaut, team: 0, bot: true, self: false, host: false },
    { name: 'DELTA', frame: Frame.Gale, team: 1, bot: true, self: false, host: false },
  ],
});

const seats = 4;
const sim = createGameSim({
  seed: 7878,
  seats,
  config: encodeConfig({ mode: Mode.Deathmatch, seats: Array.from({ length: seats }, (_, seat) => ({ frame: seat % 3, team: evenTeams(seats, 2)[seat] })) }),
});
const bots = Array.from({ length: seats }, (_, seat) => new Bot(seat, 500 + seat, 0.85));
for (let tick = 0; tick < 900; tick++) {
  sim.step({ tick, inputs: bots.map((bot) => bot.think(sim.world)), present: Array.from({ length: seats }, () => true) });
  sim.world.events.clear();
}
menus.showResults(sim.world, ['YOU', 'BRAVO', 'CHARLIE', 'DELTA']);

switch (screen) {
  case 'title':
    menus.show(MenuScreen.Title);
    break;
  case 'setup':
    menus.show(MenuScreen.Setup);
    break;
  case 'lobby':
    menus.show(MenuScreen.Lobby);
    break;
  case 'help':
    menus.show(MenuScreen.Help);
    break;
  case 'pause':
    menus.show(MenuScreen.Pause);
    break;
  case 'results':
    menus.show(MenuScreen.Results);
    break;
  default:
    throw new RangeError(`unknown demo screen ${screen}`);
}
window.ready = true;
