import { fx } from '@metronome/engine';
import { ALT_ABILITIES, Button, Form, FORMS, Frame, HAILSTORM, MUZZLE, PRIMARY_WEAPONS, canUseAlt } from '../sim/index.ts';
import { FIRE_RANGE, inPrimaryReach, mayFire, to, type BotSense, type RobotTactics } from './tactics.ts';

const CARPET = HAILSTORM.carpet;
/** HAILSTORM fights at mid range: deep in its cannon's reach, where the spray still lands, in the middle of its carpet. */
const PREFERRED_RANGE = 240;
/**
 * Once the cannon turns, the trigger stays down for a target anywhere within its rounds' flight (it opens fire only well inside
 * it): letting go spins the barrels down, and the next burst would start slow.
 */
const HOLD_RANGE = Math.min(FIRE_RANGE, to(PRIMARY_WEAPONS[Frame.Hailstorm].reach));
/** A pilot closing in faster than this (world units per tick) is met at FIRE_RANGE, so the cannon is a hose when it arrives. */
const CLOSING_SPEED = 0.5;
/** A carpet is laid with this much energy left over, so the shield can still come up after it. */
const CARPET_SPARE_ENERGY = 60;
/** A bomb counts as landing on the target within this share of its blast radius of where the target will be... */
const CARPET_HIT_SHARE = 0.75;
/** ...plus this share of a colossus's reach (a blast hurts every part it touches). */
const BOSS_REACH_SHARE = 0.5;

interface Drop {
  /** Distance from HAILSTORM's centre along the aim, world units. */
  readonly reach: number;
  /** Ticks from launch to landing. */
  readonly ticks: number;
}

/** Where and when each bomb of a carpet lands: lobbed from the muzzle along the aim at the bomb's speed (projectiles.ts lob). */
const DROPS: readonly Drop[] = Array.from({ length: CARPET.count }, (_, k) => {
  const distance = to(CARPET.first + CARPET.gap * k);
  return { reach: to(MUZZLE) + distance, ticks: Math.ceil(distance / to(CARPET.bomb.spd)) };
});

/**
 * HAILSTORM, the walking arsenal: keeps its rotary cannon spun up (the trigger stays down while the target is within its
 * rounds' flight, and it opens up early on a pilot closing in, so the cannon is already a hose when it arrives), sprays at mid
 * range, and lays its carpet along the target's course, so the line of bombs rolls out over where it is going.
 */
export function createHailstormTactics(): RobotTactics {
  let carpetAim: number | null = null;
  return {
    range: PREFERRED_RANGE,
    buttons(sense: BotSense): number {
      const { w, seat, range } = sense;
      const m = w.m;
      let buttons = 0;
      const spinning = m.plSpin[seat] > 0 && range < HOLD_RANGE;
      const arriving = closingSpeed(sense) > CLOSING_SPEED && range < FIRE_RANGE;
      if ((inPrimaryReach(sense) || spinning || arriving) && mayFire(sense)) buttons |= Button.Fire;
      carpetAim = null;
      if (sense.target.ship && m.plEnergy[seat] >= ALT_ABILITIES[Frame.Hailstorm].cost + CARPET_SPARE_ENERGY && canUseAlt(w, seat)) {
        const line = carpetLine(sense);
        if (line.hits > 0) carpetAim = line.aim;
      }
      if (carpetAim !== null) buttons |= Button.Alt;
      return buttons;
    },
    aim: (sense) => carpetAim ?? sense.aim,
    move: () => null,
  };
}

/** How fast the target is coming at HAILSTORM (world units per tick; negative when it draws away). */
function closingSpeed(sense: BotSense): number {
  const { me, target, range } = sense;
  if (range < 1) return 0;
  return (target.vx * (me.x - target.x) + target.vy * (me.y - target.y)) / range;
}

interface CarpetLine {
  /** Binary angle. */
  readonly aim: number;
  /** Bombs of the line that come down on the target. */
  readonly hits: number;
}

/**
 * The aim that lines the carpet up with the target's course. Each bomb could be the one that meets the target: aiming at where
 * the target will be when that bomb lands (its velocity kept, read as well as the bot's skill allows), count the bombs of the
 * whole line that come down on it. The aim with the most wins, then the one with the closest miss: a pilot fleeing down the
 * line is met by several bombs in turn, one crossing it by the bomb that walls off its path.
 */
function carpetLine(sense: BotSense): CarpetLine {
  const { w, me, target, skill } = sense;
  const m = w.m;
  const reach = m.plForm[target.seat] === Form.Boss ? to(FORMS[m.plFrame[target.seat]].reach) * BOSS_REACH_SHARE : 0;
  const tolerance = to(CARPET.bomb.blastR) * CARPET_HIT_SHARE + reach;
  const at = (drop: Drop) => ({ x: target.x + target.vx * drop.ticks * skill - me.x, y: target.y + target.vy * drop.ticks * skill - me.y });
  let best: CarpetLine = { aim: sense.aim, hits: 0 };
  let bestMiss = Infinity;
  for (const drop of DROPS) {
    const aimAt = at(drop);
    const angle = Math.atan2(aimAt.y, aimAt.x);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    let hits = 0;
    let miss = Infinity;
    for (const other of DROPS) {
      const p = at(other);
      const gap = Math.hypot(p.x - cos * other.reach, p.y - sin * other.reach);
      if (gap < tolerance) hits++;
      miss = Math.min(miss, gap);
    }
    if (hits > best.hits || (hits === best.hits && hits > 0 && miss < bestMiss)) {
      best = { aim: fx.fromRadians(angle), hits };
      bestMiss = miss;
    }
  }
  return best;
}
