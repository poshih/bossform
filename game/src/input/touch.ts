import { Button } from '../sim/index.ts';

const STYLE_ID = 'bossform-touch-style';
const GUIDE_STORAGE_KEY = 'bossform.touch-guide';
const STICK_RADIUS = 74;
const STICK_DEADZONE = 0.14;
const FIRE_ON = 0.72;
const FIRE_OFF = 0.62;
const TAP_MAX_MS = 180;
const TAP_MAX_DISTANCE = 14;
const CHORD_START_MS = 120;
const CHORD_TAP_MAX_MS = 260;
const CHORD_HOLD_MS = 450;
const GUIDE_MS = 6500;
const PULSE_MS = 620;

interface StickState {
  readonly side: 'left' | 'right';
  readonly visual: HTMLElement;
  pointerId: number | null;
  startX: number;
  startY: number;
  x: number;
  y: number;
  startedAt: number;
  maxDistance: number;
  firing: boolean;
}

interface ChordState {
  readonly first: number;
  readonly second: number;
  readonly formedAt: number;
  moved: boolean;
  cancelled: boolean;
  triggered: boolean;
}

export interface TouchSample {
  readonly moveX: number;
  readonly moveY: number;
  readonly moveActive: boolean;
  readonly aimX: number;
  readonly aimY: number;
  readonly aimActive: boolean;
  readonly buttons: number;
}

/**
 * Two floating thumb zones. Ordinary drags are movement and aim; distance and tap/chord gestures provide every button
 * without changing GameInput or the simulation.
 */
export class TouchControls {
  private readonly surface: HTMLElement;
  private readonly root: HTMLDivElement;
  private readonly left: StickState;
  private readonly right: StickState;
  private readonly capable: boolean;
  private touchUsed: boolean;
  private capturing = false;
  private tappedButtons = 0;
  private pauseTapped = false;
  private chord: ChordState | null = null;
  private guideTimer: number | null = null;
  private guideSeen: boolean;

  constructor(surface: HTMLElement) {
    ensureStyles();
    this.surface = surface;
    this.capable = navigator.maxTouchPoints > 0 || window.matchMedia('(any-pointer: coarse)').matches;
    this.touchUsed = window.matchMedia('(pointer: coarse)').matches;
    this.guideSeen = readGuideSeen();
    this.root = document.createElement('div');
    this.root.className = 'bf-touch-controls';
    this.root.hidden = true;
    this.root.innerHTML = `
      <div class="bf-touch-rotate" role="status">Landscape recommended</div>
      <div class="bf-touch-guide" aria-live="polite">
        <div><strong>Left</strong> drag to move · tap to boost</div>
        <div><strong>Right</strong> drag to aim · push farther to fire · tap for alt</div>
        <div><strong>Two thumbs</strong> tap to pause · hold for form / ultima</div>
      </div>
      <div class="bf-ghost-stick" data-touch-visual="left" aria-hidden="true"><i></i><b></b><em></em></div>
      <div class="bf-ghost-stick" data-touch-visual="right" aria-hidden="true"><i></i><b></b><em></em></div>`;
    surface.append(this.root);
    this.left = this.stick('left');
    this.right = this.stick('right');
    surface.addEventListener('pointerdown', this.onPointerDown, true);
    surface.addEventListener('pointermove', this.onPointerMove, true);
    surface.addEventListener('pointerup', this.onPointerUp, true);
    surface.addEventListener('pointercancel', this.onPointerCancel, true);
    surface.addEventListener('lostpointercapture', this.onLostPointerCapture, true);
    window.addEventListener('blur', this.releaseAll);
  }

  get active(): boolean {
    return this.capable && this.touchUsed && this.capturing;
  }

  setCapturing(capturing: boolean): void {
    this.capturing = capturing;
    this.releaseAll();
    this.updateVisibility();
  }

  sample(): TouchSample {
    this.updateChord();
    const chordActive = this.chord !== null && !this.chord.moved && this.hasPointer(this.chord.first) && this.hasPointer(this.chord.second);
    const buttons = this.tappedButtons | (!chordActive && this.right.firing ? Button.Fire : 0);
    this.tappedButtons = 0;
    return {
      moveX: chordActive ? 0 : this.left.x,
      moveY: chordActive ? 0 : this.left.y,
      moveActive: !chordActive && this.left.pointerId !== null && Math.hypot(this.left.x, this.left.y) > STICK_DEADZONE,
      aimX: chordActive ? 0 : this.right.x,
      aimY: chordActive ? 0 : this.right.y,
      aimActive: !chordActive && this.right.pointerId !== null && Math.hypot(this.right.x, this.right.y) > STICK_DEADZONE,
      buttons,
    };
  }

