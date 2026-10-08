import { Euler, Matrix4, Vector3 } from 'three';
import { VoxelGrid } from './VoxelGrid';

/**
 * Part-based skeletal animation.
 *
 * The model is split into parts by painting a part id onto voxels (`partMap`,
 * same size as the model; 0 = the root "body" part). Each part has a pivot
 * and a parent, forming a hierarchy. A rig animation stores rotation/offset
 * keyframes per part; baking samples them at every frame, transforms each
 * part's voxels and writes ordinary voxel frames, which the rest of the
 * editor (sprite export, model export) uses like hand-made frames.
 */

export type V3 = [number, number, number];

export interface RigPart {
  id: number;
  name: string;
  /** Display color for the part overlay. */
  color: number;
  /** Rotation center in grid units (voxel corners are integers, centers are .5). */
  pivot: V3;
  /** Parent part id; -1 only for the root part (id 0). */
  parent: number;
}

export interface RigKey {
  frame: number;
  /** Euler rotation in degrees, applied in XYZ order around the pivot. */
  rot: V3;
  /** Offset in voxels, in the parent's space. */
  pos: V3;
}

export interface RigTrack {
  part: number;
  keys: RigKey[];
}

export type Easing = 'linear' | 'smooth' | 'step';

export interface RigAnimation {
  name: string;
  fps: number;
  /** Number of frames to bake. */
  length: number;
  /** Interpolate from the last key back to the first. */
  loop: boolean;
  easing: Easing;
  tracks: RigTrack[];
}

export interface Rig {
  parts: RigPart[];
  partMap: VoxelGrid;
  animations: RigAnimation[];
  /** Which project frame is the rest pose that gets animated. */
  source: { anim: number; frame: number };
}

export const PART_COLORS = [
  0xff5c5c, 0x5cb8ff, 0x7cff5c, 0xffd25c, 0xc05cff, 0x5cffe0, 0xff8f3d, 0xff5cc8, 0xb0ff3d, 0x3d7bff, 0xffffff, 0x9c9c9c,
];

export function createRig(sx: number, sy: number, sz: number): Rig {
  return {
    parts: [{ id: 0, name: 'body', color: 0x9aa4b8, pivot: [sx / 2, 0, sz / 2], parent: -1 }],
    partMap: new VoxelGrid(sx, sy, sz),
    animations: [],
    source: { anim: 0, frame: 0 },
  };
}

/** Deep copy of everything except `partMap`, which is shared (it is edited through undoable diffs). */
export function cloneRigMeta(r: Rig): Rig {
  return {
    parts: r.parts.map((p) => ({ ...p, pivot: [...p.pivot] as V3 })),
    partMap: r.partMap,
    animations: r.animations.map(cloneRigAnimation),
    source: { ...r.source },
  };
}

export function cloneRigAnimation(a: RigAnimation): RigAnimation {
  return {
    ...a,
    tracks: a.tracks.map((t) => ({ part: t.part, keys: t.keys.map((k) => ({ frame: k.frame, rot: [...k.rot] as V3, pos: [...k.pos] as V3 })) })),
  };
}

export function getPart(rig: Rig, id: number): RigPart | undefined {
  return rig.parts.find((p) => p.id === id);
}

/** Adds a part and returns its id (lowest free id in 1..255), or -1 if full. */
export function addPart(rig: Rig, name: string, pivot?: V3, parent = 0): number {
  const used = new Set(rig.parts.map((p) => p.id));
  let id = 1;
  while (used.has(id) && id < 256) id++;
  if (id > 255) return -1;
  const { sx, sz } = rig.partMap;
  rig.parts.push({
    id,
    name,
    color: PART_COLORS[(id - 1) % PART_COLORS.length],
    pivot: pivot ?? [sx / 2, 0, sz / 2],
    parent,
  });
  return id;
}

/** Removes a part: its voxels and children go to its parent, its tracks are dropped. */
export function removePart(rig: Rig, id: number): void {
  if (id === 0) return;
  const part = getPart(rig, id);
  if (!part) return;
  const parent = part.parent < 0 ? 0 : part.parent;
  const d = rig.partMap.data;
  for (let i = 0; i < d.length; i++) if (d[i] === id) d[i] = parent;
  for (const p of rig.parts) if (p.parent === id) p.parent = parent;
  rig.parts = rig.parts.filter((p) => p.id !== id);
  for (const a of rig.animations) a.tracks = a.tracks.filter((t) => t.part !== id);
}

/** True if making `parent` the parent of `id` would create a cycle. */
export function wouldCycle(rig: Rig, id: number, parent: number): boolean {
  let cur: number = parent;
  for (let guard = 0; guard < 300 && cur >= 0; guard++) {
    if (cur === id) return true;
    cur = getPart(rig, cur)?.parent ?? -1;
  }
  return false;
}

