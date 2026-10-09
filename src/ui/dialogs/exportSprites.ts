import type { Editor } from '../../editor/Editor';
import {
  buildSprites,
  DEFAULT_SPRITE_SETTINGS,
  STACK_VIEW_RANGE,
  viewElevation,
  type Render3d,
  type SpriteSettings,
} from '../../export/spriteExport';
import { Sprite3dRenderer } from '../../export/sprite3d';
import { encodeGif } from '../../export/gif';
import { createZip, type ZipEntry } from '../../export/zip';
import type { RgbaImage } from '../../export/image';
import { t } from '../../i18n';
import { checkbox, drawFit, fill, h, imageToPng, openModal, rangeInput, row, select, toast } from '../dom';
import { safeName, saveFile } from '../files';
import { icon } from '../icons';

const KEY = 'spritestrack.export.sprite.v1';

function loadSettings(): SpriteSettings {
  try {
    return { ...DEFAULT_SPRITE_SETTINGS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return { ...DEFAULT_SPRITE_SETTINGS };
  }
}

export function openSpriteExport(ed: Editor, preset?: Partial<SpriteSettings>): void {
  const s: SpriteSettings = { ...loadSettings(), ...preset };
  let renderer3d: Sprite3dRenderer | null = null;
  let animTimer: number | null = null;
  const m = openModal(t('exportSpriteTitle'), {
    wide: true,
    onClose: () => {
      renderer3d?.dispose();
      if (animTimer !== null) clearInterval(animTimer);
      try {
        localStorage.setItem(KEY, JSON.stringify(s));
      } catch {
        /* ignore */
      }
    },
  });
  const r3d: Render3d = (grid, palette, angle, pass) => {
    renderer3d ??= new Sprite3dRenderer();
    return renderer3d.render(grid, palette, angle, {
      size: s.size,
      elevation: viewElevation(s.view),
      orthographic: s.ortho,
      light: s.useLight ? ed.light : { ...ed.light, enabled: false },
      outline: s.outline ? parseInt(s.outlineColor.slice(1), 16) : null,
      scale: 1,
      pass,
    });
  };

  const form = h('div', { class: 'col' });
  const canvas = h('canvas', { width: 560, height: 420 });
  const meta = h('div', { class: 'meta' });
  const previewBox = h('div', { class: 'preview-box', style: 'min-height:420px' }, canvas, meta);
  const status = h('span', { class: 'hint-text', style: 'margin-right:auto' });
  m.body.append(h('div', { class: 'two-col' }, form, previewBox));

  const set = <K extends keyof SpriteSettings>(k: K, v: SpriteSettings[K], rebuild = false) => {
    s[k] = v;
    if (rebuild) renderForm();
    schedulePreview();
  };

  const renderForm = () => {
    const isStack = s.method === 'stack';
    const is3d = s.method === '3d';
    const slices = s.method === 'slices';
    const outlineColor = h('input', { type: 'color', value: s.outlineColor });
    outlineColor.addEventListener('input', () => set('outlineColor', outlineColor.value));
    const gifColor = h('input', { type: 'color', value: s.gifColor });
    gifColor.addEventListener('input', () => set('gifColor', gifColor.value));
    fill(
      form,
      row(
        t('method'),
        select(
          s.method,
          [
            ['stack', t('methodStack')],
            ['3d', t('method3d')],
            ['slices', t('methodSlices')],
          ],
          (v) => set('method', v as SpriteSettings['method'], true),
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
          (v) => set('scope', v as SpriteSettings['scope']),
        ),
      ),
      !slices && row(t('angles'), select(String(s.angles), ['1', '2', '4', '8', '16', '32'].map((v) => [v, v] as [string, string]), (v) => set('angles', Number(v)))),
      !slices && row(t('startAngle'), rangeInput(s.startAngle, 0, 359, 1, (v) => set('startAngle', v))),
      isStack &&
        row(
          t('viewAngle'),
          rangeInput(Math.max(STACK_VIEW_RANGE[0], Math.min(STACK_VIEW_RANGE[1], s.view)), STACK_VIEW_RANGE[0], STACK_VIEW_RANGE[1], 1, (v) =>
            set('view', v),
          ),
        ),
      is3d && row(t('viewAngle'), rangeInput(s.view, 0, 180, 1, (v) => set('view', v))),
      !slices && h('p', { class: 'hint-text' }, isStack ? t('viewAngleHintStack') : t('viewAngleHint3d')),
      isStack && row(t('spacing'), rangeInput(s.spacing, 0.5, 3, 0.25, (v) => set('spacing', v))),
      is3d && row(t('pixelSize'), rangeInput(s.size, 16, 512, 8, (v) => set('size', v))),
      is3d && row(t('orthographic'), checkbox(s.ortho, (v) => set('ortho', v))),
      slices &&
        row(
          t('sliceDir'),
          select(
            s.sliceDir,
            [
              ['horizontal', t('horizontal')],
              ['vertical', t('vertical')],
            ],
            (v) => set('sliceDir', v as SpriteSettings['sliceDir']),
          ),
        ),
      row(t('scale'), select(String(s.scale), ['1', '2', '3', '4', '6', '8'].map((v) => [v, `${v}×`] as [string, string]), (v) => set('scale', Number(v)))),
      !slices && row(t('useLight'), checkbox(s.useLight, (v) => set('useLight', v))),
      !slices && row(t('outline'), h('div', { class: 'buttons' }, checkbox(s.outline, (v) => set('outline', v)), outlineColor)),
      row(t('trim'), checkbox(s.trim, (v) => set('trim', v))),
      ed.project.variants.length > 1 && row(t('allSchemes'), checkbox(s.allSchemes, (v) => set('allSchemes', v))),
      h('div', { class: 'group-title' }, t('layout')),
      row(
        t('format'),
        select(
          s.output,
          [
            ['sheet', t('layoutSheet')],
            ['zip', t('layoutZip')],
            ['gif', t('layoutGif')],
          ],
          (v) => set('output', v as SpriteSettings['output'], true),
        ),
      ),
      s.output === 'sheet' && row(t('includeJson'), checkbox(s.json, (v) => set('json', v))),
      s.output !== 'gif' && !slices && row(t('normalMap'), checkbox(s.normal, (v) => set('normal', v))),
      s.output !== 'gif' && !slices && row(t('depthMap'), checkbox(s.depth, (v) => set('depth', v))),
      s.output === 'gif' &&
        row(
          t('gifContent'),
          select(
            s.gifContent,
            [
              ['animation', t('gifAnimation')],
              ['turntable', t('gifTurntable')],
            ],
            (v) => set('gifContent', v as SpriteSettings['gifContent']),
          ),
        ),
      s.output === 'gif' && s.gifContent === 'turntable' && row(t('gifDelay'), rangeInput(s.gifDelay, 20, 500, 10, (v) => set('gifDelay', v))),
      s.output === 'gif' &&
        row(
          t('gifBackground'),
          h(
            'div',
            { class: 'buttons' },
            select(
              s.gifBackground,
              [
                ['transparent', t('transparent')],
                ['color', t('solidColor')],
              ],
              (v) => set('gifBackground', v as SpriteSettings['gifBackground']),
            ),
            gifColor,
          ),
        ),
      h('p', { class: 'hint-text' }, s.normal || s.depth ? t('mapsHint') : t('spriteHint')),
    );
  };

  let previewTimer: number | null = null;
  let previewToken = 0;
  const schedulePreview = () => {
    if (previewTimer !== null) clearTimeout(previewTimer);
    previewTimer = window.setTimeout(runPreview, 160);
  };

  const runPreview = async () => {
    previewTimer = null;
    const token = ++previewToken;
    if (animTimer !== null) clearInterval(animTimer);
    animTimer = null;
    meta.textContent = '…';
    try {
      const res = await buildSprites(ed.project, { ...s, allSchemes: false, normal: false, depth: false }, ed.light, ed.animIndex, ed.frameIndex, r3d, {
        limit: 48,
        baseName: 'preview',
      });
      if (token !== previewToken) return;
      if (s.output === 'gif' && res.previewFrames?.length) {
        let i = 0;
        const frames = res.previewFrames;
        const step = () => drawFit(canvas, frames[i++ % frames.length], 8);
        step();
        animTimer = window.setInterval(step, Math.max(30, res.previewDelay ?? 100));
        meta.textContent = `${frames[0].width}×${frames[0].height} · ${frames.length} ${t('frames')}`;
      } else if (res.preview) {
        drawFit(canvas, res.preview, 8);
        meta.textContent = `${res.preview.width}×${res.preview.height}${res.cellCount >= 48 ? ` · ${t('previewPartial')}` : ''}`;
      }
    } catch (e) {
      meta.textContent = (e as Error).message;
    }
  };

  const doExport = async () => {
    exportBtn.disabled = true;
    const base = safeName(ed.project.name);
    try {
      const res = await buildSprites(ed.project, s, ed.light, ed.animIndex, ed.frameIndex, r3d, {
        baseName: base,
        onProgress: (f) => (status.textContent = `${t('rendering')} ${Math.round(f * 100)}%`),
      });
      status.textContent = t('encoding');
      const entries: ZipEntry[] = [];
      for (const f of res.files) {
        if (f.image) entries.push({ name: f.name, data: await imageToPng(f.image) });
        else if (f.text) entries.push({ name: f.name, data: new TextEncoder().encode(f.text) });
        else if (f.gif) {
          const bg = s.gifBackground === 'color' ? parseInt(s.gifColor.slice(1), 16) : null;
          entries.push({ name: f.name, data: encodeGif(f.gif.frames as RgbaImage[], { delay: f.gif.delay, delays: f.gif.delays, background: bg }) });
        }
      }
      let ok: boolean;
      if (entries.length === 1) {
        const e = entries[0];
        const mime = e.name.endsWith('.gif') ? 'image/gif' : e.name.endsWith('.png') ? 'image/png' : 'application/json';
        ok = await saveFile(e.name.split('/').pop()!, e.data, mime);
      } else ok = await saveFile(`${base}-sprites.zip`, createZip(entries), 'application/zip');
      status.textContent = '';
      if (ok) {
        toast(t('exported'));
        m.close();
      }
    } catch (e) {
      status.textContent = (e as Error).message;
    } finally {
      exportBtn.disabled = false;
    }
  };

  const exportBtn = h('button', { class: 'btn primary', html: `${icon('download', 16)}<span>${t('export')}</span>`, onclick: doExport });
  m.footer.append(status, h('button', { class: 'btn outline', onclick: () => m.close() }, t('cancel')), exportBtn);
  renderForm();
  schedulePreview();
}
