import { defineConfig } from 'tsup';

/**
 * Build chrome-devtools-mcp into a SINGLE self-contained file.
 *
 * `noExternal` bundles `@symphony/plugin-sdk`, `@modelcontextprotocol/sdk`,
 * and `zod` INTO `dist/index.js` so the installed plugin runs from just
 * `plugin.json` + `dist/index.js` with no `node_modules` — exactly how
 * Symphony's host spawns it (clean env allowlist, install-dir cwd). No CJS
 * deps, so no `createRequire` banner needed.
 *
 * This is a Phase 9D SKELETON: the tool handlers are non-functional stubs.
 * A real build proxies the official `chrome-devtools-mcp` server
 * (https://github.com/ChromeDevTools/chrome-devtools-mcp) behind Symphony's
 * mandatory security envelope. See README.md.
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