/** Parts ordered parents-first. */
export function partOrder(rig: Rig): RigPart[] {
  const out: RigPart[] = [];
  const seen = new Set<number>();
  const visit = (p: RigPart, depth: number) => {
    if (seen.has(p.id) || depth > 300) return;
    const parent = p.parent >= 0 ? getPart(rig, p.parent) : undefined;
    if (parent && !seen.has(parent.id)) visit(parent, depth + 1);
    seen.add(p.id);
    out.push(p);
  };
  for (const p of rig.parts) visit(p, 0);
  return out;
}

/** Bounding box (inclusive) of a part's filled voxels in `source`, or null. */
export function partBounds(rig: Rig, source: VoxelGrid, id: number): { min: V3; max: V3 } | null {
  const pm = rig.partMap;
  let found = false;
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < source.data.length; i++) {
    if (!source.data[i] || pm.data[i] !== id) continue;
    const c = source.coords(i);
    found = true;
    for (let a = 0; a < 3; a++) {
      if (c[a] < min[a]) min[a] = c[a];
      if (c[a] > max[a]) max[a] = c[a];
    }
  }
  return found ? { min, max } : null;
}

// ---- keyframes ------------------------------------------------------------

function track(anim: RigAnimation, part: number, create: boolean): RigTrack | undefined {
  let t = anim.tracks.find((x) => x.part === part);
  if (!t && create) {
    t = { part, keys: [] };
    anim.tracks.push(t);
  }
  return t;
}

export function setKey(anim: RigAnimation, part: number, key: RigKey): void {
  const t = track(anim, part, true)!;
  const i = t.keys.findIndex((k) => k.frame === key.frame);
  const copy: RigKey = { frame: key.frame, rot: [...key.rot] as V3, pos: [...key.pos] as V3 };
  if (i >= 0) t.keys[i] = copy;
  else t.keys.push(copy);
  t.keys.sort((a, b) => a.frame - b.frame);
}

export function removeKey(anim: RigAnimation, part: number, frame: number): void {
  const t = track(anim, part, false);
  if (!t) return;
  t.keys = t.keys.filter((k) => k.frame !== frame);
  if (t.keys.length === 0) anim.tracks = anim.tracks.filter((x) => x !== t);
}

export function hasKey(anim: RigAnimation, part: number, frame: number): boolean {
  return !!track(anim, part, false)?.keys.some((k) => k.frame === frame);
}

const ease = (t: number, e: Easing) => (e === 'step' ? 0 : e === 'smooth' ? t * t * (3 - 2 * t) : t);

/** Interpolated rotation/offset of a part at `frame` (may be fractional). */
export function sampleTrack(anim: RigAnimation, part: number, frame: number): { rot: V3; pos: V3 } {
  const t = track(anim, part, false);
  if (!t || t.keys.length === 0) return { rot: [0, 0, 0], pos: [0, 0, 0] };
  const keys = t.keys;
  if (keys.length === 1) return { rot: [...keys[0].rot] as V3, pos: [...keys[0].pos] as V3 };
  let a: RigKey | null = null;
  let b: RigKey | null = null;
  let f = frame;
  for (let i = 0; i < keys.length - 1; i++)
    if (f >= keys[i].frame && f <= keys[i + 1].frame) {
      a = keys[i];
      b = keys[i + 1];
      break;
    }
  if (!a || !b) {
    const first = keys[0];
    const last = keys[keys.length - 1];
    if (anim.loop && anim.length > 0) {
      // Wrap segment: last key -> first key one loop later
      a = last;
      b = { ...first, frame: first.frame + anim.length };
      if (f < last.frame) f += anim.length;
    } else {
      const k = f < first.frame ? first : last;
      return { rot: [...k.rot] as V3, pos: [...k.pos] as V3 };
    }
  }
  const span = b.frame - a.frame;
  const u = span <= 0 ? 0 : ease(Math.max(0, Math.min(1, (f - a.frame) / span)), anim.easing);
  const mix = (x: V3, y: V3): V3 => [x[0] + (y[0] - x[0]) * u, x[1] + (y[1] - x[1]) * u, x[2] + (y[2] - x[2]) * u];
  return { rot: mix(a.rot, b.rot), pos: mix(a.pos, b.pos) };
}

// ---- baking ---------------------------------------------------------------

const DEG = Math.PI / 180;

/** World matrix (grid space) of every part at `frame`. */
export function partMatrices(rig: Rig, anim: RigAnimation | null, frame: number): Map<number, Matrix4> {
  const out = new Map<number, Matrix4>();
  for (const p of partOrder(rig)) {
    const s = anim ? sampleTrack(anim, p.id, frame) : { rot: [0, 0, 0] as V3, pos: [0, 0, 0] as V3 };
    const local = new Matrix4()
      .makeTranslation(s.pos[0] + p.pivot[0], s.pos[1] + p.pivot[1], s.pos[2] + p.pivot[2])
      .multiply(new Matrix4().makeRotationFromEuler(new Euler(s.rot[0] * DEG, s.rot[1] * DEG, s.rot[2] * DEG, 'XYZ')))
      .multiply(new Matrix4().makeTranslation(-p.pivot[0], -p.pivot[1], -p.pivot[2]));
    const parent = p.parent >= 0 ? out.get(p.parent) : undefined;
    out.set(p.id, parent ? parent.clone().multiply(local) : local);
  }
  return out;
}

