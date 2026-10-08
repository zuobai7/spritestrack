import { Editor, type Tool } from '../editor/Editor';
import { createDemoProject } from '../core/Project';
import { getGenerators, registerGenerator } from '../core/procedural';
import { Viewport, type ViewName } from '../render/Viewport';
import { getLang, setLang, t } from '../i18n';
import { askText, h, menuButton, pickFile, Scope, toast } from './dom';
import { icon } from './icons';
import { isTauri, readAutosave, readPrefs, saveProjectFile, writeAutosave, writePrefs } from './files';
import { mountSidebar } from './sidebar';
import { mountTimeline } from './timeline';
import { openSpriteExport } from './dialogs/exportSprites';
import { openModelExport } from './dialogs/exportModel';
import { openGenerate } from './dialogs/generate';
import { openRigEditor } from './dialogs/rigEditor';
import { openImageImport } from './dialogs/importImage';
import { importVoxFile, openAnyFile, openHelp, openNewProject } from './dialogs/project';
import type { LightSettings } from '../core/lighting';
import type { BrushShape } from '../core/tools';

const TOOLS: { id: Tool; key: string }[] = [
  { id: 'add', key: 'B' },
  { id: 'erase', key: 'E' },
  { id: 'paint', key: 'P' },
  { id: 'pick', key: 'I' },
  { id: 'fill', key: 'G' },
  { id: 'box', key: 'R' },
  { id: 'line', key: 'L' },
  { id: 'select', key: 'M' },
  { id: 'part', key: 'K' },
];

const TOOL_NAMES: Record<Tool, string> = {
  add: 'toolAdd',
  erase: 'toolErase',
  paint: 'toolPaint',
  pick: 'toolPick',
  fill: 'toolFill',
  box: 'toolBox',
  line: 'toolLine',
  select: 'toolSelect',
  part: 'toolPart',
};

interface Prefs {
  light: LightSettings;
  brush: { size: number; shape: BrushShape };
  showGrid: boolean;
  ao: boolean;
  showAbove: boolean;
}

/** The editor window: lays out the panels, wires shortcuts, autosave and drag-and-drop. */
export class App {
  readonly ed: Editor;
  readonly viewport: Viewport;
  private scope = new Scope();
  private top = h('header', { class: 'topbar' });
  private tools = h('nav', { class: 'toolbar' });
  private view = h('main', { class: 'view' });
  private side = h('aside', { class: 'sidebar' });
  private time = h('section', { class: 'timeline' });
  private overlays: HTMLElement[] = [];
  private saveTimer: number | null = null;
  private autosaveWarned = false;

  constructor(readonly root: HTMLElement) {
    const restored = readAutosave();
    this.ed = new Editor(restored ?? createDemoProject());
    this.applyPrefs();
    root.append(this.top, this.tools, this.view, this.side, this.time);
    this.viewport = new Viewport(this.view, this.ed);
    this.build();
    this.bindKeys();
    this.bindAutosave();
    this.bindDrop();
    if (restored) toast(t('restored'));
  }

  // ---- layout ------------------------------------------------------------------

  /** Builds every panel; called again when the language changes (the 3D view stays). */
  private build(): void {
    this.scope.dispose();
    this.top.replaceChildren();
    this.tools.replaceChildren();
    this.side.replaceChildren();
    this.time.replaceChildren();
    this.overlays.forEach((o) => o.remove());
    document.documentElement.lang = getLang() === 'zh' ? 'zh-CN' : 'en';
    this.buildTopbar();
    this.buildToolbar();
    this.buildOverlays();
    mountSidebar(this.side, this.ed, this.scope);
    mountTimeline(this.time, this.ed, this.scope, () => openRigEditor(this.ed));
    this.updateTitle();
  }

