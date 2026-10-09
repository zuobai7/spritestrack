import { VoxelGrid } from './VoxelGrid';
import type { Vec3 } from './raycast';

/** Returns the cell plus its mirror images for the enabled symmetry axes. */
export function mirrored(grid: VoxelGrid, c: Vec3, mirror: { x: boolean; y: boolean; z: boolean }): Vec3[] {
  let out: Vec3[] = [c];
  const axes: [boolean, number, number][] = [
    [mirror.x, 0, grid.sx],
    [mirror.y, 1, grid.sy],
    [mirror.z, 2, grid.sz],
  ];
  for (const [on, a, size] of axes) {
    if (!on) continue;
    const next: Vec3[] = [];
    for (const p of out) {
      next.push(p);
      const q: Vec3 = [p[0], p[1], p[2]];
      q[a] = size - 1 - p[a];
      if (q[a] !== p[a]) next.push(q);
    }
    out = next;
  }
  return out;
}

/** All cells of the inclusive box between two corners. */
export function boxCells(a: Vec3, b: Vec3): Vec3[] {
  const out: Vec3[] = [];
  const [x0, x1] = [Math.min(a[0], b[0]), Math.max(a[0], b[0])];
  const [y0, y1] = [Math.min(a[1], b[1]), Math.max(a[1], b[1])];
  const [z0, z1] = [Math.min(a[2], b[2]), Math.max(a[2], b[2])];
  for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) out.push([x, y, z]);
  return out;
}

/** Cells on a 3D line between two cells (inclusive), using a simple supercover-free DDA. */
export function lineCells(a: Vec3, b: Vec3): Vec3[] {
  const n = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]), Math.abs(b[2] - a[2]));
  if (n === 0) return [[a[0], a[1], a[2]]];
  const out: Vec3[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    out.push([
      Math.round(a[0] + (b[0] - a[0]) * t),
      Math.round(a[1] + (b[1] - a[1]) * t),
      Math.round(a[2] + (b[2] - a[2]) * t),
    ]);
  }
  return out;
}

/**
 * 3D flood fill: cells 6-connected to `start` that share its value.
 * When `layerOnly` is set the fill stays on the start cell's y layer (2D fill).
 */
export function floodCells(grid: VoxelGrid, start: Vec3, layerOnly: boolean, limit = 1 << 20): Vec3[] {
  const target = grid.get(start[0], start[1], start[2]);
  const seen = new Uint8Array(grid.data.length);
  const out: Vec3[] = [];
  const stack: Vec3[] = [start];
  const dirs: Vec3[] = layerOnly
    ? [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]
    : [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  while (stack.length && out.length < limit) {
    const c = stack.pop()!;
    if (!grid.inBounds(c[0], c[1], c[2])) continue;
    const i = grid.index(c[0], c[1], c[2]);
    if (seen[i] || grid.data[i] !== target) continue;
    seen[i] = 1;
    out.push(c);
    for (const d of dirs) stack.push([c[0] + d[0], c[1] + d[1], c[2] + d[2]]);
  }
  return out;
}

/**
 * Cells 6-connected to `start` whose value passes `inside`, as a mask over
 * the grid's cells (1 = part of the area). Unlike `floodCells` it has no size
 * limit, so it suits whole-model operations on large grids.
 */
export function floodMask(grid: VoxelGrid, start: Vec3, inside: (v: number) => boolean): Uint8Array {
  const mask = new Uint8Array(grid.data.length);
  if (!grid.inBounds(start[0], start[1], start[2])) return mask;
  const first = grid.index(start[0], start[1], start[2]);
  if (!inside(grid.data[first])) return mask;
  const { sx, sy, sz } = grid;
  const row = sx;
  const layer = sx * sz;
  const stack = [first];
  mask[first] = 1;
  const visit = (i: number) => {
    if (!mask[i] && inside(grid.data[i])) {
      mask[i] = 1;
      stack.push(i);
    }
  };
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % sx;
    const z = Math.floor(i / row) % sz;
    const y = Math.floor(i / layer);
    if (x > 0) visit(i - 1);
    if (x < sx - 1) visit(i + 1);
    if (z > 0) visit(i - row);
    if (z < sz - 1) visit(i + row);
    if (y > 0) visit(i - layer);
    if (y < sy - 1) visit(i + layer);
  }
  return mask;
}

/**
 * Surface fill: recolors the connected region of same-colored voxels that are
 * visible from the same side as the clicked face (like a paint bucket on the
 * model's surface).
 */
