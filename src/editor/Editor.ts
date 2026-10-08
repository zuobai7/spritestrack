import { VoxelGrid } from '../core/VoxelGrid';
import { Project, type Animation, type PaletteVariant } from '../core/Project';
import { History, VoxelEdit, type Command } from '../core/History';
import {
  brushCells,
  clampBox,
  copyRegion,
  fillRegion,
  flipRegion,
  floodCells,
  mirrored,
  pasteRegion,
  type Box,
  type BrushShape,
} from '../core/tools';
import type { Vec3 } from '../core/raycast';
import { DEFAULT_LIGHT, type LightSettings } from '../core/lighting';
import { MAX_COLORS } from '../core/Palette';
import { remapTable } from '../core/paletteIO';
import {
  addPart,
  bakeAnimation,
  cloneRigMeta,
  createRig,
  getPart,
  removePart,
  wouldCycle,
  type Rig,
  type RigAnimation,
  type V3,
} from '../core/rig';
import { runGenerator, type Generator, type ParamValues } from '../core/procedural';

export type Tool = 'add' | 'erase' | 'paint' | 'pick' | 'fill' | 'box' | 'line' | 'select' | 'part';
export type EditMode = '3d' | 'layer';
export type GenTarget = 'replace' | 'merge' | 'animation';
export type EditorEvent =
  | 'project'
  | 'model'
  | 'frames'
  | 'frame'
  | 'palette'
  | 'state'
  | 'history'
  | 'light'
  | 'selection'
  | 'rig'
  | 'reference';

/** How a stroke writes cells: add only fills empty cells, paint only recolors filled ones. */
export type WriteMode = 'add' | 'paint' | 'set';

export interface ReferenceImage {
  url: string;
  width: number;
  height: number;
  plane: 'front' | 'side' | 'top';
  opacity: number;
  /** Width of the image in voxels. */
  size: number;
  offsetX: number;
  offsetY: number;
  /** In layer mode, a top reference moves with the current layer (for tracing slices). */
  followLayer: boolean;
  visible: boolean;
}

interface Snapshot {
  size: [number, number, number];
  variants: PaletteVariant[];
  activeVariant: number;
  animations: Animation[];
  rig: Rig | null;
  animIndex: number;
  frameIndex: number;
  selection: Box | null;
}

type Diff = { idx: Uint32Array; old: Uint8Array; next: Uint8Array };

function diff(before: Uint8Array, after: Uint8Array): Diff {
  const idx: number[] = [];
  for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) idx.push(i);
  const old = new Uint8Array(idx.length);
  const next = new Uint8Array(idx.length);
  idx.forEach((i, k) => {
    old[k] = before[i];
    next[k] = after[i];
  });
  return { idx: Uint32Array.from(idx), old, next };
}

function applyDiff(data: Uint8Array, d: Diff, which: 'old' | 'next'): void {
  const src = which === 'old' ? d.old : d.next;
  for (let k = 0; k < d.idx.length; k++) data[d.idx[k]] = src[k];
}

/**
 * Editor state and every edit operation. UI and viewport listen to events and
 * call these methods; every change to the document goes through the undo
 * history. Two kinds of undo steps exist:
 *  - voxel strokes record per-cell diffs on one frame;
 *  - transactions snapshot the document structure (cheap: frames are shared
 *    by reference) plus diffs of the frames they edit in place.
 * Undo is strictly last-in-first-out, so grid objects referenced by older
 * steps are always back in place when those steps are undone.
 */
export class Editor {
  project: Project;
  animIndex = 0;
  frameIndex = 0;
  tool: Tool = 'add';
  color = 1;
  mode: EditMode = '3d';
  layer = 0;
  showAbove = true;
  mirror = { x: false, y: false, z: false };
  brush: { size: number; shape: BrushShape } = { size: 1, shape: 'cube' };
  onion = false;
  showGrid = true;
  ao = true;
  partOverlay = false;
  activePart = 0;
  /** Part whose pivot the next viewport click sets, or null. */
  pivotPick: number | null = null;
  light: LightSettings = { ...DEFAULT_LIGHT };
  selection: Box | null = null;
  clipboard: { grid: VoxelGrid; origin: Vec3 } | null = null;
  reference: ReferenceImage | null = null;
  playing = false;
  readonly history = new History(300);
  private listeners = new Map<EditorEvent, Set<() => void>>();
  private stroke: { edit: VoxelEdit; anim: number; frame: number; target: 'frame' | 'parts' } | null = null;
  private live: { before: Snapshot } | null = null;
  private playTimer: number | null = null;
  private versions = new WeakMap<VoxelGrid, number>();
  dirty = false;

