import { defineConfig } from 'tsup';

/**
 * Build the notifier example into a SINGLE self-contained file.
 *
 * `noExternal` bundles `@symphony/plugin-sdk`, `@modelcontextprotocol/sdk`,
 * and `zod` INTO `dist/index.js` so the installed plugin runs from just
 * `plugin.json` + `dist/index.js` with no `node_modules` — which is exactly
 * how Symphony's host spawns it (clean env, install-dir cwd). This is also
 * what a published, self-contained plugin should ship.
 */
export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  dts: false,
  sourcemap: false,
  splitting: false,
  shims: false,
  noExternal: ['@symphony/plugin-sdk', '@modelcontextprotocol/sdk', 'zod'],
});
