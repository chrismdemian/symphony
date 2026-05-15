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
  // Ship Phase 2B.1 migration SQL files + Phase 2C Maestro prompts
  // alongside the bundle so the runtime resolvers find them next to
  // `dist/index.js`.
  onSuccess: async () => {
    const copyTree = (
      srcAbs: string,
      dstAbs: string,
      predicate: (name: string) => boolean,
    ): void => {
      fs.rmSync(dstAbs, { recursive: true, force: true });
      fs.mkdirSync(dstAbs, { recursive: true });
      for (const file of fs.readdirSync(srcAbs)) {
        if (predicate(file)) {
          fs.copyFileSync(path.join(srcAbs, file), path.join(dstAbs, file));
        }
      }
    };
    copyTree(
      path.resolve('src/state/migrations'),
      path.resolve('dist/migrations'),
      (f) => f.endsWith('.sql'),
    );
    copyTree(
      path.resolve('research/prompts'),
      path.resolve('dist/prompts'),
      (f) => f.endsWith('.md'),
    );
    // Phase 4D.1 — the generated fragment subtree. `copyTree` is not
    // recursive (it skips subdirs), so the `fragments/` dir needs its
    // own copy pass alongside the flat v1 artifacts.
    copyTree(
      path.resolve('research/prompts/fragments'),
      path.resolve('dist/prompts/fragments'),
      (f) => f.endsWith('.md'),
    );
  },
});