export function surfaceFillCells(grid: VoxelGrid, start: Vec3, normal: Vec3): Vec3[] {
  const target = grid.get(start[0], start[1], start[2]);
  if (!target) return [];
  const exposed = (c: Vec3) => !grid.get(c[0] + normal[0], c[1] + normal[1], c[2] + normal[2]);
  const seen = new Set<number>();
  const out: Vec3[] = [];
  const stack: Vec3[] = [start];
  const axis = normal[0] ? 0 : normal[1] ? 1 : 2;
  const dirs: Vec3[] = [];
  for (let a = 0; a < 3; a++) {
    if (a === axis) continue;
    const d1: Vec3 = [0, 0, 0];
    d1[a] = 1;
    const d2: Vec3 = [0, 0, 0];
    d2[a] = -1;
    dirs.push(d1, d2);
  }
  while (stack.length) {
    const c = stack.pop()!;
    if (!grid.inBounds(c[0], c[1], c[2])) continue;
    const i = grid.index(c[0], c[1], c[2]);
    if (seen.has(i) || grid.data[i] !== target || !exposed(c)) continue;
    seen.add(i);
    out.push(c);
    for (const d of dirs) stack.push([c[0] + d[0], c[1] + d[1], c[2] + d[2]]);
  }
  return out;
}

export type BrushShape = 'cube' | 'sphere';

/**
 * Cells covered by a brush of `size` voxels (diameter) centered on `c`.
 * With `flatAxis` set the brush is a 2D square/disc on that axis's plane
 * (used when drawing on a single layer).
 */
export function brushCells(c: Vec3, size: number, shape: BrushShape, flatAxis: number | null = null): Vec3[] {
  const n = Math.max(1, Math.floor(size));
  if (n === 1) return [[c[0], c[1], c[2]]];
  const lo = -Math.floor((n - 1) / 2);
  const hi = Math.ceil((n - 1) / 2);
  const mid = (lo + hi) / 2;
  const r2 = (n / 2) * (n / 2) + 1e-6;
  const out: Vec3[] = [];
  const range = (a: number) => (flatAxis === a ? [0] : Array.from({ length: hi - lo + 1 }, (_, i) => lo + i));
  for (const dy of range(1))
    for (const dz of range(2))
      for (const dx of range(0)) {
        if (shape === 'sphere') {
          const ex = flatAxis === 0 ? 0 : dx - mid;
          const ey = flatAxis === 1 ? 0 : dy - mid;
          const ez = flatAxis === 2 ? 0 : dz - mid;
          if (ex * ex + ey * ey + ez * ez > r2) continue;
        }
        out.push([c[0] + dx, c[1] + dy, c[2] + dz]);
      }
  return out;
}

export interface Box {
  min: Vec3;
  max: Vec3;
}

export function normBox(a: Vec3, b: Vec3): Box {
  return {
    min: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])],
    max: [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])],
  };
}

/** Clamps a box to the grid; returns null if nothing is left. */
export function clampBox(grid: VoxelGrid, b: Box): Box | null {
  const min: Vec3 = [Math.max(0, b.min[0]), Math.max(0, b.min[1]), Math.max(0, b.min[2])];
  const max: Vec3 = [Math.min(grid.sx - 1, b.max[0]), Math.min(grid.sy - 1, b.max[1]), Math.min(grid.sz - 1, b.max[2])];
  return min[0] > max[0] || min[1] > max[1] || min[2] > max[2] ? null : { min, max };
}

/** Copies a box out of a grid. */
export function copyRegion(grid: VoxelGrid, b: Box): VoxelGrid {
  const out = new VoxelGrid(b.max[0] - b.min[0] + 1, b.max[1] - b.min[1] + 1, b.max[2] - b.min[2] + 1);
  for (let y = 0; y < out.sy; y++)
    for (let z = 0; z < out.sz; z++)
      for (let x = 0; x < out.sx; x++) out.data[out.index(x, y, z)] = grid.get(b.min[0] + x, b.min[1] + y, b.min[2] + z);
  return out;
}

/** Writes the filled cells of `clip` into `grid` with its corner at `at`. */
export function pasteRegion(grid: VoxelGrid, clip: VoxelGrid, at: Vec3): void {
  for (let y = 0; y < clip.sy; y++)
    for (let z = 0; z < clip.sz; z++)
      for (let x = 0; x < clip.sx; x++) {
        const v = clip.data[clip.index(x, y, z)];
        if (v) grid.set(at[0] + x, at[1] + y, at[2] + z, v);
      }
}

export function fillRegion(grid: VoxelGrid, b: Box, v: number): void {
  for (let y = b.min[1]; y <= b.max[1]; y++)
    for (let z = b.min[2]; z <= b.max[2]; z++) for (let x = b.min[0]; x <= b.max[0]; x++) grid.set(x, y, z, v);
}

/** Flips the content of a box in place. */
export function flipRegion(grid: VoxelGrid, b: Box, axis: 0 | 1 | 2): void {
  const clip = copyRegion(grid, b);
  clip.flip(axis === 0 ? 'x' : axis === 1 ? 'y' : 'z');
  fillRegion(grid, b, 0);
  pasteRegion(grid, clip, b.min);
}

/** Tight box around the filled cells inside `b` (or null if empty). */
export function shrinkToContent(grid: VoxelGrid, b: Box): Box | null {
  const sub = copyRegion(grid, b);
  const bb = sub.bounds();
  if (!bb) return null;
  return {
    min: [b.min[0] + bb.min[0], b.min[1] + bb.min[1], b.min[2] + bb.min[2]],
    max: [b.min[0] + bb.max[0], b.min[1] + bb.max[1], b.min[2] + bb.max[2]],
  };
}
