import { fx, hashToString } from '@metronome/engine';
import type { AudioEngine, Track } from './audio/audio.ts';
import { Devices } from './input/devices.ts';
import type { AimContext } from './input/devices.ts';
import type { Renderer } from './render/renderer.ts';
import { createRun, demoFrame, randomSeed, soundFor } from './run.ts';
import type { NetworkSetup, Run, RunSetup } from './run.ts';
import { Difficulty, Frame, FRAME_COUNT, Phase, W } from './sim/index.ts';
import type { GameInput, World } from './sim/index.ts';
import { clock, fmtScore, text } from './ui/draw.ts';
import { TEXT } from './ui/font.ts';
import { Hud } from './ui/hud.ts';
import { Menu } from './ui/menu.ts';
import { DIFFICULTY_NAMES, FRAME_META } from './ui/meta.ts';
import { drawHelp, drawPause, drawResults, drawSelect, drawTitle, HELP_PAGE_COUNT, pedestalRects } from './ui/screens.ts';
import { FieldView } from './view/field.ts';
import { Showcase } from './view/showcase.ts';

type Screen = 'title' | 'select' | 'help' | 'play' | 'pause' | 'results';

const FADE_SECONDS = 0.45;
const DEMO_MAX_TICKS = 60 * 55;
const RESULTS_DELAY_OVER = 240;
const RESULTS_DELAY_WIN = 500;
const NOTICE_SECONDS = 2.6;
const DEMO_SEED = 0x5eed01;
const GAME_OVER_EASE = 1.4;
const STALL_NOTICE_SECONDS = 0.5;

const TITLE_ITEMS = { start: 0, coop: 1, difficulty: 2, sound: 3, help: 4, online: 5 } as const;

/** A network start handed over by the online lobby (see net/lobby.ts). */
export interface OnlineStart {
  readonly setup: RunSetup;
  readonly network: NetworkSetup;
  readonly label: string;
}

export class App {
  private readonly renderer: Renderer;
  private readonly audio: AudioEngine;
  private readonly devices: Devices;
  private readonly view: FieldView;
  private readonly showcase: Showcase;
  private readonly hud: Hud;
  private readonly canvas: HTMLCanvasElement;

  private screen: Screen = 'title';
  private run: Run | null = null;
  private time = 0;
  private fade = 1;
  private alpha = 0;
  private demoCount = 0;
  private difficulty: number = Difficulty.Normal;
  private helpPage = 0;
  private endTicks = 0;
  private notice: { text: string; until: number } | null = null;
  private track: Track | null = null;
  private onlineLabel: string | null = null;
  private gameOverFade = 0;

  private readonly picking = { seats: 1, seat: 0, cursor: 0, frames: [] as number[], mode: 'local' as 'local' | 'online' };
  private readonly titleMenu: Menu;
  private readonly pauseMenu = new Menu(['RESUME', 'RESTART', 'SOUND: ON', 'QUIT TO TITLE']);
  private readonly resultsMenu = new Menu(['PLAY AGAIN', 'CHANGE FRAME', 'TITLE']);
  private lastSetup: RunSetup | null = null;
  /** Set by the entry point when a relay is configured: joins a room with the chosen frame. */
  requestOnline: ((frame: number, difficulty: number) => void) | null = null;

  constructor(renderer: Renderer, audio: AudioEngine, canvas: HTMLCanvasElement, options: { online: boolean }) {
    this.renderer = renderer;
    this.audio = audio;
    this.canvas = canvas;
    this.devices = new Devices(canvas);
    this.view = new FieldView(renderer);
    this.showcase = new Showcase(renderer);
    this.hud = new Hud(renderer);
    const items = ['START', 'CO-OP (2 PLAYERS)', 'DIFFICULTY', 'SOUND', 'HOW TO PLAY'];
    if (options.online) items.push('ONLINE CO-OP');
    this.titleMenu = new Menu(items);
    this.refreshLabels();
    this.startDemo();
  }

  /** Compiles every shader program up front. */
  warmup(): void {
    this.view.warmup();
  }

  // ------------------------------------------------------------------------------------------------
  // Runs
  // ------------------------------------------------------------------------------------------------

