import type { RgbaImage } from '../export/image';

type Attrs = Record<string, unknown> & { class?: string; style?: string };
type Child = Node | string | null | undefined | false;

/** Tiny hyperscript helper: h('button', { class: 'x', onclick }, 'Label'). */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (k === 'html') el.innerHTML = String(v);
    else if (k in el && typeof v !== 'string') (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c);
  }
  return el;
}

export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function downloadBytes(data: Uint8Array | ArrayBuffer | string, name: string, type: string): void {
  downloadBlob(new Blob([data as BlobPart], { type }), name);
}

export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept });
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null));
    input.click();
  });
}

export function imageToCanvas(img: RgbaImage): HTMLCanvasElement {
  const c = h('canvas', { width: img.width, height: img.height });
  const ctx = c.getContext('2d')!;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  return c;
}

export function imageToPng(img: RgbaImage): Promise<Uint8Array> {
  return new Promise((resolve, reject) =>
    imageToCanvas(img).toBlob(async (b) => {
      if (!b) return reject(new Error('PNG encoding failed'));
      resolve(new Uint8Array(await b.arrayBuffer()));
    }, 'image/png'),
  );
}

/** Draws an image into a canvas element, scaled to fit with crisp pixels. */
export function drawFit(canvas: HTMLCanvasElement, img: RgbaImage, maxScale = 8): void {
  const ctx = canvas.getContext('2d')!;
  const w = canvas.width;
  const hh = canvas.height;
  ctx.clearRect(0, 0, w, hh);
  if (img.width === 0 || img.height === 0) return;
  const s = Math.max(0.1, Math.min(maxScale, Math.floor(Math.min(w / img.width, hh / img.height)) || Math.min(w / img.width, hh / img.height)));
  ctx.imageSmoothingEnabled = false;
  const src = imageToCanvas(img);
  const dw = img.width * s;
  const dh = img.height * s;
  ctx.drawImage(src, Math.floor((w - dw) / 2), Math.floor((hh - dh) / 2), dw, dh);
}

export interface Modal {
  el: HTMLElement;
  body: HTMLElement;
  footer: HTMLElement;
  close(): void;
}

export function openModal(title: string, opts: { wide?: boolean; onClose?: () => void } = {}): Modal {
  const body = h('div', { class: 'modal-body' });
  const footer = h('div', { class: 'modal-footer' });
  const close = () => {
    overlay.remove();
    window.removeEventListener('keydown', onKey, true);
    opts.onClose?.();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  const panel = h(
    'div',
    { class: 'modal' + (opts.wide ? ' wide' : ''), role: 'dialog', 'aria-label': title },
    h('div', { class: 'modal-header' }, h('h2', {}, title), h('button', { class: 'icon-btn', onclick: close, 'aria-label': 'close' }, '✕')),
    body,
    footer,
  );
  const overlay = h('div', { class: 'overlay', onmousedown: (e: MouseEvent) => e.target === overlay && close() }, panel);
  document.body.append(overlay);
  window.addEventListener('keydown', onKey, true);
  return { el: panel, body, footer, close };
}

export function toast(text: string, ms = 2200): void {
  const el = h('div', { class: 'toast' }, text);
  document.body.append(el);
  setTimeout(() => el.classList.add('show'), 10);
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, ms);
}

/** Labeled form row helpers used by dialogs. */
export function row(label: string, control: HTMLElement): HTMLElement {
  return h('label', { class: 'row' }, h('span', {}, label), control);
}

export function numberInput(value: number, min: number, max: number, step: number, onchange: (v: number) => void): HTMLInputElement {
  const el = h('input', { type: 'number', value: String(value), min: String(min), max: String(max), step: String(step) });
  el.addEventListener('input', () => {
    const v = Number(el.value);
    if (!Number.isNaN(v)) onchange(Math.max(min, Math.min(max, v)));
  });
  return el;
}

export function rangeInput(value: number, min: number, max: number, step: number, onchange: (v: number) => void): HTMLElement {
  const out = h('output', {}, String(value));
  const el = h('input', { type: 'range', value: String(value), min: String(min), max: String(max), step: String(step) });
  el.addEventListener('input', () => {
    out.textContent = el.value;
    onchange(Number(el.value));
  });
  return h('span', { class: 'range' }, el, out);
}

export function checkbox(value: boolean, onchange: (v: boolean) => void): HTMLInputElement {
  const el = h('input', { type: 'checkbox' });
  el.checked = value;
  el.addEventListener('change', () => onchange(el.checked));
  return el;
}

export function select(value: string, options: [string, string][], onchange: (v: string) => void): HTMLSelectElement {
  const el = h('select', {}, ...options.map(([v, l]) => h('option', { value: v }, l)));
  el.value = value;
  el.addEventListener('change', () => onchange(el.value));
  return el;
}
