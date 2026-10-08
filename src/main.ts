import './style.css';
import { App, exposeApi } from './ui/App';
import { isTauri } from './ui/files';
import { openAnyFile } from './ui/dialogs/project';

const app = new App(document.getElementById('app')!);
exposeApi(app);

// Offline support: the service worker caches the app after the first visit.
// Only for the hosted web version (the desktop app ships its files).
if (import.meta.env.PROD && 'serviceWorker' in navigator && location.protocol.startsWith('http') && !isTauri()) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      /* offline support is optional */
    });
  });
}

// Files opened with the installed web app (see file_handlers in the manifest)
type LaunchQueue = { setConsumer(fn: (params: { files: readonly FileSystemFileHandle[] }) => void): void };
(window as unknown as { launchQueue?: LaunchQueue }).launchQueue?.setConsumer(async ({ files }) => {
  if (files[0]) void openAnyFile(app.ed, await files[0].getFile());
});

// In the desktop app, links open in the system browser instead of the editor window
if (isTauri()) {
  document.addEventListener('click', (e) => {
    const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (!a || !/^https?:/.test(a.href)) return;
    e.preventDefault();
    void import('@tauri-apps/plugin-opener').then((m) => m.openUrl(a.href));
  });
}
