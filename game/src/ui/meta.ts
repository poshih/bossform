import { EnemyType, Frame } from '../sim/index.ts';

/** Presentation copy for the three frames. Ratings (1-5) are marketing-style bars, not sim inputs. */
export interface FrameMeta {
  readonly name: string;
  readonly role: string;
  readonly bossForm: string;
  readonly blurb: readonly string[];
  readonly primary: string;
  readonly alt: string;
  readonly bossPrimary: string;
  readonly bossAlt: string;
  readonly color: string;
  readonly colorDark: string;
  readonly speed: number;
  readonly power: number;
  readonly armor: number;
}

export const FRAME_META: readonly FrameMeta[] = [
  {
    name: 'VANGUARD', role: 'VERSATILE', bossForm: 'PALADIN',
    blurb: ['BALANCED ALL-ROUNDER.', 'RELIABLE RIFLE, HOMING MISSILES', 'AND A WINGED BOSS FORM.'],
    primary: 'BEAM RIFLE', alt: 'SEEKER MISSILES', bossPrimary: 'SPREAD CANNON', bossAlt: 'JUDGEMENT BEAM',
    color: '#7ec4ff', colorDark: '#1f4f9a', speed: 3, power: 3, armor: 3,
  },
  {
    name: 'GALE', role: 'FAST STRIKER', bossForm: 'TEMPEST',
    blurb: ['LIGHT, LETHAL AND QUICK.', 'TWIN NEEDLES AND A DASH-SLASH.', 'BOSS FORM FLIES FOUR BLADE BITS.'],
    primary: 'TWIN NEEDLES', alt: 'DASH SLASH', bossPrimary: 'NEEDLES + BITS', bossAlt: 'BLADE STORM',
    color: '#ff6a5a', colorDark: '#8a1c22', speed: 5, power: 4, armor: 1,
  },
  {
    name: 'JUGGERNAUT', role: 'HEAVY ASSAULT', bossForm: 'FORTRESS',
    blurb: ['SLOW, ARMOURED SIEGE MECH.', 'HOWITZER SHELLS AND A SHIELD.', 'BOSS FORM IS A WALKING FORTRESS.'],
    primary: 'HOWITZER', alt: 'BULWARK SHIELD', bossPrimary: 'TWIN SIEGE GUNS', bossAlt: 'ROCKET BARRAGE',
    color: '#a9d04a', colorDark: '#4a5a1c', speed: 1, power: 5, armor: 5,
  },
];

export const BOSS_NAMES: Readonly<Record<number, string>> = {
  [EnemyType.Bulwark]: 'BULWARK',
  [EnemyType.Seraph]: 'SERAPH',
  [EnemyType.Overlord]: 'OVERLORD',
};

export const STAGE_NAMES: readonly string[] = ['IRON GATE', 'CRYSTAL SPIRE', 'THE THRONE'];
export const DIFFICULTY_NAMES: readonly string[] = ['EASY', 'NORMAL', 'HARD'];

export const FRAME_ORDER: readonly number[] = [Frame.Vanguard, Frame.Gale, Frame.Juggernaut];
