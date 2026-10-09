import type { Editor } from '../editor/Editor';
import { renderStack } from '../export/stackRenderer';
import { hexToNum, numToHex } from '../core/Palette';
import { parsePaletteText, paletteFromImage, paletteImage, toGplFile, toHexFile } from '../core/paletteIO';
import { getPart, partBounds, type RigPart } from '../core/rig';
import { t } from '../i18n';
import { askText, checkbox, confirmBox, drawFit, h, imageToPng, menuButton, openModal, pickFile, rangeInput, row, Scope, section, select, toast } from './dom';
import { icon } from './icons';
import { loadImageFile, safeName, saveFile } from './files';

export function mountSidebar(el: HTMLElement, ed: Editor, scope: Scope): void {
  el.append(
    paletteSection(ed, scope),
    previewSection(ed, scope),
    lightSection(ed, scope),
    viewSection(ed, scope),
    selectionSection(ed, scope),
    modelSection(ed, scope),
    partsSection(ed, scope),
  );
}

// ---- palette -------------------------------------------------------------------

function paletteSection(ed: Editor, scope: Scope): HTMLElement {
  const big = h('div', { class: 'big' });
  const code = h('code');
  const colorInput = h('input', { type: 'color', title: t('editColor') });
  colorInput.addEventListener('input', () => ed.setPaletteColor(ed.color, hexToNum(colorInput.value), true));
  colorInput.addEventListener('change', () => ed.commitLive('edit color'));
  const swatches = h('div', { class: 'swatches' });
  const variantSel = h('select', { title: t('colorScheme') });
  variantSel.addEventListener('change', () => ed.switchVariant(Number(variantSel.value)));

  const render = () => {
    const pal = ed.project.palette;
    big.style.background = numToHex(pal[ed.color] ?? 0);
    code.textContent = `#${ed.color}  ${numToHex(pal[ed.color] ?? 0)}`;
    colorInput.value = numToHex(pal[ed.color] ?? 0);
    const add = h('button', { class: 'swatch add', title: t('addColor'), html: icon('plus', 14), onclick: () => ed.addPaletteColor(pal[ed.color] ?? 0xffffff) });
    swatches.replaceChildren(
      ...pal.slice(1).map((c, k) =>
        h('button', {
          class: 'swatch' + (k + 1 === ed.color ? ' on' : ''),
          style: `background:${numToHex(c)}`,
          title: `${k + 1}  ${numToHex(c)}`,
          onclick: () => ed.setColor(k + 1),
        }),
      ),
      ...(pal.length <= 255 ? [add] : []),
    );
    variantSel.replaceChildren(...ed.project.variants.map((v, i) => h('option', { value: String(i) }, v.name)));
    variantSel.value = String(ed.project.activeVariant);
  };
  scope.add(ed.on('palette', render));
  scope.add(ed.on('state', render));
  scope.add(ed.on('project', render));
  render();

  const exportMenu = menuButton(`${icon('download', 16)}<span>${t('export')}</span>`, () => [
    { label: 'Lospec / Paint (.hex)', action: () => saveFile(`${safeName(ed.project.name)}.hex`, toHexFile(ed.project.palette), 'text/plain') },
    { label: 'GIMP / Aseprite (.gpl)', action: () => saveFile(`${safeName(ed.project.name)}.gpl`, toGplFile(ed.project.palette, ed.project.name), 'text/plain') },
    {
      label: 'PNG',
      action: async () => saveFile(`${safeName(ed.project.name)}-palette.png`, await imageToPng(paletteImage(ed.project.palette, 8)), 'image/png'),
    },
  ], 'btn outline');

  return section(
    'palette',
    t('palette'),
    icon('palette', 16),
    true,
    h('div', { class: 'current-color' }, big, h('div', { class: 'col' }, code, colorInput)),
    swatches,
    row(
      t('colorScheme'),
      h(
        'div',
        { class: 'buttons', style: 'flex-wrap:nowrap' },
        variantSel,
        h('button', {
          class: 'icon-btn small',
          title: t('newScheme'),
          html: icon('plus', 14),
          onclick: async () => {
            const name = await askText(t('newScheme'), `${t('colorScheme')} ${ed.project.variants.length + 1}`);
            if (name) ed.addVariant(name);
          },
        }),
        h('button', {
          class: 'icon-btn small',
          title: t('rename'),
          html: icon('file', 14),
          onclick: async () => {
            const name = await askText(t('rename'), ed.project.variants[ed.project.activeVariant].name);
            if (name) ed.renameVariant(name);
          },
        }),
        h('button', {
          class: 'icon-btn small',
          title: t('delete'),
          html: icon('trash', 14),
          onclick: () => ed.deleteVariant(),
        }),
      ),
    ),
    h(
      'div',
      { class: 'buttons' },
      h('button', { class: 'btn outline', html: `${icon('upload', 16)}<span>${t('import')}</span>`, onclick: () => importPaletteDialog(ed) }),
      exportMenu,
      h('button', { class: 'btn outline', onclick: () => ed.removeUnusedColors() }, t('removeUnused')),
    ),
  );
}