  constructor(project: Project) {
    this.project = project;
    this.history.onChange = () => this.emit('history');
  }

  on(ev: EditorEvent, fn: () => void): () => void {
    if (!this.listeners.has(ev)) this.listeners.set(ev, new Set());
    this.listeners.get(ev)!.add(fn);
    return () => this.listeners.get(ev)!.delete(fn);
  }

  emit(ev: EditorEvent): void {
    if (ev === 'model' || ev === 'frames' || ev === 'palette' || ev === 'project' || ev === 'rig') this.dirty = true;
    this.listeners.get(ev)?.forEach((fn) => fn());
  }

  /** Edit counter per frame grid (for thumbnail caches). */
  version(g: VoxelGrid): number {
    return this.versions.get(g) ?? 0;
  }

  private bump(g: VoxelGrid): void {
    this.versions.set(g, this.version(g) + 1);
  }

  get anim(): Animation {
    return this.project.animations[this.animIndex];
  }

  get frame(): VoxelGrid {
    return this.anim.frames[this.frameIndex];
  }

  get prevFrame(): VoxelGrid | null {
    const f = this.anim.frames;
    if (f.length < 2) return null;
    return f[(this.frameIndex - 1 + f.length) % f.length];
  }

  frameAt(anim: number, frame: number): VoxelGrid {
    return this.project.animations[anim].frames[frame];
  }

  setProject(p: Project): void {
    this.stop();
    this.project = p;
    this.animIndex = 0;
    this.frameIndex = 0;
    this.layer = Math.min(this.layer, p.sy - 1);
    this.color = Math.max(1, Math.min(this.color, p.palette.length - 1));
    this.selection = null;
    this.activePart = 0;
    this.pivotPick = null;
    this.history.clear();
    this.emit('project');
    this.dirty = false;
  }

  // ---- state setters ------------------------------------------------------

  setTool(t: Tool): void {
    this.tool = t;
    this.pivotPick = null;
    if (t === 'part' && !this.partOverlay) this.partOverlay = true;
    this.emit('state');
  }

  setColor(c: number): void {
    if (c < 1 || c >= this.project.palette.length) return;
    this.color = c;
    this.emit('state');
    this.emit('palette');
  }

  setMode(m: EditMode): void {
    this.mode = m;
    this.emit('state');
  }

  setLayer(y: number): void {
    this.layer = Math.max(0, Math.min(this.project.sy - 1, y));
    this.emit('state');
  }

  setView(patch: Partial<Pick<Editor, 'showGrid' | 'ao' | 'onion' | 'showAbove' | 'partOverlay'>>): void {
    Object.assign(this, patch);
    this.emit('state');
  }

  setBrush(patch: Partial<{ size: number; shape: BrushShape }>): void {
    Object.assign(this.brush, patch);
    this.brush.size = Math.max(1, Math.min(16, Math.round(this.brush.size)));
    this.emit('state');
  }

  selectFrame(anim: number, frame: number): void {
    this.animIndex = Math.max(0, Math.min(this.project.animations.length - 1, anim));
    this.frameIndex = Math.max(0, Math.min(this.anim.frames.length - 1, frame));
    this.emit('frame');
  }

  setLight(patch: Partial<LightSettings>): void {
    Object.assign(this.light, patch);
    this.emit('light');
  }

  setReference(r: ReferenceImage | null): void {
    this.reference = r;
    this.emit('reference');
  }

  // ---- voxel strokes ------------------------------------------------------

  beginStroke(target: 'frame' | 'parts' = 'frame'): void {
    const data = target === 'parts' ? this.ensureRig().partMap.data : this.frame.data;
    this.stroke = { edit: new VoxelEdit(data), anim: this.animIndex, frame: this.frameIndex, target };
  }

  /** Expands a cell into brush cells (flat on the layer in layer mode). */
  brushAt(c: Vec3): Vec3[] {
    return brushCells(c, this.brush.size, this.brush.shape, this.mode === 'layer' ? 1 : null);
  }

