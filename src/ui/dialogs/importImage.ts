import type { Editor } from '../../editor/Editor';
import { Project } from '../../core/Project';
import type { VoxelGrid } from '../../core/VoxelGrid';
import { MAX_COLORS } from '../../core/Palette';
import { ColorMapper, fitImage, importExtrude, importHeightmap, importSliceStrip } from '../../core/imageImport';
import { medianCut } from '../../export/gif';
import type { RgbaImage } from '../../export/image';
import { renderStack } from '../../export/stackRenderer';
import { t } from '../../i18n';
import { checkbox, confirmBox, drawFit, fill, h, numberField, openModal, pickFile, rangeInput, row, select, toast } from '../dom';
import { loadImageFile } from '../files';
import { icon } from '../icons';

type Mode = 'strip' | 'extrude' | 'heightmap';

interface ImportState {
  mode: Mode;
  slices: number;
  dir: 'horizontal' | 'vertical';
  depth: number;
  orient: 'front' | 'top';
  maxHeight: number;
  colorFrom: 'image' | 'single';
  max: number;
  addColors: boolean;
  dest: 'new' | 'frame';
}

/** A strip of square slices is the usual sprite-stacking export; guess it from the aspect ratio. */
function guess(img: RgbaImage): Pick<ImportState, 'mode' | 'slices' | 'dir'> {
  const { width: w, height: hh } = img;
  if (w >= hh * 2 && w % hh === 0) return { mode: 'strip', slices: w / hh, dir: 'horizontal' };
  if (hh >= w * 2 && hh % w === 0) return { mode: 'strip', slices: hh / w, dir: 'vertical' };
  return { mode: 'extrude', slices: 8, dir: 'horizontal' };
}

function colorCounts(img: RgbaImage): Map<number, number> {
  const m = new Map<number, number>();
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 128) continue;
    const c = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
    m.set(c, (m.get(c) ?? 0) + 1);
  }
  return m;
}

