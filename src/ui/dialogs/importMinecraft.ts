import type { Editor } from '../../editor/Editor';
import { Project } from '../../core/Project';
import type { VoxelGrid } from '../../core/VoxelGrid';
import { ColorMapper } from '../../core/imageImport';
import { readSchematic, scaledSize, schematicBlocks, schematicToGrid, type Schematic } from '../../core/minecraft';
import { renderStack } from '../../export/stackRenderer';
import { t } from '../../i18n';
import { checkbox, confirmBox, drawFit, fill, h, openModal, pickFile, row, select, toast } from '../dom';
import { icon } from '../icons';

/** Largest model side the editor accepts. */
const MAX_SIDE = 256;
/** Blocks listed in the dialog. */
const LIST = 14;

interface McState {
  scale: number;
  colors: 'nearest' | 'add';
  liquids: boolean;
  dest: 'new' | 'frame';
}

const hex = (c: number) => '#' + c.toString(16).padStart(6, '0');

/** Imports a Minecraft structure (.schem or .schematic): every block becomes a voxel of its color. */
export async function openMinecraftImport(ed: Editor, file?: File | null): Promise<void> {
  file ??= await pickFile('.schem,.schematic');
  if (!file) return;
  let sch: Schematic;
  try {
    sch = await readSchematic(new Uint8Array(await file.arrayBuffer()));
  } catch (e) {
    toast(`${t('loadError')}${t('mcNotSchematic')} (${(e as Error).message})`, 5000);
    return;
  }
  const blocks = schematicBlocks(sch);
  if (!blocks.length) {
    toast(t('mcEmpty'), 4000);
    return;
  }
  const name = file.name.replace(/\.[^.]+$/, '') || 'schematic';
  const [w, hh, l] = sch.size;
  const minScale = Math.max(1, Math.ceil(Math.max(w, hh, l) / MAX_SIDE));
  const hasLiquid = blocks.some((b) => b.liquid);
  const total = blocks.reduce((n, b) => n + b.count, 0);
  const st: McState = { scale: minScale, colors: 'nearest', liquids: true, dest: 'new' };
  let result: { grid: VoxelGrid; palette: number[] } | null = null;

  const form = h('div', { class: 'col' });
  const list = h('div', { class: 'mc-blocks' });
  const canvas = h('canvas', { width: 380, height: 340 });
  const meta = h('div', { class: 'meta' });
  const err = h('div', { class: 'error' });
  const m = openModal(`${t('importMc')} · ${file.name}`, { wide: true });

  const build = () => {
    // New colors go into an empty palette for a new project, or after the current ones
    const palette = st.colors === 'add' && st.dest === 'new' ? [0] : ed.project.palette.slice();
    const grid = schematicToGrid(sch, { scale: st.scale, palette, addColors: st.colors === 'add', liquids: st.liquids });
    return { grid, palette: palette.length > 1 ? palette : ed.project.palette.slice() };
  };

  const renderList = () => {
    if (!result) return;
    const mapper = new ColorMapper(result.palette, false);
    const shown = blocks.filter((b) => st.liquids || !b.liquid).slice(0, LIST);
    const swatch = (c: number) => h('span', { class: 'swatch', style: `background:${hex(c)}` });
    fill(
      list,
      ...shown.map((b) => {
        const to = result!.palette[mapper.map(b.color!)];
        return h(
          'div',
          { class: 'mc-block', title: b.guessed ? t('mcGuessed') : '' },
          swatch(b.color!),
          h('span', { class: 'mc-name' }, `${b.guessed ? '≈ ' : ''}${b.name}`),
          h('span', { class: 'mc-count' }, String(b.count)),
          st.colors === 'nearest' && h('span', { class: 'mc-arrow' }, '→'),
          st.colors === 'nearest' && swatch(to),
        );
      }),
      blocks.length > shown.length && h('div', { class: 'hint-text' }, `+ ${blocks.length - shown.length} ${t('mcMoreTypes')}`),
    );
  };

  const draw = () => {
    if (!result) return;
    const g = result.grid;
    // Shadows cost a ray per pixel; big structures preview without them
    const small = g.sx * g.sy * g.sz <= 96 * 96 * 96;
    const light = small ? ed.light : { ...ed.light, shadows: false, groundShadow: false };
    drawFit(canvas, renderStack(g, result.palette, { angle: 35, light, padding: Math.ceil(g.sy / 4) }), 8);
  };

  const update = () => {
    err.textContent = '';
    try {
      result = build();
      const g = result.grid;
      const p = ed.project;
      meta.textContent = `${g.sx} × ${g.sy} × ${g.sz} · ${g.count()} ${t('voxels')}`;
      if (st.dest === 'frame' && (g.sx > p.sx || g.sy > p.sy || g.sz > p.sz)) err.textContent = `${t('willCrop')} (${p.sx} × ${p.sy} × ${p.sz})`;
      renderList();
      draw();
    } catch (e) {
      result = null;
      err.textContent = (e as Error).message;
    }
  };

  let pending: number | null = null;
  const set = <K extends keyof McState>(k: K, v: McState[K]) => {
    st[k] = v;
    renderForm();
    meta.textContent = '…';
    if (pending !== null) clearTimeout(pending);
    pending = window.setTimeout(() => {
      pending = null;
      update();
    }, 60);
  };

  const renderForm = () => {
    const scales = [1, 2, 3, 4, 6, 8].filter((k) => k >= minScale);
    if (!scales.includes(minScale)) scales.unshift(minScale);
    fill(
      form,
      h('div', { class: 'hint-text' }, `${t('mcSize')}: ${w} × ${hh} × ${l} · ${total} ${t('mcBlocks')} · ${blocks.length} ${t('mcTypes')}`),
      row(
        t('mcScale'),
        select(
          String(st.scale),
          scales.map((k) => {
            const [a, b, c] = scaledSize(sch, k);
            return [String(k), `${k === 1 ? t('mcFullSize') : `1 : ${k}`} · ${a} × ${b} × ${c}`] as [string, string];
          }),
          (v) => set('scale', Number(v)),
        ),
      ),
      minScale > 1 && h('p', { class: 'hint-text' }, t('mcTooBig')),
      row(
        t('colors'),
        select(
          st.colors,
          [
            ['nearest', t('mcNearest')],
            ['add', t('mcAddColors')],
          ],
          (v) => set('colors', v as McState['colors']),
        ),
      ),
      hasLiquid && row(t('mcLiquids'), checkbox(st.liquids, (v) => set('liquids', v))),
      row(
        t('destination'),
        select(
          st.dest,
          [
            ['new', t('destNew')],
            ['frame', t('destFrame')],
          ],
          (v) => set('dest', v as McState['dest']),
        ),
      ),
      h('p', { class: 'hint-text' }, t('mcHint')),
      list,
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
      p.palette = palette;
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
