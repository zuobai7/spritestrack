import type { Editor } from '../../editor/Editor';
import type { Animation } from '../../core/Project';
import { exportGlb } from '../../export/glb';
import { exportMtl, exportObj, objToken } from '../../export/obj';
import { uniqueNames } from '../../export/spriteExport';
import { writeVox } from '../../export/vox';
import { createZip, type ZipEntry } from '../../export/zip';
import { t } from '../../i18n';
import { checkbox, fill, h, numberInput, openModal, row, select, toast } from '../dom';
import { safeName, saveFile } from '../files';
import { icon } from '../icons';

type Format = 'glb' | 'obj' | 'vox';
type Scope = 'frame' | 'anim' | 'all';

interface ModelSettings {
  format: Format;
  scope: Scope;
  scale: number;
  center: boolean;
}

const KEY = 'spritestrack.export.model.v1';

function load(): ModelSettings {
  const d: ModelSettings = { format: 'glb', scope: 'anim', scale: 1, center: true };
  try {
    return { ...d, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return d;
  }
}

/** The frames an export covers, grouped by animation. */
function animsFor(ed: Editor, scope: Scope): Animation[] {
  if (scope === 'frame') return [{ name: ed.anim.name, fps: ed.anim.fps, frames: [ed.frame] }];
  if (scope === 'anim') return [ed.anim];
  return ed.project.animations;
}

export function openModelExport(ed: Editor, format?: Format): void {
  const s = load();
  if (format) s.format = format;
  const m = openModal(t('exportModelTitle'), {
    onClose: () => {
      try {
        localStorage.setItem(KEY, JSON.stringify(s));
      } catch {
        /* ignore */
      }
    },
  });
  const form = h('div', { class: 'col' });
  const status = h('span', { class: 'hint-text', style: 'margin-right:auto' });
  m.body.append(form);

  const render = () => {
    const anims = animsFor(ed, s.scope);
    const frames = anims.reduce((n, a) => n + a.frames.length, 0);
    fill(
      form,
      row(
        t('format'),
        select(
          s.format,
          [
            ['glb', t('fmtGlb')],
            ['obj', t('fmtObj')],
            ['vox', t('fmtVox')],
          ],
          (v) => {
            s.format = v as Format;
            render();
          },
        ),
      ),
      row(
        t('frameScope'),
        select(
          s.scope,
          [
            ['frame', t('currentFrame')],
            ['anim', t('currentAnim')],
            ['all', t('allAnims')],
          ],
          (v) => {
            s.scope = v as Scope;
            render();
          },
        ),
      ),
      s.format !== 'vox' && row(t('modelScale'), numberInput(s.scale, 0.01, 1000, 0.01, (v) => (s.scale = v))),
      s.format !== 'vox' && row(t('center'), checkbox(s.center, (v) => (s.center = v))),
      h('p', { class: 'hint-text' }, `${frames} ${t('frames')} · ${t(s.format === 'glb' ? 'glbHint' : s.format === 'obj' ? 'objHint' : 'voxHint')}`),
    );
  };

  const doExport = async () => {
    btn.disabled = true;
    status.textContent = t('encoding');
    const base = safeName(ed.project.name);
    const pal = ed.project.palette;
    const anims = animsFor(ed, s.scope);
    try {
      let ok: boolean;
      if (s.format === 'glb') {
        ok = await saveFile(`${base}.glb`, await exportGlb(anims, pal, s.scale, s.center), 'model/gltf-binary');
      } else if (s.format === 'vox') {
        ok = await saveFile(`${base}.vox`, writeVox(anims.flatMap((a) => a.frames), pal), 'application/octet-stream');
      } else {
        // One OBJ per frame, all sharing one material file
        const entries: ZipEntry[] = [];
        const used = new Set<number>();
        const single = anims.length === 1 && anims[0].frames.length === 1;
        const names = uniqueNames(anims.map((a) => safeName(a.name)));
        const mtl = objToken(base);
        anims.forEach((a, ai) =>
          a.frames.forEach((f, i) => {
            const name = single ? base : `${names[ai]}_${i}`;
            for (const v of f.data) if (v) used.add(v);
            entries.push({ name: `${name}.obj`, data: new TextEncoder().encode(exportObj(f, pal, name, { scale: s.scale, center: s.center, mtlName: mtl }).obj) });
          }),
        );
        entries.push({ name: `${mtl}.mtl`, data: new TextEncoder().encode(exportMtl(pal, used)) });
        ok = await saveFile(`${base}-obj.zip`, createZip(entries), 'application/zip');
      }
      if (ok) {
        toast(t('exported'));
        m.close();
      }
      status.textContent = '';
    } catch (e) {
      status.textContent = (e as Error).message;
    } finally {
      btn.disabled = false;
    }
  };

  const btn = h('button', { class: 'btn primary', html: `${icon('download', 16)}<span>${t('export')}</span>`, onclick: doExport });
  m.footer.append(status, h('button', { class: 'btn outline', onclick: () => m.close() }, t('cancel')), btn);
  render();
}
