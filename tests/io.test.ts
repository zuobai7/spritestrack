import { describe, expect, it } from 'vitest';
import { ColorMapper, fitImage, importExtrude, importHeightmap, importSliceStrip } from '../src/core/imageImport';
import { paletteFromImage, parsePaletteText, remapTable, toGplFile, toHexFile } from '../src/core/paletteIO';
import { makePalette } from '../src/core/Palette';
import { renderSlices } from '../src/export/stackRenderer';
import { createImage, putPixel } from '../src/export/image';
import { VoxelGrid } from '../src/core/VoxelGrid';

describe('palette files', () => {
  it('parses hex, gpl, paint.net and json', () => {
    expect(parsePaletteText('ff0000\n#00ff00\n', 'a.hex')).toEqual([0xff0000, 0x00ff00]);
    expect(parsePaletteText('GIMP Palette\nName: x\n#\n255   0   0\tRed\n  0 0 255 Blue\n')).toEqual([0xff0000, 0x0000ff]);
    expect(parsePaletteText('; paint.net\nFFFF0000\nFF00FF00\n', 'p.txt')).toEqual([0xff0000, 0x00ff00]);
    expect(parsePaletteText('["#123456","abcdef"]', 'p.json')).toEqual([0x123456, 0xabcdef]);
  });

  it('round-trips through hex and gpl writers', () => {
    const pal = makePalette();
    expect(parsePaletteText(toHexFile(pal), 'x.hex')).toEqual(pal.slice(1));
    expect(parsePaletteText(toGplFile(pal, 'x'))).toEqual(pal.slice(1));
  });

  it('reads colors from an image and builds remap tables', () => {
    const img = createImage(3, 1);
    putPixel(img, 0, 0, 0xff0000);
    putPixel(img, 1, 0, 0xff0000);
    putPixel(img, 2, 0, 0x0000ff);
    expect(paletteFromImage(img)).toEqual([0xff0000, 0x0000ff]);
    const t = remapTable([0, 0xff0000, 0x0000fe], [0, 0x0000ff, 0xfe0000]);
    expect([t[1], t[2]]).toEqual([2, 1]);
  });
});

describe('image import', () => {
  it('round-trips a slice strip', () => {
    const pal = makePalette();
    const g = new VoxelGrid(4, 3, 5);
    g.set(1, 0, 2, 3);
    g.set(3, 2, 4, 7);
    const strip = renderSlices(g, pal, 'horizontal');
    const back = importSliceStrip(strip, 3, 'horizontal', new ColorMapper(pal.slice(), false));
    expect([back.sx, back.sy, back.sz]).toEqual([4, 3, 5]);
    expect(back.data).toEqual(g.data);
  });

  it('extrudes pixel art and builds heightmaps', () => {
    const img = createImage(2, 2);
    putPixel(img, 0, 0, 0xffffff);
    putPixel(img, 1, 1, 0x808080);
    const pal = makePalette();
    const e = importExtrude(img, 3, 'front', new ColorMapper(pal, true));
    expect([e.sx, e.sy, e.sz]).toEqual([2, 2, 3]);
    expect(e.count()).toBe(6);
    expect(e.get(0, 1, 0)).toBeGreaterThan(0); // top-left pixel ends up at the top
    const hm = importHeightmap(img, 10, new ColorMapper(pal, true), 'image');
    expect(hm.count()).toBe(10 + 5);
  });

  it('downscales large images', () => {
    const big = createImage(600, 300);
    const f = fitImage(big, 256);
    expect([f.width, f.height]).toEqual([256, 128]);
  });

  it('adds colors to the palette until full', () => {
    const pal = makePalette();
    const m = new ColorMapper(pal, true);
    const idx = m.map(0x010203);
    expect(pal[idx]).toBe(0x010203);
  });
});