  private startDemo(): void {
    const frame = demoFrame(this.demoCount++);
    this.beginRun(createRun('demo', { seats: 1, frames: [frame], difficulty: Difficulty.Normal, stage: 0, seed: DEMO_SEED + this.demoCount }, null));
  }

  private beginRun(run: Run): void {
    this.run = run;
    this.view.bind(run.world);
    this.hud.reset();
    this.endTicks = 0;
    this.gameOverFade = 0;
    this.alpha = 0;
  }

  private startPlay(setup: RunSetup): void {
    this.lastSetup = setup;
    this.devices.mode = setup.seats > 1 ? 'local2p' : 'solo';
    this.devices.resetAim();
    this.onlineLabel = null;
    this.beginRun(createRun('play', setup, { sample: (seat) => this.sampleSeat(seat) }));
    this.enterScreen('play');
  }

  /** Called by the lobby once every peer has agreed on the setup. */
  startOnline(start: OnlineStart): void {
    this.lastSetup = start.setup;
    this.devices.mode = 'solo';
    this.devices.resetAim();
    this.onlineLabel = start.label;
    const run = createRun('online', start.setup, { sample: (seat) => this.sampleSeat(seat), onDesync: () => this.flash('DESYNC DETECTED') }, start.network);
    this.beginRun(run);
    this.enterScreen('play');
  }

  private enterScreen(next: Screen): void {
    this.screen = next;
    this.fade = 1;
    this.showcase.show(next === 'select');
    this.view.setVisible(next !== 'select');
    this.canvas.style.cursor = next === 'play' ? 'none' : 'default';
    if (next === 'title') this.startDemo();
    if (this.run) this.run.runner.setPaused(next === 'pause' || next === 'select' || next === 'help');
  }

  private flash(message: string, seconds: number = NOTICE_SECONDS): void {
    this.notice = { text: message, until: this.time + seconds };
  }

  /** Shows a short status line at the bottom of the screen (used by the online lobby). */
  notify(message: string, seconds: number = NOTICE_SECONDS): void {
    this.flash(message, seconds);
  }

  private refreshLabels(): void {
    this.titleMenu.items[TITLE_ITEMS.difficulty] = `DIFFICULTY: ${DIFFICULTY_NAMES[this.difficulty]}`;
    this.titleMenu.items[TITLE_ITEMS.sound] = `SOUND: ${this.audio.isMuted() ? 'OFF' : 'ON'}`;
    this.pauseMenu.items[2] = `SOUND: ${this.audio.isMuted() ? 'OFF' : 'ON'}`;
  }

  // ------------------------------------------------------------------------------------------------
  // Input
  // ------------------------------------------------------------------------------------------------

  private pointerUi(): { x: number; y: number } | null {
    if (this.devices.pointerX < 0) return null;
    return this.renderer.clientToUi(this.devices.pointerX, this.devices.pointerY, this.canvas.getBoundingClientRect());
  }

  private pointerWorld(): { x: number; y: number } | null {
    const ui = this.pointerUi();
    if (!ui) return null;
    const m = this.renderer.metrics;
    return { x: (ui.x - m.lowW / 2) * m.unitsPerPx, y: (m.lowH / 2 - ui.y) * m.unitsPerPx };
  }

  /** Reads the controls for `seat`. The n-th seat this machine owns uses the n-th device slot (online play: always slot 0). */
  private sampleSeat(seat: number): GameInput {
    const run = this.run;
    const context: AimContext = { pointerWorld: this.pointerWorld(), mech: null };
    if (run) context.mech = { x: run.world.m.plX[seat] / fx.ONE, y: run.world.m.plY[seat] / fx.ONE };
    return this.devices.sample(Math.max(0, run ? run.localSeats.indexOf(seat) : 0), context);
  }

