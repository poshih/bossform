import { hashToString } from '@metronome/engine';
import { AudioEngine } from './audio/audio.ts';
import { AudioDirector } from './audio/director.ts';
import { BeatClock } from './beat.ts';
import type { Beat } from './beat.ts';
import { backingScale } from './config.ts';
import { Devices } from './input/devices.ts';
import { RelayLobby } from './net/lobby.ts';
import type { OnlineStart } from './net/lobby.ts';
import { MatchRun } from './run.ts';
import { freeForAllTeams, FRAME_NAMES } from './setup.ts';
import type { MatchSetup } from './setup.ts';
import { Attack, AttackPhase, Ev, FORMS, FRAME_COUNT, isFighting, Mode, NEUTRAL_INPUT, NO_SEAT, Phase, TICK_RATE, W } from './sim/index.ts';
import type { World } from './sim/index.ts';
import { Hud } from './ui/hud.ts';
import { Menus, MenuScreen } from './ui/menus.ts';
import { Stage } from './view/stage.ts';

/** Where the application is: a bot match behind the title menu, a match being played, the pause menu, the results, or the online lobby. */
type Screen = 'attract' | 'play' | 'paused' | 'results' | 'lobby';

export interface AppParts {
  readonly stageCanvas: HTMLCanvasElement;
  readonly hudCanvas: HTMLCanvasElement;
  readonly menusRoot: HTMLElement;
  readonly notice: HTMLElement;
}

export interface AppOptions {
  readonly relayUrl: string;
  readonly playerName: string;
  /** Development and test aid for single-machine matches: simulate this many times faster (whole number, at most the clock's catch-up limit). */
  readonly timescale: number;
  /** Skip the menus and start this match at once. */
  readonly start: MatchSetup | null;
  /** Test aid for single-machine matches: freeze the simulation halfway through the first wind-up of this boss attack (an Attack id), so the tell can be inspected. */
  readonly freezeOnWindup: number | null;
}

const RESULTS_DELAY_TICKS = 3 * TICK_RATE;
const SPECTATE_SWITCH_SECONDS = 6;
const NOTICE_SECONDS = 6;
const ATTRACT_PILOTS = 6;
const ATTRACT_MODE = Mode.Deathmatch;
const NEW_SEED_WORDS = 1;

const newSeed = (): number => crypto.getRandomValues(new Uint32Array(NEW_SEED_WORDS))[0];

/** A bot-only match to watch behind the title screen. */
function attractSetup(): MatchSetup {
  return {
    mode: ATTRACT_MODE,
    seed: newSeed(),
    pilots: Array.from({ length: ATTRACT_PILOTS }, (_, seat) => ({ name: `BOT ${seat + 1}`, frame: seat % FRAME_COUNT, team: freeForAllTeams(ATTRACT_PILOTS)[seat], bot: true })),
  };
}

export class App {
  private readonly parts: AppParts;
  private readonly options: AppOptions;
  private readonly audio: AudioEngine;
  private readonly director: AudioDirector;
  private readonly devices: Devices;
  private readonly hud = new Hud();
  private readonly beatClock = new BeatClock();
  private readonly hudContext: CanvasRenderingContext2D;
  private readonly menus: Menus;
  private run: MatchRun | null = null;
  private stage: Stage | null = null;
  private lobby: RelayLobby | null = null;
  private screen: Screen = 'attract';
  private lastSetup: MatchSetup | null = null;
  private focusSeat = 0;
  private stagedFocus = -1;
  private spectateSeconds = 0;
  private resultsAtTick = -1;
  private cssWidth = 1;
  private cssHeight = 1;
  private pixelRatio = 1;
  private elapsedSeconds = 0;
  private noticeUntil = 0;
  private frozen = false;

  constructor(parts: AppParts, options: AppOptions, audio: AudioEngine) {
    this.parts = parts;
    this.options = options;
    this.audio = audio;
    this.director = new AudioDirector(audio);
    this.devices = new Devices(parts.stageCanvas.parentElement!);
    const context = parts.hudCanvas.getContext('2d');
    if (context === null) throw new Error('the 2D canvas for the HUD is unavailable');
    this.hudContext = context;
    this.menus = new Menus(parts.menusRoot, {
      requestSeed: newSeed,
      onStartMatch: (setup) => this.startMatch(setup),
      onJoinLobby: (room) => this.joinLobby(room),
      onLobbyEdit: (edits) => this.lobby?.edit(edits),
      onLobbyStart: () => this.lobby?.start(),
      onLeaveLobby: () => this.quitToTitle(),
      onResume: () => this.resume(),
      onQuitToTitle: () => this.quitToTitle(),
      onRematch: () => this.rematch(),
      onToggleMute: () => this.toggleMute(),
    });
    audio.onMuteChange = () => undefined;
  }