async function importPaletteDialog(ed: Editor): Promise<void> {
  const file = await pickFile('.hex,.gpl,.txt,.json,.png,.gif,.jpg,.jpeg,.webp');
  if (!file) return;
  let colors: number[];
  try {
    if (/\.(png|gif|jpe?g|webp)$/i.test(file.name)) colors = paletteFromImage((await loadImageFile(file)).image);
    else colors = parsePaletteText(await file.text(), file.name);
  } catch (e) {
    toast(t('loadError') + (e as Error).message);
    return;
  }
  if (!colors.length) {
    toast(t('noColors'));
    return;
  }
  const m = openModal(`${t('importPalette')} · ${colors.length}`);
  const preview = h('div', { class: 'swatches' }, ...colors.map((c) => h('div', { class: 'swatch', style: `background:${numToHex(c)}` })));
  m.body.append(preview, h('p', { class: 'hint-text' }, t('importPaletteHint')));
  const pick = (mode: 'replace' | 'remap' | 'variant' | 'append') => {
    ed.importPalette(colors, mode, file.name.replace(/\.[^.]+$/, ''));
    m.close();
  };
  m.footer.append(
    h('button', { class: 'btn outline', onclick: () => pick('append') }, t('paletteAppend')),
    h('button', { class: 'btn outline', onclick: () => pick('replace') }, t('paletteReplace')),
    h('button', { class: 'btn outline', onclick: () => pick('variant') }, t('paletteVariant')),
    h('button', { class: 'btn primary', onclick: () => pick('remap') }, t('paletteRemap')),
  );
}

// ---- sprite preview ---------------------------------------------------------------

function previewSection(ed: Editor, scope: Scope): HTMLElement {
  const canvas = h('canvas', { class: 'preview-canvas', width: 272, height: 272 });
  let angle = 30;
  let auto = true;
  let queued = false;
  const draw = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      if (!canvas.isConnected) return;
      const g = ed.frame;
      const img = renderStack(g, ed.project.palette, {
        angle,
        light: ed.light,
        padding: Math.ceil(g.sy / 3),
      });
      drawFit(canvas, img, 6);
    });
  };
  const angleInput = rangeInput(angle, 0, 359, 1, (v) => {
    angle = v;
    draw();
  });
  const timer = window.setInterval(() => {
    if (!auto || !canvas.isConnected) return;
    angle = (angle + 5) % 360;
    (angleInput.querySelector('input') as HTMLInputElement).value = String(angle);
    (angleInput.querySelector('output') as HTMLOutputElement).textContent = String(angle);
    draw();
  }, 110);
  scope.add(() => clearInterval(timer));
  for (const ev of ['model', 'frame', 'palette', 'light', 'project'] as const) scope.add(ed.on(ev, draw));
  draw();
  return section(
    'preview',
    t('preview'),
    icon('eye', 16),
    true,
    canvas,
    row(t('angle'), angleInput),
    row(t('autoRotate'), checkbox(auto, (v) => (auto = v))),
  );
}

