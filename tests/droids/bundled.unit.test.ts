import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BundledDroidsResolveError,
  loadBundledDroids,
  resolveBundledDroidsDir,
} from '../../src/droids/bundled.js';

let root: string;
let overrideDir: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'sym-4f2-bundled-'));
  overrideDir = path.join(root, 'bundled');
  mkdirSync(overrideDir, { recursive: true });
});
afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function writeDroid(name: string, body: string): void {
  writeFileSync(
    path.join(overrideDir, `${name}.md`),
    `---\nname: ${name}\ntools_denied: [bash]\n---\n${body}`,
  );
}

describe('resolveBundledDroidsDir', () => {
  it('honors the overrideDir seam', () => {
    expect(resolveBundledDroidsDir({ overrideDir })).toBe(overrideDir);
  });

  it('throws BundledDroidsResolveError with all probed candidates when nothing exists', () => {
    // Use a fresh tmp root with NO `bundled/` subdir (the suite's
    // beforeEach creates one under `root` — bypass it).
    const empty = mkdtempSync(path.join(tmpdir(), 'sym-4f2-empty-'));
    try {
      expect(() =>
        resolveBundledDroidsDir({
          moduleUrl: `file://${path.join(empty, 'nowhere.js')}`,
        }),
      ).toThrowError(BundledDroidsResolveError);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('loadBundledDroids', () => {
  it('reads + parses every .md, keyed by name', async () => {
    writeDroid('design-researcher', 'I am the design researcher.');
    writeDroid('other-bundled', 'I am another bundled droid.');
    const r = await loadBundledDroids({ overrideDir });
    expect([...r.droids.keys()].sort()).toEqual([
      'design-researcher',
      'other-bundled',
    ]);
    expect(r.warnings).toEqual([]);
  });

  it('substitutes system vars (e.g. {design_catalog_dir}) into the body at load time', async () => {
    writeDroid(
      'design-researcher',
      'Catalog lives at {design_catalog_dir}. Read it once.',
    );
    const r = await loadBundledDroids({
      overrideDir,
      systemVars: { design_catalog_dir: '/abs/vendor/design-catalog' },
    });
    const def = r.droids.get('design-researcher')!;
    expect(def.body).toContain('Catalog lives at /abs/vendor/design-catalog.');
    expect(def.body).not.toContain('{design_catalog_dir}');
  });

  it('substitutes ALL occurrences (not just the first)', async () => {
    writeDroid(
      'design-researcher',
      '{design_catalog_dir}/README.md and {design_catalog_dir}/<slug>.md',
    );
    const r = await loadBundledDroids({
      overrideDir,
      systemVars: { design_catalog_dir: '/x' },
    });
    const def = r.droids.get('design-researcher')!;
    expect(def.body).toBe('/x/README.md and /x/<slug>.md');
  });

  it('leaves unknown {tokens} literal (worker-vars happen later)', async () => {
    writeDroid('design-researcher', 'use {worktree_path} later.');
    const r = await loadBundledDroids({
      overrideDir,
      systemVars: { design_catalog_dir: '/x' },
    });
    expect(r.droids.get('design-researcher')!.body).toContain(
      'use {worktree_path} later.',
    );
  });

  it('a malformed bundled file is a warning, not a throw (boot must not crash)', async () => {
    writeDroid('ok', 'fine');
    writeFileSync(
      path.join(overrideDir, 'broken.md'),
      '---\nname: broken\nbogus: 1\n---\nbody',
    );
    const r = await loadBundledDroids({ overrideDir });
    expect(r.droids.has('ok')).toBe(true);
    expect(r.droids.has('broken')).toBe(false);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]!.source).toMatch(/broken\.md$/);
  });

  it('filename-stem MUST match frontmatter name (parser enforces)', async () => {
    writeFileSync(
      path.join(overrideDir, 'wrong-name.md'),
      `---\nname: not-wrong-name\ntools_denied: [bash]\n---\nb`,
    );
    const r = await loadBundledDroids({ overrideDir });
    expect(r.droids.size).toBe(0);
    expect(r.warnings[0]!.message).toMatch(/does not match expected/);
  });
});

describe('shipped design-researcher droid parses cleanly', () => {
  it('loads from the real `src/droids/bundled/` (or dist/) and resolves {design_catalog_dir}', async () => {
    // No overrideDir → walks the production candidate list.
    const r = await loadBundledDroids({
      systemVars: { design_catalog_dir: '/abs/sym/design-catalog' },
    });
    expect(r.droids.has('design-researcher')).toBe(true);
    const def = r.droids.get('design-researcher')!;
    expect(def.model).toBe('opus');
    expect(def.toolsAllowed).toContain('write');
    expect(def.toolsDenied).toContain('bash');
    expect(def.writePaths).toEqual(['DESIGN.md']);
    // System var substituted.
    expect(def.body).toContain('/abs/sym/design-catalog');
    expect(def.body).not.toContain('{design_catalog_dir}');
  });
});
