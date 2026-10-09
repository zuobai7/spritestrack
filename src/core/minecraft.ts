import { VoxelGrid } from './VoxelGrid';
import { ColorMapper } from './imageImport';
import { blockColor, legacyBlockName, LIQUIDS, baseBlockName } from './mcBlocks';
import { gunzipIfNeeded, isCompound, readNbt, type NbtCompound, type NbtValue } from './nbt';

/**
 * Minecraft structure files: Sponge schematics (.schem, versions 1–3, written
 * by WorldEdit and most current tools) and the older MCEdit/Schematica
 * .schematic format with numeric block ids.
 */
export interface Schematic {
  /** Width (x), height (y) and length (z) in blocks. */
  size: [number, number, number];
  /** Block ids such as "minecraft:oak_stairs[facing=east]", indexed by `blocks`. */
  palette: string[];
  /** Palette index of every block, at x + z·width + y·width·length. */
  blocks: Uint32Array;
}

const num = (v: NbtValue | undefined): number => (typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : 0);
// Sizes are stored as signed shorts; anything over 32767 wraps negative
const dim = (v: NbtValue | undefined): number => num(v) & 0xffff;

/** Reads a .schem or .schematic file (gzip-compressed or not). */
export async function readSchematic(data: Uint8Array): Promise<Schematic> {
  return parseSchematic(readNbt(await gunzipIfNeeded(data)).value);
}

export function parseSchematic(root: NbtCompound): Schematic {
  // Version 3 wraps everything in a "Schematic" compound
  const s = isCompound(root.Schematic) ? root.Schematic : root;
  const w = dim(s.Width);
  const h = dim(s.Height);
  const l = dim(s.Length);
  if (!w || !h || !l) throw new Error('Not a Minecraft schematic (no size)');
  const total = w * h * l;
  const blocksTag = s.Blocks;
  if (isCompound(blocksTag) && isCompound(blocksTag.Palette) && blocksTag.Data instanceof Uint8Array)
    return sponge(w, h, l, blocksTag.Palette, blocksTag.Data);
  if (isCompound(s.Palette) && s.BlockData instanceof Uint8Array) return sponge(w, h, l, s.Palette, s.BlockData);
  if (blocksTag instanceof Uint8Array) {
    if (blocksTag.length < total) throw new Error('Schematic block data is too short');
    return legacy(w, h, l, blocksTag, s.Data instanceof Uint8Array ? s.Data : null, s.AddBlocks instanceof Uint8Array ? s.AddBlocks : null, s.SchematicaMapping);
  }
  throw new Error('Not a Minecraft schematic (no blocks)');
}

/** Sponge format: a palette of block states and one varint index per block. */
function sponge(w: number, h: number, l: number, pal: NbtCompound, data: Uint8Array): Schematic {
  const palette: string[] = [];
  for (const [name, id] of Object.entries(pal)) palette[num(id)] = name;
  for (let i = 0; i < palette.length; i++) palette[i] ??= 'minecraft:air';
  const total = w * h * l;
  const blocks = new Uint32Array(total);
  let p = 0;
  for (let i = 0; i < total; i++) {
    let v = 0;
    let shift = 0;
    let b: number;
    do {
      if (p >= data.length) throw new Error('Schematic block data is too short');
      b = data[p++];
      v |= (b & 0x7f) << shift;
      shift += 7;
    } while (b & 0x80 && shift < 35);
    blocks[i] = v < palette.length ? v : 0;
  }
  return { size: [w, h, l], palette, blocks };
}

/** MCEdit format: a byte id per block (plus optional high bits) and a 4-bit data value. */
function legacy(
  w: number,
  h: number,
  l: number,
  ids: Uint8Array,
  data: Uint8Array | null,
  add: Uint8Array | null,
  mapping: NbtValue | undefined,
): Schematic {
  // Schematica stores the names of the ids it used, which covers mod blocks
  const named = new Map<number, string>();
  if (isCompound(mapping)) for (const [name, id] of Object.entries(mapping)) named.set(num(id), name);
  const total = w * h * l;
  const palette: string[] = [];
  const index = new Map<number, number>();
  const blocks = new Uint32Array(total);
  for (let i = 0; i < total; i++) {
    let id = ids[i];
    // Two 4-bit high parts per byte, the even block in the upper half
    if (add) id |= (i & 1 ? add[i >> 1] & 15 : (add[i >> 1] >> 4) & 15) << 8;
    const meta = data ? data[i] & 15 : 0;
    const key = (id << 4) | meta;
    let k = index.get(key);
    if (k === undefined) {
      const name = id <= 255 ? legacyBlockName(id, meta) : null;
      k = palette.length;
      palette.push(name ?? named.get(id) ?? `legacy:${id}`);
      index.set(key, k);
    }
    blocks[i] = k;
  }
  return { size: [w, h, l], palette, blocks };
}

