// Presentation constants (never read by the simulation).

export const MAX_DPR = 2;
/**
 * Pixel budget for a canvas backing store: 4K. Fill cost and GPU memory grow with the pixel count (the 4x MSAA
 * half-float scene target alone holds 32 bytes per pixel), and past 4K a denser picture is not visibly sharper.
 */
export const MAX_BACKING_PIXELS = 3840 * 2160;

/** The backing-store scale of a canvas of this CSS size: the device pixel ratio, capped by MAX_DPR and by the pixel budget. */
export function backingScale(cssWidth: number, cssHeight: number, devicePixelRatio: number): number {
  return Math.min(devicePixelRatio, MAX_DPR, Math.sqrt(MAX_BACKING_PIXELS / Math.max(1, cssWidth * cssHeight)));
}

/** One colour per team id (sRGB hex): distinct hues, all bright enough for near-black. Neutral units never use these. */
export const TEAM_COLORS: readonly number[] = [0x35d0ff, 0xff4fa3, 0xffd23f, 0x7cff6b, 0xb48cff, 0xff8a3d, 0x3dffc4, 0x4d7cff];

/** Neutral units and their projectiles: steel edges with hostile red accents, never a team hue. */
export const NEUTRAL_COLORS = { edge: 0xcfd8e8, accent: 0xff2a2a } as const;
