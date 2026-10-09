import { describe, expect, it } from 'vitest';
import { createDemoProject } from '../src/core/Project';
import { DEFAULT_LIGHT } from '../src/core/lighting';
import { buildSprites, DEFAULT_SPRITE_SETTINGS, stackProjection, viewElevation } from '../src/export/spriteExport';

const p = createDemoProject();

describe('sprite export pipeline', () => {
  it('maps the 0–180 view angle to camera elevation and stack projection', () => {
    expect(viewElevation(0)).toBe(-90);
    expect(viewElevation(90)).toBe(0);
    expect(viewElevation(180)).toBe(90);
    const classic = stackProjection(viewElevation(135));
    expect(classic.squash).toBeCloseTo(1);
    expect(classic.spacing).toBeCloseTo(1);
    const top = stackProjection(viewElevation(180));
    expect(top.squash).toBeCloseTo(1);
    expect(top.spacing).toBeCloseTo(0);
    const low = stackProjection(viewElevation(105), 2);
    expect(low.squash).toBeCloseTo(Math.tan((15 * Math.PI) / 180));
    expect(low.spacing).toBeCloseTo(2);
  });

  it('builds a sheet with JSON for every frame and angle', async () => {
    const s = { ...DEFAULT_SPRITE_SETTINGS, scope: 'anim' as const, angles: 4, scale: 1 };
    const r = await buildSprites(p, s, DEFAULT_LIGHT, 1, 0, null, { baseName: 'demo' });
    expect(r.files.map((f) => f.name)).toEqual(['demo.png', 'demo.json']);
    const json = JSON.parse(r.files[1].text!);
    expect(Object.keys(json.frames)).toHaveLength(4 * 4);
    expect(json.animations.sway_a0).toEqual(['sway_0_a0', 'sway_1_a0', 'sway_2_a0', 'sway_3_a0']);
    const img = r.files[0].image!;
    const cell = json.frames.sway_0_a0.frame;
    expect(img.width).toBe(cell.w * 4);
    expect(img.height).toBe(cell.h * 4);
  });

  it('adds normal/depth sheets and one sheet per color scheme', async () => {
    const q = createDemoProject();
    q.variants.push({ name: 'autumn', palette: q.palette.map((c) => c ^ 0x202000) });
    const s = { ...DEFAULT_SPRITE_SETTINGS, scope: 'frame' as const, angles: 2, normal: true, depth: true, allSchemes: true, json: false };
    const r = await buildSprites(q, s, DEFAULT_LIGHT, 0, 0, null, { baseName: 'm' });
    expect(r.files.map((f) => f.name).sort()).toEqual(['m_autumn.png', 'm_default.png', 'm_depth.png', 'm_normal.png']);
    const sizes = new Set(r.files.map((f) => `${f.image!.width}x${f.image!.height}`));
    expect(sizes.size).toBe(1);
  });

  it('writes single frames and gif sequences', async () => {
    const zip = await buildSprites(p, { ...DEFAULT_SPRITE_SETTINGS, output: 'zip', angles: 2, scope: 'anim' }, DEFAULT_LIGHT, 1, 0, null, { baseName: 'x' });
    expect(zip.files).toHaveLength(8);
    expect(zip.files[0].name).toBe('sway/sway_0_a0.png');
    const gif = await buildSprites(p, { ...DEFAULT_SPRITE_SETTINGS, output: 'gif', gifContent: 'turntable', angles: 6 }, DEFAULT_LIGHT, 0, 0, null, { baseName: 'g' });
    expect(gif.files[0].gif!.frames).toHaveLength(6);
  });

  it('exports raw slices', async () => {
    const r = await buildSprites(p, { ...DEFAULT_SPRITE_SETTINGS, method: 'slices', scope: 'frame', scale: 1, trim: false }, DEFAULT_LIGHT, 0, 0, null, { baseName: 's' });
    expect(r.files[0].image!.width).toBe(16 * 16);
  });
});
