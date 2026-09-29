/**
 * The music's beat, for presentation only: visuals and the HUD pulse on it. The App owns one BeatClock. While a track
 * plays it follows the music (AudioEngine.musicPosition); when nothing is audible (audio not unlocked yet, no track) it
 * keeps time on its own at the last known tempo, so the visuals never stop pulsing. Never read by the simulation.
 */

/** Where the music is: its tempo and how many beats have elapsed on its timeline. */
export interface MusicPosition {
  readonly bpm: number;
  readonly beats: number;
}

export interface Beat {
  readonly bpm: number;
  /** Beats elapsed on the music timeline. */
  readonly beats: number;
  /** Whole beats elapsed. */
  readonly index: number;
  /** 0..1 through the current beat (0 = on the beat). */
  readonly phase: number;
  /** Which beat of the 4/4 bar, 0..3 (0 = the downbeat). */
  readonly inBar: number;
  /** 1 exactly on the beat, decaying toward 0 before the next: multiply accents by it. */
  readonly pulse: number;
  /** Like `pulse` but only on the downbeat of each bar. */
  readonly barPulse: number;
}

export const BEATS_PER_BAR = 4;
/** The tempo kept until the music reports its own (the arcade-trance soundtrack sits around this). */
const INITIAL_BPM = 140;
/** How quickly an accent fades after its beat (per beat). */
const PULSE_SHARPNESS = 6;
const SECONDS_PER_MINUTE = 60;

export class BeatClock {
  private bpm = INITIAL_BPM;
  private beats = 0;

  /** Once per rendered frame. `music` is the playing track's position, or null when no music is audible. */
  advance(dtSeconds: number, music: MusicPosition | null): void {
    if (music === null) {
      this.beats += (dtSeconds * this.bpm) / SECONDS_PER_MINUTE;
      return;
    }
    this.bpm = music.bpm;
    this.beats = music.beats;
  }

  get state(): Beat {
    const index = Math.floor(this.beats);
    const phase = this.beats - index;
    const inBar = ((index % BEATS_PER_BAR) + BEATS_PER_BAR) % BEATS_PER_BAR;
    const pulse = Math.exp(-phase * PULSE_SHARPNESS);
    return { bpm: this.bpm, beats: this.beats, index, phase, inBar, pulse, barPulse: inBar === 0 ? pulse : 0 };
  }
}
