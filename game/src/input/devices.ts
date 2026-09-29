import { fx } from '@metronome/engine';
import { Button, MOVE_MAX } from '../sim/index.ts';
import type { GameInput } from '../sim/index.ts';

/** Controls (design doc §6). Move and aim are separate: the ship slides one way while its guns point another. */
const KEYS = {
  left: ['KeyA'], right: ['KeyD'], up: ['KeyW'], down: ['KeyS'],
  aimLeft: ['ArrowLeft'], aimRight: ['ArrowRight'], aimUp: ['ArrowUp'], aimDown: ['ArrowDown'],
  fire: ['KeyJ'], alt: ['KeyK'], transform: ['Space'], ultima: ['KeyE'],
} as const;

const GAME_KEYS = new Set<string>(Object.values(KEYS).flat());
const MOUSE_BUTTON = { left: 1, right: 2 } as const;
const PAD = { a: 0, b: 1, x: 2, y: 3, lb: 4, rb: 5, lt: 6, rt: 7, start: 9, up: 12, down: 13, left: 14, right: 15 } as const;
const PAD_AXIS = { moveX: 0, moveY: 1, aimX: 2, aimY: 3 } as const;
const MOVE_DEADZONE = 0.22;
const AIM_DEADZONE = 0.35;

/** Actions that are not part of a tick's input. */
export type DeviceAction = 'pause' | 'mute';

const ACTION_KEYS: Readonly<Record<string, DeviceAction>> = { Escape: 'pause', KeyP: 'pause', KeyM: 'mute' };

type AimSource = 'mouse' | 'keys' | 'pad';

export interface Cursor {
  readonly x: number;
  readonly y: number;
}

/**
 * Keyboard + mouse and the first gamepad, merged into one pilot's GameInput. Sampling is pull-based: the session asks
 * for an input once per tick, and the aim is resolved through the camera at that moment.
 */
export class Devices {
  private readonly surface: HTMLElement;
  private readonly held = new Set<string>();
  private readonly actions = new Set<DeviceAction>();
  private mouseButtons = 0;
  private cursor_: { x: number; y: number } | null = null;
  private aimSource: AimSource = 'mouse';
  private lastAim = fx.ANGLE_QUARTER;
  private padPauseHeld = false;
  private capturing = false;
  private readonly cleanup: Array<() => void> = [];

  constructor(surface: HTMLElement) {
    this.surface = surface;
    this.listen(window, 'keydown', (e) => this.onKeyDown(e as KeyboardEvent));
    this.listen(window, 'keyup', (e) => this.held.delete((e as KeyboardEvent).code));
    this.listen(window, 'blur', () => this.releaseAll());
    this.listen(surface, 'pointerdown', (e) => this.onPointer(e as PointerEvent));
    this.listen(surface, 'pointermove', (e) => this.onPointer(e as PointerEvent));
    this.listen(surface, 'pointerup', (e) => this.onPointer(e as PointerEvent));
    this.listen(surface, 'pointerleave', () => { this.mouseButtons = 0; });
    this.listen(surface, 'contextmenu', (e) => e.preventDefault());
  }

  private listen(target: EventTarget, type: string, handler: (event: Event) => void): void {
    target.addEventListener(type, handler);
    this.cleanup.push(() => target.removeEventListener(type, handler));
  }

  /** While a match is on screen the game keys are captured (no page scrolling); menus and text fields get their keys back. */
  setCapturing(capturing: boolean): void {
    this.capturing = capturing;
    if (!capturing) this.releaseAll();
  }

  /** Pointer position in CSS pixels relative to the surface, or null before the mouse has ever moved over it. */
  get cursor(): Cursor | null {
    return this.cursor_;
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const action = ACTION_KEYS[e.code];
    if (action !== undefined && !e.repeat) this.actions.add(action);
    if (!this.capturing || !GAME_KEYS.has(e.code)) return;
    e.preventDefault();
    this.held.add(e.code);
    if ((KEYS.aimLeft as readonly string[]).includes(e.code) || (KEYS.aimRight as readonly string[]).includes(e.code) || (KEYS.aimUp as readonly string[]).includes(e.code) || (KEYS.aimDown as readonly string[]).includes(e.code)) {
      this.aimSource = 'keys';
    }
  }

