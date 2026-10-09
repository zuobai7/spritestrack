import type { VoxelGrid } from './VoxelGrid';

export interface MeshData {
  positions: Float32Array;
  normals: Float32Array;
  /** Palette index per vertex. */
  colorIndex: Uint8Array;
  /** Ambient occlusion factor per vertex (1 = fully lit). */
  ao: Float32Array;
  /** Grid cell index of the voxel each vertex belongs to. */
  cell: Uint32Array;
  indices: Uint32Array;
}

type V3 = [number, number, number];

/** Six faces: normal + 4 corners (CCW seen from outside). */
const FACES: { n: V3; c: V3[] }[] = [
  { n: [1, 0, 0], c: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]] },
  { n: [-1, 0, 0], c: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]] },
  { n: [0, 1, 0], c: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]] },
  { n: [0, -1, 0], c: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
  { n: [0, 0, 1], c: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]] },
  { n: [0, 0, -1], c: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]] },
];

/**
 * The outer faces of a set of cells: faces shared with another cell of the
 * set, or covered by a voxel for which `solid` is true, are left out. Used to
 * highlight the cells a tool is about to change.
 */
export function buildCellFaces(
  cells: V3[],
  size: V3,
  solid: (x: number, y: number, z: number) => boolean,
): { positions: Float32Array; normals: Float32Array; indices: Uint32Array } {
  const [sx, sy, sz] = size;
  const key = (x: number, y: number, z: number) => x + sx * (z + sz * y);
  const set = new Set<number>();
  const unique: V3[] = [];
  for (const c of cells) {
    const k = key(c[0], c[1], c[2]);
    if (set.has(k)) continue;
    set.add(k);
    unique.push(c);
  }
  const pos: number[] = [];
  const nor: number[] = [];
  const idx: number[] = [];
  for (const [x, y, z] of unique)
    for (const f of FACES) {
      const nx = x + f.n[0];
      const ny = y + f.n[1];
      const nz = z + f.n[2];
      const inside = nx >= 0 && ny >= 0 && nz >= 0 && nx < sx && ny < sy && nz < sz;
      if (inside && (set.has(key(nx, ny, nz)) || solid(nx, ny, nz))) continue;
      const base = pos.length / 3;
      for (const c of f.c) {
        pos.push(x + c[0], y + c[1], z + c[2]);
        nor.push(f.n[0], f.n[1], f.n[2]);
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  return { positions: new Float32Array(pos), normals: new Float32Array(nor), indices: new Uint32Array(idx) };
}

export const AO_CURVE = [0.5, 0.68, 0.84, 1];

export interface MeshOptions {
  /** Only voxels with y <= maxY are meshed (layer view). */
  maxY?: number;
  /** Compute per-vertex ambient occlusion. */
  ao?: boolean;
}

/**
 * Builds a mesh with one quad per visible voxel face, with optional per-vertex
 * ambient occlusion. Used for the interactive viewport where AO looks nice.
 */
export function buildCulledMesh(grid: VoxelGrid, opts: MeshOptions = {}): MeshData {
  const maxY = opts.maxY ?? Infinity;
  const useAo = opts.ao ?? true;
  const solid = (x: number, y: number, z: number) => y <= maxY && grid.get(x, y, z) !== 0;
  const pos: number[] = [];
  const nor: number[] = [];
  const col: number[] = [];
  const aos: number[] = [];
  const cells: number[] = [];
  const idx: number[] = [];
  const { sx, sy, sz } = grid;
  for (let y = 0; y < Math.min(sy, maxY + 1); y++)
    for (let z = 0; z < sz; z++)
      for (let x = 0; x < sx; x++) {
        const v = grid.data[grid.index(x, y, z)];
        if (!v) continue;
        for (const f of FACES) {
          const [nx, ny, nz] = f.n;
          if (solid(x + nx, y + ny, z + nz)) continue;
          const base = pos.length / 3;
          const faceAo: number[] = [];
          for (const c of f.c) {
            pos.push(x + c[0], y + c[1], z + c[2]);
            nor.push(nx, ny, nz);
            col.push(v);
            cells.push(grid.index(x, y, z));
            let ao = 3;
            if (useAo) {
              // Offsets towards this corner along the two tangent axes
              const s: V3 = [0, 0, 0];
              const t: V3 = [0, 0, 0];
              let k = 0;
              for (let a = 0; a < 3; a++) {
                if (f.n[a] !== 0) continue;
                const d = c[a] === 1 ? 1 : -1;
                if (k++ === 0) s[a] = d;
                else t[a] = d;
              }
              const ox = x + nx;
              const oy = y + ny;
              const oz = z + nz;
              const s1 = solid(ox + s[0], oy + s[1], oz + s[2]) ? 1 : 0;
              const s2 = solid(ox + t[0], oy + t[1], oz + t[2]) ? 1 : 0;
              const cc = solid(ox + s[0] + t[0], oy + s[1] + t[1], oz + s[2] + t[2]) ? 1 : 0;
              ao = s1 && s2 ? 0 : 3 - (s1 + s2 + cc);
            }
            faceAo.push(ao);
            aos.push(AO_CURVE[ao]);
          }
          // Flip the quad diagonal to avoid anisotropic AO artifacts
          if (faceAo[0] + faceAo[2] < faceAo[1] + faceAo[3]) idx.push(base + 1, base + 2, base + 3, base + 1, base + 3, base);
          else idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
        }
      }
  return {
    positions: Float32Array.from(pos),
    normals: Float32Array.from(nor),
    colorIndex: Uint8Array.from(col),
    ao: Float32Array.from(aos),
    cell: Uint32Array.from(cells),
    indices: Uint32Array.from(idx),
  };
}

export interface Quad {
  /** Four corners, CCW seen from outside. */
  corners: [V3, V3, V3, V3];
  normal: V3;
  color: number;
}

/**
 * Greedy mesher: merges coplanar faces of the same color into larger quads.
 * Produces far fewer polygons; used for 3D model export.
 */
export function buildGreedyQuads(grid: VoxelGrid): Quad[] {
  const size: V3 = [grid.sx, grid.sy, grid.sz];
  const quads: Quad[] = [];
  for (let d = 0; d < 3; d++) {
    const u = (d + 1) % 3;
    const v = (d + 2) % 3;
    const x: V3 = [0, 0, 0];
    const q: V3 = [0, 0, 0];
    q[d] = 1;
    const mask = new Int32Array(size[u] * size[v]);
    for (x[d] = -1; x[d] < size[d]; ) {
      let n = 0;
      for (x[v] = 0; x[v] < size[v]; x[v]++)
        for (x[u] = 0; x[u] < size[u]; x[u]++) {
          const a = x[d] >= 0 ? grid.get(x[0], x[1], x[2]) : 0;
          const b = x[d] < size[d] - 1 ? grid.get(x[0] + q[0], x[1] + q[1], x[2] + q[2]) : 0;
          mask[n++] = a && !b ? a : !a && b ? -b : 0;
        }
      x[d]++;
      n = 0;
      for (let j = 0; j < size[v]; j++)
        for (let i = 0; i < size[u]; ) {
          const c = mask[n];
          if (!c) {
            i++;
            n++;
            continue;
          }
          let w = 1;
          while (i + w < size[u] && mask[n + w] === c) w++;
          let h = 1;
          outer: for (; j + h < size[v]; h++)
            for (let k = 0; k < w; k++) if (mask[n + k + h * size[u]] !== c) break outer;
          const base: V3 = [0, 0, 0];
          base[d] = x[d];
          base[u] = i;
          base[v] = j;
          const du: V3 = [0, 0, 0];
          du[u] = w;
          const dv: V3 = [0, 0, 0];
          dv[v] = h;
          const p0: V3 = [...base];
          const p1: V3 = [base[0] + du[0], base[1] + du[1], base[2] + du[2]];
          const p2: V3 = [p1[0] + dv[0], p1[1] + dv[1], p1[2] + dv[2]];
          const p3: V3 = [base[0] + dv[0], base[1] + dv[1], base[2] + dv[2]];
          const normal: V3 = [0, 0, 0];
          normal[d] = c > 0 ? 1 : -1;
          quads.push({
            corners: c > 0 ? [p0, p1, p2, p3] : [p0, p3, p2, p1],
            normal,
            color: Math.abs(c),
          });
          for (let l = 0; l < h; l++) for (let k = 0; k < w; k++) mask[n + k + l * size[u]] = 0;
          i += w;
          n += w;
        }
    }
  }
  return quads;
}