export interface SchematicBlockInfo {
  /** Block id without block states, and without the namespace for vanilla blocks. */
  name: string;
  count: number;
  color: number | null;
  guessed: boolean;
  /** Water or lava. */
  liquid: boolean;
}

const displayName = (id: string): string => {
  const n = id.trim().toLowerCase().replace(/\[.*$/, '');
  return n.startsWith('minecraft:') ? n.slice(10) : n;
};

/** Every block type in the structure with its count and color, most common first (air left out). */
export function schematicBlocks(s: Schematic): SchematicBlockInfo[] {
  const counts = new Uint32Array(s.palette.length);
  for (const b of s.blocks) counts[b]++;
  const byName = new Map<string, SchematicBlockInfo>();
  s.palette.forEach((id, i) => {
    if (!counts[i]) return;
    const name = displayName(id);
    const c = blockColor(id);
    if (c.color === null) return;
    const e = byName.get(name);
    if (e) e.count += counts[i];
    else byName.set(name, { name, count: counts[i], color: c.color, guessed: c.guessed, liquid: LIQUIDS.has(baseBlockName(id)) });
  });
  return [...byName.values()].sort((a, b) => b.count - a.count);
}

export interface SchematicImportOptions {
  /** Keep one voxel per `scale`³ blocks (1 = full size). */
  scale: number;
  /** Palette to map colors into; extended in place when `addColors` is set. */
  palette: number[];
  /** Add block colors to the palette while there is room, instead of using the closest existing color. */
  addColors: boolean;
  /** Keep water and lava. */
  liquids: boolean;
}

/** Output size for a structure at a scale. */
export function scaledSize(s: Schematic, scale: number): [number, number, number] {
  const k = Math.max(1, Math.floor(scale));
  return [Math.ceil(s.size[0] / k), Math.ceil(s.size[1] / k), Math.ceil(s.size[2] / k)];
}

/**
 * Turns a structure into a voxel grid. When scaled down, each voxel takes the
 * most common block of its cube, and stays empty unless blocks fill at least
 * a slab of it (so thin walls survive and stray blocks don't).
 */
export function schematicToGrid(s: Schematic, opts: SchematicImportOptions): VoxelGrid {
  const k = Math.max(1, Math.floor(opts.scale));
  const [w, h, l] = s.size;
  const [ox, oy, oz] = scaledSize(s, k);
  const mapper = new ColorMapper(opts.palette, opts.addColors);
  // Palette index per block type; 0 = empty
  const value = s.palette.map((id) => {
    const c = blockColor(id).color;
    if (c === null || (!opts.liquids && LIQUIDS.has(baseBlockName(id)))) return 0;
    return mapper.map(c);
  });
  const out = new VoxelGrid(ox, oy, oz);
  if (k === 1) {
    for (let i = 0; i < s.blocks.length; i++) out.data[i] = value[s.blocks[i]];
    return out;
  }
  const need = Math.max(1, Math.floor((k * k) / 2));
  const tally = new Map<number, number>();
  for (let y = 0; y < oy; y++)
    for (let z = 0; z < oz; z++)
      for (let x = 0; x < ox; x++) {
        tally.clear();
        let solid = 0;
        for (let dy = 0; dy < k; dy++) {
          const by = y * k + dy;
          if (by >= h) break;
          for (let dz = 0; dz < k; dz++) {
            const bz = z * k + dz;
            if (bz >= l) break;
            for (let dx = 0; dx < k; dx++) {
              const bx = x * k + dx;
              if (bx >= w) break;
              const v = value[s.blocks[bx + w * (bz + l * by)]];
              if (!v) continue;
              solid++;
              tally.set(v, (tally.get(v) ?? 0) + 1);
            }
          }
        }
        if (solid < need) continue;
        let best = 0;
        let bestN = 0;
        for (const [v, n] of tally)
          if (n > bestN) {
            best = v;
            bestN = n;
          }
        out.data[out.index(x, y, z)] = best;
      }
  return out;
}