  private buildTopbar(): void {
    const ed = this.ed;
    const btn = (name: string, label: string, fn: () => void, showLabel = true) =>
      h('button', { class: showLabel ? 'btn' : 'icon-btn', title: label, 'aria-label': label, html: `${icon(name)}${showLabel ? `<span>${label}</span>` : ''}`, onclick: fn });
    const undo = btn('undo', `${t('undo')} (Ctrl+Z)`, () => ed.history.undo(), false);
    const redo = btn('redo', `${t('redo')} (Ctrl+Y)`, () => ed.history.redo(), false);
    const syncHistory = () => {
      undo.disabled = !ed.history.canUndo();
      redo.disabled = !ed.history.canRedo();
    };
    this.scope.add(ed.on('history', syncHistory));
    this.scope.add(ed.on('project', syncHistory));
    syncHistory();

    const nameBtn = h('button', {
      class: 'btn',
      title: t('renameProject'),
      onclick: async () => {
        const name = await askText(t('renameProject'), ed.project.name);
        if (!name) return;
        ed.project.name = name;
        ed.dirty = true;
        renderName();
        this.updateTitle();
      },
    });
    const renderName = () => (nameBtn.textContent = ed.project.name);
    this.scope.add(ed.on('project', renderName));
    renderName();

    const importMenu = menuButton(`${icon('upload')}<span>${t('import')}</span>`, () => [
      { label: t('importImage'), icon: icon('image', 16), action: () => openImageImport(ed) },
      { label: t('importVox'), icon: icon('cube', 16), action: () => importVoxFile(ed) },
      { label: t('openProject'), icon: icon('open', 16), hint: 'Ctrl+O', action: () => openAnyFile(ed) },
      { label: t('loadPlugin'), icon: icon('sparkle', 16), action: () => loadPlugin() },
    ]);
    const exportMenu = menuButton(`${icon('download')}<span>${t('export')}</span>`, () => [
      { label: t('exportSprite'), icon: icon('image', 16), hint: 'Ctrl+E', action: () => openSpriteExport(ed) },
      { label: t('exportGif'), icon: icon('film', 16), action: () => openSpriteExport(ed, { output: 'gif' }) },
      { label: t('exportMaps'), icon: icon('layers', 16), action: () => openSpriteExport(ed, { output: 'sheet', normal: true, depth: true }) },
      { label: `${t('exportModel')} (GLB)`, icon: icon('cube', 16), action: () => openModelExport(ed, 'glb') },
      { label: `${t('exportModel')} (OBJ)`, icon: icon('cube', 16), action: () => openModelExport(ed, 'obj') },
      { label: 'MagicaVoxel (.vox)', icon: icon('cube', 16), action: () => openModelExport(ed, 'vox') },
      { label: t('saveProject'), icon: icon('save', 16), hint: 'Ctrl+S', action: () => this.save() },
    ]);
    const other = getLang() === 'zh' ? 'en' : 'zh';

    this.top.append(
      h('div', { class: 'brand', html: `<b>Sprite<span>Strack</span></b><small>${t('appTagline')}</small>` }),
      btn('file', t('new'), () => openNewProject(ed)),
      btn('open', t('open'), () => openAnyFile(ed)),
      btn('save', t('save'), () => this.save()),
      h('div', { class: 'sep' }),
      undo,
      redo,
      h('div', { class: 'sep' }),
      btn('sparkle', t('generate'), () => openGenerate(ed)),
      btn('bone', t('rigAnimation'), () => openRigEditor(ed)),
      importMenu,
      exportMenu,
      h('div', { class: 'spacer' }),
      nameBtn,
      btn('help', t('help'), () => openHelp(), false),
      h('button', {
        class: 'btn',
        title: t('language'),
        html: `${icon('globe')}<span>${other === 'en' ? 'EN' : '中文'}</span>`,
        onclick: () => {
          setLang(other);
          this.build();
        },
      }),
    );
  }

  private buildToolbar(): void {
    const ed = this.ed;
    const toolBtns = TOOLS.map(({ id, key }) => {
      const b = h('button', {
        class: 'tool',
        title: `${t(TOOL_NAMES[id])} (${key})`,
        'aria-label': t(TOOL_NAMES[id]),
        html: `${icon(id)}<span class="key">${key}</span>`,
        onclick: () => ed.setTool(id),
      });
      b.dataset.tool = id;
      return b;
    });
    const size = h('input', { type: 'number', min: '1', max: '16', step: '1', title: t('brushSize') + ' ([ ])' });
    size.addEventListener('change', () => ed.setBrush({ size: Number(size.value) }));
    const shape = h('button', { class: 'tool mini', onclick: () => ed.setBrush({ shape: ed.brush.shape === 'cube' ? 'sphere' : 'cube' }) });
    const mirrors = (['x', 'y', 'z'] as const).map((a) =>
      h('button', {
        class: 'tool mini',
        title: `${t('mirror')} ${a.toUpperCase()}`,
        onclick: () => {
          ed.mirror[a] = !ed.mirror[a];
          ed.emit('state');
        },
      }, a.toUpperCase()),
    );
    const sync = () => {
      toolBtns.forEach((b) => b.classList.toggle('on', b.dataset.tool === ed.tool));
      if (document.activeElement !== size) size.value = String(ed.brush.size);
      shape.textContent = ed.brush.shape === 'cube' ? '■' : '●';
      shape.title = `${t('brushShape')}: ${t(ed.brush.shape === 'cube' ? 'shapeCube' : 'shapeSphere')}`;
      mirrors.forEach((b, i) => b.classList.toggle('on', ed.mirror[(['x', 'y', 'z'] as const)[i]]));
    };
    this.scope.add(ed.on('state', sync));
    sync();
    this.tools.append(
      ...toolBtns,
      h('div', { class: 'hr' }),
      h('span', { class: 'label' }, t('brush')),
      size,
      shape,
      h('div', { class: 'hr' }),
      h('span', { class: 'label' }, t('mirror')),
      ...mirrors,
    );
  }

