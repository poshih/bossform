import { NEUTRAL_COLORS, TEAM_COLORS } from '../config.ts';

export const UI_FONT_STACK = 'Inter, "Segoe UI", system-ui, sans-serif';
export const UI_CAPS_SPACING = '0.22em';
export const UI_BACKGROUND = '#060912';
export const UI_PANEL = 'rgba(8, 14, 24, 0.84)';
/** In-match panels sit over the fight, so they are more see-through than the menu panels. */
export const UI_HUD_PANEL = 'rgba(8, 14, 24, 0.66)';
export const UI_PANEL_STRONG = 'rgba(10, 17, 30, 0.94)';
export const UI_EDGE = 'rgba(141, 221, 255, 0.78)';
export const UI_EDGE_SOFT = 'rgba(141, 221, 255, 0.28)';
export const UI_TEXT = '#ebf7ff';
export const UI_TEXT_DIM = 'rgba(206, 227, 245, 0.68)';
export const UI_WARNING = '#ff6a80';
export const UI_WARNING_SOFT = 'rgba(255, 106, 128, 0.22)';
export const UI_ACCENT = '#6fe3ff';
export const UI_SUCCESS = '#7cffb4';
export const UI_MUTED = '#72859e';
export const UI_GLOW = 'rgba(111, 227, 255, 0.26)';

export function cssHex(value: number): string {
  return `#${value.toString(16).padStart(6, '0')}`;
}

export function rgba(value: number, alpha: number): string {
  const r = (value >> 16) & 0xff;
  const g = (value >> 8) & 0xff;
  const b = value & 0xff;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function teamColor(team: number): number {
  return TEAM_COLORS[Math.abs(team) % TEAM_COLORS.length];
}

export function teamCss(team: number): string {
  return cssHex(teamColor(team));
}

export function neutralEdge(alpha = 1): string {
  return rgba(NEUTRAL_COLORS.edge, alpha);
}

export function neutralAccent(alpha = 1): string {
  return rgba(NEUTRAL_COLORS.accent, alpha);
}
