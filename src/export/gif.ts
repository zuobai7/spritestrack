import type { RgbaImage } from './image';

/**
 * Animated GIF encoder (GIF89a, looping, 1-bit transparency).
 * Colors are shared across frames in one global table; if the frames use more
 * than 255 colors they are reduced with median cut.
 */

export interface GifOptions {
  /** Delay per frame in milliseconds. */
  delay: number;
  /** Background for semi-transparent pixels, or null to keep transparency (alpha is dithered). */
  background: number | null;
  /** 0 = loop forever. */
  loops?: number;
}

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);

/** Flattens alpha: composites onto the background, or dithers it to on/off when keeping transparency. */
function flatten(img: RgbaImage, background: number | null): { rgb: Int32Array } {
  const n = img.width * img.height;
  const rgb = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const r = img.data[i * 4];
    const g = img.data[i * 4 + 1];
    const b = img.data[i * 4 + 2];
    const a = img.data[i * 4 + 3] / 255;
    if (background === null) {
      const x = i % img.width;
      const y = (i / img.width) | 0;
      rgb[i] = a > BAYER4[(y & 3) * 4 + (x & 3)] ? (r << 16) | (g << 8) | b : -1;
    } else {
      const br = (background >> 16) & 255;
      const bg = (background >> 8) & 255;
      const bb = background & 255;
      rgb[i] = (Math.round(r * a + br * (1 - a)) << 16) | (Math.round(g * a + bg * (1 - a)) << 8) | Math.round(b * a + bb * (1 - a));
    }
  }
  return { rgb };
}

/** Median-cut quantization to at most `max` colors. */
export function medianCut(colors: Map<number, number>, max: number): number[] {
  type Box = { items: [number, number][] };
  let boxes: Box[] = [{ items: [...colors.entries()] }];
  const ch = (c: number, k: number) => (c >> (16 - k * 8)) & 255;
  while (boxes.length < max) {
    // Split the box with the widest channel range (weighted by population)
    let best = -1;
    let bestScore = -1;
    let bestCh = 0;
    boxes.forEach((b, i) => {
      if (b.items.length < 2) return;
      for (let k = 0; k < 3; k++) {
        let lo = 255;
        let hi = 0;
        let pop = 0;
        for (const [c, n] of b.items) {
          const v = ch(c, k);
          if (v < lo) lo = v;
          if (v > hi) hi = v;
          pop += n;
        }
        const score = (hi - lo) * Math.sqrt(pop);
        if (score > bestScore) {
          bestScore = score;
          best = i;
          bestCh = k;
        }
      }
    });
    if (best < 0 || bestScore <= 0) break;
    const items = boxes[best].items.sort((a, b) => ch(a[0], bestCh) - ch(b[0], bestCh));
    const total = items.reduce((s, [, n]) => s + n, 0);
    let acc = 0;
    let cut = 1;
    for (let i = 0; i < items.length - 1; i++) {
      acc += items[i][1];
      if (acc >= total / 2) {
        cut = i + 1;
        break;
      }
      cut = i + 1;
    }
    boxes.splice(best, 1, { items: items.slice(0, cut) }, { items: items.slice(cut) });
  }
  return boxes.map((b) => {
    let r = 0;
    let g = 0;
    let bl = 0;
    let n = 0;
    for (const [c, w] of b.items) {
      r += ch(c, 0) * w;
      g += ch(c, 1) * w;
      bl += ch(c, 2) * w;
      n += w;
    }
    return (Math.round(r / n) << 16) | (Math.round(g / n) << 8) | Math.round(bl / n);
  });
}

class ByteWriter {
  bytes: number[] = [];
  u8(v: number) {
    this.bytes.push(v & 255);
  }
  u16(v: number) {
    this.bytes.push(v & 255, (v >> 8) & 255);
  }
  str(s: string) {
    for (let i = 0; i < s.length; i++) this.bytes.push(s.charCodeAt(i));
  }
  data(d: ArrayLike<number>) {
    for (let i = 0; i < d.length; i++) this.bytes.push(d[i]);
  }
}

