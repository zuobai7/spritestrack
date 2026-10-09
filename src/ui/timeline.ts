import type { Editor } from '../editor/Editor';
import { renderStack } from '../export/stackRenderer';
import { t } from '../i18n';
import { askText, confirmBox, drawFit, h, Scope } from './dom';
import { icon } from './icons';
import type { VoxelGrid } from '../core/VoxelGrid';

/** Thumbnail cache keyed by grid object; invalidated when the editor bumps that grid's version. */
const thumbs = new WeakMap<VoxelGrid, { version: number; canvas: HTMLCanvasElement }>();

function thumbFor(ed: Editor, g: VoxelGrid, palette: number[], paletteKey: number): HTMLCanvasElement {
  const v = ed.version(g) * 100003 + paletteKey;
  const hit = thumbs.get(g);
  if (hit && hit.version === v) return hit.canvas;
  const canvas = h('canvas', { width: 64, height: 64 });
  drawFit(canvas, renderStack(g, palette, { angle: 35, shading: true }), 4);
  thumbs.set(g, { version: v, canvas });
  return canvas;
}

function paletteHash(p: number[]): number {
  let x = p.length;
  for (const c of p) x = (Math.imul(x, 31) + c) | 0;
  return x & 0xffff;
}

export function mountTimeline(el: HTMLElement, ed: Editor, scope: Scope, openRig: () => void): void {
  const animSelect = h('select', { title: t('animation') });
  animSelect.addEventListener('change', () => ed.selectFrame(Number(animSelect.value), 0));
  const playBtn = h('button', { class: 'icon-btn', onclick: () => ed.togglePlay() });
  const fps = h('input', { type: 'number', min: '1', max: '60', step: '1', title: t('fps') });
  fps.addEventListener('change', () => {
    ed.setFps(Number(fps.value));
    fps.value = String(ed.anim.fps);
  });
  const onion = h('button', { class: 'btn', onclick: () => ed.setView({ onion: !ed.onion }) }, t('onion'));
  const frames = h('div', { class: 'frames' });
  const btn = (name: string, title: string, fn: () => void) => h('button', { class: 'icon-btn', title, 'aria-label': title, html: icon(name), onclick: fn });

  const bar = h(
    'div',
    { class: 'bar' },
    h('span', { class: 'hint-text' }, t('animation')),
    animSelect,
    btn('plus', t('addAnim'), async () => {
      const name = await askText(t('promptAnimName'), `anim ${ed.project.animations.length + 1}`);
      if (name) ed.addAnimation(name);
    }),
    h('button', {
      class: 'btn',
      onclick: async () => {
        const name = await askText(t('renameAnim'), ed.anim.name);
        if (name) ed.renameAnimation(name);
      },
    }, t('renameAnim')),
    btn('trash', t('deleteAnim'), async () => {
      if (ed.project.animations.length > 1 && (await confirmBox(t('confirmDeleteAnim'), t('deleteAnim'), t('cancel')))) ed.deleteAnimation();
    }),
    h('div', { class: 'sep' }),
    playBtn,
    h('span', { class: 'hint-text' }, t('fps')),
    fps,
    onion,
    h('div', { class: 'sep' }),
    btn('plus', t('addFrame'), () => ed.addFrame(false)),
    btn('copy', t('dupFrame'), () => ed.addFrame(true)),
    btn('trash', t('deleteFrame'), () => ed.deleteFrame()),
    btn('left', t('moveLeft'), () => ed.moveFrame(-1)),
    btn('right', t('moveRight'), () => ed.moveFrame(1)),
    h('div', { class: 'sep' }),
    h('button', { class: 'btn', html: `${icon('bone')}<span>${t('rigAnimation')}</span>`, onclick: openRig }),
  );
  el.append(bar, frames);

  const renderBar = () => {
    animSelect.replaceChildren(...ed.project.animations.map((a, i) => h('option', { value: String(i) }, `${a.name} (${a.frames.length})`)));
    animSelect.value = String(ed.animIndex);
    if (document.activeElement !== fps) fps.value = String(ed.anim.fps);
    playBtn.innerHTML = icon(ed.playing ? 'pause' : 'play');
    playBtn.title = ed.playing ? t('pause') : t('play');
    onion.classList.toggle('on', ed.onion);
  };

  // Animation the thumbnails show
  let shownAnim = -1;
  const renderFrames = () => {
    shownAnim = ed.animIndex;
    const pk = paletteHash(ed.project.palette);
    frames.replaceChildren(
      ...ed.anim.frames.map((g, i) =>
        h(
          'button',
          {
            class: 'frame' + (i === ed.frameIndex ? ' on' : ''),
            title: `${t('frame')} ${i + 1}`,
            onclick: () => {
              ed.stop();
              ed.selectFrame(ed.animIndex, i);
            },
          },
          thumbFor(ed, g, ed.project.palette, pk),
          h('span', {}, String(i + 1)),
        ),
      ),
      h('button', { class: 'frame add', title: t('dupFrame'), html: icon('plus'), onclick: () => ed.addFrame(true) }),
    );
  };

  // Current-frame thumbnail refresh is debounced while drawing
  let pending: number | null = null;
  const onModel = () => {
    if (pending !== null) return;
    pending = window.setTimeout(() => {
      pending = null;
      renderFrames();
    }, 250);
  };

  const onFrame = () => {
    renderBar();
    frames.querySelectorAll('.frame').forEach((f, i) => f.classList.toggle('on', i === ed.frameIndex));
    if (ed.animIndex !== shownAnim || ed.anim.frames.length + 1 !== frames.children.length) renderFrames();
    (frames.children[ed.frameIndex] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };

  scope.add(ed.on('model', onModel));
  scope.add(ed.on('frame', onFrame));
  scope.add(ed.on('state', renderBar));
  scope.add(
    ed.on('frames', () => {
      renderBar();
      renderFrames();
    }),
  );
  scope.add(
    ed.on('project', () => {
      renderBar();
      renderFrames();
    }),
  );
  scope.add(ed.on('palette', renderFrames));
  scope.add(() => pending !== null && clearTimeout(pending));
  renderBar();
  renderFrames();
}