  private onPointer(e: PointerEvent): void {
    const box = this.surface.getBoundingClientRect();
    this.cursor_ = { x: e.clientX - box.left, y: e.clientY - box.top };
    this.mouseButtons = e.buttons;
    if (e.type === 'pointermove' || e.type === 'pointerdown') this.aimSource = 'mouse';
  }

  releaseAll(): void {
    this.held.clear();
    this.mouseButtons = 0;
  }

  /** Once per rendered frame: pad-only actions (Start) and everything queued by the keyboard since the last call. */
  takeActions(): DeviceAction[] {
    const pad = this.pad();
    const start = pad !== null && pad.buttons[PAD.start]?.pressed === true;
    if (start && !this.padPauseHeld) this.actions.add('pause');
    this.padPauseHeld = start;
    const out = [...this.actions];
    this.actions.clear();
    return out;
  }

  private pad(): Gamepad | null {
    if (typeof navigator.getGamepads !== 'function') return null;
    return Array.from(navigator.getGamepads()).find((p): p is Gamepad => p !== null && p.connected) ?? null;
  }

  private key(codes: readonly string[]): boolean {
    return codes.some((c) => this.held.has(c));
  }

  /**
   * One tick's input for the local pilot. `aimFromCursor` turns a cursor position into the binary angle from the pilot's ship
   * to it (Stage.aimFrom): the mouse aims by where the cursor is on the screen, whatever the camera is doing.
   */
  sample(aimFromCursor: (cssX: number, cssY: number) => number): GameInput {
    const pad = this.pad();
    const button = (index: number) => pad !== null && pad.buttons[index]?.pressed === true;
    const axis = (index: number) => (pad !== null ? pad.axes[index] ?? 0 : 0);

    let moveX = (this.key(KEYS.right) ? 1 : 0) - (this.key(KEYS.left) ? 1 : 0);
    let moveY = (this.key(KEYS.up) ? 1 : 0) - (this.key(KEYS.down) ? 1 : 0);
    const stickX = axis(PAD_AXIS.moveX);
    const stickY = -axis(PAD_AXIS.moveY);
    if (Math.hypot(stickX, stickY) > MOVE_DEADZONE) {
      moveX = stickX;
      moveY = stickY;
    }
    if (button(PAD.left)) moveX = -1;
    if (button(PAD.right)) moveX = 1;
    if (button(PAD.up)) moveY = 1;
    if (button(PAD.down)) moveY = -1;
    const length = Math.hypot(moveX, moveY);
    const scale = length > 1 ? 1 / length : 1;

    let buttons = 0;
    if (this.key(KEYS.fire) || (this.mouseButtons & MOUSE_BUTTON.left) !== 0 || button(PAD.a) || button(PAD.rt) || button(PAD.rb)) buttons |= Button.Fire;
    if (this.key(KEYS.alt) || (this.mouseButtons & MOUSE_BUTTON.right) !== 0 || button(PAD.b) || button(PAD.lt) || button(PAD.lb)) buttons |= Button.Alt;
    if (this.key(KEYS.transform) || button(PAD.y)) buttons |= Button.Boss;
    if (this.key(KEYS.ultima) || button(PAD.x)) buttons |= Button.Ultima;

    const keyX = (this.key(KEYS.aimRight) ? 1 : 0) - (this.key(KEYS.aimLeft) ? 1 : 0);
    const keyY = (this.key(KEYS.aimUp) ? 1 : 0) - (this.key(KEYS.aimDown) ? 1 : 0);
    const padAimX = axis(PAD_AXIS.aimX);
    const padAimY = -axis(PAD_AXIS.aimY);
    if (keyX !== 0 || keyY !== 0) {
      this.aimSource = 'keys';
      this.lastAim = fx.fromRadians(Math.atan2(keyY, keyX));
    } else if (Math.hypot(padAimX, padAimY) > AIM_DEADZONE) {
      this.aimSource = 'pad';
      this.lastAim = fx.fromRadians(Math.atan2(padAimY, padAimX));
    } else if (this.aimSource === 'mouse' && this.cursor_ !== null) {
      this.lastAim = aimFromCursor(this.cursor_.x, this.cursor_.y);
    }

    return { moveX: Math.round(moveX * scale * MOVE_MAX), moveY: Math.round(moveY * scale * MOVE_MAX), aim: this.lastAim, buttons };
  }

  dispose(): void {
    for (const undo of this.cleanup) undo();
  }
}
