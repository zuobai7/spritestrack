import type { VoxelGrid } from './VoxelGrid';

export type V3 = [number, number, number];

/**
 * Light settings shared by the viewport, the sprite-stack renderer and the 3D
 * sprite renderer. The light is fixed relative to the camera, so when the
 * model turns (e.g. across the angles of a sprite sheet) different faces catch
 * the light and shadows move across the model.
 */
export interface LightSettings {
  enabled: boolean;
  /** Horizontal light direction relative to the viewer, degrees. 0 = from the front, -90 = from the left. */
  azimuth: number;
  /** Height of the light above the horizon, degrees (0..90). */
  elevation: number;
  /** Ambient (unlit) brightness, 0..1. */
  ambient: number;
  /** Direct light strength, 0..1+. */
  intensity: number;
  /** Voxels cast shadows onto other voxels. */
  shadows: boolean;
  /** Draw the model's shadow on the ground. */
  groundShadow: boolean;
  /** Ground shadow opacity, 0..1. */
  shadowOpacity: number;
}

export const DEFAULT_LIGHT: LightSettings = {
  enabled: true,
  azimuth: -45,
  elevation: 50,
  ambient: 0.45,
  intensity: 0.75,
  shadows: true,
  groundShadow: true,
  shadowOpacity: 0.35,
};

const DEG = Math.PI / 180;

/**
 * Converts a view-relative direction (u = screen right, v = towards the viewer)
 * into model space for a model seen at `viewAngle` degrees.
 * Matches the stack renderer: mx = u·cos + v·sin, mz = −u·sin + v·cos.
 */
export function viewToModel(u: number, v: number, viewAngle: number): [number, number] {
  const c = Math.cos(viewAngle * DEG);
  const s = Math.sin(viewAngle * DEG);
  return [u * c + v * s, -u * s + v * c];
}

/** Unit vector pointing from the model towards the light, in model space. */
export function lightDirection(light: Pick<LightSettings, 'azimuth' | 'elevation'>, viewAngle: number): V3 {
  const e = light.elevation * DEG;
  const a = light.azimuth * DEG;
  const [mx, mz] = viewToModel(Math.sin(a), Math.cos(a), viewAngle);
  return [mx * Math.cos(e), Math.sin(e), mz * Math.cos(e)];
}

/** Marches from `p` towards the light; true if a filled voxel blocks it. */
export function inShadow(grid: VoxelGrid, p: V3, l: V3): boolean {
  const step = 0.5;
  let x = p[0];
  let y = p[1];
  let z = p[2];
  const max = grid.sx + grid.sy + grid.sz;
  for (let t = 0; t < max; t += step) {
    x += l[0] * step;
    y += l[1] * step;
    z += l[2] * step;
    if (y >= grid.sy || x < -1 || z < -1 || x > grid.sx + 1 || z > grid.sz + 1) return false;
    if (grid.get(Math.floor(x), Math.floor(y), Math.floor(z))) return true;
  }
  return false;
}

/**
 * Per-pixel brightness for a voxel face seen in a sprite. Caches shadow tests
 * per (voxel, face) since many pixels share one face.
 */
export class FaceLighter {
  private cache = new Map<number, number>();
  readonly dir: V3;

  constructor(
    readonly grid: VoxelGrid,
    readonly light: LightSettings,
    viewAngle: number,
  ) {
    this.dir = lightDirection(light, viewAngle);
  }

  /** `face`: 0..5 = +x, -x, +y, -y, +z, -z. */
  brightness(x: number, y: number, z: number, face: number): number {
    const key = this.grid.index(x, y, z) * 6 + face;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    const n = FACE_NORMALS[face];
    const l = this.dir;
    const ndotl = Math.max(0, n[0] * l[0] + n[1] * l[1] + n[2] * l[2]);
    let direct = ndotl;
    if (direct > 0 && this.light.shadows) {
      const p: V3 = [x + 0.5 + n[0] * 0.51, y + 0.5 + n[1] * 0.51, z + 0.5 + n[2] * 0.51];
      if (inShadow(this.grid, p, l)) direct = 0;
    }
    const b = this.light.ambient + this.light.intensity * direct;
    this.cache.set(key, b);
    return b;
  }
}

export const FACE_NORMALS: V3[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

/**
 * Which side face of a voxel a viewer at `viewAngle` sees: the exposed
 * horizontal face that points most towards the viewer. Returns -1 if none of
 * the side faces is exposed (the pixel shows an inner face).
 */
export function visibleSideFace(grid: VoxelGrid, x: number, y: number, z: number, viewAngle: number): number {
  const [vx, vz] = viewToModel(0, 1, viewAngle);
  let best = -1;
  let bestDot = -Infinity;
  const sides: [number, number, number][] = [
    [0, 1, 0],
    [1, -1, 0],
    [4, 0, 1],
    [5, 0, -1],
  ];
  for (const [face, dx, dz] of sides) {
    if (grid.get(x + dx, y, z + dz)) continue;
    const d = dx * vx + dz * vz;
    if (d > bestDot) {
      bestDot = d;
      best = face;
    }
  }
  return best;
}
