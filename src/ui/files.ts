import { downloadBytes } from './dom';
import { deserializeProject, serializeProject } from '../core/serialize';
import type { Project } from '../core/Project';

/** True inside the Tauri desktop app. */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * Saves bytes under a file name: a native save dialog on desktop, a download
 * in the browser. Returns false if the user cancelled.
 */
export async function saveFile(name: string, data: Uint8Array | ArrayBuffer | string, mime: string): Promise<boolean> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data);
  if (isTauri()) {
    const [{ save }, { writeFile }] = await Promise.all([import('@tauri-apps/plugin-dialog'), import('@tauri-apps/plugin-fs')]);
    const ext = name.includes('.') ? name.split('.').pop()! : '';
    const path = await save({ defaultPath: name, filters: ext ? [{ name: ext.toUpperCase(), extensions: [ext] }] : [] });
    if (!path) return false;
    await writeFile(path, bytes);
    return true;
  }
  downloadBytes(bytes, name, mime);
  return true;
}

export const PROJECT_EXT = 'sstrack';

export function safeName(name: string): string {
  return (name || 'untitled').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'untitled';
}

export async function saveProjectFile(p: Project): Promise<boolean> {
  return saveFile(`${safeName(p.name)}.${PROJECT_EXT}`, serializeProject(p), 'application/json');
}

// ---- autosave ----------------------------------------------------------------

const AUTOSAVE_KEY = 'spritestrack.autosave.v1';
/** Whether the autosaved project had changes that were never saved to a file. */
const AUTOSAVE_DIRTY_KEY = 'spritestrack.autosave.dirty';
const PREFS_KEY = 'spritestrack.prefs.v1';

export function writeAutosave(p: Project, dirty: boolean): boolean {
  try {
    localStorage.setItem(AUTOSAVE_KEY, serializeProject(p));
    localStorage.setItem(AUTOSAVE_DIRTY_KEY, dirty ? '1' : '0');
    return true;
  } catch {
    // Storage full or unavailable. An older autosave must not come back on
    // the next start as if it were the latest work.
    try {
      localStorage.removeItem(AUTOSAVE_KEY);
      localStorage.removeItem(AUTOSAVE_DIRTY_KEY);
    } catch {
      /* ignore */
    }
    return false;
  }
}

/** Records that the autosaved project now matches a saved file. */
export function markAutosaveClean(): void {
  try {
    if (localStorage.getItem(AUTOSAVE_KEY) !== null) localStorage.setItem(AUTOSAVE_DIRTY_KEY, '0');
  } catch {
    /* ignore */
  }
}

export function readAutosave(): { project: Project; dirty: boolean } | null {
  try {
    const text = localStorage.getItem(AUTOSAVE_KEY);
    // Older autosaves have no flag; treat them as unsaved work to be safe
    return text ? { project: deserializeProject(text), dirty: localStorage.getItem(AUTOSAVE_DIRTY_KEY) !== '0' } : null;
  } catch {
    return null;
  }
}

export function readPrefs<T extends object>(): Partial<T> {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<T>;
  } catch {
    return {};
  }
}

export function writePrefs(prefs: object): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
}

/** Decodes an image file into RGBA pixels. */
export async function loadImageFile(file: File): Promise<{ image: import('../export/image').RgbaImage; url: string }> {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.src = url;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, c.width, c.height);
  return { image: { width: c.width, height: c.height, data: data.data }, url };
}
