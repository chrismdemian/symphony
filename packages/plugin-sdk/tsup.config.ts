import { defineConfig } from 'tsup';

/**
 * Phase 7B — build the authoring SDK.
 *
 * Two outputs from one source tree:
 *  - `dist/index.js` (+ `dist/index.d.ts`) — the importable package, with
 *    `@modelcontextprotocol/sdk` and `zod` left EXTERNAL (the consuming
 *    plugin lists them as its own deps; bundling them would duplicate the
 *    MCP runtime).
 *  - `dist/vendor/symphony-plugin-sdk.mjs` — a single-file build that the
 *    `symphony plugin new` generator copies into each scaffolded plugin
 *    (so a scaffold is self-contained without a published npm dep). Deps
 *    stay external there too — the scaffold's package.json declares them.
 */
export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    target: 'node22',
    platform: 'node',
    outDir: 'dist',
    clean: true,
    dts: true,
    sourcemap: true,
    splitting: false,
    shims: false,
    external: ['@modelcontextprotocol/sdk', 'zod'],
  },
  {
    entry: { 'symphony-plugin-sdk': 'src/index.ts' },
    format: ['esm'],
    target: 'node22',
    platform: 'node',
    outDir: 'dist/vendor',
    clean: false,
    dts: false,
    sourcemap: false,
    splitting: false,
    shims: false,
    // `.mjs` so a scaffolded plugin can import it unambiguously as ESM
    // regardless of the plugin's own package.json `type`.
    outExtension: () => ({ js: '.mjs' }),
    external: ['@modelcontextprotocol/sdk', 'zod'],
  },
]);