/** GIF LZW compression of 8-bit indices. */
export function lzwEncode(indices: Uint8Array, minCodeSize = 8): Uint8Array {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  const out: number[] = [];
  let bitBuf = 0;
  let bitCount = 0;
  let codeSize = minCodeSize + 1;
  const emit = (code: number) => {
    bitBuf |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      out.push(bitBuf & 255);
      bitBuf >>>= 8;
      bitCount -= 8;
    }
  };
  let dict = new Map<number, number>();
  let next = eoi + 1;
  emit(clear);
  if (indices.length === 0) {
    emit(eoi);
    if (bitCount > 0) out.push(bitBuf & 255);
    return Uint8Array.from(out);
  }
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = (prefix << 8) | k;
    const hit = dict.get(key);
    if (hit !== undefined) {
      prefix = hit;
      continue;
    }
    emit(prefix);
    if (next < 4096) {
      dict.set(key, next++);
      // Grow the code size once the next code no longer fits
      if (next > 1 << codeSize && codeSize < 12) codeSize++;
    } else {
      emit(clear);
      dict = new Map();
      next = eoi + 1;
      codeSize = minCodeSize + 1;
    }
    prefix = k;
  }
  emit(prefix);
  emit(eoi);
  if (bitCount > 0) out.push(bitBuf & 255);
  return Uint8Array.from(out);
}

export function encodeGif(frames: RgbaImage[], opts: GifOptions): Uint8Array {
  if (frames.length === 0) throw new Error('No frames');
  const w = frames[0].width;
  const h = frames[0].height;
  const flat = frames.map((f) => flatten(f, opts.background).rgb);
  const counts = new Map<number, number>();
  let transparent = false;
  for (const f of flat)
    for (const c of f) {
      if (c < 0) transparent = true;
      else counts.set(c, (counts.get(c) ?? 0) + 1);
    }
  const maxColors = transparent ? 255 : 256;
  const colors = counts.size <= maxColors ? [...counts.keys()] : medianCut(counts, maxColors);
  const transIndex = transparent ? colors.length : -1;
  const table = new Map<number, number>();
  colors.forEach((c, i) => table.set(c, i));
  const nearest = (c: number): number => {
    const hit = table.get(c);
    if (hit !== undefined) return hit;
    const r = (c >> 16) & 255;
    const g = (c >> 8) & 255;
    const b = c & 255;
    let best = 0;
    let bestD = Infinity;
    colors.forEach((p, i) => {
      const d = (((p >> 16) & 255) - r) ** 2 + (((p >> 8) & 255) - g) ** 2 + ((p & 255) - b) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    table.set(c, best);
    return best;
  };

  const W = new ByteWriter();
  W.str('GIF89a');
  W.u16(w);
  W.u16(h);
  W.u8(0xf7); // global color table, 8 bits/channel, 256 entries
  W.u8(transparent ? transIndex : 0);
  W.u8(0);
  for (let i = 0; i < 256; i++) {
    const c = colors[i] ?? 0;
    W.u8((c >> 16) & 255);
    W.u8((c >> 8) & 255);
    W.u8(c & 255);
  }
  if (frames.length > 1) {
    W.u8(0x21);
    W.u8(0xff);
    W.u8(11);
    W.str('NETSCAPE2.0');
    W.u8(3);
    W.u8(1);
    W.u16(opts.loops ?? 0);
    W.u8(0);
  }
  const delay = Math.max(2, Math.round(opts.delay / 10));
  for (const f of flat) {
    W.u8(0x21);
    W.u8(0xf9);
    W.u8(4);
    W.u8((2 << 2) | (transparent ? 1 : 0)); // dispose: restore to background
    W.u16(delay);
    W.u8(transparent ? transIndex : 0);
    W.u8(0);
    W.u8(0x2c);
    W.u16(0);
    W.u16(0);
    W.u16(w);
    W.u16(h);
    W.u8(0);
    const idx = new Uint8Array(w * h);
    for (let i = 0; i < f.length; i++) idx[i] = f[i] < 0 ? transIndex : nearest(f[i]);
    W.u8(8);
    const lzw = lzwEncode(idx, 8);
    for (let i = 0; i < lzw.length; i += 255) {
      const chunk = lzw.subarray(i, i + 255);
      W.u8(chunk.length);
      W.data(chunk);
    }
    W.u8(0);
  }
  W.u8(0x3b);
  return Uint8Array.from(W.bytes);
}
