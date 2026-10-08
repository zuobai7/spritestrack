// Draws the app icon (an isometric voxel cube built from stacked layers) and
// writes the PNGs used by the web app. The desktop icons are generated from
// app-icon.png with `npx tauri icon app-icon.png`.
//
// Usage: node scripts/make-icons.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';

function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x + 0.5, y + 0.5);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = a;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const hex = (h) => [(h >> 16) & 255, (h >> 8) & 255, h & 255];
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

/**
 * Pixel shader for the icon at unit coordinates (0..1). `pad` shrinks the
 * artwork (maskable icons need a safe zone); `bg` false leaves it transparent.
 */
function icon(u, v, { pad = 0, bg = true, round = 0.22 } = {}) {
  const BG = hex(0x1d1e25);
  // Rounded-square background
  let inside = true;
  if (bg && round > 0) {
    const r = round;
    const cx = Math.min(Math.max(u, r), 1 - r);
    const cy = Math.min(Math.max(v, r), 1 - r);
    inside = (u - cx) ** 2 + (v - cy) ** 2 <= r * r;
  }
  let out = bg && inside ? [...BG, 255] : [0, 0, 0, 0];
  // Isometric cube of N^3 voxels
  const N = 4;
  // Voxel edge length so the cube is 60% of the icon wide
  const s = ((1 - 2 * pad) * 0.6) / (2 * N * Math.cos(Math.PI / 6));
  const c30 = Math.cos(Math.PI / 6);
  const ex = [c30 * s, 0.5 * s];
  const ez = [-c30 * s, 0.5 * s];
  const ey = [0, -s];
  const O = [0.5, 0.5];
  const solve = (p, a, b) => {
    const det = a[0] * b[1] - a[1] * b[0];
    return [(p[0] * b[1] - p[1] * b[0]) / det, (a[0] * p[1] - a[1] * p[0]) / det];
  };
  const P = [u - O[0], v - O[1]];
  const faces = [
    // top (y = N): accent blue; left (z = N); right (x = N)
    { base: [N * ey[0], N * ey[1]], a: ex, b: ez, color: 0x5aa0ff, dark: 0.0 },
    { base: [N * ez[0], N * ez[1]], a: ex, b: ey, color: 0x3f7fd6, dark: 0.0 },
    { base: [N * ex[0], N * ex[1]], a: ez, b: ey, color: 0x2b5aa3, dark: 0.0 },
  ];
  for (const f of faces) {
    const [x, y] = solve([P[0] - f.base[0], P[1] - f.base[1]], f.a, f.b);
    if (x < 0 || y < 0 || x > N || y > N) continue;
    const fx = x - Math.floor(x);
    const fy = y - Math.floor(y);
    const gap = 0.07;
    let col = hex(f.color);
    // Checker variation per voxel, darker gaps between voxels
    if ((Math.floor(x) + Math.floor(y)) % 2) col = mix(col, [255, 255, 255], 0.08);
    if (f === faces[0] && Math.floor(x) === 1 && Math.floor(y) === 2) col = hex(0xffd23d);
    if (fx < gap || fy < gap || fx > 1 - gap || fy > 1 - gap) col = mix(col, [10, 12, 20], 0.55);
    out = [...col, 255];
    break;
  }
  return out;
}

function render(size, opts) {
  // 3x3 supersampling for smooth edges
  return png(size, (x, y) => {
    const acc = [0, 0, 0, 0];
    for (let j = 0; j < 3; j++)
      for (let i = 0; i < 3; i++) {
        const c = icon((x - 0.5 + (i + 0.5) / 3) / size, (y - 0.5 + (j + 0.5) / 3) / size, opts);
        acc[0] += c[0] * c[3];
        acc[1] += c[1] * c[3];
        acc[2] += c[2] * c[3];
        acc[3] += c[3];
      }
    const a = acc[3];
    return a === 0 ? [0, 0, 0, 0] : [Math.round(acc[0] / a), Math.round(acc[1] / a), Math.round(acc[2] / a), Math.round(a / 9)];
  });
}

mkdirSync('public/icons', { recursive: true });
writeFileSync('app-icon.png', render(1024, {}));
writeFileSync('public/icons/icon-192.png', render(192, {}));
writeFileSync('public/icons/icon-512.png', render(512, {}));
writeFileSync('public/icons/maskable-512.png', render(512, { pad: 0.12, round: 0 }));
writeFileSync('public/favicon.png', render(64, { round: 0.18 }));
console.log('icons written');
