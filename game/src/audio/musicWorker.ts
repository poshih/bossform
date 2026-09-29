import { renderTrackSection } from './music.ts';
import type { Track } from './synth.ts';

interface RenderSectionRequest {
  readonly id: number;
  readonly track: Track;
  readonly section: number;
  readonly bars: number;
}

type WorkerRequest = RenderSectionRequest;

interface MusicWorkerScope {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: unknown, transfer: Transferable[]): void;
}

const scope = self as unknown as MusicWorkerScope;

scope.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  void renderTrackSection(request.track, request.section, request.bars).then((rendered) => {
    scope.postMessage({
      id: request.id,
      track: request.track,
      section: request.section,
      sampleRate: rendered.sampleRate,
      left: rendered.left,
      right: rendered.right,
    }, [rendered.left.buffer, rendered.right.buffer] as Transferable[]);
  });
};