  /** Sets cells (with mirroring) inside the current stroke. Returns true if anything changed. */
  strokeSet(cells: Vec3[], value: number, mode: WriteMode = 'set'): boolean {
    if (!this.stroke) this.beginStroke();
    const s = this.stroke!;
    const g = this.frame;
    let changed = false;
    for (const c of cells)
      for (const m of mirrored(g, c, this.mirror)) {
        if (!g.inBounds(m[0], m[1], m[2])) continue;
        const i = g.index(m[0], m[1], m[2]);
        if (s.target === 'parts') {
          if (!g.data[i]) continue; // parts are painted onto existing voxels
        } else if (mode === 'add' && g.data[i]) continue;
        else if (mode === 'paint' && !g.data[i]) continue;
        if (s.edit.set(i, value)) changed = true;
      }
    if (changed && s.target === 'frame') this.bump(g);
    if (changed) this.emit(s.target === 'parts' ? 'rig' : 'model');
    return changed;
  }

  endStroke(label: string): void {
    const s = this.stroke;
    this.stroke = null;
    if (!s) return;
    const resolve =
      s.target === 'parts' ? () => this.project.rig!.partMap.data : () => this.project.animations[s.anim].frames[s.frame].data;
    const cmd = s.edit.toCommand(label, resolve, () => {
      if (s.target === 'parts') return this.emit('rig');
      if (this.animIndex !== s.anim || this.frameIndex !== s.frame) this.selectFrame(s.anim, s.frame);
      this.bump(this.frame);
      this.emit('model');
    });
    if (cmd) this.history.push(cmd);
  }

  /** One-shot edit of a set of cells. */
  applyCells(cells: Vec3[], value: number, label: string, mode: WriteMode = 'set'): void {
    this.beginStroke();
    this.strokeSet(cells, value, mode);
    this.endStroke(label);
  }

  // ---- transactions -------------------------------------------------------

  private snapshot(): Snapshot {
    const p = this.project;
    return {
      size: [p.sx, p.sy, p.sz],
      variants: p.variants.map((v) => ({ name: v.name, palette: v.palette.slice() })),
      activeVariant: p.activeVariant,
      animations: p.animations.map((a) => ({ name: a.name, fps: a.fps, frames: a.frames.slice() })),
      rig: p.rig ? cloneRigMeta(p.rig) : null,
      animIndex: this.animIndex,
      frameIndex: this.frameIndex,
      selection: this.selection ? { min: [...this.selection.min], max: [...this.selection.max] } : null,
    };
  }

  private restore(s: Snapshot): void {
    const p = this.project;
    [p.sx, p.sy, p.sz] = s.size;
    p.variants = s.variants.map((v) => ({ name: v.name, palette: v.palette.slice() }));
    p.activeVariant = s.activeVariant;
    p.animations = s.animations.map((a) => ({ name: a.name, fps: a.fps, frames: a.frames.slice() }));
    p.rig = s.rig ? cloneRigMeta(s.rig) : null;
    this.animIndex = Math.min(s.animIndex, p.animations.length - 1);
    this.frameIndex = Math.min(s.frameIndex, this.anim.frames.length - 1);
    this.selection = s.selection ? { min: [...s.selection.min], max: [...s.selection.max] } : null;
  }

  private refreshAll(sizeChanged: boolean): void {
    const p = this.project;
    this.layer = Math.min(this.layer, p.sy - 1);
    this.color = Math.max(1, Math.min(this.color, p.palette.length - 1));
    if (p.rig && !getPart(p.rig, this.activePart)) this.activePart = 0;
    if (sizeChanged) this.emit('project');
    this.emit('palette');
    this.emit('frames');
    this.emit('frame');
    this.emit('model');
    this.emit('selection');
    this.emit('rig');
  }

