import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'tsup';

export default defineConfig({
  // Phase 4F.1 — `src/droids/fence-hook.ts` is a SECOND entry so it
  // emits as a standalone `dist/droids/fence-hook.js` Claude Code can
  // invoke as a PreToolUse hook. esbuild's outbase is the common
  // ancestor (`src/`), so the two entries land at `dist/index.js` +
  // `dist/droids/fence-hook.js` (resolver in `hook-command.ts` expects
  // exactly that). `splitting: false` keeps each entry self-contained.
  entry: ['src/index.ts', 'src/droids/fence-hook.ts'],
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
    // Phase 4F.2 — bundled droid `.md` files (`design-researcher` etc.).
    // Loaded at server boot via `src/droids/bundled.ts:loadBundledDroids`
    // (which walks `import.meta.url` candidates and lands here in the
    // bundled layout).
    copyTree(
      path.resolve('src/droids/bundled'),
      path.resolve('dist/droids/bundled'),
      (f) => f.endsWith('.md'),
    );
    // Phase 6A/6B — Python voice bridge files (`voice_bridge.py`,
    // `vad_segmenter.py`, `voice_vocab.py`, `stt_moonshine.py`).
    // Loaded at runtime via `src/voice/path.ts:voicePythonPackageDir`
    // which walks `import.meta.url` candidates and lands here in the
    // built layout.
    copyTree(
      path.resolve('src/voice/python'),
      path.resolve('dist/voice/python'),
      (f) => f.endsWith('.py'),
    );
    // Phase 6B — bundled vocab seed JSON. Installed atomically onto
    // `~/.symphony/voice-vocab.json` on first install. Loaded via
    // `src/voice/path.ts:voiceVocabSeedPath` which walks
    // `import.meta.url` candidates and lands here in the built layout.
    fs.mkdirSync(path.resolve('dist/voice'), { recursive: true });
    fs.copyFileSync(
      path.resolve('src/voice/vocab-seed.json'),
      path.resolve('dist/voice/vocab-seed.json'),
    );
    // Phase 7B.1 — vendored plugin SDK bundle for `symphony plugin new`.
    // The generator copies this into each scaffolded plugin's `lib/`.
    // Guarded: on a fresh build the SDK package may not be built yet
    // (`pnpm build:packages` runs after the root build); the generator's
    // resolver also walks the workspace `packages/` dir as a fallback.
    {
      const sdkVendor = path.resolve(
        'packages/plugin-sdk/dist/vendor/symphony-plugin-sdk.mjs',
      );
      if (fs.existsSync(sdkVendor)) {
        fs.mkdirSync(path.resolve('dist/plugin-sdk'), { recursive: true });
        fs.copyFileSync(sdkVendor, path.resolve('dist/plugin-sdk/symphony-plugin-sdk.mjs'));
      }
    }
    // Phase 6C — bundled wake-word ONNX models + LICENSE + checksums.
    // Loaded at runtime via `src/voice/path.ts:voiceWakeModelPath` which
    // walks `import.meta.url` candidates. The `.onnx` may legitimately
    // not exist yet (training is a separate one-time op); copyTree is
    // tolerant of missing dirs via the `existsSync` guard at the top.
    if (fs.existsSync(path.resolve('assets/wake-models'))) {
      copyTree(
        path.resolve('assets/wake-models'),
        path.resolve('dist/assets/wake-models'),
        (f) =>
          f.endsWith('.onnx') ||
          f.endsWith('.onnx.data') ||
          f === 'LICENSE.md' ||
          f === 'CHECKSUMS.txt' ||
          f === 'training-config.json',
      );
    }
  },
});
