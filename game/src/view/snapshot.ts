import { FORMS, MAX_PARTS, W, type World } from '../sim/index.ts';
import { binaryAngleToRadians, lerp, lerpBinaryAngle, toWorld } from './shared.ts';

export class WorldSnapshot {
  readonly seats: number;
  readonly projectiles: number;
  readonly neutrals: number;
  readonly orbs: number;
  readonly parts: number;

  tick = 0;
  safeR = 0;
  phase = 0;
  roundTick = 0;

  readonly plActive: Uint8Array;
  readonly plAlive: Uint8Array;
  readonly plFrame: Uint8Array;
  readonly plTeam: Uint8Array;
  readonly plForm: Uint8Array;
  readonly plAtk: Uint8Array;
  readonly plAtkPhase: Uint8Array;
  readonly plX: Int32Array;
  readonly plY: Int32Array;
  readonly plVX: Int32Array;
  readonly plVY: Int32Array;
  readonly plAim: Int32Array;
  readonly plBody: Int32Array;
  readonly plOrbit: Int32Array;
  readonly plHp: Int32Array;
  readonly plInvuln: Int32Array;
  readonly plGauge: Int32Array;
  readonly plTimer: Int32Array;
  readonly plFlash: Int32Array;
  readonly plDash: Int32Array;
  readonly plBulwark: Int32Array;
  readonly plAtkTimer: Int32Array;
  readonly plEpoch: Int32Array;
  readonly plShield: Uint8Array;
  readonly plEnergy: Int32Array;
  readonly plShieldWait: Int32Array;
  readonly plShieldBreak: Int32Array;
  readonly plBoost: Int32Array;
  readonly plBoostCd: Int32Array;
  readonly plCharge: Int32Array;
  readonly plSpin: Int32Array;
  readonly plParry: Int32Array;
  readonly plCloak: Int32Array;
  readonly plBeam: Int32Array;
  readonly plBeamAng: Int32Array;
  readonly plBeamLen: Int32Array;
  readonly plLance: Int32Array;
  readonly plLanceAng: Int32Array;
  readonly plSide: Uint8Array;

  readonly ptHp: Int32Array;
  readonly ptAng: Int32Array;
  readonly ptFlash: Int32Array;
  readonly ptHeat: Int32Array;
  readonly ptBeamLen: Int32Array;
  readonly ptAway: Uint8Array;

  readonly pAlive: Uint8Array;
  readonly pAttack: Uint8Array;
  readonly pPart: Uint8Array;
  readonly pMode: Uint8Array;
  readonly pDef: Uint16Array;
  readonly pOwner: Int32Array;
  readonly pTeam: Int32Array;
  readonly pX: Int32Array;
  readonly pY: Int32Array;
  readonly pAng: Int32Array;
  readonly pSpd: Int32Array;
  readonly pAge: Int32Array;
  readonly pFuse: Int32Array;

  readonly nAlive: Uint8Array;
  readonly nType: Uint8Array;
  readonly nX: Int32Array;
  readonly nY: Int32Array;
  readonly nVX: Int32Array;
  readonly nVY: Int32Array;
  readonly nHp: Int32Array;
  readonly nAge: Int32Array;
  readonly nAng: Int32Array;
  readonly nFlash: Int32Array;

  readonly oAlive: Uint8Array;
  readonly oX: Int32Array;
  readonly oY: Int32Array;
  readonly oVX: Int32Array;
  readonly oVY: Int32Array;
  readonly oAge: Int32Array;
  readonly oVal: Int32Array;

