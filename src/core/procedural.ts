import { VoxelGrid } from './VoxelGrid';
import { MAX_COLORS, rgb } from './Palette';
import { mulberry32, Perlin } from './noise';

/**
 * Procedural generation API.
 *
 * A generator fills a voxel grid from a few parameters. Built-in generators
 * live in this file; more can be added at runtime with `registerGenerator`
 * (also exposed as `window.SpriteStrack.registerGenerator` in the app), or
 * written as a script in the editor's Generate dialog.
 */

export type Localized = string | { zh: string; en: string };

export interface ParamDef {
  key: string;
  label: Localized;
  type: 'int' | 'number' | 'bool' | 'color' | 'select';
  default: number | boolean | string;
  min?: number;
  max?: number;
  step?: number;
  options?: { value: string; label: Localized }[];
}

export type ParamValues = Record<string, number | boolean | string>;

export interface GenContext {
  readonly sx: number;
  readonly sy: number;
  readonly sz: number;
  /** Animation time in [0, 1). 0 when generating a single frame. */
  readonly t: number;
  /** Frame number when generating an animation, else 0. */
  readonly frame: number;
  readonly frameCount: number;
  /** Seeded random float in [0, 1). */
  rand(): number;
  /** Seeded random integer in [min, max]. */
  randInt(min: number, max: number): number;
  /** Seeded Perlin noise, about [-1, 1]. */
  noise2(x: number, y: number): number;
  noise3(x: number, y: number, z: number): number;
  fbm2(x: number, y: number, octaves?: number): number;
  fbm3(x: number, y: number, z: number, octaves?: number): number;
  get(x: number, y: number, z: number): number;
  /** Sets a voxel to a palette index (0 erases). Out-of-bounds writes are ignored. */
  set(x: number, y: number, z: number, color: number): void;
  /** Fills an inclusive box. */
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, color: number): void;
  /** Fills a sphere/ellipsoid centered at (cx, cy, cz). */
  sphere(cx: number, cy: number, cz: number, rx: number, color: number, ry?: number, rz?: number): void;
  /** Palette index for a hex color like "#ff8800" or 0xff8800; adds it to the palette if missing. */
  color(c: string | number): number;
  clear(): void;
}

export interface Generator {
  id: string;
  name: Localized;
  description?: Localized;
  params: ParamDef[];
  /** True if the generator uses `ctx.t`, so generating an animation makes sense. */
  animated?: boolean;
  generate(ctx: GenContext, params: ParamValues): void;
}

const registry = new Map<string, Generator>();
const listeners = new Set<() => void>();

export function registerGenerator(g: Generator): void {
  if (!g || typeof g.id !== 'string' || typeof g.generate !== 'function') throw new Error('Invalid generator');
  registry.set(g.id, { ...g, params: g.params ?? [] });
  listeners.forEach((l) => l());
}

export function getGenerators(): Generator[] {
  return [...registry.values()];
}

export function getGenerator(id: string): Generator | undefined {
  return registry.get(id);
}

export function onGeneratorsChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function defaultParams(g: Generator): ParamValues {
  const out: ParamValues = {};
  for (const p of g.params) out[p.key] = p.default;
  return out;
}

export interface RunOptions {
  seed: number;
  t?: number;
  frame?: number;
  frameCount?: number;
  /** Start from this grid's content (merge) instead of an empty grid. */
  base?: VoxelGrid;
}

/**
 * Runs a generator into a fresh grid. `palette` may grow when the generator
 * asks for colors it doesn't contain.
 */