// ---- light -----------------------------------------------------------------------

function lightSection(ed: Editor, scope: Scope): HTMLElement {
  const L = ed.light;
  const body = [
    row(t('lightOn'), checkbox(L.enabled, (v) => ed.setLight({ enabled: v }))),
    row(t('azimuth'), rangeInput(L.azimuth, -180, 180, 5, (v) => ed.setLight({ azimuth: v }))),
    row(t('elevation'), rangeInput(L.elevation, 5, 90, 1, (v) => ed.setLight({ elevation: v }))),
    row(t('ambient'), rangeInput(L.ambient, 0, 1, 0.05, (v) => ed.setLight({ ambient: v }))),
    row(t('intensity'), rangeInput(L.intensity, 0, 1.5, 0.05, (v) => ed.setLight({ intensity: v }))),
    row(t('castShadows'), checkbox(L.shadows, (v) => ed.setLight({ shadows: v }))),
    row(t('groundShadow'), checkbox(L.groundShadow, (v) => ed.setLight({ groundShadow: v }))),
    row(t('shadowOpacity'), rangeInput(L.shadowOpacity, 0, 1, 0.05, (v) => ed.setLight({ shadowOpacity: v }))),
    h('p', { class: 'hint-text' }, t('lightHint')),
  ];
  void scope;
  return section('light', t('lighting'), icon('sun', 16), false, ...body);
}

// ---- view & reference image -------------------------------------------------------------

function viewSection(ed: Editor, scope: Scope): HTMLElement {
  const refBox = h('div', { class: 'col' });
  const renderRef = () => {
    const r = ed.reference;
    if (!r) {
      refBox.replaceChildren(h('button', { class: 'btn outline', html: `${icon('image', 16)}<span>${t('loadReference')}</span>`, onclick: () => loadReference(ed) }));
      return;
    }
    const set = (patch: Partial<typeof r>) => ed.setReference({ ...ed.reference!, ...patch });
    refBox.replaceChildren(
      row(t('show'), checkbox(r.visible, (v) => set({ visible: v }))),
      row(
        t('refPlane'),
        select(
          r.plane,
          [
            ['front', t('planeFront')],
            ['side', t('planeSide')],
            ['top', t('planeTop')],
          ],
          (v) => set({ plane: v as typeof r.plane }),
        ),
      ),
      row(t('opacity'), rangeInput(r.opacity, 0.05, 1, 0.05, (v) => set({ opacity: v }))),
      row(t('refSize'), rangeInput(r.size, 1, 256, 1, (v) => set({ size: v }))),
      row(t('offsetX'), rangeInput(r.offsetX, -128, 128, 0.5, (v) => set({ offsetX: v }))),
      row(t('offsetY'), rangeInput(r.offsetY, -128, 128, 0.5, (v) => set({ offsetY: v }))),
      row(t('followLayer'), checkbox(r.followLayer, (v) => set({ followLayer: v }))),
      h(
        'div',
        { class: 'buttons' },
        h('button', { class: 'btn outline', onclick: () => loadReference(ed) }, t('replace')),
        h('button', { class: 'btn outline danger', onclick: () => ed.setReference(null) }, t('remove')),
      ),
    );
  };
  let lastRef = ed.reference;
  scope.add(
    ed.on('reference', () => {
      // Rebuild only when a reference is added or removed (sliders keep focus otherwise)
      if (!!lastRef !== !!ed.reference || lastRef?.url !== ed.reference?.url) renderRef();
      lastRef = ed.reference;
    }),
  );
  renderRef();
  const toggles = h('div', { class: 'col' });
  const renderToggles = () =>
    toggles.replaceChildren(
      row(t('grid'), checkbox(ed.showGrid, (v) => ed.setView({ showGrid: v }))),
      row(t('ao'), checkbox(ed.ao, (v) => ed.setView({ ao: v }))),
      row(t('onion'), checkbox(ed.onion, (v) => ed.setView({ onion: v }))),
      row(t('showAbove'), checkbox(ed.showAbove, (v) => ed.setView({ showAbove: v }))),
      row(t('partOverlay'), checkbox(ed.partOverlay, (v) => ed.setView({ partOverlay: v }))),
    );
  let key = '';
  scope.add(
    ed.on('state', () => {
      const k = [ed.showGrid, ed.ao, ed.onion, ed.showAbove, ed.partOverlay].join();
      if (k !== key) {
        key = k;
        renderToggles();
      }
    }),
  );
  renderToggles();
  return section('view', t('view'), icon('eye', 16), false, toggles, h('div', { class: 'group-title' }, t('reference')), refBox);
}