  takePause(): boolean {
    const tapped = this.pauseTapped;
    this.pauseTapped = false;
    return tapped;
  }

  readonly releaseAll = (): void => {
    this.resetStick(this.left);
    this.resetStick(this.right);
    this.chord = null;
    this.tappedButtons = 0;
    this.pauseTapped = false;
  };

  dispose(): void {
    this.surface.removeEventListener('pointerdown', this.onPointerDown, true);
    this.surface.removeEventListener('pointermove', this.onPointerMove, true);
    this.surface.removeEventListener('pointerup', this.onPointerUp, true);
    this.surface.removeEventListener('pointercancel', this.onPointerCancel, true);
    this.surface.removeEventListener('lostpointercapture', this.onLostPointerCapture, true);
    window.removeEventListener('blur', this.releaseAll);
    if (this.guideTimer !== null) window.clearTimeout(this.guideTimer);
    this.releaseAll();
    this.root.remove();
  }

  private stick(side: 'left' | 'right'): StickState {
    return {
      side,
      visual: this.root.querySelector<HTMLElement>(`[data-touch-visual="${side}"]`)!,
      pointerId: null,
      startX: 0,
      startY: 0,
      x: 0,
      y: 0,
      startedAt: 0,
      maxDistance: 0,
      firing: false,
    };
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    const usesTouch = event.pointerType !== 'mouse';
    if (usesTouch !== this.touchUsed) {
      this.touchUsed = usesTouch;
      this.releaseAll();
      this.updateVisibility();
    }
    if (!this.active || !usesTouch) return;
    event.preventDefault();
    const box = this.surface.getBoundingClientRect();
    const preferLeft = event.clientX < box.left + box.width * 0.5;
    const preferred = preferLeft ? this.left : this.right;
    const other = preferLeft ? this.right : this.left;
    const stick = preferred.pointerId === null ? preferred : other.pointerId === null ? other : null;
    if (stick === null) return;
    stick.pointerId = event.pointerId;
    stick.startX = event.clientX - box.left;
    stick.startY = event.clientY - box.top;
    stick.x = 0;
    stick.y = 0;
    stick.startedAt = performance.now();
    stick.maxDistance = 0;
    stick.firing = false;
    this.placeVisual(stick, 0, 0);
    stick.visual.hidden = false;
    this.surface.setPointerCapture(event.pointerId);
    const otherStick = stick === this.left ? this.right : this.left;
    if (otherStick.pointerId !== null && otherStick.maxDistance <= TAP_MAX_DISTANCE && Math.abs(stick.startedAt - otherStick.startedAt) <= CHORD_START_MS) {
      this.chord = {
        first: otherStick.pointerId,
        second: stick.pointerId,
        formedAt: stick.startedAt,
        moved: false,
        cancelled: false,
        triggered: false,
      };
    }
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    const stick = this.stickFor(event.pointerId);
    if (stick === null) return;
    event.preventDefault();
    const box = this.surface.getBoundingClientRect();
    const rawX = event.clientX - box.left - stick.startX;
    const rawY = event.clientY - box.top - stick.startY;
    const distance = Math.hypot(rawX, rawY);
    stick.maxDistance = Math.max(stick.maxDistance, distance);
    const scale = distance > STICK_RADIUS ? STICK_RADIUS / distance : 1;
    const dx = rawX * scale;
    const dy = rawY * scale;
    stick.x = dx / STICK_RADIUS;
    stick.y = -dy / STICK_RADIUS;
    this.placeVisual(stick, dx, dy);
    if (this.chord !== null && (this.chord.first === event.pointerId || this.chord.second === event.pointerId) && distance > TAP_MAX_DISTANCE) {
      this.chord.moved = true;
    }
    if (stick === this.right) {
      const magnitude = Math.hypot(stick.x, stick.y);
      if (!stick.firing && magnitude >= FIRE_ON) {
        stick.firing = true;
        stick.visual.dataset.fire = 'true';
        this.pulse(stick.startX + dx, stick.startY + dy, 'fire');
      } else if (stick.firing && magnitude <= FIRE_OFF) {
        stick.firing = false;
        stick.visual.dataset.fire = 'false';
      }
    }
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    this.finishPointer(event, false);
  };

