import type { VoxelGrid } from './VoxelGrid';

export type Vec3 = [number, number, number];

export interface VoxelHit {
  /** The filled voxel that was hit. */
  voxel: Vec3;
  /** Face normal of the hit (unit axis vector). */
  normal: Vec3;
  /** Distance along the ray. */
  t: number;
}

/**
 * Walks the grid along a ray (Amanatides & Woo DDA) in grid space, where voxel
 * (x,y,z) spans [x,x+1]×[y,y+1]×[z,z+1]. Returns the first filled voxel whose
 * y is <= `maxY`.
 */
export function raycastGrid(grid: VoxelGrid, origin: Vec3, dir: Vec3, maxY = Infinity, maxT = 1e4): VoxelHit | null {
  const size: Vec3 = [grid.sx, grid.sy, grid.sz];
  // Clip the ray to the grid box first
  let tmin = 0;
  let tmax = maxT;
  let enterAxis = -1;
  for (let a = 0; a < 3; a++) {
    if (Math.abs(dir[a]) < 1e-12) {
      if (origin[a] < 0 || origin[a] > size[a]) return null;
      continue;
    }
    let t0 = (0 - origin[a]) / dir[a];
    let t1 = (size[a] - origin[a]) / dir[a];
    if (t0 > t1) [t0, t1] = [t1, t0];
    if (t0 > tmin) {
      tmin = t0;
      enterAxis = a;
    }
    if (t1 < tmax) tmax = t1;
    if (tmin > tmax) return null;
  }
  const eps = 1e-7;
  const p: Vec3 = [origin[0] + dir[0] * (tmin + eps), origin[1] + dir[1] * (tmin + eps), origin[2] + dir[2] * (tmin + eps)];
  const cell: Vec3 = [0, 0, 0];
  const step: Vec3 = [0, 0, 0];
  const tDelta: Vec3 = [Infinity, Infinity, Infinity];
  const tNext: Vec3 = [Infinity, Infinity, Infinity];
  for (let a = 0; a < 3; a++) {
    cell[a] = Math.min(size[a] - 1, Math.max(0, Math.floor(p[a])));
    if (dir[a] > 0) {
      step[a] = 1;
      tDelta[a] = 1 / dir[a];
      tNext[a] = (cell[a] + 1 - origin[a]) / dir[a];
    } else if (dir[a] < 0) {
      step[a] = -1;
      tDelta[a] = -1 / dir[a];
      tNext[a] = (cell[a] - origin[a]) / dir[a];
    }
  }
  let normal: Vec3 = [0, 0, 0];
  if (enterAxis >= 0) normal[enterAxis] = -Math.sign(dir[enterAxis]);
  let t = tmin;
  for (let guard = 0; guard < 10000; guard++) {
    if (!grid.inBounds(cell[0], cell[1], cell[2])) return null;
    if (cell[1] <= maxY && grid.get(cell[0], cell[1], cell[2])) {
      return { voxel: [cell[0], cell[1], cell[2]], normal, t };
    }
    let a = 0;
    if (tNext[1] < tNext[a]) a = 1;
    if (tNext[2] < tNext[a]) a = 2;
    t = tNext[a];
    if (t > tmax + eps) return null;
    cell[a] += step[a];
    tNext[a] += tDelta[a];
    normal = [0, 0, 0];
    normal[a] = -step[a];
  }
  return null;
}

/**
 * Intersects a ray with the horizontal plane y = `planeY` (grid space). Returns
 * the cell coordinates at that height, or null if the ray misses or the cell is
 * outside the grid footprint.
 */
export function raycastPlaneY(grid: VoxelGrid, origin: Vec3, dir: Vec3, planeY: number): Vec3 | null {
  if (Math.abs(dir[1]) < 1e-9) return null;
  const t = (planeY - origin[1]) / dir[1];
  if (t <= 0) return null;
  const x = Math.floor(origin[0] + dir[0] * t);
  const z = Math.floor(origin[2] + dir[2] * t);
  if (x < 0 || z < 0 || x >= grid.sx || z >= grid.sz) return null;
  return [x, Math.floor(planeY), z];
}

/** Intersects a ray with an axis-aligned plane (`axis` = 0/1/2, at coordinate `level` + 0.5 cell center). */
export function raycastAxisPlane(grid: VoxelGrid, origin: Vec3, dir: Vec3, axis: number, level: number): Vec3 | null {
  const plane = level + 0.5;
  if (Math.abs(dir[axis]) < 1e-9) return null;
  const t = (plane - origin[axis]) / dir[axis];
  if (t <= 0) return null;
  const c: Vec3 = [0, 0, 0];
  for (let a = 0; a < 3; a++) c[a] = a === axis ? level : Math.floor(origin[a] + dir[a] * t);
  return grid.inBounds(c[0], c[1], c[2]) ? c : null;
}
