/**
 * DOM menu overlay for BOSSFORM.
 *
 * Public API:
 *   new Menus(root, callbacks)
 *   show(screen)
 *   hide()
 *   setMuted(muted)
 *   update(lobby)
 *   showResults(world, names)
 *
 * The class reports user intent only through MenuCallbacks. It never starts a match itself.
 */
import { fx } from '@metronome/engine';
import { ALT_LABELS, DEFAULT_NAMES, evenTeams, FORM_NAMES, FRAME_BLURBS, FRAME_NAMES, FRAME_TAGLINES, freeForAllTeams, MODE_BLURBS, MODE_NAMES, PRIMARY_LABELS } from '../setup.ts';
import type { LobbyEdits, LobbyState, MatchSetup } from '../setup.ts';
import { FRAME_COUNT, FRAME_STATS, Frame, MAX_PLAYERS, Mode, TICK_RATE, W } from '../sim/index.ts';
import type { World } from '../sim/index.ts';
import { FRAME_EMBLEM_COLORS, frameEmblemSvg } from './icons.ts';
import { cssHex, teamCss, UI_ACCENT, UI_BACKGROUND, UI_CAPS_SPACING, UI_EDGE, UI_EDGE_SOFT, UI_FONT_STACK, UI_PANEL, UI_PANEL_STRONG, UI_SUCCESS, UI_TEXT, UI_TEXT_DIM, UI_WARNING } from './theme.ts';

const STYLE_ID = 'bossform-menus-style';
const TITLE_TAGLINE = 'VECTOR MECH ARENA';
const RESULT_COUNT_SECONDS = 0.72;
const SETUP_TEAM_PRESETS = ['free-for-all', 'two-teams', 'four-teams'] as const;
type SetupTeamPreset = typeof SETUP_TEAM_PRESETS[number];
const SCREEN_IDS = ['title', 'setup', 'lobby', 'help', 'pause', 'results'] as const;
export type MenuScreenId = typeof SCREEN_IDS[number];
export const MenuScreen = {
  Title: 'title',
  Setup: 'setup',
  Lobby: 'lobby',
  Help: 'help',
  Pause: 'pause',
  Results: 'results',
} as const satisfies Record<string, MenuScreenId>;

interface SetupState {
  mode: number;
  frame: number;
  opponents: number;
  preset: SetupTeamPreset;
}

interface ResultsState {
  title: string;
  subtitle: string;
  rows: Array<{ seat: number; name: string; team: number; kills: number; deaths: number; dealt: number; grazes: number }>;
}

export interface MenuCallbacks {
  readonly requestSeed: () => number;
  readonly onStartMatch: (setup: MatchSetup) => void;
  readonly onJoinLobby: (room: string) => void;
  readonly onLobbyEdit: (edits: LobbyEdits) => void;
  readonly onLobbyStart: () => void;
  readonly onLeaveLobby: () => void;
  readonly onResume: () => void;
  readonly onQuitToTitle: () => void;
  readonly onRematch: () => void;
  readonly onToggleMute: () => void;
}

export class Menus {
  private readonly root: HTMLElement;
  private readonly callbacks: MenuCallbacks;
  private readonly shell: HTMLDivElement;
  private readonly screenEls: Record<MenuScreenId, HTMLElement>;
  private readonly roomInput: HTMLInputElement;
  private readonly titleOnline: HTMLButtonElement;
  private readonly titleMute: HTMLButtonElement;
  private readonly pauseMute: HTMLButtonElement;
  private readonly setupInfo: HTMLDivElement;
  private readonly lobbyModeWrap: HTMLDivElement;
  private readonly lobbyContent: HTMLDivElement;
  private readonly resultsContent: HTMLDivElement;
  private screen: MenuScreenId = MenuScreen.Title;
  private previousScreen: MenuScreenId = MenuScreen.Title;
  private lobbyState: LobbyState | null = null;
  private helpPage = 0;
  private readonly setupState: SetupState = {
    mode: Mode.Elimination,
    frame: Frame.Vanguard,
    opponents: 3,
    preset: 'free-for-all',
  };
  private resultsState: ResultsState = { title: 'RESULTS', subtitle: '', rows: [] };

  constructor(root: HTMLElement, callbacks: MenuCallbacks) {
    ensureStyles();
    this.root = root;
    this.callbacks = callbacks;
    root.classList.add('bf-menu-root');
    root.replaceChildren();
    this.shell = document.createElement('div');
    this.shell.className = 'bf-menu-shell';
    this.screenEls = {
      title: this.buildTitleScreen(),
      setup: this.buildSetupScreen(),
      lobby: this.buildLobbyScreen(),
      help: this.buildHelpScreen(),
      pause: this.buildPauseScreen(),
      results: this.buildResultsScreen(),
    };
    Object.values(this.screenEls).forEach((screen) => this.shell.append(screen));
    root.append(this.shell);
    this.roomInput = this.screenEls.lobby.querySelector('[data-room-input]') as HTMLInputElement;
    this.titleOnline = this.screenEls.title.querySelector('[data-title-action="online"]') as HTMLButtonElement;
    this.titleMute = this.screenEls.title.querySelector('[data-mute-toggle]') as HTMLButtonElement;
    this.pauseMute = this.screenEls.pause.querySelector('[data-pause-action="mute"]') as HTMLButtonElement;
    this.setupInfo = this.screenEls.setup.querySelector('[data-setup-info]') as HTMLDivElement;
    this.lobbyModeWrap = this.screenEls.lobby.querySelector('[data-lobby-mode-wrap]') as HTMLDivElement;
    this.lobbyContent = this.screenEls.lobby.querySelector('[data-lobby-content]') as HTMLDivElement;
    this.resultsContent = this.screenEls.results.querySelector('[data-results-content]') as HTMLDivElement;
    this.shell.addEventListener('click', (event) => this.onClick(event));
    this.root.addEventListener('change', (event) => this.onChange(event));
    this.root.addEventListener('keydown', (event) => this.onKeyDown(event));
    this.renderSetup();
    this.renderHelp();
    this.renderLobby();
    this.renderResults();
    this.show(MenuScreen.Title);
  }

