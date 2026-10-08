import { describe, expect, it } from 'vitest';
import { VoxelGrid } from '../src/core/VoxelGrid';
import { makePalette } from '../src/core/Palette';
import { renderSlices, renderStack, stackCanvasSize } from '../src/export/stackRenderer';
import { packSheet, trimCommon } from '../src/export/image';
import { exportObj } from '../src/export/obj';
import { readVox, writeVox } from '../src/export/vox';
import { createZip, crc32 } from '../src/export/zip';

const palette = makePalette();

function cube(): VoxelGrid {
  const g = new VoxelGrid(4, 4, 4);
  for (let y = 0; y < 4; y++) for (let z = 0; z < 4; z++) for (let x = 0; x < 4; x++) g.set(x, y, z, 1 + ((x + y + z) % 3));
  return g;
}

function opaque(img: { data: Uint8ClampedArray }): number {
  let n = 0;
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i]) n++;
  return n;
}

describe('sprite stack renderer', () => {
  it('renders every angle at the same size', () => {
    const g = cube();
    const a = renderStack(g, palette, { angle: 0 });
    const b = renderStack(g, palette, { angle: 45 });
    const size = stackCanvasSize(g, { spacing: 1, squash: 1 });
    expect([a.width, a.height]).toEqual([size.w, size.h]);
    expect([b.width, b.height]).toEqual([size.w, size.h]);
    // Top-down 4x4 plus 3 stacked layers => 4 wide x 7 tall at angle 0
    expect(opaque(a)).toBe(4 * 7);
    expect(opaque(b)).toBeGreaterThan(16);
  });

  it('upscales and outlines', () => {
    const g = cube();
    const base = renderStack(g, palette, {});
    const big = renderStack(g, palette, { scale: 3 });
    expect(big.width).toBe(base.width * 3);
    const outlined = renderStack(g, palette, { outline: 0x000000 });
    expect(opaque(outlined)).toBe(opaque(base) + 2 * 4 + 2 * 7);
  });

  it('exports slices strip', () => {
    const img = renderSlices(cube(), palette);
    expect([img.width, img.height]).toEqual([16, 4]);
    expect(opaque(img)).toBe(64);
  });

  it('packs a sheet with frame rects', () => {
    const g = cube();
    const imgs = trimCommon([0, 90, 180, 270].map((angle) => renderStack(g, palette, { angle })));
    const { image, frames } = packSheet([{ name: 'idle', images: imgs }, { name: 'walk', images: imgs.slice(0, 2) }]);
    expect(frames).toHaveLength(6);
    expect(image.width).toBe(imgs[0].width * 4);
    expect(image.height).toBe(imgs[0].height * 2);
  });
});

describe('model export', () => {
  it('writes an OBJ with one material per color', () => {
    const { obj, mtl } = exportObj(cube(), palette, 'cube', { scale: 1, center: true });
    expect(obj).toContain('mtllib cube.mtl');
    expect(mtl.match(/newmtl/g)).toHaveLength(3);
    const faces = obj.split('\n').filter((l) => l.startsWith('f ')).length;
    const verts = obj.split('\n').filter((l) => l.startsWith('v ')).length;
    expect(verts).toBe(faces * 4);
  });

  it('round-trips MagicaVoxel .vox', () => {
    const g = new VoxelGrid(5, 3, 2);
    g.set(4, 2, 0, 7);
    g.set(0, 0, 1, 200);
    const buf = writeVox([g, g], palette);
    const back = readVox(buf);
    expect(back.models).toHaveLength(2);
    expect([back.models[0].sx, back.models[0].sy, back.models[0].sz]).toEqual([5, 3, 2]);
    expect(back.models[0].data).toEqual(g.data);
    expect(back.palette[7]).toBe(palette[7]);
  });
});

describe('zip', () => {
  it('computes the standard crc32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('writes a well-formed archive', () => {
    const zip = createZip([{ name: 'a.txt', data: new TextEncoder().encode('hello') }]);
    const dv = new DataView(zip.buffer);
    expect(dv.getUint32(0, true)).toBe(0x04034b50);
    expect(dv.getUint32(zip.length - 22, true)).toBe(0x06054b50);
  });
});

describe('sprite lighting', () => {
  it('changes shading with the view angle and casts ground shadows', async () => {
    const { DEFAULT_LIGHT } = await import('../src/core/lighting');
    const g = new VoxelGrid(6, 6, 6);
    for (let y = 0; y < 6; y++) for (let z = 1; z < 5; z++) for (let x = 1; x < 5; x++) g.set(x, y, z, 20); // white pillar
    const light = { ...DEFAULT_LIGHT, groundShadow: false };
    const a = renderStack(g, palette, { angle: 0, light });
    const b = renderStack(g, palette, { angle: 180, light });
    expect(a.data).not.toEqual(b.data);
    const noShadow = renderStack(g, palette, { angle: 0, light, padding: 8 });
    const withShadow = renderStack(g, palette, { angle: 0, light: { ...light, groundShadow: true }, padding: 8 });
    expect(opaque(withShadow)).toBeGreaterThan(opaque(noShadow));
  });

  it('shadows voxels under an overhang', async () => {
    const { inShadow, lightDirection } = await import('../src/core/lighting');
    const g = new VoxelGrid(5, 5, 5);
    for (let x = 0; x < 5; x++) for (let z = 0; z < 5; z++) g.set(x, 4, z, 1); // roof
    const l = lightDirection({ azimuth: 0, elevation: 80 }, 0);
    expect(inShadow(g, [2.5, 0.5, 2.5], l)).toBe(true);
    expect(inShadow(g, [2.5, 4.9 + 0.2, 2.5], l)).toBe(false);
  });
});

describe('normal and depth passes', () => {
  it('produces maps with the same footprint as the color pass', () => {
    const g = cube();
    const color = renderStack(g, palette, { angle: 30 });
    const normal = renderStack(g, palette, { angle: 30, pass: 'normal' });
    const depth = renderStack(g, palette, { angle: 30, pass: 'depth' });
    const mask = (img: { data: Uint8ClampedArray }) => Array.from({ length: img.data.length / 4 }, (_, i) => img.data[i * 4 + 3] > 0);
    expect(mask(normal)).toEqual(mask(color));
    expect(mask(depth)).toEqual(mask(color));
  });

  it('encodes top faces as pointing up and towards the viewer', () => {
    const g = new VoxelGrid(3, 1, 3);
    g.set(1, 0, 1, 1);
    const img = renderStack(g, palette, { pass: 'normal', spacing: 1, squash: 1 });
    let found = false;
    for (let i = 0; i < img.data.length; i += 4) {
      if (!img.data[i + 3]) continue;
      found = true;
      // n = (0, .707, .707) → (128, 218, 218)
      expect(img.data[i]).toBe(128);
      expect(img.data[i + 1]).toBeGreaterThan(200);
      expect(img.data[i + 2]).toBeGreaterThan(200);
    }
    expect(found).toBe(true);
  });
});
