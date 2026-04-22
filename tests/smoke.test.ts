import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

interface PackageJson {
  name: string;
  version: string;
  bin: Record<string, string>;
  type: string;
  engines: { node: string };
}

const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as PackageJson;

describe('project scaffold', () => {
  it('declares a version', () => {
    expect(pkg.version).toBe('0.0.0');
  });

  it('wires the symphony CLI binary', () => {
    expect(pkg.bin.symphony).toBe('./dist/index.js');
  });

  it('is ESM', () => {
    expect(pkg.type).toBe('module');
  });

  it('pins Node 22+', () => {
    expect(pkg.engines.node).toMatch(/>=\s*22/);
  });
});
