/**
 * Phase 7C — security invariant: `PluginAdmin.install` (the RPC-reachable
 * install path the TUI uses) is ALWAYS ignore-scripts. The loud
 * `--allow-scripts` opt-in stays CLI-only; the admin never passes it, so
 * `resolveRemoteSource` appends `--ignore-scripts` and never runs author
 * lifecycle code. Locks the headline security property against refactors.
 */
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SymphonyDatabase } from '../../src/state/db.js';
import { SqlitePluginStore } from '../../src/plugins/store.js';
import { createPluginAdmin } from '../../src/plugins/admin.js';
import type { RemoteRunner } from '../../src/plugins/remote.js';

let tmpRoot: string;
let home: string;
let svc: ReturnType<typeof SymphonyDatabase.open>;
let store: SqlitePluginStore;

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'sym-7c-sec-'));
  home = path.join(tmpRoot, 'home');
  mkdirSync(home, { recursive: true });
  svc = SymphonyDatabase.open({ filePath: ':memory:' });
  store = new SqlitePluginStore(svc.db);
});

afterEach(() => {
  svc.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('PluginAdmin.install ignore-scripts invariant (7C)', () => {
  it('passes --ignore-scripts (never --allow-scripts) to npm and refuses gracefully', async () => {
    const npmArgs: string[][] = [];
    const runNpm: RemoteRunner = async (args) => {
      npmArgs.push([...args]);
      // Fail the fetch so we don't actually hit the network; we only care
      // about the flags the admin asked for.
      return { exitCode: 1, stdout: '', stderr: 'forced failure (test)' };
    };
    const admin = createPluginAdmin({ store, home, now: () => 'ts', runNpm });

    // A bare package name classifies as an npm source.
    const result = await admin.install('some-plugin-package');

    // Graceful refusal (not a throw) so the RPC layer can surface it.
    expect(result.ok).toBe(false);

    // The npm runner was invoked with the supply-chain guard, never the
    // script-executing opt-in.
    expect(npmArgs.length).toBeGreaterThanOrEqual(1);
    const flat = npmArgs.flat();
    expect(flat).toContain('--ignore-scripts');
    expect(flat).not.toContain('--allow-scripts');
  });
});