  /**
   * Runs `mutate` as one undo step. `frames` lists frames (anim, frame) that
   * `mutate` edits in place; `partMap` says it edits the rig's part map in
   * place. Anything else `mutate` may only replace, not modify.
   */
  transaction(label: string, mutate: () => void, touched: { frames?: [number, number][]; partMap?: boolean } = {}): void {
    this.stop();
    this.commitLive();
    const before = this.snapshot();
    const copies = (touched.frames ?? []).map(([a, f]) => ({ a, f, copy: this.frameAt(a, f).data.slice() }));
    const pmBefore = touched.partMap && this.project.rig ? this.project.rig.partMap.data.slice() : null;
    mutate();
    const after = this.snapshot();
    const diffs = copies.map(({ a, f, copy }) => ({ a, f, d: diff(copy, this.frameAt(a, f).data) }));
    for (const x of diffs) if (x.d.idx.length) this.bump(this.frameAt(x.a, x.f));
    const pmDiff = pmBefore && this.project.rig ? diff(pmBefore, this.project.rig.partMap.data) : null;
    const resized = before.size.some((v, i) => v !== after.size[i]);
    const cmd: Command = {
      label,
      undo: () => {
        this.restore(before);
        for (const x of diffs) {
          applyDiff(this.frameAt(x.a, x.f).data, x.d, 'old');
          this.bump(this.frameAt(x.a, x.f));
        }
        if (pmDiff && this.project.rig) applyDiff(this.project.rig.partMap.data, pmDiff, 'old');
        this.refreshAll(resized);
      },
      redo: () => {
        this.restore(after);
        for (const x of diffs) {
          applyDiff(this.frameAt(x.a, x.f).data, x.d, 'next');
          this.bump(this.frameAt(x.a, x.f));
        }
        if (pmDiff && this.project.rig) applyDiff(this.project.rig.partMap.data, pmDiff, 'next');
        this.refreshAll(resized);
      },
    };
    this.history.push(cmd);
    this.refreshAll(resized);
  }

  /**
   * Live edits (e.g. dragging a slider): changes apply immediately and are
   * merged into one undo step by `commitLive`. Only for metadata (rig keys,
   * palette colors), never for frame data.
   */
  liveEdit(mutate: () => void, ev: EditorEvent): void {
    if (!this.live) this.live = { before: this.snapshot() };
    mutate();
    this.emit(ev);
  }

  commitLive(label = 'edit'): void {
    if (!this.live) return;
    const before = this.live.before;
    this.live = null;
    const after = this.snapshot();
    this.history.push({
      label,
      undo: () => {
        this.restore(before);
        this.refreshAll(false);
      },
      redo: () => {
        this.restore(after);
        this.refreshAll(false);
      },
    });
  }

  private allFrameRefs(): [number, number][] {
    const out: [number, number][] = [];
    this.project.animations.forEach((a, ai) => a.frames.forEach((_, fi) => out.push([ai, fi])));
    return out;
  }

  // ---- frames and animations ----------------------------------------------

  addFrame(duplicate: boolean): void {
    this.transaction('add frame', () => {
      const f = duplicate ? this.frame.clone() : new VoxelGrid(this.project.sx, this.project.sy, this.project.sz);
      this.anim.frames.splice(this.frameIndex + 1, 0, f);
      this.frameIndex++;
    });
  }

  deleteFrame(): void {
    if (this.anim.frames.length <= 1) return;
    this.transaction('delete frame', () => {
      this.anim.frames.splice(this.frameIndex, 1);
      this.frameIndex = Math.min(this.frameIndex, this.anim.frames.length - 1);
    });
  }

  moveFrame(delta: number): void {
    const to = this.frameIndex + delta;
    if (to < 0 || to >= this.anim.frames.length) return;
    this.transaction('move frame', () => {
      const f = this.anim.frames;
      [f[this.frameIndex], f[to]] = [f[to], f[this.frameIndex]];
      this.frameIndex = to;
    });
  }

  addAnimation(name: string): void {
    this.transaction('add animation', () => {
      this.project.animations.push({ name, fps: this.anim.fps, frames: [this.frame.clone()] });
      this.animIndex = this.project.animations.length - 1;
      this.frameIndex = 0;
    });
  }

  deleteAnimation(): void {
    if (this.project.animations.length <= 1) return;
    this.transaction('delete animation', () => {
      this.project.animations.splice(this.animIndex, 1);
      this.animIndex = Math.max(0, this.animIndex - 1);
      this.frameIndex = 0;
    });
  }

  renameAnimation(name: string): void {
    this.transaction('rename animation', () => {
      this.anim.name = name;
    });
  }

  setFps(fps: number): void {
    this.anim.fps = Math.max(1, Math.min(60, Math.round(fps)));
    this.dirty = true;
    if (this.playing) {
      this.stop();
      this.play();
    }
    this.emit('frames');
  }

  resize(sx: number, sy: number, sz: number): void {
    this.transaction('resize', () => {
      this.project.resize(sx, sy, sz, 'center');
      this.selection = null;
    });
  }