export function runGenerator(
  g: Generator,
  params: ParamValues,
  size: [number, number, number],
  palette: number[],
  opts: RunOptions,
): VoxelGrid {
  const [sx, sy, sz] = size;
  const grid = opts.base ? opts.base.clone() : new VoxelGrid(sx, sy, sz);
  const rand = mulberry32(opts.seed);
  const perlin = new Perlin(opts.seed);
  const colorCache = new Map<number, number>();
  const ctx: GenContext = {
    sx,
    sy,
    sz,
    t: opts.t ?? 0,
    frame: opts.frame ?? 0,
    frameCount: opts.frameCount ?? 1,
    rand,
    randInt: (min, max) => min + Math.floor(rand() * (max - min + 1)),
    noise2: (x, y) => perlin.noise2(x, y),
    noise3: (x, y, z) => perlin.noise3(x, y, z),
    fbm2: (x, y, o) => perlin.fbm2(x, y, o),
    fbm3: (x, y, z, o) => perlin.fbm3(x, y, z, o),
    get: (x, y, z) => grid.get(Math.floor(x), Math.floor(y), Math.floor(z)),
    set: (x, y, z, c) => grid.set(Math.floor(x), Math.floor(y), Math.floor(z), c | 0),
    box(x0, y0, z0, x1, y1, z1, c) {
      // Corners are floored like set(), so fractional coordinates still fill whole voxels
      const lo = (a: number, b: number) => Math.max(0, Math.floor(Math.min(a, b)));
      const hi = (a: number, b: number, n: number) => Math.min(n - 1, Math.floor(Math.max(a, b)));
      for (let y = lo(y0, y1); y <= hi(y0, y1, sy); y++)
        for (let z = lo(z0, z1); z <= hi(z0, z1, sz); z++) for (let x = lo(x0, x1); x <= hi(x0, x1, sx); x++) grid.set(x, y, z, c | 0);
    },
    sphere(cx, cy, cz, rx, c, ry = rx, rz = rx) {
      for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++)
        for (let z = Math.floor(cz - rz); z <= Math.ceil(cz + rz); z++)
          for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
            const dx = (x + 0.5 - cx) / rx;
            const dy = (y + 0.5 - cy) / ry;
            const dz = (z + 0.5 - cz) / rz;
            if (dx * dx + dy * dy + dz * dz <= 1) grid.set(x, y, z, c);
          }
    },
    color(c) {
      const n = typeof c === 'number' ? c & 0xffffff : parseInt(String(c).replace('#', ''), 16) & 0xffffff;
      const cached = colorCache.get(n);
      if (cached !== undefined) return cached;
      let idx = palette.indexOf(n, 1);
      if (idx < 0) {
        if (palette.length <= MAX_COLORS) {
          palette.push(n);
          idx = palette.length - 1;
        } else {
          const [r, g2, b] = rgb(n);
          let best = 1;
          let bestD = Infinity;
          for (let i = 1; i < palette.length; i++) {
            const [pr, pg, pb] = rgb(palette[i]);
            const d = (pr - r) ** 2 + (pg - g2) ** 2 + (pb - b) ** 2;
            if (d < bestD) {
              bestD = d;
              best = i;
            }
          }
          idx = best;
        }
      }
      colorCache.set(n, idx);
      return idx;
    },
    clear: () => grid.data.fill(0),
  };
  g.generate(ctx, params);
  return grid;
}

/** Wraps user script source as a generator. The script sees `ctx` and `params`. */
export function scriptGenerator(source: string): Generator {
  // eslint-disable-next-line no-new-func
  const fn = new Function('ctx', 'params', `"use strict";\n${source}`) as (ctx: GenContext, p: ParamValues) => void;
  return {
    id: 'script',
    name: { zh: '自定义脚本', en: 'Custom script' },
    params: [],
    animated: true,
    generate: (ctx, p) => fn(ctx, p),
  };
}

export const SCRIPT_TEMPLATE = `// ctx: sx, sy, sz, t (0..1 animation time), rand(), randInt(a,b),
//      noise2/noise3/fbm2/fbm3, get/set(x,y,z,color), box(...), sphere(...),
//      color('#rrggbb') -> palette index, clear()
// Example: a wobbly mushroom that bounces with t
const stem = ctx.color('#ead4aa');
const cap = ctx.color('#e43b44');
const dot = ctx.color('#ffffff');
const cx = ctx.sx / 2, cz = ctx.sz / 2;
const bounce = Math.round(Math.sin(ctx.t * Math.PI * 2) * 1.5);
const h = Math.floor(ctx.sy * 0.45) + bounce;
for (let y = 0; y < h; y++) ctx.sphere(cx, y + 0.5, cz, 2.2, stem, 0.6);
ctx.sphere(cx, h + 1, cz, ctx.sx * 0.38, cap, ctx.sy * 0.22);
for (let i = 0; i < 12; i++) {
  const a = ctx.rand() * Math.PI * 2;
  const r = ctx.sx * 0.3;
  ctx.set(cx + Math.cos(a) * r, h + 1 + ctx.rand() * 3, cz + Math.sin(a) * r, dot);
}
`;

