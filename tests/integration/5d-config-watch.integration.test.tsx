/**
 * Phase 5D audit M2+M3 fix — verify `<ConfigProvider>`'s fs.watch
 * bridge picks up cross-process changes to `~/.symphony/config.json`
 * within ~1s and propagates them to consumers.
 *
 * Scenario:
 *   1. Mount a `<ConfigProvider>` (no `initial` — production path).
 *   2. Wait for the initial mount-time load to settle.
 *   3. Simulate Maestro's MCP child writing the file (out-of-process
 *      from this test's perspective): write a new `activeProject`
 *      value via `applyPatchToDisk`. The atomic rename fires
 *      fs.watch in the parent dir; ConfigProvider's effect debounces
 *      then calls `reload()`.
 *   4. Assert the consumer (a `<Probe>` that reads `useConfig()`)
 *      re-renders with the new value within a bounded wait.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import React from 'react';
import { Text } from 'ink';

import {
  ConfigProvider,
  useConfig,
} from '../../src/utils/config-context.js';
import {
  SYMPHONY_CONFIG_FILE_ENV,
  _resetConfigWriteQueue,
  applyPatchToDisk,
} from '../../src/utils/config.js';

const SETTLE_MS = 2500;

function Probe(): React.JSX.Element {
  const { config } = useConfig();
  return <Text>{`activeProject=${config.activeProject ?? '<unset>'}`}</Text>;
}

async function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await wait(40);
  }
  // Final attempt; let the caller assert if it failed.
}

describe('Phase 5D — ConfigProvider fs.watch bridge (audit M2+M3 fix)', () => {
  let sandbox: string;
  let configPath: string;
  let priorEnv: string | undefined;

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-5d-watch-'));
    configPath = path.join(sandbox, 'config.json');
    priorEnv = process.env[SYMPHONY_CONFIG_FILE_ENV];
    process.env[SYMPHONY_CONFIG_FILE_ENV] = configPath;
    _resetConfigWriteQueue();
  });

  afterEach(() => {
    if (priorEnv === undefined) {
      delete process.env[SYMPHONY_CONFIG_FILE_ENV];
    } else {
      process.env[SYMPHONY_CONFIG_FILE_ENV] = priorEnv;
    }
    _resetConfigWriteQueue();
    try {
      fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      // Win32 retry — best effort
    }
  });

  it('cross-process write to activeProject propagates to ConfigProvider consumers', async () => {
    // Seed an initial activeProject so the mount-time load reads a
    // known value first; later we'll change it to a different value
    // and verify the change propagates.
    fs.writeFileSync(
      configPath,
      JSON.stringify({ schemaVersion: 1, activeProject: 'before' }),
    );

    const tree = render(
      <ConfigProvider>
        <Probe />
      </ConfigProvider>,
    );
    try {
      // Wait for initial load (async).
      await waitFor(
        () => (tree.lastFrame() ?? '').includes('activeProject=before'),
        SETTLE_MS,
      );
      expect(tree.lastFrame() ?? '').toContain('activeProject=before');

      // Simulate Maestro's MCP child writing the file via the same
      // `applyPatchToDisk` path Maestro uses. Atomic rename fires
      // fs.watch on the parent directory.
      await applyPatchToDisk({ activeProject: 'after' });

      // Wait for the debounced fs.watch handler + reload() + setState
      // cascade to surface in the rendered tree.
      await waitFor(
        () => (tree.lastFrame() ?? '').includes('activeProject=after'),
        SETTLE_MS,
      );
      expect(tree.lastFrame() ?? '').toContain('activeProject=after');
    } finally {
      tree.unmount();
    }
  });

  it('clearing the field on disk propagates as <unset>', async () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({ schemaVersion: 1, activeProject: 'one' }),
    );

    const tree = render(
      <ConfigProvider>
        <Probe />
      </ConfigProvider>,
    );
    try {
      await waitFor(
        () => (tree.lastFrame() ?? '').includes('activeProject=one'),
        SETTLE_MS,
      );

      // Maestro fires `set_active_project("(none)")` → server calls
      // `applyPatchToDisk({activeProject: null})` → file rewrite
      // without the field.
      await applyPatchToDisk({ activeProject: null });

      await waitFor(
        () => (tree.lastFrame() ?? '').includes('activeProject=<unset>'),
        SETTLE_MS,
      );
      expect(tree.lastFrame() ?? '').toContain('activeProject=<unset>');
    } finally {
      tree.unmount();
    }
  });

  it('initial prop suppresses the watcher (tests / visual harness path)', async () => {
    // When `initial` is provided, the effect early-returns. Mutating
    // disk should NOT cause a reload. This protects the visual
    // harness + unit tests against unexpected re-renders.
    const tree = render(
      <ConfigProvider initial={{ config: { schemaVersion: 1, modelMode: 'mixed', maxConcurrentWorkers: 4, autoMerge: 'ask', notifications: { enabled: false }, awayMode: false, theme: { name: 'symphony', autoFallback16Color: true }, leaderTimeoutMs: 300, keybindOverrides: {}, autonomyTier: 2 } as never, source: { kind: 'default' } }}>
        <Probe />
      </ConfigProvider>,
    );
    try {
      await wait(100);
      const baseline = tree.lastFrame() ?? '';
      expect(baseline).toContain('activeProject=<unset>');

      // Write to disk; the fixture should NOT update.
      await applyPatchToDisk({ activeProject: 'should-not-leak' });
      await wait(300);
      const after = tree.lastFrame() ?? '';
      expect(after).toContain('activeProject=<unset>');
      expect(after).not.toContain('should-not-leak');
    } finally {
      tree.unmount();
    }
  });
});
