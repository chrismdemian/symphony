import { defineConfig } from 'tsup';

/**
 * Build obsidian-source into a SINGLE self-contained file.
 *
 * `noExternal` bundles `@symphony/plugin-sdk`, `@modelcontextprotocol/sdk`,
 * `zod`, AND `gray-matter` (frontmatter parsing) INTO `dist/index.js` so the
 * installed plugin runs from just `plugin.json` + `dist/index.js` with no
 * `node_modules` — exactly how Symphony's host spawns it (clean env allowlist,
 * install-dir cwd). The plugin reads its vault path from
 * `<install-dir>/config.json`.
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
  noExternal: ['@symphony/plugin-sdk', '@modelcontextprotocol/sdk', 'zod', 'gray-matter'],
  // gray-matter is CJS and `require('fs')`s internally; under an ESM bundle
  // esbuild's `__require` shim throws "Dynamic require of fs is not supported".
  // Define a real `require` (via createRequire) at the top so the shim resolves
  // to it for Node builtins. Verified by `pnpm smoke:9b`.
  banner: {
    js: "import { createRequire as __createRequire } from 'module'; const require = __createRequire(import.meta.url);",
  },
});