// ---------------------------------------------------------------------------
// Built-in generators

const L = (zh: string, en: string) => ({ zh, en });

registerGenerator({
  id: 'terrain',
  name: L('地形', 'Terrain'),
  description: L('噪声高度图地形，带水面、岩石和雪顶', 'Noise heightmap with water, rock and snow'),
  animated: true,
  params: [
    { key: 'scale', label: L('噪声缩放', 'Noise scale'), type: 'number', default: 0.08, min: 0.01, max: 0.5, step: 0.01 },
    { key: 'height', label: L('高度', 'Height'), type: 'number', default: 0.7, min: 0.1, max: 1, step: 0.05 },
    { key: 'water', label: L('水位', 'Water level'), type: 'number', default: 0.25, min: 0, max: 1, step: 0.05 },
    { key: 'island', label: L('岛屿形状', 'Island shape'), type: 'bool', default: true },
    { key: 'waves', label: L('动画水波', 'Animated waves'), type: 'bool', default: true },
  ],
  generate(ctx, p) {
    const grass = ctx.color('#63c74d');
    const dirt = ctx.color('#b86f50');
    const sand = ctx.color('#ead4aa');
    const stone = ctx.color('#8b9bb4');
    const snow = ctx.color('#ffffff');
    const water = ctx.color('#0099db');
    const s = Number(p.scale);
    const maxH = Math.max(1, Math.floor(ctx.sy * Number(p.height)));
    const waterH = Math.floor(ctx.sy * Number(p.water));
    for (let z = 0; z < ctx.sz; z++)
      for (let x = 0; x < ctx.sx; x++) {
        let n = (ctx.fbm2(x * s, z * s, 4) + 1) / 2;
        if (p.island) {
          const dx = (x + 0.5) / ctx.sx - 0.5;
          const dz = (z + 0.5) / ctx.sz - 0.5;
          n *= Math.max(0, 1 - Math.sqrt(dx * dx + dz * dz) * 1.9);
        }
        const h = Math.max(1, Math.round(n * maxH));
        for (let y = 0; y < h; y++) {
          let c = y < h - 3 ? stone : y < h - 1 ? dirt : grass;
          if (y === h - 1 && h <= waterH + 1) c = sand;
          if (y === h - 1 && h > maxH * 0.8) c = snow;
          else if (y >= h - 2 && h > maxH * 0.65) c = stone;
          ctx.set(x, y, z, c);
        }
        const wave = p.waves ? Math.round(Math.sin(ctx.t * Math.PI * 2 + (x + z) * 0.5) * 0.5) : 0;
        for (let y = h; y < waterH + wave; y++) ctx.set(x, y, z, water);
      }
  },
});

