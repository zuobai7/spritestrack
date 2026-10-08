import { VoxelGrid } from '../core/VoxelGrid';

/**
 * MagicaVoxel .vox support.
 *
 * MagicaVoxel is Z-up; SpriteStrack is Y-up. Mapping keeps handedness:
 *   ours (x, y, z) = vox (x, z, sizeY - 1 - y)
 * Palette: vox color index i (1..255) uses RGBA entry i-1, which maps directly
 * onto our palette index i.
 */

function chunk(id: string, content: Uint8Array, children: Uint8Array = new Uint8Array()): Uint8Array {
  const out = new Uint8Array(12 + content.length + children.length);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) out[i] = id.charCodeAt(i);
  dv.setUint32(4, content.length, true);
  dv.setUint32(8, children.length, true);
  out.set(content, 12);
  out.set(children, 12 + content.length);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Writes one or more grids (e.g. animation frames) as models in a .vox file. Max 256 per axis. */
export function writeVox(grids: VoxelGrid[], palette: number[]): Uint8Array {
  const models: Uint8Array[] = [];
  for (const g of grids) {
    if (g.sx > 256 || g.sy > 256 || g.sz > 256) throw new Error('MagicaVoxel supports at most 256 voxels per axis');
    const size = new Uint8Array(12);
    const sv = new DataView(size.buffer);
    sv.setUint32(0, g.sx, true);
    sv.setUint32(4, g.sz, true);
    sv.setUint32(8, g.sy, true);
    const n = g.count();
    const xyzi = new Uint8Array(4 + n * 4);
    new DataView(xyzi.buffer).setUint32(0, n, true);
    let o = 4;
    for (let y = 0; y < g.sy; y++)
      for (let z = 0; z < g.sz; z++)
        for (let x = 0; x < g.sx; x++) {
          const c = g.data[g.index(x, y, z)];
          if (!c) continue;
          xyzi[o++] = x;
          xyzi[o++] = g.sz - 1 - z;
          xyzi[o++] = y;
          xyzi[o++] = c;
        }
    models.push(chunk('SIZE', size), chunk('XYZI', xyzi));
  }
  const rgba = new Uint8Array(256 * 4);
  for (let i = 0; i < 255; i++) {
    const c = palette[i + 1] ?? 0;
    rgba[i * 4] = (c >> 16) & 255;
    rgba[i * 4 + 1] = (c >> 8) & 255;
    rgba[i * 4 + 2] = c & 255;
    rgba[i * 4 + 3] = 255;
  }
  const parts: Uint8Array[] = [];
  if (grids.length > 1) {
    const pack = new Uint8Array(4);
    new DataView(pack.buffer).setUint32(0, grids.length, true);
    parts.push(chunk('PACK', pack));
  }
  parts.push(...models, chunk('RGBA', rgba));
  const main = chunk('MAIN', new Uint8Array(), concat(parts));
  const header = new Uint8Array(8);
  header.set([0x56, 0x4f, 0x58, 0x20]); // "VOX "
  new DataView(header.buffer).setUint32(4, 150, true);
  return concat([header, main]);
}

/** MagicaVoxel's default palette, used when a file has no RGBA chunk. */
function defaultVoxPalette(): number[] {
  const out: number[] = [0];
  // Approximation of the standard 6x6x6 cube + ramps; only used as a fallback.
  const steps = [0xff, 0xcc, 0x99, 0x66, 0x33, 0x00];
  for (const r of steps) for (const g of steps) for (const b of steps) out.push((r << 16) | (g << 8) | b);
  const ramp = [0xee, 0xdd, 0xbb, 0xaa, 0x88, 0x77, 0x55, 0x44, 0x22, 0x11];
  for (const v of ramp) out.push(v << 16);
  for (const v of ramp) out.push(v << 8);
  for (const v of ramp) out.push(v);
  for (const v of ramp) out.push((v << 16) | (v << 8) | v);
  return out.slice(0, 256);
}

export interface VoxFile {
  models: VoxelGrid[];
  palette: number[];
}

export function readVox(buf: Uint8Array): VoxFile {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const magic = String.fromCharCode(buf[0], buf[1], buf[2], buf[3]);
  if (magic !== 'VOX ') throw new Error('Not a MagicaVoxel file');
  const models: VoxelGrid[] = [];
  let palette: number[] | null = null;
  let pendingSize: [number, number, number] | null = null;
  let p = 8;
  const end = buf.length;
  while (p + 12 <= end) {
    const id = String.fromCharCode(buf[p], buf[p + 1], buf[p + 2], buf[p + 3]);
    const contentSize = dv.getUint32(p + 4, true);
    const childSize = dv.getUint32(p + 8, true);
    const c = p + 12;
    if (id === 'MAIN') {
      p = c + contentSize; // descend into children
      continue;
    }
    if (id === 'SIZE') {
      pendingSize = [dv.getUint32(c, true), dv.getUint32(c + 4, true), dv.getUint32(c + 8, true)];
    } else if (id === 'XYZI' && pendingSize) {
      const [vx, vy, vz] = pendingSize;
      const g = new VoxelGrid(vx, vz, vy);
      const n = dv.getUint32(c, true);
      for (let i = 0; i < n; i++) {
        const o = c + 4 + i * 4;
        g.set(buf[o], buf[o + 2], vy - 1 - buf[o + 1], buf[o + 3]);
      }
      models.push(g);
      pendingSize = null;
    } else if (id === 'RGBA') {
      palette = [0];
      for (let i = 0; i < 255; i++) {
        const o = c + i * 4;
        palette.push((buf[o] << 16) | (buf[o + 1] << 8) | buf[o + 2]);
      }
    }
    p = c + contentSize + childSize;
  }
  return { models, palette: palette ?? defaultVoxPalette() };
}
