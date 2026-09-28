import { fx } from '@metronome/engine';
import { Button, MOVE_MAX } from '../sim/index.ts';
import type { GameInput } from '../sim/index.ts';

export type MenuAction = 'up' | 'down' | 'left' | 'right' | 'confirm' | 'back' | 'pause' | 'mute';
export type ControlMode = 'solo' | 'local2p';

const MENU_KEYS: Readonly<Record<string, readonly MenuAction[]>> = {
  ArrowUp: ['up'], KeyW: ['up'], ArrowDown: ['down'], KeyS: ['down'], ArrowLeft: ['left'], KeyA: ['left'], ArrowRight: ['right'], KeyD: ['right'],
  Enter: ['confirm'], Space: ['confirm'], KeyZ: ['confirm'], KeyJ: ['confirm'],
  Escape: ['back', 'pause'], Backspace: ['back'], KeyX: ['back'], KeyP: ['pause'], KeyM: ['mute'],
};

/** Keys held for gameplay. Arrow keys aim; WASD moves. */
const KEY = {
  up: ['KeyW'], down: ['KeyS'], left: ['KeyA'], right: ['KeyD'],
  aimUp: ['ArrowUp'], aimDown: ['ArrowDown'], aimLeft: ['ArrowLeft'], aimRight: ['ArrowRight'],
  fire: ['KeyJ', 'KeyZ'], alt: ['KeyK', 'KeyX', 'ShiftLeft', 'ShiftRight'], boss: ['Space', 'KeyE'],
} as const;

const PREVENT_DEFAULT = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Backspace', 'Tab']);
const STICK_DEADZONE = 0.22;
const AIM_STICK_DEADZONE = 0.35;
const MENU_STICK_THRESHOLD = 0.6;
const PAD = { a: 0, b: 1, x: 2, y: 3, lb: 4, rb: 5, lt: 6, rt: 7, start: 9, up: 12, down: 13, left: 14, right: 15 } as const;
const MOUSE = { left: 1, right: 2, middle: 4 } as const;

export interface PointerTap {
  clientX: number;
  clientY: number;
}

/** Where the mouse cursor is in the world, and where the given seat's robot stands (both in world units). */
export interface AimContext {
  pointerWorld: { x: number; y: number } | null;
  mech: { x: number; y: number } | null;
}

interface PadSnapshot {
  moveX: number;
  moveY: number;
  aimX: number;
  aimY: number;
  fire: boolean;
  alt: boolean;
  boss: boolean;
}

export class Devices {
  private readonly surface: HTMLElement;
  private readonly keys = new Set<string>();
  private readonly queuedEdges = new Set<MenuAction>();
  private readonly edges = new Set<MenuAction>();
  private readonly padHeld = new Set<MenuAction>();
  private readonly prevPadHeld = new Set<MenuAction>();
  private readonly taps_: PointerTap[] = [];
  private readonly lastAim = [fx.ANGLE_QUARTER, fx.ANGLE_QUARTER];
  private mouseButtons = 0;
  private pointerEverMoved = false;
  private keyboardAimUntil = 0;
  mode: ControlMode = 'solo';
  pointerX = -1;
  pointerY = -1;
  /** 'pad' once a gamepad has been touched more recently than the keyboard/mouse (drives on-screen prompts). */
  lastDevice: 'keyboard' | 'pad' = 'keyboard';

