import type { Editor } from '../../editor/Editor';
import { createDemoProject, Project } from '../../core/Project';
import { VoxelGrid } from '../../core/VoxelGrid';
import { ColorMapper } from '../../core/imageImport';
import { deserializeProject } from '../../core/serialize';
import { readVox } from '../../export/vox';
import { t } from '../../i18n';
import { confirmBox, fill, h, numberField, openModal, pickFile, row, select, toast } from '../dom';
import { PROJECT_EXT } from '../files';
import { icon } from '../icons';
import { openImageImport } from './importImage';
import { openMinecraftImport } from './importMinecraft';

export const REPO_URL = 'https://github.com/zuobai7/spritestrack';

/** Asks before throwing away unsaved work. */
export async function confirmDiscard(ed: Editor): Promise<boolean> {
  return !ed.dirty || confirmBox(t('confirmNew'), t('ok'), t('cancel'));
}

export function openNewProject(ed: Editor): void {
  const st = { name: 'untitled', preset: '32', size: [32, 32, 32] as [number, number, number], template: 'empty' };
  const m = openModal(t('newProjectTitle'));
  const form = h('div', { class: 'col' });
  const render = () => {
    const nameInput = h('input', { type: 'text', value: st.name });
    nameInput.addEventListener('input', () => (st.name = nameInput.value));
    const custom = st.preset === 'custom';
    fill(
      form,
      row(t('name'), nameInput),
      row(
        t('template'),
        select(
          st.template,
          [
            ['empty', t('tplEmpty')],
            ['demo', t('tplDemo')],
          ],
          (v) => {
            st.template = v;
            render();
          },
        ),
      ),
      st.template === 'empty' &&
        row(
          t('size'),
          select(
            st.preset,
            [...['8', '16', '24', '32', '48', '64', '96', '128'].map((v) => [v, `${v} × ${v} × ${v}`] as [string, string]), ['custom', t('custom')]],
            (v) => {
              st.preset = v;
              if (v !== 'custom') st.size = [Number(v), Number(v), Number(v)];
              render();
            },
          ),
        ),
      st.template === 'empty' &&
        custom &&
        row(
          `${t('width')} × ${t('height')} × ${t('depthAxis')}`,
          h('div', { class: 'xyz' }, ...st.size.map((v, i) => numberField(v, 1, 256, 1, (x) => (st.size[i] = Math.round(x))))),
        ),
      ed.dirty && h('p', { class: 'hint-text' }, t('unsavedWarning')),
    );
    setTimeout(() => nameInput.focus());
  };
  const create = () => {
    const p = st.template === 'demo' ? createDemoProject() : new Project(st.size[0], st.size[1], st.size[2], st.name.trim() || 'untitled');
    if (st.template === 'demo' && st.name.trim() && st.name !== 'untitled') p.name = st.name.trim();
    ed.setProject(p);
    m.close();
  };
  m.body.append(form);
  m.footer.append(h('button', { class: 'btn outline', onclick: () => m.close() }, t('cancel')), h('button', { class: 'btn primary', onclick: create }, t('create')));
  render();
}

/**
 * Opens a project, a MagicaVoxel model, a Minecraft structure or an image
 * (models, structures and images go to their import dialogs).
 */
export async function openAnyFile(ed: Editor, file?: File | null): Promise<void> {
  file ??= await pickFile(`.${PROJECT_EXT},.json,.vox,.schem,.schematic,image/png,image/gif,image/jpeg,image/webp`);
  if (!file) return;
  const lower = file.name.toLowerCase();
  try {
    if (lower.endsWith('.vox')) return await importVoxFile(ed, file);
    if (lower.endsWith('.schem') || lower.endsWith('.schematic')) return await openMinecraftImport(ed, file);
    if (file.type.startsWith('image/') || /\.(png|gif|jpe?g|webp|bmp)$/.test(lower)) return await openImageImport(ed, file);
    if (!lower.endsWith(`.${PROJECT_EXT}`) && !lower.endsWith('.json')) throw new Error(t('unknownFile'));
    const p = deserializeProject(await file.text());
    if (!(await confirmDiscard(ed))) return;
    ed.setProject(p);
    toast(`${t('opened')}: ${p.name}`);
  } catch (e) {
    toast(t('loadError') + (e as Error).message, 4000);
  }
}

