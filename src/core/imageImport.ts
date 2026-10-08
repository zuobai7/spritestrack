import { VoxelGrid } from './VoxelGrid';
import { MAX_COLORS, nearestIndex } from './Palette';
import type { RgbaImage } from '../export/image';

/**
 * Turning 2D images into voxels: slice strips (the sprite-stacking format),
 * extruded pixel art, and heightmaps. Images larger than `maxSize` are
 * downscaled with nearest-neighbor sampling first.
 */

export const MAX_AXIS = 256;

/** Maps image colors to palette indices, adding new colors while there is room. */
export class ColorMapper {
  private cache = new Map<number, number>();
  constructor(
    readonly palette: number[],
    readonly addColors: boolean,
  ) {}

  map(color: number): number {
    const c = color & 0xffffff;
    const hit = this.cache.get(c);
    if (hit !== undefined) return hit;
    let idx = this.palette.indexOf(c, 1);
    if (idx < 0) {
      if (this.addColors && this.palette.length <= MAX_COLORS) {
        this.palette.push(c);
        idx = this.palette.length - 1;
      } else idx = nearestIndex(this.palette, c);
    }
    this.cache.set(c, idx);
    return idx;
  }
}

function pixel(img: RgbaImage, x: number, y: number): { color: number; alpha: number } {
  const i = (y * img.width + x) * 4;
  return { color: (img.data[i] << 16) | (img.data[i + 1] << 8) | img.data[i + 2], alpha: img.data[i + 3] };
}

/** Nearest-neighbor downscale so neither side exceeds `max`. */
export function fitImage(img: RgbaImage, max: number): RgbaImage {
  const s = Math.min(1, max / img.width, max / img.height);
  if (s >= 1) return img;
  const w = Math.max(1, Math.floor(img.width * s));
  const h = Math.max(1, Math.floor(img.height * s));
  const out: RgbaImage = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.width - 1, Math.floor((x + 0.5) / s));
      const sy = Math.min(img.height - 1, Math.floor((y + 0.5) / s));
      out.data.set(img.data.subarray((sy * img.width + sx) * 4, (sy * img.width + sx) * 4 + 4), (y * w + x) * 4);
    }
  return out;
}

/**
 * Slice strip → model. Slice 0 is the bottom layer. Each slice is a top-down
 * view (x right, z down).
 */
export function importSliceStrip(img: RgbaImage, slices: number, direction: 'horizontal' | 'vertical', mapper: ColorMapper): VoxelGrid {
  const n = Math.max(1, Math.floor(slices));
  const horiz = direction === 'horizontal';
  const sw = horiz ? Math.floor(img.width / n) : img.width;
  const sh = horiz ? img.height : Math.floor(img.height / n);
  if (sw < 1 || sh < 1) throw new Error('Image is too small for that many slices');
  const sx = Math.min(MAX_AXIS, sw);
  const sz = Math.min(MAX_AXIS, sh);
  const sy = Math.min(MAX_AXIS, n);
  const g = new VoxelGrid(sx, sy, sz);
  for (let y = 0; y < sy; y++)
    for (let z = 0; z < sz; z++)
      for (let x = 0; x < sx; x++) {
        const px = horiz ? y * sw + x : x;
        const py = horiz ? z : y * sh + z;
        const p = pixel(img, px, py);
        if (p.alpha >= 128) g.set(x, y, z, mapper.map(p.color));
      }
  return g;
}

/** Pixel art → solid model `depth` voxels thick. 'front': image on the XY plane; 'top': on the XZ plane. */
export function importExtrude(img: RgbaImage, depth: number, orientation: 'front' | 'top', mapper: ColorMapper): VoxelGrid {
  const d = Math.max(1, Math.min(MAX_AXIS, Math.floor(depth)));
  const w = Math.min(MAX_AXIS, img.width);
  const h = Math.min(MAX_AXIS, img.height);
  const g = orientation === 'front' ? new VoxelGrid(w, h, d) : new VoxelGrid(w, d, h);
  for (let py = 0; py < h; py++)
    for (let px = 0; px < w; px++) {
      const p = pixel(img, px, py);
      if (p.alpha < 128) continue;
      const c = mapper.map(p.color);
      for (let k = 0; k < d; k++) {
        if (orientation === 'front') g.set(px, h - 1 - py, k, c);
        else g.set(px, k, py, c);
      }
    }
  return g;
}

/**
 * Heightmap → terrain. Brightness sets the column height (1..maxHeight).
 * `colorFrom`: 'image' keeps each pixel's color, otherwise `color` is used.
 */
export function importHeightmap(img: RgbaImage, maxHeight: number, mapper: ColorMapper, colorFrom: 'image' | 'single', color = 1): VoxelGrid {
  const w = Math.min(MAX_AXIS, img.width);
  const h = Math.min(MAX_AXIS, img.height);
  const H = Math.max(1, Math.min(MAX_AXIS, Math.floor(maxHeight)));
  const g = new VoxelGrid(w, H, h);
  for (let z = 0; z < h; z++)
    for (let x = 0; x < w; x++) {
      const p = pixel(img, x, z);
      if (p.alpha < 128) continue;
      const r = (p.color >> 16) & 255;
      const gg = (p.color >> 8) & 255;
      const b = p.color & 255;
      const lum = (0.299 * r + 0.587 * gg + 0.114 * b) / 255;
      const top = Math.max(1, Math.round(lum * H));
      const c = colorFrom === 'image' ? mapper.map(p.color) : color;
      for (let y = 0; y < top; y++) g.set(x, y, z, c);
    }
  return g;
}
