import type { VoxelGrid } from '../core/VoxelGrid';
import { shade } from '../core/Palette';
import { createImage, outlineImage, putPixel, scaleImage, type RgbaImage } from './image';

export interface StackOptions {
  /** View rotation around the vertical axis, in degrees. */
  angle: number;
  /** Screen pixels between consecutive layers. 1 is the classic sprite-stack look. */
  spacing: number;
  /** Vertical squash of the ground plane (1 = top-down, smaller = flatter camera). */
  squash: number;
  /** Integer upscale factor applied at the end. */
  scale: number;
  /** Outline color, or null for none. */
  outline: number | null;
  /** Darken side pixels so layers read as volume. */
  shading: boolean;
}

export const DEFAULT_STACK_OPTIONS: StackOptions = {
  angle: 0,
  spacing: 1,
  squash: 1,
  scale: 1,
  outline: null,
  shading: true,
};

/** Size of the 1x canvas used for every angle so cells line up in a sheet. */
export function stackCanvasSize(grid: VoxelGrid, opts: Pick<StackOptions, 'spacing' | 'squash'>): { w: number; h: number } {
  const diag = Math.ceil(Math.hypot(grid.sx, grid.sz)) + 2;
  const thick = Math.max(1, Math.ceil(opts.spacing));
  return { w: diag, h: Math.ceil(diag * opts.squash) + Math.ceil((grid.sy - 1) * opts.spacing) + thick + 2 };
}

/**
 * Renders a voxel grid the way sprite-stacking games do: every horizontal
 * slice is rotated and drawn on top of the previous one, shifted up by
 * `spacing` pixels. Pure software, pixel-exact, no WebGL needed.
 */
export function renderStack(grid: VoxelGrid, palette: number[], options: Partial<StackOptions> = {}): RgbaImage {
  const o = { ...DEFAULT_STACK_OPTIONS, ...options };
  const { w, h } = stackCanvasSize(grid, o);
  const img = createImage(w, h);
  const rad = (o.angle * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const cx = w / 2;
  const baseY = h - 1 - (Math.ceil(Math.hypot(grid.sx, grid.sz)) * o.squash) / 2;
  const hx = grid.sx / 2;
  const hz = grid.sz / 2;
  const reach = Math.hypot(hx, hz) + 1;
  const thick = Math.max(1, Math.ceil(o.spacing));
  for (let y = 0; y < grid.sy; y++) {
    for (let k = 0; k < thick; k++) {
      const isTop = k === thick - 1;
      const cy = baseY - y * o.spacing - k;
      const py0 = Math.max(0, Math.floor(cy - reach * o.squash));
      const py1 = Math.min(h - 1, Math.ceil(cy + reach * o.squash));
      const px0 = Math.max(0, Math.floor(cx - reach));
      const px1 = Math.min(w - 1, Math.ceil(cx + reach));
      for (let py = py0; py <= py1; py++) {
        const v = (py + 0.5 - cy) / o.squash;
        for (let px = px0; px <= px1; px++) {
          const u = px + 0.5 - cx;
          const mx = Math.floor(u * cos + v * sin + hx);
          const mz = Math.floor(-u * sin + v * cos + hz);
          if (mx < 0 || mz < 0 || mx >= grid.sx || mz >= grid.sz) continue;
          const c = grid.data[grid.index(mx, y, mz)];
          if (!c) continue;
          let color = palette[c] ?? 0xff00ff;
          if (o.shading) {
            const covered = grid.get(mx, y + 1, mz) !== 0;
            if (!isTop || covered) color = shade(color, 0.78);
          }
          putPixel(img, px, py, color);
        }
      }
    }
  }
  let out = o.outline !== null ? outlineImage(img, o.outline) : img;
  out = scaleImage(out, o.scale);
  return out;
}

/**
 * The raw slices as one strip image (layer 0 first), the input format most
 * sprite-stacking engines (GameMaker, Godot, Love2D, ...) expect.
 */
export function renderSlices(grid: VoxelGrid, palette: number[], direction: 'horizontal' | 'vertical' = 'horizontal', scale = 1): RgbaImage {
  const horiz = direction === 'horizontal';
  const img = createImage(horiz ? grid.sx * grid.sy : grid.sx, horiz ? grid.sz : grid.sz * grid.sy);
  for (let y = 0; y < grid.sy; y++) {
    const ox = horiz ? y * grid.sx : 0;
    const oy = horiz ? 0 : y * grid.sz;
    for (let z = 0; z < grid.sz; z++)
      for (let x = 0; x < grid.sx; x++) {
        const c = grid.data[grid.index(x, y, z)];
        if (c) putPixel(img, ox + x, oy + z, palette[c] ?? 0xff00ff);
      }
  }
  return scaleImage(img, scale);
}