/** Keeps only palette entries the models use, so a 255-color VOX palette doesn't flood the editor. */
function compactPalette(models: VoxelGrid[], palette: number[]): { models: VoxelGrid[]; palette: number[] } {
  const map = new Uint8Array(256);
  const out = [0];
  for (const g of models)
    for (const v of g.data)
      if (v && !map[v]) {
        map[v] = out.length;
        out.push(palette[v] ?? 0xff00ff);
      }
  return {
    models: models.map((g) => {
      const c = new VoxelGrid(g.sx, g.sy, g.sz);
      for (let i = 0; i < g.data.length; i++) c.data[i] = map[g.data[i]];
      return c;
    }),
    palette: out.length > 1 ? out : palette,
  };
}

export async function importVoxFile(ed: Editor, file?: File | null): Promise<void> {
  file ??= await pickFile('.vox');
  if (!file) return;
  let vox: ReturnType<typeof readVox>;
  try {
    vox = readVox(new Uint8Array(await file.arrayBuffer()));
    if (!vox.models.length) throw new Error(t('voxEmpty'));
  } catch (e) {
    toast(t('loadError') + (e as Error).message, 4000);
    return;
  }
  const { models, palette } = compactPalette(vox.models, vox.palette);
  const name = file.name.replace(/\.[^.]+$/, '');
  const sx = Math.max(...models.map((g) => g.sx));
  const sy = Math.max(...models.map((g) => g.sy));
  const sz = Math.max(...models.map((g) => g.sz));

  const asProject = async () => {
    if (!(await confirmDiscard(ed))) return;
    const p = new Project(sx, sy, sz, name);
    p.palette = palette;
    p.animations[0].name = models.length > 1 ? 'vox' : 'idle';
    p.animations[0].frames = models.map((g) => (g.sx === sx && g.sy === sy && g.sz === sz ? g : g.resized(sx, sy, sz, 'center')));
    ed.setProject(p);
    m.close();
    toast(t('imported'));
  };
  const intoFrame = () => {
    // Map the model's colors into the current palette (adding new ones while there is room)
    const pal = ed.project.palette.slice();
    const mapper = new ColorMapper(pal, true);
    const g = models[0];
    const out = new VoxelGrid(g.sx, g.sy, g.sz);
    for (let i = 0; i < g.data.length; i++) if (g.data[i]) out.data[i] = mapper.map(palette[g.data[i]]);
    ed.replaceFrameWith(out, pal);
    m.close();
    toast(t('imported'));
  };

  const m = openModal(`${t('importVox')} · ${file.name}`);
  m.body.append(
    h('p', {}, `${models.length} ${t('voxModels')} · ${sx} × ${sy} × ${sz} · ${palette.length - 1} ${t('colorsWord')}`),
    h('p', { class: 'hint-text' }, t('voxHintImport')),
  );
  m.footer.append(
    h('button', { class: 'btn outline', onclick: intoFrame }, t('destFrame')),
    h('button', { class: 'btn primary', onclick: asProject }, models.length > 1 ? t('voxAsFrames') : t('destNew')),
  );
}

export function openHelp(): void {
  const m = openModal(t('help'), { wide: true });
  m.el.style.width = 'min(760px, 100%)';
  m.body.append(
    h('div', { class: 'help', html: t('helpText') }),
    h(
      'p',
      { class: 'hint-text', html: `SpriteStrack · MIT · <a href="${REPO_URL}" target="_blank" rel="noopener">${REPO_URL.replace('https://', '')}</a>` },
    ),
  );
  m.footer.append(h('a', { class: 'btn outline', href: REPO_URL, target: '_blank', rel: 'noopener', html: `${icon('globe', 16)}<span>GitHub</span>` }), h('button', { class: 'btn primary', onclick: () => m.close() }, t('close')));
}