  private handleMenu(menu: Menu, taps: Array<{ x: number; y: number }>, hover: { x: number; y: number } | null): 'confirm' | 'left' | 'right' | 'back' | null {
    const d = this.devices;
    if (d.consume('up')) {
      menu.move(-1);
      this.audio.play('uiMove');
    }
    if (d.consume('down')) {
      menu.move(1);
      this.audio.play('uiMove');
    }
    for (const tap of taps) {
      const hit = menu.hit(tap.x, tap.y);
      if (hit >= 0) {
        menu.index = hit;
        return 'confirm';
      }
    }
    if (hover && d.pointerActive) {
      const hit = menu.hit(hover.x, hover.y);
      if (hit >= 0 && hit !== menu.index) {
        menu.index = hit;
        this.audio.play('uiMove');
      }
    }
    if (d.consume('confirm')) return 'confirm';
    if (d.consume('left')) return 'left';
    if (d.consume('right')) return 'right';
    if (d.consume('back')) return 'back';
    return null;
  }

  // ------------------------------------------------------------------------------------------------
  // Frame update
  // ------------------------------------------------------------------------------------------------

  update(dt: number, nowMs: number): void {
    this.time += dt;
    const d = this.devices;
    d.poll();
    if (d.consume('mute')) {
      this.audio.setMuted(!this.audio.isMuted());
      this.refreshLabels();
    }
    this.fade = Math.max(0, this.fade - dt / FADE_SECONDS);
    const taps = d.takeTaps().map((t) => this.renderer.clientToUi(t.clientX, t.clientY, this.canvas.getBoundingClientRect()));
    const hover = this.pointerUi();

    switch (this.screen) {
      case 'title': this.updateTitle(taps, hover); break;
      case 'select': this.updateSelect(taps); break;
      case 'help': this.updateHelp(); break;
      case 'play': this.updatePlay(); break;
      case 'pause': this.updatePause(taps, hover); break;
      case 'results': this.updateResults(taps, hover); break;
    }

    this.stepRun(nowMs);
    this.showcase.update(dt);
    if (this.run && this.screen !== 'select') this.view.update(this.run.world, this.alpha, dt);
    this.updateMusic();
    this.applyScreenPost(dt);
  }

  private updateTitle(taps: Array<{ x: number; y: number }>, hover: { x: number; y: number } | null): void {
    const action = this.handleMenu(this.titleMenu, taps, hover);
    if (!action) return;
    const item = this.titleMenu.index;
    const change = action === 'left' ? -1 : 1;
    if (item === TITLE_ITEMS.difficulty && action !== 'back') {
      this.difficulty = (this.difficulty + change + DIFFICULTY_NAMES.length) % DIFFICULTY_NAMES.length;
      this.refreshLabels();
      this.audio.play('uiSelect');
      return;
    }
    if (item === TITLE_ITEMS.sound && action !== 'back') {
      this.audio.setMuted(!this.audio.isMuted());
      this.refreshLabels();
      this.audio.play('uiSelect');
      return;
    }
    if (action !== 'confirm') return;
    this.audio.play('uiSelect');
    if (item === TITLE_ITEMS.start) this.openSelect(1, 'local');
    else if (item === TITLE_ITEMS.coop) {
      if (this.devices.padCount < 1) this.flash('CONNECT A GAMEPAD FOR PLAYER 2');
      else this.openSelect(2, 'local');
    } else if (item === TITLE_ITEMS.help) {
      this.helpPage = 0;
      this.enterScreen('help');
    } else if (item === TITLE_ITEMS.online) this.openSelect(1, 'online');
  }

  private openSelect(seats: number, mode: 'local' | 'online'): void {
    this.picking.mode = mode;
    this.picking.seats = seats;
    this.picking.seat = 0;
    this.picking.cursor = Frame.Vanguard;
    this.picking.frames = [];
    this.showcase.select(this.picking.cursor);
    this.enterScreen('select');
  }