  constructor(world: World) {
    this.seats = world.seats;
    this.projectiles = world.cap.projectiles;
    this.neutrals = world.cap.neutrals;
    this.orbs = world.cap.orbs;
    this.parts = world.cap.parts;

    this.plActive = new Uint8Array(this.seats);
    this.plAlive = new Uint8Array(this.seats);
    this.plFrame = new Uint8Array(this.seats);
    this.plTeam = new Uint8Array(this.seats);
    this.plForm = new Uint8Array(this.seats);
    this.plAtk = new Uint8Array(this.seats);
    this.plAtkPhase = new Uint8Array(this.seats);
    this.plX = new Int32Array(this.seats);
    this.plY = new Int32Array(this.seats);
    this.plVX = new Int32Array(this.seats);
    this.plVY = new Int32Array(this.seats);
    this.plAim = new Int32Array(this.seats);
    this.plBody = new Int32Array(this.seats);
    this.plOrbit = new Int32Array(this.seats);
    this.plHp = new Int32Array(this.seats);
    this.plInvuln = new Int32Array(this.seats);
    this.plGauge = new Int32Array(this.seats);
    this.plTimer = new Int32Array(this.seats);
    this.plFlash = new Int32Array(this.seats);
    this.plDash = new Int32Array(this.seats);
    this.plBulwark = new Int32Array(this.seats);
    this.plAtkTimer = new Int32Array(this.seats);
    this.plEpoch = new Int32Array(this.seats);
    this.plShield = new Uint8Array(this.seats);
    this.plEnergy = new Int32Array(this.seats);
    this.plShieldWait = new Int32Array(this.seats);
    this.plShieldBreak = new Int32Array(this.seats);
    this.plBoost = new Int32Array(this.seats);
    this.plBoostCd = new Int32Array(this.seats);
    this.plCharge = new Int32Array(this.seats);
    this.plSpin = new Int32Array(this.seats);
    this.plParry = new Int32Array(this.seats);
    this.plCloak = new Int32Array(this.seats);
    this.plBeam = new Int32Array(this.seats);
    this.plBeamAng = new Int32Array(this.seats);
    this.plBeamLen = new Int32Array(this.seats);
    this.plLance = new Int32Array(this.seats);
    this.plLanceAng = new Int32Array(this.seats);
    this.plSide = new Uint8Array(this.seats);

    this.ptHp = new Int32Array(this.parts);
    this.ptAng = new Int32Array(this.parts);
    this.ptFlash = new Int32Array(this.parts);
    this.ptHeat = new Int32Array(this.parts);
    this.ptBeamLen = new Int32Array(this.parts);
    this.ptAway = new Uint8Array(this.parts);

    this.pAlive = new Uint8Array(this.projectiles);
    this.pAttack = new Uint8Array(this.projectiles);
    this.pPart = new Uint8Array(this.projectiles);
    this.pMode = new Uint8Array(this.projectiles);
    this.pDef = new Uint16Array(this.projectiles);
    this.pOwner = new Int32Array(this.projectiles);
    this.pTeam = new Int32Array(this.projectiles);
    this.pX = new Int32Array(this.projectiles);
    this.pY = new Int32Array(this.projectiles);
    this.pAng = new Int32Array(this.projectiles);
    this.pSpd = new Int32Array(this.projectiles);
    this.pAge = new Int32Array(this.projectiles);
    this.pFuse = new Int32Array(this.projectiles);

    this.nAlive = new Uint8Array(this.neutrals);
    this.nType = new Uint8Array(this.neutrals);
    this.nX = new Int32Array(this.neutrals);
    this.nY = new Int32Array(this.neutrals);
    this.nVX = new Int32Array(this.neutrals);
    this.nVY = new Int32Array(this.neutrals);
    this.nHp = new Int32Array(this.neutrals);
    this.nAge = new Int32Array(this.neutrals);
    this.nAng = new Int32Array(this.neutrals);
    this.nFlash = new Int32Array(this.neutrals);

    this.oAlive = new Uint8Array(this.orbs);
    this.oX = new Int32Array(this.orbs);
    this.oY = new Int32Array(this.orbs);
    this.oVX = new Int32Array(this.orbs);
    this.oVY = new Int32Array(this.orbs);
    this.oAge = new Int32Array(this.orbs);
    this.oVal = new Int32Array(this.orbs);

    this.copyFrom(world);
  }

  copyFrom(world: World): void {
    const { m } = world;
    this.tick = m.world[W.Tick];
    this.safeR = m.world[W.SafeR];
    this.phase = m.world[W.Phase];
    this.roundTick = m.world[W.RoundTick];

    this.plActive.set(m.plActive);
    this.plAlive.set(m.plAlive);
    this.plFrame.set(m.plFrame);
    this.plTeam.set(m.plTeam);
    this.plForm.set(m.plForm);
    this.plAtk.set(m.plAtk);
    this.plAtkPhase.set(m.plAtkPhase);
    this.plX.set(m.plX);
    this.plY.set(m.plY);
    this.plVX.set(m.plVX);
    this.plVY.set(m.plVY);
    this.plAim.set(m.plAim);
    this.plBody.set(m.plBody);
    this.plOrbit.set(m.plOrbit);
    this.plHp.set(m.plHp);
    this.plInvuln.set(m.plInvuln);
    this.plGauge.set(m.plGauge);
    this.plTimer.set(m.plTimer);
    this.plFlash.set(m.plFlash);
    this.plDash.set(m.plDash);
    this.plBulwark.set(m.plBulwark);
    this.plAtkTimer.set(m.plAtkTimer);
    this.plEpoch.set(m.plEpoch);
    this.plShield.set(m.plShield);
    this.plEnergy.set(m.plEnergy);
    this.plShieldWait.set(m.plShieldWait);
    this.plShieldBreak.set(m.plShieldBreak);
    this.plBoost.set(m.plBoost);
    this.plBoostCd.set(m.plBoostCd);
    this.plCharge.set(m.plCharge);
    this.plSpin.set(m.plSpin);
    this.plParry.set(m.plParry);
    this.plCloak.set(m.plCloak);
    this.plBeam.set(m.plBeam);
    this.plBeamAng.set(m.plBeamAng);
    this.plBeamLen.set(m.plBeamLen);
    this.plLance.set(m.plLance);
    this.plLanceAng.set(m.plLanceAng);
    this.plSide.set(m.plSide);

    this.ptHp.set(m.ptHp);
    this.ptAng.set(m.ptAng);
    this.ptFlash.set(m.ptFlash);
    this.ptHeat.set(m.ptHeat);
    this.ptBeamLen.set(m.ptBeamLen);
    this.ptAway.set(m.ptAway);

    this.pAlive.set(m.pAlive);
    this.pAttack.set(m.pAttack);
    this.pPart.set(m.pPart);
    this.pMode.set(m.pMode);
    this.pDef.set(m.pDef);
    this.pOwner.set(m.pOwner);
    this.pTeam.set(m.pTeam);
    this.pX.set(m.pX);
    this.pY.set(m.pY);
    this.pAng.set(m.pAng);
    this.pSpd.set(m.pSpd);
    this.pAge.set(m.pAge);
    this.pFuse.set(m.pFuse);

    this.nAlive.set(m.nAlive);
    this.nType.set(m.nType);
    this.nX.set(m.nX);
    this.nY.set(m.nY);
    this.nVX.set(m.nVX);
    this.nVY.set(m.nVY);
    this.nHp.set(m.nHp);
    this.nAge.set(m.nAge);
    this.nAng.set(m.nAng);
    this.nFlash.set(m.nFlash);

    this.oAlive.set(m.oAlive);
    this.oX.set(m.oX);
    this.oY.set(m.oY);
    this.oVX.set(m.oVX);
    this.oVY.set(m.oVY);
    this.oAge.set(m.oAge);
    this.oVal.set(m.oVal);
  }
}

