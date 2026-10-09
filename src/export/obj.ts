import type { VoxelGrid } from '../core/VoxelGrid';
import { buildGreedyQuads } from '../core/mesher';
import { rgb } from '../core/Palette';

/** A name as one OBJ/MTL token (no whitespace). */
export const objToken = (name: string) => name.trim().replace(/\s+/g, '_') || 'model';

export interface ModelExportOptions {
  /** World units per voxel. */
  scale: number;
  /** Center the model on x/z (y stays at 0 = ground). */
  center: boolean;
}

/** Exports a Wavefront OBJ + MTL pair. One material per palette color used. */
export function exportObj(
  grid: VoxelGrid,
  palette: number[],
  name: string,
  opts: ModelExportOptions & { mtlName?: string },
): { obj: string; mtl: string } {
  const quads = buildGreedyQuads(grid);
  const ox = opts.center ? grid.sx / 2 : 0;
  const oz = opts.center ? grid.sz / 2 : 0;
  const s = opts.scale;
  // OBJ splits these lines at whitespace, so names must not contain any
  const lines: string[] = [`# Exported by SpriteStrack`, `mtllib ${objToken(opts.mtlName ?? name)}.mtl`, `o ${objToken(name)}`];
  const normals = ['1 0 0', '-1 0 0', '0 1 0', '0 -1 0', '0 0 1', '0 0 -1'];
  for (const n of normals) lines.push(`vn ${n}`);
  const normalIndex = (n: number[]) => normals.indexOf(n.join(' ')) + 1;
  const byColor = new Map<number, string[]>();
  let v = 1;
  for (const q of quads) {
    for (const c of q.corners) lines.push(`v ${fmt((c[0] - ox) * s)} ${fmt(c[1] * s)} ${fmt((c[2] - oz) * s)}`);
    const ni = normalIndex(q.normal);
    const face = `f ${v}//${ni} ${v + 1}//${ni} ${v + 2}//${ni} ${v + 3}//${ni}`;
    v += 4;
    if (!byColor.has(q.color)) byColor.set(q.color, []);
    byColor.get(q.color)!.push(face);
  }
  for (const [color, faces] of [...byColor].sort((a, b) => a[0] - b[0])) lines.push(`usemtl color_${color}`, ...faces);
  return { obj: lines.join('\n') + '\n', mtl: exportMtl(palette, byColor.keys()) };
}

const fmt = (n: number) => (Math.round(n * 1e5) / 1e5).toString();

/** Material library with one flat material per palette index, shared by OBJ files that use `color_<index>`. */
export function exportMtl(palette: number[], colors: Iterable<number>): string {
  const mtl: string[] = ['# Exported by SpriteStrack'];
  for (const color of [...new Set(colors)].sort((a, b) => a - b)) {
    const [r, g, b] = rgb(palette[color] ?? 0xff00ff);
    mtl.push(`newmtl color_${color}`, `Kd ${fmt(r / 255)} ${fmt(g / 255)} ${fmt(b / 255)}`, 'Ka 0 0 0', 'Ks 0 0 0', 'd 1', 'illum 1', '');
  }
  return mtl.join('\n');
}
