import type { RgbaImage } from '../export/image';
import { MAX_COLORS } from './Palette';

/**
 * Palette file formats: .hex (Lospec), .gpl (GIMP/Aseprite), .txt (Paint.NET),
 * .json (array of hex strings) and .png (every distinct opaque color, in
 * reading order). Returned colors are 0xRRGGBB without the empty slot.
 */
export function parsePaletteText(text: string, filename = ''): number[] {
  const name = filename.toLowerCase();
  const out: number[] = [];
  const push = (c: number) => {
    if (out.length < MAX_COLORS) out.push(c & 0xffffff);
  };
  if (name.endsWith('.json') || text.trim().startsWith('[') || text.trim().startsWith('{')) {
    const json = JSON.parse(text);
    const list: unknown[] = Array.isArray(json) ? json : Array.isArray(json.colors) ? json.colors : [];
    for (const c of list) if (typeof c === 'string') push(parseInt(c.replace('#', ''), 16));
    return out;
  }
  if (text.startsWith('GIMP Palette') || name.endsWith('.gpl')) {
    for (const line of text.split(/\r?\n/)) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)/);
      if (m) push((+m[1] << 16) | (+m[2] << 8) | +m[3]);
    }
    return out;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('//')) continue;
    const hex = line.replace(/^#/, '');
    if (/^[0-9a-fA-F]{8}$/.test(hex)) push(parseInt(hex.slice(2), 16)); // Paint.NET AARRGGBB
    else if (/^[0-9a-fA-F]{6}$/.test(hex)) push(parseInt(hex, 16));
  }
  return out;
}

export function paletteFromImage(img: RgbaImage): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (let i = 0; i < img.width * img.height && out.length < MAX_COLORS; i++) {
    if (img.data[i * 4 + 3] < 128) continue;
    const c = (img.data[i * 4] << 16) | (img.data[i * 4 + 1] << 8) | img.data[i * 4 + 2];
    if (!seen.has(c)) {
      seen.add(c);
      out.push(c);
    }
  }
  return out;
}

/** `palette` here is the editor palette (index 0 unused). */
export function toHexFile(palette: number[]): string {
  return palette.slice(1).map((c) => c.toString(16).padStart(6, '0')).join('\n') + '\n';
}

export function toGplFile(palette: number[], name: string): string {
  const lines = ['GIMP Palette', `Name: ${name}`, 'Columns: 8', '#'];
  for (const c of palette.slice(1)) {
    const r = (c >> 16) & 255;
    const g = (c >> 8) & 255;
    const b = c & 255;
    lines.push(`${String(r).padStart(3)} ${String(g).padStart(3)} ${String(b).padStart(3)}\t#${c.toString(16).padStart(6, '0')}`);
  }
  return lines.join('\n') + '\n';
}

/** A 1-pixel-per-color strip image of the palette, upscaled by `cell`. */
export function paletteImage(palette: number[], cell = 8): RgbaImage {
  const colors = palette.slice(1);
  const w = Math.max(1, colors.length) * cell;
  const img: RgbaImage = { width: w, height: cell, data: new Uint8ClampedArray(w * cell * 4) };
  colors.forEach((c, i) => {
    for (let y = 0; y < cell; y++)
      for (let x = 0; x < cell; x++) {
        const o = (y * w + i * cell + x) * 4;
        img.data[o] = (c >> 16) & 255;
        img.data[o + 1] = (c >> 8) & 255;
        img.data[o + 2] = c & 255;
        img.data[o + 3] = 255;
      }
  });
  return img;
}

/**
 * For each old palette index, the closest index in `next` (both editor palettes).
 * Used to keep a model's look when switching to a different palette.
 */
export function remapTable(old: number[], next: number[]): Uint8Array {
  const table = new Uint8Array(256);
  for (let i = 1; i < old.length; i++) {
    const c = old[i];
    const r = (c >> 16) & 255;
    const g = (c >> 8) & 255;
    const b = c & 255;
    let best = 1;
    let bestD = Infinity;
    for (let j = 1; j < next.length; j++) {
      const n = next[j];
      const d = (((n >> 16) & 255) - r) ** 2 * 0.3 + (((n >> 8) & 255) - g) ** 2 * 0.59 + ((n & 255) - b) ** 2 * 0.11;
      if (d < bestD) {
        bestD = d;
        best = j;
      }
    }
    table[i] = best;
  }
  return table;
}
