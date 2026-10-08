import type { VoxelGrid } from './VoxelGrid';
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