  private buildOverlays(): void {
    const ed = this.ed;
    const vp = this.viewport;
    const modeSeg = h('div', { class: 'seg' });
    const layerChip = h('div', { class: 'chip' });
    const renderMode = () => {
      modeSeg.replaceChildren(
        ...(['3d', 'layer'] as const).map((m) =>
          h('button', { class: ed.mode === m ? 'on' : '', title: `${t('mode')} (Tab)`, onclick: () => ed.setMode(m) }, t(m === '3d' ? 'mode3d' : 'modeLayer')),
        ),
      );
      layerChip.style.display = ed.mode === 'layer' ? '' : 'none';
      layerChip.replaceChildren(
        h('span', {}, `${t('layer')} ${ed.layer + 1} / ${ed.project.sy}`),
        h('button', { class: 'icon-btn', title: `${t('layerDown')} (PageDown)`, html: icon('down', 16), onclick: () => ed.setLayer(ed.layer - 1) }),
        h('button', { class: 'icon-btn', title: `${t('layerUp')} (PageUp)`, html: icon('up', 16), onclick: () => ed.setLayer(ed.layer + 1) }),
      );
    };
    this.scope.add(ed.on('state', renderMode));
    this.scope.add(ed.on('project', renderMode));
    renderMode();

    const views: [ViewName, string][] = [
      ['front', 'viewFront'],
      ['back', 'viewBack'],
      ['left', 'viewLeft'],
      ['right', 'viewRight'],
      ['top', 'viewTop'],
      ['iso', 'viewIso'],
    ];
    const viewSeg = h(
      'div',
      { class: 'seg' },
      ...views.map(([v, k]) => h('button', { onclick: () => vp.setView(v) }, t(k))),
      h('button', { title: `${t('resetView')} (F)`, 'aria-label': t('resetView'), html: icon('camera', 14), onclick: () => vp.resetCamera() }),
    );
    const status = h('div', {});
    vp.onStatus = (s) => (status.textContent = s);
    const hint = h('div', {});
    const renderHint = () => (hint.textContent = ed.pivotPick !== null ? t('hintPivot') : t(`hint_${ed.tool}`));
    this.scope.add(ed.on('state', renderHint));
    this.scope.add(ed.on('rig', renderHint));
    renderHint();

    this.overlays = [
      h('div', { class: 'view-overlay tl' }, modeSeg, layerChip),
      h('div', { class: 'view-overlay tr' }, viewSeg),
      h('div', { class: 'view-overlay bl' }, status),
      h('div', { class: 'view-overlay br' }, hint),
    ];
    this.view.append(...this.overlays);
  }

  private updateTitle(): void {
    document.title = `${this.ed.project.name}${this.ed.dirty ? ' •' : ''} · SpriteStrack`;
  }

  // ---- files ---------------------------------------------------------------------

  async save(): Promise<void> {
    if (await saveProjectFile(this.ed.project)) {
      this.ed.dirty = false;
      this.updateTitle();
      toast(t('saved'));
    }
  }

  private bindAutosave(): void {
    const ed = this.ed;
    const schedule = () => {
      this.updateTitle();
      if (this.saveTimer !== null) clearTimeout(this.saveTimer);
      this.saveTimer = window.setTimeout(() => {
        this.saveTimer = null;
        if (!writeAutosave(ed.project) && !this.autosaveWarned) {
          this.autosaveWarned = true;
          toast(t('autosaveFailed'), 5000);
        }
      }, 1500);
    };
    for (const ev of ['model', 'frames', 'palette', 'project', 'rig'] as const) ed.on(ev, schedule);
    // Remember view and light settings between sessions
    let prefsTimer: number | null = null;
    const savePrefs = () => {
      if (prefsTimer !== null) clearTimeout(prefsTimer);
      prefsTimer = window.setTimeout(() => {
        const p: Prefs = { light: ed.light, brush: ed.brush, showGrid: ed.showGrid, ao: ed.ao, showAbove: ed.showAbove };
        writePrefs(p);
      }, 500);
    };
    ed.on('light', savePrefs);
    ed.on('state', savePrefs);
    window.addEventListener('beforeunload', () => {
      if (this.saveTimer !== null) writeAutosave(ed.project);
    });
  }

  private applyPrefs(): void {
    const p = readPrefs<Prefs>();
    const ed = this.ed;
    if (p.light) Object.assign(ed.light, p.light);
    if (p.brush) Object.assign(ed.brush, p.brush);
    if (typeof p.showGrid === 'boolean') ed.showGrid = p.showGrid;
    if (typeof p.ao === 'boolean') ed.ao = p.ao;
    if (typeof p.showAbove === 'boolean') ed.showAbove = p.showAbove;
  }

