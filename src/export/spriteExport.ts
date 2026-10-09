import type { Project } from '../core/Project';
import type { VoxelGrid } from '../core/VoxelGrid';
import { shadowReach, type LightSettings } from '../core/lighting';
import { renderSlices, renderStack, type RenderPass } from './stackRenderer';
import { packSheet, scaleImage, trimCommon, type RgbaImage, type SheetFrame } from './image';

/** Everything the sprite export dialog lets the user choose. */
export interface SpriteSettings {
  method: 'stack' | '3d' | 'slices';
  angles: number;
  startAngle: number;
  /** Layer thickness of the sprite stack (1 = one pixel per layer at a 45° view). */
  spacing: number;
  /** View angle on the 0–180 scale shown in the dialog, see `viewElevation`. */
  view: number;
  size: number;
  ortho: boolean;
  scale: number;
  outline: boolean;
  outlineColor: string;
  useLight: boolean;
  trim: boolean;
  scope: 'frame' | 'anim' | 'all';
  normal: boolean;
  depth: boolean;
  allSchemes: boolean;
  output: 'sheet' | 'zip' | 'gif';
  json: boolean;
  gifContent: 'animation' | 'turntable';
  gifBackground: 'transparent' | 'color';
  gifColor: string;
  gifDelay: number;
  sliceDir: 'horizontal' | 'vertical';
}

export const DEFAULT_SPRITE_SETTINGS: SpriteSettings = {
  method: 'stack',
  angles: 8,
  startAngle: 0,
  spacing: 1,
  view: 135,
  size: 64,
  ortho: true,
  scale: 2,
  outline: false,
  outlineColor: '#181425',
  useLight: true,
  trim: true,
  scope: 'anim',
  normal: false,
  depth: false,
  allSchemes: false,
  output: 'sheet',
  json: true,
  gifContent: 'animation',
  gifBackground: 'transparent',
  gifColor: '#262b44',
  gifDelay: 80,
  sliceDir: 'horizontal',
};

export interface FrameRef {
  /** Animation name, made unique within the export (names key rows, files and JSON frames). */
  anim: string;
  index: number;
  fps: number;
  grid: VoxelGrid;
}

export type Render3d = (grid: VoxelGrid, palette: number[], angle: number, pass: RenderPass) => RgbaImage;

export function framesFor(p: Project, s: SpriteSettings, animIndex: number, frameIndex: number): FrameRef[] {
  if (s.scope === 'frame') {
    const a = p.animations[animIndex];
    return [{ anim: a.name, index: frameIndex, fps: a.fps, grid: a.frames[frameIndex] }];
  }
  if (s.scope === 'anim') {
    const a = p.animations[animIndex];
    return a.frames.map((grid, index) => ({ anim: a.name, index, fps: a.fps, grid }));
  }
  const names = uniqueNames(p.animations.map((a) => a.name));
  return p.animations.flatMap((a, ai) => a.frames.map((grid, index) => ({ anim: names[ai], index, fps: a.fps, grid })));
}

/** Names with repeats numbered ("walk", "walk 2"), so they can serve as keys. */
export function uniqueNames(names: string[]): string[] {
  const out: string[] = [];
  for (const n of names) {
    let name = n || 'anim';
    for (let i = 2; out.includes(name); i++) name = `${n || 'anim'} ${i}`;
    out.push(name);
  }
  return out;
}

export function anglesFor(s: SpriteSettings): number[] {
  if (s.method === 'slices') return [0];
  const n = Math.max(1, Math.min(64, Math.floor(s.angles)));
  return Array.from({ length: n }, (_, i) => (s.startAngle + (360 * i) / n) % 360);
}

export function passesFor(s: SpriteSettings): RenderPass[] {
  const out: RenderPass[] = ['color'];
  if (s.method !== 'slices' && s.output !== 'gif') {
    if (s.normal) out.push('normal');
    if (s.depth) out.push('depth');
  }
  return out;
}

export function schemesFor(p: Project, s: SpriteSettings): { name: string; palette: number[] }[] {
  if (!s.allSchemes || p.variants.length < 2) return [{ name: '', palette: p.palette }];
  return p.variants.map((v, i) => ({ name: v.name, palette: p.variantPalette(i) }));
}

const hex = (s: string) => parseInt(s.replace('#', ''), 16) & 0xffffff;