registerGenerator({
  id: 'tree',
  name: L('树', 'Tree'),
  description: L('随机树干和树冠，可做摇摆动画', 'Random trunk and canopy, can sway'),
  animated: true,
  params: [
    { key: 'trunk', label: L('树干高度', 'Trunk height'), type: 'number', default: 0.45, min: 0.1, max: 0.9, step: 0.05 },
    { key: 'canopy', label: L('树冠大小', 'Canopy size'), type: 'number', default: 0.35, min: 0.1, max: 0.5, step: 0.05 },
    { key: 'kind', label: L('类型', 'Kind'), type: 'select', default: 'round', options: [
      { value: 'round', label: L('圆形', 'Round') },
      { value: 'pine', label: L('松树', 'Pine') },
      { value: 'palm', label: L('棕榈', 'Palm') },
    ] },
    { key: 'leaf', label: L('树叶颜色', 'Leaf color'), type: 'color', default: '#3e8948' },
    { key: 'fruit', label: L('果实', 'Fruit'), type: 'bool', default: true },
    { key: 'sway', label: L('摇摆幅度', 'Sway'), type: 'number', default: 1, min: 0, max: 3, step: 0.5 },
  ],
  generate(ctx, p) {
    const bark = ctx.color('#733e39');
    const leaf = ctx.color(String(p.leaf));
    const leafHi = ctx.color(lighten(String(p.leaf), 1.35));
    const fruit = ctx.color('#e43b44');
    const cx = ctx.sx / 2;
    const cz = ctx.sz / 2;
    const th = Math.max(2, Math.floor(ctx.sy * Number(p.trunk)));
    const r = Math.max(1.5, Math.min(ctx.sx, ctx.sz) * Number(p.canopy));
    const sway = (y: number) => Math.sin(ctx.t * Math.PI * 2) * Number(p.sway) * (y / ctx.sy);
    const tw = Math.max(1, Math.round(ctx.sx / 16));
    for (let y = 0; y < th; y++) {
      const ox = p.kind === 'palm' ? Math.sin(y / th * 1.2) * th * 0.25 : 0;
      ctx.box(Math.floor(cx - tw / 2 + ox + sway(y)), y, Math.floor(cz - tw / 2), Math.floor(cx + tw / 2 - 0.01 + ox + sway(y)), y, Math.floor(cz + tw / 2 - 0.01), bark);
    }
    if (p.kind === 'pine') {
      const layers = Math.max(2, Math.floor((ctx.sy - th) / 2));
      for (let i = 0; i < layers * 2; i++) {
        const y = th - 2 + i;
        const rr = r * (1 - i / (layers * 2));
        if (y >= ctx.sy) break;
        ctx.sphere(cx + sway(y), y + 0.5, cz, Math.max(0.6, rr), i % 2 ? leaf : leafHi, 0.5);
      }
    } else if (p.kind === 'palm') {
      const topX = cx + Math.sin(1.2) * th * 0.25 + sway(th);
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2 + ctx.rand() * 0.3;
        for (let s = 0; s < r * 1.6; s += 0.5) {
          const droop = (s / r) ** 2 * 1.2;
          ctx.set(topX + Math.cos(a) * s, th - droop, cz + Math.sin(a) * s, s < r * 0.6 ? leafHi : leaf);
        }
      }
    } else {
      const cy = Math.min(ctx.sy - r * 0.8, th + r * 0.6);
      for (let i = 0; i < 6; i++) {
        const a = ctx.rand() * Math.PI * 2;
        const d = ctx.rand() * r * 0.45;
        const y = cy + (ctx.rand() - 0.3) * r * 0.5;
        ctx.sphere(cx + Math.cos(a) * d + sway(y), y, cz + Math.sin(a) * d, r * (0.6 + ctx.rand() * 0.25), i < 3 ? leaf : leafHi);
      }
    }
    if (p.fruit && p.kind !== 'pine') {
      for (let i = 0; i < 6; i++) {
        const x = ctx.randInt(0, ctx.sx - 1);
        const y = ctx.randInt(th, ctx.sy - 1);
        const z = ctx.randInt(0, ctx.sz - 1);
        if (ctx.get(x, y, z) && (!ctx.get(x + 1, y, z) || !ctx.get(x, y, z + 1))) ctx.set(x, y, z, fruit);
      }
    }
  },
});

registerGenerator({
  id: 'rock',
  name: L('岩石', 'Rock'),
  description: L('噪声扰动的石块', 'Noise-displaced boulder'),
  params: [
    { key: 'size', label: L('大小', 'Size'), type: 'number', default: 0.8, min: 0.2, max: 1, step: 0.05 },
    { key: 'rough', label: L('粗糙度', 'Roughness'), type: 'number', default: 0.35, min: 0, max: 1, step: 0.05 },
    { key: 'moss', label: L('青苔', 'Moss'), type: 'bool', default: true },
  ],
  generate(ctx, p) {
    const dark = ctx.color('#5a6988');
    const mid = ctx.color('#8b9bb4');
    const light = ctx.color('#c0cbdc');
    const moss = ctx.color('#63c74d');
    const rx = (ctx.sx / 2) * Number(p.size);
    const ry = (ctx.sy / 2) * Number(p.size) * 0.8;
    const rz = (ctx.sz / 2) * Number(p.size);
    const cx = ctx.sx / 2;
    const cz = ctx.sz / 2;
    for (let y = 0; y < ctx.sy; y++)
      for (let z = 0; z < ctx.sz; z++)
        for (let x = 0; x < ctx.sx; x++) {
          const dx = (x + 0.5 - cx) / rx;
          const dy = (y + 0.5) / (ry * 1.6);
          const dz = (z + 0.5 - cz) / rz;
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
          const n = ctx.fbm3(x * 0.15, y * 0.15, z * 0.15, 3) * Number(p.rough);
          if (d < 1 + n) {
            const shadeN = ctx.noise3(x * 0.4, y * 0.4, z * 0.4);
            let c = shadeN > 0.25 ? light : shadeN < -0.25 ? dark : mid;
            if (p.moss && y > ry * 0.9 && ctx.noise3(x * 0.3, 7, z * 0.3) > 0) c = moss;
            ctx.set(x, y, z, c);
          }
        }
  },
});

