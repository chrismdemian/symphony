/**
 * Phase 7B.2 — runPluginInstall with REMOTE sources, driven by fake
 * runNpm/runGit runners (no network, no real subprocess). Verifies the DB
 * records the spec (sourceLabel), temp cleanup runs, and the git
 * entrypoint-missing warning fires.
 */
import path from 'node:path';
import os from 'node:os';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runPluginInstall, runPluginList } from '../../src/cli/plugin.js';
import { pluginDir } from '../../src/plugins/paths.js';
import type { RemoteRunner } from '../../src/plugins/remote.js';

let tmpRoot: string;
let home: string;
let dbFilePath: string;
let fetchTmp: string;

const NOW = '2026-06-03T00:00:00.000Z';

function capture(): { stream: Writable; text: () => string } {
  let buf = '';
  const stream = new Writable({
    write(chunk, _enc, cb) {
      buf += chunk.toString();
      cb();
    },
  });
  return { stream, text: () => buf };
}

function validManifest(id: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    id,
    name: id,
    version: '1.0.0',
    author: 'me',
    description: 'a remote plugin',
    entrypoint: { command: 'node', args: ['dist/index.js'] },
    ...overrides,
  });
}

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'sym-7b2-cli-'));
  home = path.join(tmpRoot, 'home');
  mkdirSync(home, { recursive: true });
  dbFilePath = path.join(tmpRoot, 'symphony.db');
  fetchTmp = path.join(tmpRoot, 'fetch');
  mkdirSync(fetchTmp, { recursive: true });
});
afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function fakeNpm(id: string, opts: { manifest?: string; withDist?: boolean } = {}): RemoteRunner {
  return async (args, options) => {
    const pi = args.indexOf('--prefix');
    const prefix = pi >= 0 ? args[pi + 1]! : options.cwd!;
    const dir = path.join(prefix, 'node_modules', id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'plugin.json'), opts.manifest ?? validManifest(id), 'utf8');
    if (opts.withDist !== false) {
      mkdirSync(path.join(dir, 'dist'), { recursive: true });
      writeFileSync(path.join(dir, 'dist', 'index.js'), '// x', 'utf8');
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };
}

function fakeGit(id: string, opts: { withDist?: boolean } = {}): RemoteRunner {
  return async (args) => {
    if (args[0] === 'clone') {
      const cloneDir = args[args.length - 1]!;
      mkdirSync(path.join(cloneDir, '.git'), { recursive: true });
      writeFileSync(path.join(cloneDir, '.git', 'config'), '[core]\n', 'utf8');
      writeFileSync(path.join(cloneDir, 'plugin.json'), validManifest(id), 'utf8');
      if (opts.withDist === true) {
        mkdirSync(path.join(cloneDir, 'dist'), { recursive: true });
        writeFileSync(path.join(cloneDir, 'dist', 'index.js'), '// x', 'utf8');
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };
}

describe('runPluginInstall — remote sources', () => {
  it('npm: records the spec as the DB source, installs disabled, cleans up temp', async () => {
    const err = capture();
    const r = await runPluginInstall({
      source: 'my-remote-plugin@1.0.0',
      runNpm: fakeNpm('my-remote-plugin'),
      tmpRoot: fetchTmp,
      dbFilePath,
      home,
      now: NOW,
      stderr: err.stream,
    });
    expect(r.exitCode).toBe(0);
    expect(err.text()).toContain("installed 'my-remote-plugin'");

    const out = capture();
    await runPluginList({ dbFilePath, home, format: 'json', stdout: out.stream });
    const parsed = JSON.parse(out.text()) as Array<{ id: string; source: string; enabled: boolean }>;
    expect(parsed[0]?.id).toBe('my-remote-plugin');
    expect(parsed[0]?.source).toBe('my-remote-plugin@1.0.0'); // spec, not the temp dir
    expect(parsed[0]?.enabled).toBe(false);

    // The fetched plugin landed in the central store; temp tree is gone.
    expect(existsSync(path.join(pluginDir('my-remote-plugin', home), 'plugin.json'))).toBe(true);
    expect(readdirSync(fetchTmp)).toHaveLength(0);
  });

  it('git: installs, records the URL, and does not copy .git into the store', async () => {
    const url = 'https://example.com/acme/git-plugin.git';
    const err = capture();
    const r = await runPluginInstall({
      source: url,
      runGit: fakeGit('git-plugin', { withDist: true }),
      tmpRoot: fetchTmp,
      dbFilePath,
      home,
      now: NOW,
      stderr: err.stream,
    });
    expect(r.exitCode).toBe(0);

    const installed = pluginDir('git-plugin', home);
    expect(existsSync(path.join(installed, 'plugin.json'))).toBe(true);
    expect(existsSync(path.join(installed, '.git'))).toBe(false);

    const out = capture();
    await runPluginList({ dbFilePath, home, format: 'json', stdout: out.stream });
    const parsed = JSON.parse(out.text()) as Array<{ id: string; source: string }>;
    expect(parsed[0]?.source).toBe(url);
    expect(readdirSync(fetchTmp)).toHaveLength(0);
  });

  it('git: warns when the entrypoint file is missing (no committed dist/)', async () => {
    const err = capture();
    const r = await runPluginInstall({
      source: 'https://example.com/acme/no-dist.git',
      runGit: fakeGit('no-dist', { withDist: false }),
      tmpRoot: fetchTmp,
      dbFilePath,
      home,
      now: NOW,
      stderr: err.stream,
    });
    expect(r.exitCode).toBe(0); // install succeeds; the warning is advisory
    expect(err.text()).toContain("entrypoint file 'dist/index.js' not found");
    expect(err.text().toLowerCase()).toContain('--allow-scripts');
  });

  it('cleans up the temp tree even when install fails on an invalid manifest', async () => {
    const err = capture();
    const r = await runPluginInstall({
      source: 'bad-plugin',
      // uppercase id → parsePluginManifest rejects it inside installPlugin
      runNpm: fakeNpm('bad-plugin', { manifest: validManifest('BAD-UPPER') }),
      tmpRoot: fetchTmp,
      dbFilePath,
      home,
      now: NOW,
      stderr: err.stream,
    });
    expect(r.exitCode).toBe(1);
    expect(err.text()).toContain('install failed');
    expect(readdirSync(fetchTmp)).toHaveLength(0); // temp removed despite failure
  });

  it('refuses an empty source', async () => {
    const err = capture();
    const r = await runPluginInstall({ source: '', dbFilePath, home, now: NOW, stderr: err.stream });
    expect(r.exitCode).toBe(1);
    expect(err.text()).toContain('empty-source');
  });
});