  /** Starts the application: a requested match at once, else the title screen over a bot match. */
  begin(): void {
    if (this.options.start !== null) this.startMatch(this.options.start);
    else this.showTitle();
  }

  resize(cssWidth: number, cssHeight: number, devicePixelRatio: number): void {
    this.cssWidth = cssWidth;
    this.cssHeight = cssHeight;
    this.pixelRatio = backingScale(cssWidth, cssHeight, devicePixelRatio);
    const { hudCanvas } = this.parts;
    hudCanvas.width = Math.max(1, Math.floor(cssWidth * this.pixelRatio));
    hudCanvas.height = Math.max(1, Math.floor(cssHeight * this.pixelRatio));
    this.stage?.resize(cssWidth, cssHeight, this.pixelRatio);
  }

  // ---- screens ---------------------------------------------------------------------------------------

  private showTitle(): void {
    this.leaveRun();
    this.beginRun(attractSetup(), undefined, 'attract');
    this.menus.show(MenuScreen.Title);
    this.audio.playMusic('title');
  }

  private startMatch(setup: MatchSetup, online?: OnlineStart): void {
    this.lastSetup = setup;
    this.lobby = online === undefined ? this.lobby : null;
    this.leaveRun();
    this.beginRun(setup, online, 'play');
    this.menus.hide();
  }

  private joinLobby(room: string): void {
    this.lobby?.leave();
    this.setScreen('lobby');
    this.menus.show(MenuScreen.Lobby);
    this.lobby = new RelayLobby(
      { relayUrl: this.options.relayUrl, room, name: this.options.playerName, frame: 0 },
      { onState: (state) => this.menus.update(state), onStart: (start) => this.startMatch(start.setup, start) },
    );
  }

  private pause(): void {
    if (this.screen !== 'play' || this.run === null) return;
    if (this.run.canPause) this.run.setPaused(true);
    this.setScreen('paused');
    this.menus.show(MenuScreen.Pause);
  }

  private resume(): void {
    if (this.screen !== 'paused' || this.run === null) return;
    if (this.run.canPause) this.run.setPaused(false);
    this.setScreen('play');
    this.menus.hide();
  }

  private rematch(): void {
    if (this.lastSetup === null || this.run === null || this.run.online) {
      this.quitToTitle();
      return;
    }
    this.startMatch({ ...this.lastSetup, seed: newSeed() });
  }

  private quitToTitle(): void {
    this.lobby?.leave();
    this.lobby = null;
    this.showTitle();
  }

  private toggleMute(): void {
    this.audio.setMuted(!this.audio.isMuted());
  }

  private notify(message: string): void {
    this.parts.notice.textContent = message;
    this.parts.notice.hidden = false;
    this.noticeUntil = this.elapsedSeconds + NOTICE_SECONDS;
  }

  // ---- runs ------------------------------------------------------------------------------------------

  private beginRun(setup: MatchSetup, online: OnlineStart | undefined, screen: Screen): void {
    const run = new MatchRun(
      setup,
      {
        // Only a pilot who is playing flies: in the pause menu (which an online match does not stop) the ship idles.
        sampleHuman: () => (this.screen === 'play' ? this.devices.sample((x, y) => this.stage!.aimFrom(this.run!.localSeat, x, y)) : NEUTRAL_INPUT),
        onTick: (world) => this.stage?.tick(world),
      },
      online === undefined ? undefined : { transport: online.transport, self: online.self, seatOwners: online.seatOwners, inputDelay: online.inputDelay },
    );
    this.run = run;
    this.stage = new Stage(this.parts.stageCanvas, run.world);
    this.stage.resize(this.cssWidth, this.cssHeight, this.pixelRatio);
    this.focusSeat = Math.max(0, run.localSeat);
    this.shotsBySeat.length = 0;
    this.stagedFocus = -1;
    this.spectateSeconds = 0;
    this.resultsAtTick = -1;
    this.setScreen(screen);
    this.audio.stopMusic();
  }

