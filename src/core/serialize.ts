import { VoxelGrid } from './VoxelGrid';
import { Project, type Animation } from './Project';
import type { Rig, RigAnimation, RigPart } from './rig';

/** Run-length encodes bytes as (count, value) pairs with count in 1..255. */
export function rleEncode(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < data.length) {
    const v = data[i];
    let n = 1;
    while (n < 255 && i + n < data.length && data[i + n] === v) n++;
    out.push(n, v);
    i += n;
  }
  return Uint8Array.from(out);
}

export function rleDecode(rle: Uint8Array, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let o = 0;
  for (let i = 0; i + 1 < rle.length; i += 2) {
    const n = rle[i];
    const v = rle[i + 1];
    if (o + n > length) throw new Error('RLE data overflows grid');
    out.fill(v, o, o + n);
    o += n;
  }
  if (o !== length) throw new Error(`RLE data length ${o} != ${length}`);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export const FORMAT = 'spritestrack';
export const FORMAT_VERSION = 2;

interface ProjectJson {
  format: string;
  version: number;
  name: string;
  size: [number, number, number];
  /** Active palette (kept for v1 readers). */
  palette: string[];
  animations: { name: string; fps: number; frames: string[] }[];
  /** v2: all color schemes. */
  variants?: { name: string; palette: string[] }[];
  activeVariant?: number;
  /** v2: skeletal rig. */
  rig?: { parts: RigPart[]; partMap: string; animations: RigAnimation[]; source: { anim: number; frame: number } } | null;
}

const hexList = (pal: number[]) => pal.slice(1).map((c) => c.toString(16).padStart(6, '0'));
const parseHexList = (list: string[]) => [0, ...list.map((h) => parseInt(h, 16) & 0xffffff)];

export function serializeProject(p: Project): string {
  const json: ProjectJson = {
    format: FORMAT,
    version: FORMAT_VERSION,
    name: p.name,
    size: [p.sx, p.sy, p.sz],
    palette: hexList(p.palette),
    animations: p.animations.map((a) => ({
      name: a.name,
      fps: a.fps,
      frames: a.frames.map((f) => bytesToBase64(rleEncode(f.data))),
    })),
    variants: p.variants.map((v) => ({ name: v.name, palette: hexList(v.palette) })),
    activeVariant: p.activeVariant,
    rig: p.rig
      ? {
          parts: p.rig.parts,
          partMap: bytesToBase64(rleEncode(p.rig.partMap.data)),
          animations: p.rig.animations,
          source: p.rig.source,
        }
      : null,
  };
  return JSON.stringify(json);
}

export function deserializeProject(text: string): Project {
  const json = JSON.parse(text) as ProjectJson;
  if (json.format !== FORMAT) throw new Error('Not a SpriteStrack project file');
  if (json.version > FORMAT_VERSION) throw new Error(`Unsupported project version ${json.version}`);
  const [sx, sy, sz] = json.size;
  const p = new Project(sx, sy, sz, json.name);
  if (json.variants && json.variants.length) {
    p.variants = json.variants.map((v) => ({ name: v.name, palette: parseHexList(v.palette) }));
    p.activeVariant = Math.max(0, Math.min(p.variants.length - 1, json.activeVariant ?? 0));
  } else {
    p.palette = parseHexList(json.palette);
  }
  const n = sx * sy * sz;
  p.animations = json.animations.map(
    (a): Animation => ({
      name: a.name,
      fps: a.fps,
      frames: a.frames.map((f) => new VoxelGrid(sx, sy, sz, rleDecode(base64ToBytes(f), n))),
    }),
  );
  if (p.animations.length === 0) p.animations.push({ name: 'idle', fps: 8, frames: [new VoxelGrid(sx, sy, sz)] });
  if (json.rig) {
    const rig: Rig = {
      parts: json.rig.parts,
      partMap: new VoxelGrid(sx, sy, sz, rleDecode(base64ToBytes(json.rig.partMap), n)),
      animations: json.rig.animations,
      source: json.rig.source ?? { anim: 0, frame: 0 },
    };
    p.rig = rig;
  }
  return p;
}