  show(screen: MenuScreenId): void {
    this.previousScreen = this.screen;
    this.screen = screen;
    this.root.hidden = false;
    this.shell.dataset.current = screen;
    this.shell.prepend(this.screenEls[screen]);
    for (const [id, element] of Object.entries(this.screenEls) as Array<[MenuScreenId, HTMLElement]>) {
      element.hidden = id !== screen;
    }
    const focusTarget = this.screenEls[screen].querySelector<HTMLElement>('[data-autofocus], button, input, select, [tabindex="0"]');
    focusTarget?.focus({ preventScroll: true });
    if (screen === MenuScreen.Results) this.animateResultStats();
  }

  hide(): void {
    this.root.hidden = true;
  }

  setOnlineAvailable(available: boolean): void {
    this.titleOnline.hidden = !available;
  }

  setMuted(muted: boolean): void {
    this.titleMute.textContent = muted ? 'Audio: Off' : 'Audio: On';
    this.titleMute.setAttribute('aria-pressed', String(muted));
    this.pauseMute.textContent = muted ? 'Audio: Off' : 'Audio: On';
    this.pauseMute.setAttribute('aria-pressed', String(muted));
  }

  update(lobby: LobbyState): void {
    this.lobbyState = lobby;
    this.renderLobby();
  }

  showResults(world: World, names: readonly string[]): void {
    const winner = world.m.world[W.Winner];
    this.resultsState = {
      title: winner === -1 ? 'DRAW' : `TEAM ${winner + 1} WINS`,
      subtitle: world.isDeathmatch ? 'DEATHMATCH RESULTS' : `ROUND ${world.m.world[W.Round]} COMPLETE`,
      rows: Array.from({ length: world.seats }, (_, seat) => ({
        seat,
        name: names[seat] ?? `P${seat + 1}`,
        team: world.m.plTeam[seat],
        kills: world.m.plKills[seat],
        deaths: world.m.plDeaths[seat],
        dealt: world.m.plDealt[seat],
        grazes: world.m.plGrazes[seat],
      })).sort((a, b) => (b.kills - a.kills) || (a.deaths - b.deaths) || (b.dealt - a.dealt) || (a.seat - b.seat)),
    };
    this.renderResults();
    this.show(MenuScreen.Results);
  }

  private buildTitleScreen(): HTMLElement {
    const section = screenSection('title');
    section.innerHTML = `
      <div class="bf-card bf-title-card">
        <div class="bf-title-mark">BOSSFORM</div>
        <div class="bf-title-tag">${TITLE_TAGLINE}</div>
        <div class="bf-title-grid">
          <button type="button" class="bf-action" data-title-action="quick" data-autofocus>Offline Match</button>
          <button type="button" class="bf-action" data-title-action="online">Online</button>
          <button type="button" class="bf-action" data-title-action="help">How to Play</button>
        </div>
        <button type="button" class="bf-toggle" data-mute-toggle aria-label="Toggle mute">Audio: On</button>
      </div>`;
    return section;
  }

