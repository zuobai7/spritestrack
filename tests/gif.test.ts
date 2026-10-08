import { describe, expect, it } from 'vitest';
import { encodeGif, lzwEncode, medianCut } from '../src/export/gif';
import { createImage, putPixel } from '../src/export/image';

/** Reference GIF LZW decoder used to check the encoder. */
function lzwDecode(data: Uint8Array, minCodeSize: number, pixelCount: number): number[] {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  let codeSize = minCodeSize + 1;
  let dict: number[][] = [];
  const reset = () => {
    dict = [];
    for (let i = 0; i < clear; i++) dict[i] = [i];
    dict[clear] = [];
    dict[eoi] = [];
    codeSize = minCodeSize + 1;
  };
  reset();
  const out: number[] = [];
  let bit = 0;
  let prev: number[] | null = null;
  const read = () => {
    let v = 0;
    for (let i = 0; i < codeSize; i++, bit++) v |= ((data[bit >> 3] >> (bit & 7)) & 1) << i;
    return v;
  };
  while (bit + codeSize <= data.length * 8) {
    const code = read();
    if (code === clear) {
      reset();
      prev = null;
      continue;
    }
    if (code === eoi) break;
    let entry: number[];
    if (code < dict.length) entry = dict[code];
    else if (prev) entry = [...prev, prev[0]];
    else throw new Error('bad code');
    out.push(...entry);
    if (prev && dict.length < 4096) dict.push([...prev, entry[0]]);
    prev = entry;
    if (dict.length === 1 << codeSize && codeSize < 12) codeSize++;
  }
  return out.slice(0, pixelCount);
}

describe('gif', () => {
  it('LZW round-trips', () => {
    const src = new Uint8Array(10000);
    for (let i = 0; i < src.length; i++) src[i] = (i * 7 + (i >> 5)) % 200;
    const enc = lzwEncode(src, 8);
    expect(lzwDecode(enc, 8, src.length)).toEqual([...src]);
  });

  it('LZW handles dictionary resets on noisy data', () => {
    const src = new Uint8Array(70000);
    let s = 1;
    for (let i = 0; i < src.length; i++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      src[i] = s & 255;
    }
    expect(lzwDecode(lzwEncode(src, 8), 8, src.length)).toEqual([...src]);
  });

  it('median cut reduces colors', () => {
    const m = new Map<number, number>();
    for (let i = 0; i < 1000; i++) m.set(i * 4099, 1);
    expect(medianCut(m, 16).length).toBeLessThanOrEqual(16);
  });

  it('writes a valid animated gif', () => {
    const a = createImage(4, 4);
    const b = createImage(4, 4);
    putPixel(a, 1, 1, 0xff0000);
    putPixel(b, 2, 2, 0x00ff00, 100);
    const gif = encodeGif([a, b], { delay: 100, background: null });
    expect(String.fromCharCode(...gif.slice(0, 6))).toBe('GIF89a');
    expect(gif[gif.length - 1]).toBe(0x3b);
    expect(new TextDecoder().decode(gif)).toContain('NETSCAPE2.0');
  });
});
