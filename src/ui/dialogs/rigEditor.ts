import type { Editor } from '../../editor/Editor';
import { VoxelGrid } from '../../core/VoxelGrid';
import { numToHex, shade } from '../../core/Palette';
import {
  applyTemplate,
  bakeFrame,
  getPart,
  hasKey,
  removeKey,
  sampleTrack,
  setKey,
  type Easing,
  type Rig,
  type RigAnimation,
  type Template,
  type V3,
} from '../../core/rig';
import { renderStack } from '../../export/stackRenderer';
import { t } from '../../i18n';
import { askText, checkbox, confirmBox, drawFit, fill, h, numberField, openModal, rangeInput, row, select, toast } from '../dom';
import { icon } from '../icons';

/** A slider that reports every move (`onInput`) and the release (`onCommit`). */
function liveRange(value: number, min: number, max: number, step: number, onInput: (v: number) => void, onCommit: () => void): HTMLElement {
  const el = rangeInput(value, min, max, step, onInput);
  el.querySelector('input')!.addEventListener('change', onCommit);
  return el;
}

function setRange(el: HTMLElement, v: number): void {
  const input = el.querySelector('input')!;
  if (document.activeElement === input) return; // don't fight the user's drag
  input.value = String(v);
  el.querySelector('output')!.textContent = String(Math.round(v * 10) / 10);
}

/**
 * Part-based skeletal animation editor: rig animations on the left, posed
 * preview and key tracks in the middle, the selected part's pose and motion
 * templates on the right. Baking turns a rig animation into voxel frames.
 */