  private buildSetupScreen(): HTMLElement {
    const section = screenSection('setup');
    const modeCards = [Mode.Elimination, Mode.Deathmatch].map((mode) => `
      <button type="button" class="bf-choice-card" data-nav-group="setup-mode" data-setup-mode="${mode}" aria-label="${MODE_NAMES[mode]}">
        <span class="bf-choice-kicker">Mode</span>
        <span class="bf-choice-title">${MODE_NAMES[mode]}</span>
        <span class="bf-choice-copy">${MODE_BLURBS[mode]}</span>
      </button>`).join('');
    const frameCards = Array.from({ length: FRAME_COUNT }, (_, frame) => `
      <button type="button" class="bf-choice-card bf-frame-card" data-nav-group="setup-frame" data-setup-frame="${frame}" aria-label="${FRAME_NAMES[frame]}, ${FRAME_TAGLINES[frame]}" style="--frame:${cssHex(FRAME_EMBLEM_COLORS[frame])}">
        <span class="bf-emblem" data-frame-emblem="${frame}"></span>
        <span class="bf-frame-text">
          <span class="bf-frame-name">${FRAME_NAMES[frame]}</span>
          <span class="bf-frame-tag">${FRAME_TAGLINES[frame]}</span>
        </span>
      </button>`).join('');
    const teamCards = [
      { id: 'free-for-all', title: 'FREE-FOR-ALL', copy: 'Every pilot is their own team.' },
      { id: 'two-teams', title: '2 TEAMS', copy: 'Even split into rival squads.' },
      { id: 'four-teams', title: '4 TEAMS', copy: 'Pairs battle in four colors.' },
    ].map((preset) => `
      <button type="button" class="bf-choice-card" data-nav-group="setup-preset" data-setup-preset="${preset.id}">
        <span class="bf-choice-kicker">Teams</span>
        <span class="bf-choice-title">${preset.title}</span>
        <span class="bf-choice-copy">${preset.copy}</span>
      </button>`).join('');
    const options = Array.from({ length: MAX_PLAYERS - 1 }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join('');
    section.innerHTML = `
      <div class="bf-card bf-setup-card">
        <div class="bf-head-row">
          <div>
            <div class="bf-screen-title">Offline Match</div>
            <div class="bf-screen-copy">Build a sharp vector duel. Bots fill every empty seat.</div>
          </div>
          <button type="button" class="bf-ghost" data-screen="title">Back</button>
        </div>
        <div class="bf-subtitle">Choose the mode, frame, opponents, and team layout.</div>
        <div class="bf-grid-2">${modeCards}</div>
        <div class="bf-section-label">Frame</div>
        <div class="bf-frame-grid" role="group" aria-label="Frame">${frameCards}</div>
        <div class="bf-grid-3">${teamCards}</div>
        <div class="bf-inline-fields">
          <label class="bf-field"><span>Opponents</span><select data-setup-opponents aria-label="Opponent count">${options}</select></label>
        </div>
        <div class="bf-setup-info" data-setup-info></div>
        <div class="bf-footer-actions">
          <button type="button" class="bf-ghost" data-screen="help">Controls</button>
          <button type="button" class="bf-action" data-setup-start>Start Match</button>
        </div>
      </div>`;
    return section;
  }

  private buildLobbyScreen(): HTMLElement {
    const section = screenSection('lobby');
    section.innerHTML = `
      <div class="bf-card bf-lobby-card">
        <div class="bf-head-row">
          <div>
            <div class="bf-screen-title">Online Lobby</div>
            <div class="bf-screen-copy">Room setup, teams, bots, and host controls.</div>
          </div>
          <button type="button" class="bf-ghost" data-screen="title">Back</button>
        </div>
        <div class="bf-inline-fields">
          <label class="bf-field bf-grow"><span>Room</span><input data-room-input aria-label="Room name" placeholder="room" value="lobby"></label>
          <button type="button" class="bf-action" data-lobby-join>Join</button>
        </div>
        <div class="bf-inline-fields" data-lobby-mode-wrap></div>
        <div class="bf-setup-info" data-lobby-content></div>
        <div class="bf-footer-actions">
          <button type="button" class="bf-ghost" data-lobby-leave>Leave</button>
          <button type="button" class="bf-action" data-lobby-start>Start</button>
        </div>
      </div>`;
    return section;
  }

  private buildHelpScreen(): HTMLElement {
    const section = screenSection('help');
    section.innerHTML = `
      <div class="bf-card bf-help-card">
        <div class="bf-head-row">
          <div>
            <div class="bf-screen-title">How to Play</div>
            <div class="bf-screen-copy">Controls, combat flow, and boss-form rules.</div>
          </div>
          <button type="button" class="bf-ghost" data-help-close data-screen="title">Back</button>
        </div>
        <div class="bf-setup-info" data-help-content></div>
        <div class="bf-footer-actions">
          <button type="button" class="bf-ghost" data-help-prev>Previous</button>
          <button type="button" class="bf-action" data-help-next>Next</button>
        </div>
      </div>`;
    return section;
  }

  private buildPauseScreen(): HTMLElement {
    const section = screenSection('pause');
    section.innerHTML = `
      <div class="bf-card bf-pause-card">
        <div class="bf-screen-title">Paused</div>
        <div class="bf-title-grid bf-single-column">
          <button type="button" class="bf-action" data-pause-action="resume" data-autofocus>Resume</button>
          <button type="button" class="bf-action" data-pause-action="controls">Controls</button>
          <button type="button" class="bf-action" data-pause-action="mute" aria-pressed="false">Audio: On</button>
          <button type="button" class="bf-action" data-pause-action="quit">Quit to Title</button>
        </div>
      </div>`;
    return section;
  }

  private buildResultsScreen(): HTMLElement {
    const section = screenSection('results');
    section.innerHTML = `
      <div class="bf-card bf-results-card">
        <div class="bf-head-row">
          <div>
            <div class="bf-screen-title">Results</div>
            <div class="bf-screen-copy">Round totals and performance stats.</div>
          </div>
        </div>
        <div class="bf-setup-info" data-results-content></div>
        <div class="bf-footer-actions">
          <button type="button" class="bf-ghost" data-results-action="title">Back to Title</button>
          <button type="button" class="bf-action" data-results-action="rematch">Rematch</button>
        </div>
      </div>`;
    return section;
  }

  private onClick(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.closest('[data-help-close]')) {
      this.show(this.previousScreen === MenuScreen.Help ? MenuScreen.Title : this.previousScreen);
      return;
    }
    const screen = target.closest<HTMLButtonElement>('button[data-screen]')?.dataset.screen as MenuScreenId | undefined;
    if (screen) {
      this.show(screen);
      return;
    }
    const titleAction = target.closest<HTMLElement>('[data-title-action]')?.dataset.titleAction;
    if (titleAction === 'quick') {
      this.renderSetup();
      this.show(MenuScreen.Setup);
      return;
    }
    if (titleAction === 'online') {
      this.show(MenuScreen.Lobby);
      return;
    }
    if (titleAction === 'help') {
      this.helpPage = 0;
      this.renderHelp();
      this.show(MenuScreen.Help);
      return;
    }
    if (target.closest('[data-mute-toggle]')) {
      this.callbacks.onToggleMute();
      return;
    }
    const setupMode = target.closest<HTMLElement>('[data-setup-mode]')?.dataset.setupMode;
    if (setupMode !== undefined) {
      this.setupState.mode = Number(setupMode);
      this.renderSetup();
      return;
    }
    const setupFrame = target.closest<HTMLElement>('[data-setup-frame]')?.dataset.setupFrame;
    if (setupFrame !== undefined) {
      this.setupState.frame = Number(setupFrame);
      this.renderSetup();
      return;
    }
    const setupPreset = target.closest<HTMLElement>('[data-setup-preset]')?.dataset.setupPreset as SetupTeamPreset | undefined;
    if (setupPreset) {
      this.setupState.preset = setupPreset;
      this.renderSetup();
      return;
    }
    if (target.closest('[data-setup-start]')) {
      this.callbacks.onStartMatch(this.buildSetupMatch());
      return;
    }
    if (target.closest('[data-lobby-join]')) {
      this.callbacks.onJoinLobby(this.roomInput.value.trim() || 'lobby');
      return;
    }
    if (target.closest('[data-lobby-leave]')) {
      this.callbacks.onLeaveLobby();
      return;
    }
    if (target.closest('[data-lobby-start]')) {
      this.callbacks.onLobbyStart();
      return;
    }
    if (target.closest('[data-lobby-add-bot]')) {
      this.callbacks.onLobbyEdit({ addBot: true });
      return;
    }
    const removeBot = target.closest<HTMLElement>('[data-lobby-remove-bot]')?.dataset.lobbyRemoveBot;
    if (removeBot !== undefined) {
      this.callbacks.onLobbyEdit({ removeBot: Number(removeBot) });
      return;
    }
    if (target.closest('[data-help-prev]')) {
      this.helpPage = Math.max(0, this.helpPage - 1);
      this.renderHelp();
      return;
    }
    if (target.closest('[data-help-next]')) {
      this.helpPage = Math.min(1, this.helpPage + 1);
      this.renderHelp();
      return;
    }
    const pauseAction = target.closest<HTMLElement>('[data-pause-action]')?.dataset.pauseAction;
    if (pauseAction === 'resume') {
      this.callbacks.onResume();
      return;
    }
    if (pauseAction === 'controls') {
      this.helpPage = 0;
      this.renderHelp();
      this.show(MenuScreen.Help);
      return;
    }
    if (pauseAction === 'mute') {
      this.callbacks.onToggleMute();
      return;
    }
    if (pauseAction === 'quit') {
      this.callbacks.onQuitToTitle();
      return;
    }
    const resultsAction = target.closest<HTMLElement>('[data-results-action]')?.dataset.resultsAction;
    if (resultsAction === 'title') {
      this.callbacks.onQuitToTitle();
      return;
    }
    if (resultsAction === 'rematch') {
      this.callbacks.onRematch();
    }
  }

