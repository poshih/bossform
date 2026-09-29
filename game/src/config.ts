// Presentation constants (never read by the simulation).

export const MAX_DPR = 2;

/** One colour per team id (sRGB hex): distinct hues, all bright enough for near-black. Neutral units never use these. */
export const TEAM_COLORS: readonly number[] = [0x35d0ff, 0xff4fa3, 0xffd23f, 0x7cff6b, 0xb48cff, 0xff8a3d, 0x3dffc4, 0x4d7cff];

/** Neutral units and their projectiles: steel edges with hostile red accents, never a team hue. */
export const NEUTRAL_COLORS = { edge: 0xcfd8e8, accent: 0xff2a2a } as const;
