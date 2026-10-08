import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

// `base: './'` keeps asset paths relative so the build works on GitHub Pages
// under /<repo>/, inside the Tauri desktop app, and from any static server.
export default defineConfig({
  base: './',
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  build: { target: 'es2022', chunkSizeWarningLimit: 1200 },
  worker: { format: 'es' },
  // Tauri expects a fixed port in dev and must not have the screen cleared
  server: { port: 5173, strictPort: true },
  clearScreen: false,
  test: { environment: 'node' },
});
