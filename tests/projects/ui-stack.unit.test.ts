import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  detectUiStack,
  hasDesignMd,
  UI_FRAMEWORK_PACKAGES,
} from '../../src/projects/ui-stack.js';

let project: string;

beforeEach(() => {
  project = mkdtempSync(path.join(tmpdir(), 'sym-4f3-uistack-'));
});
afterEach(() => {
  try {
    rmSync(project, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function writePkg(deps: Record<string, string>, devDeps: Record<string, string> = {}): void {
  writeFileSync(
    path.join(project, 'package.json'),
    JSON.stringify({ name: 'p', dependencies: deps, devDependencies: devDeps }),
  );
}

describe('detectUiStack', () => {
  it('no package.json ⇒ {hasUiStack: false, frameworks: []}', async () => {
    expect(await detectUiStack(project)).toEqual({
      hasUiStack: false,
      frameworks: [],
    });
  });

  it('package.json with no UI deps ⇒ no UI stack', async () => {
    writePkg({ commander: '^14', zod: '^4' });
    expect(await detectUiStack(project)).toEqual({
      hasUiStack: false,
      frameworks: [],
    });
  });

  it('detects react in dependencies', async () => {
    writePkg({ react: '^19' });
    const r = await detectUiStack(project);
    expect(r.hasUiStack).toBe(true);
    expect(r.frameworks).toEqual(['react']);
  });

  it('detects multiple frameworks across deps + devDeps; sorted + de-duped', async () => {
    writePkg(
      { next: '^15', react: '^19', tailwindcss: '^4' },
      { svelte: '^5' },
    );
    const r = await detectUiStack(project);
    expect(r.hasUiStack).toBe(true);
    expect(r.frameworks).toEqual(['next', 'react', 'svelte', 'tailwindcss']);
  });

  it.each([
    ['nuxt', { nuxt: '^3' }],
    ['vue', { vue: '^3' }],
    ['@sveltejs/kit', { '@sveltejs/kit': '^2' }],
    ['astro', { astro: '^5' }],
    ['solid-js', { 'solid-js': '^1' }],
    ['lit', { lit: '^3' }],
    ['preact', { preact: '^10' }],
    ['react-native', { 'react-native': '^0.74' }],
    ['expo', { expo: '^50' }],
    ['@radix-ui/themes', { '@radix-ui/themes': '^3' }],
    ['@mui/material', { '@mui/material': '^5' }],
    ['@chakra-ui/react', { '@chakra-ui/react': '^2' }],
    ['@mantine/core', { '@mantine/core': '^7' }],
    ['antd', { antd: '^5' }],
    ['@builder.io/qwik', { '@builder.io/qwik': '^1' }],
    ['gatsby', { gatsby: '^5' }],
  ])('detects %s', async (_label, deps) => {
    writePkg(deps);
    const r = await detectUiStack(project);
    expect(r.hasUiStack).toBe(true);
    expect(r.frameworks.length).toBeGreaterThan(0);
  });

  it('malformed package.json ⇒ {hasUiStack: false} (never crash a Python project)', async () => {
    writeFileSync(path.join(project, 'package.json'), '{ this is broken');
    expect(await detectUiStack(project)).toEqual({
      hasUiStack: false,
      frameworks: [],
    });
  });

  it('package.json without deps/devDeps blocks ⇒ no UI stack', async () => {
    writeFileSync(path.join(project, 'package.json'), '{}');
    expect(await detectUiStack(project)).toEqual({
      hasUiStack: false,
      frameworks: [],
    });
  });

  it('the framework set names lowercase + non-empty', () => {
    expect(UI_FRAMEWORK_PACKAGES.size).toBeGreaterThan(0);
    for (const name of UI_FRAMEWORK_PACKAGES) {
      expect(name).toBe(name.toLowerCase());
      expect(name.length).toBeGreaterThan(0);
    }
  });
});

describe('hasDesignMd', () => {
  it('false when DESIGN.md is absent', async () => {
    expect(await hasDesignMd(project)).toBe(false);
  });

  it('true when DESIGN.md is present at the project root', async () => {
    writeFileSync(path.join(project, 'DESIGN.md'), '# spec\n');
    expect(await hasDesignMd(project)).toBe(true);
  });

  it('does NOT match DESIGN.md inside a subdirectory (must be at root)', async () => {
    mkdirSync(path.join(project, 'sub'), { recursive: true });
    writeFileSync(path.join(project, 'sub', 'DESIGN.md'), '# nope\n');
    expect(await hasDesignMd(project)).toBe(false);
  });
});