registerGenerator({
  id: 'shape',
  name: L('基础形状', 'Primitive'),
  description: L('球、圆柱、圆锥、圆环、金字塔', 'Sphere, cylinder, cone, torus, pyramid'),
  params: [
    { key: 'shape', label: L('形状', 'Shape'), type: 'select', default: 'sphere', options: [
      { value: 'sphere', label: L('球', 'Sphere') },
      { value: 'cylinder', label: L('圆柱', 'Cylinder') },
      { value: 'cone', label: L('圆锥', 'Cone') },
      { value: 'torus', label: L('圆环', 'Torus') },
      { value: 'pyramid', label: L('金字塔', 'Pyramid') },
    ] },
    { key: 'hollow', label: L('空心', 'Hollow'), type: 'bool', default: false },
    { key: 'color', label: L('颜色', 'Color'), type: 'color', default: '#0099db' },
  ],
  generate(ctx, p) {
    const c = ctx.color(String(p.color));
    const cx = ctx.sx / 2;
    const cy = ctx.sy / 2;
    const cz = ctx.sz / 2;
    const inside = (x: number, y: number, z: number): boolean => {
      const nx = (x + 0.5 - cx) / cx;
      const ny = (y + 0.5 - cy) / cy;
      const nz = (z + 0.5 - cz) / cz;
      const r = Math.sqrt(nx * nx + nz * nz);
      switch (p.shape) {
        case 'cylinder':
          return r <= 1;
        case 'cone':
          return r <= (1 - ny) / 2;
        case 'torus': {
          const q = r - 0.65;
          return q * q + ny * ny * 0.8 <= 0.35 * 0.35;
        }
        case 'pyramid':
          return Math.max(Math.abs(nx), Math.abs(nz)) <= (1 - ny) / 2;
        default:
          return nx * nx + ny * ny + nz * nz <= 1;
      }
    };
    for (let y = 0; y < ctx.sy; y++)
      for (let z = 0; z < ctx.sz; z++)
        for (let x = 0; x < ctx.sx; x++) {
          if (!inside(x, y, z)) continue;
          if (p.hollow && inside(x + 1, y, z) && inside(x - 1, y, z) && inside(x, y + 1, z) && inside(x, y - 1, z) && inside(x, y, z + 1) && inside(x, y, z - 1)) continue;
          ctx.set(x, y, z, c);
        }
  },
});

