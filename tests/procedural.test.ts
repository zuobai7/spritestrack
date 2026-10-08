import { describe, expect, it } from 'vitest';
import { defaultParams, getGenerators, registerGenerator, runGenerator, scriptGenerator, SCRIPT_TEMPLATE } from '../src/core/procedural';
import { makePalette } from '../src/core/Palette';
import { Perlin, mulberry32 } from '../src/core/noise';

describe('noise', () => {
  it('is deterministic per seed', () => {
    expect(mulberry32(5)()).toBe(mulberry32(5)());
    expect(new Perlin(3).noise3(1.3, 2.7, 0.1)).toBe(new Perlin(3).noise3(1.3, 2.7, 0.1));
    expect(new Perlin(3).noise3(1.3, 2.7, 0.1)).not.toBe(new Perlin(4).noise3(1.3, 2.7, 0.1));
  });
});

describe('procedural generators', () => {
  for (const g of getGenerators()) {
    it(`${g.id} produces voxels deterministically`, () => {
      const pal = makePalette();
      const a = runGenerator(g, defaultParams(g), [24, 24, 24], pal, { seed: 7, t: 0.25 });
      const b = runGenerator(g, defaultParams(g), [24, 24, 24], makePalette(), { seed: 7, t: 0.25 });
      expect(a.count()).toBeGreaterThan(0);
      expect(a.data).toEqual(b.data);
      for (const v of a.data) expect(v).toBeLessThan(pal.length);
    });
  }

  it('animated generators change over time', () => {
    const flame = getGenerators().find((g) => g.id === 'flame')!;
    const a = runGenerator(flame, defaultParams(flame), [16, 16, 16], makePalette(), { seed: 1, t: 0 });
    const b = runGenerator(flame, defaultParams(flame), [16, 16, 16], makePalette(), { seed: 1, t: 0.5 });
    expect(a.data).not.toEqual(b.data);
  });

  it('runs user scripts and custom registered generators', () => {
    const pal = makePalette();
    const before = pal.length;
    const g = runGenerator(scriptGenerator(SCRIPT_TEMPLATE), {}, [16, 16, 16], pal, { seed: 2 });
    expect(g.count()).toBeGreaterThan(0);
    expect(pal.length).toBeGreaterThanOrEqual(before);
    registerGenerator({ id: 'test-cube', name: 'Cube', params: [], generate: (ctx) => ctx.box(0, 0, 0, 1, 1, 1, ctx.color('#123456')) });
    const c = runGenerator(getGenerators().find((x) => x.id === 'test-cube')!, {}, [4, 4, 4], pal, { seed: 1 });
    expect(c.count()).toBe(8);
    expect(pal[c.get(0, 0, 0)]).toBe(0x123456);
  });
});