  private updateSelect(taps: Array<{ x: number; y: number }>): void {
    const d = this.devices;
    const p = this.picking;
    let confirm = d.consume('confirm');
    if (d.consume('left')) {
      p.cursor = (p.cursor + FRAME_COUNT - 1) % FRAME_COUNT;
      this.audio.play('uiMove');
    }
    if (d.consume('right')) {
      p.cursor = (p.cursor + 1) % FRAME_COUNT;
      this.audio.play('uiMove');
    }
    const rects = pedestalRects(this.renderer, this.showcase);
    for (const tap of taps) {
      const hit = rects.findIndex((r) => tap.x >= r.x && tap.x < r.x + r.w && tap.y >= r.y && tap.y < r.y + r.h);
      if (hit >= 0) {
        if (hit === p.cursor) confirm = true;
        p.cursor = hit;
      }
    }
    this.showcase.select(p.cursor);
    if (d.consume('back')) {
      this.audio.play('uiBack');
      if (p.seat > 0) {
        p.seat--;
        p.frames.pop();
        p.cursor = p.frames[p.seat] ?? Frame.Vanguard;
      } else this.enterScreen('title');
      return;
    }
    if (!confirm) return;
    this.audio.play('uiSelect');
    p.frames[p.seat] = p.cursor;
    if (p.seat + 1 < p.seats) {
      p.seat++;
      p.cursor = Frame.Vanguard;
      return;
    }
    if (p.mode === 'online') {
      this.enterScreen('title');
      this.requestOnline?.(p.cursor, this.difficulty);
      return;
    }
    this.startPlay({ seats: p.seats, frames: [...p.frames], difficulty: this.difficulty, stage: 0, seed: randomSeed() });
  }

  private updateHelp(): void {
    const d = this.devices;
    if (d.consume('right') || d.consume('confirm')) {
      this.helpPage = (this.helpPage + 1) % HELP_PAGE_COUNT;
      this.audio.play('uiMove');
    }
    if (d.consume('left')) {
      this.helpPage = (this.helpPage + HELP_PAGE_COUNT - 1) % HELP_PAGE_COUNT;
      this.audio.play('uiMove');
    }
    if (d.consume('back')) {
      this.audio.play('uiBack');
      this.enterScreen('title');
    }
  }

  private canPause(): boolean {
    return this.run !== null && this.run.kind === 'play';
  }

  private updatePlay(): void {
    if (this.devices.consume('pause') || this.devices.consume('back')) {
      if (this.canPause()) {
        this.pauseMenu.index = 0;
        this.audio.play('pause');
        this.enterScreen('pause');
      }
    }
  }

  private updatePause(taps: Array<{ x: number; y: number }>, hover: { x: number; y: number } | null): void {
    if (this.devices.consume('pause')) {
      this.enterScreen('play');
      return;
    }
    const action = this.handleMenu(this.pauseMenu, taps, hover);
    if (action === 'back') {
      this.enterScreen('play');
      return;
    }
    if (action !== 'confirm') return;
    this.audio.play('uiSelect');
    switch (this.pauseMenu.index) {
      case 0: this.enterScreen('play'); break;
      case 1:
        if (this.lastSetup) this.startPlay({ ...this.lastSetup, seed: randomSeed() });
        break;
      case 2:
        this.audio.setMuted(!this.audio.isMuted());
        this.refreshLabels();
        break;
      default:
        this.closeRun();
        this.enterScreen('title');
    }
  }

  private updateResults(taps: Array<{ x: number; y: number }>, hover: { x: number; y: number } | null): void {
    const action = this.handleMenu(this.resultsMenu, taps, hover);
    if (action !== 'confirm') return;
    this.audio.play('uiSelect');
    if (this.resultsMenu.index === 0 && this.lastSetup && this.run?.kind !== 'online') this.startPlay({ ...this.lastSetup, seed: randomSeed() });
    else if (this.resultsMenu.index === 1 && this.run?.kind !== 'online') this.openSelect(this.lastSetup?.seats ?? 1, 'local');
    else {
      this.closeRun();
      this.enterScreen('title');
    }
  }

  private closeRun(): void {
    if (this.run?.kind === 'online') {
      this.run.session.leave();
      this.run.session.close();
    }
    this.run = null;
  }

  // ------------------------------------------------------------------------------------------------
  // Simulation stepping
  // ------------------------------------------------------------------------------------------------

