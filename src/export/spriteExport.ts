import type { Project } from '../core/Project';
import type { VoxelGrid } from '../core/VoxelGrid';
import type { LightSettings } from '../core/lighting';
import { renderSlices, renderStack, type RenderPass } from './stackRenderer';
import { packSheet, scaleImage, trimCommon, type RgbaImage, type SheetFrame } from './image';

/** Everything the sprite export dialog lets the user choose. */
export interface SpriteSettings {
  method: 'stack' | '3d' | 'slices';
  angles: number;
  startAngle: number;
  spacing: number;
  squash: number;
  size: number;
  elevation: number;
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
  squash: 1,
  size: 64,
  elevation: 35,
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
  const anims = s.scope === 'anim' ? [p.animations[animIndex]] : p.animations;
  return anims.flatMap((a) => a.frames.map((grid, index) => ({ anim: a.name, index, fps: a.fps, grid })));
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
  return renderStack(grid, palette, {
    angle,
    spacing: s.spacing,
    squash: s.squash,
    scale: 1,
    outline: s.outline ? hex(s.outlineColor) : null,
    light: s.useLight ? light : null,
    shading: true,
    padding: s.useLight && light.groundShadow ? Math.ceil(grid.sy / 2) : 1,
    pass,
  });
}

/** Output of one export: named files ready to save or zip. */
export interface ExportFile {
  name: string;
  image?: RgbaImage;
  text?: string;
  /** GIF frames + delay, encoded by the caller. */
  gif?: { frames: RgbaImage[]; delay: number };
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
    const seq = turntable ? angles.map((a) => ({ grid: frames[0].grid, angle: a })) : frames.map((f) => ({ grid: f.grid, angle: s.startAngle }));
    const delay = turntable ? s.gifDelay : Math.round(1000 / Math.max(1, frames[0]?.fps ?? 8));
    let preview: RgbaImage[] = [];
    for (const sc of schemes) {
      const imgs: RgbaImage[] = [];
      for (const q of seq.slice(0, Math.min(seq.length, limit))) {
        imgs.push(renderCell(q.grid, sc.palette, q.angle, 'color', s, light, render3d));
        await tick();
      }
      const out = (s.trim ? trimCommon(imgs, 1) : imgs).map((im) => scaleImage(im, s.scale));
      if (!preview.length) preview = out;
      files.push({ name: `${opts.baseName}${sc.name ? `_${sc.name}` : ''}.gif`, gif: { frames: out, delay } });
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
  const trimmed = s.trim ? trimCommon(cells.map((c) => c.image), 1) : cells.map((c) => c.image);
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
      for (const c of mine) files.push({ name: `${c.frame.anim}/${frameName(c.frame, c.angleIndex)}${v.suffix}.png`, image: c.image });
      if (!preview) preview = packSheet(rowsOf(mine)).image;
      continue;
    }
    const { image, frames: rects } = packSheet(rowsOf(mine));
    if (!preview) preview = image;
    const png = `${opts.baseName}${v.suffix}.png`;
    files.push({ name: png, image });
    if (s.json && v.pass === 'color') files.push({ name: `${opts.baseName}${v.suffix}.json`, text: sheetJson(png, image, rects, mine, frameName, angles, s) });
  }
  return { files, preview, cellCount: count };

  function rowsOf(list: Cell[]) {
    const rows: { name: string; images: RgbaImage[]; cells: Cell[] }[] = [];
    for (const c of list) {
      const key = `${c.frame.anim}_${c.frame.index}`;
      let r = rows.find((x) => x.name === key);
      if (!r) rows.push((r = { name: key, images: [], cells: [] }));
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
