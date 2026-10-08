/**
 * A dense voxel grid. Each cell stores a palette index (0 = empty, 1..255 = color).
 *
 * Coordinates: x to the right, y up, z towards the viewer. Data is laid out
 * layer by layer along y, so one horizontal slice is a contiguous block of
 * `sx * sz` cells. That makes slice-based work (layer editing, sprite stacking)
 * cheap.
 */
export class VoxelGrid {
  readonly sx: number;
  readonly sy: number;
  readonly sz: number;
  readonly data: Uint8Array;

  constructor(sx: number, sy: number, sz: number, data?: Uint8Array) {
    if (sx < 1 || sy < 1 || sz < 1) throw new Error(`Invalid grid size ${sx}x${sy}x${sz}`);
    this.sx = sx;
    this.sy = sy;
    this.sz = sz;
    const n = sx * sy * sz;
    if (data && data.length !== n) throw new Error(`Data length ${data.length} != ${n}`);
    this.data = data ?? new Uint8Array(n);
  }

  index(x: number, y: number, z: number): number {
    return x + this.sx * (z + this.sz * y);
  }

  inBounds(x: number, y: number, z: number): boolean {
    return x >= 0 && y >= 0 && z >= 0 && x < this.sx && y < this.sy && z < this.sz;
  }

  get(x: number, y: number, z: number): number {
    if (!this.inBounds(x, y, z)) return 0;
    return this.data[this.index(x, y, z)];
  }

  set(x: number, y: number, z: number, v: number): void {
    if (!this.inBounds(x, y, z)) return;
    this.data[this.index(x, y, z)] = v;
  }

  coords(i: number): [number, number, number] {
    const x = i % this.sx;
    const rest = (i - x) / this.sx;
    const z = rest % this.sz;
    const y = (rest - z) / this.sz;
    return [x, y, z];
  }

  clone(): VoxelGrid {
    return new VoxelGrid(this.sx, this.sy, this.sz, this.data.slice());
  }

  count(): number {
    let n = 0;
    for (let i = 0; i < this.data.length; i++) if (this.data[i]) n++;
    return n;
  }

  isEmpty(): boolean {
    for (let i = 0; i < this.data.length; i++) if (this.data[i]) return false;
    return true;
  }

  /** Returns a new grid with the given size. Content is copied; `anchor` decides how x/z are aligned. */
  resized(nx: number, ny: number, nz: number, anchor: 'corner' | 'center' = 'center'): VoxelGrid {
    const out = new VoxelGrid(nx, ny, nz);
    const ox = anchor === 'center' ? Math.floor((nx - this.sx) / 2) : 0;
    const oz = anchor === 'center' ? Math.floor((nz - this.sz) / 2) : 0;
    for (let y = 0; y < this.sy; y++)
      for (let z = 0; z < this.sz; z++)
        for (let x = 0; x < this.sx; x++) {
          const v = this.data[this.index(x, y, z)];
          if (v) out.set(x + ox, y, z + oz, v);
        }
    return out;
  }

  /** Bounding box of the filled cells, or null if the grid is empty. Max is inclusive. */
  bounds(): { min: [number, number, number]; max: [number, number, number] } | null {
    let found = false;
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-1, -1, -1];
    for (let y = 0; y < this.sy; y++)
      for (let z = 0; z < this.sz; z++)
        for (let x = 0; x < this.sx; x++) {
          if (!this.data[this.index(x, y, z)]) continue;
          found = true;
          if (x < min[0]) min[0] = x;
          if (y < min[1]) min[1] = y;
          if (z < min[2]) min[2] = z;
          if (x > max[0]) max[0] = x;
          if (y > max[1]) max[1] = y;
          if (z > max[2]) max[2] = z;
        }
    return found ? { min, max } : null;
  }

  /** Mirrors the grid in place along one axis. */
  flip(axis: 'x' | 'y' | 'z'): void {
    const src = this.data.slice();
    for (let y = 0; y < this.sy; y++)
      for (let z = 0; z < this.sz; z++)
        for (let x = 0; x < this.sx; x++) {
          const nx = axis === 'x' ? this.sx - 1 - x : x;
          const ny = axis === 'y' ? this.sy - 1 - y : y;
          const nz = axis === 'z' ? this.sz - 1 - z : z;
          this.data[this.index(nx, ny, nz)] = src[this.index(x, y, z)];
        }
  }

  /** Returns a copy rotated 90° around the Y axis (clockwise seen from above). Size swaps x/z. */
  rotatedY(): VoxelGrid {
    const out = new VoxelGrid(this.sz, this.sy, this.sx);
    for (let y = 0; y < this.sy; y++)
      for (let z = 0; z < this.sz; z++)
        for (let x = 0; x < this.sx; x++) {
          const v = this.data[this.index(x, y, z)];
          if (v) out.set(this.sz - 1 - z, y, x, v);
        }
    return out;
  }

  /** Shifts content by an offset; cells moved outside are dropped. */
  shift(dx: number, dy: number, dz: number): void {
    const src = this.data.slice();
    this.data.fill(0);
    for (let y = 0; y < this.sy; y++)
      for (let z = 0; z < this.sz; z++)
        for (let x = 0; x < this.sx; x++) {
          const v = src[this.index(x, y, z)];
          if (v) this.set(x + dx, y + dy, z + dz, v);
        }
  }
}