async function loadReference(ed: Editor): Promise<void> {
  const file = await pickFile('image/*');
  if (!file) return;
  try {
    const { image, url } = await loadImageFile(file);
    ed.setReference({
      url,
      width: image.width,
      height: image.height,
      plane: 'front',
      opacity: 0.5,
      size: Math.max(ed.project.sx, ed.project.sz),
      offsetX: 0,
      offsetY: 0,
      followLayer: true,
      visible: true,
    });
  } catch (e) {
    toast(t('loadError') + (e as Error).message);
  }
}

// ---- selection --------------------------------------------------------------------

function selectionSection(ed: Editor, scope: Scope): HTMLElement {
  const info = h('div', { class: 'hint-text' });
  const b = (label: string, fn: () => void, needsSel = true) => {
    const el = h('button', { class: 'btn outline', onclick: fn }, label);
    el.dataset.needsSel = needsSel ? '1' : '';
    return el;
  };
  const buttons = h(
    'div',
    { class: 'buttons' },
    b(t('selectAll'), () => ed.selectAll(), false),
    b(t('deselect'), () => ed.setSelection(null)),
    b(t('copy'), () => ed.copySelection(), false),
    b(t('cut'), () => ed.cutSelection(), false),
    b(t('paste'), () => ed.paste(), false),
    b(t('delete'), () => ed.deleteSelection()),
    b(t('fillSel'), () => ed.fillSelection()),
    b(t('paintSel'), () => ed.paintSelection()),
    b(t('flipX'), () => ed.flipSelection(0)),
    b(t('flipY'), () => ed.flipSelection(1)),
    b(t('flipZ'), () => ed.flipSelection(2)),
    b(t('assignPart'), () => ed.assignSelectionToPart()),
  );
  const render = () => {
    const s = ed.selection;
    info.textContent = s
      ? `${t('selection')}: ${s.max[0] - s.min[0] + 1} × ${s.max[1] - s.min[1] + 1} × ${s.max[2] - s.min[2] + 1}  (${s.min.join(', ')})`
      : t('noSelection');
    buttons.querySelectorAll<HTMLButtonElement>('button').forEach((x) => {
      x.disabled = !!x.dataset.needsSel && !s;
      if (x.textContent === t('paste')) x.disabled = !ed.clipboard;
    });
  };
  scope.add(ed.on('selection', render));
  scope.add(ed.on('frame', render));
  scope.add(ed.on('project', render));
  render();
  return section('selection', t('selection'), icon('select', 16), false, info, buttons, h('p', { class: 'hint-text' }, t('selectionHint')));
}

// ---- model ------------------------------------------------------------------------