/** A name usable as a file or folder name on every system. */
const fileSafe = (name: string) => name.replace(/[\\/:*?"<>|]+/g, '_').trim() || '_';

/**
 * Camera elevation in degrees (-90 looks up from straight below, 0 is level,
 * 90 looks straight down) for a view angle on the dialog's 0–180 scale.
 */
export function viewElevation(view: number): number {
  return Math.max(-90, Math.min(90, view - 90));
}

/** View angles the sprite-stack method can draw: it has to look down onto the layers. */
export const STACK_VIEW_RANGE: [number, number] = [105, 180];

/**
 * Ground squash and layer spacing (pixels per layer) of a sprite stack seen
 * from `elevation` degrees above. The larger of the two stays one pixel per
 * voxel, so 45° gives the classic look (1 and 1) and 90° is straight top-down.
 */
export function stackProjection(elevation: number, thickness = 1): { squash: number; spacing: number } {
  const e = (Math.max(1, Math.min(90, elevation)) * Math.PI) / 180;
  const k = 1 / Math.max(Math.sin(e), Math.cos(e));
  return { squash: Math.sin(e) * k, spacing: Math.cos(e) * k * thickness };
}

/** Renders one cell at 1x (scaling happens after trimming). */
export function renderCell(
  grid: VoxelGrid,
  palette: number[],
  angle: number,
  pass: RenderPass,
  s: SpriteSettings,
  light: LightSettings,
  render3d: Render3d | null,
): RgbaImage {
  if (s.method === 'slices') return renderSlices(grid, palette, s.sliceDir, 1);
  if (s.method === '3d' && render3d) return render3d(grid, palette, angle, pass);
  const view = Math.max(STACK_VIEW_RANGE[0], Math.min(STACK_VIEW_RANGE[1], s.view));
  const { squash, spacing } = stackProjection(viewElevation(view), s.spacing);
  return renderStack(grid, palette, {
    angle,
    spacing,
    squash,
    scale: 1,
    outline: s.outline ? hex(s.outlineColor) : null,
    light: s.useLight ? light : null,
    shading: true,
    // Room for the whole ground shadow; trimming removes what's left over
    padding: s.useLight ? Math.max(1, Math.ceil(shadowReach(grid.sy, light))) : 1,
    pass,
  });
}

/** Output of one export: named files ready to save or zip. */
export interface ExportFile {
  name: string;
  image?: RgbaImage;
  text?: string;
  /** GIF frames + delay (or one delay per frame), encoded by the caller. */
  gif?: { frames: RgbaImage[]; delay: number; delays?: number[] };
}

export interface SheetResult {
  files: ExportFile[];
  /** Image shown in the dialog preview. */
  preview: RgbaImage | null;
  previewFrames?: RgbaImage[];
  previewDelay?: number;
  cellCount: number;
}

/**
 * Builds every image the current settings describe. `limit` caps the number
 * of cells (for quick previews). Yields to the browser regularly so the UI
 * stays responsive; `onProgress` gets a 0..1 fraction.
 */
export async function buildSprites(
  p: Project,
  s: SpriteSettings,
  light: LightSettings,
  animIndex: number,
  frameIndex: number,
  render3d: Render3d | null,
  opts: { limit?: number; onProgress?: (f: number) => void; baseName: string },
): Promise<SheetResult> {
  const frames = framesFor(p, s, animIndex, frameIndex);
  const angles = anglesFor(s);
  const passes = passesFor(s);
  const schemes = schemesFor(p, s);
  const limit = opts.limit ?? Infinity;
  // A slice strip must keep equal slices, so it is never trimmed
  const trim = s.trim && s.method !== 'slices';
  const files: ExportFile[] = [];
  let done = 0;
  const total = frames.length * angles.length * passes.length * schemes.length;
  const tick = async () => {
    done++;
    if (done % 6 === 0) {
      opts.onProgress?.(done / total);
      await new Promise((r) => setTimeout(r));
    }
  };

  if (s.output === 'gif') {
    const turntable = s.gifContent === 'turntable';
    const seq = turntable
      ? angles.map((a) => ({ grid: frames[0].grid, angle: a, fps: 0 }))
      : frames.map((f) => ({ grid: f.grid, angle: s.startAngle, fps: f.fps }));
    const delay = turntable ? s.gifDelay : Math.round(1000 / Math.max(1, frames[0]?.fps ?? 8));
    // Each animation plays at its own frame rate
    const delays = turntable ? undefined : seq.map((q) => Math.round(1000 / Math.max(1, q.fps)));
    let preview: RgbaImage[] = [];
    for (const sc of schemes) {
      const imgs: RgbaImage[] = [];
      for (const q of seq.slice(0, Math.min(seq.length, limit))) {
        imgs.push(renderCell(q.grid, sc.palette, q.angle, 'color', s, light, render3d));
        await tick();
      }
      const out = (trim ? trimCommon(imgs, 1) : imgs).map((im) => scaleImage(im, s.scale));
      if (!preview.length) preview = out;
      files.push({ name: `${opts.baseName}${sc.name ? `_${sc.name}` : ''}.gif`, gif: { frames: out, delay, delays } });
    }
    return { files, preview: preview[0] ?? null, previewFrames: preview, previewDelay: delay, cellCount: seq.length };
  }

  // Render every cell of every pass and scheme, then trim them together so all sheets line up
  type Cell = { frame: FrameRef; angleIndex: number; pass: RenderPass; scheme: number; image: RgbaImage };
  const cells: Cell[] = [];
  let count = 0;
  outer: for (const frame of frames)
    for (let ai = 0; ai < angles.length; ai++) {
      if (count >= limit) break outer;
      count++;
      for (const pass of passes)
        for (let si = 0; si < schemes.length; si++) {
          // Normal and depth maps don't depend on colors: render them once
          if (pass !== 'color' && si > 0) continue;
          cells.push({ frame, angleIndex: ai, pass, scheme: si, image: renderCell(frame.grid, schemes[si].palette, angles[ai], pass, s, light, render3d) });
          await tick();
        }
    }
  const trimmed = trim ? trimCommon(cells.map((c) => c.image), 1) : cells.map((c) => c.image);
  trimmed.forEach((img, i) => (cells[i].image = scaleImage(img, s.scale)));

  const variants: { scheme: number; pass: RenderPass; suffix: string }[] = [];
  schemes.forEach((sc, si) => variants.push({ scheme: si, pass: 'color', suffix: sc.name ? `_${sc.name}` : '' }));
  for (const pass of passes) if (pass !== 'color') variants.push({ scheme: 0, pass, suffix: `_${pass}` });

  const angleNames = angles.map((_, i) => (s.method === 'slices' ? '' : `_a${i}`));
  const frameName = (f: FrameRef, ai: number) => `${f.anim}_${f.index}${angleNames[ai]}`;
  let preview: RgbaImage | null = null;

  for (const v of variants) {
    const mine = cells.filter((c) => c.scheme === v.scheme && c.pass === v.pass);
    if (s.output === 'zip') {
      for (const c of mine) files.push({ name: `${fileSafe(c.frame.anim)}/${fileSafe(frameName(c.frame, c.angleIndex))}${v.suffix}.png`, image: c.image });
      if (!preview) preview = packSheet(rowsOf(mine)).image;
      continue;
    }
    const rows = rowsOf(mine);
    const { image, frames: rects } = packSheet(rows);
    if (!preview) preview = image;
    const png = `${opts.baseName}${v.suffix}.png`;
    files.push({ name: png, image });
    const placed = rows.flatMap((r) => r.cells);
    if (s.json && v.pass === 'color') files.push({ name: `${opts.baseName}${v.suffix}.json`, text: sheetJson(png, image, rects, placed, frameName, angles, s) });
  }
  return { files, preview, cellCount: count };

  function rowsOf(list: Cell[]) {
    // One row per frame (all its angles)
    const rows: { name: string; frame: FrameRef; images: RgbaImage[]; cells: Cell[] }[] = [];
    for (const c of list) {
      let r = rows.find((x) => x.frame === c.frame);
      if (!r) rows.push((r = { name: `${c.frame.anim}_${c.frame.index}`, frame: c.frame, images: [], cells: [] }));
      r.images.push(c.image);
      r.cells.push(c);
    }
    return rows;
  }
}

/**
 * Sprite sheet metadata in the JSON-hash format read by Phaser, PixiJS and
 * most engines' importers, plus per-angle animation lists.
 */
function sheetJson(
  imageName: string,
  image: RgbaImage,
  rects: SheetFrame[],
  cells: { frame: FrameRef; angleIndex: number }[],
  frameName: (f: FrameRef, ai: number) => string,
  angles: number[],
  s: SpriteSettings,
): string {
  const frames: Record<string, unknown> = {};
  const animations: Record<string, string[]> = {};
  rects.forEach((r, i) => {
    const c = cells[i];
    const name = frameName(c.frame, c.angleIndex);
    frames[name] = {
      frame: { x: r.x, y: r.y, w: r.w, h: r.h },
      rotated: false,
      trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w: r.w, h: r.h },
      sourceSize: { w: r.w, h: r.h },
      duration: Math.round(1000 / Math.max(1, c.frame.fps)),
    };
    const key = s.method === 'slices' ? c.frame.anim : `${c.frame.anim}_a${c.angleIndex}`;
    (animations[key] ??= []).push(name);
  });
  return JSON.stringify(
    {
      frames,
      animations,
      meta: {
        app: 'SpriteStrack',
        version: '1',
        image: imageName,
        format: 'RGBA8888',
        size: { w: image.width, h: image.height },
        scale: '1',
        angles,
        method: s.method,
      },
    },
    null,
    1,
  );
}
