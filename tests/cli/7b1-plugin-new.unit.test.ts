/**
 * Phase 7B.1 — `symphony plugin new` generator (`src/cli/plugin-new.ts`).
 * Scaffolds into a temp dir, validates the produced manifest with the host
 * parser, and checks the fail-loud guards (slug-empty name, non-empty dir).
 */
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runPluginNew, slugifyPluginId } from '../../src/cli/plugin-new.js';
import { parsePluginManifest } from '../../src/plugins/manifest.js';

let tmp: string;
let vendor: string;
const sink = () => new WritableSink();

class WritableSink {
  lines: string[] = [];
  write(s: string): boolean {
    this.lines.push(s);
    return true;
  }
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'sym-7b1-new-'));
  // A fake vendored SDK file so the generator doesn't depend on a build.
  vendor = path.join(tmp, 'fake-sdk.mjs');
  writeFileSync(vendor, '// fake sdk\nexport const createPlugin = () => {};\n', 'utf8');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('7B.1 plugin generator', () => {
  it('slugifies names into safe ids', () => {
    expect(slugifyPluginId('My Cool Plugin!!')).toBe('my-cool-plugin');
    expect(slugifyPluginId('  Notion Tasks  ')).toBe('notion-tasks');
    expect(slugifyPluginId('!!!')).toBe('');
    expect(slugifyPluginId('UPPER_case')).toBe('upper_case');
    // `__` is reserved as the tool-namespace separator — collapse it.
    expect(slugifyPluginId('foo__bar')).toBe('foo_bar');
  });

  it('scaffolds a valid, self-contained plugin', async () => {
    const out = path.join(tmp, 'dest');
    const stdout = sink();
    const stderr = sink();
    const res = await runPluginNew({
      name: 'Notion Tasks',
      out,
      author: 'chris',
      sdkVendorPath: vendor,
      stdout: stdout as unknown as NodeJS.WritableStream,
      stderr: stderr as unknown as NodeJS.WritableStream,
    });
    expect(res.exitCode).toBe(0);

    // Files present.
    for (const f of ['plugin.json', 'package.json', 'index.js', 'README.md', '.gitignore', 'lib/symphony-plugin-sdk.mjs']) {
      expect(existsSync(path.join(out, f)), `${f} should exist`).toBe(true);
    }

    // Manifest validates with the HOST parser (the real boundary).
    const manifest = parsePluginManifest(
      JSON.parse(readFileSync(path.join(out, 'plugin.json'), 'utf8')),
    );
    expect(manifest.id).toBe('notion-tasks');
    expect(manifest.name).toBe('Notion Tasks');
    expect(manifest.author).toBe('chris');
    expect(manifest.entrypoint).toEqual({ command: 'node', args: ['index.js'] });

    // package.json is valid + declares the SDK's externals.
    const pkg = JSON.parse(readFileSync(path.join(out, 'package.json'), 'utf8'));
    expect(pkg.name).toBe('notion-tasks');
    expect(pkg.dependencies['@modelcontextprotocol/sdk']).toBeDefined();
    expect(pkg.dependencies['zod']).toBeDefined();

    // index.js references the vendored SDK + the id.
    const index = readFileSync(path.join(out, 'index.js'), 'utf8');
    expect(index).toContain("./lib/symphony-plugin-sdk.mjs");
    expect(index).toContain('notion-tasks');
  });

  it('refuses an unparseable name', async () => {
    const res = await runPluginNew({
      name: '!!!',
      out: path.join(tmp, 'x'),
      sdkVendorPath: vendor,
      stdout: sink() as unknown as NodeJS.WritableStream,
      stderr: sink() as unknown as NodeJS.WritableStream,
    });
    expect(res.exitCode).toBe(1);
    expect(existsSync(path.join(tmp, 'x'))).toBe(false);
  });

  it('refuses a non-empty target dir without --force', async () => {
    const out = path.join(tmp, 'occupied');
    mkdirSync(out, { recursive: true });
    writeFileSync(path.join(out, 'keep.txt'), 'hi', 'utf8');
    const res = await runPluginNew({
      name: 'plug',
      out,
      sdkVendorPath: vendor,
      stdout: sink() as unknown as NodeJS.WritableStream,
      stderr: sink() as unknown as NodeJS.WritableStream,
    });
    expect(res.exitCode).toBe(1);
    expect(existsSync(path.join(out, 'plugin.json'))).toBe(false);
  });

  it('scaffolds into a non-empty dir with --force', async () => {
    const out = path.join(tmp, 'occupied2');
    mkdirSync(out, { recursive: true });
    writeFileSync(path.join(out, 'keep.txt'), 'hi', 'utf8');
    const res = await runPluginNew({
      name: 'plug',
      out,
      force: true,
      sdkVendorPath: vendor,
      stdout: sink() as unknown as NodeJS.WritableStream,
      stderr: sink() as unknown as NodeJS.WritableStream,
    });
    expect(res.exitCode).toBe(0);
    expect(existsSync(path.join(out, 'plugin.json'))).toBe(true);
    expect(existsSync(path.join(out, 'keep.txt'))).toBe(true);
  });

  it('fails clearly when the vendored SDK cannot be located', async () => {
    const stderr = sink();
    const res = await runPluginNew({
      name: 'plug',
      out: path.join(tmp, 'y'),
      sdkVendorPath: path.join(tmp, 'does-not-exist.mjs'),
      stdout: sink() as unknown as NodeJS.WritableStream,
      stderr: stderr as unknown as NodeJS.WritableStream,
    });
    expect(res.exitCode).toBe(1);
    expect(stderr.lines.join('')).toMatch(/could not locate the bundled SDK/);
  });
});
