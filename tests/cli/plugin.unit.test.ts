/**
 * Phase 7A — `symphony plugin …` CLI runner tests. Uses a temp-FILE DB so
 * state persists across the separate open/close cycles each runner does.
 */
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  runPluginDisable,
  runPluginEnable,
  runPluginInstall,
  runPluginList,
  runPluginRemove,
} from '../../src/cli/plugin.js';

let tmpRoot: string;
let home: string;
let dbFilePath: string;

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

function writePluginSource(dir: string, manifest: Record<string, unknown>): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(manifest), 'utf8');
  return dir;
}

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: 'echo',
    name: 'Echo',
    version: '1.0.0',
    author: 'me',
    description: 'echoes',
    entrypoint: { command: 'node', args: ['server.js'] },
    ...overrides,
  };
}

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'sym-plugincli-'));
  home = path.join(tmpRoot, 'home');
  mkdirSync(home, { recursive: true });
  dbFilePath = path.join(tmpRoot, 'symphony.db');
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('plugin CLI lifecycle', () => {
  it('install → list → enable → list --json → disable → remove', async () => {
    const src = writePluginSource(
      path.join(tmpRoot, 'src'),
      manifest({ capabilityFlags: ['irreversible'], permissions: ['task:read'] }),
    );

    // install
    const installErr = capture();
    const r1 = await runPluginInstall({
      source: src,
      dbFilePath,
      home,
      now: '2026-06-02T00:00:00.000Z',
      stderr: installErr.stream,
    });
    expect(r1.exitCode).toBe(0);
    expect(installErr.text()).toContain("installed 'echo'");
    expect(installErr.text()).toContain('irreversible');

    // list (table) — disabled by default
    const listOut = capture();
    await runPluginList({ dbFilePath, home, format: 'table', stdout: listOut.stream });
    expect(listOut.text()).toMatch(/disabled\s+echo\s+1\.0\.0/);

    // enable
    const enErr = capture();
    const r2 = await runPluginEnable({ id: 'echo', dbFilePath, home, stderr: enErr.stream });
    expect(r2.exitCode).toBe(0);
    expect(enErr.text()).toContain("enabled 'echo'");

    // list --json — enabled now
    const jsonOut = capture();
    await runPluginList({ dbFilePath, home, format: 'json', stdout: jsonOut.stream });
    const parsed = JSON.parse(jsonOut.text()) as Array<{ id: string; enabled: boolean }>;
    expect(parsed[0]?.id).toBe('echo');
    expect(parsed[0]?.enabled).toBe(true);

    // disable
    const r3 = await runPluginDisable({ id: 'echo', dbFilePath, home, stderr: capture().stream });
    expect(r3.exitCode).toBe(0);

    // remove
    const r4 = await runPluginRemove({ id: 'echo', dbFilePath, home, stderr: capture().stream });
    expect(r4.exitCode).toBe(0);

    // list now empty (json → [])
    const emptyOut = capture();
    await runPluginList({ dbFilePath, home, format: 'json', stdout: emptyOut.stream });
    expect(JSON.parse(emptyOut.text())).toEqual([]);
  });

  it('enable refuses an unknown plugin', async () => {
    const r = await runPluginEnable({ id: 'ghost', dbFilePath, home, stderr: capture().stream });
    expect(r.exitCode).toBe(1);
  });

  it('install refuses an invalid manifest with exit 1', async () => {
    const src = writePluginSource(path.join(tmpRoot, 'bad'), manifest({ id: 'BAD' }));
    const err = capture();
    const r = await runPluginInstall({ source: src, dbFilePath, home, stderr: err.stream });
    expect(r.exitCode).toBe(1);
    expect(err.text()).toContain('install failed');
  });
});