  private bindDrop(): void {
    window.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
    });
    window.addEventListener('drop', (e) => {
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      e.preventDefault();
      void openAnyFile(this.ed, file);
    });
  }

  // ---- keyboard -------------------------------------------------------------------

  private bindKeys(): void {
    const ed = this.ed;
    window.addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName ?? '';
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(tag) || !!target?.isContentEditable;
      // Text fields keep their own undo; sliders, checkboxes and the canvas use the editor's
      const textEntry = tag === 'TEXTAREA' || (tag === 'INPUT' && /^(text|number|search|url|email|)$/.test((target as HTMLInputElement).type));
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      const modal = !!document.querySelector('.overlay');

      if (mod && !e.altKey && (k === 'z' || k === 'y') && !textEntry) {
        e.preventDefault();
        if (k === 'y' || e.shiftKey) ed.history.redo();
        else ed.history.undo();
        return;
      }
      if (typing || modal) return;

      if (mod) {
        const actions: Record<string, () => void> = {
          s: () => void this.save(),
          o: () => void openAnyFile(ed),
          e: () => openSpriteExport(ed),
          c: () => ed.copySelection(),
          x: () => ed.cutSelection(),
          v: () => ed.paste(),
          a: () => ed.selectAll(),
          d: () => ed.setSelection(null),
        };
        const fn = actions[k];
        if (fn && !e.altKey) {
          e.preventDefault();
          fn();
        }
        return;
      }
      if (e.altKey) return;

      const tool = TOOLS.find((x) => x.key.toLowerCase() === k);
      if (tool && !e.shiftKey) return ed.setTool(tool.id);
      const sel = ed.selection;
      switch (e.key) {
        case 'Tab':
          e.preventDefault();
          ed.setMode(ed.mode === '3d' ? 'layer' : '3d');
          return;
        case '[':
          return ed.setBrush({ size: ed.brush.size - 1 });
        case ']':
          return ed.setBrush({ size: ed.brush.size + 1 });
        case 'PageUp':
          e.preventDefault();
          return ed.setLayer(ed.layer + 1);
        case 'PageDown':
          e.preventDefault();
          return ed.setLayer(ed.layer - 1);
        case 'Escape':
          if (ed.pivotPick !== null) {
            ed.pivotPick = null;
            ed.emit('rig');
            ed.emit('state');
          } else ed.setSelection(null);
          return;
        case 'Delete':
        case 'Backspace':
          if (sel) {
            e.preventDefault();
            ed.deleteSelection();
          }
          return;
        case 'ArrowLeft':
        case 'ArrowRight':
        case 'ArrowUp':
        case 'ArrowDown': {
          if (!sel) return;
          e.preventDefault();
          const d = e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 1;
          if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') ed.moveSelection(d, 0, 0);
          else if (e.shiftKey) ed.moveSelection(0, d, 0);
          else ed.moveSelection(0, 0, -d);
          return;
        }
        case ' ':
          e.preventDefault();
          return ed.togglePlay();
        case ',':
        case '<':
          ed.stop();
          return ed.selectFrame(ed.animIndex, (ed.frameIndex - 1 + ed.anim.frames.length) % ed.anim.frames.length);
        case '.':
        case '>':
          ed.stop();
          return ed.selectFrame(ed.animIndex, (ed.frameIndex + 1) % ed.anim.frames.length);
        case 'f':
        case 'F':
          return this.viewport.resetCamera();
        case '?':
        case 'F1':
          e.preventDefault();
          return openHelp();
      }
      if (/^[1-9]$/.test(e.key)) ed.setColor(Number(e.key));
    });
  }
}

/** Loads a plugin script chosen by the user; it registers generators through `window.SpriteStrack`. */
async function loadPlugin(): Promise<void> {
  const file = await pickFile('.js,.mjs,text/javascript');
  if (!file) return;
  const before = getGenerators().length;
  const url = URL.createObjectURL(new Blob([await file.text()], { type: 'text/javascript' }));
  try {
    await import(/* @vite-ignore */ url);
    const added = getGenerators().length - before;
    toast(`${t('pluginLoaded')}: ${file.name}${added > 0 ? ` (+${added})` : ''}`);
  } catch (e) {
    toast(`${t('pluginFailed')}: ${(e as Error).message}`, 5000);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Public API for plugins and the browser console. */
export function exposeApi(app: App): void {
  (window as unknown as { SpriteStrack: unknown }).SpriteStrack = {
    version: __APP_VERSION__,
    registerGenerator,
    getGenerators,
    editor: app.ed,
    isDesktop: isTauri(),
  };
}
