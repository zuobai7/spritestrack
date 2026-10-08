import { defineConfig } from 'vite';

// `base: './'` keeps asset paths relative so the build works on GitHub Pages
// under /<repo>/ as well as from a local file server.
export default defineConfig({
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 1200 },
  test: { environment: 'node' },
});
