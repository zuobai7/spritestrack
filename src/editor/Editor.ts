import { VoxelGrid } from '../core/VoxelGrid';
import { Project, type Animation } from '../core/Project';
import { History, VoxelEdit, type Command } from '../core/History';
import { mirrored } from '../core/tools';
import type { Vec3 } from '../core/raycast';
import { DEFAULT_LIGHT, type LightSettings } from '../core/lighting';
import { MAX_COLORS } from '../core/Palette';

export type Tool = 'add' | 'erase' | 'paint' | 'pick' | 'fill' | 'box' | 'line';
export type EditMode = '3d' | 'layer';
export type EditorEvent = 'project' | 'model' | 'frames' | 'frame' | 'palette' | 'state' | 'history' | 'light';

interface Snapshot {
  size: [number, number, number];
  palette: number[];
  animations: { name: string; fps: number; frames: VoxelGrid[] }[];
  animIndex: number;
  frameIndex: number;
}

/**
 * Editor state and every edit operation. UI and viewport listen to events and
 * call these methods; all changes go through the undo history.
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
  onion = false;
  showGrid = true;
  ao = true;
  light: LightSettings = { ...DEFAULT_LIGHT };
  playing = false;
  readonly history = new History(300);
  private listeners = new Map<EditorEvent, Set<() => void>>();
  private stroke: { edit: VoxelEdit; anim: number; frame: number } | null = null;
  private playTimer: number | null = null;
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
    if (ev === 'model' || ev === 'frames' || ev === 'palette' || ev === 'project') this.dirty = true;
    this.listeners.get(ev)?.forEach((fn) => fn());
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

  setProject(p: Project): void {
    this.stop();
    this.project = p;
    this.animIndex = 0;
    this.frameIndex = 0;
    this.layer = Math.min(this.layer, p.sy - 1);
    this.color = Math.min(this.color, p.palette.length - 1);
    this.history.clear();
    this.emit('project');
    this.dirty = false;
  }

  // ---- state setters ------------------------------------------------------

  setTool(t: Tool): void {
    this.tool = t;
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

  selectFrame(anim: number, frame: number): void {
    this.animIndex = Math.max(0, Math.min(this.project.animations.length - 1, anim));
    this.frameIndex = Math.max(0, Math.min(this.anim.frames.length - 1, frame));
    this.emit('frame');
  }

  setLight(patch: Partial<LightSettings>): void {
    Object.assign(this.light, patch);
    this.emit('light');
  }

  // ---- voxel strokes ------------------------------------------------------

  beginStroke(): void {
    this.stroke = { edit: new VoxelEdit(this.frame.data), anim: this.animIndex, frame: this.frameIndex };
  }

  /** Sets cells (with mirroring) inside the current stroke. Returns true if anything changed. */
  strokeSet(cells: Vec3[], value: number): boolean {
    if (!this.stroke) this.beginStroke();
    const g = this.frame;
    let changed = false;
    for (const c of cells)
      for (const m of mirrored(g, c, this.mirror)) {
        if (!g.inBounds(m[0], m[1], m[2])) continue;
        if (this.stroke!.edit.set(g.index(m[0], m[1], m[2]), value)) changed = true;
      }
    if (changed) this.emit('model');
    return changed;
  }

  endStroke(label: string): void {
    const s = this.stroke;
    this.stroke = null;
    if (!s) return;
    const cmd = s.edit.toCommand(
      label,
      () => this.project.animations[s.anim].frames[s.frame].data,
      () => {
        if (this.animIndex !== s.anim || this.frameIndex !== s.frame) this.selectFrame(s.anim, s.frame);
        this.emit('model');
      },
    );
    if (cmd) this.history.push(cmd);
  }

  /** One-shot edit of a set of cells. */
  applyCells(cells: Vec3[], value: number, label: string): void {
    this.beginStroke();
    this.strokeSet(cells, value);
    this.endStroke(label);
  }

  // ---- structural edits (snapshot-based undo) -----------------------------

  private snapshot(): Snapshot {
    const p = this.project;
    return {
      size: [p.sx, p.sy, p.sz],
      palette: p.palette.slice(),
      animations: p.animations.map((a) => ({ name: a.name, fps: a.fps, frames: a.frames.map((f) => f.clone()) })),
      animIndex: this.animIndex,
      frameIndex: this.frameIndex,
    };
  }

  private restore(s: Snapshot): void {
    const p = this.project;
    [p.sx, p.sy, p.sz] = s.size;
    p.palette = s.palette.slice();
    p.animations = s.animations.map((a) => ({ name: a.name, fps: a.fps, frames: a.frames.map((f) => f.clone()) }));
    this.animIndex = Math.min(s.animIndex, p.animations.length - 1);
    this.frameIndex = Math.min(s.frameIndex, this.anim.frames.length - 1);
    this.layer = Math.min(this.layer, p.sy - 1);
    this.color = Math.min(this.color, p.palette.length - 1);
    this.emit('palette');
    this.emit('frames');
    this.emit('frame');
    this.emit('model');
  }

  /** Runs `mutate` and records an undo step that restores the whole project. */
  structural(label: string, mutate: () => void): void {
    this.stop();
    const before = this.snapshot();
    mutate();
    const after = this.snapshot();
    const cmd: Command = {
      label,
      undo: () => this.restore(before),
      redo: () => this.restore(after),
    };
    this.history.push(cmd);
    this.restore(after);
  }

  addFrame(duplicate: boolean): void {
    this.structural('add frame', () => {
      const f = duplicate ? this.frame.clone() : new VoxelGrid(this.project.sx, this.project.sy, this.project.sz);
      this.anim.frames.splice(this.frameIndex + 1, 0, f);
      this.frameIndex++;
    });
  }

  deleteFrame(): void {
    if (this.anim.frames.length <= 1) return;
    this.structural('delete frame', () => {
      this.anim.frames.splice(this.frameIndex, 1);
      this.frameIndex = Math.min(this.frameIndex, this.anim.frames.length - 1);
    });
  }

  moveFrame(delta: number): void {
    const to = this.frameIndex + delta;
    if (to < 0 || to >= this.anim.frames.length) return;
    this.structural('move frame', () => {
      const f = this.anim.frames;
      [f[this.frameIndex], f[to]] = [f[to], f[this.frameIndex]];
      this.frameIndex = to;
    });
  }

  addAnimation(name: string): void {
    this.structural('add animation', () => {
      this.project.animations.push({ name, fps: this.anim.fps, frames: [this.frame.clone()] });
      this.animIndex = this.project.animations.length - 1;
      this.frameIndex = 0;
    });
  }

  deleteAnimation(): void {
    if (this.project.animations.length <= 1) return;
    this.structural('delete animation', () => {
      this.project.animations.splice(this.animIndex, 1);
      this.animIndex = Math.max(0, this.animIndex - 1);
      this.frameIndex = 0;
    });
  }

  renameAnimation(name: string): void {
    this.structural('rename animation', () => {
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
    this.structural('resize', () => this.project.resize(sx, sy, sz, 'center'));
    this.emit('project');
  }

  transform(kind: 'flipX' | 'flipY' | 'flipZ' | 'rotate' | 'clear', allFrames: boolean): void {
    this.structural(kind, () => {
      const frames = allFrames ? this.anim.frames : [this.frame];
      if (kind === 'rotate' && this.project.sx !== this.project.sz) {
        // Rotation swaps x and z: rotate every frame of every animation to keep sizes consistent
        for (const a of this.project.animations) a.frames = a.frames.map((f) => f.rotatedY());
        [this.project.sx, this.project.sz] = [this.project.sz, this.project.sx];
        return;
      }
      for (const f of frames) {
        if (kind === 'flipX') f.flip('x');
        else if (kind === 'flipY') f.flip('y');
        else if (kind === 'flipZ') f.flip('z');
        else if (kind === 'clear') f.data.fill(0);
        else if (kind === 'rotate') f.data.set(f.rotatedY().data);
      }
    });
  }

  shiftFrame(dx: number, dy: number, dz: number): void {
    this.structural('shift', () => this.frame.shift(dx, dy, dz));
  }

  // ---- palette ------------------------------------------------------------

  setPaletteColor(i: number, color: number): void {
    if (i < 1 || i >= this.project.palette.length) return;
    this.structural('edit color', () => {
      this.project.palette[i] = color;
    });
  }

  addPaletteColor(color: number): void {
    if (this.project.palette.length > MAX_COLORS) return;
    this.structural('add color', () => {
      this.project.palette.push(color);
      this.color = this.project.palette.length - 1;
    });
  }

  /** Replaces the whole palette and remaps voxel indices (used by generators and imports). */
  replaceFramesAndPalette(label: string, mutate: () => void): void {
    this.structural(label, mutate);
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