/**
 * A pilot that died, respawned or was moved without travelling (its epoch changed) between the two snapshots: it is drawn
 * where it is now, never slid across the arena from where it was.
 */
export function seatJumped(previous: WorldSnapshot, current: WorldSnapshot, seat: number): boolean {
  return previous.plEpoch[seat] !== current.plEpoch[seat] || previous.plAlive[seat] !== current.plAlive[seat];
}

/** How far to blend a pilot from the previous snapshot toward the current one this frame (see seatJumped). */
export function seatBlend(previous: WorldSnapshot, current: WorldSnapshot, seat: number, alpha: number): number {
  return seatJumped(previous, current, seat) ? 1 : alpha;
}

/** Where a pilot is drawn this frame, in world units: every view that draws at a pilot's position uses this one. */
export function drawnSeatPoint(previous: WorldSnapshot, current: WorldSnapshot, seat: number, alpha: number, out: { x: number; y: number }): void {
  const t = seatBlend(previous, current, seat, alpha);
  out.x = lerp(toWorld(previous.plX[seat]), toWorld(current.plX[seat]), t);
  out.y = lerp(toWorld(previous.plY[seat]), toWorld(current.plY[seat]), t);
}

/** Where a boss-form part is drawn this frame, world units: the drawn core plus the part's offset turned by the drawn body or orbit. */
export function drawnPartCenter(previous: WorldSnapshot, current: WorldSnapshot, seat: number, part: number, alpha: number, out: { x: number; y: number }): void {
  const def = FORMS[current.plFrame[seat]].parts[part];
  const t = seatBlend(previous, current, seat, alpha);
  const angle = binaryAngleToRadians(def.orbit
    ? lerpBinaryAngle(previous.plOrbit[seat], current.plOrbit[seat], t)
    : lerpBinaryAngle(previous.plBody[seat], current.plBody[seat], t));
  drawnSeatPoint(previous, current, seat, alpha, out);
  const x = toWorld(def.x);
  const y = toWorld(def.y);
  out.x += x * Math.cos(angle) - y * Math.sin(angle);
  out.y += x * Math.sin(angle) + y * Math.cos(angle);
}

/** Where a pod's barrel points this frame, radians (interpolated like the ship). */
export function drawnPodFacing(previous: WorldSnapshot, current: WorldSnapshot, seat: number, part: number, alpha: number): number {
  const k = seat * MAX_PARTS + part;
  return binaryAngleToRadians(lerpBinaryAngle(previous.ptAng[k], current.ptAng[k], seatBlend(previous, current, seat, alpha)));
}

/**
 * A cloaked pilot is hidden from everyone not on its team: its robot, rings, glows, shield, boost wake and graze sparks are
 * not drawn for them (its shots still are). Reads either a snapshot or the live memory (event handlers).
 */
export function hiddenFrom(state: { readonly plCloak: ArrayLike<number>; readonly plTeam: ArrayLike<number> }, seat: number, viewerTeam: number): boolean {
  return state.plCloak[seat] > 0 && state.plTeam[seat] !== viewerTeam;
}
