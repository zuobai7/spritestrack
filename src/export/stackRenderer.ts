import type { VoxelGrid } from '../core/VoxelGrid';
import { shade } from '../core/Palette';
import { FACE_NORMALS, FaceLighter, inShadow, lightDirection, visibleSideFace, type LightSettings } from '../core/lighting';
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
  /** Darken side pixels so layers read as volume (used when `light` is off). */
  shading: boolean;
  /** Directional light fixed to the camera; faces and shadows change with `angle`. */
  light: LightSettings | null;
  /** Extra transparent pixels around the sprite (room for ground shadows). */
  padding: number;
  /**
   * 'color' = the sprite; 'normal' = screen-space normal map (x right, y up,
   * z towards the viewer, OpenGL convention); 'depth' = white is near.
   */
  pass: 'color' | 'normal' | 'depth';
}

export type RenderPass = StackOptions['pass'];

export const DEFAULT_STACK_OPTIONS: StackOptions = {
  angle: 0,
  spacing: 1,
  squash: 1,
  scale: 1,
  outline: null,
  shading: true,
  light: null,
  padding: 0,
  pass: 'color',
};

/** Size of the 1x canvas used for every angle so cells line up in a sheet. */
export function stackCanvasSize(
  grid: VoxelGrid,
  opts: Pick<StackOptions, 'spacing' | 'squash'> & { padding?: number },
): { w: number; h: number } {
  const diag = Math.ceil(Math.hypot(grid.sx, grid.sz)) + 2;
  const thick = Math.max(1, Math.ceil(opts.spacing));
  const pad = Math.max(0, Math.floor(opts.padding ?? 0));
  return {
    w: diag + pad * 2,
    h: Math.ceil(diag * opts.squash) + Math.ceil((grid.sy - 1) * opts.spacing) + thick + 2 + pad * 2,
  };
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
  const baseY = h - 1 - Math.max(0, Math.floor(o.padding)) - (Math.ceil(Math.hypot(grid.sx, grid.sz)) * o.squash) / 2;
  const hx = grid.sx / 2;
  const hz = grid.sz / 2;
  const reach = Math.hypot(hx, hz) + 1;
  const thick = Math.max(1, Math.ceil(o.spacing));
  const pass = o.pass;
  const light = pass === 'color' && o.light && o.light.enabled ? o.light : null;
  const lighter = light ? new FaceLighter(grid, light, o.angle) : null;
  // Effective camera elevation of the stack projection (ground squash vs layer height)
  const elev = Math.atan2(o.squash, Math.max(1e-6, o.spacing));
  const ce = Math.cos(elev);
  const se = Math.sin(elev);
  const R = Math.hypot(hx, hz);
  const dMin = -R * ce;
  const dMax = grid.sy * se + R * ce;

  if (light && light.groundShadow) {
    // Shadow on the ground plane (y = 0): march from each ground point towards the light
    const l = lightDirection(light, o.angle);
    const alpha = Math.round(255 * Math.max(0, Math.min(1, light.shadowOpacity)));
    for (let py = 0; py < h; py++) {
      const v = (py + 0.5 - baseY) / o.squash;
      for (let px = 0; px < w; px++) {
        const u = px + 0.5 - cx;
        const gx = u * cos + v * sin + hx;
        const gz = -u * sin + v * cos + hz;
        if (gx < -grid.sy * 2 || gz < -grid.sy * 2 || gx > grid.sx + grid.sy * 2 || gz > grid.sz + grid.sy * 2) continue;
        if (inShadow(grid, [gx, 0.01, gz], l)) putPixel(img, px, py, 0x000000, alpha);
      }
    }
  }

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
          let color: number;
          if (pass === 'depth') {
            const vv = (mx + 0.5 - hx) * sin + (mz + 0.5 - hz) * cos;
            const d = (y + (k + 0.5) / thick) * se + vv * ce;
            const g = Math.round(255 * Math.max(0, Math.min(1, (d - dMin) / (dMax - dMin))));
            color = (g << 16) | (g << 8) | g;
          } else if (pass === 'normal' || lighter) {
            const covered = grid.get(mx, y + 1, mz) !== 0;
            let face = isTop && !covered ? 2 : visibleSideFace(grid, mx, y, mz, o.angle);
            if (face < 0 && !covered) face = 2;
            if (pass === 'normal') {
              let n: [number, number, number];
              if (face >= 0) n = FACE_NORMALS[face];
              else n = [sin, 0, cos]; // inner pixel: face the viewer
              const nu = n[0] * cos - n[2] * sin;
              const nv = n[0] * sin + n[2] * cos;
              const sxn = nu;
              const syn = n[1] * ce - nv * se;
              const szn = n[1] * se + nv * ce;
              const enc = (t: number) => Math.round(((t + 1) / 2) * 255);
              color = (enc(sxn) << 16) | (enc(syn) << 8) | enc(szn);
            } else {
              const b = face < 0 ? lighter!.light.ambient : lighter!.brightness(mx, y, mz, face);
              color = shade(palette[c] ?? 0xff00ff, b);
            }
          } else {
            color = palette[c] ?? 0xff00ff;
            if (o.shading) {
              const covered = grid.get(mx, y + 1, mz) !== 0;
              if (!isTop || covered) color = shade(color, 0.78);
            }
          }
          putPixel(img, px, py, color);
        }
      }
    }
  }
  const outline = o.outline === null ? null : pass === 'normal' ? 0x8080ff : pass === 'depth' ? 0x000000 : o.outline;
  let out = outline !== null ? outlineImage(img, outline) : img;
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