  /** The one place the screen changes: game input is captured exactly while a match is being played. */
  private setScreen(screen: Screen): void {
    this.screen = screen;
    this.devices.setCapturing(screen === 'play');
  }

  private leaveRun(): void {
    if (this.run === null) return;
    this.run.leave();
    this.stage?.dispose();
    this.run = null;
    this.stage = null;
    this.devices.setCapturing(false);
  }

  /** The seat the camera (and the listener) follows: the local pilot; when they are out, whoever hurt them, then anyone still fighting. */
  private updateFocus(world: World, dtSeconds: number, localSeat: number): void {
    if (this.frozen) return;
    if (localSeat >= 0 && isFighting(world, localSeat)) {
      this.focusSeat = localSeat;
      this.spectateSeconds = 0;
    } else {
      this.spectateSeconds += dtSeconds;
      const watching = this.focusSeat !== localSeat && isFighting(world, this.focusSeat);
      if (!watching || this.spectateSeconds > SPECTATE_SWITCH_SECONDS) {
        const killer = localSeat >= 0 ? world.m.plLastHit[localSeat] : NO_SEAT;
        this.focusSeat = killer !== NO_SEAT && !watching && isFighting(world, killer) ? killer : this.nextFighting(world, this.focusSeat, localSeat);
        this.spectateSeconds = 0;
      }
    }
    if (this.focusSeat !== this.stagedFocus) {
      this.stage!.focus(this.focusSeat);
      this.stagedFocus = this.focusSeat;
    }
  }

  private nextFighting(world: World, after: number, exclude: number): number {
    for (let step = 1; step <= world.seats; step++) {
      const seat = (after + step) % world.seats;
      if (seat !== exclude && isFighting(world, seat)) return seat;
    }
    return this.focusSeat;
  }

  // ---- frame ------------------------------------------------------------------------------------------

  /** One call per rendered frame. `nowMs` is the animation-frame timestamp, `dtSeconds` the time since the last frame. */
  frame(nowMs: number, dtSeconds: number): void {
    this.elapsedSeconds += dtSeconds;
    if (this.noticeUntil > 0 && this.elapsedSeconds > this.noticeUntil) {
      this.parts.notice.hidden = true;
      this.noticeUntil = 0;
    }
    for (const action of this.devices.takeActions()) {
      if (action === 'mute') this.toggleMute();
      else if (this.screen === 'play') this.pause();
      else if (this.screen === 'paused') this.resume();
    }
    const run = this.run;
    const stage = this.stage;
    if (run === null || stage === null) return;

    const time = this.options.timescale > 1 && !run.online ? nowMs * this.options.timescale : nowMs;
    const result = run.frame(time);
    const world = run.world;
    this.checkSession(run, result.status);
    this.updateFocus(world, dtSeconds, run.localSeat);

    const attract = this.screen === 'attract';
    stage.handleEvents(world);
    if (!attract) {
      this.hud.handleEvents(world);
      this.director.handleEvents(world, this.focusSeat);
    }
    this.countShots(world);
    world.events.clear();
    this.freezeIfRequested(run, world);
    this.beatClock.advance(dtSeconds, this.audio.musicPosition());
    const beat = this.beatClock.state;
    stage.render(world, result.alpha, dtSeconds, beat);
    if (!attract) this.director.update(world, this.focusSeat, dtSeconds);
    this.drawHud(run, world, beat);
    this.checkMatchEnd(run, world);
  }

  private freezeIfRequested(run: MatchRun, world: World): void {
    const attack = this.options.freezeOnWindup;
    if (attack === null || this.frozen || !run.canPause) return;
    const { m } = world;
    for (let seat = 0; seat < world.seats; seat++) {
      if (m.plAtk[seat] !== attack || m.plAtkPhase[seat] !== AttackPhase.Windup) continue;
      const form = FORMS[m.plFrame[seat]];
      const timing = attack === Attack.Salvo ? form.salvo : attack === Attack.Siege ? form.siege : form.ultima;
      if (m.plAtkTimer[seat] > timing.windup / 2) continue;
      run.setPaused(true);
      this.frozen = true;
      this.focusSeat = seat;
      this.stage!.focus(seat);
      this.stagedFocus = seat;
      return;
    }
  }

