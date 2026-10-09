import { t } from '../i18n';
import type { RgbaImage } from '../export/image';

type Attrs = Record<string, unknown> & { class?: string; style?: string };
type Child = Node | string | null | undefined | false;

/** Tiny hyperscript helper: h('button', { class: 'x', onclick }, 'Label'). */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  let value: unknown;
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'value' && 'value' in el) value = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (k === 'html') el.innerHTML = String(v);
    else if (k in el && typeof v !== 'string') (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c);
  }
  // Last, once min/max/step and any <option>s exist: a range input set earlier
  // snaps the value to the default 0–100 range with step 1 (0.7 became 0.1)
  if (value !== undefined) (el as unknown as { value: string }).value = String(value);
  return el;
}

/** Replaces an element's children, skipping falsy entries like h() does. */
export function fill(el: HTMLElement, ...children: (Child | Child[])[]): void {
  el.replaceChildren(...children.flat().filter((c): c is Node | string => c !== null && c !== undefined && c !== false));
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

/** Open dialogs, topmost last; only the topmost one reacts to Escape. */
const openModals: (() => void)[] = [];

export function openModal(title: string, opts: { wide?: boolean; onClose?: () => void } = {}): Modal {
  const body = h('div', { class: 'modal-body' });
  const footer = h('div', { class: 'modal-footer' });
  // Focus moves into the dialog (so Enter or Space can't press the button
  // that opened it again) and goes back when it closes
  const returnFocus = document.activeElement as HTMLElement | null;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    overlay.remove();
    window.removeEventListener('keydown', onKey, true);
    openModals.splice(openModals.indexOf(close), 1);
    opts.onClose?.();
    if (returnFocus?.isConnected && !openModals.length) returnFocus.focus();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || openModals[openModals.length - 1] !== close) return;
    e.stopPropagation();
    e.preventDefault();
    close();
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
  openModals.push(close);
  window.addEventListener('keydown', onKey, true);
  panel.tabIndex = -1;
  panel.focus({ preventScroll: true });
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

/** Number input that reports only committed values (blur or Enter), for fields whose change rebuilds the UI. */
export function numberField(value: number, min: number, max: number, step: number, onchange: (v: number) => void): HTMLInputElement {
  const el = h('input', { type: 'number', value: String(value), min: String(min), max: String(max), step: String(step) });
  el.addEventListener('change', () => {
    const v = Number(el.value);
    if (Number.isNaN(v)) return;
    const c = Math.max(min, Math.min(max, v));
    el.value = String(c);
    onchange(c);
  });
  return el;
}

export function rangeInput(
  value: number,
  min: number,
  max: number,
  step: number,
  onchange: (v: number) => void,
  format: (v: number) => string = String,
): HTMLElement {
  const out = h('output', {}, format(value));
  const el = h('input', { type: 'range', value: String(value), min: String(min), max: String(max), step: String(step) });
  el.addEventListener('input', () => {
    out.textContent = format(Number(el.value));
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

/** Collects unsubscribe callbacks so a panel can be torn down and rebuilt (e.g. on language change). */
export class Scope {
  private fns: (() => void)[] = [];
  add(fn: () => void): void {
    this.fns.push(fn);
  }
  dispose(): void {
    this.fns.forEach((f) => f());
    this.fns = [];
  }
}

export interface MenuItem {
  label: string;
  icon?: string;
  hint?: string;
  action: () => void;
}

/** A button that opens a dropdown list of actions. */
export function menuButton(content: string, items: () => MenuItem[], cls = 'btn'): HTMLElement {
  const btn = h('button', { class: cls, html: content, 'aria-haspopup': 'menu' });
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelectorAll('.menu-list').forEach((m) => m.remove());
    const r = btn.getBoundingClientRect();
    const list = h(
      'div',
      { class: 'menu-list', role: 'menu' },
      ...items().map((it) =>
        h(
          'button',
          {
            role: 'menuitem',
            onclick: () => {
              list.remove();
              it.action();
            },
            html: `${it.icon ?? ''}<span>${escapeHtml(it.label)}</span>${it.hint ? `<span class="hint">${escapeHtml(it.hint)}</span>` : ''}`,
          },
        ),
      ),
    );
    list.style.left = `${Math.min(r.left, window.innerWidth - 220)}px`;
    list.style.top = `${r.bottom + 4}px`;
    document.body.append(list);
    const close = (ev: Event) => {
      if (ev.type === 'keydown' && (ev as KeyboardEvent).key !== 'Escape') return;
      if (ev.type === 'mousedown' && list.contains(ev.target as Node)) return;
      // The Escape that closes the menu does nothing else (like clearing the selection)
      if (ev.type === 'keydown') ev.stopPropagation();
      list.remove();
      window.removeEventListener('mousedown', close, true);
      window.removeEventListener('keydown', close, true);
    };
    setTimeout(() => {
      window.addEventListener('mousedown', close, true);
      window.addEventListener('keydown', close, true);
    });
  });
  return btn;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** A collapsible sidebar section that remembers whether it was open. */
export function section(id: string, title: string, iconHtml: string, defaultOpen: boolean, ...children: (Node | null | false)[]): HTMLDetailsElement {
  const key = `spritestrack.section.${id}`;
  let open = defaultOpen;
  try {
    const v = localStorage.getItem(key);
    if (v !== null) open = v === '1';
  } catch {
    /* ignore */
  }
  const body = h('div', { class: 'body' }, ...children);
  const d = h('details', { class: 'section' }, h('summary', { html: `${iconHtml}<span>${escapeHtml(title)}</span>` }), body);
  d.open = open;
  d.addEventListener('toggle', () => {
    try {
      localStorage.setItem(key, d.open ? '1' : '0');
    } catch {
      /* ignore */
    }
  });
  return d;
}

/** Simple prompt replacement that works in desktop webviews too. */
export function askText(title: string, value: string): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const input = h('input', { type: 'text', value });
    const m = openModal(title, {
      onClose: () => {
        if (!done) resolve(null);
      },
    });
    m.body.append(input);
    const ok = () => {
      done = true;
      m.close();
      resolve(input.value.trim() || null);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') ok();
    });
    m.footer.append(h('button', { class: 'btn outline', onclick: () => m.close() }, t('cancel')), h('button', { class: 'btn primary', onclick: ok }, t('ok')));
    setTimeout(() => {
      input.focus();
      input.select();
    });
  });
}

export function confirmBox(text: string, okLabel: string, cancelLabel: string): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const m = openModal(text, {
      onClose: () => {
        if (!done) resolve(false);
      },
    });
    m.footer.append(
      h('button', { class: 'btn outline', onclick: () => m.close() }, cancelLabel),
      h(
        'button',
        {
          class: 'btn primary',
          onclick: () => {
            done = true;
            m.close();
            resolve(true);
          },
        },
        okLabel,
      ),
    );
  });
}
