import { FRAME_NAMES } from '../setup.ts';
import { Frame, FRAME_COUNT } from '../sim/index.ts';

const SVG_BOX = '0 0 128 128';
/** HAILSTORM's rack: one warhead circle per cell of its 3 x 2 grid. */
const HAILSTORM_CELLS = [34, 64, 94].flatMap((cx) => [47, 81].map((cy) => `<circle cx="${cx}" cy="${cy}" r="5"/>`)).join('');

/**
 * Each frame's emblem colour, by frame: the robot's accent (the first three keep the colours they always had; the specialists
 * take the accents their models are drawn with: ice, white-gold, amber, crimson, violet, gold).
 */
export const FRAME_EMBLEM_COLORS: readonly number[] = [0x35d0ff, 0xff4fa3, 0xffd23f, 0xc6f4ff, 0xfff0b8, 0xff8f33, 0xff3d4d, 0xb57bff, 0xffb43a];
if (FRAME_EMBLEM_COLORS.length !== FRAME_COUNT) throw new RangeError(`FRAME_EMBLEM_COLORS lists ${FRAME_EMBLEM_COLORS.length} frames, the simulation has ${FRAME_COUNT}`);

function svgShell(stroke: string, path: string, extras = ''): string {
  return `<svg viewBox="${SVG_BOX}" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"><g fill="none" stroke="${stroke}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round">${path}${extras}</g></svg>`;
}

export function frameEmblemSvg(frame: number, stroke: string): string {
  switch (frame) {
    case Frame.Vanguard:
      return svgShell(stroke, '<path d="M24 68 64 20l40 48-18 40H42Z"/><path d="M52 68h24"/>', '<path d="M39 47h50" stroke-width="4" opacity=".45"/>');
    case Frame.Gale:
      return svgShell(stroke, '<path d="M24 64 52 30h24l28 34-28 34H52Z"/><path d="M64 30v68"/>', '<path d="M36 64h56" stroke-width="4" opacity=".45"/>');
    case Frame.Juggernaut:
      return svgShell(stroke, '<path d="M18 50 36 28h56l18 22v28l-18 22H36L18 78Z"/><path d="M44 64h40"/>', '<path d="M32 42h64M32 86h64" stroke-width="4" opacity=".45"/>');
    case Frame.Longbow:
      // A scope reticle on a long rail.
      return svgShell(stroke, '<circle cx="64" cy="64" r="26"/><path d="M10 64h40M78 64h40M64 30v12M64 86v12"/>', '<path d="M64 16v6M64 106v6" stroke-width="4" opacity=".45"/><circle cx="64" cy="64" r="4" stroke-width="4" opacity=".45"/>');
    case Frame.Prism:
      // A prism lens: one beam in, a spread of light out.
      return svgShell(stroke, '<path d="M64 18 108 96H20Z"/><path d="M8 74h24"/>', '<path d="M90 64 118 52M94 72h24M98 80l20 10" stroke-width="4" opacity=".45"/>');
    case Frame.Hailstorm:
      // A bomb rack: a grid of cells, a warhead in each.
      return svgShell(stroke, '<path d="M26 30h76l8 8v52l-8 8H26l-8-8V38Z"/><path d="M49 30v68M79 30v68M18 64h92"/>', `<g stroke-width="4" opacity=".45">${HAILSTORM_CELLS}</g>`);
    case Frame.Ronin:
      // A crescent blade over its guard and hilt.
      return svgShell(stroke, '<path d="M44 14A56 56 0 0 0 114 84 78 78 0 0 1 44 14Z"/><path d="M30 86 42 98"/>', '<path d="M16 112 36 92" stroke-width="4" opacity=".45"/>');
    case Frame.Shade:
      // A four-point star (shuriken) in a faint ring.
      return svgShell(stroke, '<path d="M64 12 75 53 116 64 75 75 64 116 53 75 12 64 53 53Z"/><circle cx="64" cy="64" r="8"/>', '<circle cx="64" cy="64" r="32" stroke-width="4" opacity=".45"/>');
    case Frame.Gauntlet:
      // A clenched fist under a V-crest.
      return svgShell(stroke, '<path d="M26 14 64 42l38-28"/><path d="M32 54h64l8 10v28l-12 14H36L24 92V64Z"/><path d="M48 54v18M64 54v18M80 54v18M24 80h32l10-8"/>', '<path d="M40 118h48" stroke-width="4" opacity=".45"/>');
    default:
      throw new RangeError(`unknown frame ${frame} (${FRAME_NAMES[frame] ?? 'OUT OF RANGE'})`);
  }
}