export function openRigEditor(ed: Editor): void {
  let ai = 0;
  let frame = 0;
  let angle = 35;
  let showParts = false;
  let playing = false;
  let playTimer: number | null = null;
  const tpl: { kind: Template; axis: 0 | 1 | 2; amount: number; phase: number } = { kind: 'swing', axis: 0, amount: 30, phase: 0 };
  const unsubs: (() => void)[] = [];

  const m = openModal(t('rigTitle'), {
    wide: true,
    onClose: () => {
      stopPlay();
      ed.commitLive('pose');
      unsubs.forEach((u) => u());
    },
  });
  m.el.style.width = 'min(1180px, 100%)';

  const rig = (): Rig | null => ed.project.rig;
  const anim = (): RigAnimation | null => rig()?.animations[ai] ?? null;
  const pid = () => (rig() && getPart(rig()!, ed.activePart) ? ed.activePart : 0);

  // ---- preview ---------------------------------------------------------------
  const canvas = h('canvas', { width: 420, height: 380 });
  const meta = h('div', { class: 'meta' });
  let queued = false;
  const drawPreview = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      const r = rig();
      if (!r || !canvas.isConnected) return;
      let src = ed.rigSourceGrid();
      let pal = ed.project.palette;
      if (showParts) {
        // Color voxels by part (index = part id + 1); parts other than the selected one are dimmed
        const colored = new VoxelGrid(src.sx, src.sy, src.sz);
        const pm = r.partMap.data;
        for (let i = 0; i < src.data.length; i++) if (src.data[i]) colored.data[i] = Math.min(255, pm[i] + 1);
        pal = new Array(256).fill(0x808080);
        for (const p of r.parts) pal[Math.min(255, p.id + 1)] = p.id === pid() ? p.color : shade(p.color, 0.55);
        src = colored;
      }
      const a = anim();
      const posed = bakeFrame(src, r, a, a ? frame : 0);
      drawFit(canvas, renderStack(posed, pal, { angle, light: ed.light, padding: Math.ceil(posed.sy / 3) }), 8);
      meta.textContent = a ? `${t('frame')} ${frame + 1} / ${a.length}` : t('restPose');
    });
  };

  // ---- play ------------------------------------------------------------------
  const playBtn = h('button', { class: 'icon-btn', onclick: () => (playing ? stopPlay() : startPlay()) });
  const syncPlayBtn = () => {
    playBtn.innerHTML = icon(playing ? 'pause' : 'play');
    playBtn.title = playing ? t('pause') : t('play');
  };
  function startPlay() {
    const a = anim();
    if (!a) return;
    playing = true;
    playTimer = window.setInterval(() => {
      const cur = anim();
      if (!cur) return stopPlay();
      frame = (frame + 1) % Math.max(1, cur.length);
      updateDynamic();
    }, 1000 / Math.max(1, a.fps));
    syncPlayBtn();
  }
  function stopPlay() {
    playing = false;
    if (playTimer !== null) clearInterval(playTimer);
    playTimer = null;
    syncPlayBtn();
  }

  // ---- panels ------------------------------------------------------------------
  const left = h('div', { class: 'col' });
  const middle = h('div', { class: 'col' });
  const right = h('div', { class: 'col' });
  const tracks = h('div', { class: 'col', style: 'gap:4px' });
  const frameSlider = h('input', { type: 'range', min: '0', max: '0', step: '1', value: '0', style: 'flex:1' });
  const frameOut = h('output', { style: 'min-width:48px;text-align:right' });
  frameSlider.addEventListener('input', () => {
    frame = Number(frameSlider.value);
    stopPlay();
    updateDynamic();
  });
  const angleRange = rangeInput(angle, 0, 359, 1, (v) => {
    angle = v;
    drawPreview();
  });

  // Pose controls are built once per part/frame and then updated in place, so sliders keep focus
  const rotRanges: HTMLElement[] = [];
  const posInputs: HTMLInputElement[] = [];
  const keyState = h('div', { class: 'hint-text' });
  const poseTitle = h('div', { class: 'group-title' });

  const editPose = (mutate: (rot: V3, pos: V3) => void, live: boolean) => {
    const p = pid();
    ed.editRigAnimation(
      ai,
      (a) => {
        const s = sampleTrack(a, p, frame);
        mutate(s.rot, s.pos);
        setKey(a, p, { frame, rot: s.rot, pos: s.pos });
      },
      live,
    );
  };

  for (let axis = 0; axis < 3; axis++) {
    rotRanges.push(
      // ±360 so a full turn (the spin template's keys) fits on the slider
      liveRange(
        0,
        -360,
        360,
        1,
        (v) => editPose((rot) => (rot[axis] = v), true),
        () => ed.commitLive('pose'),
      ),
    );
    const inp = h('input', { type: 'number', step: '1', value: '0' });
    inp.addEventListener('change', () => editPose((_, pos) => (pos[axis] = Math.round(Number(inp.value) || 0)), false));
    posInputs.push(inp);
  }

  /** Refreshes everything that changes with time, keys and pose (cheap, no rebuild). */
  const updateDynamic = () => {
    const a = anim();
    const L = a ? Math.max(1, a.length) : 1;
    frame = Math.min(frame, L - 1);
    frameSlider.max = String(L - 1);
    frameSlider.value = String(frame);
    frameOut.textContent = `${frame + 1} / ${L}`;
    if (a) {
      const s = sampleTrack(a, pid(), frame);
      rotRanges.forEach((r, i) => setRange(r, Math.round(s.rot[i] * 10) / 10));
      posInputs.forEach((p, i) => document.activeElement !== p && (p.value = String(Math.round(s.pos[i] * 10) / 10)));
      keyState.textContent = hasKey(a, pid(), frame) ? `◆ ${t('keyHere')}` : `◇ ${t('noKeyHere')}`;
      poseTitle.textContent = `${getPart(rig()!, pid())?.name ?? ''} · ${t('frame')} ${frame + 1}`;
    }
    renderTracks();
    drawPreview();
  };

  const renderTracks = () => {
    const r = rig();
    const a = anim();
    if (!r || !a) return fill(tracks);
    const L = Math.max(1, a.length);
    const pos = (f: number) => (L > 1 ? (f / (L - 1)) * 100 : 50);
    fill(
      tracks,
      r.parts.map((p) => {
        const keys = a.tracks.find((tr) => tr.part === p.id)?.keys ?? [];
        const bar = h(
          'div',
          { class: 'keytrack', style: p.id === pid() ? 'outline:1px solid var(--accent)' : '' },
          ...keys.map((k) => h('i', { style: `left:${pos(k.frame)}%`, title: `${t('frame')} ${k.frame + 1}` })),
          h('b', { style: `left:calc(${pos(frame)}% - 1px)` }),
        );
        bar.addEventListener('pointerdown', (e) => {
          const rect = bar.getBoundingClientRect();
          frame = Math.max(0, Math.min(L - 1, Math.round(((e.clientX - rect.left) / rect.width) * (L - 1))));
          stopPlay();
          if (p.id !== ed.activePart) ed.setActivePart(p.id);
          else updateDynamic();
        });
        return h(
          'div',
          { style: 'display:grid;grid-template-columns:96px minmax(0,1fr);gap:8px;align-items:center;cursor:pointer' },
          h('span', { style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, h('span', { class: 'dot', style: `background:${numToHex(p.color)};margin-right:6px` }), p.name),
          bar,
        );
      }),
    );
  };

  const renderLeft = () => {
    const r = rig()!;
    const a = anim();
    fill(
      left,
      h('div', { class: 'group-title' }, t('rigAnimations')),
      h(
        'div',
        { class: 'list' },
        r.animations.map((x, i) =>
          h(
            'button',
            {
              class: i === ai ? 'on' : '',
              onclick: () => {
                ai = i;
                frame = 0;
                stopPlay();
                renderAll();
              },
            },
            `${x.name} · ${x.length}`,
          ),
        ),
      ),
      h(
        'div',
        { class: 'buttons' },
        h('button', {
          class: 'btn outline',
          html: `${icon('plus', 16)}<span>${t('add')}</span>`,
          onclick: async () => {
            const name = await askText(t('promptAnimName'), r.animations.length ? `${t('motion')} ${r.animations.length + 1}` : 'walk');
            if (!name) return;
            ai = ed.addRigAnimation(name);
            frame = 0;
            renderAll();
          },
        }),
        a &&
          h('button', {
            class: 'btn outline',
            onclick: async () => {
              const name = await askText(t('renameAnim'), a.name);
              if (name) ed.editRigAnimation(ai, (x) => (x.name = name));
            },
          }, t('renameAnim')),
        a &&
          h('button', {
            class: 'icon-btn',
            title: t('delete'),
            html: icon('trash'),
            onclick: async () => {
              if (!(await confirmBox(t('confirmDeleteAnim'), t('delete'), t('cancel')))) return;
              ed.removeRigAnimation(ai);
              ai = Math.max(0, ai - 1);
              renderAll();
            },
          }),
      ),
      a && h('div', { class: 'group-title' }, t('settings')),
      a &&
        row(
          t('length'),
          numberField(a.length, 1, 120, 1, (v) =>
            ed.editRigAnimation(ai, (x) => {
              x.length = Math.max(1, Math.round(v));
              // A shorter animation drops the keys past its new end
              for (const tr of x.tracks) tr.keys = tr.keys.filter((k) => k.frame < x.length);
              x.tracks = x.tracks.filter((tr) => tr.keys.length > 0);
            }),
          ),
        ),
      a &&
        row(
          t('fps'),
          numberField(a.fps, 1, 60, 1, (v) => {
            ed.editRigAnimation(ai, (x) => (x.fps = Math.round(v)));
            if (playing) {
              stopPlay();
              startPlay();
            }
          }),
        ),
      a && row(t('loop'), checkbox(a.loop, (v) => ed.editRigAnimation(ai, (x) => (x.loop = v)))),
      a &&
        row(
          t('easing'),
          select(
            a.easing,
            [
              ['smooth', t('easeSmooth')],
              ['linear', t('easeLinear')],
              ['step', t('easeStep')],
            ],
            (v) => ed.editRigAnimation(ai, (x) => (x.easing = v as Easing)),
          ),
        ),
      h('div', { class: 'group-title' }, t('restPose')),
      h('div', { class: 'hint-text' }, `${ed.project.animations[r.source.anim]?.name ?? '?'} · ${t('frame')} ${r.source.frame + 1}`),
      h('p', { class: 'hint-text' }, t('rigHint')),
    );
  };

  const renderMiddle = () => {
    const a = anim();
    fill(
      middle,
      h('div', { class: 'preview-box', style: 'min-height:380px' }, canvas, meta),
      a && h('div', { class: 'buttons', style: 'flex-wrap:nowrap;align-items:center' }, playBtn, frameSlider, frameOut),
      row(t('angle'), angleRange),
      row(t('showParts'), checkbox(showParts, (v) => ((showParts = v), drawPreview()))),
      a && h('div', { class: 'group-title' }, t('keyframes')),
      a && tracks,
      !a && h('p', { class: 'hint-text' }, t('noRigAnims')),
    );
  };

  const renderRight = () => {
    const r = rig()!;
    const a = anim();
    const part = getPart(r, pid())!;
    fill(
      right,
      h('div', { class: 'group-title' }, t('parts')),
      h(
        'div',
        { class: 'list', style: 'max-height:150px' },
        r.parts.map((p) =>
          h(
            'button',
            { class: p.id === part.id ? 'on' : '', onclick: () => ed.setActivePart(p.id) },
            h('span', { class: 'dot', style: `background:${numToHex(p.color)};margin-right:6px` }),
            p.name,
          ),
        ),
      ),
      r.parts.length < 2 && h('p', { class: 'hint-text' }, t('needParts')),
      a && poseTitle,
      a && keyState,
      a && row(t('rotX'), rotRanges[0]),
      a && row(t('rotY'), rotRanges[1]),
      a && row(t('rotZ'), rotRanges[2]),
      a && row(t('offset'), h('div', { class: 'xyz' }, ...posInputs)),
      a &&
        h(
          'div',
          { class: 'buttons' },
          h('button', { class: 'btn outline', onclick: () => editPose(() => {}, false) }, t('setKey')),
          h('button', { class: 'btn outline', onclick: () => ed.editRigAnimation(ai, (x) => removeKey(x, part.id, frame)) }, t('deleteKey')),
          h('button', {
            class: 'btn outline',
            onclick: () => ed.editRigAnimation(ai, (x) => (x.tracks = x.tracks.filter((tr) => tr.part !== part.id))),
          }, t('clearTrack')),
        ),
      a && h('div', { class: 'group-title' }, t('templates')),
      a &&
        row(
          t('template'),
          select(
            tpl.kind,
            [
              ['swing', t('tplSwing')],
              ['bob', t('tplBob')],
              ['spin', t('tplSpin')],
              ['shake', t('tplShake')],
            ],
            (v) => {
              tpl.kind = v as Template;
              tpl.amount = tpl.kind === 'swing' ? 30 : tpl.kind === 'spin' ? 360 : 1;
              renderRight();
            },
          ),
        ),
      a &&
        row(
          t('axis'),
          select(
            String(tpl.axis),
            [
              ['0', 'X'],
              ['1', 'Y'],
              ['2', 'Z'],
            ],
            (v) => (tpl.axis = Number(v) as 0 | 1 | 2),
          ),
        ),
      a && tpl.kind !== 'spin' && row(tpl.kind === 'swing' ? t('amountDeg') : t('amountVox'), rangeInput(tpl.amount, 1, tpl.kind === 'swing' ? 90 : 8, 1, (v) => (tpl.amount = v))),
      a && row(t('phase'), rangeInput(tpl.phase, 0, 1, 0.05, (v) => (tpl.phase = v))),
      a &&
        h('div', { class: 'buttons' }, h('button', {
          class: 'btn outline',
          html: `${icon('sparkle', 16)}<span>${t('applyTemplate')}</span>`,
          onclick: () => ed.editRigAnimation(ai, (x) => applyTemplate(x, part.id, tpl.kind, { axis: tpl.axis, amount: tpl.amount, phase: tpl.phase })),
        })),
      a && h('p', { class: 'hint-text' }, t('templateHint')),
    );
  };

  const bakeBtn = h('button', {
    class: 'btn primary',
    html: `${icon('film', 16)}<span>${t('bake')}</span>`,
    onclick: () => {
      const a = anim();
      if (!a) return;
      ed.bakeRigAnimation(ai);
      toast(`${t('baked')}: ${a.name}`);
    },
  });

  let structureKey = '';
  const renderAll = () => {
    const r = rig();
    if (!r) {
      fill(
        m.body,
        h('p', {}, t('partsIntro')),
        h('div', { class: 'buttons' }, h('button', { class: 'btn primary', html: `${icon('bone', 16)}<span>${t('enableParts')}</span>`, onclick: () => ed.enableRig() })),
      );
      bakeBtn.disabled = true;
      return;
    }
    ai = Math.max(0, Math.min(ai, r.animations.length - 1));
    if (!m.body.contains(left)) fill(m.body, h('div', { class: 'three-col', style: 'grid-template-columns:210px minmax(0,1fr) 270px' }, left, middle, right));
    renderLeft();
    renderMiddle();
    renderRight();
    bakeBtn.disabled = !anim();
    syncPlayBtn();
    updateDynamic();
  };

  /** Rebuilds panels only when the rig's structure changed; otherwise just refreshes values. */
  const onRig = () => {
    const r = rig();
    const key = r
      ? JSON.stringify([
          ai,
          ed.activePart,
          r.parts.map((p) => [p.id, p.name, p.color]),
          r.animations.map((a) => [a.name, a.length, a.fps, a.loop, a.easing]),
          r.source,
        ])
      : 'none';
    if (key !== structureKey) {
      structureKey = key;
      renderAll();
    } else updateDynamic();
  };

  unsubs.push(ed.on('rig', onRig), ed.on('project', onRig), ed.on('frames', onRig));
  for (const ev of ['model', 'palette', 'light'] as const) unsubs.push(ed.on(ev, drawPreview));
  m.footer.append(h('span', { class: 'hint-text', style: 'margin-right:auto' }, t('bakeHint')), h('button', { class: 'btn outline', onclick: () => m.close() }, t('close')), bakeBtn);
  onRig();
}
