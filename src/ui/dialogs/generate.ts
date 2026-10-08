import type { Editor, GenTarget } from '../../editor/Editor';
import {
  defaultParams,
  getGenerator,
  getGenerators,
  onGeneratorsChanged,
  runGenerator,
  SCRIPT_TEMPLATE,
  type Generator,
  type ParamDef,
  type ParamValues,
} from '../../core/procedural';
import type { VoxelGrid } from '../../core/VoxelGrid';
import { renderStack } from '../../export/stackRenderer';
import { loc, t } from '../../i18n';
import { checkbox, drawFit, fill, h, numberInput, openModal, rangeInput, row, select, toast } from '../dom';
import { icon } from '../icons';
import { ScriptRunner, ScriptTimeoutError } from '../scriptRunner';
import type { GenFrameSpec } from '../../workers/genWorker';

const KEY = 'spritestrack.generate.v1';
const SCRIPT_ID = '__script__';
const DOCS_URL = 'https://github.com/zuobai7/spritestrack/blob/main/docs/plugins.md';

interface GenState {
  id: string;
  seed: number;
  target: GenTarget;
  frames: number;
  script: string;
  params: Record<string, ParamValues>;
}

function load(): GenState {
  const d: GenState = { id: 'terrain', seed: 1, target: 'replace', frames: 8, script: SCRIPT_TEMPLATE, params: {} };
  try {
    return { ...d, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return d;
  }
}

function frameSpecs(n: number, max = Infinity): GenFrameSpec[] {
  const count = Math.min(n, max);
  return Array.from({ length: count }, (_, i) => {
    const frame = count < n ? Math.floor((i * n) / count) : i;
    return { t: frame / n, frame, frameCount: n };
  });
}

export function openGenerate(ed: Editor): void {
  const st = load();
  if (st.id !== SCRIPT_ID && !getGenerator(st.id)) st.id = 'terrain';
  const runner = new ScriptRunner();
  let frames: VoxelGrid[] = [];
  let palette = ed.project.palette;
  let angle = 35;
  let tick = 0;
  let token = 0;
  let pending: number | null = null;

  const list = h('div', { class: 'list' });
  const form = h('div', { class: 'col' });
  const canvas = h('canvas', { width: 320, height: 320 });
  const meta = h('div', { class: 'meta' });
  const err = h('div', { class: 'error' });

  const draw = () => {
    if (!frames.length) return;
    const g = frames[tick % frames.length];
    drawFit(canvas, renderStack(g, palette, { angle, light: ed.light, padding: Math.ceil(g.sy / 3) }), 6);
  };
  const timer = window.setInterval(() => {
    angle = (angle + 3) % 360;
    tick++;
    draw();
  }, 125);
  const unsub = onGeneratorsChanged(() => renderList());
  const m = openModal(t('generateTitle'), {
    wide: true,
    onClose: () => {
      clearInterval(timer);
      unsub();
      runner.kill();
      try {
        localStorage.setItem(KEY, JSON.stringify(st));
      } catch {
        /* ignore */
      }
    },
  });

  const gen = (): Generator | undefined => (st.id === SCRIPT_ID ? undefined : getGenerator(st.id));
  const paramsOf = (g: Generator): ParamValues => (st.params[g.id] = { ...defaultParams(g), ...st.params[g.id] });
  const frameCount = () => (st.target === 'animation' ? Math.max(1, Math.min(120, Math.floor(st.frames))) : 1);
  const canAnimate = () => st.id === SCRIPT_ID || !!gen()?.animated;

  const schedule = (ms = 200) => {
    if (pending !== null) clearTimeout(pending);
    pending = window.setTimeout(preview, ms);
  };

  /** Runs the generator: user scripts in the worker, built-ins and plugins in place. */
  const run = async (specs: GenFrameSpec[], timeoutMs?: number): Promise<{ grids: VoxelGrid[]; palette: number[] }> => {
    const p = ed.project;
    const size: [number, number, number] = [p.sx, p.sy, p.sz];
    const base = st.target === 'merge' ? ed.frame : undefined;
    if (st.id === SCRIPT_ID) return runner.run(st.script, { size, palette: p.palette.slice(), seed: st.seed, frames: specs, base, timeoutMs });
    const g = gen();
    if (!g) throw new Error('generator not found');
    const pal = p.palette.slice();
    const params = paramsOf(g);
    return { grids: specs.map((f) => runGenerator(g, params, size, pal, { seed: st.seed, ...f, base })), palette: pal };
  };

  const preview = async () => {
    pending = null;
    const my = ++token;
    err.textContent = '';
    meta.textContent = '…';
    try {
      const n = frameCount();
      const res = await run(n > 1 ? frameSpecs(n, 16) : [{ t: 0, frame: 0, frameCount: 1 }]);
      if (my !== token) return;
      frames = res.grids;
      palette = res.palette;
      meta.textContent = `${frames[0].count()} ${t('voxels')}${n > 1 ? ` · ${n} ${t('frames')}` : ''}`;
      draw();
    } catch (e) {
      if (my !== token) return;
      meta.textContent = '';
      err.textContent = e instanceof ScriptTimeoutError ? t('scriptTimeout') : (e as Error).message;
    }
  };

  const renderList = () => {
    const items: [string, string][] = getGenerators().map((g) => [g.id, loc(g.name)]);
    items.push([SCRIPT_ID, t('customScript')]);
    fill(
      list,
      items.map(([id, label]) =>
        h(
          'button',
          {
            class: id === st.id ? 'on' : '',
            onclick: () => {
              st.id = id;
              if (st.target === 'animation' && !canAnimate()) st.target = 'replace';
              renderList();
              renderForm();
              schedule(0);
            },
          },
          label,
        ),
      ),
    );
  };

  const control = (d: ParamDef, values: ParamValues): HTMLElement => {
    const v = values[d.key] ?? d.default;
    const set = (x: number | boolean | string) => {
      values[d.key] = x;
      schedule();
    };
    if (d.type === 'bool') return checkbox(Boolean(v), set);
    if (d.type === 'color') {
      const inp = h('input', { type: 'color', value: String(v) });
      inp.addEventListener('input', () => set(inp.value));
      return inp;
    }
    if (d.type === 'select') return select(String(v), (d.options ?? []).map((o) => [o.value, loc(o.label)] as [string, string]), set);
    return rangeInput(Number(v), d.min ?? 0, d.max ?? 100, d.step ?? (d.type === 'int' ? 1 : 0.01), set);
  };

  const renderForm = () => {
    const g = gen();
    const seed = numberInput(st.seed, 0, 2 ** 31 - 1, 1, (v) => {
      st.seed = Math.floor(v);
      schedule();
    });
    const dice = h('button', {
      class: 'icon-btn',
      title: t('randomSeed'),
      html: icon('dice'),
      onclick: () => {
        st.seed = Math.floor(Math.random() * 1e6);
        seed.value = String(st.seed);
        schedule(0);
      },
    });
    let body: (HTMLElement | false)[];
    if (g) {
      const values = paramsOf(g);
      body = [
        h('div', { class: 'group-title' }, loc(g.name)),
        !!g.description && h('p', { class: 'hint-text' }, loc(g.description)),
        ...g.params.map((d) => row(loc(d.label), control(d, values))),
        g.params.length > 0 &&
          h(
            'div',
            { class: 'buttons' },
            h('button', {
              class: 'btn outline',
              onclick: () => {
                st.params[g.id] = defaultParams(g);
                renderForm();
                schedule(0);
              },
            }, t('resetParams')),
          ),
      ];
    } else {
      const area = h('textarea', { rows: 16, spellcheck: 'false', class: 'code' });
      area.value = st.script;
      area.addEventListener('input', () => {
        st.script = area.value;
        schedule(500);
      });
      area.addEventListener('keydown', (e) => {
        if (e.key !== 'Tab') return;
        e.preventDefault();
        const s = area.selectionStart;
        area.setRangeText('  ', s, area.selectionEnd, 'end');
        st.script = area.value;
      });
      body = [
        h('div', { class: 'group-title' }, t('customScript')),
        h('p', { class: 'hint-text' }, t('scriptHint')),
        area,
        h(
          'div',
          { class: 'buttons' },
          h('button', { class: 'btn outline', html: `${icon('play', 16)}<span>${t('runPreview')}</span>`, onclick: () => schedule(0) }),
          h('button', {
            class: 'btn outline',
            onclick: () => {
              st.script = SCRIPT_TEMPLATE;
              renderForm();
              schedule(0);
            },
          }, t('loadExample')),
        ),
      ];
    }
    const targets: [string, string][] = [
      ['replace', t('genReplace')],
      ['merge', t('genMerge')],
    ];
    if (canAnimate()) targets.push(['animation', t('genAnimation')]);
    fill(
      form,
      ...body,
      h('div', { class: 'group-title' }, t('output')),
      row(t('seed'), h('div', { class: 'buttons', style: 'flex-wrap:nowrap' }, seed, dice)),
      row(
        t('target'),
        select(st.target, targets, (v) => {
          st.target = v as GenTarget;
          renderForm();
          schedule(0);
        }),
      ),
      st.target === 'animation' &&
        row(
          t('frameCount'),
          numberInput(st.frames, 1, 120, 1, (v) => {
            st.frames = v;
            schedule();
          }),
        ),
    );
  };

  const doGenerate = async () => {
    btn.disabled = true;
    try {
      const g = gen();
      if (g) ed.generate(g, paramsOf(g), st.seed, st.target, st.frames);
      else {
        const n = frameCount();
        const res = await run(n > 1 ? frameSpecs(n) : [{ t: 0, frame: 0, frameCount: 1 }], 5000 + 400 * n);
        ed.applyGenerated(res.grids, res.palette, st.target, 'script');
      }
      toast(t('generated'));
      m.close();
    } catch (e) {
      err.textContent = e instanceof ScriptTimeoutError ? t('scriptTimeout') : (e as Error).message;
    } finally {
      btn.disabled = false;
    }
  };

  const pluginHint = h('p', { class: 'hint-text', html: `${t('pluginHint')} <a href="${DOCS_URL}" target="_blank" rel="noopener">docs/plugins.md</a>` });
  m.body.append(
    h(
      'div',
      { class: 'three-col', style: 'grid-template-columns:170px minmax(0,1fr) 320px' },
      h('div', { class: 'col' }, list, pluginHint),
      form,
      h('div', { class: 'col' }, h('div', { class: 'preview-box', style: 'min-height:320px' }, canvas, meta), err),
    ),
  );
  const btn = h('button', { class: 'btn primary', html: `${icon('sparkle', 16)}<span>${t('generate')}</span>`, onclick: doGenerate });
  m.footer.append(h('button', { class: 'btn outline', onclick: () => m.close() }, t('cancel')), btn);
  renderList();
  renderForm();
  schedule(0);
}