  private readonly onPointerCancel = (event: PointerEvent): void => {
    this.finishPointer(event, true);
  };

  private readonly onLostPointerCapture = (event: PointerEvent): void => {
    if (this.stickFor(event.pointerId) !== null) this.finishPointer(event, true);
  };

  private finishPointer(event: PointerEvent, cancelled: boolean): void {
    const stick = this.stickFor(event.pointerId);
    if (stick === null) return;
    event.preventDefault();
    const now = performance.now();
    const chord = this.chord;
    const chordPointer = chord !== null && (chord.first === event.pointerId || chord.second === event.pointerId);
    const tap = !cancelled && now - stick.startedAt <= TAP_MAX_MS && stick.maxDistance <= TAP_MAX_DISTANCE;
    const pulseX = stick.startX;
    const pulseY = stick.startY;
    this.resetStick(stick);
    if (chordPointer && chord !== null) {
      if (cancelled) chord.cancelled = true;
      if (!this.hasPointer(chord.first) && !this.hasPointer(chord.second)) {
        if (!chord.cancelled && !chord.moved && !chord.triggered && now - chord.formedAt <= CHORD_TAP_MAX_MS) {
          this.pauseTapped = true;
          this.pulse((this.left.startX + this.right.startX) * 0.5, (this.left.startY + this.right.startY) * 0.5, 'chord');
        }
        this.chord = null;
      }
      return;
    }
    if (!tap) return;
    this.tappedButtons |= stick.side === 'left' ? Button.Boost : Button.Alt;
    this.pulse(pulseX, pulseY, stick.side);
  }

  private updateChord(): void {
    const chord = this.chord;
    if (chord === null || chord.moved || chord.triggered || !this.hasPointer(chord.first) || !this.hasPointer(chord.second)) return;
    if (performance.now() - chord.formedAt < CHORD_HOLD_MS) return;
    chord.triggered = true;
    this.tappedButtons |= Button.Boss | Button.Ultima;
    this.pulse((this.left.startX + this.right.startX) * 0.5, (this.left.startY + this.right.startY) * 0.5, 'chord');
  }

  private hasPointer(pointerId: number): boolean {
    return this.left.pointerId === pointerId || this.right.pointerId === pointerId;
  }

  private stickFor(pointerId: number): StickState | null {
    if (this.left.pointerId === pointerId) return this.left;
    if (this.right.pointerId === pointerId) return this.right;
    return null;
  }

  private resetStick(stick: StickState): void {
    const pointerId = stick.pointerId;
    stick.pointerId = null;
    stick.x = 0;
    stick.y = 0;
    stick.firing = false;
    stick.visual.hidden = true;
    stick.visual.dataset.fire = 'false';
    if (pointerId !== null && this.surface.hasPointerCapture(pointerId)) this.surface.releasePointerCapture(pointerId);
  }

  private placeVisual(stick: StickState, dx: number, dy: number): void {
    stick.visual.style.left = `${stick.startX}px`;
    stick.visual.style.top = `${stick.startY}px`;
    stick.visual.style.setProperty('--stick-x', `${dx}px`);
    stick.visual.style.setProperty('--stick-y', `${dy}px`);
    stick.visual.style.setProperty('--stick-length', `${Math.hypot(dx, dy)}px`);
    stick.visual.style.setProperty('--stick-angle', `${Math.atan2(dy, dx)}rad`);
  }

  private pulse(x: number, y: number, kind: 'left' | 'right' | 'fire' | 'chord'): void {
    const pulse = document.createElement('div');
    pulse.className = 'bf-touch-pulse';
    pulse.dataset.kind = kind;
    pulse.style.left = `${x}px`;
    pulse.style.top = `${y}px`;
    this.root.append(pulse);
    window.setTimeout(() => pulse.remove(), PULSE_MS);
  }

  private updateVisibility(): void {
    this.root.hidden = !this.active;
    if (!this.active || this.guideSeen) return;
    this.guideSeen = true;
    this.root.dataset.guide = 'true';
    try {
      localStorage.setItem(GUIDE_STORAGE_KEY, '1');
    } catch {
      /* storage is optional */
    }
    this.guideTimer = window.setTimeout(() => {
      this.root.dataset.guide = 'false';
      this.guideTimer = null;
    }, GUIDE_MS);
  }
}