  private onChange(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.matches('[data-setup-opponents]')) {
      this.setupState.opponents = Number((target as HTMLSelectElement).value);
      this.renderSetup();
      return;
    }
    if (target.matches('[data-lobby-frame]')) {
      this.callbacks.onLobbyEdit({ frame: Number((target as HTMLSelectElement).value) });
      return;
    }
    if (target.matches('[data-lobby-team]')) {
      this.callbacks.onLobbyEdit({ team: Number((target as HTMLSelectElement).value) });
      return;
    }
    if (target.matches('[data-lobby-mode]')) {
      this.callbacks.onLobbyEdit({ mode: Number((target as HTMLSelectElement).value) });
    }
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (this.screen === MenuScreen.Pause) this.callbacks.onResume();
      else if (this.screen === MenuScreen.Help) this.show(this.previousScreen === MenuScreen.Help ? MenuScreen.Title : this.previousScreen);
      else if (this.screen === MenuScreen.Setup || this.screen === MenuScreen.Lobby || this.screen === MenuScreen.Results) this.show(MenuScreen.Title);
      return;
    }
    if (event.key === 'Enter') {
      const active = document.activeElement;
      if (active instanceof HTMLButtonElement) {
        event.preventDefault();
        active.click();
      }
      return;
    }
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return;
    const group = active.dataset.navGroup;
    if (!group) return;
    const peers = Array.from(this.root.querySelectorAll<HTMLElement>(`[data-nav-group="${group}"]`)).filter((node) => !node.hidden);
    const index = peers.indexOf(active);
    if (index < 0 || peers.length < 2) return;
    event.preventDefault();
    const horizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight';
    const delta = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
    // Grids reflow with the screen size: the row length is however many cards share the first card's row right now.
    const columns = peers.filter((node) => node.offsetTop === peers[0].offsetTop).length;
    const next = horizontal ? index + delta : index + delta * columns;
    peers[(next + peers.length) % peers.length]?.focus();
  }

  private renderSetup(): void {
    this.screenEls.setup.querySelectorAll<HTMLElement>('[data-setup-mode]').forEach((node) => node.dataset.active = String(Number(node.dataset.setupMode) === this.setupState.mode));
    this.screenEls.setup.querySelectorAll<HTMLElement>('[data-setup-frame]').forEach((node) => node.dataset.active = String(Number(node.dataset.setupFrame) === this.setupState.frame));
    this.screenEls.setup.querySelectorAll<HTMLElement>('[data-setup-preset]').forEach((node) => node.dataset.active = String(node.dataset.setupPreset === this.setupState.preset));
    (this.screenEls.setup.querySelector('[data-setup-opponents]') as HTMLSelectElement).value = String(this.setupState.opponents);
    this.screenEls.setup.querySelectorAll<HTMLElement>('[data-frame-emblem]').forEach((node) => {
      const frame = Number(node.dataset.frameEmblem);
      node.innerHTML = frameEmblemSvg(frame, cssHex(FRAME_EMBLEM_COLORS[frame]));
    });
    const frame = this.setupState.frame;
    const stats = FRAME_STATS[frame];
    const pilotCount = this.setupState.opponents + 1;
    const teams = this.teamList(pilotCount);
    this.setupInfo.innerHTML = `
      <div class="bf-setup-summary">
        <div><strong>${FRAME_NAMES[frame]}</strong> — ${FRAME_TAGLINES[frame]} · Boss form ${FORM_NAMES[frame]}</div>
        <div class="bf-setup-blurb">${FRAME_BLURBS[frame]}</div>
        <div>Fire ${PRIMARY_LABELS[frame]} · Alt ${ALT_LABELS[frame]}</div>
        <div>HP ${stats.hp} · Window ${stats.windowCap} / ${(stats.windowTicks / TICK_RATE).toFixed(1)}s · Speed ${fx.toFloat(stats.speed).toFixed(1)}</div>
        <div>Pilots ${pilotCount} · Teams ${Array.from(new Set(teams)).length} · ${MODE_BLURBS[this.setupState.mode]}</div>
      </div>`;
  }

  private buildSetupMatch(): MatchSetup {
    const pilotCount = this.setupState.opponents + 1;
    const teams = this.teamList(pilotCount);
    return {
      mode: this.setupState.mode,
      seed: this.callbacks.requestSeed(),
      pilots: Array.from({ length: pilotCount }, (_, seat) => ({
        name: seat === 0 ? 'YOU' : DEFAULT_NAMES[seat],
        frame: seat === 0 ? this.setupState.frame : (this.setupState.frame + seat) % FRAME_COUNT,
        team: teams[seat],
        bot: seat !== 0,
      })),
    };
  }

  private teamList(count: number): number[] {
    switch (this.setupState.preset) {
      case 'free-for-all':
        return freeForAllTeams(count);
      case 'two-teams':
        return evenTeams(count, 2);
      case 'four-teams':
        return evenTeams(count, Math.min(4, count));
      default:
        throw new RangeError(`unknown preset ${this.setupState.preset}`);
    }
  }

  private renderLobby(): void {
    const lobby = this.lobbyState;
    this.roomInput.value = lobby?.room ?? 'lobby';
    this.lobbyModeWrap.innerHTML = lobby === null ? '' : `
      <label class="bf-field bf-grow"><span>Mode</span><select data-lobby-mode ${lobby.host ? '' : 'disabled'}>
        ${[Mode.Elimination, Mode.Deathmatch].map((mode) => `<option value="${mode}" ${lobby.mode === mode ? 'selected' : ''}>${MODE_NAMES[mode]}</option>`).join('')}
      </select></label>
      <label class="bf-field"><span>Status</span><div class="bf-status-chip">${lobby.status.toUpperCase()}</div></label>`;
    const start = this.screenEls.lobby.querySelector('[data-lobby-start]') as HTMLButtonElement;
    if (lobby === null) {
      this.lobbyContent.innerHTML = '<div class="bf-empty">Join a room to edit your frame, team, and match settings.</div>';
      start.disabled = true;
      return;
    }
    const self = lobby.players.find((player) => player.self);
    if (self === undefined) {
      // Still connecting (or refused): the relay has not listed this player yet, so there is nothing to edit, only a status.
      this.lobbyContent.innerHTML = `<div class="bf-empty">${lobby.message}</div>`;
      start.disabled = true;
      return;
    }
    const teamOptions = Array.from({ length: lobby.maxPlayers }, (_, team) => `<option value="${team}" ${team === self.team ? 'selected' : ''}>Team ${team + 1}</option>`).join('');
    const frameOptions = Array.from({ length: FRAME_COUNT }, (_, frame) => `<option value="${frame}" ${frame === self.frame ? 'selected' : ''}>${FRAME_NAMES[frame]} — ${FRAME_TAGLINES[frame]}</option>`).join('');
    const players = lobby.players.map((player, index) => `
      <div class="bf-lobby-row" style="--team:${teamCss(player.team)}">
        <div>
          <strong>${player.name}</strong>
          <span>${FRAME_NAMES[player.frame]} · Team ${player.team + 1}${player.bot ? ' · Bot' : ''}${player.host ? ' · Host' : ''}${player.self ? ' · You' : ''}</span>
        </div>
        ${lobby.host && player.bot ? `<button type="button" class="bf-ghost bf-mini" data-lobby-remove-bot="${index}">Remove</button>` : '<span></span>'}
      </div>`).join('');
    this.lobbyContent.innerHTML = `
      <div class="bf-inline-fields">
        <label class="bf-field bf-grow"><span>Your Frame</span><select data-lobby-frame>${frameOptions}</select></label>
        <label class="bf-field bf-grow"><span>Your Team</span><select data-lobby-team>${teamOptions}</select></label>
        ${lobby.host ? '<button type="button" class="bf-action" data-lobby-add-bot>Add Bot</button>' : ''}
      </div>
      <div class="bf-setup-summary">${lobby.message}</div>
      <div class="bf-lobby-list">${players}</div>`;
    start.disabled = !lobby.host || lobby.players.length < 2;
  }

  private renderHelp(): void {
    const content = this.screenEls.help.querySelector('[data-help-content]') as HTMLDivElement;
    if (this.helpPage === 0) {
      content.innerHTML = `
        <div class="bf-help-page">
          <div class="bf-screen-copy">Controls</div>
          <div class="bf-table-scroll"><table class="bf-table"><tbody>
            <tr><th>Move</th><td>WASD</td><td>Left Stick</td><td>Left drag</td></tr>
            <tr><th>Aim</th><td>Mouse</td><td>Right Stick</td><td>Right drag</td></tr>
            <tr><th>Fire / Salvo</th><td>LMB</td><td>RT</td><td>Push right drag outward</td></tr>
            <tr><th>Alt / Siege</th><td>RMB</td><td>LT</td><td>Tap right</td></tr>
            <tr><th>Boost</th><td>Shift</td><td>LB</td><td>Tap left</td></tr>
            <tr><th>Transform</th><td>Space</td><td>Y</td><td>Hold both thumbs</td></tr>
            <tr><th>Ultima</th><td>E</td><td>X</td><td>Hold both thumbs</td></tr>
            <tr><th>Pause</th><td>Esc</td><td>Start</td><td>Tap both thumbs</td></tr>
            <tr><th>Mute</th><td>M</td><td>—</td><td>Pause menu</td></tr>
          </tbody></table></div>
          <div class="bf-screen-copy">Touch sticks float under your thumbs and only show a faint direction trace while held.</div>
        </div>`;
    } else {
      content.innerHTML = `
        <div class="bf-help-page">
          <div class="bf-screen-copy">Rules</div>
          <ul class="bf-help-list">
            <li>Stop firing and your shield comes up. Firing drops it: attacking costs you your guard.</li>
            <li>Energy feeds both your guns and your shield. Let go of the trigger and it refills fast.</li>
            <li>Boost with Shift toward where you steer. Its first instant dodges straight through bullets.</li>
            <li>All bullets are slow enough to read. Graze danger and land hits to fill your boss gauge.</li>
            <li>Beams and lances are instant, but a thin laser always shows first exactly where they will fire: step off the line.</li>
            <li>Lobbed shells fly over everything and burst inside the ring drawn where they will land.</li>
            <li>Your core can only take so much damage per window. Saturate, reposition, punish.</li>
            <li>With a half-full boss gauge, transform into a colossus. Boss form burns the gauge as fuel.</li>
            <li>Only the boss core deals real damage — tear off armour plates and pods first.</li>
            <li>Salvo fills space, Siege roots for a heavier blast, Ultima warns every HUD before it erupts.</li>
          </ul>
        </div>`;
    }
  }

  private renderResults(): void {
    const rows = this.resultsState.rows.map((row) => `
      <tr style="--team:${teamCss(row.team)}">
        <td><span class="bf-team-dot"></span>${row.name}</td>
        <td>Team ${row.team + 1}</td>
        <td><span class="bf-stat" data-stat-value="${row.kills}">${row.kills}</span></td>
        <td><span class="bf-stat" data-stat-value="${row.deaths}">${row.deaths}</span></td>
        <td><span class="bf-stat" data-stat-value="${row.dealt}">${row.dealt}</span></td>
        <td><span class="bf-stat" data-stat-value="${row.grazes}">${row.grazes}</span></td>
      </tr>`).join('');
    this.resultsContent.innerHTML = `
      <div class="bf-results-banner">${this.resultsState.title}</div>
      <div class="bf-screen-copy">${this.resultsState.subtitle}</div>
      <table class="bf-table bf-results-table">
        <thead><tr><th>Pilot</th><th>Team</th><th>K</th><th>D</th><th>Damage</th><th>Grazes</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  private animateResultStats(): void {
    if (this.screen !== MenuScreen.Results) return;
    const stats = Array.from(this.resultsContent.querySelectorAll<HTMLElement>('[data-stat-value]'));
    if (stats.length === 0 || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const started = performance.now();
    const duration = RESULT_COUNT_SECONDS * 1000;
    const tick = (now: number) => {
      if (this.screen !== MenuScreen.Results) return;
      const t = Math.min(1, (now - started) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      stats.forEach((node) => {
        const value = Number(node.dataset.statValue);
        node.textContent = String(Math.round(value * eased));
      });
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}

function screenSection(id: MenuScreenId): HTMLElement {
  const section = document.createElement('section');
  section.className = 'bf-screen';
  section.dataset.screenId = id;
  section.hidden = true;
  return section;
}

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    :root {
      color-scheme: dark;
      --bf-bg: ${UI_BACKGROUND};
      --bf-panel: ${UI_PANEL};
      --bf-panel-strong: ${UI_PANEL_STRONG};
      --bf-edge: ${UI_EDGE};
      --bf-edge-soft: ${UI_EDGE_SOFT};
      --bf-copy: ${UI_TEXT};
      --bf-copy-dim: ${UI_TEXT_DIM};
      --bf-accent: ${UI_ACCENT};
      --bf-warn: ${UI_WARNING};
      --bf-ok: ${UI_SUCCESS};
      --bf-font: ${UI_FONT_STACK};
      --bf-track: ${UI_CAPS_SPACING};
    }
    .bf-menu-root { position: absolute; inset: 0; font-family: var(--bf-font); color: var(--bf-copy); }
    .bf-menu-shell { position: absolute; inset: 0; display: grid; place-items: center; overflow: auto; padding: max(clamp(16px, 4vw, 40px), env(safe-area-inset-top)) max(clamp(16px, 4vw, 40px), env(safe-area-inset-right)) max(clamp(16px, 4vw, 40px), env(safe-area-inset-bottom)) max(clamp(16px, 4vw, 40px), env(safe-area-inset-left)); background: radial-gradient(circle at 50% 20%, rgba(31,62,99,.36), rgba(4,7,15,.92) 58%), linear-gradient(180deg, rgba(0,0,0,.18), rgba(0,0,0,.44)); }
    .bf-menu-shell::before { content: ""; position: fixed; inset: -20%; pointer-events: none; background: linear-gradient(115deg, transparent 0 42%, rgba(111,227,255,.08) 47%, transparent 52% 100%); animation: bf-scan 4.8s linear infinite; }
    .bf-menu-shell::after { content: ""; position: fixed; inset: 0; pointer-events: none; background-image: linear-gradient(rgba(255,255,255,.035) 1px, transparent 1px), radial-gradient(circle at 20% 20%, rgba(255,106,128,.12), transparent 28%); background-size: 100% 5px, auto; mix-blend-mode: screen; opacity: .38; }
    .bf-screen { width: min(100%, 1100px); max-height: 100%; margin: auto; animation: bf-screen-in .2s ease-out both; }
    .bf-card { position: relative; border: 1px solid var(--bf-edge-soft); background: linear-gradient(180deg, rgba(12,18,32,.92), rgba(7,11,21,.96)); box-shadow: 0 0 0 1px rgba(111,227,255,.08) inset, 0 0 28px rgba(111,227,255,.12); clip-path: polygon(16px 0, calc(100% - 16px) 0, 100% 16px, 100% calc(100% - 16px), calc(100% - 16px) 100%, 16px 100%, 0 calc(100% - 16px), 0 16px); padding: clamp(18px, 3vw, 30px); overflow: hidden; }
    .bf-card::before { content: ""; position: absolute; inset: 0; pointer-events: none; background: linear-gradient(90deg, transparent, rgba(111,227,255,.14), transparent); transform: translateX(-120%); animation: bf-card-sweep 3.6s ease-in-out infinite; }
    .bf-title-card, .bf-pause-card { max-width: min(92vw, 620px); margin: 0 auto; text-align: center; }
    .bf-title-mark { position: relative; display: inline-block; font-size: clamp(30px, min(8.4vw, 10vh), 78px); font-weight: 780; letter-spacing: clamp(.04em, .45vw, .12em); text-transform: uppercase; color: transparent; -webkit-text-stroke: 1px #e9fbff; text-shadow: 0 0 16px rgba(111,227,255,.28); line-height: .94; white-space: nowrap; animation: bf-title-fill .9s ease-out .18s both, bf-title-glow 2.8s ease-in-out 1.1s infinite; }
    .bf-title-mark::before, .bf-title-mark::after { content: "BOSSFORM"; position: absolute; inset: 0; pointer-events: none; color: rgba(111,227,255,.34); clip-path: inset(0 0 55% 0); animation: bf-title-glitch 4.2s steps(1,end) infinite; }
    .bf-title-mark::after { color: rgba(255,106,128,.26); clip-path: inset(58% 0 0 0); animation-delay: .12s; }
    .bf-title-tag, .bf-subtitle { margin-top: 10px; color: var(--bf-copy-dim); letter-spacing: var(--bf-track); text-transform: uppercase; font-size: 12px; }
    .bf-title-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-top: 26px; }
    .bf-title-card > .bf-toggle { display: block; margin: 16px auto 0; }
    .bf-single-column { grid-template-columns: 1fr; }
    .bf-action, .bf-ghost, .bf-toggle, .bf-choice-card, .bf-status-chip {
      position: relative; min-height: 46px; border: 1px solid var(--bf-edge-soft); background: rgba(8, 16, 29, .9); color: var(--bf-copy); padding: 0 16px; font: 600 clamp(13px, 1.25vw, 14px)/1 var(--bf-font); letter-spacing: .06em; text-transform: uppercase; overflow: hidden;
    }
    .bf-action::after, .bf-ghost::after, .bf-toggle::after, .bf-choice-card::after { content: ""; position: absolute; left: 10px; right: 10px; bottom: 7px; height: 1px; background: linear-gradient(90deg, transparent, var(--bf-accent), transparent); transform: scaleX(0); transform-origin: left; transition: transform .18s ease; pointer-events: none; }
    .bf-action:hover::after, .bf-action:focus-visible::after, .bf-ghost:hover::after, .bf-ghost:focus-visible::after, .bf-toggle:hover::after, .bf-toggle:focus-visible::after, .bf-choice-card:hover::after, .bf-choice-card:focus-visible::after, .bf-choice-card[data-active="true"]::after { transform: scaleX(1); }
    .bf-choice-card { display: flex; flex-direction: column; gap: 8px; align-items: flex-start; justify-content: flex-start; min-height: 150px; padding: 18px; text-align: left; transition: border-color .18s ease, box-shadow .18s ease, transform .18s ease; }
    .bf-choice-card[data-active="true"], .bf-action:hover, .bf-ghost:hover, .bf-toggle:hover { border-color: var(--bf-edge); box-shadow: 0 0 0 1px rgba(111,227,255,.16) inset, 0 0 18px rgba(111,227,255,.16); }
    .bf-choice-card[data-active="true"] { transform: translateY(-1px); }
    .bf-choice-kicker { color: var(--bf-copy-dim); font-size: 10px; letter-spacing: var(--bf-track); }
    .bf-choice-title { font-size: 18px; font-weight: 700; letter-spacing: .08em; }
    .bf-choice-copy { color: var(--bf-copy-dim); font-size: 13px; line-height: 1.45; text-transform: none; letter-spacing: normal; }
    .bf-section-label { margin-top: 20px; color: var(--bf-copy-dim); font-size: 11px; letter-spacing: var(--bf-track); text-transform: uppercase; }
    .bf-frame-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin-top: 8px; }
    .bf-frame-card { flex-direction: row; align-items: center; gap: 12px; min-height: 64px; padding: 10px 14px; }
    .bf-frame-card .bf-emblem { flex: 0 0 auto; width: 44px; height: 44px; }
    .bf-frame-card .bf-emblem svg { display: block; width: 100%; height: 100%; }
    .bf-frame-text { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
    .bf-frame-name { font-size: 15px; font-weight: 700; letter-spacing: .08em; }
    .bf-frame-tag { color: var(--bf-copy-dim); font-size: 10px; letter-spacing: var(--bf-track); }
    .bf-frame-card[data-active="true"] { border-color: var(--frame); background: color-mix(in srgb, var(--frame) 7%, rgba(8, 16, 29, .9)); box-shadow: 0 0 0 1px color-mix(in srgb, var(--frame) 22%, transparent) inset, 0 0 18px color-mix(in srgb, var(--frame) 20%, transparent); }
    .bf-frame-card[data-active="true"]::after { background: linear-gradient(90deg, transparent, var(--frame), transparent); }
    .bf-frame-card[data-active="true"] .bf-emblem { filter: drop-shadow(0 0 6px color-mix(in srgb, var(--frame) 60%, transparent)); }
    .bf-setup-blurb { color: var(--bf-copy-dim); line-height: 1.45; }
    .bf-action:focus-visible, .bf-ghost:focus-visible, .bf-toggle:focus-visible, .bf-choice-card:focus-visible, .bf-field input:focus-visible, .bf-field select:focus-visible { outline: 2px solid #ffd46f; outline-offset: 3px; box-shadow: 0 0 0 1px rgba(255,212,111,.35), 0 0 22px rgba(255,212,111,.18); }
    .bf-head-row, .bf-footer-actions, .bf-inline-fields { display: flex; gap: 12px; align-items: center; justify-content: space-between; flex-wrap: wrap; }
    .bf-screen-title { font-size: clamp(26px, 4vw, 42px); font-weight: 740; letter-spacing: .1em; text-transform: uppercase; }
    .bf-screen-copy, .bf-empty { color: var(--bf-copy-dim); line-height: 1.6; }
    .bf-grid-2, .bf-grid-3 { display: grid; gap: 12px; margin-top: 20px; }
    .bf-grid-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .bf-grid-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .bf-inline-fields { margin-top: 16px; }
    .bf-field { display: flex; flex-direction: column; gap: 8px; min-width: 160px; flex: 0 0 auto; }
    .bf-field span { color: var(--bf-copy-dim); font-size: 11px; letter-spacing: var(--bf-track); text-transform: uppercase; }
    .bf-field input, .bf-field select { min-height: 44px; border: 1px solid var(--bf-edge-soft); background: rgba(7,13,24,.88); color: var(--bf-copy); padding: 0 12px; font: 600 14px/1 var(--bf-font); }
    .bf-grow { flex: 1 1 220px; }
    .bf-setup-info { margin-top: 18px; padding: 16px; border: 1px solid rgba(255,255,255,.08); background: rgba(255,255,255,.03); min-height: 96px; }
    .bf-setup-summary { display: grid; gap: 8px; }
    .bf-lobby-list { display: grid; gap: 10px; margin-top: 14px; }
    .bf-lobby-row { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 12px 14px; border: 1px solid color-mix(in srgb, var(--team) 36%, transparent); background: color-mix(in srgb, var(--team) 8%, rgba(255,255,255,.02)); animation: bf-row-in .22s ease-out both; }
    .bf-lobby-row strong { display: block; color: var(--team); }
    .bf-lobby-row span { color: var(--bf-copy-dim); font-size: 12px; }
    .bf-mini { min-height: 34px; padding: 0 10px; font-size: 12px; }
    .bf-status-chip { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; color: var(--bf-accent); }
    .bf-table { width: 100%; border-collapse: collapse; margin-top: 14px; }
    .bf-table-scroll { overflow-x: auto; margin-top: 14px; }
    .bf-table-scroll .bf-table { min-width: 540px; margin-top: 0; }
    .bf-table th, .bf-table td { text-align: left; padding: 10px 12px; border-bottom: 1px solid rgba(255,255,255,.08); }
    .bf-table th { color: var(--bf-copy-dim); font-size: 11px; letter-spacing: var(--bf-track); text-transform: uppercase; }
    .bf-help-list { margin: 14px 0 0; padding-left: 18px; display: grid; gap: 10px; color: var(--bf-copy); line-height: 1.6; }
    .bf-results-banner { font-size: clamp(28px, 6vw, 54px); font-weight: 760; letter-spacing: .12em; text-transform: uppercase; color: var(--bf-accent); animation: bf-winner-reveal .42s ease-out both; text-shadow: 0 0 24px rgba(111,227,255,.34); }
    .bf-results-table td:first-child { font-weight: 700; color: var(--team); }
    .bf-team-dot { display: inline-block; width: 10px; height: 10px; margin-right: 8px; border-radius: 50%; background: var(--team); }
    @media (max-width: 900px) {
      .bf-grid-3 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @media (max-width: 680px) {
      .bf-grid-2, .bf-grid-3, .bf-title-grid { grid-template-columns: 1fr; }
      .bf-choice-card { min-height: 0; }
      .bf-screen-title { letter-spacing: .08em; }
      .bf-card { padding: 18px; }
      .bf-title-mark { font-size: clamp(28px, 10vw, 48px); letter-spacing: clamp(.03em, .6vw, .08em); }
      .bf-frame-grid { gap: 8px; }
      .bf-frame-card { flex-direction: column; justify-content: center; align-items: center; gap: 6px; min-height: 0; padding: 10px 6px; text-align: center; }
      .bf-frame-card .bf-emblem { width: 34px; height: 34px; }
      .bf-frame-text { align-items: center; gap: 3px; }
      .bf-frame-name { font-size: 11px; letter-spacing: .04em; }
      .bf-frame-tag { font-size: 9px; letter-spacing: .12em; }
    }
    @media (max-height: 420px) and (orientation: landscape) {
      .bf-menu-shell { place-items: start center; }
      .bf-card { padding: 14px 16px; }
      .bf-title-mark { font-size: clamp(28px, 10vh, 42px); }
      .bf-title-tag, .bf-subtitle { margin-top: 6px; }
      .bf-title-grid { gap: 8px; margin-top: 14px; }
      .bf-title-card > .bf-toggle { margin-top: 8px; }
      .bf-screen-title { font-size: 24px; }
      .bf-grid-2, .bf-grid-3 { margin-top: 12px; gap: 8px; }
      .bf-choice-card { min-height: 0; padding: 12px 14px; gap: 6px; }
      .bf-section-label { margin-top: 12px; }
      .bf-frame-grid { gap: 6px; }
      .bf-frame-card { min-height: 46px; padding: 6px 10px; gap: 10px; }
      .bf-frame-card .bf-emblem { width: 30px; height: 30px; }
      .bf-frame-text { gap: 3px; }
      .bf-frame-name { font-size: 13px; }
    }
    @keyframes bf-screen-in { from { opacity: 0; transform: translate3d(24px, 0, 0); } to { opacity: 1; transform: translate3d(0, 0, 0); } }
    @keyframes bf-card-sweep { 0%, 42% { transform: translateX(-120%); opacity: 0; } 55% { opacity: .7; } 72%, 100% { transform: translateX(120%); opacity: 0; } }
    @keyframes bf-scan { from { transform: translateX(-18%); } to { transform: translateX(18%); } }
    @keyframes bf-title-fill { 0% { color: transparent; letter-spacing: .28em; } 68% { color: rgba(233,251,255,.18); } 100% { color: #e9fbff; } }
    @keyframes bf-title-glow { 0%, 100% { text-shadow: 0 0 12px rgba(111,227,255,.24); } 50% { text-shadow: 0 0 28px rgba(111,227,255,.48), 0 0 54px rgba(255,106,128,.18); } }
    @keyframes bf-title-glitch { 0%, 86%, 100% { transform: translateX(0); opacity: 0; } 88% { transform: translateX(4px); opacity: 1; } 90% { transform: translateX(-3px); opacity: .75; } 92% { transform: translateX(0); opacity: 0; } }
    @keyframes bf-row-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes bf-winner-reveal { from { opacity: 0; clip-path: inset(0 100% 0 0); transform: scale(.96); } to { opacity: 1; clip-path: inset(0 0 0 0); transform: scale(1); } }
    @media (prefers-reduced-motion: reduce) {
      .bf-menu-shell::before, .bf-card::before, .bf-title-mark, .bf-title-mark::before, .bf-title-mark::after, .bf-lobby-row, .bf-results-banner, .bf-screen { animation: none; }
      .bf-choice-card, .bf-action::after, .bf-ghost::after, .bf-toggle::after, .bf-choice-card::after { transition: none; }
      .bf-screen { opacity: 1; }
    }
  `;
  document.head.append(style);
}
