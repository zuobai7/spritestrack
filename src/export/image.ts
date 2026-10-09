/** A plain RGBA image buffer, independent of the DOM so it can be tested in Node. */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export function createImage(width: number, height: number): RgbaImage {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

export function putPixel(img: RgbaImage, x: number, y: number, color: number, alpha = 255): void {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const i = (y * img.width + x) * 4;
  img.data[i] = (color >> 16) & 255;
  img.data[i + 1] = (color >> 8) & 255;
  img.data[i + 2] = color & 255;
  img.data[i + 3] = alpha;
}

export function alphaAt(img: RgbaImage, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return 0;
  return img.data[(y * img.width + x) * 4 + 3];
}

/** Nearest-neighbor upscale by an integer factor. */
export function scaleImage(img: RgbaImage, factor: number): RgbaImage {
  const f = Math.max(1, Math.floor(factor));
  if (f === 1) return img;
  const out = createImage(img.width * f, img.height * f);
  for (let y = 0; y < out.height; y++)
    for (let x = 0; x < out.width; x++) {
      const s = ((Math.floor(y / f) * img.width + Math.floor(x / f)) * 4) | 0;
      const d = (y * out.width + x) * 4;
      out.data[d] = img.data[s];
      out.data[d + 1] = img.data[s + 1];
      out.data[d + 2] = img.data[s + 2];
      out.data[d + 3] = img.data[s + 3];
    }
  return out;
}

/**
 * Adds a 1px outline around opaque pixels (4-neighborhood). Semi-transparent
 * pixels such as a ground shadow don't count, so the outline hugs the model.
 */
export function outlineImage(img: RgbaImage, color: number): RgbaImage {
  const out: RgbaImage = { width: img.width, height: img.height, data: img.data.slice() };
  const solid = (x: number, y: number) => alphaAt(img, x, y) >= 128;
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++) {
      if (solid(x, y)) continue;
      if (solid(x - 1, y) || solid(x + 1, y) || solid(x, y - 1) || solid(x, y + 1)) putPixel(out, x, y, color);
    }
  return out;
}

/** Copies `src` into `dst` at (dx, dy), overwriting. */
export function blit(dst: RgbaImage, src: RgbaImage, dx: number, dy: number): void {
  for (let y = 0; y < src.height; y++) {
    const ty = y + dy;
    if (ty < 0 || ty >= dst.height) continue;
    for (let x = 0; x < src.width; x++) {
      const tx = x + dx;
      if (tx < 0 || tx >= dst.width) continue;
      const s = (y * src.width + x) * 4;
      const d = (ty * dst.width + tx) * 4;
      dst.data[d] = src.data[s];
      dst.data[d + 1] = src.data[s + 1];
      dst.data[d + 2] = src.data[s + 2];
      dst.data[d + 3] = src.data[s + 3];
    }
  }
}

export interface SheetFrame {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Packs equally sized cells into a grid sheet. `rows[r][c]` ends up at row r,
 * column c. Returns the sheet plus frame rectangles for metadata.
 */
export function packSheet(rows: { name: string; images: RgbaImage[] }[], gap = 0): { image: RgbaImage; frames: SheetFrame[] } {
  const all = rows.flatMap((r) => r.images);
  if (all.length === 0) return { image: createImage(1, 1), frames: [] };
  const cw = all[0].width;
  const ch = all[0].height;
  const cols = Math.max(...rows.map((r) => r.images.length));
  const image = createImage(cols * cw + (cols - 1) * gap, rows.length * ch + (rows.length - 1) * gap);
  const frames: SheetFrame[] = [];
  rows.forEach((row, r) =>
    row.images.forEach((img, c) => {
      const x = c * (cw + gap);
      const y = r * (ch + gap);
      blit(image, img, x, y);
      frames.push({ name: `${row.name}_${c}`, x, y, w: cw, h: ch });
    }),
  );
  return { image, frames };
}

/** Trims fully transparent borders shared by all images so every cell keeps the same size. */
export function trimCommon(images: RgbaImage[], pad = 0): RgbaImage[] {
  if (images.length === 0) return images;
  const { width, height } = images[0];
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (const img of images)
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        if (img.data[(y * width + x) * 4 + 3]) {
          if (x < x0) x0 = x;
          if (y < y0) y0 = y;
          if (x > x1) x1 = x;
          if (y > y1) y1 = y;
        }
  if (x1 < 0) return images;
  x0 = Math.max(0, x0 - pad);
  y0 = Math.max(0, y0 - pad);
  x1 = Math.min(width - 1, x1 + pad);
  y1 = Math.min(height - 1, y1 + pad);
  return images.map((img) => {
    const out = createImage(x1 - x0 + 1, y1 - y0 + 1);
    blit(out, img, -x0, -y0);
    return out;
  });
}