  private drawHud(run: MatchRun, world: World, beat: Beat): void {
    const ctx = this.hudContext;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.parts.hudCanvas.width, this.parts.hudCanvas.height);
    if (this.screen === 'attract' || this.screen === 'lobby') return;
    ctx.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
    const stage = this.stage!;
    this.hud.draw(ctx, {
      world,
      seat: this.focusSeat,
      names: run.setup.pilots.map((pilot) => pilot.name),
      width: this.cssWidth,
      height: this.cssHeight,
      project: (x, y, out) => stage.project(x, y, out),
      ground: (cssX, cssY, out) => stage.ground(cssX, cssY, out),
      seatScreen: (seat, out) => stage.seatScreen(seat, out),
      beat,
      time: this.elapsedSeconds,
      cursor: this.screen === 'play' && run.localSeat >= 0 && isFighting(world, run.localSeat) ? this.devices.cursor : null,
    });
  }

  private checkSession(run: MatchRun, status: string): void {
    if (status !== 'desynced' && status !== 'aborted') return;
    const reason = status === 'desynced' ? 'THE MATCH DESYNCED' : `THE MATCH WAS ABORTED (${(run.session.abortReason ?? 'unknown').toUpperCase()})`;
    this.notify(reason);
    this.quitToTitle();
  }

  private checkMatchEnd(run: MatchRun, world: World): void {
    if (this.screen !== 'play' || world.m.world[W.Phase] !== Phase.Over) return;
    const tick = world.m.world[W.Tick];
    if (this.resultsAtTick < 0) this.resultsAtTick = tick + RESULTS_DELAY_TICKS;
    if (tick < this.resultsAtTick) return;
    this.setScreen('results');
    this.menus.showResults(world, run.setup.pilots.map((pilot) => pilot.name));
  }

  // ---- read-only view for tests and tools --------------------------------------------------------------

  /** Tools only (profiling): hides or shows a scene view of the current match. */
  setViewVisible(index: number, visible: boolean): void {
    if (this.stage === null) throw new Error('no match is running');
    this.stage.setViewVisible(index, visible);
  }

  /** Tools only: weapon firings per seat in the current match (Ev.Fire), for input checks. */
  private readonly shotsBySeat: number[] = [];

  private countShots(world: World): void {
    const events = world.events;
    for (let i = 0; i < events.count; i++) {
      if (events.type[i] !== Ev.Fire) continue;
      const seat = events.a[i];
      this.shotsBySeat[seat] = (this.shotsBySeat[seat] ?? 0) + 1;
    }
  }

  private focusScreen(stage: Stage): { x: number; y: number; width: number; height: number } {
    const out = { x: 0, y: 0 };
    stage.seatScreen(this.focusSeat, out);
    return { x: out.x, y: out.y, width: this.cssWidth, height: this.cssHeight };
  }

  debug(): unknown {
    const run = this.run;
    if (run === null) return { screen: this.screen, running: false };
    const world = run.world;
    const { m } = world;
    return {
      screen: this.screen,
      running: true,
      frozen: this.frozen,
      online: run.online,
      status: run.session.status,
      tick: run.session.tick,
      phase: m.world[W.Phase],
      round: m.world[W.Round],
      winner: m.world[W.Winner],
      localSeat: run.localSeat,
      focusSeat: this.focusSeat,
      hash: hashToString(run.sim.memory.hash()),
      dropped: m.world[W.Dropped],
      projectiles: world.cap.projectiles - m.world[W.ProjFree],
      neutrals: world.cap.neutrals - m.world[W.NeutralFree],
      orbs: world.cap.orbs - m.world[W.OrbFree],
      seats: Array.from({ length: world.seats }, (_, seat) => ({
        name: run.setup.pilots[seat].name,
        frame: FRAME_NAMES[m.plFrame[seat]],
        team: m.plTeam[seat],
        active: m.plActive[seat] === 1,
        alive: m.plAlive[seat] === 1,
        form: m.plForm[seat],
        attack: m.plAtk[seat],
        attackPhase: m.plAtkPhase[seat],
        hp: m.plHp[seat],
        gauge: m.plGauge[seat],
        aim: m.plAim[seat],
        x: m.plX[seat] / 65536,
        y: m.plY[seat] / 65536,
        kills: m.plKills[seat],
        deaths: m.plDeaths[seat],
        fired: this.shotsBySeat[seat] ?? 0,
      })),
      stats: { ...run.session.stats },
      camera: this.stage?.cameraState ?? null,
      focusScreen: this.stage === null ? null : this.focusScreen(this.stage),
    };
  }
}