  transform(kind: 'flipX' | 'flipY' | 'flipZ' | 'rotate' | 'clear', allFrames: boolean): void {
    const refs: [number, number][] = allFrames
      ? this.anim.frames.map((_, i) => [this.animIndex, i] as [number, number])
      : [[this.animIndex, this.frameIndex]];
    if (kind === 'rotate' && this.project.sx !== this.project.sz) {
      // Rotation swaps x and z, so every frame of every animation must turn to keep one size
      this.transaction('rotate', () => {
        const p = this.project;
        for (const a of p.animations) a.frames = a.frames.map((f) => f.rotatedY());
        if (p.rig) p.rig.partMap = p.rig.partMap.rotatedY();
        [p.sx, p.sz] = [p.sz, p.sx];
        this.selection = null;
      });
      return;
    }
    this.transaction(
      kind,
      () => {
        for (const [a, fi] of refs) {
          const f = this.frameAt(a, fi);
          if (kind === 'flipX') f.flip('x');
          else if (kind === 'flipY') f.flip('y');
          else if (kind === 'flipZ') f.flip('z');
          else if (kind === 'clear') f.data.fill(0);
          else if (kind === 'rotate') f.data.set(f.rotatedY().data);
        }
      },
      { frames: refs },
    );
  }

  // ---- selection and clipboard ---------------------------------------------

  setSelection(b: Box | null): void {
    this.selection = b ? clampBox(this.frame, b) : null;
    this.emit('selection');
  }

  selectAll(): void {
    const { sx, sy, sz } = this.project;
    this.setSelection({ min: [0, 0, 0], max: [sx - 1, sy - 1, sz - 1] });
  }