function modelSection(ed: Editor, scope: Scope): HTMLElement {
  const size = ['sx', 'sy', 'sz'].map(() => h('input', { type: 'number', min: '1', max: '256', step: '1' }));
  const count = h('div', { class: 'hint-text' });
  let allFrames = false;
  const renderCount = () => {
    const p = ed.project;
    count.textContent = `${ed.frame.count()} ${t('voxels')} · ${p.animations.length} ${t('animations')} · ${p.frameCount()} ${t('frames')}`;
  };
  // The size fields only change with the model size, so typing in them isn't undone by edits or playback
  const render = () => {
    const p = ed.project;
    [p.sx, p.sy, p.sz].forEach((v, i) => (size[i].value = String(v)));
    renderCount();
  };
  let pending: number | null = null;
  const soon = () => {
    if (pending === null)
      pending = window.setTimeout(() => {
        pending = null;
        renderCount();
      }, 300);
  };
  scope.add(ed.on('project', render));
  scope.add(ed.on('frames', render));
  scope.add(ed.on('frame', soon));
  scope.add(ed.on('model', soon));
  render();
  const apply = async () => {
    const [x, y, z] = size.map((s) => Math.round(Number(s.value)));
    if (![x, y, z].every((v) => v >= 1 && v <= 256)) return toast(t('invalidSize'));
    if (x === ed.project.sx && y === ed.project.sy && z === ed.project.sz) return;
    ed.resize(x, y, z);
  };
  const tr = (label: string, kind: 'flipX' | 'flipY' | 'flipZ' | 'rotate' | 'clear') =>
    h(
      'button',
      {
        class: 'btn outline',
        onclick: async () => {
          if (kind === 'clear' && !(await confirmBox(t('confirmClear'), t('clear'), t('cancel')))) return;
          ed.transform(kind, allFrames);
        },
      },
      label,
    );
  return section(
    'model',
    t('model'),
    icon('cube', 16),
    false,
    count,
    row(t('size'), h('div', { class: 'xyz' }, ...size)),
    h('div', { class: 'buttons' }, h('button', { class: 'btn outline', onclick: apply }, t('resize'))),
    h('div', { class: 'group-title' }, t('transform')),
    h('div', { class: 'buttons' }, tr(t('flipX'), 'flipX'), tr(t('flipY'), 'flipY'), tr(t('flipZ'), 'flipZ'), tr(t('rotate'), 'rotate'), tr(t('clear'), 'clear')),
    row(t('allFrames'), checkbox(allFrames, (v) => (allFrames = v))),
  );
}

// ---- parts (rig) ---------------------------------------------------------------------

