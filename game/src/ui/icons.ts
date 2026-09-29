import { FRAME_NAMES } from '../setup.ts';
import { Frame } from '../sim/index.ts';

const SVG_BOX = '0 0 128 128';

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
    default:
      throw new RangeError(`unknown frame ${frame} (${FRAME_NAMES[frame] ?? 'OUT OF RANGE'})`);
  }
}