  /** Selects the bounding box of the voxels connected to `c` (any color). */
  selectConnected(c: Vec3): void {
    const g = this.frame;
    if (!g.get(c[0], c[1], c[2])) return this.setSelection(null);
    const solid = new VoxelGrid(g.sx, g.sy, g.sz);
    for (let i = 0; i < g.data.length; i++) solid.data[i] = g.data[i] ? 1 : 0;
    const cells = floodCells(solid, c, false);
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const p of cells)
      for (let a = 0; a < 3; a++) {
        min[a] = Math.min(min[a], p[a]);
        max[a] = Math.max(max[a], p[a]);
      }
    this.setSelection({ min, max });
  }

  private selectionOrAll(): Box {
    const { sx, sy, sz } = this.project;
    return this.selection ?? { min: [0, 0, 0], max: [sx - 1, sy - 1, sz - 1] };
  }

  private here(): [number, number][] {
    return [[this.animIndex, this.frameIndex]];
  }

  copySelection(): void {
    const b = this.selectionOrAll();
    this.clipboard = { grid: copyRegion(this.frame, b), origin: [...b.min] };
    this.emit('selection');
  }

  cutSelection(): void {
    this.copySelection();
    const b = this.selectionOrAll();
    this.transaction('cut', () => fillRegion(this.frame, b, 0), { frames: this.here() });
  }

  deleteSelection(): void {
    const b = this.selectionOrAll();
    this.transaction('delete', () => fillRegion(this.frame, b, 0), { frames: this.here() });
  }

  fillSelection(): void {
    if (!this.selection) return;
    const b = this.selection;
    this.transaction('fill selection', () => fillRegion(this.frame, b, this.color), { frames: this.here() });
  }

  /** Recolors only the filled voxels inside the selection. */
  paintSelection(): void {
    if (!this.selection) return;
    const b = this.selection;
    const g = this.frame;
    this.transaction(
      'paint selection',
      () => {
        for (let y = b.min[1]; y <= b.max[1]; y++)
          for (let z = b.min[2]; z <= b.max[2]; z++)
            for (let x = b.min[0]; x <= b.max[0]; x++) if (g.get(x, y, z)) g.set(x, y, z, this.color);
      },
      { frames: this.here() },
    );
  }

  paste(): void {
    const clip = this.clipboard;
    if (!clip) return;
    const at: Vec3 = this.selection ? [...this.selection.min] : [...clip.origin];
    this.transaction(
      'paste',
      () => {
        pasteRegion(this.frame, clip.grid, at);
        this.selection = clampBox(this.frame, { min: at, max: [at[0] + clip.grid.sx - 1, at[1] + clip.grid.sy - 1, at[2] + clip.grid.sz - 1] });
      },
      { frames: this.here() },
    );
  }

  /** Moves the selected voxels (and the selection) by a delta. */
  moveSelection(dx: number, dy: number, dz: number): void {
    if (!this.selection) return;
    const b = this.selection;
    const g = this.frame;
    const min: Vec3 = [b.min[0] + dx, b.min[1] + dy, b.min[2] + dz];
    const max: Vec3 = [b.max[0] + dx, b.max[1] + dy, b.max[2] + dz];
    if (max[0] < 0 || max[1] < 0 || max[2] < 0 || min[0] >= g.sx || min[1] >= g.sy || min[2] >= g.sz) return;
    this.transaction(
      'move',
      () => {
        const clip = copyRegion(g, b);
        fillRegion(g, b, 0);
        pasteRegion(g, clip, min);
        this.selection = { min, max };
      },
      { frames: this.here() },
    );
  }

  flipSelection(axis: 0 | 1 | 2): void {
    if (!this.selection) return;
    const b = this.selection;
    this.transaction('flip selection', () => flipRegion(this.frame, b, axis), { frames: this.here() });
  }

  // ---- palette and color schemes ---------------------------------------------

  setPaletteColor(i: number, color: number, live = false): void {
    if (i < 1 || i >= this.project.palette.length) return;
    if (live) this.liveEdit(() => (this.project.palette[i] = color), 'palette');
    else this.transaction('edit color', () => (this.project.palette[i] = color));
  }

  addPaletteColor(color: number): void {
    if (this.project.palette.length > MAX_COLORS) return;
    this.transaction('add color', () => {
      this.project.palette.push(color);
      this.color = this.project.palette.length - 1;
    });
  }

  /** Removes palette entries no frame uses and compacts indices. */
  removeUnusedColors(): void {
    const used = new Uint8Array(256);
    for (const a of this.project.animations) for (const f of a.frames) for (const v of f.data) used[v] = 1;
    const pal = this.project.palette;
    const map = new Uint8Array(256);
    const keep: number[] = [0];
    for (let i = 1; i < pal.length; i++)
      if (used[i]) {
        map[i] = keep.length;
        keep.push(i);
      }
    if (keep.length === pal.length) return;
    this.transaction(
      'remove unused colors',
      () => {
        for (const a of this.project.animations) for (const f of a.frames) for (let i = 0; i < f.data.length; i++) f.data[i] = map[f.data[i]];
        for (const v of this.project.variants) v.palette = keep.map((k) => (k === 0 ? 0 : v.palette[k] ?? pal[k]));
        this.color = Math.max(1, map[this.color] || 1);
      },
      { frames: this.allFrameRefs() },
    );
  }

  /**
   * Applies an imported palette. 'replace': colors replace entries by index;
   * 'remap': the palette is replaced and voxels move to their closest color;
   * 'variant': added as a new color scheme; 'append': added to the end.
   */
  importPalette(colors: number[], mode: 'replace' | 'remap' | 'variant' | 'append', name = 'imported'): void {
    if (colors.length === 0) return;
    const p = this.project;
    if (mode === 'variant') {
      this.transaction('add color scheme', () => {
        const pal = p.palette.slice();
        colors.forEach((c, i) => {
          if (i + 1 < pal.length) pal[i + 1] = c;
          else if (pal.length <= MAX_COLORS) pal.push(c);
        });
        p.variants.push({ name, palette: pal });
        p.activeVariant = p.variants.length - 1;
      });
    } else if (mode === 'remap') {
      const next = [0, ...colors.slice(0, MAX_COLORS)];
      const table = remapTable(p.palette, next);
      this.transaction(
        'remap palette',
        () => {
          for (const a of p.animations) for (const f of a.frames) for (let i = 0; i < f.data.length; i++) if (f.data[i]) f.data[i] = table[f.data[i]];
          p.palette = next;
          this.color = 1;
        },
        { frames: this.allFrameRefs() },
      );
    } else {
      this.transaction('import palette', () => {
        const pal = p.palette;
        colors.forEach((c, i) => {
          if (mode === 'replace' && i + 1 < pal.length) pal[i + 1] = c;
          else if (pal.length <= MAX_COLORS) pal.push(c);
        });
      });
    }
  }

  switchVariant(i: number): void {
    if (i === this.project.activeVariant || !this.project.variants[i]) return;
    this.transaction('switch color scheme', () => {
      this.project.activeVariant = i;
      const pal = this.project.palette;
      // Fill indices the scheme lacks so every voxel still has a color
      const base = this.project.variants.reduce((a, v) => (v.palette.length > a.length ? v.palette : a), pal);
      for (let k = pal.length; k < base.length; k++) pal.push(base[k]);
    });
  }

  addVariant(name: string): void {
    this.transaction('add color scheme', () => {
      this.project.variants.push({ name, palette: this.project.palette.slice() });
      this.project.activeVariant = this.project.variants.length - 1;
    });
  }

  renameVariant(name: string): void {
    this.transaction('rename color scheme', () => (this.project.variants[this.project.activeVariant].name = name));
  }

  deleteVariant(): void {
    if (this.project.variants.length <= 1) return;
    this.transaction('delete color scheme', () => {
      this.project.variants.splice(this.project.activeVariant, 1);
      this.project.activeVariant = Math.max(0, this.project.activeVariant - 1);
    });
  }

  // ---- procedural generation -----------------------------------------------

  generate(gen: Generator, params: ParamValues, seed: number, target: GenTarget, frames = 8): void {
    const p = this.project;
    const size: [number, number, number] = [p.sx, p.sy, p.sz];
    const palette = p.palette.slice();
    const n = target === 'animation' ? Math.max(1, Math.min(120, Math.floor(frames))) : 1;
    const grids: VoxelGrid[] = [];
    for (let i = 0; i < n; i++)
      grids.push(
        target === 'animation'
          ? runGenerator(gen, params, size, palette, { seed, t: i / n, frame: i, frameCount: n })
          : runGenerator(gen, params, size, palette, { seed, base: target === 'merge' ? this.frame : undefined }),
      );
    this.applyGenerated(grids, palette, target, typeof gen.name === 'string' ? gen.name : gen.id);
  }

  /**
   * Commits generator output: the first grid replaces the current frame, or
   * all grids become a new animation. `palette` is the palette the generator
   * ran with (it may have added colors).
   */
  applyGenerated(grids: VoxelGrid[], palette: number[], target: GenTarget, name: string): void {
    const p = this.project;
    if (!grids.length) return;
    if (target === 'animation') {
      this.transaction('generate animation', () => {
        p.palette = palette.slice();
        p.animations.push({ name: uniqueName(name, p.animations.map((a) => a.name)), fps: this.anim.fps, frames: grids });
        this.animIndex = p.animations.length - 1;
        this.frameIndex = 0;
      });
      return;
    }
    this.transaction(
      'generate',
      () => {
        p.palette = palette.slice();
        this.frame.data.set(grids[0].data);
      },
      { frames: this.here() },
    );
  }

  /** Puts a model built elsewhere (image import, VOX) into the current frame, resized to fit. */
  replaceFrameWith(grid: VoxelGrid, palette?: number[]): void {
    const p = this.project;
    const g = grid.sx === p.sx && grid.sy === p.sy && grid.sz === p.sz ? grid : grid.resized(p.sx, p.sy, p.sz, 'center');
    this.transaction(
      'import',
      () => {
        if (palette) p.palette = palette;
        this.frame.data.set(g.data);
      },
      { frames: this.here() },
    );
  }

  // ---- parts and skeletal animation ----------------------------------------

  /** The rig, created first (as its own undo step) if the model has none. */
  private ensureRig(): Rig {
    if (!this.project.rig) this.enableRig();
    return this.project.rig!;
  }

  enableRig(): void {
    if (this.project.rig) return;
    this.transaction('enable parts', () => {
      const p = this.project;
      p.rig = createRig(p.sx, p.sy, p.sz);
      p.rig.source = { anim: this.animIndex, frame: this.frameIndex };
    });
    this.partOverlay = true;
    this.emit('state');
  }

  addPart(name: string): number {
    let id = -1;
    this.ensureRig();
    this.transaction('add part', () => {
      id = addPart(this.project.rig!, name, undefined, this.activePart >= 0 ? this.activePart : 0);
      if (id >= 0) this.activePart = id;
    });
    return id;
  }

  removePart(id: number): void {
    if (!this.project.rig || id === 0) return;
    this.transaction('remove part', () => removePart(this.project.rig!, id), { partMap: true });
    if (this.activePart === id) this.activePart = 0;
    this.emit('rig');
  }

  updatePart(id: number, patch: { name?: string; color?: number; pivot?: V3; parent?: number }, live = false): void {
    const rig = this.project.rig;
    if (!rig) return;
    if (patch.parent !== undefined && (id === 0 || wouldCycle(rig, id, patch.parent))) delete patch.parent;
    const apply = () => {
      const part = getPart(this.project.rig!, id);
      if (part) Object.assign(part, patch);
    };
    if (live) this.liveEdit(apply, 'rig');
    else this.transaction('edit part', apply);
  }

  setActivePart(id: number): void {
    this.activePart = id;
    this.emit('rig');
  }

  /** Assigns voxels connected to `c` with the same color to the active part. */
  assignConnectedToPart(c: Vec3): void {
    const g = this.frame;
    if (!g.get(c[0], c[1], c[2])) return;
    const rig = this.ensureRig();
    const cells = floodCells(g, c, false);
    this.transaction('assign part', () => {
      for (const p of cells) rig.partMap.set(p[0], p[1], p[2], this.activePart);
    }, { partMap: true });
  }

  assignSelectionToPart(): void {
    if (!this.selection) return;
    const rig = this.ensureRig();
    const b = this.selection;
    const g = this.frame;
    this.transaction('assign part', () => {
      for (let y = b.min[1]; y <= b.max[1]; y++)
        for (let z = b.min[2]; z <= b.max[2]; z++)
          for (let x = b.min[0]; x <= b.max[0]; x++) if (g.get(x, y, z)) rig.partMap.set(x, y, z, this.activePart);
    }, { partMap: true });
  }

  setRigSource(anim: number, frame: number): void {
    if (!this.project.rig) return;
    this.transaction('rig source', () => (this.project.rig!.source = { anim, frame }));
  }

  rigSourceGrid(): VoxelGrid {
    const p = this.project;
    const s = p.rig?.source ?? { anim: 0, frame: 0 };
    const a = p.animations[Math.min(s.anim, p.animations.length - 1)];
    return a.frames[Math.min(s.frame, a.frames.length - 1)];
  }

  addRigAnimation(name: string): number {
    this.ensureRig();
    this.transaction('add rig animation', () => {
      this.project.rig!.animations.push({ name, fps: 8, length: 8, loop: true, easing: 'smooth', tracks: [] });
    });
    return this.project.rig!.animations.length - 1;
  }

  removeRigAnimation(i: number): void {
    if (!this.project.rig) return;
    this.transaction('remove rig animation', () => this.project.rig!.animations.splice(i, 1));
  }

  /** Edits a rig animation (keys, settings). `live` merges slider drags into one undo step. */
  editRigAnimation(i: number, mutate: (a: RigAnimation) => void, live = false): void {
    const rig = this.project.rig;
    if (!rig || !rig.animations[i]) return;
    if (live) this.liveEdit(() => mutate(this.project.rig!.animations[i]), 'rig');
    else this.transaction('edit rig animation', () => mutate(this.project.rig!.animations[i]));
  }

  /** Bakes a rig animation into voxel frames: replaces the animation with the same name or adds one. */
  bakeRigAnimation(i: number): void {
    const p = this.project;
    const rig = p.rig;
    if (!rig || !rig.animations[i]) return;
    const ra = rig.animations[i];
    const frames = bakeAnimation(this.rigSourceGrid(), rig, ra);
    this.transaction('bake animation', () => {
      // Re-baking replaces the earlier result, but never the animation holding the rest pose
      const existing = p.animations.findIndex((a, k) => a.name === ra.name && k !== rig.source.anim);
      if (existing >= 0) {
        p.animations[existing] = { name: ra.name, fps: ra.fps, frames };
        this.animIndex = existing;
      } else {
        p.animations.push({ name: uniqueName(ra.name, p.animations.map((a) => a.name)), fps: ra.fps, frames });
        this.animIndex = p.animations.length - 1;
      }
      this.frameIndex = 0;
    });
  }

  // ---- playback -----------------------------------------------------------

  play(): void {
    if (this.playing) return;
    this.playing = true;
    const tick = () => {
      const n = this.anim.frames.length;
      this.frameIndex = (this.frameIndex + 1) % n;
      this.emit('frame');
    };
    this.playTimer = window.setInterval(tick, 1000 / this.anim.fps);
    this.emit('state');
  }

  stop(): void {
    if (!this.playing) return;
    this.playing = false;
    if (this.playTimer !== null) window.clearInterval(this.playTimer);
    this.playTimer = null;
    this.emit('state');
  }

  togglePlay(): void {
    if (this.playing) this.stop();
    else this.play();
  }
}

export function uniqueName(base: string, taken: string[]): string {
  if (!taken.includes(base)) return base;
  for (let i = 2; ; i++) if (!taken.includes(`${base} ${i}`)) return `${base} ${i}`;
}
