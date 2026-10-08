/** Palette helpers. Colors are stored as 0xRRGGBB numbers; index 0 is reserved for "empty". */

export const MAX_COLORS = 255;

/** Default 32-color palette (Endesga 32), a popular general-purpose pixel art palette. */
export const DEFAULT_PALETTE: number[] = [
  0xbe4a2f, 0xd77643, 0xead4aa, 0xe4a672, 0xb86f50, 0x733e39, 0x3e2731, 0xa22633,
  0xe43b44, 0xf77622, 0xfeae34, 0xfee761, 0x63c74d, 0x3e8948, 0x265c42, 0x193c3e,
  0x124e89, 0x0099db, 0x2ce8f5, 0xffffff, 0xc0cbdc, 0x8b9bb4, 0x5a6988, 0x3a4466,
  0x262b44, 0x181425, 0xff0044, 0x68386c, 0xb55088, 0xf6757a, 0xe8b796, 0xc28569,
];

/** Returns the palette as used by the editor: element i is the color of index i (element 0 unused). */
export function makePalette(colors: number[] = DEFAULT_PALETTE): number[] {
  return [0x000000, ...colors.slice(0, MAX_COLORS)];
}

export function hexToNum(hex: string): number {
  return parseInt(hex.replace('#', ''), 16) & 0xffffff;
}

export function numToHex(n: number): string {
  return '#' + (n & 0xffffff).toString(16).padStart(6, '0');
}

export function rgb(n: number): [number, number, number] {
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function fromRgb(r: number, g: number, b: number): number {
  return ((r & 255) << 16) | ((g & 255) << 8) | (b & 255);
}

/** Multiplies a color's channels by `f`, clamped. */
export function shade(n: number, f: number): number {
  const [r, g, b] = rgb(n);
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * f)));
  return fromRgb(c(r), c(g), c(b));
}

/** Index of the closest palette color (ignoring index 0). */
export function nearestIndex(palette: number[], color: number): number {
  const [r, g, b] = rgb(color);
  let best = 1;
  let bestD = Infinity;
  for (let i = 1; i < palette.length; i++) {
    const [pr, pg, pb] = rgb(palette[i]);
    const d = (pr - r) ** 2 * 0.3 + (pg - g) ** 2 * 0.59 + (pb - b) ** 2 * 0.11;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}