function readGuideSeen(): boolean {
  try {
    return localStorage.getItem(GUIDE_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID) !== null) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .bf-touch-controls {
      position: absolute; inset: 0; z-index: 15; pointer-events: none; overflow: hidden;
      font-family: Inter, "Segoe UI", system-ui, sans-serif; color: #e9fbff;
    }
    .bf-touch-controls[hidden] { display: none; }
    .bf-touch-controls *, .bf-touch-controls *::before, .bf-touch-controls *::after {
      box-sizing: border-box; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
    }
    .bf-ghost-stick {
      --stick-x: 0px; --stick-y: 0px; --stick-length: 0px; --stick-angle: 0rad;
      position: absolute; width: 1px; height: 1px; opacity: .28;
    }
    .bf-ghost-stick[hidden] { display: none; }
    .bf-ghost-stick i, .bf-ghost-stick b, .bf-ghost-stick em { position: absolute; pointer-events: none; }
    .bf-ghost-stick i {
      left: -3px; top: -3px; width: 6px; height: 6px; border-radius: 50%;
      background: rgba(233,251,255,.84); box-shadow: 0 0 12px rgba(53,208,255,.42);
    }
    .bf-ghost-stick b {
      left: 0; top: -1px; width: var(--stick-length); height: 2px; transform: rotate(var(--stick-angle)); transform-origin: left center;
      background: linear-gradient(90deg, rgba(111,227,255,.2), rgba(111,227,255,.82)); box-shadow: 0 0 8px rgba(53,208,255,.2);
    }
    .bf-ghost-stick em {
      left: var(--stick-x); top: var(--stick-y); width: 22px; height: 22px; transform: translate(-50%, -50%);
      border: 1px solid rgba(233,251,255,.62); border-radius: 50%; background: rgba(53,208,255,.08);
      box-shadow: 0 0 14px rgba(53,208,255,.24);
    }
    .bf-ghost-stick[data-fire="true"] { opacity: .52; }
    .bf-ghost-stick[data-fire="true"] b { background: linear-gradient(90deg, rgba(111,227,255,.28), #e9fbff); }
    .bf-ghost-stick[data-fire="true"] em { border-color: #e9fbff; box-shadow: 0 0 22px rgba(53,208,255,.58); }
    .bf-touch-pulse {
      position: absolute; width: 22px; height: 22px; transform: translate(-50%, -50%); border: 1px solid rgba(111,227,255,.86);
      border-radius: 50%; animation: bf-touch-pulse .62s ease-out forwards;
    }
    .bf-touch-pulse[data-kind="left"] { border-color: rgba(124,255,107,.88); }
    .bf-touch-pulse[data-kind="right"] { border-color: rgba(255,199,101,.9); }
    .bf-touch-pulse[data-kind="chord"] { border-color: rgba(255,106,128,.92); }
    .bf-touch-guide {
      position: absolute; left: 50%; top: max(92px, calc(env(safe-area-inset-top) + 82px)); transform: translateX(-50%);
      display: grid; gap: 5px; width: min(90vw, 580px); padding: 10px 14px; opacity: 0;
      border: 1px solid rgba(111,227,255,.2); background: rgba(3,10,18,.72); color: #9fb5c6;
      font-size: 10px; line-height: 1.35; letter-spacing: .04em; text-align: center; transition: opacity .24s ease;
    }
    .bf-touch-guide strong { color: #e9fbff; text-transform: uppercase; letter-spacing: .12em; }
    .bf-touch-controls[data-guide="true"] .bf-touch-guide { opacity: 1; }
    .bf-touch-rotate {
      display: none; position: absolute; left: 50%; top: max(88px, calc(env(safe-area-inset-top) + 82px)); transform: translateX(-50%);
      padding: 7px 12px; border: 1px solid rgba(255,199,101,.52); background: rgba(22,12,4,.72); color: #ffd46f;
      font-size: 10px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; white-space: nowrap;
    }
    @media (orientation: portrait) {
      .bf-touch-rotate { display: block; }
      .bf-touch-guide { top: max(126px, calc(env(safe-area-inset-top) + 120px)); }
    }
    @media (prefers-reduced-motion: reduce) {
      .bf-touch-pulse { animation: none; opacity: 0; }
      .bf-touch-guide { transition: none; }
    }
    @keyframes bf-touch-pulse {
      from { opacity: .9; transform: translate(-50%, -50%) scale(.7); }
      to { opacity: 0; transform: translate(-50%, -50%) scale(3.2); }
    }`;
  document.head.append(style);
}
