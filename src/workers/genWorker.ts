import { runGenerator, scriptGenerator, type ParamValues } from '../core/procedural';
import { VoxelGrid } from '../core/VoxelGrid';

/**
 * Runs user generator scripts off the main thread, so a slow or endless
 * script can be stopped (the page terminates the worker) instead of freezing
 * the editor.
 */

export interface GenFrameSpec {
  t: number;
  frame: number;
  frameCount: number;
}

export interface GenRequest {
  id: number;
  source: string;
  params: ParamValues;
  size: [number, number, number];
  palette: number[];
  seed: number;
  frames: GenFrameSpec[];
  /** Current frame content for "merge". */
  base?: Uint8Array;
}

export interface GenResponse {
  id: number;
  grids?: Uint8Array[];
  palette?: number[];
  error?: string;
}

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<GenRequest>) => void) | null;
  postMessage(msg: GenResponse, transfer?: Transferable[]): void;
};

scope.onmessage = (e) => {
  const r = e.data;
  try {
    const gen = scriptGenerator(r.source);
    const palette = r.palette.slice();
    let base: VoxelGrid | undefined;
    if (r.base) {
      base = new VoxelGrid(r.size[0], r.size[1], r.size[2]);
      base.data.set(r.base);
    }
    const grids = r.frames.map((f) => runGenerator(gen, r.params, r.size, palette, { seed: r.seed, ...f, base }).data);
    scope.postMessage({ id: r.id, grids, palette }, grids.map((g) => g.buffer));
  } catch (err) {
    scope.postMessage({ id: r.id, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
  }
};
