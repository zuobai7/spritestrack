import { describe, expect, it } from 'vitest';
import { VoxelGrid } from '../src/core/VoxelGrid';
import { History, VoxelEdit } from '../src/core/History';
import { createDemoProject, Project } from '../src/core/Project';
import { deserializeProject, rleDecode, rleEncode, serializeProject } from '../src/core/serialize';
import { raycastGrid, raycastPlaneY } from '../src/core/raycast';
import {
  boxCells,
  brushCells,
  copyRegion,
  flipRegion,
  floodCells,
  lineCells,
  mirrored,
  pasteRegion,
  shrinkToContent,
  surfaceFillCells,
} from '../src/core/tools';
import { buildCulledMesh, buildGreedyQuads } from '../src/core/mesher';

describe('VoxelGrid', () => {
  it('stores and reads voxels, ignoring out-of-bounds', () => {
    const g = new VoxelGrid(4, 3, 2);
    g.set(3, 2, 1, 7);
    g.set(9, 0, 0, 1);
    expect(g.get(3, 2, 1)).toBe(7);
    expect(g.get(-1, 0, 0)).toBe(0);
    expect(g.count()).toBe(1);
    expect(g.coords(g.index(3, 2, 1))).toEqual([3, 2, 1]);
  });

  it('resizes around the center and computes bounds', () => {
    const g = new VoxelGrid(2, 2, 2);
    g.set(0, 0, 0, 1);
    const r = g.resized(4, 2, 4);
    expect(r.get(1, 0, 1)).toBe(1);
    expect(r.bounds()).toEqual({ min: [1, 0, 1], max: [1, 0, 1] });
  });

  it('flips and rotates', () => {
    const g = new VoxelGrid(3, 1, 2);
    g.set(0, 0, 0, 5);
    g.flip('x');
    expect(g.get(2, 0, 0)).toBe(5);
    const r = g.rotatedY();
    expect([r.sx, r.sy, r.sz]).toEqual([2, 1, 3]);
    expect(r.count()).toBe(1);
    expect(r.get(1, 0, 2)).toBe(5);
  });
});

describe('History', () => {
  it('undoes and redoes voxel edits', () => {
    const g = new VoxelGrid(2, 2, 2);
    const h = new History();
    const e = new VoxelEdit(g.data);
    e.set(0, 3);
    e.set(1, 4);
    e.set(0, 5); // second write keeps original old value
    h.push(e.toCommand('paint', () => g.data, () => {})!);
    expect(g.data[0]).toBe(5);
    h.undo();
    expect(g.data[0]).toBe(0);
    expect(g.data[1]).toBe(0);
    h.redo();
    expect(g.data[0]).toBe(5);
    expect(g.data[1]).toBe(4);
  });

  it('drops no-op edits', () => {
    const g = new VoxelGrid(1, 1, 1);
    const e = new VoxelEdit(g.data);
    e.set(0, 2);
    e.set(0, 0);
    expect(e.toCommand('x', () => g.data, () => {})).toBeNull();
  });
});

describe('serialization', () => {
  it('round-trips RLE', () => {
    const d = new Uint8Array(1000);
    d.fill(3, 10, 600);
    d[999] = 9;
    expect(rleDecode(rleEncode(d), 1000)).toEqual(d);
  });

  it('round-trips a project', () => {
    const p = createDemoProject();
    const q = deserializeProject(serializeProject(p));
    expect([q.sx, q.sy, q.sz]).toEqual([p.sx, p.sy, p.sz]);
    expect(q.palette).toEqual(p.palette);
    expect(q.animations.map((a) => a.name)).toEqual(p.animations.map((a) => a.name));
    expect(q.animations[1].frames[1].data).toEqual(p.animations[1].frames[1].data);
  });

  it('resizes every frame', () => {
    const p = new Project(4, 4, 4);
    p.animations[0].frames[0].set(0, 0, 0, 1);
    p.resize(8, 4, 8, 'corner');
    expect(p.animations[0].frames[0].sx).toBe(8);
    expect(p.animations[0].frames[0].get(0, 0, 0)).toBe(1);
  });
});