registerGenerator({
  id: 'house',
  name: L('房屋', 'House'),
  description: L('墙、门窗和坡屋顶', 'Walls, door, windows and a pitched roof'),
  params: [
    { key: 'floors', label: L('层数', 'Floors'), type: 'int', default: 1, min: 1, max: 4 },
    { key: 'wall', label: L('墙颜色', 'Wall color'), type: 'color', default: '#ead4aa' },
    { key: 'roof', label: L('屋顶颜色', 'Roof color'), type: 'color', default: '#a22633' },
    { key: 'chimney', label: L('烟囱', 'Chimney'), type: 'bool', default: true },
  ],
  generate(ctx, p) {
    const wall = ctx.color(String(p.wall));
    const roof = ctx.color(String(p.roof));
    const wood = ctx.color('#733e39');
    const glass = ctx.color('#2ce8f5');
    const brick = ctx.color('#be4a2f');
    const x0 = 1;
    const z0 = 1;
    const x1 = ctx.sx - 2;
    const z1 = ctx.sz - 2;
    const floorH = Math.max(3, Math.floor((ctx.sy * 0.55) / Number(p.floors)));
    const wallTop = Math.min(ctx.sy - 3, floorH * Number(p.floors)) - 1;
    for (let y = 0; y <= wallTop; y++)
      for (let z = z0; z <= z1; z++)
        for (let x = x0; x <= x1; x++) {
          const edge = x === x0 || x === x1 || z === z0 || z === z1;
          if (!edge && y > 0) continue;
          const corner = (x === x0 || x === x1) && (z === z0 || z === z1);
          ctx.set(x, y, z, corner ? wood : wall);
        }
    // Door on the front (+z) wall
    const mid = Math.floor((x0 + x1) / 2);
    ctx.box(mid, 1, z1, mid + (ctx.sx > 10 ? 1 : 0), Math.min(wallTop - 1, 3), z1, wood);
    // Windows on every floor
    for (let f = 0; f < Number(p.floors); f++) {
      const wy = f * floorH + Math.floor(floorH / 2);
      if (wy >= wallTop) continue;
      for (const wx of [x0 + 2, x1 - 2]) {
        ctx.set(wx, wy, z1, glass);
        ctx.set(wx, wy, z0, glass);
      }
      for (const wz of [z0 + 2, z1 - 2]) {
        ctx.set(x0, wy, wz, glass);
        ctx.set(x1, wy, wz, glass);
      }
    }
    // Pitched roof along x
    const half = Math.ceil((z1 - z0 + 3) / 2);
    for (let i = 0; i < half; i++) {
      const y = wallTop + 1 + i;
      if (y >= ctx.sy) break;
      for (let x = x0 - 1; x <= x1 + 1; x++) {
        ctx.set(x, y, z0 - 1 + i, roof);
        ctx.set(x, y, z1 + 1 - i, roof);
      }
      // Gable walls
      for (let z = z0 + i; z <= z1 - i; z++) {
        ctx.set(x0, y, z, wall);
        ctx.set(x1, y, z, wall);
      }
    }
    if (p.chimney) ctx.box(x1 - 2, wallTop + 1, z0 + 1, x1 - 2, Math.min(ctx.sy - 1, wallTop + half + 1), z0 + 1, brick);
  },
});

registerGenerator({
  id: 'flame',
  name: L('火焰', 'Flame'),
  description: L('噪声驱动的火焰，适合生成循环动画', 'Noise-driven flame, made for looping animation'),
  animated: true,
  params: [
    { key: 'size', label: L('大小', 'Size'), type: 'number', default: 0.8, min: 0.3, max: 1, step: 0.05 },
    { key: 'logs', label: L('木柴', 'Logs'), type: 'bool', default: true },
  ],
  generate(ctx, p) {
    const cols = ['#fee761', '#feae34', '#f77622', '#e43b44', '#a22633'].map((c) => ctx.color(c));
    const log = ctx.color('#733e39');
    const cx = ctx.sx / 2;
    const cz = ctx.sz / 2;
    const base = p.logs ? 2 : 0;
    if (p.logs) {
      ctx.box(Math.floor(cx - ctx.sx * 0.35), 0, Math.floor(cz - 1), Math.ceil(cx + ctx.sx * 0.35) - 1, 0, Math.floor(cz), log);
      ctx.box(Math.floor(cx - 1), 1, Math.floor(cz - ctx.sz * 0.35), Math.floor(cx), 1, Math.ceil(cz + ctx.sz * 0.35) - 1, log);
    }
    const R = (Math.min(ctx.sx, ctx.sz) / 2) * Number(p.size);
    const H = (ctx.sy - base) * Number(p.size);
    // Loop seamlessly: sample noise on a circle in time
    const ta = ctx.t * Math.PI * 2;
    const tx = Math.cos(ta) * 1.5;
    const tz = Math.sin(ta) * 1.5;
    for (let y = base; y < ctx.sy; y++)
      for (let z = 0; z < ctx.sz; z++)
        for (let x = 0; x < ctx.sx; x++) {
          const h = (y - base) / H;
          if (h > 1) continue;
          const r = Math.hypot(x + 0.5 - cx, z + 0.5 - cz) / R;
          const n = ctx.noise3(x * 0.25 + tx, (y - base) * 0.18 - ctx.t * 4, z * 0.25 + tz);
          const v = 1 - r - h * 0.9 + n * 0.45;
          if (v <= 0) continue;
          const k = Math.min(cols.length - 1, Math.floor((1 - Math.min(1, v * 1.6)) * cols.length));
          ctx.set(x, y, z, cols[k]);
        }
  },
});

function lighten(hex: string, f: number): string {
  const n = parseInt(hex.replace('#', ''), 16);
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * f)));
  return '#' + ((c((n >> 16) & 255) << 16) | (c((n >> 8) & 255) << 8) | c(n & 255)).toString(16).padStart(6, '0');
}
