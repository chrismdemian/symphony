import React, { useEffect, useRef } from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render } from 'ink-testing-library';
import {
  ConfigProvider,
  useConfig,
  type ConfigController,
} from '../../src/utils/config-context.js';
import { defaultConfig } from '../../src/utils/config-schema.js';
import { SYMPHONY_CONFIG_FILE_ENV, _resetConfigWriteQueue } from '../../src/utils/config.js';
import type { KeyChord } from '../../src/ui/keybinds/registry.js';

/**
 * Phase 3H.2 — `ConfigProvider.setConfig` covers the in-process setter
 * that SettingsPanel + leader handlers call. The RPC `mode.setModel`
 * exercise lives in `tests/rpc/mode-setmodel.unit.test.ts`; this suite
 * focuses on the React context surface: merge correctness, persistence
 * (real disk via SYMPHONY_CONFIG_FILE), validation rejection, and the
 * test/harness `initial` short-circuit.
 */

const settle = async (ms = 30): Promise<void> => {
  await new Promise((r) => setTimeout(r, ms));
};

interface CaptureProps {
  readonly cb: (controller: ConfigController) => void;
}

function Capture({ cb }: CaptureProps): React.JSX.Element {
  const controller = useConfig();
  const ref = useRef(controller);
  ref.current = controller;
  useEffect(() => {
    cb(controller);
  });
  return <></>;
}

