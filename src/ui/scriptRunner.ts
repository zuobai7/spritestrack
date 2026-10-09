import type { GenFrameSpec, GenRequest, GenResponse } from '../workers/genWorker';
import type { ParamValues } from '../core/procedural';
import { VoxelGrid } from '../core/VoxelGrid';

export class ScriptTimeoutError extends Error {}

/**
 * Runs generator scripts in a worker. A run that takes longer than
 * `timeoutMs` kills the worker (an endless loop can't block the editor), and
 * starting a run cancels any earlier one that hasn't finished.
 */
export class ScriptRunner {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (r: GenResponse) => void; reject: (e: Error) => void; timer: number }>();

  constructor(private timeoutMs = 5000) {}

  private ensure(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(new URL('../workers/genWorker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<GenResponse>) => {
      const p = this.pending.get(e.data.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(e.data.id);
      p.resolve(e.data);
    };
    this.worker = w;
    return w;
  }

  async run(
    source: string,
    opts: {
      params?: ParamValues;
      size: [number, number, number];
      palette: number[];
      seed: number;
      frames: GenFrameSpec[];
      base?: VoxelGrid;
      timeoutMs?: number;
    },
  ): Promise<{ grids: VoxelGrid[]; palette: number[] }> {
    // Only the newest run matters. An older one still running (maybe stuck in
    // an endless loop the user just fixed) is cancelled instead of making
    // this one wait behind it and then time out with it.
    if (this.pending.size) this.kill();
    const w = this.ensure();
    const id = this.nextId++;
    const req: GenRequest = {
      id,
      source,
      params: opts.params ?? {},
      size: opts.size,
      palette: opts.palette,
      seed: opts.seed,
      frames: opts.frames,
      base: opts.base?.data.slice(),
    };
    const res = await new Promise<GenResponse>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        this.kill();
        reject(new ScriptTimeoutError('timeout'));
      }, opts.timeoutMs ?? this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      w.postMessage(req);
    });
    if (res.error || !res.grids || !res.palette) throw new Error(res.error ?? 'no result');
    const [sx, sy, sz] = opts.size;
    const grids = res.grids.map((d) => {
      const g = new VoxelGrid(sx, sy, sz);
      g.data.set(d);
      return g;
    });
    return { grids, palette: res.palette };
  }

  /** Stops the worker; later runs start a fresh one. */
  kill(): void {
    this.worker?.terminate();
    this.worker = null;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('cancelled'));
    }
    this.pending.clear();
  }
}