  private stepRun(nowMs: number): void {
    const run = this.run;
    if (!run) return;
    const result = run.runner.frame(nowMs);
    this.alpha = result.alpha;
    if (run.kind === 'online' && result.stalled && this.screen === 'play') this.flash('WAITING FOR THE OTHER PLAYER...', STALL_NOTICE_SECONDS);
    for (let i = 0; i < result.ticks; i++) this.hud.tick();
    this.drainEvents(run);

    const phase = run.world.m.world[W.Phase];
    if (run.kind === 'demo') {
      if (this.screen === 'title' && (phase === Phase.Over || phase === Phase.Win || run.session.tick > DEMO_MAX_TICKS)) this.startDemo();
      return;
    }
    if (result.status === 'aborted' || result.status === 'desynced') {
      this.flash(result.status === 'desynced' ? 'DESYNC - MATCH ENDED' : 'CONNECTION LOST');
      this.closeRun();
      this.enterScreen('title');
      return;
    }
    if (phase === Phase.Over || phase === Phase.Win) this.endTicks += result.ticks;
    else this.endTicks = 0;
    if (this.screen === 'play') {
      const delay = phase === Phase.Win ? RESULTS_DELAY_WIN : RESULTS_DELAY_OVER;
      if ((phase === Phase.Over || phase === Phase.Win) && this.endTicks >= delay) {
        this.resultsMenu.index = 0;
        this.resultsMenu.items = run.kind === 'online' ? ['TITLE'] : ['PLAY AGAIN', 'CHANGE FRAME', 'TITLE'];
        this.enterScreen('results');
      }
    }
  }

  private drainEvents(run: Run): void {
    const q = run.world.events;
    for (let i = 0; i < q.count; i++) {
      const type = q.type[i];
      const x = q.x[i];
      const y = q.y[i];
      const a = q.a[i];
      this.view.handleEvent(type, x, y, a);
      if (run.kind === 'demo') continue;
      this.hud.onEvent(type, x, y, a);
      const cue = soundFor(type, x, a);
      if (cue) this.audio.play(cue.sfx, cue.options);
    }
    q.clear();
    let beam = false;
    if (run.kind !== 'demo' && this.screen === 'play') for (const seat of run.localSeats) if (run.world.m.plBeam[seat] === 1) beam = true;
    this.audio.setBeam(beam);
  }

  private updateMusic(): void {
    let next: Track = 'title';
    const run = this.run;
    if (run && run.kind !== 'demo') {
      const m = run.world.m;
      const phase = m.world[W.Phase];
      const bossForm = run.localSeats.some((s) => m.plBoss[s] > 0);
      if (phase === Phase.Over) next = 'gameOver';
      else if (phase === Phase.Win || phase === Phase.Clear) next = 'clear';
      else if (bossForm) next = 'bossMode';
      else if (phase === Phase.Boss || phase === Phase.BossWarning) next = 'boss';
      else next = (['stage1', 'stage2', 'stage3'] as const)[m.world[W.Stage]] ?? 'stage1';
    }
    if (next !== this.track) {
      this.track = next;
      this.audio.playMusic(next);
    }
  }

  private applyScreenPost(dt: number): void {
    const post = this.renderer.post;
    post.fade = this.fade;
    const run = this.run;
    const over = run !== null && run.kind !== 'demo' && run.world.m.world[W.Phase] === Phase.Over;
    this.gameOverFade += ((over ? 1 : 0) - this.gameOverFade) * Math.min(1, dt * GAME_OVER_EASE);
    post.mono = this.gameOverFade * 0.85;
    post.vhs = this.gameOverFade * 0.7;
  }

  onFocusLost(): void {
    this.devices.releaseAll();
    if (this.screen === 'play' && this.canPause()) {
      this.pauseMenu.index = 0;
      this.enterScreen('pause');
    }
  }

  // ------------------------------------------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------------------------------------------

