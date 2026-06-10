import { defineConfig } from 'tsup';

/**
 * Build gitlab-source into a SINGLE self-contained file.
 *
 * `noExternal` bundles `@symphony/plugin-sdk`, `@modelcontextprotocol/sdk`,
 * and `zod` INTO `dist/index.js` so the installed plugin runs from just
 * `plugin.json` + `dist/index.js` with no `node_modules` — exactly how
 * Symphony's host spawns it (clean env allowlist, install-dir cwd). The plugin
 * reads its GitLab token + projects from `<install-dir>/config.json` (Symphony's
 * env allowlist strips every `SYMPHONY_*` var — a plugin sources its own
 * secrets, never Symphony's keychain). No CJS deps, so no `createRequire` banner
 * needed.
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
