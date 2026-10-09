import { describe, expect, it } from 'vitest';
import { blockColor, legacyBlockName } from '../src/core/mcBlocks';
import { readSchematic, schematicBlocks, schematicToGrid, scaledSize } from '../src/core/minecraft';
import { readNbt } from '../src/core/nbt';

// A minimal NBT writer for building test files
type Tag =
  | { t: 'byte'; v: number }
  | { t: 'short'; v: number }
  | { t: 'int'; v: number }
  | { t: 'string'; v: string }
  | { t: 'bytes'; v: number[] }
  | { t: 'list'; of: number; v: Tag[] }
  | { t: 'compound'; v: Record<string, Tag> };
const TYPE = { byte: 1, short: 2, int: 3, string: 8, bytes: 7, list: 9, compound: 10 } as const;
const C = (v: Record<string, Tag>): Tag => ({ t: 'compound', v });
const S = (v: number): Tag => ({ t: 'short', v });
const I = (v: number): Tag => ({ t: 'int', v });
const B = (v: number[]): Tag => ({ t: 'bytes', v });

function writeNbt(name: string, root: Tag): Uint8Array {
  const out: number[] = [];
  const u16 = (n: number) => out.push((n >> 8) & 255, n & 255);
  const i32 = (n: number) => out.push((n >> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255);
  const str = (s: string) => {
    const b = new TextEncoder().encode(s);
    u16(b.length);
    out.push(...b);
  };
  const payload = (tag: Tag) => {
    switch (tag.t) {
      case 'byte':
        return out.push(tag.v & 255);
      case 'short':
        return u16(tag.v);
      case 'int':
        return i32(tag.v);
      case 'string':
        return str(tag.v);
      case 'bytes':
        i32(tag.v.length);
        return out.push(...tag.v.map((b) => b & 255));
      case 'list':
        out.push(tag.of);
        i32(tag.v.length);
        return tag.v.forEach(payload);
      case 'compound':
        for (const [k, v] of Object.entries(tag.v)) {
          out.push(TYPE[v.t]);
          str(k);
          payload(v);
        }
        return out.push(0);
    }
  };
  out.push(10);
  str(name);
  payload(root);
  return Uint8Array.from(out);
}

async function gzip(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Varint bytes for a list of palette indices. */
function varints(values: number[]): number[] {
  const out: number[] = [];
  for (let v of values) {
    while (v >= 0x80) {
      out.push((v & 0x7f) | 0x80);
      v >>>= 7;
    }
    out.push(v);
  }
  return out;
}

describe('NBT', () => {
  it('reads nested compounds, lists and arrays', () => {
    const data = writeNbt('root', C({ a: S(-2), b: { t: 'list', of: 3, v: [I(1), I(300)] }, c: C({ d: { t: 'string', v: 'héllo' } }), e: B([1, 255]) }));
    const { name, value } = readNbt(data);
    expect(name).toBe('root');
    expect(value.a).toBe(-2);
    expect(value.b).toEqual([1, 300]);
    expect((value.c as { d: string }).d).toBe('héllo');
    expect(Array.from(value.e as Uint8Array)).toEqual([1, 255]);
  });

  it('rejects data that is not NBT', () => {
    expect(() => readNbt(new Uint8Array([1, 2, 3, 4]))).toThrow();
    expect(() => readNbt(writeNbt('x', C({ a: I(1) })).slice(0, 8))).toThrow();
  });
});

describe('Minecraft schematics', () => {
  // 2×2×2: bottom layer stone and oak stairs, top layer air and red wool
  const cells = [1, 2, 1, 2, 0, 3, 0, 0]; // x + z*2 + y*4
  const palette = { 'minecraft:air': 0, 'minecraft:stone': 1, 'minecraft:oak_stairs[facing=east,half=bottom]': 2, 'minecraft:red_wool': 3 };
  const paletteTag = C(Object.fromEntries(Object.entries(palette).map(([k, v]) => [k, I(v)])));

  it('reads Sponge v2 (.schem), gzip-compressed', async () => {
    const file = await gzip(writeNbt('Schematic', C({ Version: I(2), Width: S(2), Height: S(2), Length: S(2), Palette: paletteTag, PaletteMax: I(4), BlockData: B(varints(cells)) })));
    const s = await readSchematic(file);
    expect(s.size).toEqual([2, 2, 2]);
    expect(s.palette[s.blocks[1]]).toContain('oak_stairs');
    expect(s.palette[s.blocks[5]]).toBe('minecraft:red_wool');
  });

  it('reads Sponge v3 with large palette indices', async () => {
    // Index 200 needs two varint bytes
    const pal = C({ 'minecraft:air': I(0), 'minecraft:gold_block': I(200) });
    const file = writeNbt('', C({ Schematic: C({ Version: I(3), Width: S(2), Height: S(1), Length: S(1), Blocks: C({ Palette: pal, Data: B(varints([200, 0])) }) }) }));
    const s = await readSchematic(file);
    expect(s.palette[s.blocks[0]]).toBe('minecraft:gold_block');
    expect(s.palette[s.blocks[1]]).toBe('minecraft:air');
  });

  it('reads MCEdit .schematic with numeric ids, data values and AddBlocks', async () => {
    // wool:14 (red), log:1|4 (spruce, x axis), stone:3 (diorite), id 256+1 (high bits via AddBlocks)
    const ids = [35, 17, 1, 1];
    const data = [14, 1 | 4, 3, 0];
    const add = [0x00, 0x01]; // 4th block (odd index 3) gets high nibble 1
    const file = await gzip(writeNbt('Schematic', C({ Width: S(4), Height: S(1), Length: S(1), Materials: { t: 'string', v: 'Alpha' }, Blocks: B(ids), Data: B(data), AddBlocks: B(add) })));
    const s = await readSchematic(file);
    expect(s.palette[s.blocks[0]]).toBe('red_wool');
    expect(s.palette[s.blocks[1]]).toBe('spruce_log');
    expect(s.palette[s.blocks[2]]).toBe('diorite');
    expect(s.palette[s.blocks[3]]).toBe('legacy:257');
  });

  it('colors blocks by name, including variants and unknown blocks', () => {
    expect(blockColor('minecraft:air').color).toBeNull();
    expect(blockColor('minecraft:oak_stairs[facing=east]')).toEqual({ color: blockColor('oak_planks').color, guessed: false });
    expect(blockColor('stone_brick_wall').color).toBe(blockColor('stone_bricks').color);
    expect(blockColor('light_blue_concrete').color).not.toBe(blockColor('blue_concrete').color);
    expect(blockColor('waxed_weathered_cut_copper_slab').color).toBe(blockColor('weathered_copper').color);
    expect(blockColor('stripped_cherry_log').guessed).toBe(false);
    expect(blockColor('somemod:magic_stone_thing').guessed).toBe(true);
    expect(legacyBlockName(35, 4)).toBe('yellow_wool');
    expect(legacyBlockName(0, 0)).toBe('air');
    expect(legacyBlockName(9999, 0)).toBeNull();
  });

  it('turns a structure into voxels with the nearest palette colors or new ones', async () => {
    const file = writeNbt('Schematic', C({ Version: I(2), Width: S(2), Height: S(2), Length: S(2), Palette: paletteTag, BlockData: B(varints(cells)) }));
    const s = await readSchematic(file);
    const pal = [0, 0x000000, 0xff0000, 0x808080, 0xa08050];
    const g = schematicToGrid(s, { scale: 1, palette: pal, addColors: false, liquids: true });
    expect(pal).toHaveLength(5); // nothing added
    expect(g.get(0, 0, 0)).toBe(3); // stone → gray
    expect(g.get(1, 0, 0)).toBe(4); // oak stairs → brown
    expect(g.get(1, 1, 0)).toBe(2); // red wool → red
    expect(g.get(0, 1, 0)).toBe(0); // air
    const pal2 = [0];
    const g2 = schematicToGrid(s, { scale: 1, palette: pal2, addColors: true, liquids: true });
    expect(pal2).toHaveLength(4);
    expect(pal2[g2.get(0, 0, 0)]).toBe(blockColor('stone').color);
    expect(schematicBlocks(s).map((b) => b.name)).toEqual(['stone', 'oak_stairs', 'red_wool']);
  });

  it('scales down by majority, keeping thin walls and dropping stray blocks', async () => {
    // 4×4×4: a one-block-thick wall at z = 0 and a lone block at (3, 3, 3)
    const n = 64;
    const values = new Array(n).fill(0);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) values[x + 4 * (0 + 4 * y)] = 1;
    values[3 + 4 * (3 + 4 * 3)] = 2;
    const pal = C({ 'minecraft:air': I(0), 'minecraft:bricks': I(1), 'minecraft:gold_block': I(2) });
    const s = await readSchematic(writeNbt('Schematic', C({ Version: I(2), Width: S(4), Height: S(4), Length: S(4), Palette: pal, BlockData: B(varints(values)) })));
    expect(scaledSize(s, 2)).toEqual([2, 2, 2]);
    const g = schematicToGrid(s, { scale: 2, palette: [0], addColors: true, liquids: true });
    expect(g.get(0, 0, 0)).not.toBe(0);
    expect(g.get(1, 1, 0)).not.toBe(0);
    expect(g.get(1, 1, 1)).toBe(0);
  });

  it('leaves out water when asked', async () => {
    const pal = C({ 'minecraft:water[level=0]': I(0), 'minecraft:sand': I(1) });
    const s = await readSchematic(writeNbt('Schematic', C({ Version: I(2), Width: S(2), Height: S(1), Length: S(1), Palette: pal, BlockData: B([0, 1]) })));
    expect(schematicToGrid(s, { scale: 1, palette: [0], addColors: true, liquids: false }).count()).toBe(1);
    expect(schematicToGrid(s, { scale: 1, palette: [0], addColors: true, liquids: true }).count()).toBe(2);
  });
});