export async function openImageImport(ed: Editor, file?: File): Promise<void> {
  file ??= (await pickFile('image/png,image/gif,image/jpeg,image/webp,image/bmp')) ?? undefined;
  if (!file) return;
  let src: RgbaImage;
  try {
    src = (await loadImageFile(file)).image;
  } catch (e) {
    toast(t('loadError') + (e as Error).message);
    return;
  }
  const name = file.name.replace(/\.[^.]+$/, '') || 'image';
  const st: ImportState = { ...guess(src), depth: 2, orient: 'front', maxHeight: 16, colorFrom: 'image', max: 128, addColors: true, dest: 'new' };
  let result: { grid: VoxelGrid; palette: number[] } | null = null;
  let angle = 35;

  const form = h('div', { class: 'col' });
  const canvas = h('canvas', { width: 380, height: 340 });
  const meta = h('div', { class: 'meta' });
  const err = h('div', { class: 'error' });
  const timer = window.setInterval(() => {
    angle = (angle + 3) % 360;
    draw();
  }, 120);
  const m = openModal(`${t('importImageTitle')} · ${file.name}`, { wide: true, onClose: () => clearInterval(timer) });

  const build = () => {
    const fresh = st.dest === 'new' && st.addColors && !(st.mode === 'heightmap' && st.colorFrom === 'single');
    const palette = fresh ? [0] : ed.project.palette.slice();
    let img = src;
    if (st.mode === 'strip') {
      const n = Math.max(1, Math.floor(st.slices));
      const sw = st.dir === 'horizontal' ? img.width / n : img.width;
      const sh = st.dir === 'horizontal' ? img.height : img.height / n;
      const s = Math.min(1, st.max / Math.max(sw, sh));
      if (s < 1) img = fitImage(img, Math.floor(Math.max(img.width, img.height) * s));
    } else img = fitImage(img, st.max);
    // Too many colors for the palette: reduce them with median cut first, then map to the nearest
    let add = st.addColors;
    if (add) {
      const counts = colorCounts(img);
      const room = MAX_COLORS + 1 - palette.length;
      const missing = [...counts.keys()].filter((c) => palette.indexOf(c, 1) < 0);
      if (missing.length > room) {
        palette.push(...medianCut(new Map(missing.map((c) => [c, counts.get(c)!])), Math.max(1, room)));
        add = false;
      }
    }
    const mapper = new ColorMapper(palette, add);
    let grid: VoxelGrid;
    if (st.mode === 'strip') grid = importSliceStrip(img, st.slices, st.dir, mapper);
    else if (st.mode === 'extrude') grid = importExtrude(img, st.depth, st.orient, mapper);
    else grid = importHeightmap(img, st.maxHeight, mapper, st.colorFrom, ed.color);
    return { grid, palette };
  };

  const draw = () => {
    if (!result) return;
    const g = result.grid;
    drawFit(canvas, renderStack(g, result.palette, { angle, light: ed.light, padding: Math.ceil(g.sy / 3) }), 8);
  };

  const update = () => {
    err.textContent = '';
    try {
      result = build();
      const g = result.grid;
      const p = ed.project;
      meta.textContent = `${g.sx} × ${g.sy} × ${g.sz} · ${g.count()} ${t('voxels')}`;
      if (st.dest === 'frame' && (g.sx > p.sx || g.sy > p.sy || g.sz > p.sz)) err.textContent = `${t('willCrop')} (${p.sx} × ${p.sy} × ${p.sz})`;
      draw();
    } catch (e) {
      result = null;
      err.textContent = (e as Error).message;
    }
  };

  let pending: number | null = null;
  const set = <K extends keyof ImportState>(k: K, v: ImportState[K], rebuild = false) => {
    st[k] = v;
    if (rebuild) renderForm();
    if (pending !== null) clearTimeout(pending);
    pending = window.setTimeout(() => {
      pending = null;
      update();
    }, 120);
  };

  const renderForm = () => {
    fill(
      form,
      h('div', { class: 'hint-text' }, `${t('imageSize')}: ${src.width} × ${src.height}`),
      row(
        t('importMode'),
        select(
          st.mode,
          [
            ['strip', t('modeStrip')],
            ['extrude', t('modeExtrude')],
            ['heightmap', t('modeHeightmap')],
          ],
          (v) => set('mode', v as Mode, true),
        ),
      ),
      h('p', { class: 'hint-text' }, t(st.mode === 'strip' ? 'stripHint' : st.mode === 'extrude' ? 'extrudeHint' : 'heightmapHint')),
      st.mode === 'strip' && row(t('sliceCount'), numberField(st.slices, 1, 256, 1, (v) => set('slices', Math.round(v)))),
      st.mode === 'strip' &&
        row(
          t('sliceDir'),
          select(
            st.dir,
            [
              ['horizontal', t('horizontal')],
              ['vertical', t('vertical')],
            ],
            (v) => set('dir', v as ImportState['dir']),
          ),
        ),
      st.mode === 'extrude' && row(t('depth'), rangeInput(st.depth, 1, 64, 1, (v) => set('depth', v))),
      st.mode === 'extrude' &&
        row(
          t('orientation'),
          select(
            st.orient,
            [
              ['front', t('standing')],
              ['top', t('lying')],
            ],
            (v) => set('orient', v as ImportState['orient']),
          ),
        ),
      st.mode === 'heightmap' && row(t('maxHeight'), rangeInput(st.maxHeight, 1, 128, 1, (v) => set('maxHeight', v))),
      st.mode === 'heightmap' &&
        row(
          t('colors'),
          select(
            st.colorFrom,
            [
              ['image', t('fromImage')],
              ['single', t('currentColor')],
            ],
            (v) => set('colorFrom', v as ImportState['colorFrom']),
          ),
        ),
      row(t('maxSize'), select(String(st.max), ['32', '64', '128', '256'].map((v) => [v, v] as [string, string]), (v) => set('max', Number(v)))),
      row(t('addColors'), checkbox(st.addColors, (v) => set('addColors', v))),
      row(
        t('destination'),
        select(
          st.dest,
          [
            ['new', t('destNew')],
            ['frame', t('destFrame')],
          ],
          (v) => set('dest', v as ImportState['dest']),
        ),
      ),
    );
  };

  const doImport = async () => {
    if (pending !== null) {
      clearTimeout(pending);
      pending = null;
      update();
    }
    if (!result) return;
    const { grid, palette } = result;
    if (st.dest === 'frame') {
      ed.replaceFrameWith(grid, palette);
    } else {
      if (ed.dirty && !(await confirmBox(t('confirmNew'), t('ok'), t('cancel')))) return;
      const p = new Project(grid.sx, grid.sy, grid.sz, name);
      p.palette = palette.length > 1 ? palette : ed.project.palette.slice();
      p.animations[0].frames[0] = grid;
      ed.setProject(p);
    }
    toast(t('imported'));
    m.close();
  };

  m.body.append(h('div', { class: 'two-col' }, form, h('div', { class: 'col' }, h('div', { class: 'preview-box', style: 'min-height:340px' }, canvas, meta), err)));
  m.footer.append(
    h('button', { class: 'btn outline', onclick: () => m.close() }, t('cancel')),
    h('button', { class: 'btn primary', html: `${icon('upload', 16)}<span>${t('import')}</span>`, onclick: doImport }),
  );
  renderForm();
  update();
}
