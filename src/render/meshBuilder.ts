import * as THREE from 'three';
import type { VoxelGrid } from '../core/VoxelGrid';
import { buildCulledMesh, buildGreedyQuads, type MeshOptions } from '../core/mesher';

const tmp = new THREE.Color();

/** Linear-space RGB for each palette entry (three.js lights work in linear space). */
export function linearPalette(palette: number[]): Float32Array {
  const out = new Float32Array(palette.length * 3);
  palette.forEach((c, i) => {
    tmp.setHex(c);
    out[i * 3] = tmp.r;
    out[i * 3 + 1] = tmp.g;
    out[i * 3 + 2] = tmp.b;
  });
  return out;
}

/** Viewport geometry: one quad per visible face, vertex colors darkened by AO. */
export function culledGeometry(grid: VoxelGrid, palette: number[], opts: MeshOptions & { minY?: number } = {}): THREE.BufferGeometry {
  const src = opts.minY ? sliceAbove(grid, opts.minY) : grid;
  const m = buildCulledMesh(src, opts);
  const lin = linearPalette(palette);
  const colors = new Float32Array(m.colorIndex.length * 3);
  for (let i = 0; i < m.colorIndex.length; i++) {
    const c = m.colorIndex[i];
    const a = m.ao[i];
    colors[i * 3] = (lin[c * 3] ?? 1) * a;
    colors[i * 3 + 1] = (lin[c * 3 + 1] ?? 0) * a;
    colors[i * 3 + 2] = (lin[c * 3 + 2] ?? 1) * a;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3));
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.setIndex(new THREE.BufferAttribute(m.indices, 1));
  g.computeBoundingSphere();
  return g;
}

/** A copy of the grid with layers below `minY` removed. */
function sliceAbove(grid: VoxelGrid, minY: number): VoxelGrid {
  const g = grid.clone();
  g.data.fill(0, 0, Math.min(g.data.length, minY * g.sx * g.sz));
  return g;
}

/** Export geometry: greedy-merged quads with flat vertex colors. */
export function greedyGeometry(grid: VoxelGrid, palette: number[], scale = 1, center = true): THREE.BufferGeometry {
  const quads = buildGreedyQuads(grid);
  const lin = linearPalette(palette);
  const pos = new Float32Array(quads.length * 12);
  const nor = new Float32Array(quads.length * 12);
  const col = new Float32Array(quads.length * 12);
  const idx = new Uint32Array(quads.length * 6);
  const ox = center ? grid.sx / 2 : 0;
  const oz = center ? grid.sz / 2 : 0;
  quads.forEach((q, i) => {
    q.corners.forEach((c, k) => {
      const o = i * 12 + k * 3;
      pos[o] = (c[0] - ox) * scale;
      pos[o + 1] = c[1] * scale;
      pos[o + 2] = (c[2] - oz) * scale;
      nor[o] = q.normal[0];
      nor[o + 1] = q.normal[1];
      nor[o + 2] = q.normal[2];
      col[o] = lin[q.color * 3];
      col[o + 1] = lin[q.color * 3 + 1];
      col[o + 2] = lin[q.color * 3 + 2];
    });
    const b = i * 4;
    idx.set([b, b + 1, b + 2, b, b + 2, b + 3], i * 6);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  return g;
}

/** Converts view-relative light angles to a world-space direction (towards the light). */
export function lightVector(azimuthDeg: number, elevationDeg: number, viewAzimuthRad = 0): THREE.Vector3 {
  const a = (azimuthDeg * Math.PI) / 180 + viewAzimuthRad;
  const e = (elevationDeg * Math.PI) / 180;
  return new THREE.Vector3(Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e));
}
