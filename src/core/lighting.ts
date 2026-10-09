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

/**
 * Marches from `p` towards the light; true if a filled voxel blocks it. Only
 * the stretch of the ray inside the model's box is walked, so points far out
 * on the ground still find the model between them and the light.
 */
export function inShadow(grid: VoxelGrid, p: V3, l: V3): boolean {
  const size = [grid.sx, grid.sy, grid.sz];
  let t0 = 0;
  let t1 = Infinity;
  for (let a = 0; a < 3; a++) {
    if (Math.abs(l[a]) < 1e-9) {
      if (p[a] < 0 || p[a] > size[a]) return false;
      continue;
    }
    let ta = -p[a] / l[a];
    let tb = (size[a] - p[a]) / l[a];
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta);
    t1 = Math.min(t1, tb);
    if (t0 > t1) return false;
  }
  const step = 0.5;
  for (let t = Math.max(t0, step); t <= t1 + step; t += step) {
    if (grid.get(Math.floor(p[0] + l[0] * t), Math.floor(p[1] + l[1] * t), Math.floor(p[2] + l[2] * t))) return true;
  }
  return false;
}

/**
 * How far (in voxels, along the ground) the ground shadow of a model `sy`
 * voxels tall can reach past the model, capped at three times its height.
 * Zero when there is no ground shadow.
 */
export function shadowReach(sy: number, light: Pick<LightSettings, 'enabled' | 'groundShadow' | 'elevation'> | null): number {
  if (!light || !light.enabled || !light.groundShadow) return 0;
  const e = Math.max(1, Math.min(90, light.elevation)) * DEG;
  return Math.min(3 * sy, sy / Math.tan(e));
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
