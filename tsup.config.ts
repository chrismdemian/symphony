import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  dts: false,
  sourcemap: true,
  splitting: false,
  shims: false,
  // Ship Phase 2B.1 migration SQL files alongside the bundle so the
  // runtime `resolveMigrationsPath()` finds them next to `dist/index.js`.
  onSuccess: async () => {
    const src = path.resolve('src/state/migrations');
    const dst = path.resolve('dist/migrations');
    fs.rmSync(dst, { recursive: true, force: true });
    fs.mkdirSync(dst, { recursive: true });
    for (const file of fs.readdirSync(src)) {
      if (file.endsWith('.sql')) {
        fs.copyFileSync(path.join(src, file), path.join(dst, file));
      }
    }
  },
});
