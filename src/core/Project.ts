import { VoxelGrid } from './VoxelGrid';
import { makePalette } from './Palette';
import type { Rig } from './rig';

export interface Animation {
  name: string;
  fps: number;
  frames: VoxelGrid[];
}

/** A named palette. Voxels store palette indices, so swapping palettes recolors the whole model. */
export interface PaletteVariant {
  name: string;
  palette: number[];
}

/**
 * A SpriteStrack document: one model size shared by every frame, one palette,
 * and a list of named animations. Each animation is a list of frames; each
 * frame is a full voxel grid. The first animation's first frame is the "base"
 * model.
 */
export class Project {
  name: string;
  sx: number;
  sy: number;
  sz: number;
  animations: Animation[];
  /** All palettes (color schemes). `palette` is the active one. */
  variants: PaletteVariant[];
  activeVariant = 0;
  /** Part-based skeletal animation setup, or null if the model isn't rigged. */
  rig: Rig | null = null;

  constructor(sx = 16, sy = 16, sz = 16, name = 'untitled') {
    this.name = name;
    this.sx = sx;
    this.sy = sy;
    this.sz = sz;
    this.variants = [{ name: 'default', palette: makePalette() }];
    this.animations = [{ name: 'idle', fps: 8, frames: [new VoxelGrid(sx, sy, sz)] }];
  }

  /** The active palette. Element i is the color of palette index i (element 0 unused). */
  get palette(): number[] {
    return this.variants[this.activeVariant].palette;
  }

  set palette(p: number[]) {
    this.variants[this.activeVariant].palette = p;
  }

  /**
   * Palette of variant `i`, with indices it lacks filled from the active
   * palette, so every voxel index resolves to a color.
   */
  variantPalette(i: number): number[] {
    const base = this.palette;
    const v = this.variants[i]?.palette ?? base;
    return base.map((c, k) => (k < v.length ? v[k] : c));
  }

  /** Resizes every frame of every animation (and the rig's part map). */
  resize(sx: number, sy: number, sz: number, anchor: 'corner' | 'center' = 'center'): void {
    for (const anim of this.animations) anim.frames = anim.frames.map((f) => f.resized(sx, sy, sz, anchor));
    if (this.rig) {
      const ox = anchor === 'center' ? Math.floor((sx - this.sx) / 2) : 0;
      const oz = anchor === 'center' ? Math.floor((sz - this.sz) / 2) : 0;
      this.rig.partMap = this.rig.partMap.resized(sx, sy, sz, anchor);
      for (const p of this.rig.parts) p.pivot = [p.pivot[0] + ox, p.pivot[1], p.pivot[2] + oz];
    }
    this.sx = sx;
    this.sy = sy;
    this.sz = sz;
  }

  frameCount(): number {
    return this.animations.reduce((n, a) => n + a.frames.length, 0);
  }
}

/** A small demo model so the editor doesn't open on an empty grid. */
export function createDemoProject(): Project {
  const p = new Project(16, 16, 16, 'demo');
  const g = p.animations[0].frames[0];
  // Grass block base
  for (let x = 2; x < 14; x++)
    for (let z = 2; z < 14; z++) {
      g.set(x, 0, z, 6); // soil
      g.set(x, 1, z, 5);
      g.set(x, 2, z, 13); // grass
    }
  // Tree trunk
  for (let y = 3; y < 8; y++) for (let x = 7; x < 9; x++) for (let z = 7; z < 9; z++) g.set(x, y, z, 6);
  // Canopy
  for (let y = 7; y < 13; y++)
    for (let x = 3; x < 13; x++)
      for (let z = 3; z < 13; z++) {
        const dx = x - 7.5;
        const dy = (y - 9.5) * 1.2;
        const dz = z - 7.5;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        // Darker leaves inside; the flat top layer stays light so no dark patch shows
        if (d < 4.6) g.set(x, y, z, d < 3.2 && y < 12 ? 14 : 13);
      }
  // A few apples
  g.set(4, 9, 7, 9);
  g.set(10, 10, 5, 9);
  g.set(7, 11, 11, 9);
  // Second animation: the tree sways (canopy shifts one voxel)
  const f1 = g.clone();
  const f2 = g.clone();
  for (let y = 9; y < 14; y++)
    for (let z = 0; z < 16; z++) {
      for (let x = 15; x > 0; x--) f1.set(x, y, z, g.get(x - 1, y, z));
      f1.set(0, y, z, 0);
      for (let x = 0; x < 15; x++) f2.set(x, y, z, g.get(x + 1, y, z));
      f2.set(15, y, z, 0);
    }
  p.animations.push({ name: 'sway', fps: 4, frames: [g.clone(), f1, g.clone(), f2] });
  return p;
}