  render(): void {
    const r = this.renderer;
    const ctx = r.ui;
    ctx.clearRect(0, 0, r.metrics.lowW, r.metrics.lowH);
    const run = this.run;
    const world = run?.world;

    if (world && (this.screen === 'play' || this.screen === 'pause' || this.screen === 'results')) {
      const local = (run?.localSeats ?? []).map((seat) => {
        const ui = { x: 0, y: 0 };
        const p = { x: 0, y: 0 };
        return { seat, ui: this.view.mechPosition(seat, p) ? r.worldToUi(p.x, p.y, ui) : null };
      });
      const usingPointer = this.devices.pointerActive && this.devices.lastDevice === 'keyboard' && this.screen === 'play';
      this.hud.draw(ctx, {
        world,
        time: this.time,
        cursor: usingPointer ? this.pointerUi() : null,
        local: this.screen === 'play' ? local : [],
        padPrompts: this.devices.lastDevice === 'pad',
        online: this.onlineLabel && run ? `${this.onlineLabel}  ${Math.round(run.session.stats.rttMs)}MS` : null,
      });
    }

    switch (this.screen) {
      case 'title':
        drawTitle(ctx, r, { menu: this.titleMenu, time: this.time, pad: this.devices.lastDevice === 'pad' });
        break;
      case 'select':
        drawSelect(ctx, r, { frame: this.picking.cursor, seat: this.picking.seat, seats: this.picking.seats, time: this.time, showcase: this.showcase, pad: this.devices.lastDevice === 'pad' });
        break;
      case 'help':
        drawHelp(ctx, r, this.helpPage, this.time);
        break;
      case 'pause':
        drawPause(ctx, r, this.pauseMenu, this.time);
        break;
      case 'results':
        if (world) drawResults(ctx, r, { victory: world.m.world[W.Phase] === Phase.Win, lines: this.resultLines(world), menu: this.resultsMenu, time: this.time });
        break;
      default:
        break;
    }
    if (this.notice && this.time < this.notice.until) {
      text(ctx, this.notice.text, r.metrics.lowW / 2, r.metrics.lowH - 34, 1, TEXT.gold, 'center');
    }
    r.markUiDirty();
    r.render(this.view.elapsed);
  }

  private resultLines(world: World): Array<readonly [string, string]> {
    const { m } = world;
    let score = 0;
    let kills = 0;
    let grazes = 0;
    const names: string[] = [];
    for (let p = 0; p < world.seats; p++) {
      score += m.plScore[p];
      kills += m.plKills[p];
      grazes += m.plGraze[p];
      names.push(FRAME_META[m.plFrame[p]].name);
    }
    return [
      ['FRAME', names.join(' + ')],
      ['DIFFICULTY', DIFFICULTY_NAMES[m.world[W.Difficulty]]],
      ['STAGE REACHED', `${m.world[W.Stage] + 1}`],
      ['SCORE', fmtScore(score)],
      ['ENEMIES DESTROYED', `${kills}`],
      ['BULLETS GRAZED', `${grazes}`],
      ['TIME', clock(m.world[W.Tick])],
    ];
  }

  // ------------------------------------------------------------------------------------------------
  // Diagnostics (used by the browser E2E checks)
  // ------------------------------------------------------------------------------------------------

  diagnostics(): Record<string, unknown> {
    const run = this.run;
    const m = run?.world.m;
    return {
      screen: this.screen,
      kind: run?.kind ?? null,
      tick: run?.session.tick ?? 0,
      status: run?.session.status ?? null,
      phase: m?.world[W.Phase] ?? null,
      stage: m?.world[W.Stage] ?? null,
      hash: run ? hashToString(run.session.sim.memory.hash()) : null,
      players: m ? Array.from({ length: run!.world.seats }, (_, p) => ({
        hp: m.plHp[p], lives: m.plLives[p], gauge: m.plGauge[p], boss: m.plBoss[p], score: m.plScore[p], kills: m.plKills[p], x: m.plX[p] / fx.ONE, y: m.plY[p] / fx.ONE,
        aim: m.plAim[p], frame: m.plFrame[p],
      })) : [],
      stats: run?.session.stats ?? null,
    };
  }

  /** Test hook: the live world (the E2E harness may inject state, e.g. a full gauge, in solo play). */
  debugWorld(): World | null {
    return this.run?.world ?? null;
  }

  exportReplay(): Uint8Array | null {
    return this.run && this.run.kind !== 'demo' ? this.run.session.exportReplay() : null;
  }
}