  constructor(surface: HTMLElement) {
    this.surface = surface;
    window.addEventListener('keydown', (e) => this.onKeyDown(e));
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.releaseAll());
    surface.addEventListener('pointerdown', (e) => {
      this.mouseButtons = e.buttons;
      if (e.button === 0) this.taps_.push({ clientX: e.clientX, clientY: e.clientY });
      this.pointerX = e.clientX;
      this.pointerY = e.clientY;
      this.pointerEverMoved = true;
      this.lastDevice = 'keyboard';
    });
    surface.addEventListener('pointermove', (e) => {
      this.pointerX = e.clientX;
      this.pointerY = e.clientY;
      this.pointerEverMoved = true;
      this.mouseButtons = e.buttons;
    });
    surface.addEventListener('pointerup', (e) => { this.mouseButtons = e.buttons; });
    surface.addEventListener('pointerleave', () => { this.mouseButtons = 0; });
    surface.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (PREVENT_DEFAULT.has(e.code)) e.preventDefault();
    this.keys.add(e.code);
    this.lastDevice = 'keyboard';
    if (e.repeat) return;
    for (const action of MENU_KEYS[e.code] ?? []) this.queuedEdges.add(action);
    if (KEY.aimUp.some((k) => k === e.code) || KEY.aimDown.some((k) => k === e.code) || KEY.aimLeft.some((k) => k === e.code) || KEY.aimRight.some((k) => k === e.code)) {
      this.keyboardAimUntil = performance.now() + 400;
    }
  }

  releaseAll(): void {
    this.keys.clear();
    this.queuedEdges.clear();
    this.edges.clear();
    this.taps_.length = 0;
    this.mouseButtons = 0;
  }

  /** Once per rendered frame: turns raw events into per-frame menu edges. */
  poll(): void {
    this.edges.clear();
    for (const a of this.queuedEdges) this.edges.add(a);
    this.queuedEdges.clear();
    this.prevPadHeld.clear();
    for (const a of this.padHeld) this.prevPadHeld.add(a);
    this.padHeld.clear();
    const pad = this.pads()[0];
    if (pad) {
      const b = (i: number) => !!pad.buttons[i]?.pressed;
      const ax = pad.axes[0] ?? 0;
      const ay = pad.axes[1] ?? 0;
      if (b(PAD.up) || ay < -MENU_STICK_THRESHOLD) this.padHeld.add('up');
      if (b(PAD.down) || ay > MENU_STICK_THRESHOLD) this.padHeld.add('down');
      if (b(PAD.left) || ax < -MENU_STICK_THRESHOLD) this.padHeld.add('left');
      if (b(PAD.right) || ax > MENU_STICK_THRESHOLD) this.padHeld.add('right');
      if (b(PAD.a)) this.padHeld.add('confirm');
      if (b(PAD.b)) this.padHeld.add('back');
      if (b(PAD.start)) this.padHeld.add('pause');
      if (this.padHeld.size > 0) this.lastDevice = 'pad';
    }
    for (const a of this.padHeld) if (!this.prevPadHeld.has(a)) this.edges.add(a);
  }

  pressed(action: MenuAction): boolean {
    return this.edges.has(action);
  }

  consume(action: MenuAction): boolean {
    return this.edges.delete(action);
  }

  anyPressed(): boolean {
    return this.edges.size > 0 || this.taps_.length > 0;
  }

  /** Pointer clicks since the last call (client coordinates). */
  takeTaps(): PointerTap[] {
    return this.taps_.splice(0, this.taps_.length);
  }

  get pointerActive(): boolean {
    return this.pointerEverMoved;
  }

  private pads(): Gamepad[] {
    const list = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
    return Array.from(list ?? []).filter((p): p is Gamepad => !!p && p.connected);
  }

  get padCount(): number {
    return this.pads().length;
  }

  private held(codes: readonly string[]): boolean {
    return codes.some((c) => this.keys.has(c));
  }

  private snapshot(pad: Gamepad | undefined): PadSnapshot | null {
    if (!pad) return null;
    const b = (i: number) => !!pad.buttons[i]?.pressed;
    let moveX = pad.axes[0] ?? 0;
    let moveY = -(pad.axes[1] ?? 0);
    if (Math.hypot(moveX, moveY) < STICK_DEADZONE) {
      moveX = 0;
      moveY = 0;
    }
    if (b(PAD.left)) moveX = -1;
    if (b(PAD.right)) moveX = 1;
    if (b(PAD.up)) moveY = 1;
    if (b(PAD.down)) moveY = -1;
    const aimX = pad.axes[2] ?? 0;
    const aimY = -(pad.axes[3] ?? 0);
    return {
      moveX, moveY, aimX, aimY,
      fire: b(PAD.a) || b(PAD.rt) || b(PAD.rb),
      alt: b(PAD.b) || b(PAD.lt) || b(PAD.lb),
      boss: b(PAD.y) || b(PAD.x),
    };
  }

  /**
   * Builds the input for one device slot for the next tick. Movement and aim come from different controls, so
   * the robot can slide in any direction while its weapons point in another (the twin-stick core of the game).
   * Slot 0 is keyboard + mouse (and the pad when playing alone); slot 1 is the first gamepad in local co-op.
   */
  sample(slot: number, ctx: AimContext): GameInput {
    const seat = slot;
    const usesKeyboard = seat === 0;
    // Solo: one pad may also drive seat 0. Local co-op: seat 0 is keyboard + mouse, seat 1 owns the first pad.
    const padSeat = this.mode === 'local2p' ? 1 : 0;
    const seatPad = seat === padSeat ? this.snapshot(this.pads()[0]) : null;

    let moveX = 0;
    let moveY = 0;
    if (usesKeyboard) {
      moveX = (this.held(KEY.right) ? 1 : 0) - (this.held(KEY.left) ? 1 : 0);
      moveY = (this.held(KEY.up) ? 1 : 0) - (this.held(KEY.down) ? 1 : 0);
    }
    if (seatPad && (seatPad.moveX !== 0 || seatPad.moveY !== 0)) {
      moveX = seatPad.moveX;
      moveY = seatPad.moveY;
    }

    let buttons = 0;
    if (usesKeyboard) {
      if (this.held(KEY.fire) || (this.mouseButtons & MOUSE.left) !== 0) buttons |= Button.Fire;
      if (this.held(KEY.alt) || (this.mouseButtons & MOUSE.right) !== 0) buttons |= Button.Alt;
      if (this.held(KEY.boss) || (this.mouseButtons & MOUSE.middle) !== 0) buttons |= Button.Boss;
    }
    if (seatPad) {
      if (seatPad.fire) buttons |= Button.Fire;
      if (seatPad.alt) buttons |= Button.Alt;
      if (seatPad.boss) buttons |= Button.Boss;
    }

    let aim = this.lastAim[seat];
    const keyAimX = usesKeyboard ? (this.held(KEY.aimRight) ? 1 : 0) - (this.held(KEY.aimLeft) ? 1 : 0) : 0;
    const keyAimY = usesKeyboard ? (this.held(KEY.aimUp) ? 1 : 0) - (this.held(KEY.aimDown) ? 1 : 0) : 0;
    if (keyAimX !== 0 || keyAimY !== 0) {
      aim = fx.fromRadians(Math.atan2(keyAimY, keyAimX));
    } else if (seatPad && Math.hypot(seatPad.aimX, seatPad.aimY) > AIM_STICK_DEADZONE) {
      aim = fx.fromRadians(Math.atan2(seatPad.aimY, seatPad.aimX));
    } else if (usesKeyboard && this.pointerActive && ctx.pointerWorld && ctx.mech && performance.now() > this.keyboardAimUntil) {
      const dx = ctx.pointerWorld.x - ctx.mech.x;
      const dy = ctx.pointerWorld.y - ctx.mech.y;
      if (Math.hypot(dx, dy) > 3) aim = fx.fromRadians(Math.atan2(dy, dx));
    }
    this.lastAim[seat] = aim;

    const len = Math.hypot(moveX, moveY);
    const scale = len > 1 ? 1 / len : 1;
    return {
      moveX: Math.round(moveX * scale * MOVE_MAX),
      moveY: Math.round(moveY * scale * MOVE_MAX),
      aim,
      buttons,
    };
  }

  /** Forgets aim memory (new run). */
  resetAim(): void {
    this.lastAim[0] = fx.ANGLE_QUARTER;
    this.lastAim[1] = fx.ANGLE_QUARTER;
  }

  get element(): HTMLElement {
    return this.surface;
  }
}