function partsSection(ed: Editor, scope: Scope): HTMLElement {
  const box = h('div', { class: 'col' });
  const render = () => {
    const rig = ed.project.rig;
    if (!rig) {
      box.replaceChildren(
        h('p', { class: 'hint-text' }, t('partsIntro')),
        h('button', { class: 'btn primary', html: `${icon('bone', 16)}<span>${t('enableParts')}</span>`, onclick: () => ed.enableRig() }),
      );
      return;
    }
    const active = getPart(rig, ed.activePart) ?? rig.parts[0];
    const list = h(
      'div',
      { class: 'parts' },
      ...rig.parts.map((p) =>
        h(
          'div',
          { class: 'part-row' + (p.id === active.id ? ' on' : ''), onclick: () => ed.setActivePart(p.id) },
          h('span', { class: 'dot', style: `background:${numToHex(p.color)}` }),
          h('span', {}, depthPrefix(rig.parts, p) + p.name),
          h('span', { class: 'hint-text' }, `#${p.id}`),
        ),
      ),
    );
    const pivots = active.pivot.map((v, i) => {
      const inp = h('input', { type: 'number', step: '0.5', value: String(v) });
      inp.addEventListener('change', () => {
        const pv = [...active.pivot] as [number, number, number];
        pv[i] = Number(inp.value);
        ed.updatePart(active.id, { pivot: pv });
      });
      return inp;
    });
    const color = h('input', { type: 'color', value: numToHex(active.color) });
    color.addEventListener('change', () => ed.updatePart(active.id, { color: hexToNum(color.value) }));
    const parentSel = select(
      String(active.parent),
      rig.parts.filter((p) => p.id !== active.id).map((p) => [String(p.id), p.name] as [string, string]),
      (v) => ed.updatePart(active.id, { parent: Number(v) }),
    );
    parentSel.disabled = active.id === 0;
    const autoPivot = (where: 'top' | 'center' | 'bottom') => {
      const b = partBounds(rig, ed.rigSourceGrid(), active.id);
      if (!b) return toast(t('partEmpty'));
      const cx = (b.min[0] + b.max[0] + 1) / 2;
      const cz = (b.min[2] + b.max[2] + 1) / 2;
      const y = where === 'top' ? b.max[1] + 1 : where === 'bottom' ? b.min[1] : (b.min[1] + b.max[1] + 1) / 2;
      ed.updatePart(active.id, { pivot: [cx, y, cz] });
    };
    const src = rig.source;
    const srcAnim = ed.project.animations[src.anim];
    box.replaceChildren(
      list,
      h(
        'div',
        { class: 'buttons' },
        h('button', {
          class: 'btn outline',
          html: `${icon('plus', 16)}<span>${t('addPart')}</span>`,
          onclick: async () => {
            const name = await askText(t('partName'), `${t('part')} ${rig.parts.length}`);
            if (name) ed.addPart(name);
          },
        }),
        h('button', { class: 'btn outline danger', disabled: active.id === 0, onclick: () => ed.removePart(active.id) }, t('removePart')),
      ),
      h('div', { class: 'group-title' }, active.name),
      row(
        t('name'),
        (() => {
          const inp = h('input', { type: 'text', value: active.name });
          inp.addEventListener('change', () => inp.value.trim() && ed.updatePart(active.id, { name: inp.value.trim() }));
          return inp;
        })(),
      ),
      row(t('parent'), parentSel),
      row(t('color'), color),
      row(t('pivot'), h('div', { class: 'xyz' }, ...pivots)),
      h(
        'div',
        { class: 'buttons' },
        h('button', {
          class: 'btn outline' + (ed.pivotPick === active.id ? ' on' : ''),
          html: `${icon('target', 16)}<span>${t('pickPivot')}</span>`,
          onclick: () => {
            ed.pivotPick = ed.pivotPick === active.id ? null : active.id;
            ed.setView({ partOverlay: true });
            ed.emit('rig');
          },
        }),
        h('button', { class: 'btn outline', onclick: () => autoPivot('top') }, t('pivotTop')),
        h('button', { class: 'btn outline', onclick: () => autoPivot('center') }, t('pivotCenter')),
        h('button', { class: 'btn outline', onclick: () => autoPivot('bottom') }, t('pivotBottom')),
      ),
      h('p', { class: 'hint-text' }, t('partsHint')),
      h('div', { class: 'group-title' }, t('restPose')),
      h('div', { class: 'hint-text' }, `${srcAnim?.name ?? '?'} · ${t('frame')} ${src.frame + 1}`),
      h('div', { class: 'buttons' }, h('button', { class: 'btn outline', onclick: () => ed.setRigSource(ed.animIndex, ed.frameIndex) }, t('useCurrentAsRest'))),
    );
  };
  scope.add(ed.on('rig', render));
  scope.add(ed.on('project', render));
  scope.add(ed.on('frames', render));
  render();
  return section('parts', t('parts'), icon('bone', 16), false, box);
}

function depthPrefix(parts: RigPart[], p: RigPart): string {
  let d = 0;
  let cur = p;
  while (cur.parent >= 0 && d < 20) {
    const next = parts.find((x) => x.id === cur.parent);
    if (!next) break;
    cur = next;
    d++;
  }
  return d ? '  '.repeat(d) + '└ ' : '';
}
