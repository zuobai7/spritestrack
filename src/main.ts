import './style.css';
import { App, exposeApi } from './ui/App';
import { isTauri } from './ui/files';

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
