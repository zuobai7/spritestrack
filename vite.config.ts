import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

/** All files under `dir`, as paths relative to `root` with forward slashes. */
function listFiles(dir: string, root = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listFiles(join(dir, e.name), root) : [relative(root, join(dir, e.name)).split(sep).join('/')],
  );
}

/**
 * Writes dist/sw.js from the src/sw.js template with the list of every built
 * file, so the service worker caches the whole app on the first visit. The
 * build id is a hash of all files, so any change installs a fresh cache.
 */
function serviceWorker(): Plugin {
  return {
    name: 'spritestrack-service-worker',
    apply: 'build',
    writeBundle(options) {
      const dir = options.dir!;
      const files = listFiles(dir)
        .filter((f) => f !== 'sw.js' && !f.endsWith('.map'))
        .sort();
      const hash = createHash('sha256');
      for (const f of files) hash.update(f).update(readFileSync(join(dir, f)));
      const source = readFileSync(new URL('./src/sw.js', import.meta.url), 'utf8')
        .replace('__BUILD_ID__', JSON.stringify(hash.digest('hex').slice(0, 12)))
        .replace('__BUILD_FILES__', JSON.stringify(files.map((f) => './' + f)));
      writeFileSync(join(dir, 'sw.js'), source);
    },
  };
}

// `base: './'` keeps asset paths relative so the build works on GitHub Pages
// under /<repo>/, inside the Tauri desktop app, and from any static server.
export default defineConfig({
  base: './',
  plugins: [serviceWorker()],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  build: { target: 'es2022', chunkSizeWarningLimit: 1200 },
  worker: { format: 'es' },
  // Tauri expects a fixed port in dev and must not have the screen cleared
  server: { port: 5173, strictPort: true },
  clearScreen: false,
  test: { environment: 'node' },
});
