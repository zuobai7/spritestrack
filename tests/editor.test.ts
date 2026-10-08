import { describe, expect, it } from 'vitest';
import { Editor } from '../src/editor/Editor';
import { Project } from '../src/core/Project';
import { getGenerator, defaultParams } from '../src/core/procedural';
import { setKey } from '../src/core/rig';

function editor() {
  return new Editor(new Project(8, 8, 8));
}

describe('Editor history', () => {
  it('undoes strokes and structural edits in order', () => {
    const ed = editor();
    ed.applyCells([[1, 1, 1]], 3, 'add');
    ed.addFrame(true);
    expect(ed.anim.frames).toHaveLength(2);
    ed.applyCells([[2, 2, 2]], 4, 'add'); // edit the new frame
    ed.resize(10, 8, 10);
    expect(ed.frame.sx).toBe(10);
    expect(ed.frame.get(3, 2, 3)).toBe(4);
    ed.history.undo(); // resize
    expect(ed.frame.sx).toBe(8);
    expect(ed.frame.get(2, 2, 2)).toBe(4);
    ed.history.undo(); // second stroke
    expect(ed.frame.get(2, 2, 2)).toBe(0);
    ed.history.undo(); // add frame
    expect(ed.anim.frames).toHaveLength(1);
    expect(ed.frame.get(1, 1, 1)).toBe(3);
    ed.history.redo();
    ed.history.redo();
    ed.history.redo();
    expect(ed.anim.frames).toHaveLength(2);
    expect(ed.frame.sx).toBe(10);
    expect(ed.frame.get(3, 2, 3)).toBe(4);
  });

  it('add mode only fills empty cells and paint only recolors', () => {
    const ed = editor();
    ed.applyCells([[0, 0, 0]], 2, 'x');
    ed.applyCells([[0, 0, 0], [1, 0, 0]], 5, 'add', 'add');
    expect(ed.frame.get(0, 0, 0)).toBe(2);
    expect(ed.frame.get(1, 0, 0)).toBe(5);
    ed.applyCells([[0, 0, 0], [2, 0, 0]], 7, 'paint', 'paint');
    expect(ed.frame.get(0, 0, 0)).toBe(7);
    expect(ed.frame.get(2, 0, 0)).toBe(0);
  });

  it('mirrors strokes', () => {
    const ed = editor();
    ed.mirror.x = true;
    ed.applyCells([[0, 0, 0]], 1, 'x');
    expect(ed.frame.get(7, 0, 0)).toBe(1);
  });
});

describe('Editor selection', () => {
  it('moves, copies and pastes', () => {
    const ed = editor();
    ed.applyCells([[1, 1, 1], [2, 1, 1]], 6, 'x');
    ed.setSelection({ min: [1, 1, 1], max: [2, 1, 1] });
    ed.moveSelection(0, 2, 0);
    expect(ed.frame.get(1, 3, 1)).toBe(6);
    expect(ed.frame.get(1, 1, 1)).toBe(0);
    expect(ed.selection).toEqual({ min: [1, 3, 1], max: [2, 3, 1] });
    ed.copySelection();
    ed.setSelection({ min: [5, 0, 5], max: [5, 0, 5] });
    ed.paste();
    expect(ed.frame.get(5, 0, 5)).toBe(6);
    expect(ed.frame.get(6, 0, 5)).toBe(6);
    ed.history.undo();
    expect(ed.frame.get(5, 0, 5)).toBe(0);
    ed.history.undo();
    expect(ed.frame.get(1, 1, 1)).toBe(6);
  });

  it('selects connected voxels and deletes the selection', () => {
    const ed = editor();
    ed.applyCells([[1, 0, 1], [1, 1, 1], [5, 5, 5]], 2, 'x');
    ed.selectConnected([1, 0, 1]);
    expect(ed.selection).toEqual({ min: [1, 0, 1], max: [1, 1, 1] });
    ed.deleteSelection();
    expect(ed.frame.count()).toBe(1);
  });
});

describe('Editor palettes', () => {
  it('remaps voxels to an imported palette and switches color schemes', () => {
    const ed = editor();
    ed.project.palette[1] = 0xff0000;
    ed.applyCells([[0, 0, 0]], 1, 'x');
    ed.importPalette([0x0000ff, 0xee0000], 'remap');
    expect(ed.project.palette).toEqual([0, 0x0000ff, 0xee0000]);
    expect(ed.frame.get(0, 0, 0)).toBe(2);
    ed.addVariant('night');
    ed.setPaletteColor(2, 0x330000);
    expect(ed.project.variants[0].palette[2]).toBe(0xee0000);
    ed.switchVariant(0);
    expect(ed.project.palette[2]).toBe(0xee0000);
    ed.history.undo();
    expect(ed.project.palette[2]).toBe(0x330000);
  });

  it('removes unused colors and keeps voxel colors', () => {
    const ed = editor();
    const c5 = ed.project.palette[5];
    ed.applyCells([[0, 0, 0]], 5, 'x');
    ed.removeUnusedColors();
    expect(ed.project.palette).toHaveLength(2);
    expect(ed.project.palette[ed.frame.get(0, 0, 0)]).toBe(c5);
  });
});

describe('Editor generation and rig', () => {
  it('generates into the frame and as an animation', () => {
    const ed = editor();
    const gen = getGenerator('flame')!;
    ed.generate(gen, defaultParams(gen), 1, 'replace');
    expect(ed.frame.count()).toBeGreaterThan(0);
    ed.generate(gen, defaultParams(gen), 1, 'animation', 4);
    expect(ed.project.animations).toHaveLength(2);
    expect(ed.anim.frames).toHaveLength(4);
    ed.history.undo();
    expect(ed.project.animations).toHaveLength(1);
  });

  it('paints parts and bakes a rig animation', () => {
    const ed = editor();
    ed.applyCells([[4, 0, 4], [4, 1, 4], [4, 2, 4], [5, 2, 4], [6, 2, 4]], 3, 'x');
    const arm = ed.addPart('arm');
    ed.updatePart(arm, { pivot: [5, 2.5, 4.5] });
    ed.setTool('part');
    ed.beginStroke('parts');
    ed.strokeSet([[5, 2, 4], [6, 2, 4], [7, 7, 7]], arm);
    ed.endStroke('part');
    expect(ed.project.rig!.partMap.get(6, 2, 4)).toBe(arm);
    expect(ed.project.rig!.partMap.get(7, 7, 7)).toBe(0); // empty cells are not painted
    const ri = ed.addRigAnimation('wave');
    ed.editRigAnimation(ri, (a) => {
      a.length = 2;
      setKey(a, arm, { frame: 1, rot: [0, 0, 90], pos: [0, 0, 0] });
    });
    ed.bakeRigAnimation(ri);
    expect(ed.anim.name).toBe('wave');
    expect(ed.anim.frames).toHaveLength(2);
    expect(ed.anim.frames[1].get(6, 2, 4)).toBe(0);
    ed.history.undo();
    expect(ed.project.animations).toHaveLength(1);
    ed.history.undo();
    ed.history.undo();
    ed.history.undo(); // part stroke
    expect(ed.project.rig!.partMap.get(6, 2, 4)).toBe(0);
  });
});