describe('ConfigProvider.setConfig (3H.2)', () => {
  let tmp: string;
  let cfgFile: string;
  let prevEnv: string | undefined;

  beforeEach(() => {
    _resetConfigWriteQueue();
    tmp = mkdtempSync(join(tmpdir(), 'symphony-config-ctx-'));
    cfgFile = join(tmp, 'config.json');
    prevEnv = process.env[SYMPHONY_CONFIG_FILE_ENV];
    process.env[SYMPHONY_CONFIG_FILE_ENV] = cfgFile;
  });

  afterEach(() => {
    _resetConfigWriteQueue();
    if (prevEnv === undefined) delete process.env[SYMPHONY_CONFIG_FILE_ENV];
    else process.env[SYMPHONY_CONFIG_FILE_ENV] = prevEnv;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('persists to disk and reflects in state on top-level set', async () => {
    let captured: ConfigController | undefined;
    render(
      <ConfigProvider>
        <Capture cb={(c) => (captured = c)} />
      </ConfigProvider>,
    );
    // Initial async load resolves to defaults (no file).
    await settle(60);
    if (captured === undefined) throw new Error('captured undefined');
    expect(captured.config.modelMode).toBe('mixed');

    const next = await captured.setConfig({ modelMode: 'opus' });
    expect(next.modelMode).toBe('opus');

    await settle(40);
    expect(captured.config.modelMode).toBe('opus');

    const onDisk = JSON.parse(readFileSync(cfgFile, 'utf8')) as Record<string, unknown>;
    expect(onDisk['modelMode']).toBe('opus');
  });

  it('partial-deep-merges nested theme + notifications fields', async () => {
    let captured: ConfigController | undefined;
    render(
      <ConfigProvider>
        <Capture cb={(c) => (captured = c)} />
      </ConfigProvider>,
    );
    await settle(60);
    if (captured === undefined) throw new Error('captured undefined');

    await captured.setConfig({ theme: { autoFallback16Color: false } });
    await settle(20);
    expect(captured.config.theme.autoFallback16Color).toBe(false);
    expect(captured.config.theme.name).toBe('symphony');

    await captured.setConfig({ notifications: { enabled: true } });
    await settle(20);
    expect(captured.config.notifications.enabled).toBe(true);
    // Theme partial preserved across the second patch.
    expect(captured.config.theme.autoFallback16Color).toBe(false);
  });

  it('throws ZodError for out-of-range fields, does NOT persist, AND preserves in-memory state (audit M4)', async () => {
    let captured: ConfigController | undefined;
    render(
      <ConfigProvider>
        <Capture cb={(c) => (captured = c)} />
      </ConfigProvider>,
    );
    await settle(60);
    if (captured === undefined) throw new Error('captured undefined');

    // First persist a known-good value.
    await captured.setConfig({ maxConcurrentWorkers: 8 });
    await settle(20);
    const before = JSON.parse(readFileSync(cfgFile, 'utf8')) as Record<string, unknown>;
    expect(before['maxConcurrentWorkers']).toBe(8);

    // Now attempt out-of-range — must reject, leave disk unchanged,
    // AND preserve in-memory state (a future refactor that swapped
    // setState before the throw would silently regress this).
    await expect(captured.setConfig({ maxConcurrentWorkers: -1 })).rejects.toThrow();
    const after = JSON.parse(readFileSync(cfgFile, 'utf8')) as Record<string, unknown>;
    expect(after['maxConcurrentWorkers']).toBe(8);
    expect(captured.config.maxConcurrentWorkers).toBe(8);
  });

  it('flips source.kind to "file" on first save when initial source was "default" (audit M1)', async () => {
    let captured: ConfigController | undefined;
    render(
      <ConfigProvider>
        <Capture cb={(c) => (captured = c)} />
      </ConfigProvider>,
    );
    await settle(60);
    if (captured === undefined) throw new Error('captured undefined');
    expect(captured.source.kind).toBe('default');

    await captured.setConfig({ modelMode: 'opus' });
    await settle(20);
    expect(captured.source.kind).toBe('file');
    if (captured.source.kind === 'file') {
      expect(captured.source.path).toBe(cfgFile);
    }
  });

  it('keybindOverrides replaces (not merges) the entire record (audit m4)', async () => {
    let captured: ConfigController | undefined;
    render(
      <ConfigProvider>
        <Capture cb={(c) => (captured = c)} />
      </ConfigProvider>,
    );
    await settle(60);
    if (captured === undefined) throw new Error('captured undefined');

    const chordA: KeyChord = { kind: 'ctrl', char: 'a' };
    const chordB: KeyChord = { kind: 'ctrl', char: 'b' };
    const chordC: KeyChord = { kind: 'ctrl', char: 'c' };

    await captured.setConfig({ keybindOverrides: { 'cmd.a': chordA, 'cmd.b': chordB } });
    await settle(20);
    expect(Object.keys(captured.config.keybindOverrides).sort()).toEqual(['cmd.a', 'cmd.b']);

    await captured.setConfig({ keybindOverrides: { 'cmd.c': chordC } });
    await settle(20);
    // Replace, not merge — `cmd.a` and `cmd.b` should be gone.
    expect(Object.keys(captured.config.keybindOverrides)).toEqual(['cmd.c']);
  });

  it('serializes concurrent setConfig calls so both patches survive (audit C2)', async () => {
    let captured: ConfigController | undefined;
    render(
      <ConfigProvider>
        <Capture cb={(c) => (captured = c)} />
      </ConfigProvider>,
    );
    await settle(60);
    if (captured === undefined) throw new Error('captured undefined');

    // Fire both without awaiting between them — under the pre-fix
    // closure-stale-state bug, only the second patch survived because
    // each `setConfig` merged off the same captured `state.config`.
    const a = captured.setConfig({ modelMode: 'opus' });
    const b = captured.setConfig({ maxConcurrentWorkers: 16 });
    await Promise.all([a, b]);
    await settle(40);

    expect(captured.config.modelMode).toBe('opus');
    expect(captured.config.maxConcurrentWorkers).toBe(16);
    const onDisk = JSON.parse(readFileSync(cfgFile, 'utf8')) as Record<string, unknown>;
    expect(onDisk['modelMode']).toBe('opus');
    expect(onDisk['maxConcurrentWorkers']).toBe(16);
  });

  it('explicit null on defaultProjectPath drops the field on disk', async () => {
    let captured: ConfigController | undefined;
    render(
      <ConfigProvider>
        <Capture cb={(c) => (captured = c)} />
      </ConfigProvider>,
    );
    await settle(60);
    if (captured === undefined) throw new Error('captured undefined');

    await captured.setConfig({ defaultProjectPath: '/tmp/foo' });
    await settle(20);
    let onDisk = JSON.parse(readFileSync(cfgFile, 'utf8')) as Record<string, unknown>;
    expect(onDisk['defaultProjectPath']).toBe('/tmp/foo');

    await captured.setConfig({ defaultProjectPath: null });
    await settle(20);
    onDisk = JSON.parse(readFileSync(cfgFile, 'utf8')) as Record<string, unknown>;
    expect(onDisk['defaultProjectPath']).toBeUndefined();
    expect(captured.config.defaultProjectPath).toBeUndefined();
  });

  it('respects test-mode initial: setConfig stays in-memory (no disk write)', async () => {
    let captured: ConfigController | undefined;
    const initial = { config: defaultConfig(), source: { kind: 'default' as const } };
    render(
      <ConfigProvider initial={initial}>
        <Capture cb={(c) => (captured = c)} />
      </ConfigProvider>,
    );
    await settle(40);
    if (captured === undefined) throw new Error('captured undefined');

    await captured.setConfig({ modelMode: 'opus' });
    await settle(20);
    expect(captured.config.modelMode).toBe('opus');
    // Disk file should not exist — initialOverride suppresses save.
    expect(() => readFileSync(cfgFile, 'utf8')).toThrow(/ENOENT/);
  });
});