describe('raycast', () => {
  const g = new VoxelGrid(8, 8, 8);
  g.set(4, 0, 4, 1);
  g.set(4, 3, 4, 2);

  it('hits the top face from above', () => {
    const hit = raycastGrid(g, [4.5, 20, 4.5], [0, -1, 0]);
    expect(hit?.voxel).toEqual([4, 3, 4]);
    expect(hit?.normal).toEqual([0, 1, 0]);
  });

  it('respects maxY (layer view)', () => {
    const hit = raycastGrid(g, [4.5, 20, 4.5], [0, -1, 0], 2);
    expect(hit?.voxel).toEqual([4, 0, 4]);
  });

  it('hits side faces at an angle', () => {
    const d = Math.SQRT1_2;
    const hit = raycastGrid(g, [-2, 3.5, 4.5 - 0.0001], [d, 0, d * 0.0001]);
    expect(hit?.voxel).toEqual([4, 3, 4]);
    expect(hit?.normal).toEqual([-1, 0, 0]);
  });

  it('returns null on a miss and finds the ground cell', () => {
    expect(raycastGrid(g, [0.5, 20, 0.5], [0, -1, 0])).toBeNull();
    expect(raycastPlaneY(g, [2.5, 10, 2.5], [0, -1, 0], 0)).toEqual([2, 0, 2]);
  });
});

describe('tools', () => {
  it('mirrors on x and z', () => {
    const g = new VoxelGrid(4, 4, 4);
    expect(mirrored(g, [0, 1, 0], { x: true, y: false, z: true })).toHaveLength(4);
  });

  it('box and line', () => {
    expect(boxCells([0, 0, 0], [1, 1, 1])).toHaveLength(8);
    expect(lineCells([0, 0, 0], [3, 0, 0])).toHaveLength(4);
  });

  it('flood fills a layer and a surface', () => {
    const g = new VoxelGrid(4, 2, 4);
    for (let x = 0; x < 4; x++) for (let z = 0; z < 4; z++) g.set(x, 0, z, 1);
    g.set(1, 1, 1, 1);
    expect(floodCells(g, [0, 1, 0], true)).toHaveLength(15);
    // Top surface of layer 0 minus the covered cell
    expect(surfaceFillCells(g, [0, 0, 0], [0, 1, 0])).toHaveLength(15);
  });
});

describe('mesher', () => {
  it('culls hidden faces', () => {
    const g = new VoxelGrid(2, 1, 1);
    g.set(0, 0, 0, 1);
    g.set(1, 0, 0, 1);
    const m = buildCulledMesh(g);
    expect(m.indices.length / 6).toBe(10);
  });

  it('greedy-merges a solid box into 6 quads', () => {
    const g = new VoxelGrid(3, 3, 3);
    g.data.fill(2);
    const q = buildGreedyQuads(g);
    expect(q).toHaveLength(6);
    // Each quad's winding must match its normal
    for (const { corners: [a, b, c], normal } of q) {
      const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      const dot = n[0] * normal[0] + n[1] * normal[1] + n[2] * normal[2];
      expect(dot).toBeGreaterThan(0);
    }
  });

  it('keeps colors separate', () => {
    const g = new VoxelGrid(2, 1, 1);
    g.set(0, 0, 0, 1);
    g.set(1, 0, 0, 2);
    expect(buildGreedyQuads(g)).toHaveLength(10);
  });
});


describe('brush and selection helpers', () => {
  it('builds cube, sphere and flat brushes', () => {
    expect(brushCells([5, 5, 5], 1, 'cube')).toHaveLength(1);
    expect(brushCells([5, 5, 5], 3, 'cube')).toHaveLength(27);
    expect(brushCells([5, 5, 5], 3, 'sphere')).toHaveLength(19);
    expect(brushCells([5, 5, 5], 3, 'cube', 1)).toHaveLength(9);
    expect(brushCells([5, 5, 5], 2, 'cube')).toHaveLength(8);
    expect(brushCells([5, 5, 5], 5, 'sphere', 1).every((c) => c[1] === 5)).toBe(true);
  });

  it('copies, pastes and flips regions', () => {
    const g = new VoxelGrid(6, 6, 6);
    g.set(1, 1, 1, 4);
    g.set(2, 1, 1, 5);
    const clip = copyRegion(g, { min: [1, 1, 1], max: [2, 1, 1] });
    expect([clip.sx, clip.sy, clip.sz]).toEqual([2, 1, 1]);
    pasteRegion(g, clip, [3, 4, 3]);
    expect(g.get(3, 4, 3)).toBe(4);
    expect(g.get(4, 4, 3)).toBe(5);
    flipRegion(g, { min: [3, 4, 3], max: [4, 4, 3] }, 0);
    expect(g.get(3, 4, 3)).toBe(5);
    expect(shrinkToContent(g, { min: [0, 0, 0], max: [5, 5, 5] })).toEqual({ min: [1, 1, 1], max: [4, 4, 3] });
  });
});
