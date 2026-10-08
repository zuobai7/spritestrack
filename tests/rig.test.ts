import { describe, expect, it } from 'vitest';
import { VoxelGrid } from '../src/core/VoxelGrid';
import {
  addPart,
  applyTemplate,
  bakeAnimation,
  bakeFrame,
  createRig,
  partOrder,
  removePart,
  sampleTrack,
  setKey,
  wouldCycle,
  type RigAnimation,
} from '../src/core/rig';
import { Project } from '../src/core/Project';
import { deserializeProject, serializeProject } from '../src/core/serialize';

function anim(length = 4): RigAnimation {
  return { name: 'a', fps: 8, length, loop: true, easing: 'linear', tracks: [] };
}

/** A body column with an "arm" sticking out along +x. */
function model() {
  const g = new VoxelGrid(9, 9, 9);
  for (let y = 0; y < 5; y++) g.set(4, y, 4, 1);
  const rig = createRig(9, 9, 9);
  const arm = addPart(rig, 'arm', [5, 5, 4.5]);
  for (let x = 5; x < 8; x++) {
    g.set(x, 5, 4, 2);
    rig.partMap.set(x, 5, 4, arm);
  }
  return { g, rig, arm };
}

describe('rig', () => {
  it('reproduces the rest pose exactly without keys', () => {
    const { g, rig } = model();
    expect(bakeFrame(g, rig, anim(), 0).data).toEqual(g.data);
  });

  it('rotates a part around its pivot', () => {
    const { g, rig, arm } = model();
    const a = anim();
    setKey(a, arm, { frame: 0, rot: [0, 0, 90], pos: [0, 0, 0] });
    const out = bakeFrame(g, rig, a, 0);
    // Arm now points up from the pivot (x=5, y=5): cells (4..5, 5..7)
    expect(out.count()).toBe(g.count());
    expect(out.get(5, 5, 4)).toBe(0);
    let armCells = 0;
    for (let i = 0; i < out.data.length; i++) if (out.data[i] === 2) armCells++;
    expect(armCells).toBe(3);
    expect(out.get(4, 6, 4) === 2 || out.get(4, 7, 4) === 2).toBe(true);
  });

  it('moves children with their parent', () => {
    const { g, rig, arm } = model();
    const hand = addPart(rig, 'hand', [7, 5, 4.5], arm);
    rig.partMap.set(7, 5, 4, hand);
    const a = anim();
    setKey(a, arm, { frame: 0, rot: [0, 0, 0], pos: [0, 2, 0] });
    const out = bakeFrame(g, rig, a, 0);
    expect(out.get(7, 7, 4)).toBe(2);
    expect(out.get(7, 5, 4)).toBe(0);
  });

  it('interpolates keys with looping', () => {
    const a = anim(8);
    setKey(a, 1, { frame: 0, rot: [0, 0, 0], pos: [0, 0, 0] });
    setKey(a, 1, { frame: 4, rot: [40, 0, 0], pos: [0, 4, 0] });
    expect(sampleTrack(a, 1, 2).rot[0]).toBeCloseTo(20);
    expect(sampleTrack(a, 1, 6).rot[0]).toBeCloseTo(20); // wraps back to frame 0's value
    a.loop = false;
    expect(sampleTrack(a, 1, 6).rot[0]).toBeCloseTo(40);
    a.easing = 'step';
    expect(sampleTrack(a, 1, 3).rot[0]).toBe(0);
  });

  it('applies templates and bakes every frame', () => {
    const { g, rig, arm } = model();
    const a = anim(8);
    applyTemplate(a, arm, 'swing', { axis: 2, amount: 45, phase: 0 });
    applyTemplate(a, 0, 'bob', { axis: 1, amount: 1, phase: 0 });
    const frames = bakeAnimation(g, rig, a);
    expect(frames).toHaveLength(8);
    expect(frames[0].data).toEqual(g.data);
    expect(frames[2].data).not.toEqual(g.data);
    const spin = anim(4);
    applyTemplate(spin, arm, 'spin', { axis: 1, amount: 0, phase: 0 });
    expect(sampleTrack(spin, arm, 3).rot[1]).toBe(270);
  });

  it('removes parts and prevents cycles', () => {
    const { rig, arm } = model();
    const hand = addPart(rig, 'hand', [7, 5, 4.5], arm);
    expect(wouldCycle(rig, arm, hand)).toBe(true);
    expect(partOrder(rig).map((p) => p.id)).toEqual([0, arm, hand]);
    removePart(rig, arm);
    expect(rig.parts.find((p) => p.id === hand)!.parent).toBe(0);
    expect(rig.partMap.get(5, 5, 4)).toBe(0);
  });

  it('survives save/load and resize', () => {
    const p = new Project(9, 9, 9);
    const { g, rig, arm } = model();
    p.animations[0].frames[0] = g;
    p.rig = rig;
    const a = anim(4);
    setKey(a, arm, { frame: 1, rot: [0, 30, 0], pos: [0, 0, 0] });
    rig.animations.push(a);
    p.variants.push({ name: 'alt', palette: p.palette.map(() => 0x123456) });
    const q = deserializeProject(serializeProject(p));
    expect(q.rig!.partMap.data).toEqual(rig.partMap.data);
    expect(q.rig!.animations[0].tracks[0].keys[0].rot[1]).toBe(30);
    expect(q.variants).toHaveLength(2);
    expect(q.variantPalette(1)[3]).toBe(0x123456);
    q.resize(11, 9, 11);
    expect(q.rig!.partMap.get(6, 5, 5)).toBe(arm);
    expect(q.rig!.parts.find((x) => x.id === arm)!.pivot).toEqual([6, 5, 5.5]);
  });
});