/** Renders the source model posed at `frame` into a new grid. */
export function bakeFrame(source: VoxelGrid, rig: Rig, anim: RigAnimation | null, frame: number): VoxelGrid {
  const out = new VoxelGrid(source.sx, source.sy, source.sz);
  const mats = partMatrices(rig, anim, frame);
  const pm = rig.partMap.data;
  const v = new Vector3();
  for (const p of partOrder(rig)) {
    const b = partBounds(rig, source, p.id);
    if (!b) continue;
    const m = mats.get(p.id)!;
    // Output-space bounds of the transformed part
    const lo: V3 = [Infinity, Infinity, Infinity];
    const hi: V3 = [-Infinity, -Infinity, -Infinity];
    for (let c = 0; c < 8; c++) {
      v.set(c & 1 ? b.max[0] + 1 : b.min[0], c & 2 ? b.max[1] + 1 : b.min[1], c & 4 ? b.max[2] + 1 : b.min[2]).applyMatrix4(m);
      lo[0] = Math.min(lo[0], v.x);
      lo[1] = Math.min(lo[1], v.y);
      lo[2] = Math.min(lo[2], v.z);
      hi[0] = Math.max(hi[0], v.x);
      hi[1] = Math.max(hi[1], v.y);
      hi[2] = Math.max(hi[2], v.z);
    }
    const x0 = Math.max(0, Math.floor(lo[0]));
    const y0 = Math.max(0, Math.floor(lo[1]));
    const z0 = Math.max(0, Math.floor(lo[2]));
    const x1 = Math.min(source.sx - 1, Math.ceil(hi[0]));
    const y1 = Math.min(source.sy - 1, Math.ceil(hi[1]));
    const z1 = Math.min(source.sz - 1, Math.ceil(hi[2]));
    const e = m.clone().invert().elements;
    for (let y = y0; y <= y1; y++)
      for (let z = z0; z <= z1; z++)
        for (let x = x0; x <= x1; x++) {
          const cx = x + 0.5;
          const cy = y + 0.5;
          const cz = z + 0.5;
          // Inverse-map the output cell center into the rest pose (column-major elements)
          const px = Math.floor(e[0] * cx + e[4] * cy + e[8] * cz + e[12] + 1e-6);
          const py = Math.floor(e[1] * cx + e[5] * cy + e[9] * cz + e[13] + 1e-6);
          const pz = Math.floor(e[2] * cx + e[6] * cy + e[10] * cz + e[14] + 1e-6);
          if (!source.inBounds(px, py, pz)) continue;
          const si = source.index(px, py, pz);
          const c = source.data[si];
          if (c && pm[si] === p.id) out.data[out.index(x, y, z)] = c;
        }
  }
  return out;
}

export function bakeAnimation(source: VoxelGrid, rig: Rig, anim: RigAnimation): VoxelGrid[] {
  const n = Math.max(1, Math.floor(anim.length));
  return Array.from({ length: n }, (_, f) => bakeFrame(source, rig, anim, f));
}

// ---- templates ------------------------------------------------------------

export type Template = 'swing' | 'bob' | 'spin' | 'shake';

/**
 * Writes a looping motion for one part. `amount` is degrees for rotations and
 * voxels for `bob`; `phase` (0..1) shifts the motion so two legs can alternate.
 */
export function applyTemplate(anim: RigAnimation, part: number, tpl: Template, opts: { axis: 0 | 1 | 2; amount: number; phase: number }): void {
  const L = Math.max(1, anim.length);
  const t = track(anim, part, true)!;
  t.keys = [];
  const shift = (f: number) => (((f + Math.round(opts.phase * L)) % L) + L) % L;
  const rot = (deg: number): V3 => {
    const r: V3 = [0, 0, 0];
    r[opts.axis] = deg;
    return r;
  };
  if (tpl === 'spin') {
    // A key on every frame: no wrap-around interpolation issues
    for (let f = 0; f < L; f++) t.keys.push({ frame: f, rot: rot((360 * shift(f)) / L), pos: [0, 0, 0] });
  } else {
    for (let f = 0; f < L; f++) {
      const w = Math.sin((2 * Math.PI * shift(f)) / L);
      if (tpl === 'swing') t.keys.push({ frame: f, rot: rot(w * opts.amount), pos: [0, 0, 0] });
      else if (tpl === 'bob') {
        const p: V3 = [0, 0, 0];
        p[opts.axis] = Math.round(Math.abs(w) * opts.amount);
        t.keys.push({ frame: f, rot: [0, 0, 0], pos: p });
      } else {
        const p: V3 = [0, 0, 0];
        p[opts.axis] = Math.round(Math.sin((4 * Math.PI * shift(f)) / L) * opts.amount);
        t.keys.push({ frame: f, rot: [0, 0, 0], pos: p });
      }
    }
  }
  t.keys.sort((a, b) => a.frame - b.frame);
}
